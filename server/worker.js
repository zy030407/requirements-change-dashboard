import "dotenv/config";
import { validateRuntimeEnv } from "./env.js";
import { configureIngestQueue } from "./jobQueue.js";
import { ensureStorage } from "./storage.js";
import { processIngestJob } from "./ingestProcessor.js";

validateRuntimeEnv();
await ensureStorage();
const queue = configureIngestQueue(processIngestJob);

if (queue.provider !== "bullmq") {
  console.warn("Worker started without BullMQ. Set JOB_QUEUE_PROVIDER=bullmq and REDIS_URL for production workers.");
}

console.log(`Ingest worker listening with provider=${queue.provider}`);
