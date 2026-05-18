import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import OSS from "ali-oss";

const uploadRoot = path.join(process.cwd(), process.env.UPLOAD_DIR || "uploads");
const provider = process.env.STORAGE_PROVIDER || "local";
let ossClient = null;

export function storageProvider() {
  return provider;
}

export function getUploadRoot() {
  return uploadRoot;
}

export async function ensureStorage() {
  if (provider === "local") {
    await fs.mkdir(uploadRoot, { recursive: true });
  } else {
    getOssClient();
  }
}

export async function storeUploadedFile(file, { projectId, originalName }) {
  const contentHash = await fileHash(file.path);
  if (provider === "oss") {
    const client = getOssClient();
    const objectKey = buildObjectKey(projectId, originalName);
    const result = await client.put(objectKey, file.path, {
      headers: {
        "Content-Type": file.mimetype || "application/octet-stream"
      }
    });
    await fs.rm(file.path, { force: true }).catch(() => {});
    return {
      storageProvider: "oss",
      bucket: process.env.ALI_OSS_BUCKET,
      objectKey,
      etag: result?.res?.headers?.etag || result?.etag || "",
      contentHash,
      storageRegion: process.env.ALI_OSS_REGION,
      path: `oss://${process.env.ALI_OSS_BUCKET}/${objectKey}`
    };
  }

  return {
    storageProvider: "local",
    bucket: null,
    objectKey: path.relative(process.cwd(), file.path),
    etag: "",
    contentHash,
    storageRegion: "local",
    path: file.path
  };
}

export async function createUploadToken({ projectId, originalName, mimeType }) {
  if (provider !== "oss") {
    return {
      provider: "local",
      uploadMode: "backend",
      maxBackendUploadSize: 250 * 1024 * 1024
    };
  }

  const client = getOssClient();
  const objectKey = buildObjectKey(projectId, originalName);
  const expires = Number(process.env.ALI_OSS_PRIVATE_URL_TTL_SECONDS || 900);
  const uploadUrl = client.signatureUrl(objectKey, {
    method: "PUT",
    expires,
    "Content-Type": mimeType || "application/octet-stream"
  });
  return {
    provider: "oss",
    uploadMode: "direct-put",
    bucket: process.env.ALI_OSS_BUCKET,
    region: process.env.ALI_OSS_REGION,
    endpoint: process.env.ALI_OSS_ENDPOINT || "",
    objectKey,
    method: "PUT",
    uploadUrl,
    headers: {
      "Content-Type": mimeType || "application/octet-stream"
    },
    expiresAt: new Date(Date.now() + expires * 1000).toISOString()
  };
}

export async function statObject(objectKey) {
  if (provider !== "oss") return null;
  const client = getOssClient();
  const result = await client.head(objectKey);
  return {
    etag: result?.res?.headers?.etag || "",
    size: Number(result?.res?.headers?.["content-length"] || 0),
    mimeType: result?.res?.headers?.["content-type"] || ""
  };
}

export async function signedFileUrl(sourceFile, { download = false } = {}) {
  if (sourceFile.storageProvider === "oss" || sourceFile.objectKey?.startsWith("projects/")) {
    const client = getOssClient();
    const expires = Number(process.env.ALI_OSS_PRIVATE_URL_TTL_SECONDS || 900);
    const response = download
      ? {
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(sourceFile.originalName || sourceFile.title || "source-file")}`
        }
      : {
          "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(sourceFile.originalName || sourceFile.title || "source-file")}`
        };
    return {
      provider: "oss",
      url: client.signatureUrl(sourceFile.objectKey, { expires, response }),
      expiresAt: new Date(Date.now() + expires * 1000).toISOString()
    };
  }

  return {
    provider: "local",
    url: `/api/source-files/${sourceFile.id}/raw`,
    expiresAt: null
  };
}

export async function withMaterializedSourceFile(sourceFile, callback) {
  if (!(sourceFile.storageProvider === "oss" || sourceFile.objectKey?.startsWith("projects/"))) {
    return callback({ ...sourceFile, path: resolveLocalPath(sourceFile) });
  }

  const client = getOssClient();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "requirements-source-"));
  const tempPath = path.join(tempDir, safeLocalName(sourceFile.originalName || sourceFile.fileName || "source"));
  try {
    await client.get(sourceFile.objectKey, tempPath);
    return await callback({ ...sourceFile, path: tempPath });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export function resolveLocalPath(sourceFile) {
  if (sourceFile.storageProvider === "oss" || sourceFile.objectKey?.startsWith("projects/")) return null;
  const candidates = [];
  const addCandidate = (value) => {
    if (!value) return;
    candidates.push(path.isAbsolute(value) ? value : path.resolve(value));
  };

  addCandidate(sourceFile.path);
  addCandidate(sourceFile.objectKey);

  const storedName = path.basename(sourceFile.path || sourceFile.objectKey || "");
  if (sourceFile.projectId && storedName) {
    candidates.push(path.join(uploadRoot, sourceFile.projectId, storedName));
  }

  return candidates.find((candidate) => fsSync.existsSync(candidate)) || candidates[0];
}

function getOssClient() {
  if (ossClient) return ossClient;
  ossClient = new OSS({
    region: process.env.ALI_OSS_REGION,
    bucket: process.env.ALI_OSS_BUCKET,
    endpoint: process.env.ALI_OSS_ENDPOINT || undefined,
    accessKeyId: process.env.ALI_OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.ALI_OSS_ACCESS_KEY_SECRET,
    secure: process.env.ALI_OSS_SECURE !== "false"
  });
  return ossClient;
}

function buildObjectKey(projectId, originalName) {
  const date = new Date().toISOString().slice(0, 10);
  return `projects/${projectId}/sources/${date}/${Date.now()}-${randomUUID().slice(0, 8)}-${safeLocalName(originalName)}`;
}

function safeLocalName(value = "file") {
  return String(value)
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180) || "file";
}

async function fileHash(filePath) {
  const hash = createHash("sha256");
  const handle = await fs.open(filePath, "r");
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
    return hash.digest("hex");
  } finally {
    await handle.close().catch(() => {});
  }
}
