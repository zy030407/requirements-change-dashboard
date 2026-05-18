import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { ensureAuthData } from "./auth.js";
import { ensureModelRegistry } from "./modelRegistry.js";

const prisma = new PrismaClient();
const dbPath = path.join(process.cwd(), process.env.DATA_DIR || "data", "db.json");

const raw = JSON.parse(await fs.readFile(dbPath, "utf8"));
const db = ensureModelRegistry(raw);
ensureAuthData(db);

await prisma.$transaction(async (tx) => {
  await clearAll(tx);
  await tx.tenant.createMany({ data: (db.tenants || []).map(pickTenant), skipDuplicates: true });
  await tx.user.createMany({ data: (db.users || []).map(pickUser), skipDuplicates: true });
  await tx.project.createMany({ data: (db.projects || []).map(pickProject), skipDuplicates: true });
  await tx.projectMember.createMany({ data: (db.projectMembers || []).map(pickProjectMember), skipDuplicates: true });
  await tx.sourceFile.createMany({ data: (db.sourceFiles || []).map(pickSourceFile), skipDuplicates: true });
  await tx.ingestJob.createMany({ data: (db.ingestJobs || []).map(pickIngestJob), skipDuplicates: true });
  await tx.transcript.createMany({ data: (db.transcripts || []).map(pickTranscript), skipDuplicates: true });
  await tx.wikiPage.createMany({ data: (db.wikiPages || []).map(pickWikiPage), skipDuplicates: true });
  await tx.wikiPageVersion.createMany({ data: (db.wikiPageVersions || []).map(pickWikiPageVersion), skipDuplicates: true });
  await tx.wikiLink.createMany({ data: (db.wikiLinks || []).map(pickWikiLink), skipDuplicates: true });
  await tx.sourceEvidence.createMany({ data: (db.sourceEvidences || []).map(pickSourceEvidence), skipDuplicates: true });
  await tx.requirement.createMany({ data: (db.requirements || []).map(pickRequirement), skipDuplicates: true });
  await tx.requirementVersion.createMany({ data: (db.requirementVersions || []).map(pickRequirementVersion), skipDuplicates: true });
  await tx.change.createMany({ data: (db.changes || []).map(pickChange), skipDuplicates: true });
  await tx.changeConfirmation.createMany({ data: (db.changeConfirmations || []).map(pickChangeConfirmation), skipDuplicates: true });
  await tx.decision.createMany({ data: (db.decisions || []).map(pickDecision), skipDuplicates: true });
  await tx.risk.createMany({ data: (db.risks || []).map(pickRisk), skipDuplicates: true });
  await tx.openQuestion.createMany({ data: (db.openQuestions || []).map(pickOpenQuestion), skipDuplicates: true });
  await tx.communication.createMany({ data: (db.communications || []).map(pickCommunication), skipDuplicates: true });
  await tx.markdownExport.createMany({ data: (db.markdownExports || []).map(pickMarkdownExport), skipDuplicates: true });
  await tx.auditLog.createMany({ data: (db.auditLogs || []).map(pickAuditLog), skipDuplicates: true });
  await tx.modelAdapter.createMany({ data: (db.modelAdapters || []).map(pickModelAdapter), skipDuplicates: true });
  await tx.modelPipeline.createMany({
    data: Object.entries(db.modelPipeline || {}).map(([capability, adapterId]) => ({
      id: `pipe_${capability}`,
      tenantId: null,
      capability,
      adapterId: adapterId || null
    })),
    skipDuplicates: true
  });
});

await prisma.$disconnect();
console.log("JSON data migrated to PostgreSQL via Prisma.");

async function clearAll(tx) {
  for (const model of [
    "modelUsage",
    "modelPipeline",
    "modelAdapter",
    "auditLog",
    "markdownExport",
    "communication",
    "openQuestion",
    "risk",
    "decision",
    "changeConfirmation",
    "change",
    "requirementVersion",
    "requirement",
    "sourceEvidence",
    "wikiLink",
    "wikiPageVersion",
    "wikiPage",
    "transcript",
    "ingestJob",
    "sourceFile",
    "projectMember",
    "project",
    "session",
    "user",
    "tenant"
  ]) {
    await tx[model].deleteMany();
  }
}

function d(value) {
  return value ? new Date(value) : undefined;
}

function tenantId(item) {
  return item.tenantId || "tenant_default";
}

function pickTenant(item) {
  return { id: item.id, name: item.name, status: item.status || "active", settings: item.settings || {}, createdAt: d(item.createdAt), updatedAt: d(item.updatedAt) };
}

function pickUser(item) {
  return {
    id: item.id,
    tenantId: tenantId(item),
    name: item.name,
    account: item.account,
    passwordHash: item.passwordHash,
    passwordSalt: item.passwordSalt,
    phone: item.phone || "",
    email: item.email || "",
    role: item.role || "",
    systemRole: item.systemRole || "customer",
    status: item.status || "active",
    createdAt: d(item.createdAt),
    updatedAt: d(item.updatedAt)
  };
}

function pickProject(item) {
  return {
    id: item.id,
    tenantId: tenantId(item),
    name: item.name,
    customerName: item.customerName || "",
    stage: item.stage || "",
    ownerId: item.ownerId || null,
    startDate: d(item.startDate),
    expectedEndDate: d(item.expectedEndDate),
    status: item.status || "active",
    settings: item.settings || {},
    createdAt: d(item.createdAt),
    updatedAt: d(item.updatedAt)
  };
}

function pickProjectMember(item) {
  return {
    id: item.id,
    tenantId: tenantId(item),
    projectId: item.projectId,
    userId: item.userId,
    role: item.role || "",
    memberType: item.memberType || "tech",
    isPrimaryManager: Boolean(item.isPrimaryManager),
    canConfirmChanges: Boolean(item.canConfirmChanges),
    permissions: item.permissions || []
  };
}

function pickSourceFile(item) {
  return {
    id: item.id,
    tenantId: tenantId(item),
    projectId: item.projectId,
    title: item.title,
    originalName: item.originalName,
    fileName: item.fileName || item.originalName,
    mimeType: item.mimeType || "",
    category: item.category || "unknown",
    size: Number(item.size || 0),
    path: item.path || "",
    storageProvider: item.storageProvider || "local",
    bucket: item.bucket || null,
    objectKey: item.objectKey || null,
    etag: item.etag || null,
    contentHash: item.contentHash || null,
    storageRegion: item.storageRegion || null,
    previewUrlExpiresAt: d(item.previewUrlExpiresAt),
    speakerCount: item.speakerCount || null,
    enableSpeakerDiarization: Boolean(item.enableSpeakerDiarization),
    asrOptions: item.asrOptions || undefined,
    note: item.note || "",
    parsedText: item.parsedText || "",
    aiSummary: item.aiSummary || "",
    status: item.status || "uploaded",
    uploadedBy: item.uploadedBy || "",
    uploadedAt: d(item.uploadedAt),
    updatedAt: d(item.updatedAt)
  };
}

function pickIngestJob(item) {
  return { id: item.id, tenantId: tenantId(item), projectId: item.projectId, sourceFileId: item.sourceFileId, status: item.status, step: item.step, progress: item.progress || 0, error: item.error || null, resultSummary: item.resultSummary || undefined, attempts: item.attempts || 0, createdAt: d(item.createdAt), updatedAt: d(item.updatedAt) };
}

function pickTranscript(item) {
  return { id: item.id, tenantId: tenantId(item), projectId: item.projectId, sourceFileId: item.sourceFileId, text: item.text || "", createdAt: d(item.createdAt) };
}

function pickWikiPage(item) {
  return { id: item.id, tenantId: tenantId(item), projectId: item.projectId, type: item.type, title: item.title, slug: item.slug, summary: item.summary || "", content: item.content || "", tags: item.tags || [], sourceIds: item.sourceIds || [], createdAt: d(item.createdAt), updatedAt: d(item.updatedAt) };
}

function pickWikiPageVersion(item) {
  return { id: item.id, tenantId: tenantId(item), wikiPageId: item.wikiPageId, projectId: item.projectId, version: item.version || 1, title: item.title, summary: item.summary || "", content: item.content || "", sourceFileId: item.sourceFileId || null, changeReason: item.changeReason || "", createdBy: item.createdBy || "", createdAt: d(item.createdAt) };
}

function pickWikiLink(item) {
  return { id: item.id, tenantId: tenantId(item), projectId: item.projectId, fromPageId: item.fromPageId, toPageId: item.toPageId, label: item.label || null, createdAt: d(item.createdAt) };
}

function pickSourceEvidence(item) {
  return { id: item.id, tenantId: tenantId(item), projectId: item.projectId, sourceFileId: item.sourceFileId, entityType: item.entityType, entityId: item.entityId, quote: item.quote || "", location: item.location || null, createdAt: d(item.createdAt) };
}

function pickRequirement(item) {
  return { id: item.id, tenantId: tenantId(item), projectId: item.projectId, moduleName: item.moduleName || "", title: item.title, description: item.description || "", acceptanceCriteria: item.acceptanceCriteria || "", status: item.status || "待确认", priority: item.priority || "中", proposer: item.proposer || "", owner: item.owner || "", sourceIds: item.sourceIds || [], createdAt: d(item.createdAt), updatedAt: d(item.updatedAt) };
}

function pickRequirementVersion(item) {
  return { id: item.id, tenantId: tenantId(item), requirementId: item.requirementId, projectId: item.projectId, version: item.version || 1, description: item.description || "", acceptanceCriteria: item.acceptanceCriteria || "", sourceChangeId: item.sourceChangeId || null, createdBy: item.createdBy || "", createdAt: d(item.createdAt) };
}

function pickChange(item) {
  return { id: item.id, tenantId: tenantId(item), projectId: item.projectId, requirementId: item.requirementId || null, changeType: item.changeType || "待确认", moduleName: item.moduleName || "", title: item.title, beforeContent: item.beforeContent || "", afterContent: item.afterContent || "", summary: item.summary || "", impactScope: item.impactScope || "", sourceFileId: item.sourceFileId || null, proposer: item.proposer || "", confidence: Number(item.confidence || 0), status: item.status || "待确认", createdAt: d(item.createdAt), updatedAt: d(item.updatedAt) };
}

function pickChangeConfirmation(item) {
  return { id: item.id, tenantId: tenantId(item), changeId: item.changeId, projectId: item.projectId, actorId: item.actorId, actorName: item.actorName, action: item.action, comment: item.comment || "", createdAt: d(item.createdAt) };
}

function pickDecision(item) {
  return { id: item.id, tenantId: tenantId(item), projectId: item.projectId, sourceFileId: item.sourceFileId || null, title: item.title, summary: item.summary || "", status: item.status || "已记录", createdAt: d(item.createdAt) };
}

function pickRisk(item) {
  return { id: item.id, tenantId: tenantId(item), projectId: item.projectId, sourceFileId: item.sourceFileId || null, title: item.title, summary: item.summary || "", severity: item.severity || "中", status: item.status || "open", createdAt: d(item.createdAt) };
}

function pickOpenQuestion(item) {
  return { id: item.id, tenantId: tenantId(item), projectId: item.projectId, sourceFileId: item.sourceFileId || null, title: item.title, summary: item.summary || "", owner: item.owner || "", status: item.status || "待确认", createdAt: d(item.createdAt) };
}

function pickCommunication(item) {
  return { id: item.id, tenantId: tenantId(item), projectId: item.projectId, title: item.title, type: item.type || "沟通记录", participants: item.participants || [], sourceFileId: item.sourceFileId || null, summary: item.summary || "", relatedChangeCount: item.relatedChangeCount || 0, meetingTime: d(item.meetingTime), createdBy: item.createdBy || "", createdAt: d(item.createdAt), updatedAt: d(item.updatedAt) };
}

function pickMarkdownExport(item) {
  return { id: item.id, tenantId: tenantId(item), projectId: item.projectId, path: item.path, pageCount: item.pageCount || 0, createdAt: d(item.createdAt) };
}

function pickAuditLog(item) {
  return { id: item.id, tenantId: item.tenantId || null, projectId: item.projectId || null, actorId: item.actorId || null, actorName: item.actorName || item.actor || null, actor: item.actor || item.actorName || "系统", action: item.action, targetType: item.targetType, targetId: item.targetId, before: item.before || undefined, after: item.after || undefined, detail: item.detail || "", createdAt: d(item.createdAt) };
}

function pickModelAdapter(item) {
  return { id: item.id, tenantId: item.tenantId || null, name: item.name, provider: item.provider, capability: item.capability, protocol: item.protocol, model: item.model || null, baseUrl: item.baseUrl || null, appKey: item.appKey || null, apiKey: item.apiKey || null, envVarName: item.envVarName || null, status: item.status || "active", description: item.description || null, timeoutSeconds: item.timeoutSeconds || null, lastTest: item.lastTest || undefined, createdAt: d(item.createdAt), updatedAt: d(item.updatedAt) };
}
