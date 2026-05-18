const REQUIRED_PRODUCTION_ENV = [
  "DATABASE_URL",
  "SESSION_SECRET"
];

const REQUIRED_OSS_ENV = [
  "ALI_OSS_REGION",
  "ALI_OSS_BUCKET",
  "ALI_OSS_ACCESS_KEY_ID",
  "ALI_OSS_ACCESS_KEY_SECRET"
];

export function validateRuntimeEnv() {
  const errors = [];
  const nodeEnv = process.env.NODE_ENV || "development";
  const storageProvider = process.env.STORAGE_PROVIDER || "local";

  if (nodeEnv === "production") {
    for (const key of REQUIRED_PRODUCTION_ENV) {
      if (!process.env[key]) errors.push(`生产环境缺少 ${key}`);
    }
    if (storageProvider === "local") {
      errors.push("生产环境不允许使用 STORAGE_PROVIDER=local，请配置 STORAGE_PROVIDER=oss。");
    }
  }

  if (storageProvider === "oss") {
    for (const key of REQUIRED_OSS_ENV) {
      if (!process.env[key]) errors.push(`OSS 存储缺少 ${key}`);
    }
  }

  if (process.env.JOB_QUEUE_PROVIDER === "bullmq" && !process.env.REDIS_URL) {
    errors.push("JOB_QUEUE_PROVIDER=bullmq 时必须配置 REDIS_URL。");
  }

  if (errors.length) {
    const error = new Error(`运行环境配置不完整：${errors.join("；")}`);
    error.code = "INVALID_RUNTIME_ENV";
    throw error;
  }
}

export function runtimeCapabilities() {
  return {
    nodeEnv: process.env.NODE_ENV || "development",
    storeProvider: process.env.STORE_PROVIDER || "json",
    storageProvider: process.env.STORAGE_PROVIDER || "local",
    jobQueueProvider: process.env.JOB_QUEUE_PROVIDER || "inline",
    hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
    hasRedisUrl: Boolean(process.env.REDIS_URL),
    ossConfigured: Boolean(
      process.env.ALI_OSS_REGION &&
        process.env.ALI_OSS_BUCKET &&
        process.env.ALI_OSS_ACCESS_KEY_ID &&
        process.env.ALI_OSS_ACCESS_KEY_SECRET
    )
  };
}
