import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createSeedDb } from "./seed.js";
import { ensureModelRegistry } from "./modelRegistry.js";
import { ensureAuthData } from "./auth.js";

const rootDir = process.cwd();
const dataDir = process.env.DATA_DIR || "data";
const dbPath = path.join(rootDir, dataDir, "db.json");
const appStateId = process.env.APP_STATE_ID || "default";
let mutationQueue = Promise.resolve();
let postgresClient = null;

export function makeId(prefix) {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export async function ensureDb() {
  if (usePostgresStore()) {
    await ensurePostgresDb();
    return;
  }
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  try {
    await fs.access(dbPath);
  } catch {
    await saveDb(createSeedDb());
  }
}

export async function loadDb() {
  if (usePostgresStore()) {
    await ensureDb();
    const sql = await getPostgresClient();
    const rows = await sql`SELECT data FROM app_state WHERE id = ${appStateId} LIMIT 1`;
    const state = rows?.[0]?.data || createSeedDb();
    const db = ensureModelRegistry(typeof state === "string" ? JSON.parse(state) : state);
    ensureAuthData(db);
    return db;
  }
  await ensureDb();
  const raw = await fs.readFile(dbPath, "utf8");
  const db = ensureModelRegistry(JSON.parse(raw));
  ensureAuthData(db);
  return db;
}

export async function saveDb(db) {
  ensureAuthData(db);
  ensureModelRegistry(db);
  if (usePostgresStore()) {
    await ensureDb();
    const sql = await getPostgresClient();
    await sql`
      INSERT INTO app_state (id, data, updated_at)
      VALUES (${appStateId}, ${sql.json(db)}, NOW())
      ON CONFLICT (id) DO UPDATE
      SET data = EXCLUDED.data, updated_at = NOW()
    `;
    return;
  }
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const tmpPath = `${dbPath}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(db, null, 2)}\n`);
  await fs.rename(tmpPath, dbPath);
}

export async function mutateDb(mutator) {
  const run = async () => {
    const db = await loadDb();
    const result = await mutator(db);
    await saveDb(db);
    return result;
  };
  const result = mutationQueue.then(run, run);
  mutationQueue = result.catch(() => {});
  return result;
}

export function getProjectOrThrow(db, projectId) {
  const project = db.projects.find((item) => item.id === projectId);
  if (!project) {
    const error = new Error("Project not found");
    error.status = 404;
    throw error;
  }
  return project;
}

export function getSourceFileOrThrow(db, sourceFileId) {
  const sourceFile = db.sourceFiles.find((item) => item.id === sourceFileId);
  if (!sourceFile) {
    const error = new Error("Source file not found");
    error.status = 404;
    throw error;
  }
  return sourceFile;
}

function usePostgresStore() {
  return Boolean(process.env.DATABASE_URL) && ["postgres", "postgres-json", "postgresql"].includes(process.env.STORE_PROVIDER || "");
}

async function getPostgresClient() {
  if (postgresClient) return postgresClient;
  const { default: postgres } = await import("postgres");
  postgresClient = postgres(process.env.DATABASE_URL, {
    max: Number(process.env.POSTGRES_POOL_SIZE || 5),
    idle_timeout: Number(process.env.POSTGRES_IDLE_TIMEOUT_SECONDS || 20)
  });
  return postgresClient;
}

async function ensurePostgresDb() {
  const sql = await getPostgresClient();
  await sql`
    CREATE TABLE IF NOT EXISTS app_state (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  const rows = await sql`SELECT id FROM app_state WHERE id = ${appStateId} LIMIT 1`;
  if (rows.length) return;
  const initialDb = await loadInitialDb();
  await sql`
    INSERT INTO app_state (id, data, updated_at)
    VALUES (${appStateId}, ${sql.json(initialDb)}, NOW())
    ON CONFLICT (id) DO NOTHING
  `;
}

async function loadInitialDb() {
  try {
    const raw = await fs.readFile(dbPath, "utf8");
    const db = ensureModelRegistry(JSON.parse(raw));
    ensureAuthData(db);
    return db;
  } catch {
    const db = ensureModelRegistry(createSeedDb());
    ensureAuthData(db);
    return db;
  }
}
