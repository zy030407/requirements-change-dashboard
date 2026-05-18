export const MODEL_CAPABILITIES = [
  { key: "LLM", label: "大模型", description: "用于 Wiki 编译、需求差异识别和结构化总结。" },
  { key: "VISION", label: "视觉理解", description: "用于截图、界面图、流程图和图片资料理解。" },
  { key: "ASR", label: "语音转写", description: "用于会议录音、电话录音和访谈音频转写。" },
  { key: "OCR", label: "OCR", description: "用于扫描件、图片文字和复杂 PDF 版面识别。" },
  { key: "PDF_PARSER", label: "PDF 解析", description: "用于普通 PDF 文本抽取或 MinerU 等增强解析。" },
  { key: "EMBEDDING", label: "向量检索", description: "用于后续语义搜索、相似需求和来源召回。" }
];

const CAPABILITY_KEYS = new Set(MODEL_CAPABILITIES.map((item) => item.key));

export function defaultModelAdapters(timestamp = new Date().toISOString()) {
  return [
    {
      id: "mdl_openai_llm",
      name: "OpenAI 兼容 Wiki 编译模型",
      provider: "openai-compatible",
      capability: "LLM",
      protocol: "chat-completions",
      model: process.env.OPENAI_TEXT_MODEL || "gpt-4.1-mini",
      baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
      apiKey: "",
      envVarName: "OPENAI_API_KEY",
      status: "active",
      description: "所有 LLM 按 OpenAI API 兼容方式接入，填写 base 地址、模型名称和 key 即可。",
      timeoutSeconds: 120,
      createdAt: timestamp,
      updatedAt: timestamp
    },
    {
      id: "mdl_openai_vision",
      name: "OpenAI 图片理解模型",
      provider: "openai",
      capability: "VISION",
      protocol: "responses",
      model: process.env.OPENAI_VISION_MODEL || process.env.OPENAI_TEXT_MODEL || "gpt-4.1-mini",
      baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
      apiKey: "",
      envVarName: "OPENAI_API_KEY",
      status: "active",
      description: "默认用于界面截图、图片批注和图形资料的视觉理解。",
      timeoutSeconds: 120,
      createdAt: timestamp,
      updatedAt: timestamp
    },
    {
      id: "mdl_doubao_asr",
      name: "豆包语音识别",
      provider: "doubao",
      capability: "ASR",
      protocol: "doubao-asr",
      model: process.env.DOUBAO_ASR_RESOURCE_ID || "volc.bigasr.auc_turbo",
      baseUrl: process.env.DOUBAO_ASR_BASE_URL || "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash",
      appKey: process.env.DOUBAO_ASR_APP_KEY || "",
      apiKey: "",
      envVarName: "DOUBAO_ASR_ACCESS_KEY",
      status: "active",
      description: "默认语音识别服务，按火山引擎豆包录音文件极速版配置 App Key、Access Key 和资源 ID。",
      timeoutSeconds: 300,
      createdAt: timestamp,
      updatedAt: timestamp
    },
    {
      id: "mdl_local_pdf",
      name: "本地 PDF 文本解析",
      provider: "local",
      capability: "PDF_PARSER",
      protocol: "local-pdf-parse",
      model: "pdf-parse",
      baseUrl: "",
      apiKey: "",
      envVarName: "",
      status: "active",
      description: "本地抽取 PDF 文本，适合普通文本型 PDF。",
      timeoutSeconds: 60,
      createdAt: timestamp,
      updatedAt: timestamp
    },
    {
      id: "mdl_mineru_ocr",
      name: "MinerU 增强文档解析",
      provider: "mineru",
      capability: "OCR",
      protocol: "mineru",
      model: "mineru",
      baseUrl: process.env.PDF_MINERU_BASE_URL || "",
      apiKey: "",
      envVarName: "PDF_MINERU_API_KEY",
      status: "disabled",
      description: "预留给复杂 PDF、扫描件、表格、公式和 OCR 解析，可接官方 API 或自托管服务。",
      timeoutSeconds: 300,
      createdAt: timestamp,
      updatedAt: timestamp
    }
  ];
}

export function defaultModelPipeline() {
  return {
    LLM: "mdl_openai_llm",
    VISION: "mdl_openai_vision",
    ASR: "mdl_doubao_asr",
    OCR: "",
    PDF_PARSER: "mdl_local_pdf",
    EMBEDDING: ""
  };
}

export function ensureModelRegistry(db) {
  if (!Array.isArray(db.modelAdapters)) db.modelAdapters = [];
  if (!db.modelPipeline || typeof db.modelPipeline !== "object") db.modelPipeline = defaultModelPipeline();
  db.modelAdapters = db.modelAdapters.filter((adapter) => adapter.id !== "mdl_openai_asr");

  const existingIds = new Set(db.modelAdapters.map((item) => item.id));
  for (const adapter of defaultModelAdapters()) {
    const existing = db.modelAdapters.find((item) => item.id === adapter.id);
    if (!existingIds.has(adapter.id)) {
      db.modelAdapters.push(adapter);
    } else {
      Object.assign(existing, {
        name: adapter.name,
        provider: adapter.provider,
        capability: adapter.capability,
        protocol: adapter.protocol,
        model: existing.model || adapter.model,
        baseUrl: existing.baseUrl || adapter.baseUrl,
        envVarName: existing.envVarName ?? adapter.envVarName,
        description: adapter.description,
        timeoutSeconds: existing.timeoutSeconds || adapter.timeoutSeconds
      });
      if (adapter.id === "mdl_doubao_asr") {
        if (!existing.model || existing.model === "volc.bigasr.sauc.duration") existing.model = adapter.model;
        if (!existing.baseUrl || existing.baseUrl.startsWith("wss://") || existing.baseUrl.includes("/sauc/")) {
          existing.baseUrl = adapter.baseUrl;
        }
      }
    }
  }

  const defaults = defaultModelPipeline();
  for (const key of Object.keys(defaults)) {
    if (!(key in db.modelPipeline)) db.modelPipeline[key] = defaults[key];
  }
  if (db.modelPipeline.ASR === "mdl_openai_asr") db.modelPipeline.ASR = "mdl_doubao_asr";

  return db;
}

export function getActiveModelAdapter(db, capability) {
  ensureModelRegistry(db);
  const key = normalizeCapability(capability);
  const configuredId = db.modelPipeline?.[key];
  const configured = db.modelAdapters.find((adapter) => adapter.id === configuredId);
  if (configured?.status === "active") return configured;
  return db.modelAdapters.find((adapter) => adapter.capability === key && adapter.status === "active") || null;
}

export function modelRegistryView(db) {
  ensureModelRegistry(db);
  return {
    capabilities: MODEL_CAPABILITIES,
    pipeline: db.modelPipeline,
    adapters: db.modelAdapters.map((adapter) => ({
      ...adapter,
      apiKey: "",
      envConfigured: isAdapterEnvConfigured(adapter),
      hasApiKey: Boolean(adapter.apiKey),
      secretStorage: adapter.envVarName ? "env" : "none"
    }))
  };
}

export function normalizeModelAdapterInput(input, fallback = {}) {
  const timestamp = new Date().toISOString();
  const capability = normalizeCapability(input.capability || fallback.capability || "LLM");
  const provider = normalizeText(input.provider ?? fallback.provider ?? "openai-compatible");
  const protocol = normalizeText(input.protocol ?? fallback.protocol ?? defaultProtocolForCapability(capability));
  const status = ["active", "disabled", "draft"].includes(input.status) ? input.status : fallback.status || "active";

  return {
    name: normalizeText(input.name ?? fallback.name ?? "未命名模型适配器"),
    provider,
    capability,
    protocol,
    model: normalizeText(input.model ?? fallback.model ?? ""),
    baseUrl: normalizeText(input.baseUrl ?? fallback.baseUrl ?? ""),
    appKey: normalizeText(input.appKey ?? fallback.appKey ?? ""),
    apiKey: normalizeSecret(input.apiKey, fallback.apiKey),
    envVarName: normalizeText(input.envVarName ?? fallback.envVarName ?? ""),
    status,
    description: normalizeText(input.description ?? fallback.description ?? ""),
    timeoutSeconds: normalizeTimeout(input.timeoutSeconds ?? fallback.timeoutSeconds),
    createdAt: fallback.createdAt || timestamp,
    updatedAt: timestamp
  };
}

export function updateModelPipeline(db, nextPipeline) {
  ensureModelRegistry(db);
  for (const item of MODEL_CAPABILITIES) {
    if (!(item.key in nextPipeline)) continue;
    const nextId = nextPipeline[item.key] || "";
    if (nextId && !db.modelAdapters.some((adapter) => adapter.id === nextId && adapter.capability === item.key)) {
      const error = new Error(`Invalid adapter for ${item.key}`);
      error.status = 400;
      throw error;
    }
    db.modelPipeline[item.key] = nextId;
  }
  return db.modelPipeline;
}

export function adapterClientConfig(adapter, fallbackEnvVarName = "OPENAI_API_KEY") {
  const envVarName = adapter?.envVarName || fallbackEnvVarName;
  const envApiKey = envVarName ? process.env[envVarName] : "";
  const provider = String(adapter?.provider || "").toLowerCase();
  const apiKey = adapter?.apiKey || envApiKey || (adapter?.baseUrl && provider !== "openai" ? "local-dev-key" : "");
  return {
    apiKey,
    baseURL: adapter?.baseUrl || undefined,
    model: adapter?.model || "",
    envVarName
  };
}

export function isOpenAICompatibleAdapter(adapter) {
  return ["openai", "openai-compatible", "openrouter", "deepseek", "qwen", "kimi", "minimax", "glm", "ollama"].includes(
    String(adapter?.provider || "").toLowerCase()
  );
}

function normalizeCapability(value) {
  const capability = String(value || "").trim().toUpperCase();
  return CAPABILITY_KEYS.has(capability) ? capability : "LLM";
}

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeSecret(value, fallbackValue = "") {
  if (value == null) return fallbackValue || "";
  const secret = String(value).trim();
  return secret || fallbackValue || "";
}

function normalizeTimeout(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 120;
  return Math.min(Math.max(Math.round(number), 10), 900);
}

function defaultProtocolForCapability(capability) {
  if (capability === "ASR") return "doubao-asr";
  if (capability === "PDF_PARSER") return "local-pdf-parse";
  if (capability === "OCR") return "mineru";
  return capability === "LLM" ? "chat-completions" : "responses";
}

function isAdapterEnvConfigured(adapter) {
  if (adapter.apiKey) return true;
  if (!adapter.envVarName) return adapter.provider === "local";
  return Boolean(process.env[adapter.envVarName]);
}
