import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import mammoth from "mammoth";
import ExcelJS from "exceljs";
import OpenAI from "openai";
import { adapterClientConfig, getActiveModelAdapter, isOpenAICompatibleAdapter } from "./modelRegistry.js";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const pdfParseModule = require("pdf-parse");
const pdfParse = pdfParseModule.default || pdfParseModule;

const TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".csv", ".json", ".log"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".webm"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const WORD_EXTENSIONS = new Set([".docx"]);
const EXCEL_EXTENSIONS = new Set([".xlsx", ".xls"]);

export function classifyFile(filename, mimeType = "") {
  const ext = path.extname(filename).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  if (AUDIO_EXTENSIONS.has(ext) || mimeType.startsWith("audio/")) return "audio";
  if (IMAGE_EXTENSIONS.has(ext) || mimeType.startsWith("image/")) return "image";
  if (WORD_EXTENSIONS.has(ext)) return "word";
  if (EXCEL_EXTENSIONS.has(ext)) return "excel";
  if (ext === ".pdf" || mimeType === "application/pdf") return "pdf";
  return "unknown";
}

export async function extractSourceContent(sourceFile, db = {}) {
  const category = sourceFile.category || classifyFile(sourceFile.originalName, sourceFile.mimeType);
  const ext = path.extname(sourceFile.originalName).toLowerCase();

  if (category === "text") {
    return { parsedText: await fs.readFile(sourceFile.path, "utf8"), transcriptText: null };
  }

  if (category === "pdf") {
    return { parsedText: await parsePdf(sourceFile, db), transcriptText: null };
  }

  if (category === "word") {
    const result = await mammoth.extractRawText({ path: sourceFile.path });
    return { parsedText: result.value || "", transcriptText: null };
  }

  if (category === "excel") {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(sourceFile.path);
    const lines = [];
    workbook.eachSheet((sheet) => {
      lines.push(`# Sheet: ${sheet.name}`);
      sheet.eachRow((row) => {
        const values = row.values
          .slice(1)
          .map((value) => formatExcelCell(value))
          .filter(Boolean);
        if (values.length) lines.push(values.join(" | "));
      });
    });
    return { parsedText: lines.join("\n"), transcriptText: null };
  }

  if (category === "audio") {
    const transcriptText = await transcribeAudio(sourceFile, db);
    return { parsedText: transcriptText, transcriptText };
  }

  if (category === "image") {
    const parsedText = await understandImage(sourceFile.path, ext, db);
    return { parsedText, transcriptText: null };
  }

  return {
    parsedText: `无法自动解析文件 ${sourceFile.originalName}。请补充手动纪要后重新编译。`,
    transcriptText: null
  };
}

async function parsePdf(sourceFile, db) {
  const adapter = getActiveModelAdapter(db, "PDF_PARSER");
  if (adapter?.protocol === "mineru" && adapter.baseUrl) {
    console.warn("MinerU PDF adapter is configured but not implemented yet; falling back to local pdf-parse.");
  }
  const data = await pdfParse(await fs.readFile(sourceFile.path));
  return data.text || "";
}

function formatExcelCell(value) {
  if (value == null) return "";
  if (typeof value === "object") {
    if (value.text) return String(value.text);
    if (value.result) return String(value.result);
    if (value.richText) return value.richText.map((item) => item.text).join("");
    if (value.hyperlink) return String(value.hyperlink);
    return JSON.stringify(value);
  }
  return String(value);
}

async function transcribeAudio(sourceFile, db) {
  const adapter = getActiveModelAdapter(db, "ASR");
  if (String(adapter?.provider || "").toLowerCase() === "doubao") {
    return transcribeDoubaoAudio(adapter, sourceFile);
  }
  const client = createOpenAIClient(adapter, "OPENAI_API_KEY");

  if (!client) {
    const error = new Error(`未配置可用的语音识别模型，录音不会使用占位文本编译。请在模型后台配置 ASR 后重新转写。`);
    error.code = "ASR_NOT_CONFIGURED";
    throw error;
  }

  const result = await client.audio.transcriptions.create({
    file: fsSync.createReadStream(sourceFile.path),
    model: adapter?.model || process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-transcribe"
  });
  return result.text || "";
}

async function transcribeDoubaoAudio(adapter, sourceFile) {
  const apiSecret = adapter?.apiKey || (adapter?.envVarName ? process.env[adapter.envVarName] : "");
  const appKey = adapter?.appKey || process.env.DOUBAO_ASR_APP_KEY;
  const requestOptions = buildDoubaoAsrRequestOptions(sourceFile);
  const endpoint = normalizeDoubaoAsrEndpoint(adapter?.baseUrl || process.env.DOUBAO_ASR_BASE_URL);
  const resourceId = normalizeDoubaoAsrResourceId(adapter?.model || process.env.DOUBAO_ASR_RESOURCE_ID);
  const speakerLine = requestOptions.request.enable_speaker_info
    ? `本次录音已请求 ${requestOptions.meeting.speakerCount} 人会议的说话人聚类分离，参数将使用 enable_speaker_info=true、ssd_version=${requestOptions.request.ssd_version}、show_utterances=true。`
    : "本次录音未开启说话人聚类分离。";

  if (!apiSecret && !appKey) {
    const error = new Error(`未配置豆包语音识别鉴权信息，录音不会使用占位文本编译。旧版控制台请配置 App Key + Access Key；新版控制台只需配置 API Key。${speakerLine}`);
    error.code = "DOUBAO_ASR_NOT_CONFIGURED";
    throw error;
  }

  const preparedAudio = await prepareDoubaoAudioPayload(sourceFile);
  const requestId = randomUUID();
  const headers = {
    "Content-Type": "application/json",
    "X-Api-Resource-Id": resourceId,
    "X-Api-Request-Id": requestId,
    "X-Api-Sequence": "-1"
  };
  if (appKey && apiSecret) {
    headers["X-Api-App-Key"] = appKey;
    headers["X-Api-Access-Key"] = apiSecret;
  } else {
    headers["X-Api-Key"] = apiSecret || appKey;
  }
  const body = {
    user: {
      uid: appKey || "requirements-dashboard"
    },
    audio: {
      data: preparedAudio.base64
    },
    request: requestOptions.request
  };

  const response = await fetchWithTimeout(
    endpoint,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    },
    adapter?.timeoutSeconds || 300
  );
  const responseText = await response.text();
  const responseJson = safeJsonParse(responseText);
  const statusCode = response.headers.get("x-api-status-code");
  const providerMessage = response.headers.get("x-api-message") || responseJson?.message || responseJson?.error?.message || "";

  if (!response.ok || (statusCode && statusCode !== "20000000")) {
    const error = new Error(
      [
        `豆包语音识别失败：${providerMessage || `HTTP ${response.status}`}`,
        statusCode ? `状态码 ${statusCode}` : null,
        response.headers.get("x-tt-logid") ? `LogID ${response.headers.get("x-tt-logid")}` : null
      ]
        .filter(Boolean)
        .join("，")
    );
    error.code = "DOUBAO_ASR_FAILED";
    error.providerStatusCode = statusCode;
    error.providerLogId = response.headers.get("x-tt-logid");
    error.providerBody = responseJson || responseText;
    throw error;
  }

  const transcript = formatDoubaoTranscript(responseJson, {
    speakerCount: requestOptions.meeting.speakerCount,
    convertedFormat: preparedAudio.format,
    originalFormat: inferAudioFormat(sourceFile.originalName || sourceFile.fileName || "")
  });
  if (!transcript.trim()) {
    const error = new Error(`豆包语音识别成功返回，但结果中没有可用转写文本。${speakerLine}`);
    error.code = "DOUBAO_ASR_EMPTY_RESULT";
    error.providerStatusCode = statusCode;
    error.providerBody = responseJson;
    throw error;
  }
  return transcript;
}

function buildDoubaoAsrRequestOptions(sourceFile = {}) {
  const speakerCount = normalizeSpeakerCount(sourceFile.asrOptions?.speakerCount || sourceFile.speakerCount);
  return {
    audio: {
      format: inferAudioFormat(sourceFile.originalName || sourceFile.fileName || ""),
      url: null
    },
    request: {
      model_name: "bigmodel",
      enable_itn: true,
      enable_punc: true,
      enable_speaker_info: Boolean(sourceFile.enableSpeakerDiarization ?? sourceFile.asrOptions?.enableSpeakerInfo),
      ssd_version: sourceFile.asrOptions?.ssdVersion || "200",
      show_utterances: true
    },
    meeting: {
      speakerCount
    }
  };
}

function normalizeDoubaoAsrEndpoint(baseUrl = "") {
  const fallback = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash";
  if (!baseUrl) return fallback;
  if (baseUrl.startsWith("wss://") || baseUrl.includes("/sauc/")) return fallback;
  return baseUrl;
}

function normalizeDoubaoAsrResourceId(model = "") {
  if (!model || model === "volc.bigasr.sauc.duration") return "volc.bigasr.auc_turbo";
  return model;
}

async function prepareDoubaoAudioPayload(sourceFile) {
  const originalFormat = inferAudioFormat(sourceFile.originalName || sourceFile.fileName || "");
  const fileSize = Number(sourceFile.size || 0);
  if (fileSize > 100 * 1024 * 1024) {
    const error = new Error("豆包录音文件极速版单文件限制为 100MB，请压缩音频或后续接入标准版异步识别。");
    error.code = "DOUBAO_ASR_FILE_TOO_LARGE";
    throw error;
  }

  if (["mp3", "wav", "ogg"].includes(originalFormat)) {
    return {
      format: originalFormat,
      base64: await fs.readFile(sourceFile.path, "base64")
    };
  }

  const converted = await convertAudioToWav(sourceFile.path);
  try {
    return {
      format: "wav",
      base64: await fs.readFile(converted.path, "base64")
    };
  } finally {
    await fs.rm(converted.path, { force: true }).catch(() => {});
  }
}

async function convertAudioToWav(filePath) {
  const outputPath = path.join(os.tmpdir(), `doubao-asr-${randomUUID()}.wav`);
  try {
    await execFileAsync("ffmpeg", ["-y", "-i", filePath, "-vn", "-ac", "1", "-ar", "16000", outputPath], {
      timeout: 120_000,
      maxBuffer: 1024 * 1024
    });
    return { path: outputPath };
  } catch (error) {
    await fs.rm(outputPath, { force: true }).catch(() => {});
    const wrapped = new Error("当前音频格式需要先转为 WAV，但本机 ffmpeg 转码失败。请上传 MP3/WAV/OGG，或检查 ffmpeg 是否可用。");
    wrapped.code = "DOUBAO_ASR_TRANSCODE_FAILED";
    wrapped.cause = error;
    throw wrapped;
  }
}

function normalizeSpeakerCount(value) {
  const count = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(count)) return 4;
  return Math.min(10, Math.max(1, count));
}

function inferAudioFormat(filename) {
  const ext = path.extname(filename).replace(".", "").toLowerCase();
  if (["mp3", "wav", "ogg"].includes(ext)) return ext;
  return ext || "mp3";
}

function formatDoubaoTranscript(payload, options = {}) {
  const result = payload?.result || payload?.data?.result || payload?.data || payload || {};
  const utterances = Array.isArray(result.utterances)
    ? result.utterances
    : Array.isArray(payload?.utterances)
      ? payload.utterances
      : [];
  if (utterances.length) {
    return utterances
      .map((item, index) => formatDoubaoUtterance(item, index, options.speakerCount))
      .filter(Boolean)
      .join("\n");
  }
  return String(result.text || payload?.text || "").trim();
}

function formatDoubaoUtterance(item, index, speakerCount = 0) {
  const text = String(item.text || "").trim();
  if (!text) return "";
  const rawSpeaker =
    item.speaker ||
    item.speaker_id ||
    item.speakerId ||
    item.spk ||
    item.additions?.speaker ||
    item.additions?.speaker_id ||
    "";
  const speakerLabel = rawSpeaker
    ? `说话人${String(rawSpeaker).replace(/^speaker[_-]?/i, "")}`
    : speakerCount > 1
      ? `说话人${(index % speakerCount) + 1}`
      : "说话人";
  const start = formatAsrTime(item.start_time ?? item.startTime ?? item.start);
  const end = formatAsrTime(item.end_time ?? item.endTime ?? item.end);
  const range = start || end ? ` ${start || "00:00"}-${end || ""}` : "";
  return `[${speakerLabel}${range}] ${text}`;
}

function formatAsrTime(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms)) return "";
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url, options, timeoutSeconds) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error(`豆包语音识别请求超过 ${timeoutSeconds} 秒未返回。`);
      timeoutError.code = "DOUBAO_ASR_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function understandImage(filePath, ext, db) {
  const adapter = getActiveModelAdapter(db, "VISION") || getActiveModelAdapter(db, "LLM");
  const client = createOpenAIClient(adapter, "OPENAI_API_KEY");

  if (!client) {
    return [
      `未配置 ${adapter?.envVarName || "OPENAI_API_KEY"}，当前使用图片占位理解。`,
      "图片可能包含界面截图、客户批注或需求流程，请在模型后台配置可用的视觉理解模型后重新编译。"
    ].join("\n");
  }

  const mimeType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : `image/${ext.replace(".", "")}`;
  const imageBase64 = await fs.readFile(filePath, "base64");

  if (adapter?.protocol === "chat-completions") {
    const response = await client.chat.completions.create({
      model: adapter.model || process.env.OPENAI_TEXT_MODEL || "gpt-4.1-mini",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "请读取这张组织沟通或业务资料相关图片，提取可用于知识沉淀、需求管理、决策追踪的文字、界面元素、业务规则、待确认点和风险。输出中文要点。"
            },
            {
              type: "image_url",
              image_url: { url: `data:${mimeType};base64,${imageBase64}` }
            }
          ]
        }
      ]
    });
    return response.choices?.[0]?.message?.content || "";
  }

  const response = await client.responses.create({
    model: adapter?.model || process.env.OPENAI_TEXT_MODEL || "gpt-4.1-mini",
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "请读取这张组织沟通或业务资料相关图片，提取可用于知识沉淀、需求管理、决策追踪的文字、界面元素、业务规则、待确认点和风险。输出中文要点。"
          },
          {
            type: "input_image",
            image_url: `data:${mimeType};base64,${imageBase64}`
          }
        ]
      }
    ]
  });

  return response.output_text || "";
}

function createOpenAIClient(adapter, fallbackEnvVarName) {
  if (!adapter || !isOpenAICompatibleAdapter(adapter)) return null;
  const { apiKey, baseURL } = adapterClientConfig(adapter, fallbackEnvVarName);
  if (!apiKey) return null;
  return new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {})
  });
}
