import fs from "node:fs/promises";
import path from "node:path";
import { makeId, nowIso } from "./store.js";

export async function exportProjectMarkdown(db, projectId) {
  const project = db.projects.find((item) => item.id === projectId);
  if (!project) {
    const error = new Error("Project not found");
    error.status = 404;
    throw error;
  }

  const exportId = makeId("exp");
  const root = path.join(process.cwd(), "exports", safeName(`${project.name}-${exportId}`));
  const wikiRoot = path.join(root, "wiki");
  await fs.mkdir(wikiRoot, { recursive: true });

  const pages = db.wikiPages.filter((item) => item.projectId === projectId);
  const sources = db.sourceFiles.filter((item) => item.projectId === projectId);
  const changes = db.changes.filter((item) => item.projectId === projectId);
  const decisions = db.decisions.filter((item) => item.projectId === projectId);
  const risks = db.risks.filter((item) => item.projectId === projectId);
  const openQuestions = db.openQuestions.filter((item) => item.projectId === projectId);

  for (const page of pages) {
    await fs.writeFile(path.join(wikiRoot, `${safeName(page.title)}.md`), renderWikiPage(page));
  }

  await fs.writeFile(path.join(root, "index.md"), renderIndex(project, pages, sources, changes, decisions, risks, openQuestions));
  await fs.writeFile(path.join(root, "log.md"), renderLog(project, db, pages));
  await fs.writeFile(path.join(root, "changes.md"), renderChanges(changes));
  await fs.writeFile(path.join(root, "sources.md"), renderSources(sources));

  const record = {
    id: exportId,
    projectId,
    path: root,
    pageCount: pages.length,
    createdAt: nowIso()
  };
  db.markdownExports.push(record);
  db.auditLogs.push({
    id: makeId("aud"),
    projectId,
    actor: "系统",
    action: "MARKDOWN_EXPORTED",
    targetType: "MarkdownExport",
    targetId: exportId,
    detail: `导出 ${pages.length} 个 Wiki 页面到 ${root}`,
    createdAt: nowIso()
  });
  return record;
}

function renderWikiPage(page) {
  return [
    "---",
    `title: ${quoteYaml(page.title)}`,
    `type: ${page.type}`,
    `status: ${quoteYaml(page.status || "推断")}`,
    `signal: ${quoteYaml(page.signalLevel || "medium")}`,
    `tags: [${(page.tags || []).map(quoteYaml).join(", ")}]`,
    `canonical_terms: [${(page.canonicalTerms || []).map(quoteYaml).join(", ")}]`,
    `updated: ${page.updatedAt}`,
    "---",
    "",
    page.content,
    "",
    "## 元信息",
    "",
    `- 页面类型：${page.type}`,
    `- 状态：${page.status || "推断"}`,
    `- 信号等级：${page.signalLevel || "medium"}`,
    `- 来源数量：${page.sourceIds?.length || 0}`,
    `- 关联页面：${page.relatedPageIds?.length || 0}`
  ].join("\n");
}

function renderIndex(project, pages, sources, changes, decisions, risks, openQuestions) {
  const grouped = groupBy(pages, "type");
  const lines = [
    `# ${project.name} Wiki Index`,
    "",
    "## 概览",
    "",
    `- 来源资料：${sources.length}`,
    `- Wiki 页面：${pages.length}`,
    `- 需求变更：${changes.length}`,
    `- 决策：${decisions.length}`,
    `- 风险：${risks.length}`,
    `- 待确认事项：${openQuestions.length}`,
    ""
  ];

  for (const [type, typePages] of Object.entries(grouped)) {
    lines.push(`## ${type}`, "");
    for (const page of typePages) {
      lines.push(`- [[wiki/${safeName(page.title)}|${page.title}]] - ${page.summary || ""}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function renderLog(project, db, pages) {
  const logs = db.auditLogs
    .filter((item) => item.projectId === project.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((item) => [`## [${item.createdAt.slice(0, 10)}] ${item.action} | ${item.targetType}`, "", item.detail, ""].join("\n"));
  if (!logs.length) {
    logs.push(`## [${new Date().toISOString().slice(0, 10)}] export | ${project.name}\n\n导出 ${pages.length} 个页面。\n`);
  }
  return [`# ${project.name} Wiki Log`, "", ...logs].join("\n");
}

function renderChanges(changes) {
  const lines = ["# 需求变更记录", ""];
  for (const change of changes) {
    lines.push(
      `## ${change.changeType} | ${change.moduleName} > ${change.title}`,
      "",
      `- 状态：${change.status}`,
      `- 置信度：${Math.round((change.confidence || 0) * 100)}%`,
      `- 摘要：${change.summary}`,
      "",
      "### 变更前",
      "",
      change.beforeContent || "无",
      "",
      "### 变更后",
      "",
      change.afterContent || "无",
      ""
    );
  }
  return lines.join("\n");
}

function renderSources(sources) {
  const lines = ["# 来源资料", ""];
  for (const source of sources) {
    const audioMeta =
      source.category === "audio" && source.speakerCount
        ? `，说话人分离：${source.speakerCount} 人`
        : "";
    lines.push(`- ${source.originalName} (${source.category}) - ${source.status}${audioMeta}`);
  }
  return lines.join("\n");
}

function groupBy(items, key) {
  return items.reduce((acc, item) => {
    acc[item[key]] ||= [];
    acc[item[key]].push(item);
    return acc;
  }, {});
}

function safeName(value) {
  return value.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim().slice(0, 120);
}

function quoteYaml(value) {
  return `"${String(value).replaceAll("\"", "\\\"")}"`;
}
