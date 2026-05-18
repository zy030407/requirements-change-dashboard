import OpenAI from "openai";
import { makeId, nowIso } from "./store.js";
import { adapterClientConfig, getActiveModelAdapter, isOpenAICompatibleAdapter } from "./modelRegistry.js";
import { applySpeakerLabelsToText, detectSpeakerLabels, normalizeSpeakerLabels } from "./speakerLabels.js";

const MODULE_KEYWORDS = ["会员管理", "订单管理", "营销中心", "商品管理", "数据报表", "库存同步", "结算中心", "权限管理"];
const CONCEPT_KEYWORDS = ["会员等级", "退货申请", "优惠券", "发票", "积分", "库存", "权限", "报表", "审批", "验收标准"];
const TECH_MODULE_KEYWORDS = [
  "电子档案",
  "指令签署",
  "信托档案",
  "合同档案",
  "风险合规",
  "方案确认",
  "资产配置",
  "投资指令",
  "分配档案",
  "到期提醒",
  "客户确认",
  "审批材料",
  "权限管理",
  "通知提醒",
  "客户门户",
  "系统专员",
  "下载功能",
  "上传功能"
];
const REQUIREMENT_VERBS = [
  "需要",
  "要",
  "必须",
  "可以",
  "支持",
  "开通",
  "上传",
  "下载",
  "提醒",
  "确认",
  "审批",
  "签署",
  "查看",
  "新增",
  "修改",
  "导入",
  "导出",
  "生成",
  "同步",
  "分配",
  "到期"
];

const WIKI_PAGE_TYPES = new Set([
  "MANAGER_BRIEF",
  "SOURCE_SUMMARY",
  "PROJECT_OVERVIEW",
  "TOPIC",
  "PROJECT_EVOLUTION",
  "REQUIREMENT_BASELINE",
  "DELIVERY_COMPILATION",
  "DECISION_LOG",
  "RISK_REGISTER",
  "OPEN_QUESTION",
  "INDEX",
  "TIMELINE",
  "LINT",
  "LOG"
]);

export async function compileAndApplySource(db, project, sourceFile, parsedText) {
  ensureWikiCompilerCollections(db);
  const compilationText = applySpeakerLabelsToText(parsedText, sourceFile.speakerLabels);
  const sourceCapsule = buildSourceCapsule(project, sourceFile, compilationText);
  const compilation = await compileSource(db, project, sourceFile, compilationText, sourceCapsule);
  const effectiveCompilation = effectiveCompilationForSignal(compilation);
  const sourcePage = upsertWikiPage(db, project.id, {
    type: "SOURCE_SUMMARY",
    title: `来源：${sourceFile.title || sourceFile.originalName}`,
    slug: `source-${sourceFile.id}`,
    summary: effectiveCompilation.sourceSummary,
    content: renderSourcePage(sourceFile, effectiveCompilation, sourceCapsule),
    tags: ["source", sourceFile.category, effectiveCompilation.signalLevel],
    sourceIds: [sourceFile.id],
    signalLevel: effectiveCompilation.signalLevel,
    status: signalStatus(effectiveCompilation.signalLevel),
    canonicalTerms: effectiveCompilation.canonicalTerms,
    sourceFileId: sourceFile.id,
    changeReason: "资料导入后自动编译",
    mergeStrategy: "replace"
  });

  const touchedPages = [sourcePage];

  if (effectiveCompilation.signalLevel !== "low") {
    for (const page of buildCoreWikiPages(project, db, sourceFile, sourceCapsule, effectiveCompilation)) {
      touchedPages.push(upsertWikiPage(db, project.id, page));
    }
  }

  for (const page of normalizeIncomingWikiPages(effectiveCompilation.pages, sourceFile, sourceCapsule, effectiveCompilation)) {
    touchedPages.push(
      upsertWikiPage(db, project.id, {
        type: page.type,
        title: page.title,
        slug: slugify(`${page.type}-${page.title}`),
        summary: page.summary,
        content: page.content,
        tags: page.tags || [],
        sourceIds: [sourceFile.id],
        signalLevel: effectiveCompilation.signalLevel,
        status: page.status || "推断",
        canonicalTerms: effectiveCompilation.canonicalTerms,
        sourceFileId: sourceFile.id,
        changeReason: `来源 ${sourceFile.originalName} 自动编译`
      })
    );
  }

  const relatedWikiPageIds = touchedPages.map((page) => page.id);
  const changes = effectiveCompilation.changes.map((change) => createChange(db, project.id, sourceFile.id, change, relatedWikiPageIds));
  const decisions = effectiveCompilation.decisions.map((decision) => createDecision(db, project.id, sourceFile.id, decision));
  const risks = effectiveCompilation.risks.map((risk) => createRisk(db, project.id, sourceFile.id, risk));
  const openQuestions = effectiveCompilation.openQuestions.map((question) =>
    createOpenQuestion(db, project.id, sourceFile.id, question)
  );
  const communication = upsertCommunicationFromSource(db, project, sourceFile, effectiveCompilation, parsedText, changes.length);

  for (const entity of [...changes, ...decisions, ...risks, ...openQuestions]) {
    const evidence = createSourceEvidence(db, project.id, sourceFile.id, entity, entity.evidence || effectiveCompilation.sourceSummary);
    entity.evidenceIds = unique([...(entity.evidenceIds || []), evidence.id]);
  }

  for (const page of touchedPages) {
    const evidence = createSourceEvidence(db, project.id, sourceFile.id, { ...page, entityType: "WikiPage" }, effectiveCompilation.sourceSummary);
    page.evidenceIds = unique([...(page.evidenceIds || []), evidence.id]);
  }

  const maintenancePages = buildMaintenanceWikiPages(project, db, sourceFile, sourceCapsule, effectiveCompilation);
  for (const page of maintenancePages) {
    touchedPages.push(upsertWikiPage(db, project.id, page));
  }

  db.auditLogs.push({
    id: makeId("aud"),
    projectId: project.id,
    actor: "AI 编译器",
    action: "INGEST_COMPILED",
    targetType: "SourceFile",
    targetId: sourceFile.id,
    detail: `按增量 Wiki 方式自动更新 ${touchedPages.length} 个页面，信号等级 ${effectiveCompilation.signalLevel}，生成 ${changes.length} 条变更、${decisions.length} 条决策、${risks.length} 条风险、${openQuestions.length} 个待确认事项，并归档沟通记录 ${communication.title}。`,
    createdAt: nowIso()
  });

  return {
    compilation: effectiveCompilation,
    touchedPages,
    changes,
    decisions,
    risks,
    openQuestions,
    communication
  };
}

export function upsertCommunicationFromSource(db, project, sourceFile, compilation = {}, parsedText = "", relatedChangeCount = 0) {
  if (!Array.isArray(db.communications)) db.communications = [];
  const timestamp = nowIso();
  const existing = db.communications.find((item) => item.projectId === project.id && item.sourceFileId === sourceFile.id);
  const title = communicationTitle(sourceFile);
  const next = {
    projectId: project.id,
    title,
    type: communicationType(sourceFile),
    participants: extractParticipants(sourceFile, parsedText),
    sourceFileId: sourceFile.id,
    summary: compilation.sourceSummary || sourceFile.aiSummary || sourceFile.parsedText?.slice(0, 300) || "资料已归档，待补充摘要。",
    meetingTime: extractMeetingTime(sourceFile) || sourceFile.uploadedAt || timestamp,
    createdBy: sourceFile.uploadedBy || "当前用户",
    relatedChangeCount,
    updatedAt: timestamp
  };
  if (existing) {
    Object.assign(existing, next);
    return existing;
  }
  const communication = {
    id: makeId("comm"),
    ...next,
    createdAt: timestamp
  };
  db.communications.push(communication);
  return communication;
}

async function compileSource(db, project, sourceFile, parsedText, sourceCapsule) {
  const adapter = getActiveModelAdapter(db, "LLM");
  const client = createOpenAIClient(adapter);
  if (client) {
    return normalizeCompilation(await compileWithModel(client, adapter, db, project, sourceFile, parsedText, sourceCapsule), parsedText, sourceCapsule);
  }
  const error = new Error("未配置可用的大模型，资料不会使用本地规则冒充编译成功。请在模型后台配置 LLM 后重新编译。");
  error.code = "LLM_NOT_CONFIGURED";
  throw error;
}

async function compileWithModel(client, adapter, db, project, sourceFile, parsedText, sourceCapsule) {
  const existingRequirements = db.requirements
    .filter((item) => item.projectId === project.id)
    .map((item) => ({
      id: item.id,
      moduleName: item.moduleName,
      title: item.title,
      description: item.description,
      status: item.status
    }));
  const existingWiki = db.wikiPages
    .filter((item) => item.projectId === project.id)
    .slice(0, 20)
    .map((item) => ({ type: item.type, title: item.title, summary: item.summary }));

  const prompt = [
    "你是木铎知会的 LLM Wiki 编译器，也是资深组织沟通、业务分析与知识沉淀专家。",
    "根据新资料内容，按持续演进的项目知识层更新 wiki，并结构化识别需求、决策、风险、待确认差异和依赖关系。",
    "重要规则：不要直接覆盖已确认需求；所有差异都输出为待确认 changes。",
    "编译标准：必须先判断资料信号等级，再抽取业务目标、用户角色、业务流程、功能模块、数据对象、权限规则、外部依赖、验收标准、风险和待确认问题。",
    "不要把口语转录逐句当成需求；要合并同义表达，过滤寒暄、重复语气词和调试闲聊。",
    "如果资料大多是闲聊、噪声、笑声、上下文不足或无业务信息，将 signalLevel 标为 low，changes/decisions/risks/openQuestions 尽量为空。",
    "状态必须区分：已确认、推断、待确认、已废弃、低信号。不要把推断写成已确认。",
    "每条变更、决策、风险、待确认都要给 evidence；能提取时间戳和说话人就填 timestampStart/timestampEnd/speaker。",
    "Wiki 正文必须是可读的 Markdown；可以包含 Mermaid 代码块，用于表达流程图、架构图、模块关系图、需求流转图。优先使用 flowchart LR，节点文本用双引号包裹。",
    "页面类型只能使用：SOURCE_SUMMARY, PROJECT_OVERVIEW, TOPIC, PROJECT_EVOLUTION, REQUIREMENT_BASELINE, DELIVERY_COMPILATION, DECISION_LOG, RISK_REGISTER, OPEN_QUESTION, INDEX, TIMELINE, LINT, LOG。MANAGER_BRIEF 由系统生成，不要在 pages 里输出。",
    "项目经理摘要规则：项目经理只需要结论、关键变化、待处理、风险和下一步动作；禁止输出大段转录、技术堆叠和全文罗列。每条结论必须说明发生了什么、影响什么、谁需要处理、依据来自哪里。",
    "只输出 JSON，不要输出 markdown 代码围栏。JSON 字符串值必须使用正常双引号，不要把字段值外层写成 \\\"...\\\"。",
    "",
    `项目：${project.name}`,
    `来源文件：${sourceFile.originalName}`,
    `用户备注/编译提示：${sourceFile.note || "无"}`,
    "Source Capsule：",
    JSON.stringify(sourceCapsule, null, 2),
    "",
    "现有需求：",
    JSON.stringify(existingRequirements, null, 2),
    "",
    "现有 Wiki 摘要：",
    JSON.stringify(existingWiki, null, 2),
    "",
    "新资料正文：",
    parsedText.slice(0, 50000),
    "",
    "JSON 结构：",
    JSON.stringify(
      {
        routing: {
          signalLevel: "high|medium|low",
          topics: ["主题名"],
          projectPhase: "资料反映出的项目阶段",
          canonicalTerms: ["规范术语"],
          aliases: [{ alias: "别名", canonical: "规范名" }],
          routeReason: "为什么进入这些页面"
        },
        sourceSummary: "本资料的一段摘要",
        projectSummary: "项目当前综合摘要",
        pages: [
          {
            type: "TOPIC|PROJECT_EVOLUTION|REQUIREMENT_BASELINE|DELIVERY_COMPILATION|DECISION_LOG|RISK_REGISTER|OPEN_QUESTION",
            title: "页面标题",
            summary: "一句话摘要",
            content: "markdown 正文，必须包含：背景、角色、流程、功能点、数据/字段、权限、验收标准、来源摘录",
            tags: ["标签"],
            status: "已确认|推断|待确认|已废弃|低信号"
          }
        ],
        changes: [
          {
            changeType: "新增|修改|删除|待确认",
            moduleName: "模块",
            title: "需求标题",
            beforeContent: "变更前",
            afterContent: "变更后",
            summary: "变更摘要",
            impactScope: "影响范围",
            proposer: "提出人",
            certainty: "confirmed|inferred|needs_confirmation",
            dependencies: ["依赖的模块或变更标题"],
            relatedRequirements: ["相关需求标题"],
            confidence: 0.8,
            evidence: { quote: "来源依据原文摘录", timestampStart: "00:01:02", timestampEnd: "00:01:08", speaker: "说话人1" }
          }
        ],
        decisions: [{ title: "决策", summary: "摘要", status: "已确认|推断|待确认", evidence: { quote: "依据" } }],
        risks: [{ title: "风险", summary: "摘要", severity: "高|中|低", evidence: { quote: "依据" } }],
        openQuestions: [{ title: "待确认问题", summary: "摘要", owner: "待确认方", evidence: { quote: "依据" } }]
      },
      null,
      2
    )
  ].join("\n");

  const protocol = String(adapter?.protocol || "").toLowerCase();
  const provider = String(adapter?.provider || "").toLowerCase();
  const model = adapter?.model || process.env.OPENAI_TEXT_MODEL || "gpt-4.1-mini";
  const errors = [];

  if (protocol === "responses" && provider === "openai") {
    try {
      const response = await client.responses.create({ model, input: prompt });
      return parseModelJson(response.output_text || "");
    } catch (error) {
      errors.push(`responses: ${error.message}`);
    }
  }

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0
    });
    return parseModelJson(response.choices?.[0]?.message?.content || response.choices?.[0]?.text || "");
  } catch (error) {
    errors.push(`chat-completions: ${error.message}`);
  }

  if (protocol === "responses" && provider !== "openai") {
    try {
      const response = await client.responses.create({ model, input: prompt });
      return parseModelJson(response.output_text || "");
    } catch (error) {
      errors.push(`responses: ${error.message}`);
    }
  }

  const error = new Error(`LLM 编译失败，未生成合法 JSON：${errors.join("；")}`);
  error.code = "LLM_COMPILE_FAILED";
  throw error;
}

function createOpenAIClient(adapter) {
  if (!adapter || !isOpenAICompatibleAdapter(adapter)) return null;
  const { apiKey, baseURL } = adapterClientConfig(adapter, "OPENAI_API_KEY");
  if (!apiKey) return null;
  return new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {})
  });
}

function parseModelJson(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("模型返回为空。");
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error(`模型未返回 JSON 对象：${raw.slice(0, 180)}`);
  }
  const jsonText = cleaned.slice(start, end + 1);
  const parsed = parseJsonWithRepair(jsonText);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("模型 JSON 根节点不是对象。");
  }
  return parsed;
}

function parseJsonWithRepair(jsonText) {
  try {
    return JSON.parse(jsonText);
  } catch (firstError) {
    const repaired = jsonText
      .replace(/(:\\s*)\\\\\"/g, '$1"')
      .replace(/\\\\\"(\\s*[,}\\]])/g, '"$1')
      .replace(/([\\[{,]\\s*)\\\\\"([^"\\\\]+)\\\\\"\\s*:/g, '$1"$2":');
    try {
      return JSON.parse(repaired);
    } catch {
      throw firstError;
    }
  }
}

function heuristicCompilation(db, project, sourceFile, parsedText) {
  if (isTechnicalMarkdownSource(sourceFile, parsedText)) {
    return technicalMarkdownCompilation(db, project, sourceFile, parsedText);
  }

  const noteText = sourceFile.note ? `用户备注/编译提示：${sourceFile.note}\n\n` : "";
  const text = `${noteText}${parsedText || ""}`;
  const modules = MODULE_KEYWORDS.filter((item) => text.includes(item));
  const concepts = CONCEPT_KEYWORDS.filter((item) => text.includes(item));
  const summary = summarizeText(text);

  const pages = [
    ...modules.map((moduleName) => ({
      type: "MODULE",
      title: moduleName,
      summary: `${moduleName} 在最新资料中被提及，需要纳入持续跟踪。`,
      content: `# ${moduleName}\n\n## 最新资料要点\n\n${extractSentences(text, moduleName)
        .map((item) => `- ${item}`)
        .join("\n") || "- 新资料提及该模块，但未形成明确规则。"}\n\n## 来源\n\n- [[来源：${sourceFile.title || sourceFile.originalName}]]`,
      tags: ["module", moduleName]
    })),
    ...concepts.map((concept) => ({
      type: "CONCEPT",
      title: concept,
      summary: `${concept} 是当前资料中的关键概念。`,
      content: `# ${concept}\n\n${extractSentences(text, concept)
        .map((item) => `- ${item}`)
        .join("\n") || "- 需要后续补充定义和边界。"}\n\n相关来源：[[来源：${sourceFile.title || sourceFile.originalName}]]`,
      tags: ["concept", concept]
    }))
  ];

  const changes = inferChanges(db, project.id, sourceFile, text);
  const decisions = inferDecisions(text);
  const risks = inferRisks(text);
  const openQuestions = inferOpenQuestions(text);

  return normalizeCompilation(
    {
      sourceSummary: summary,
      projectSummary: `${project.name} 已纳入新资料《${sourceFile.originalName}》。当前识别出 ${changes.length} 条需求差异、${risks.length} 个风险和 ${openQuestions.length} 个待确认事项。`,
      pages,
      changes,
      decisions,
      risks,
      openQuestions
    },
    parsedText
  );
}

function normalizeCompilation(compilation, parsedText, sourceCapsule = {}) {
  const routing = compilation.routing && typeof compilation.routing === "object" ? compilation.routing : {};
  const signalLevel = normalizeSignalLevel(routing.signalLevel || compilation.signalLevel || inferSignalLevel(parsedText, compilation));
  const canonicalTerms = unique([
    ...(Array.isArray(routing.canonicalTerms) ? routing.canonicalTerms : []),
    ...(Array.isArray(compilation.canonicalTerms) ? compilation.canonicalTerms : []),
    ...detectCanonicalTerms(parsedText)
  ]).slice(0, 24);
  return {
    routing: {
      signalLevel,
      topics: normalizeStringArray(routing.topics || compilation.topics).slice(0, 12),
      projectPhase: String(routing.projectPhase || compilation.projectPhase || "").slice(0, 80),
      canonicalTerms,
      aliases: Array.isArray(routing.aliases) ? routing.aliases.slice(0, 20) : [],
      routeReason: String(routing.routeReason || "").slice(0, 500)
    },
    signalLevel,
    canonicalTerms,
    sourceSummary: compilation.sourceSummary || summarizeText(parsedText),
    projectSummary: compilation.projectSummary || compilation.sourceSummary || summarizeText(parsedText),
    pages: Array.isArray(compilation.pages) ? compilation.pages : [],
    changes: Array.isArray(compilation.changes) ? compilation.changes.map((item) => normalizeChangeInput(item, sourceCapsule)) : [],
    decisions: Array.isArray(compilation.decisions) ? compilation.decisions.map((item) => normalizeEntityInput(item, "沟通结论")) : [],
    risks: Array.isArray(compilation.risks) ? compilation.risks.map((item) => normalizeRiskInput(item)) : [],
    openQuestions: Array.isArray(compilation.openQuestions) ? compilation.openQuestions.map((item) => normalizeEntityInput(item, "待确认事项")) : []
  };
}

function ensureWikiCompilerCollections(db) {
  db.wikiPages ||= [];
  db.wikiPageVersions ||= [];
  db.wikiLinks ||= [];
  db.sourceEvidences ||= [];
  db.changes ||= [];
  db.decisions ||= [];
  db.risks ||= [];
  db.openQuestions ||= [];
  db.communications ||= [];
  db.auditLogs ||= [];
}

function buildSourceCapsule(project, sourceFile, parsedText = "") {
  const text = String(parsedText || "");
  const timestampMatches = [...text.matchAll(/(?:\[|【)?(?:(?:说话人|Speaker)\s*[A-Za-z0-9一二三四五六七八九十]+)?\s*(\d{1,2}:\d{2}(?::\d{2})?)(?:\s*[-~—]\s*(\d{1,2}:\d{2}(?::\d{2})?))?/g)]
    .slice(0, 20)
    .map((match) => ({ start: normalizeTimestamp(match[1]), end: normalizeTimestamp(match[2]) }));
  const speakers = extractParticipants(sourceFile, text);
  const speakerLabels = normalizeSpeakerLabels(sourceFile.speakerLabels || {});
  return {
    projectId: project.id,
    projectName: project.name,
    sourceFileId: sourceFile.id,
    sourceTitle: sourceFile.title || sourceFile.originalName,
    originalName: sourceFile.originalName,
    category: sourceFile.category,
    uploadedAt: sourceFile.uploadedAt,
    documentTime: extractMeetingTime(sourceFile) || sourceFile.uploadedAt || null,
    note: sourceFile.note || "",
    speakerCount: sourceFile.speakerCount || speakers.length,
    speakers,
    speakerLabels,
    timestampSamples: timestampMatches,
    textLength: text.length,
    textPreview: summarizeText(text)
  };
}

function effectiveCompilationForSignal(compilation) {
  if (compilation.signalLevel !== "low") return compilation;
  return {
    ...compilation,
    changes: [],
    decisions: [],
    risks: [],
    openQuestions: [],
    pages: (compilation.pages || []).filter((page) => normalizeWikiPageType(page.type) === "TOPIC")
  };
}

function buildCoreWikiPages(project, db, sourceFile, sourceCapsule, compilation) {
  const common = commonPageInput(sourceFile, sourceCapsule, compilation);
  const managerBrief = buildManagerBrief(db, project, compilation, sourceCapsule);
  return [
    {
      ...common,
      type: "MANAGER_BRIEF",
      title: "项目经理摘要",
      slug: "manager-brief",
      summary: managerBrief.summary,
      content: renderManagerBriefPage(project, managerBrief),
      tags: ["manager-brief", "summary"],
      managerBrief,
      changeReason: "新资料更新项目经理摘要"
    },
    {
      ...common,
      type: "PROJECT_OVERVIEW",
      title: "项目总览",
      slug: "project-overview",
      summary: compilation.projectSummary,
      content: renderProjectOverview(project, db, compilation),
      tags: ["overview"],
      changeReason: "新资料更新项目总览"
    },
    {
      ...common,
      type: "PROJECT_EVOLUTION",
      title: "项目变化过程",
      slug: "project-evolution",
      summary: `${project.name} 的资料时间线、阶段变化和范围演进。`,
      content: renderProjectEvolutionPage(project, db, sourceCapsule, compilation),
      tags: ["project-evolution", "timeline"],
      changeReason: "新资料更新项目演进"
    },
    {
      ...common,
      type: "REQUIREMENT_BASELINE",
      title: "需求基线与变更",
      slug: "requirement-baseline",
      summary: `${project.name} 的当前需求基线、已确认变更和待确认差异。`,
      content: renderRequirementBaselinePage(project, db, sourceCapsule, compilation),
      tags: ["requirements", "baseline"],
      changeReason: "新资料更新需求基线"
    },
    {
      ...common,
      type: "DELIVERY_COMPILATION",
      title: "开发管理编译",
      slug: "delivery-compilation",
      summary: `${project.name} 的功能清单、任务候选、验收口径和风险阻塞。`,
      content: renderDeliveryCompilationPage(project, db, sourceCapsule, compilation),
      tags: ["delivery", "tasks"],
      changeReason: "新资料更新开发管理编译"
    },
    {
      ...common,
      type: "DECISION_LOG",
      title: "决策记录",
      slug: "decision-log",
      summary: `${project.name} 的沟通结论和决策证据。`,
      content: renderDecisionLogPage(project, db, compilation),
      tags: ["decisions"],
      changeReason: "新资料更新决策记录"
    },
    {
      ...common,
      type: "RISK_REGISTER",
      title: "风险台账",
      slug: "risk-register",
      summary: `${project.name} 的风险、影响范围和来源依据。`,
      content: renderRiskRegisterPage(project, db, compilation),
      tags: ["risks"],
      changeReason: "新资料更新风险台账"
    },
    {
      ...common,
      type: "OPEN_QUESTION",
      title: "待确认事项",
      slug: "open-questions",
      summary: `${project.name} 的待确认问题、确认方和依据。`,
      content: renderOpenQuestionPage(project, db, compilation),
      tags: ["open-questions"],
      changeReason: "新资料更新待确认事项"
    },
    ...buildTopicPages(sourceFile, sourceCapsule, compilation)
  ];
}

function buildMaintenanceWikiPages(project, db, sourceFile, sourceCapsule, compilation) {
  const common = commonPageInput(sourceFile, sourceCapsule, compilation);
  return [
    {
      ...common,
      type: "INDEX",
      title: "Wiki 索引",
      slug: "wiki-index",
      summary: `${project.name} Wiki 导航索引。`,
      content: renderIndexPage(project, db),
      tags: ["index"],
      changeReason: "更新 Wiki 索引"
    },
    {
      ...common,
      type: "TIMELINE",
      title: "时间线",
      slug: "timeline",
      summary: `${project.name} 的资料、变更、决策时间线。`,
      content: renderTimelinePage(project, db),
      tags: ["timeline"],
      changeReason: "更新时间线"
    },
    {
      ...common,
      type: "LINT",
      title: "Wiki 健康检查",
      slug: "wiki-lint",
      summary: `${project.name} Wiki 编译质量、孤立页面和待确认状态检查。`,
      content: renderLintPage(project, db),
      tags: ["lint"],
      changeReason: "更新 Wiki 健康检查"
    },
    {
      ...common,
      type: "LOG",
      title: "编译日志",
      slug: "compile-log",
      summary: `${project.name} Wiki 编译维护日志。`,
      content: renderCompileLogPage(project, db, sourceCapsule, compilation),
      tags: ["log"],
      changeReason: "更新编译日志"
    }
  ];
}

function commonPageInput(sourceFile, sourceCapsule, compilation) {
  return {
    sourceIds: [sourceFile.id],
    sourceFileId: sourceFile.id,
    signalLevel: compilation.signalLevel,
    status: signalStatus(compilation.signalLevel),
    canonicalTerms: compilation.canonicalTerms,
    lastCompiledAt: nowIso(),
    mergeStrategy: "replace",
    relatedPageIds: []
  };
}

function buildTopicPages(sourceFile, sourceCapsule, compilation) {
  const topics = unique([
    ...normalizeStringArray(compilation.routing?.topics),
    ...normalizeStringArray(compilation.canonicalTerms)
  ]).slice(0, 8);
  return topics.map((topic) => ({
    ...commonPageInput(sourceFile, sourceCapsule, compilation),
    type: "TOPIC",
    title: topic,
    slug: slugify(`topic-${topic}`),
    summary: `${topic} 在 ${sourceCapsule.sourceTitle} 中被提及，进入项目知识层持续跟踪。`,
    content: renderTopicPage(topic, sourceCapsule, compilation),
    tags: ["topic", topic],
    changeReason: `来源 ${sourceCapsule.sourceTitle} 更新主题 ${topic}`,
    mergeStrategy: "append"
  }));
}

function normalizeIncomingWikiPages(pages, sourceFile, sourceCapsule, compilation) {
  return (pages || [])
    .map((page) => ({
      type: normalizeWikiPageType(page.type),
      title: String(page.title || "未命名页面").slice(0, 120),
      summary: String(page.summary || "").slice(0, 500),
      content: String(page.content || page.summary || ""),
      tags: normalizeStringArray(page.tags),
      status: normalizeKnowledgeStatus(page.status),
      sourceIds: [sourceFile.id],
      sourceFileId: sourceFile.id,
      signalLevel: compilation.signalLevel,
      canonicalTerms: compilation.canonicalTerms
    }))
    .filter((page) => page.type !== "MANAGER_BRIEF" && page.content.trim());
}

function normalizeWikiPageType(type) {
  const raw = String(type || "").trim().toUpperCase();
  if (WIKI_PAGE_TYPES.has(raw)) return raw;
  if (["MODULE", "REQUIREMENT", "CONCEPT", "TECHNICAL_DESIGN"].includes(raw)) return "TOPIC";
  if (["CHANGE_RECORD"].includes(raw)) return "REQUIREMENT_BASELINE";
  if (["RISK"].includes(raw)) return "RISK_REGISTER";
  if (["DECISION"].includes(raw)) return "DECISION_LOG";
  return "TOPIC";
}

function normalizeChangeInput(input = {}, sourceCapsule = {}) {
  return {
    ...input,
    changeType: ["新增", "修改", "删除", "待确认"].includes(input.changeType) ? input.changeType : "待确认",
    moduleName: input.moduleName || "项目范围",
    title: input.title || "未命名变更",
    certainty: normalizeCertainty(input.certainty),
    dependencies: normalizeStringArray(input.dependencies),
    relatedRequirements: normalizeStringArray(input.relatedRequirements),
    evidence: normalizeEvidenceInput(input.evidence, input.summary || input.afterContent || sourceCapsule.textPreview)
  };
}

function normalizeEntityInput(input = {}, fallbackTitle) {
  return {
    ...input,
    title: input.title || fallbackTitle,
    summary: input.summary || "",
    status: normalizeKnowledgeStatus(input.status),
    evidence: normalizeEvidenceInput(input.evidence, input.summary || input.title || fallbackTitle)
  };
}

function normalizeRiskInput(input = {}) {
  return {
    ...normalizeEntityInput(input, "需求风险"),
    severity: ["高", "中", "低"].includes(input.severity) ? input.severity : "中"
  };
}

function normalizeEvidenceInput(evidence, fallbackQuote = "") {
  if (evidence && typeof evidence === "object") {
    return {
      quote: String(evidence.quote || evidence.text || fallbackQuote || "").slice(0, 2000),
      location: evidence.location || null,
      timestampStart: normalizeTimestamp(evidence.timestampStart || evidence.start),
      timestampEnd: normalizeTimestamp(evidence.timestampEnd || evidence.end),
      speaker: evidence.speaker ? String(evidence.speaker).slice(0, 80) : null,
      confidence: normalizeConfidence(evidence.confidence)
    };
  }
  return {
    quote: String(evidence || fallbackQuote || "").slice(0, 2000),
    location: null,
    timestampStart: null,
    timestampEnd: null,
    speaker: null,
    confidence: 0.7
  };
}

function createSourceEvidence(db, projectId, sourceFileId, entity, evidenceInput) {
  const evidence = normalizeEvidenceInput(evidenceInput);
  const record = {
    id: makeId("evi"),
    projectId,
    sourceFileId,
    entityType: entity.entityType || entity.type || "Unknown",
    targetType: entity.entityType || entity.type || "Unknown",
    entityId: entity.id,
    targetId: entity.id,
    quote: evidence.quote,
    location: evidence.location,
    timestampStart: evidence.timestampStart,
    timestampEnd: evidence.timestampEnd,
    speaker: evidence.speaker,
    confidence: evidence.confidence,
    createdAt: nowIso()
  };
  db.sourceEvidences.push(record);
  return record;
}

function normalizeSignalLevel(value) {
  const raw = String(value || "").toLowerCase();
  if (["high", "medium", "low"].includes(raw)) return raw;
  if (["高", "强"].includes(raw)) return "high";
  if (["中", "中等"].includes(raw)) return "medium";
  if (["低", "弱"].includes(raw)) return "low";
  return "medium";
}

function inferSignalLevel(text = "", compilation = {}) {
  const raw = String(text || "");
  if (raw.trim().length < 80) return "low";
  const productSignal = /需求|客户|确认|变更|风险|流程|模块|权限|数据|字段|验收|报价|交付|开发|上传|签署|报告|提醒/.test(raw);
  const entityCount =
    (compilation.changes?.length || 0) +
    (compilation.decisions?.length || 0) +
    (compilation.risks?.length || 0) +
    (compilation.openQuestions?.length || 0);
  if (productSignal && entityCount >= 3) return "high";
  if (productSignal) return "medium";
  return "low";
}

function signalStatus(signalLevel) {
  return signalLevel === "low" ? "低信号" : "推断";
}

function normalizeKnowledgeStatus(value) {
  const raw = String(value || "").trim();
  return ["已确认", "推断", "待确认", "已废弃", "低信号"].includes(raw) ? raw : "推断";
}

function normalizeCertainty(value) {
  const raw = String(value || "").toLowerCase();
  if (["confirmed", "inferred", "needs_confirmation"].includes(raw)) return raw;
  if (raw.includes("确认") && !raw.includes("待")) return "confirmed";
  if (raw.includes("待") || raw.includes("需")) return "needs_confirmation";
  return "inferred";
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return unique(value.map((item) => String(item || "").trim()).filter(Boolean));
}

function detectCanonicalTerms(text = "") {
  const terms = [...TECH_MODULE_KEYWORDS, ...MODULE_KEYWORDS, ...CONCEPT_KEYWORDS].filter((item) => String(text).includes(item));
  return unique(terms).slice(0, 12);
}

function normalizeTimestamp(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const match = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return raw.slice(0, 32);
  const [, a, b, c] = match;
  return c ? `${a.padStart(2, "0")}:${b}:${c}` : `00:${a.padStart(2, "0")}:${b}`;
}

function technicalMarkdownCompilation(db, project, sourceFile, parsedText) {
  const metadata = extractMarkdownMetadata(parsedText);
  const transcriptLines = extractTranscriptLines(parsedText);
  const usefulLines = transcriptLines.filter((line) => isUsefulRequirementLine(line.text));
  const text = usefulLines.map((line) => line.text).join("\n") || stripMarkdownBoilerplate(parsedText);
  const modules = detectTechnicalModules(text);
  const requirementCandidates = extractRequirementCandidates(usefulLines, modules);
  const decisions = inferTechnicalDecisions(usefulLines);
  const risks = inferTechnicalRisks(usefulLines);
  const openQuestions = inferTechnicalOpenQuestions(usefulLines);

  const sourceTitle = sourceFile.title || sourceFile.originalName;
  const pages = [];

  pages.push({
    type: "TECHNICAL_DESIGN",
    title: "技术需求索引",
    summary: `${project.name} 的技术需求索引，按模块、流程、数据和权限持续归档。`,
    content: renderTechnicalIndexPage(project, sourceFile, metadata, modules, requirementCandidates, decisions, risks, openQuestions),
    tags: ["technical-index", "requirements", "markdown"]
  });

  for (const module of modules) {
    const relatedRequirements = requirementCandidates.filter((item) => item.moduleName === module.name).slice(0, 12);
    pages.push({
      type: "MODULE",
      title: module.name,
      summary: module.summary,
      content: renderTechnicalModulePage(module, relatedRequirements, sourceTitle),
      tags: ["module", module.name]
    });
  }

  for (const requirement of requirementCandidates.slice(0, 16)) {
    pages.push({
      type: "REQUIREMENT",
      title: requirement.title,
      summary: requirement.summary,
      content: renderTechnicalRequirementPage(requirement, sourceTitle),
      tags: ["requirement", requirement.moduleName, requirement.priority]
    });
  }

  const changes = requirementCandidates.slice(0, 12).map((item) => ({
    changeType: "待确认",
    moduleName: item.moduleName,
    title: item.title,
    beforeContent: "",
    afterContent: item.description,
    summary: item.summary,
    impactScope: item.impactScope,
    proposer: item.proposer,
    confidence: item.confidence,
    evidence: item.evidence
  }));

  return normalizeCompilation(
    {
      sourceSummary: renderTechnicalSourceSummary(sourceFile, metadata, modules, requirementCandidates, risks, openQuestions),
      projectSummary: `${project.name} 已按技术需求逻辑编译《${sourceFile.originalName}》：识别 ${modules.length} 个业务模块、${requirementCandidates.length} 个候选需求、${risks.length} 个风险和 ${openQuestions.length} 个待确认问题。`,
      pages,
      changes,
      decisions,
      risks,
      openQuestions
    },
    parsedText
  );
}

function inferChanges(db, projectId, sourceFile, text) {
  const requirements = db.requirements.filter((item) => item.projectId === projectId);
  const sentences = splitSentences(text);
  const changeHints = sentences.filter((sentence) => /新增|增加|修改|改为|变更|删除|取消|不做|待确认|确认/.test(sentence));
  const changes = [];

  for (const sentence of changeHints.slice(0, 8)) {
    const matchedRequirement = requirements.find(
      (requirement) => sentence.includes(requirement.title) || sentence.includes(requirement.moduleName)
    );
    const changeType = sentence.includes("删除") || sentence.includes("取消") || sentence.includes("不做")
      ? "删除"
      : sentence.includes("新增") || sentence.includes("增加")
        ? "新增"
        : sentence.includes("待确认") || sentence.includes("是否")
          ? "待确认"
          : "修改";

    changes.push({
      changeType,
      moduleName: matchedRequirement?.moduleName || inferModule(sentence),
      title: matchedRequirement?.title || inferTitle(sentence),
      beforeContent: matchedRequirement?.description || "",
      afterContent: sentence,
      summary: summarizeSentence(sentence),
      impactScope: matchedRequirement?.moduleName || inferModule(sentence),
      proposer: inferProposer(sentence),
      confidence: matchedRequirement ? 0.86 : 0.68,
      evidence: sentence
    });
  }

  if (!changes.length) {
    changes.push({
      changeType: "待确认",
      moduleName: "项目范围",
      title: sourceFile.title || sourceFile.originalName,
      beforeContent: "",
      afterContent: summarizeText(text),
      summary: "新资料已进入 Wiki，但未识别到明确变更动作，建议人工复核。",
      impactScope: "需求范围",
      proposer: "AI 编译器",
      confidence: 0.52,
      evidence: summarizeText(text)
    });
  }

  return changes;
}

function inferDecisions(text) {
  return splitSentences(text)
    .filter((sentence) => /确认|决定|结论|一期|暂不/.test(sentence))
    .slice(0, 5)
    .map((sentence) => ({
      title: summarizeSentence(sentence),
      summary: sentence,
      evidence: sentence
    }));
}

function inferRisks(text) {
  return splitSentences(text)
    .filter((sentence) => /风险|影响|延期|成本|报价|冲突|不一致|反复/.test(sentence))
    .slice(0, 5)
    .map((sentence) => ({
      title: summarizeSentence(sentence),
      summary: sentence,
      severity: /延期|报价|成本|核心|冲突/.test(sentence) ? "高" : "中",
      evidence: sentence
    }));
}

function inferOpenQuestions(text) {
  return splitSentences(text)
    .filter((sentence) => /待确认|是否|？|\?|不清楚|口径|需要客户|需客户|客户确认/.test(sentence))
    .slice(0, 6)
    .map((sentence) => ({
      title: summarizeSentence(sentence),
      summary: sentence,
      owner: "待确认",
      evidence: sentence
    }));
}

function upsertWikiPage(db, projectId, pageInput) {
  const existing = db.wikiPages.find((page) => page.projectId === projectId && page.slug === pageInput.slug);
  const timestamp = nowIso();
  const nextType = normalizeWikiPageType(pageInput.type);
  const nextContent = pageInput.mergeStrategy === "replace" ? pageInput.content : mergeContent(existing?.content, pageInput.content);

  if (existing) {
    const versionCount = db.wikiPageVersions.filter((version) => version.wikiPageId === existing.id).length;
    existing.type = nextType;
    existing.title = pageInput.title;
    existing.summary = pageInput.summary;
    existing.content = nextContent;
    existing.tags = unique([...(existing.tags || []), ...(pageInput.tags || [])]);
    existing.sourceIds = unique([...(existing.sourceIds || []), ...(pageInput.sourceIds || [])]);
    existing.signalLevel = pageInput.signalLevel || existing.signalLevel || "medium";
    existing.status = pageInput.status || existing.status || "推断";
    existing.relatedPageIds = unique([...(existing.relatedPageIds || []), ...(pageInput.relatedPageIds || [])]);
    existing.canonicalTerms = unique([...(existing.canonicalTerms || []), ...(pageInput.canonicalTerms || [])]);
    if (pageInput.managerBrief) existing.managerBrief = pageInput.managerBrief;
    existing.lastCompiledAt = pageInput.lastCompiledAt || timestamp;
    existing.updatedAt = timestamp;

    db.wikiPageVersions.push({
      id: makeId("wver"),
      wikiPageId: existing.id,
      projectId,
      version: versionCount + 1,
      title: existing.title,
      summary: existing.summary,
      content: existing.content,
      sourceFileId: pageInput.sourceFileId || null,
      changeReason: pageInput.changeReason,
      createdBy: "AI 编译器",
      createdAt: timestamp
    });
    return existing;
  }

  const page = {
    id: makeId("wiki"),
    projectId,
    type: nextType,
    title: pageInput.title,
    slug: pageInput.slug,
    summary: pageInput.summary,
    content: pageInput.content,
    tags: pageInput.tags || [],
    sourceIds: pageInput.sourceIds || [],
    signalLevel: pageInput.signalLevel || "medium",
    status: pageInput.status || "推断",
    relatedPageIds: pageInput.relatedPageIds || [],
    canonicalTerms: pageInput.canonicalTerms || [],
    managerBrief: pageInput.managerBrief || null,
    lastCompiledAt: pageInput.lastCompiledAt || timestamp,
    evidenceIds: [],
    createdAt: timestamp,
    updatedAt: timestamp
  };
  db.wikiPages.push(page);
  db.wikiPageVersions.push({
    id: makeId("wver"),
    wikiPageId: page.id,
    projectId,
    version: 1,
    title: page.title,
    summary: page.summary,
    content: page.content,
    sourceFileId: pageInput.sourceFileId || null,
    changeReason: pageInput.changeReason,
    createdBy: "AI 编译器",
    createdAt: timestamp
  });
  return page;
}

function createChange(db, projectId, sourceFileId, input, relatedWikiPageIds = []) {
  const requirement = db.requirements.find(
    (item) =>
      item.projectId === projectId &&
      (item.title === input.title || (input.moduleName && item.moduleName === input.moduleName && input.title?.includes(item.title)))
  );
  const timestamp = nowIso();
  const change = {
    id: makeId("chg"),
    projectId,
    requirementId: requirement?.id || null,
    changeType: input.changeType || "待确认",
    moduleName: input.moduleName || requirement?.moduleName || "项目范围",
    title: input.title || "未命名变更",
    beforeContent: input.beforeContent || requirement?.description || "",
    afterContent: input.afterContent || "",
    summary: input.summary || input.afterContent || "AI 自动识别的需求差异",
    impactScope: input.impactScope || input.moduleName || "待评估",
    sourceFileId,
    proposer: input.proposer || "AI 编译器",
    confidence: normalizeConfidence(input.confidence),
    status: "待确认",
    certainty: normalizeCertainty(input.certainty),
    dependencyChangeIds: [],
    relatedRequirementIds: unique([
      requirement?.id,
      ...resolveRequirementIds(db, projectId, input.relatedRequirements || [])
    ]),
    relatedWikiPageIds: unique(relatedWikiPageIds),
    evidenceIds: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    entityType: "Change",
    evidence: input.evidence
  };
  change.dependencyChangeIds = resolveDependencyChangeIds(db, projectId, input.dependencies || [], change);
  db.changes.push(change);
  return change;
}

function createDecision(db, projectId, sourceFileId, input) {
  const decision = {
    id: makeId("dec"),
    projectId,
    sourceFileId,
    title: input.title || "沟通结论",
    summary: input.summary || "",
    status: input.status || "已记录",
    evidenceIds: [],
    createdAt: nowIso(),
    entityType: "Decision",
    evidence: input.evidence
  };
  db.decisions.push(decision);
  return decision;
}

function createRisk(db, projectId, sourceFileId, input) {
  const risk = {
    id: makeId("risk"),
    projectId,
    sourceFileId,
    title: input.title || "需求风险",
    summary: input.summary || "",
    severity: input.severity || "中",
    status: "打开",
    evidenceIds: [],
    createdAt: nowIso(),
    entityType: "Risk",
    evidence: input.evidence
  };
  db.risks.push(risk);
  return risk;
}

function createOpenQuestion(db, projectId, sourceFileId, input) {
  const question = {
    id: makeId("oq"),
    projectId,
    sourceFileId,
    title: input.title || "待确认事项",
    summary: input.summary || "",
    owner: input.owner || "待确认",
    status: "待确认",
    evidenceIds: [],
    createdAt: nowIso(),
    entityType: "OpenQuestion",
    evidence: input.evidence
  };
  db.openQuestions.push(question);
  return question;
}

function resolveRequirementIds(db, projectId, names = []) {
  return normalizeStringArray(names)
    .map((name) => db.requirements.find((item) => item.projectId === projectId && (item.title === name || name.includes(item.title) || item.title.includes(name)))?.id)
    .filter(Boolean);
}

function resolveDependencyChangeIds(db, projectId, dependencies = [], change) {
  const names = normalizeStringArray(dependencies);
  if (!names.length) {
    return db.changes
      .filter((item) => item.projectId === projectId && item.id !== change.id && item.moduleName === change.moduleName)
      .slice(-4)
      .map((item) => item.id);
  }
  return db.changes
    .filter((item) => item.projectId === projectId)
    .filter((item) => names.some((name) => [item.title, item.moduleName, item.summary].filter(Boolean).some((value) => String(value).includes(name) || name.includes(String(value)))))
    .slice(-8)
    .map((item) => item.id);
}

function renderSourcePage(sourceFile, compilation, sourceCapsule = {}) {
  const audioLines =
    sourceFile.category === "audio"
      ? [
          `- 说话人分离：${sourceFile.enableSpeakerDiarization ? "已开启" : "未开启"}`,
          sourceFile.speakerCount ? `- 会议人数：${sourceFile.speakerCount} 人` : null,
          sourceFile.asrOptions?.ssdVersion ? `- ASR 分离版本：ssd_version=${sourceFile.asrOptions.ssdVersion}` : null
        ].filter(Boolean)
      : [];

  return [
    `# 来源：${sourceFile.title || sourceFile.originalName}`,
    "",
    "## 元信息",
    "",
    `- 类型：${sourceFile.category}`,
    `- 信号等级：${compilation.signalLevel}`,
    `- 状态：${signalStatus(compilation.signalLevel)}`,
    `- 上传时间：${sourceFile.uploadedAt}`,
    sourceCapsule.documentTime ? `- 资料时间：${sourceCapsule.documentTime}` : null,
    sourceCapsule.speakers?.length ? `- 说话人：${sourceCapsule.speakers.join("、")}` : null,
    ...audioLines,
    sourceFile.note ? `- 编译备注：${sourceFile.note}` : null,
    "",
    "## 摘要",
    "",
    compilation.sourceSummary,
    "",
    "## 路由",
    "",
    `- 主题：${compilation.routing?.topics?.join("、") || "未识别"}`,
    `- 项目阶段：${compilation.routing?.projectPhase || "未识别"}`,
    `- 规范术语：${compilation.canonicalTerms?.join("、") || "无"}`,
    "",
    "## 结构化产物",
    "",
    `- 需求差异：${compilation.changes.length} 条`,
    `- 决策：${compilation.decisions.length} 条`,
    `- 风险：${compilation.risks.length} 条`,
    `- 待确认：${compilation.openQuestions.length} 条`
  ].filter((line) => line !== null).join("\n");
}

export function buildManagerBrief(db, project, compilation = {}, sourceCapsule = null) {
  const projectChanges = (db.changes || []).filter((item) => item.projectId === project.id);
  const projectRisks = (db.risks || []).filter((item) => item.projectId === project.id);
  const projectQuestions = (db.openQuestions || []).filter((item) => item.projectId === project.id);
  const projectSources = (db.sourceFiles || []).filter((item) => item.projectId === project.id);
  const incomingChanges = (compilation.changes || []).map((item, index) => ({
    ...item,
    id: `incoming-change-${index}`,
    incoming: true,
    status: item.status || "待确认",
    createdAt: nowIso(),
    sourceFileId: sourceCapsule?.sourceFileId || null
  }));
  const incomingRisks = (compilation.risks || []).map((item, index) => ({
    ...item,
    id: `incoming-risk-${index}`,
    incoming: true,
    status: item.status || "open",
    createdAt: nowIso(),
    sourceFileId: sourceCapsule?.sourceFileId || null
  }));
  const incomingQuestions = (compilation.openQuestions || []).map((item, index) => ({
    ...item,
    id: `incoming-question-${index}`,
    incoming: true,
    status: item.status || "待确认",
    createdAt: nowIso(),
    sourceFileId: sourceCapsule?.sourceFileId || null
  }));

  const activeChanges = [...projectChanges, ...incomingChanges]
    .filter((item) => item.status !== "已驳回")
    .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));
  const activeRisks = [...projectRisks, ...incomingRisks]
    .filter((item) => !["已关闭", "closed"].includes(item.status))
    .sort((a, b) => riskSeverityWeight(b.severity) - riskSeverityWeight(a.severity) || String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  const activeQuestions = [...projectQuestions, ...incomingQuestions]
    .filter((item) => item.status !== "已确认" && item.status !== "已关闭")
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  const customerConfirmChanges = activeChanges.filter((item) => item.status === "需客户确认");
  const pendingManagerChanges = activeChanges.filter((item) => item.status === "待确认");
  const highRisks = activeRisks.filter((item) => ["高", "严重", "高风险"].includes(item.severity));

  const sourceRefs = unique([
    sourceCapsule?.sourceFileId,
    ...activeChanges.map((item) => item.sourceFileId),
    ...activeRisks.map((item) => item.sourceFileId),
    ...activeQuestions.map((item) => item.sourceFileId)
  ])
    .map((sourceFileId) => projectSources.find((item) => item.id === sourceFileId))
    .filter(Boolean)
    .slice(0, 6)
    .map((source) => ({
      sourceFileId: source.id,
      title: source.title || source.originalName,
      category: source.category,
      uploadedAt: source.uploadedAt
    }));

  const actionCandidates = [
    ...pendingManagerChanges.map((item) => ({
      id: `action-${item.id}`,
      title: `确认变更：${item.moduleName || "项目范围"} - ${item.title}`,
      owner: "项目经理",
      due: "下次沟通前",
      status: item.status,
      source: sourceTitleForBrief(projectSources, item.sourceFileId),
      changeId: item.incoming ? null : item.id,
      sourceFileId: item.sourceFileId || null,
      summary: shortText(item.summary || item.afterContent || "该变更需要确认后才能进入需求池。", 88)
    })),
    ...customerConfirmChanges.map((item) => ({
      id: `action-${item.id}`,
      title: `跟进客户确认：${item.moduleName || "项目范围"} - ${item.title}`,
      owner: "客户负责人",
      due: "本周",
      status: item.status,
      source: sourceTitleForBrief(projectSources, item.sourceFileId),
      changeId: item.incoming ? null : item.id,
      sourceFileId: item.sourceFileId || null,
      summary: shortText(item.summary || item.afterContent || "等待客户确认口径。", 88)
    })),
    ...activeQuestions.map((item) => ({
      id: `action-${item.id}`,
      title: `澄清问题：${item.title}`,
      owner: item.owner || "待确认方",
      due: "下次会议前",
      status: item.status || "待确认",
      source: sourceTitleForBrief(projectSources, item.sourceFileId),
      sourceFileId: item.sourceFileId || null,
      summary: shortText(item.summary || "需要补充确认。", 88)
    }))
  ].slice(0, 6);

  const keyChanges = activeChanges.slice(0, 5).map((item) => ({
    id: item.id,
    title: `${item.moduleName || "项目范围"} - ${item.title}`,
    type: item.changeType || "待确认",
    status: item.status || "待确认",
    impact: shortText(item.impactScope || item.summary || item.afterContent || "影响范围待评估。", 90),
    result: shortText(item.summary || item.afterContent || "需要进一步确认。", 90),
    owner: item.proposer || "待确认",
    changeId: item.incoming ? null : item.id,
    sourceFileId: item.sourceFileId || null,
    source: sourceTitleForBrief(projectSources, item.sourceFileId)
  }));

  const risks = activeRisks.slice(0, 3).map((item) => ({
    id: item.id,
    title: item.title || "未命名风险",
    severity: item.severity || "中",
    summary: shortText(item.summary || "风险影响待补充。", 100),
    action: riskAction(item),
    sourceFileId: item.sourceFileId || null,
    source: sourceTitleForBrief(projectSources, item.sourceFileId)
  }));

  const summary = buildManagerBriefSummary(project, {
    pendingManagerCount: pendingManagerChanges.length,
    customerConfirmCount: customerConfirmChanges.length,
    highRiskCount: highRisks.length,
    riskCount: activeRisks.length,
    changeCount: activeChanges.length,
    questionCount: activeQuestions.length,
    fallbackSummary: compilation.projectSummary
  });

  return {
    summary,
    keyChanges,
    risks,
    actions: actionCandidates,
    sourceRefs,
    stats: {
      pendingManagerCount: pendingManagerChanges.length,
      customerConfirmCount: customerConfirmChanges.length,
      riskCount: activeRisks.length,
      questionCount: activeQuestions.length,
      changeCount: activeChanges.length
    }
  };
}

export function buildManagerBriefWikiPage(project, db) {
  const managerBrief = buildManagerBrief(db, project);
  const sources = managerBrief.sourceRefs.map((item) => item.sourceFileId).filter(Boolean);
  const latestUpdatedAt = [
    ...(db.wikiPages || []).filter((item) => item.projectId === project.id).map((item) => item.updatedAt),
    ...(db.changes || []).filter((item) => item.projectId === project.id).map((item) => item.updatedAt || item.createdAt),
    ...(db.risks || []).filter((item) => item.projectId === project.id).map((item) => item.createdAt)
  ].filter(Boolean).sort().at(-1) || nowIso();
  return {
    id: `manager-brief-${project.id}`,
    projectId: project.id,
    type: "MANAGER_BRIEF",
    title: "项目经理摘要",
    slug: "manager-brief",
    summary: managerBrief.summary,
    content: renderManagerBriefPage(project, managerBrief),
    tags: ["manager-brief", "summary"],
    sourceIds: sources,
    signalLevel: "medium",
    status: "推断",
    relatedPageIds: [],
    canonicalTerms: [],
    managerBrief,
    createdAt: latestUpdatedAt,
    updatedAt: latestUpdatedAt
  };
}

function renderManagerBriefPage(project, brief) {
  return [
    `# ${project.name} 项目经理摘要`,
    "",
    "## 当前一句话结论",
    "",
    brief.summary,
    "",
    "## 本周关键变化",
    "",
    ...(brief.keyChanges.length
      ? brief.keyChanges.map((item) => `- ${item.type} / ${item.status}：${item.title}。影响：${item.impact} 来源：${item.source ? `[[来源：${item.source}]]` : "待补充"}。`)
      : ["- 暂无需要项目经理关注的关键变化。"]),
    "",
    "## 需要处理",
    "",
    ...(brief.actions.length
      ? brief.actions.map((item) => `- ${item.owner} / ${item.due}：${item.title}。${item.summary} 来源：${item.source ? `[[来源：${item.source}]]` : "待补充"}。`)
      : ["- 暂无待处理动作。"]),
    "",
    "## 风险简报",
    "",
    ...(brief.risks.length
      ? brief.risks.map((item) => `- ${item.severity}：${item.title}。${item.summary} 建议：${item.action}`)
      : ["- 暂无高优先级风险。"]),
    "",
    "## 下一步动作",
    "",
    ...(brief.actions.length
      ? brief.actions.slice(0, 4).map((item) => `- ${item.title}；负责人：${item.owner}；建议时间：${item.due}`)
      : ["- 继续导入沟通资料，等待下一轮编译。"]),
    "",
    "## 技术下钻",
    "",
    "- [[需求基线与变更]]",
    "- [[开发管理编译]]",
    "- [[风险台账]]",
    "- [[待确认事项]]"
  ].join("\n");
}

function buildManagerBriefSummary(project, counts) {
  if (counts.highRiskCount > 0) {
    return `${project.name} 当前存在 ${counts.highRiskCount} 项高风险，另有 ${counts.pendingManagerCount + counts.customerConfirmCount + counts.questionCount} 项需要确认，建议先处理风险和确认闭环。`;
  }
  if (counts.pendingManagerCount || counts.customerConfirmCount) {
    return `${project.name} 当前重点是确认 ${counts.pendingManagerCount + counts.customerConfirmCount} 项变更，确认后再更新需求池和交付计划。`;
  }
  if (counts.riskCount || counts.questionCount) {
    return `${project.name} 当前没有新的强变更，但仍有 ${counts.riskCount} 项风险和 ${counts.questionCount} 个待确认问题需要跟进。`;
  }
  if (counts.changeCount) {
    return `${project.name} 已沉淀 ${counts.changeCount} 条变更记录，当前暂无紧急处理项，可继续按最新基线推进。`;
  }
  return shortText(counts.fallbackSummary || `${project.name} 暂无需要项目经理立即处理的事项。`, 120);
}

function sourceTitleForBrief(sourceFiles, sourceFileId) {
  const source = sourceFiles.find((item) => item.id === sourceFileId);
  return source ? source.title || source.originalName : "";
}

function riskAction(risk) {
  const text = `${risk.title || ""} ${risk.summary || ""}`;
  if (/延期|周期|排期/.test(text)) return "评估排期影响并同步客户。";
  if (/报价|成本|费用/.test(text)) return "确认是否触发商务变更。";
  if (/冲突|不一致|反复/.test(text)) return "拉齐口径并保留确认记录。";
  if (/权限|数据|安全/.test(text)) return "补充权限和数据边界说明。";
  return "指定负责人跟进，并在下次会议前关闭或降级。";
}

function riskSeverityWeight(value) {
  if (["高", "严重", "高风险"].includes(value)) return 3;
  if (["中", "中风险"].includes(value)) return 2;
  return 1;
}

function shortText(value, maxLength = 90) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function communicationTitle(sourceFile) {
  const name = sourceFile.title || sourceFile.originalName || "未命名资料";
  return name.replace(/\.(md|txt|pdf|docx?|xlsx?|mp3|wav|m4a)$/i, "");
}

function communicationType(sourceFile) {
  const name = `${sourceFile.title || ""} ${sourceFile.originalName || ""}`;
  if (sourceFile.category === "audio") return "会议录音";
  if (/会议|评审|纪要|MIC|录音|访谈/i.test(name)) return "会议纪要";
  if (/邮件|mail/i.test(name)) return "邮件沟通";
  if (/微信|聊天|群聊/i.test(name)) return "聊天记录";
  return "文档沟通";
}

function extractParticipants(sourceFile, parsedText = "") {
  const labels = detectSpeakerLabels(sourceFile, parsedText);
  const speakerLabels = normalizeSpeakerLabels(sourceFile.speakerLabels || {});
  const speakers = labels.map((label) => (speakerLabels[label] ? `${label}=${speakerLabels[label]}` : label));
  return speakers.length ? speakers : ["待补充"];
}

function extractMeetingTime(sourceFile) {
  const value = [sourceFile.title, sourceFile.originalName, sourceFile.fileName].filter(Boolean).join(" ");
  const patterns = [
    /((?:19|20)\d{2})[年./_\-\s]+(1[0-2]|0?[1-9])[月./_\-\s]+(3[01]|[12]\d|0?[1-9])(?:[日号])?(?:[\sT_\-]*(?:([01]?\d|2[0-3])(?:[点时:._-]?([0-5]\d))?(?:[分:._-]?([0-5]\d))?秒?))?/g,
    /((?:19|20)\d{2})(1[0-2]|0[1-9])(3[01]|[12]\d|0[1-9])(?:[\sT_\-]?([01]\d|2[0-3])([0-5]\d)?([0-5]\d)?)?/g
  ];
  let latest = 0;
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(value)) !== null) {
      const [, year, month, day, hour = "0", minute = "0", second = "0"] = match;
      const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
      const time = date.getTime();
      if (
        Number.isFinite(time) &&
        date.getFullYear() === Number(year) &&
        date.getMonth() === Number(month) - 1 &&
        date.getDate() === Number(day)
      ) {
        latest = Math.max(latest, time);
      }
    }
  }
  return latest ? new Date(latest).toISOString() : null;
}

function renderProjectOverview(project, db, compilation) {
  const requirementCount = db.requirements.filter((item) => item.projectId === project.id).length;
  const changeCount = db.changes.filter((item) => item.projectId === project.id).length + compilation.changes.length;
  return [
    `# ${project.name} 项目总览`,
    "",
    compilation.projectSummary,
    "",
    "## 当前统计",
    "",
    `- 需求数量：${requirementCount}`,
    `- 变更记录：${changeCount}`,
    `- 新增风险：${compilation.risks.length}`,
    `- 待确认事项：${compilation.openQuestions.length}`,
    "",
    "## 项目知识结构图",
    "",
    "```mermaid",
    "flowchart LR",
    '  source["来源资料"] --> compiler["AI 编译"]',
    '  compiler --> wiki["项目 Wiki"]',
    '  compiler --> changes["待确认变更"]',
    '  compiler --> risks["风险与待确认事项"]',
    '  changes --> requirements["确认后更新需求池"]',
    '  wiki --> export["Markdown / Obsidian 导出"]',
    "```",
    "",
    "## 最近编译结论",
    "",
    compilation.sourceSummary
  ].join("\n");
}

function renderProjectEvolutionPage(project, db, sourceCapsule, compilation) {
  const sources = db.sourceFiles
    .filter((item) => item.projectId === project.id)
    .sort((a, b) => String(extractMeetingTime(a) || a.uploadedAt || "").localeCompare(String(extractMeetingTime(b) || b.uploadedAt || "")))
    .slice(-30);
  const recentChanges = [...(db.changes || [])]
    .filter((item) => item.projectId === project.id)
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")))
    .slice(-20);
  return [
    `# ${project.name} 项目变化过程`,
    "",
    "## 最新资料带来的阶段判断",
    "",
    `- 来源：[[来源：${sourceCapsule.sourceTitle}]]`,
    `- 信号等级：${compilation.signalLevel}`,
    `- 项目阶段：${compilation.routing?.projectPhase || "待继续观察"}`,
    compilation.routing?.routeReason ? `- 路由原因：${compilation.routing.routeReason}` : null,
    "",
    "## 资料时间线",
    "",
    ...sources.map((source) => `- ${formatDateLabel(extractMeetingTime(source) || source.uploadedAt)}：[[来源：${source.title || source.originalName}]]（${source.status || "unknown"}）`),
    "",
    "## 变更演进",
    "",
    ...(recentChanges.length
      ? recentChanges.map((change) => `- ${formatDateLabel(change.createdAt)}：${change.changeType} / ${change.status} / ${change.moduleName} - ${change.title}`)
      : ["- 暂无变更记录。"]),
    "",
    "## 当前编译结论",
    "",
    compilation.projectSummary
  ].filter((line) => line !== null).join("\n");
}

function renderRequirementBaselinePage(project, db, sourceCapsule, compilation) {
  const requirements = db.requirements.filter((item) => item.projectId === project.id);
  const confirmedChanges = db.changes.filter((item) => item.projectId === project.id && item.status === "已确认").slice(-20);
  return [
    `# ${project.name} 需求基线与变更`,
    "",
    "## 证据来源",
    "",
    ...unique([sourceCapsule.sourceTitle, ...db.sourceFiles.filter((item) => item.projectId === project.id && item.status === "compiled").map((item) => item.title || item.originalName)])
      .slice(-20)
      .map((title) => `- [[来源：${title}]]`),
    "",
    "## 当前需求基线",
    "",
    ...(requirements.length
      ? requirements.map((item) => `- ${item.status}：${item.moduleName} - ${item.title}。${item.description || ""}`.trim())
      : ["- 当前还没有人工确认写入的需求。"]),
    "",
    "## 本次识别的待确认变更",
    "",
    ...(compilation.changes.length
      ? compilation.changes.map((change) => `- ${change.changeType} / ${change.certainty} / ${change.moduleName} - ${change.title}：${change.summary || change.afterContent || ""}`)
      : ["- 本次资料未产生可进入需求基线的变更。"]),
    "",
    "## 已确认变更",
    "",
    ...(confirmedChanges.length
      ? confirmedChanges.map((change) => `- ${formatDateLabel(change.updatedAt || change.createdAt)}：${change.moduleName} - ${change.title}`)
      : ["- 暂无已确认变更。"]),
    "",
    "## 待确认事项",
    "",
    ...(compilation.openQuestions.length
      ? compilation.openQuestions.map((item) => `- ${item.owner || "待确认"}：${item.title}。${item.summary}`)
      : ["- 本次资料未新增待确认事项。"])
  ].join("\n");
}

function renderDeliveryCompilationPage(project, db, sourceCapsule, compilation) {
  const candidateChanges = compilation.changes.slice(0, 20);
  const risks = compilation.risks.slice(0, 12);
  const questions = compilation.openQuestions.slice(0, 12);
  return [
    `# ${project.name} 开发管理编译`,
    "",
    "## 口径说明",
    "",
    "- 已确认：已经由人工或客户确认过，才可进入当前需求池。",
    "- 推断：AI 基于多份资料编译出的管理判断，不等于客户最终签字。",
    "- 待确认：需要项目经理或客户继续确认后才能安排开发。",
    "- 低信号：只保留来源摘要，不进入开发任务候选。",
    "",
    "## 功能 / 任务候选",
    "",
    ...(candidateChanges.length
      ? candidateChanges.map((change, index) => `- T-${String(index + 1).padStart(2, "0")} ${change.moduleName} - ${change.title}：状态 ${change.certainty}；依赖 ${change.dependencies?.join("、") || "待梳理"}；产出 ${change.impactScope || "待评估"}。`)
      : ["- 本次资料未生成任务候选。"]),
    "",
    "## 风险与阻塞",
    "",
    ...(risks.length ? risks.map((risk) => `- ${risk.severity || "中"}：${risk.title}。${risk.summary}`) : ["- 本次资料未新增风险。"]),
    "",
    "## 需要继续确认",
    "",
    ...(questions.length ? questions.map((item) => `- ${item.owner || "待确认"}：${item.title}。${item.summary}`) : ["- 本次资料未新增待确认项。"]),
    "",
    "## 最新来源",
    "",
    `- [[来源：${sourceCapsule.sourceTitle}]]`
  ].join("\n");
}

function renderDecisionLogPage(project, db, compilation) {
  const existing = db.decisions.filter((item) => item.projectId === project.id).slice(-30);
  const incoming = compilation.decisions.map((item) => ({ ...item, incoming: true }));
  return [
    `# ${project.name} 决策记录`,
    "",
    ...(existing.length || incoming.length
      ? [...existing, ...incoming].map((item) => `- ${item.incoming ? "本次新增" : formatDateLabel(item.createdAt)}：${item.status || "已记录"} / ${item.title}。${item.summary || ""}`)
      : ["- 暂无决策记录。"])
  ].join("\n");
}

function renderRiskRegisterPage(project, db, compilation) {
  const existing = db.risks.filter((item) => item.projectId === project.id).slice(-30);
  const incoming = compilation.risks.map((item) => ({ ...item, incoming: true }));
  return [
    `# ${project.name} 风险台账`,
    "",
    ...(existing.length || incoming.length
      ? [...existing, ...incoming].map((item) => `- ${item.severity || "中"} / ${item.status || "打开"}：${item.title}。${item.summary || ""}`)
      : ["- 暂无风险。"])
  ].join("\n");
}

function renderOpenQuestionPage(project, db, compilation) {
  const existing = db.openQuestions.filter((item) => item.projectId === project.id).slice(-30);
  const incoming = compilation.openQuestions.map((item) => ({ ...item, incoming: true }));
  return [
    `# ${project.name} 待确认事项`,
    "",
    ...(existing.length || incoming.length
      ? [...existing, ...incoming].map((item) => `- ${item.owner || "待确认"} / ${item.status || "待确认"}：${item.title}。${item.summary || ""}`)
      : ["- 暂无待确认事项。"])
  ].join("\n");
}

function renderTopicPage(topic, sourceCapsule, compilation) {
  return [
    `# ${topic}`,
    "",
    "## 最新来源",
    "",
    `- [[来源：${sourceCapsule.sourceTitle}]]`,
    "",
    "## 最新要点",
    "",
    compilation.sourceSummary,
    "",
    "## 相关产物",
    "",
    `- 变更：${compilation.changes.filter((item) => [item.moduleName, item.title, item.summary].join(" ").includes(topic)).length} 条`,
    `- 风险：${compilation.risks.filter((item) => [item.title, item.summary].join(" ").includes(topic)).length} 条`,
    `- 待确认：${compilation.openQuestions.filter((item) => [item.title, item.summary].join(" ").includes(topic)).length} 条`
  ].join("\n");
}

function renderIndexPage(project, db) {
  const pages = db.wikiPages.filter((item) => item.projectId === project.id);
  const grouped = groupBy(pages, "type");
  const lines = [
    "---",
    "type: index",
    "---",
    "",
    `# ${project.name} Wiki Index`,
    "",
    "## 导航",
    "",
    "- [[项目总览]]",
    "- [[项目变化过程]]",
    "- [[需求基线与变更]]",
    "- [[开发管理编译]]",
    "- [[时间线]]",
    "- [[Wiki 健康检查]]",
    "- [[编译日志]]",
    ""
  ];
  for (const [type, typePages] of Object.entries(grouped)) {
    lines.push(`## ${type}`, "");
    for (const page of typePages.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))).slice(0, 80)) {
      lines.push(`- [[${page.title}]]：${page.summary || ""}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function renderTimelinePage(project, db) {
  const sourceEvents = db.sourceFiles
    .filter((item) => item.projectId === project.id)
    .map((item) => ({ date: extractMeetingTime(item) || item.uploadedAt, label: `资料：[[来源：${item.title || item.originalName}]]`, type: "source" }));
  const changeEvents = db.changes
    .filter((item) => item.projectId === project.id)
    .map((item) => ({ date: item.createdAt, label: `变更：${item.changeType} / ${item.moduleName} - ${item.title}`, type: "change" }));
  const decisionEvents = db.decisions
    .filter((item) => item.projectId === project.id)
    .map((item) => ({ date: item.createdAt, label: `决策：${item.title}`, type: "decision" }));
  const events = [...sourceEvents, ...changeEvents, ...decisionEvents]
    .filter((item) => item.date)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .slice(-120);
  return [
    `# ${project.name} 时间线`,
    "",
    ...(events.length ? events.map((item) => `- ${formatDateLabel(item.date)}：${item.label}`) : ["- 暂无时间线事件。"])
  ].join("\n");
}

function renderLintPage(project, db) {
  const report = buildWikiLintReport(project, db);
  return [
    `# ${project.name} Wiki 健康检查`,
    "",
    `- 页面数量：${report.pageCount}`,
    `- 来源数量：${report.sourceCount}`,
    `- 低信号来源：${report.lowSignalSources.length}`,
    `- 孤立页面：${report.orphanPages.length}`,
    `- 缺少证据的变更：${report.changesMissingEvidence.length}`,
    `- 长期待确认变更：${report.stalePendingChanges.length}`,
    "",
    "## 问题",
    "",
    ...(report.issues.length ? report.issues.map((item) => `- ${item}`) : ["- 暂无明显问题。"])
  ].join("\n");
}

function renderCompileLogPage(project, db, sourceCapsule, compilation) {
  const logs = db.auditLogs
    .filter((item) => item.projectId === project.id && /COMPILED|INGEST|WIKI|MARKDOWN/.test(item.action || ""))
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")))
    .slice(-80)
    .map((item) => `## [${formatDateLabel(item.createdAt)}] ${item.action} | ${item.targetType}\n\n${item.detail || ""}\n`);
  logs.push(`## [${formatDateLabel(nowIso())}] compile | ${sourceCapsule.sourceTitle}\n\n信号等级：${compilation.signalLevel}；变更 ${compilation.changes.length} 条，风险 ${compilation.risks.length} 条，待确认 ${compilation.openQuestions.length} 条。\n`);
  return [`# ${project.name} 编译日志`, "", ...logs].join("\n");
}

export function buildWikiLintReport(project, db) {
  const pages = db.wikiPages.filter((item) => item.projectId === project.id);
  const sources = db.sourceFiles.filter((item) => item.projectId === project.id);
  const evidences = db.sourceEvidences.filter((item) => item.projectId === project.id);
  const sourceIdsWithEvidence = new Set(evidences.map((item) => item.sourceFileId));
  const pageIdsWithLinks = new Set([
    ...pages.flatMap((page) => page.relatedPageIds || []),
    ...db.changes.filter((item) => item.projectId === project.id).flatMap((item) => item.relatedWikiPageIds || [])
  ]);
  const orphanPages = pages.filter((page) => !["INDEX", "PROJECT_OVERVIEW", "LOG", "LINT"].includes(page.type) && !(page.sourceIds || []).length && !pageIdsWithLinks.has(page.id));
  const changesMissingEvidence = db.changes.filter((item) => item.projectId === project.id && !(item.evidenceIds || []).length);
  const stalePendingChanges = db.changes.filter((item) => {
    if (item.projectId !== project.id || !["待确认", "需客户确认"].includes(item.status)) return false;
    const ageMs = Date.now() - Date.parse(item.createdAt || item.updatedAt || nowIso());
    return ageMs > 14 * 24 * 60 * 60 * 1000;
  });
  const lowSignalSources = sources.filter((item) => pages.some((page) => page.type === "SOURCE_SUMMARY" && page.sourceIds?.includes(item.id) && page.signalLevel === "low"));
  const issues = [];
  if (orphanPages.length) issues.push(`有 ${orphanPages.length} 个页面缺少来源或关联。`);
  if (changesMissingEvidence.length) issues.push(`有 ${changesMissingEvidence.length} 条变更缺少证据 ID。`);
  if (stalePendingChanges.length) issues.push(`有 ${stalePendingChanges.length} 条变更超过 14 天仍未确认。`);
  const sourcesWithoutEvidence = sources.filter((item) => item.status === "compiled" && !sourceIdsWithEvidence.has(item.id));
  if (sourcesWithoutEvidence.length) issues.push(`有 ${sourcesWithoutEvidence.length} 个已编译来源缺少证据记录。`);
  return {
    pageCount: pages.length,
    sourceCount: sources.length,
    orphanPages,
    changesMissingEvidence,
    stalePendingChanges,
    lowSignalSources,
    issues
  };
}

function groupBy(items, key) {
  return items.reduce((acc, item) => {
    const group = item[key] || "UNKNOWN";
    acc[group] ||= [];
    acc[group].push(item);
    return acc;
  }, {});
}

function formatDateLabel(value) {
  if (!value) return "未知时间";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value).slice(0, 16);
  return date.toISOString().slice(0, 16).replace("T", " ");
}

function mergeContent(oldContent = "", newContent = "") {
  const section = `\n\n---\n\n## ${new Date().toISOString().slice(0, 10)} 自动编译更新\n\n${newContent}`;
  return oldContent ? `${oldContent}${section}` : newContent;
}

function splitSentences(text) {
  return text
    .replace(/\r/g, "\n")
    .split(/[\n。；;]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 8);
}

function extractSentences(text, keyword) {
  return splitSentences(text).filter((sentence) => sentence.includes(keyword)).slice(0, 8);
}

function summarizeText(text) {
  const sentences = splitSentences(text);
  if (!sentences.length) return "该资料没有可提取的正文内容。";
  return sentences.slice(0, 3).join("。").slice(0, 260);
}

function summarizeSentence(sentence) {
  return sentence.replace(/[：:，,。；;]/g, " ").trim().slice(0, 32);
}

function inferModule(sentence) {
  return MODULE_KEYWORDS.find((item) => sentence.includes(item)) || "项目范围";
}

function inferTitle(sentence) {
  const concept = CONCEPT_KEYWORDS.find((item) => sentence.includes(item));
  if (concept) return concept;
  return summarizeSentence(sentence);
}

function inferProposer(sentence) {
  const match = sentence.match(/由([^，。；\s]{2,5})/);
  return match?.[1] || "AI 编译器";
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^\p{Script=Han}a-z0-9]+/gu, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function normalizeConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0.7;
  return number > 1 ? Math.min(number / 100, 1) : Math.max(Math.min(number, 1), 0);
}
