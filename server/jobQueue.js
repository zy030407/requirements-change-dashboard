import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";

let queue = null;
let worker = null;
let inlineHandler = null;
let inlineQueue = Promise.resolve();

export function configureIngestQueue(handler, { startWorker = true } = {}) {
  inlineHandler = handler;
  if (process.env.JOB_QUEUE_PROVIDER !== "bullmq") return { provider: "inline" };
  if (!process.env.REDIS_URL) return { provider: "inline" };

  const connection = new IORedis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null
  });
  queue = new Queue("ingest-jobs", { connection });
  if (startWorker) {
    worker = new Worker(
      "ingest-jobs",
      async (job) => {
        await handler(job.data.jobId);
      },
      {
        connection,
        concurrency: Number(process.env.INGEST_WORKER_CONCURRENCY || 2)
      }
    );
    worker.on("failed", (job, error) => {
      console.error(`BullMQ ingest job ${job?.data?.jobId || job?.id} failed`, error);
    });
  }
  return { provider: "bullmq" };
}

export async function enqueueIngestJob(jobId) {
  if (queue) {
    await queue.add("ingest", { jobId }, { attempts: 3, backoff: { type: "exponential", delay: 5000 } });
    return { provider: "bullmq" };
  }
  inlineQueue = inlineQueue
    .then(() => inlineHandler?.(jobId))
    .catch((error) => {
      console.error(`Ingest job ${jobId} failed`, error);
    });
  return { provider: "inline" };
}

export async function retryQueuedJob(jobId) {
  return enqueueIngestJob(jobId);
}

export async function cancelQueuedJob(jobId) {
  if (!queue) return { provider: "inline", cancelled: false };
  const jobs = await queue.getJobs(["waiting", "delayed", "prioritized", "paused"]);
  const match = jobs.find((job) => job.data?.jobId === jobId);
  if (!match) return { provider: "bullmq", cancelled: false };
  await match.remove();
  return { provider: "bullmq", cancelled: true };
}
