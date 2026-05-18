import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyFile } from "./parsers.js";
import { exportProjectMarkdown } from "./markdownExport.js";
import { processIngestJob } from "./ingestProcessor.js";
import { buildManagerBrief, buildManagerBriefWikiPage, buildWikiLintReport } from "./wikiCompiler.js";
import { runtimeCapabilities, validateRuntimeEnv } from "./env.js";
import { cancelQueuedJob, configureIngestQueue, enqueueIngestJob, retryQueuedJob } from "./jobQueue.js";
import {
  adapterClientConfig,
  getActiveModelAdapter,
  isOpenAICompatibleAdapter,
  modelRegistryView,
  normalizeModelAdapterInput,
  updateModelPipeline
} from "./modelRegistry.js";
import { getProjectOrThrow, getSourceFileOrThrow, loadDb, makeId, mutateDb, nowIso } from "./store.js";
import {
  SYSTEM_ROLES,
  appendAuditLog,
  canAccessProject,
  createSessionForUser,
  defaultPermissionsForMemberType,
  hashPassword,
  hashToken,
  inferMemberType,
  isCustomerForProject,
  normalizeUserInput,
  roleLabel,
  sanitizeUser,
  verifyPassword
} from "./auth.js";
import {
  createUploadToken,
  ensureStorage,
  getUploadRoot,
  resolveLocalPath,
  signedFileUrl,
  statObject,
  storageProvider,
  storeUploadedFile
} from "./storage.js";
import { applySpeakerLabelsToText, detectSpeakerLabels, normalizeSpeakerLabels } from "./speakerLabels.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 4000);
const uploadRoot = getUploadRoot();
const DOCUMENT_STAGE_OPTIONS = ["需求确认阶段", "开发阶段", "测试阶段", "上线阶段"];
const DOCUMENT_PURPOSE_OPTIONS = ["需求确认文件", "需求变更文件", "合同文件", "会议纪要", "通用资料"];
const REQUIREMENT_SUGGESTION_STATUSES = ["建议", "已采纳", "已放弃"];
const CHANGE_STATUS_OPTIONS = ["待确认", "已确认", "已驳回", "需客户确认", "客户退回"];

validateRuntimeEnv();
await ensureStorage();
configureIngestQueue(processIngestJob, {
  startWorker: process.env.JOB_QUEUE_PROCESS_IN_API !== "false"
});

const upload = multer({
  storage: multer.diskStorage({
    destination: async (req, file, cb) => {
      const dir = path.join(uploadRoot, req.params.id || "unassigned");
      await fs.mkdir(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      cb(null, `${Date.now()}-${safeFileName(file.originalname)}`);
    }
  }),
  limits: { fileSize: 250 * 1024 * 1024 }
});

app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.get("/api/health", (req, res) => {
  res.json({ ok: true, time: nowIso(), capabilities: runtimeCapabilities() });
});

app.post("/api/auth/login", async (req, res, next) => {
  try {
    const result = await mutateDb((db) => {
      const account = String(req.body.account || "").trim();
      const user = db.users.find((item) => item.account === account);
      if (!user || user.status === "disabled" || !verifyPassword(req.body.password, user)) {
        const error = new Error("账号或密码错误");
        error.status = 401;
        throw error;
      }
      const { token } = createSessionForUser(db, user);
      appendAuditLog(db, {
        actor: user,
        action: "AUTH_LOGIN",
        targetType: "User",
        targetId: user.id,
        detail: `${user.name} 登录系统`
      });
      return { token, user: sanitizeUser(user) };
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({ user: sanitizeUser(req.user) });
});

app.post("/api/auth/logout", requireAuth, async (req, res, next) => {
  try {
    await mutateDb((db) => {
      db.sessions = db.sessions.filter((item) => item.id !== req.session.id);
      appendAuditLog(db, {
        actor: req.user,
        action: "AUTH_LOGOUT",
        targetType: "User",
        targetId: req.user.id,
        detail: `${req.user.name} 退出系统`
      });
    });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.use("/api", requireAuth);
app.use("/api/admin", requireRole(SYSTEM_ROLES.ADMIN));

app.get("/api/admin/model-adapters", async (req, res, next) => {
  try {
    const db = await loadDb();
    res.json(modelRegistryView(db));
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/model-adapters", async (req, res, next) => {
  try {
    const adapter = await mutateDb((db) => {
      const item = {
        id: makeId("mdl"),
        ...normalizeModelAdapterInput(req.body)
      };
      db.modelAdapters.push(item);
      db.auditLogs.push({
        id: makeId("aud"),
        projectId: null,
        actor: "当前用户",
        action: "MODEL_ADAPTER_CREATED",
        targetType: "ModelAdapter",
        targetId: item.id,
        detail: `新增模型适配器 ${item.name}`,
        createdAt: nowIso()
      });
      return item;
    });
    res.status(201).json({ adapter });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/admin/model-adapters/:id", async (req, res, next) => {
  try {
    const adapter = await mutateDb((db) => {
      const item = db.modelAdapters.find((modelAdapter) => modelAdapter.id === req.params.id);
      if (!item) {
        const error = new Error("Model adapter not found");
        error.status = 404;
        throw error;
      }
      Object.assign(item, normalizeModelAdapterInput(req.body, item));
      db.auditLogs.push({
        id: makeId("aud"),
        projectId: null,
        actor: "当前用户",
        action: "MODEL_ADAPTER_UPDATED",
        targetType: "ModelAdapter",
        targetId: item.id,
        detail: `更新模型适配器 ${item.name}`,
        createdAt: nowIso()
      });
      return item;
    });
    res.json({ adapter });
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/model-adapters/test", async (req, res, next) => {
  try {
    const adapter = normalizeModelAdapterInput(req.body.adapter || req.body || {});
    const result = await testModelAdapter(adapter, req.body?.prompt);
    res.json({ result });
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/model-adapters/:id/test", async (req, res, next) => {
  try {
    const db = await loadDb();
    const adapter = db.modelAdapters.find((modelAdapter) => modelAdapter.id === req.params.id);
    if (!adapter) {
      const error = new Error("Model adapter not found");
      error.status = 404;
      throw error;
    }
    const testAdapter = req.body?.adapter ? normalizeModelAdapterInput(req.body.adapter, adapter) : adapter;
    const result = await testModelAdapter(testAdapter, req.body?.prompt);
    await mutateDb((nextDb) => {
      const item = nextDb.modelAdapters.find((modelAdapter) => modelAdapter.id === req.params.id);
      if (item) {
        item.lastTest = {
          ok: result.ok,
          message: result.message,
          testedAt: result.testedAt,
          latencyMs: result.latencyMs
        };
        item.updatedAt = nowIso();
      }
      nextDb.auditLogs.push({
        id: makeId("aud"),
        projectId: null,
        actor: "当前用户",
        action: "MODEL_ADAPTER_TESTED",
        targetType: "ModelAdapter",
        targetId: adapter.id,
        detail: `测试模型适配器 ${adapter.name}：${result.ok ? "通过" : "失败"}`,
        createdAt: nowIso()
      });
      return item;
    });
    res.json({ result });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/admin/model-pipeline", async (req, res, next) => {
  try {
    const pipeline = await mutateDb((db) => {
      const nextPipeline = updateModelPipeline(db, req.body.pipeline || req.body);
      db.auditLogs.push({
        id: makeId("aud"),
        projectId: null,
        actor: "当前用户",
        action: "MODEL_PIPELINE_UPDATED",
        targetType: "ModelPipeline",
        targetId: "default",
        detail: "更新默认模型处理管线",
        createdAt: nowIso()
      });
      return nextPipeline;
    });
    res.json({ pipeline });
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/users", async (req, res, next) => {
  try {
    const db = await loadDb();
    res.json({ users: db.users.map((user) => buildAdminUserView(db, user)).sort((a, b) => a.name.localeCompare(b.name, "zh-CN")) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/users", async (req, res, next) => {
  try {
    const result = await mutateDb((db) => {
      const timestamp = nowIso();
      const user = {
        id: makeId("usr"),
        tenantId: req.user.tenantId || "tenant_default",
        ...normalizeUserInput(req.body),
        ...hashPassword(req.body.password || "123456"),
        createdAt: timestamp,
        updatedAt: timestamp
      };
      if (db.users.some((item) => item.account === user.account)) {
        const error = new Error("登录账号已存在");
        error.status = 400;
        throw error;
      }
      db.users.push(user);
      appendAuditLog(db, {
        actor: req.user,
        action: "USER_CREATED",
        targetType: "User",
        targetId: user.id,
        after: sanitizeUser(user),
        detail: `新增用户 ${user.name}`
      });
      return sanitizeUser(user);
    });
    res.status(201).json({ user: result });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/admin/users/:id", async (req, res, next) => {
  try {
    const user = await mutateDb((db) => {
      const item = db.users.find((candidate) => candidate.id === req.params.id);
      if (!item) {
        const error = new Error("User not found");
        error.status = 404;
        throw error;
      }
      const before = sanitizeUser({ ...item });
      const next = normalizeUserInput(req.body, item);
      if (db.users.some((candidate) => candidate.id !== item.id && candidate.account === next.account)) {
        const error = new Error("登录账号已存在");
        error.status = 400;
        throw error;
      }
      Object.assign(item, next, { updatedAt: nowIso() });
      appendAuditLog(db, {
        actor: req.user,
        action: "USER_UPDATED",
        targetType: "User",
        targetId: item.id,
        before,
        after: sanitizeUser(item),
        detail: `更新用户 ${item.name}`
      });
      return sanitizeUser(item);
    });
    res.json({ user });
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/users/:id/reset-password", async (req, res, next) => {
  try {
    const user = await mutateDb((db) => {
      const item = db.users.find((candidate) => candidate.id === req.params.id);
      if (!item) {
        const error = new Error("User not found");
        error.status = 404;
        throw error;
      }
      Object.assign(item, hashPassword(req.body.password || "123456"), { updatedAt: nowIso() });
      appendAuditLog(db, {
        actor: req.user,
        action: "USER_PASSWORD_RESET",
        targetType: "User",
        targetId: item.id,
        detail: `重置用户 ${item.name} 的密码`
      });
      return sanitizeUser(item);
    });
    res.json({ user });
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/projects", async (req, res, next) => {
  try {
    const db = await loadDb();
    res.json({ projects: buildAdminProjects(db) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/projects", async (req, res, next) => {
  try {
    const project = await mutateDb((db) => {
      const timestamp = nowIso();
      const manager = getAdminManagerOrThrow(db, req.body.ownerId);
      const nextProject = {
        id: makeId("proj"),
        tenantId: req.user.tenantId || manager.tenantId || "tenant_default",
        name: req.body.name || "新项目",
        customerName: req.body.customerName || "未填写客户",
        stage: req.body.stage || "需求沟通阶段",
        ownerId: manager.id,
        startDate: req.body.startDate || timestamp.slice(0, 10),
        expectedEndDate: req.body.expectedEndDate || null,
        status: req.body.status || "active",
        createdAt: timestamp,
        updatedAt: timestamp
      };
      db.projects.push(nextProject);
      ensureProjectManagerMember(db, nextProject.id, manager.id, true);
      appendAuditLog(db, {
        projectId: nextProject.id,
        actor: req.user,
        action: "ADMIN_PROJECT_CREATED",
        targetType: "Project",
        targetId: nextProject.id,
        after: nextProject,
        detail: `管理员新建项目 ${nextProject.name}，项目经理 ${manager.name}`
      });
      return buildAdminProjectView(db, nextProject);
    });
    res.status(201).json({ project });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/admin/projects/:id", async (req, res, next) => {
  try {
    const project = await mutateDb((db) => {
      const item = getProjectOrThrow(db, req.params.id);
      const before = { ...item };
      if (req.body.ownerId && req.body.ownerId !== item.ownerId) {
        const manager = getAdminManagerOrThrow(db, req.body.ownerId);
        item.ownerId = manager.id;
        db.projectMembers
          .filter((member) => member.projectId === item.id && member.memberType === "manager")
          .forEach((member) => {
            member.isPrimaryManager = false;
          });
        ensureProjectManagerMember(db, item.id, manager.id, true);
      }
      Object.assign(item, {
        name: req.body.name ?? item.name,
        customerName: req.body.customerName ?? item.customerName,
        stage: req.body.stage ?? item.stage,
        expectedEndDate: req.body.expectedEndDate ?? item.expectedEndDate,
        status: req.body.status ?? item.status,
        updatedAt: nowIso()
      });
      appendAuditLog(db, {
        projectId: item.id,
        actor: req.user,
        action: "ADMIN_PROJECT_UPDATED",
        targetType: "Project",
        targetId: item.id,
        before,
        after: item,
        detail: `管理员更新项目 ${item.name}`
      });
      return buildAdminProjectView(db, item);
    });
    res.json({ project });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/admin/projects/:id", async (req, res, next) => {
  try {
    await mutateDb((db) => {
      const project = getProjectOrThrow(db, req.params.id);
      const before = { ...project };
      const projectId = project.id;
      const sourceIds = new Set((db.sourceFiles || []).filter((item) => item.projectId === projectId).map((item) => item.id));
      const wikiPageIds = new Set((db.wikiPages || []).filter((item) => item.projectId === projectId).map((item) => item.id));
      const requirementIds = new Set((db.requirements || []).filter((item) => item.projectId === projectId).map((item) => item.id));
      const changeIds = new Set((db.changes || []).filter((item) => item.projectId === projectId).map((item) => item.id));

      db.projects = db.projects.filter((item) => item.id !== projectId);
      db.projectMembers = (db.projectMembers || []).filter((item) => item.projectId !== projectId);
      db.sourceFiles = (db.sourceFiles || []).filter((item) => item.projectId !== projectId);
      db.ingestJobs = (db.ingestJobs || []).filter((item) => item.projectId !== projectId && !sourceIds.has(item.sourceFileId));
      db.transcripts = (db.transcripts || []).filter((item) => item.projectId !== projectId && !sourceIds.has(item.sourceFileId));
      db.wikiPages = (db.wikiPages || []).filter((item) => item.projectId !== projectId);
      db.wikiPageVersions = (db.wikiPageVersions || []).filter((item) => item.projectId !== projectId && !wikiPageIds.has(item.wikiPageId));
      db.wikiLinks = (db.wikiLinks || []).filter((item) => !wikiPageIds.has(item.fromPageId) && !wikiPageIds.has(item.toPageId));
      db.sourceEvidence = (db.sourceEvidence || []).filter((item) => item.projectId !== projectId && !sourceIds.has(item.sourceFileId));
      db.requirements = (db.requirements || []).filter((item) => item.projectId !== projectId);
      db.requirementVersions = (db.requirementVersions || []).filter((item) => item.projectId !== projectId && !requirementIds.has(item.requirementId));
      db.changes = (db.changes || []).filter((item) => item.projectId !== projectId);
      db.changeConfirmations = (db.changeConfirmations || []).filter((item) => item.projectId !== projectId && !changeIds.has(item.changeId));
      db.decisions = (db.decisions || []).filter((item) => item.projectId !== projectId);
      db.risks = (db.risks || []).filter((item) => item.projectId !== projectId);
      db.openQuestions = (db.openQuestions || []).filter((item) => item.projectId !== projectId);
      db.communications = (db.communications || []).filter((item) => item.projectId !== projectId);
      db.communicationRecords = (db.communicationRecords || []).filter((item) => item.projectId !== projectId);
      db.tasks = (db.tasks || []).filter((item) => item.projectId !== projectId);
      db.markdownExports = (db.markdownExports || []).filter((item) => item.projectId !== projectId);

      appendAuditLog(db, {
        actor: req.user,
        action: "ADMIN_PROJECT_DELETED",
        targetType: "Project",
        targetId: projectId,
        before,
        detail: `管理员删除项目 ${before.name}`
      });
    });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/projects/:id/users", async (req, res, next) => {
  try {
    const db = await loadDb();
    getProjectOrThrow(db, req.params.id);
    res.json(buildAdminProjectUsers(db, req.params.id));
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/projects/:id/users", async (req, res, next) => {
  try {
    const result = await mutateDb((db) => {
      getProjectOrThrow(db, req.params.id);
      const timestamp = nowIso();
      let user = req.body.userId ? db.users.find((item) => item.id === req.body.userId) : null;
      if (!user) {
        const input = normalizeUserInput(req.body, {
          systemRole: req.body.memberType === "manager" ? SYSTEM_ROLES.PROJECT_MANAGER : req.body.memberType === "customer" ? SYSTEM_ROLES.CUSTOMER : SYSTEM_ROLES.PROJECT_MANAGER
        });
        if (db.users.some((item) => item.account === input.account)) {
          const error = new Error("登录账号已存在");
          error.status = 400;
          throw error;
        }
        user = {
          id: makeId("usr"),
          tenantId: req.user.tenantId || "tenant_default",
          ...input,
          ...hashPassword(req.body.password || "123456"),
          createdAt: timestamp,
          updatedAt: timestamp
        };
        db.users.push(user);
      }
      const project = getProjectOrThrow(db, req.params.id);
      const memberType = req.body.memberType || inferMemberType(req.body.projectRole || user.role);
      let member = db.projectMembers.find((item) => item.projectId === req.params.id && item.userId === user.id);
      const wasExistingMember = Boolean(member);
      const previousMemberType = member?.memberType;
      if (!member) {
        member = {
          id: makeId("mem"),
          tenantId: project.tenantId || req.user.tenantId || "tenant_default",
          projectId: req.params.id,
          userId: user.id,
          isPrimaryManager: false
        };
        db.projectMembers.push(member);
      }
      Object.assign(member, {
        tenantId: member.tenantId || project.tenantId || req.user.tenantId || "tenant_default",
        role: req.body.projectRole || member.role || roleLabel(user.systemRole),
        memberType,
        canConfirmChanges:
          req.body.canConfirmChanges ??
          (previousMemberType && previousMemberType !== memberType ? memberType === "customer" : member.canConfirmChanges) ??
          memberType === "customer",
        permissions:
          req.body.permissions ||
          (previousMemberType && previousMemberType !== memberType ? defaultPermissionsForMemberType(memberType) : member.permissions) ||
          defaultPermissionsForMemberType(memberType)
      });
      if (req.body.isPrimaryManager === true) member.isPrimaryManager = true;
      if (member.isPrimaryManager && member.memberType === "manager") {
        db.projects.find((item) => item.id === req.params.id).ownerId = user.id;
        db.projectMembers
          .filter((item) => item.projectId === req.params.id && item.memberType === "manager")
          .forEach((item) => {
            item.isPrimaryManager = false;
          });
      }
      db.projectMembers.push(member);
      appendAuditLog(db, {
        projectId: req.params.id,
        actor: req.user,
        action: wasExistingMember ? "ADMIN_PROJECT_MEMBER_UPDATED" : "ADMIN_PROJECT_MEMBER_CREATED",
        targetType: "ProjectMember",
        targetId: member.id,
        after: { member, user: sanitizeUser(user) },
        detail: wasExistingMember ? `管理员更新项目成员 ${user.name}` : `管理员为项目新增成员 ${user.name}`
      });
      return { member: buildMemberView(db, member), user: sanitizeUser(user), created: !wasExistingMember };
    });
    res.status(result.created ? 201 : 200).json(result);
  } catch (error) {
    next(error);
  }
});

app.patch("/api/admin/project-members/:id", async (req, res, next) => {
  try {
    const result = await mutateDb((db) => {
      const member = db.projectMembers.find((item) => item.id === req.params.id);
      if (!member) {
        const error = new Error("Project member not found");
        error.status = 404;
        throw error;
      }
      const user = db.users.find((item) => item.id === member.userId);
      const before = { member: { ...member }, user: sanitizeUser({ ...user }) };
      if (user) {
        const next = normalizeUserInput(req.body, user);
        Object.assign(user, next, { updatedAt: nowIso() });
        if (req.body.password) Object.assign(user, hashPassword(req.body.password));
      }
      member.role = req.body.projectRole || req.body.role || member.role;
      member.memberType = req.body.memberType || member.memberType || inferMemberType(member.role);
      member.canConfirmChanges = req.body.canConfirmChanges ?? member.canConfirmChanges;
      member.permissions = req.body.permissions || member.permissions || defaultPermissionsForMemberType(member.memberType);
      if (req.body.isPrimaryManager && member.memberType === "manager") {
        db.projectMembers
          .filter((item) => item.projectId === member.projectId && item.memberType === "manager")
          .forEach((item) => {
            item.isPrimaryManager = false;
          });
        member.isPrimaryManager = true;
        db.projects.find((item) => item.id === member.projectId).ownerId = member.userId;
      } else {
        member.isPrimaryManager = Boolean(req.body.isPrimaryManager ?? member.isPrimaryManager);
      }
      appendAuditLog(db, {
        projectId: member.projectId,
        actor: req.user,
        action: "ADMIN_PROJECT_MEMBER_UPDATED",
        targetType: "ProjectMember",
        targetId: member.id,
        before,
        after: { member, user: sanitizeUser(user) },
        detail: `管理员更新项目成员 ${user?.name || member.id}`
      });
      return { member: buildMemberView(db, member), user: sanitizeUser(user) };
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/admin/project-members/:id", async (req, res, next) => {
  try {
    await mutateDb((db) => {
      const member = db.projectMembers.find((item) => item.id === req.params.id);
      if (!member) return;
      db.projectMembers = db.projectMembers.filter((item) => item.id !== req.params.id);
      appendAuditLog(db, {
        projectId: member.projectId,
        actor: req.user,
        action: "ADMIN_PROJECT_MEMBER_REMOVED",
        targetType: "ProjectMember",
        targetId: member.id,
        before: member,
        detail: "管理员移除项目成员"
      });
    });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/audit-logs", async (req, res, next) => {
  try {
    const db = await loadDb();
    res.json({ logs: db.auditLogs.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 300) });
  } catch (error) {
    next(error);
  }
});

app.use("/api/projects/:id", async (req, res, next) => {
  try {
    const db = await loadDb();
    const project = getProjectOrThrow(db, req.params.id);
    if (!canAccessProject(req.user, project, db)) {
      const error = new Error("无权访问该项目");
      error.status = 403;
      throw error;
    }
    if (req.user.systemRole === SYSTEM_ROLES.CUSTOMER) {
      const error = new Error("客户账号请使用客户门户访问项目数据");
      error.status = 403;
      throw error;
    }
    next();
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects", async (req, res, next) => {
  try {
    if (req.user.systemRole === SYSTEM_ROLES.CUSTOMER) {
      const error = new Error("客户账号请使用客户门户访问项目数据");
      error.status = 403;
      throw error;
    }
    const db = await loadDb();
    const usersById = Object.fromEntries(db.users.map((user) => [user.id, user]));
    const accessibleProjects = db.projects.filter((project) => canAccessProject(req.user, project, db));
    res.json({
      projects: accessibleProjects.map((project) => ({
        ...project,
        owner: usersById[project.ownerId] ? sanitizeUser(usersById[project.ownerId]) : null
      }))
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects", async (req, res, next) => {
  try {
    if (req.user.systemRole !== SYSTEM_ROLES.ADMIN) {
      const error = new Error("只有管理员可以新建项目");
      error.status = 403;
      throw error;
    }
    const project = await mutateDb((db) => {
      const timestamp = nowIso();
      const owner = db.users[0] || { id: "usr_default", name: "项目负责人", role: "项目经理" };
      if (!db.users.find((user) => user.id === owner.id)) db.users.push(owner);
      const nextProject = {
        id: makeId("proj"),
        tenantId: req.user.tenantId || "tenant_default",
        name: req.body.name || "新项目",
        customerName: req.body.customerName || "未填写客户",
        stage: req.body.stage || "需求沟通阶段",
        ownerId: owner.id,
        startDate: req.body.startDate || timestamp.slice(0, 10),
        expectedEndDate: req.body.expectedEndDate || null,
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp
      };
      db.projects.push(nextProject);
      return nextProject;
    });
    res.status(201).json({ project });
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:id/dashboard", async (req, res, next) => {
  try {
    const db = await loadDb();
    const project = getProjectOrThrow(db, req.params.id);
    res.json(buildDashboard(db, project));
  } catch (error) {
    next(error);
  }
});

app.patch("/api/projects/:id", async (req, res, next) => {
  try {
    const project = await mutateDb((db) => {
      assertCanManageProjectId(db, req.user, req.params.id);
      const item = getProjectOrThrow(db, req.params.id);
      const timestamp = nowIso();
      Object.assign(item, {
        name: req.body.name ?? item.name,
        customerName: req.body.customerName ?? item.customerName,
        stage: req.body.stage ?? item.stage,
        expectedEndDate: req.body.expectedEndDate ?? item.expectedEndDate,
        status: req.body.status ?? item.status,
        settings: {
          ...(item.settings || defaultProjectSettings()),
          ...(req.body.settings || {})
        },
        updatedAt: timestamp
      });
      db.auditLogs.push({
        id: makeId("aud"),
        projectId: item.id,
        actor: "当前用户",
        action: "PROJECT_SETTINGS_UPDATED",
        targetType: "Project",
        targetId: item.id,
        detail: "更新项目设置",
        createdAt: timestamp
      });
      return item;
    });
    res.json({ project });
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:id/requirements", async (req, res, next) => {
  try {
    const db = await loadDb();
    getProjectOrThrow(db, req.params.id);
    const q = String(req.query.q || "").trim();
    const requirements = db.requirements
      .filter((item) => item.projectId === req.params.id)
      .filter((item) => !q || [item.title, item.moduleName, item.description, item.status].some((value) => value?.includes(q)));
    res.json({ requirements });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:id/requirements", async (req, res, next) => {
  try {
    const requirement = await mutateDb((db) => {
      assertCanManageProjectId(db, req.user, req.params.id);
      ensureRequirementSuggestions(db);
      const timestamp = nowIso();
      const nextRequirement = {
        id: makeId("req"),
        projectId: req.params.id,
        moduleName: req.body.moduleName || "项目范围",
        title: req.body.title || "未命名需求",
        description: req.body.description || "",
        acceptanceCriteria: req.body.acceptanceCriteria || "",
        status: req.body.status || "待确认",
        priority: req.body.priority || "中",
        proposer: req.body.proposer || "未填写",
        owner: req.body.owner || "未分配",
        sourceIds: req.body.sourceIds || [],
        createdAt: timestamp,
        updatedAt: timestamp
      };
      db.requirements.push(nextRequirement);
      const sourceSuggestionId = String(req.body.sourceSuggestionId || "");
      if (sourceSuggestionId) {
        const suggestion = db.requirementSuggestions.find((item) => item.id === sourceSuggestionId && item.projectId === req.params.id);
        if (suggestion) {
          suggestion.status = "已采纳";
          suggestion.adoptedRequirementId = nextRequirement.id;
          suggestion.updatedAt = timestamp;
        }
      }
      db.requirementVersions.push({
        id: makeId("rver"),
        requirementId: nextRequirement.id,
        projectId: req.params.id,
        version: 1,
        description: nextRequirement.description,
        acceptanceCriteria: nextRequirement.acceptanceCriteria,
        sourceChangeId: null,
        createdBy: "用户",
        createdAt: timestamp
      });
      return nextRequirement;
    });
    res.status(201).json({ requirement });
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:id/requirement-suggestions", async (req, res, next) => {
  try {
    const db = await loadDb();
    const project = getProjectOrThrow(db, req.params.id);
    assertCanAccessEntityProject(db, req.user, project.id);
    ensureRequirementSuggestions(db);
    const stored = db.requirementSuggestions
      .filter((item) => item.projectId === project.id)
      .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));
    if (stored.length) {
      res.json({ suggestions: stored, generatedBy: stored[0]?.generatedBy || "llm-wiki", stale: false });
      return;
    }
    res.json({
      suggestions: buildHeuristicRequirementSuggestions(db, project),
      generatedBy: "wiki-rules",
      stale: true
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:id/requirement-suggestions/generate", async (req, res, next) => {
  try {
    const result = await mutateDb(async (db) => {
      assertCanManageProjectId(db, req.user, req.params.id);
      const project = getProjectOrThrow(db, req.params.id);
      ensureRequirementSuggestions(db);
      let generatedBy = "llm-wiki";
      let warning = "";
      let suggestions = [];
      try {
        suggestions = await generateRequirementSuggestionsWithModel(db, project);
      } catch (error) {
        generatedBy = "wiki-rules";
        warning = `大模型预测失败，已使用 Wiki 编译结果生成本地草案：${error.message}`;
        suggestions = buildHeuristicRequirementSuggestions(db, project);
      }
      const timestamp = nowIso();
      const savedSuggestions = normalizeRequirementSuggestions(db, project, suggestions, {
        generatedBy,
        timestamp,
        persist: true
      }).slice(0, 10);
      db.requirementSuggestions = db.requirementSuggestions.filter((item) => item.projectId !== project.id);
      db.requirementSuggestions.push(...savedSuggestions);
      appendAuditLog(db, {
        actor: req.user,
        projectId: project.id,
        action: "REQUIREMENT_SUGGESTIONS_GENERATED",
        targetType: "Project",
        targetId: project.id,
        detail: `生成 ${savedSuggestions.length} 条需求建议，来源：${generatedBy}`
      });
      return { suggestions: savedSuggestions, generatedBy, warning };
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.patch("/api/requirement-suggestions/:id/status", async (req, res, next) => {
  try {
    const suggestion = await mutateDb((db) => {
      ensureRequirementSuggestions(db);
      const item = db.requirementSuggestions.find((candidate) => candidate.id === req.params.id);
      if (!item) {
        const error = new Error("Requirement suggestion not found");
        error.status = 404;
        throw error;
      }
      assertCanManageEntityProject(db, req.user, item.projectId);
      const status = REQUIREMENT_SUGGESTION_STATUSES.includes(req.body.status) ? req.body.status : "";
      if (!status) {
        const error = new Error("Unsupported requirement suggestion status");
        error.status = 400;
        throw error;
      }
      item.status = status;
      item.updatedAt = nowIso();
      appendAuditLog(db, {
        actor: req.user,
        projectId: item.projectId,
        action: "REQUIREMENT_SUGGESTION_STATUS_UPDATED",
        targetType: "RequirementSuggestion",
        targetId: item.id,
        detail: `需求建议状态更新为 ${status}`
      });
      return item;
    });
    res.json({ suggestion });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/requirement-suggestions/:id", async (req, res, next) => {
  try {
    await mutateDb((db) => {
      ensureRequirementSuggestions(db);
      const item = db.requirementSuggestions.find((candidate) => candidate.id === req.params.id);
      if (!item) {
        const error = new Error("Requirement suggestion not found");
        error.status = 404;
        throw error;
      }
      assertCanManageEntityProject(db, req.user, item.projectId);
      db.requirementSuggestions = db.requirementSuggestions.filter((candidate) => candidate.id !== item.id);
      appendAuditLog(db, {
        actor: req.user,
        projectId: item.projectId,
        action: "REQUIREMENT_SUGGESTION_DELETED",
        targetType: "RequirementSuggestion",
        targetId: item.id,
        detail: `删除需求建议 ${item.title}`
      });
    });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:id/tasks", async (req, res, next) => {
  try {
    const db = await loadDb();
    getProjectOrThrow(db, req.params.id);
    res.json({ tasks: buildProjectTasks(db, req.params.id) });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/tasks/:entityType/:entityId/status", async (req, res, next) => {
  try {
    const result = await mutateDb((db) => {
      const { entityType, entityId } = req.params;
      const status = req.body.status || "已完成";
      const timestamp = nowIso();
      let item = null;

      if (entityType === "change") item = db.changes.find((change) => change.id === entityId);
      if (entityType === "question") item = db.openQuestions.find((question) => question.id === entityId);
      if (entityType === "risk") item = db.risks.find((risk) => risk.id === entityId);

      if (!item) {
        const error = new Error("Task source not found");
        error.status = 404;
        throw error;
      }
      assertCanManageEntityProject(db, req.user, item.projectId);

      let requirement = null;
      if (entityType === "change") {
        requirement = updateChangeStatus(db, item, status);
      } else {
        item.status = status;
        item.updatedAt = timestamp;
      }
      db.auditLogs.push({
        id: makeId("aud"),
        projectId: item.projectId,
        actor: "当前用户",
        action: "TASK_STATUS_UPDATED",
        targetType: entityType,
        targetId: entityId,
        detail: `任务状态更新为 ${status}`,
        createdAt: timestamp
      });
      return { task: buildTaskFromEntity(entityType, item), requirement };
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:id/members", async (req, res, next) => {
  try {
    const db = await loadDb();
    getProjectOrThrow(db, req.params.id);
    res.json({ members: buildProjectMembers(db, req.params.id) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:id/members", async (req, res, next) => {
  try {
    const member = await mutateDb((db) => {
      assertCanManageProjectId(db, req.user, req.params.id);
      if (req.user.systemRole !== SYSTEM_ROLES.ADMIN && req.body.projectRole?.includes("经理")) {
        const error = new Error("项目经理只能添加技术组员或客户成员");
        error.status = 403;
        throw error;
      }
      const timestamp = nowIso();
      const name = String(req.body.name || "").trim();
      if (!name) {
        const error = new Error("Member name is required");
        error.status = 400;
        throw error;
      }
      const user = {
        id: makeId("usr"),
        tenantId: req.user.tenantId || "tenant_default",
        name,
        role: req.body.userRole || req.body.projectRole || "项目成员",
        account: req.body.account || `${Date.now()}`,
        phone: req.body.phone || "",
        email: req.body.email || "",
        systemRole: req.body.projectRole?.includes("客户") ? SYSTEM_ROLES.CUSTOMER : SYSTEM_ROLES.PROJECT_MANAGER,
        status: "active",
        ...hashPassword(req.body.password || "123456"),
        createdAt: timestamp,
        updatedAt: timestamp
      };
      if (db.users.some((item) => item.account === user.account)) user.account = `${user.account}_${String(Date.now()).slice(-4)}`;
      const memberType = inferMemberType(req.body.projectRole || "技术组员");
      const projectMember = {
        id: makeId("mem"),
        tenantId: getProjectOrThrow(db, req.params.id).tenantId || req.user.tenantId || "tenant_default",
        projectId: req.params.id,
        userId: user.id,
        role: req.body.projectRole || "技术组员",
        memberType,
        isPrimaryManager: false,
        canConfirmChanges: memberType === "customer",
        permissions: req.body.permissions || defaultPermissionsForMemberType(memberType)
      };
      db.users.push(user);
      db.projectMembers.push(projectMember);
      db.auditLogs.push({
        id: makeId("aud"),
        projectId: req.params.id,
        actorId: req.user.id,
        actorName: req.user.name,
        actor: req.user.name,
        action: "PROJECT_MEMBER_CREATED",
        targetType: "ProjectMember",
        targetId: projectMember.id,
        detail: `新增项目成员 ${name}`,
        createdAt: timestamp
      });
      return buildMemberView(db, projectMember);
    });
    res.status(201).json({ member });
  } catch (error) {
    next(error);
  }
});

app.get("/api/requirements/:id", async (req, res, next) => {
  try {
    const db = await loadDb();
    const requirement = db.requirements.find((item) => item.id === req.params.id);
    if (!requirement) return res.status(404).json({ error: "Requirement not found" });
    assertCanAccessEntityProject(db, req.user, requirement.projectId);
    res.json({
      requirement,
      versions: db.requirementVersions.filter((item) => item.requirementId === requirement.id),
      changes: db.changes.filter((item) => item.requirementId === requirement.id)
    });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/requirements/:id", async (req, res, next) => {
  try {
    const requirement = await mutateDb((db) => {
      const item = db.requirements.find((requirement) => requirement.id === req.params.id);
      if (!item) {
        const error = new Error("Requirement not found");
        error.status = 404;
        throw error;
      }
      assertCanManageEntityProject(db, req.user, item.projectId);
      const timestamp = nowIso();
      Object.assign(item, {
        moduleName: req.body.moduleName ?? item.moduleName,
        title: req.body.title ?? item.title,
        description: req.body.description ?? item.description,
        acceptanceCriteria: req.body.acceptanceCriteria ?? item.acceptanceCriteria,
        status: req.body.status ?? item.status,
        priority: req.body.priority ?? item.priority,
        owner: req.body.owner ?? item.owner,
        updatedAt: timestamp
      });
      const version = db.requirementVersions.filter((version) => version.requirementId === item.id).length + 1;
      db.requirementVersions.push({
        id: makeId("rver"),
        requirementId: item.id,
        projectId: item.projectId,
        version,
        description: item.description,
        acceptanceCriteria: item.acceptanceCriteria,
        sourceChangeId: null,
        createdBy: "用户",
        createdAt: timestamp
      });
      return item;
    });
    res.json({ requirement });
  } catch (error) {
    next(error);
  }
});

app.get("/api/requirements/:id/versions", async (req, res, next) => {
  try {
    const db = await loadDb();
    const requirement = db.requirements.find((item) => item.id === req.params.id);
    if (!requirement) return res.status(404).json({ error: "Requirement not found" });
    assertCanAccessEntityProject(db, req.user, requirement.projectId);
    res.json({ versions: db.requirementVersions.filter((item) => item.requirementId === req.params.id) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/requirements/:id/restore-version", async (req, res, next) => {
  try {
    const requirement = await mutateDb((db) => {
      const item = db.requirements.find((requirement) => requirement.id === req.params.id);
      const version = db.requirementVersions.find((version) => version.id === req.body.versionId);
      if (!item || !version) {
        const error = new Error("Requirement or version not found");
        error.status = 404;
        throw error;
      }
      assertCanManageEntityProject(db, req.user, item.projectId);
      item.description = version.description;
      item.acceptanceCriteria = version.acceptanceCriteria;
      item.updatedAt = nowIso();
      return item;
    });
    res.json({ requirement });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:id/source-files", upload.any(), async (req, res, next) => {
  try {
    const sourceFiles = await mutateDb((db) => {
      assertCanManageProjectId(db, req.user, req.params.id);
      const uploadedFiles = Array.isArray(req.files) ? req.files : [];
      if (!uploadedFiles.length) {
        const error = new Error("File is required");
        error.status = 400;
        throw error;
      }
      const timestamp = nowIso();
      const documentStage = normalizeDocumentStage(req.body.documentStage);
      const documentPurpose = normalizeDocumentPurpose(req.body.documentPurpose);
      return Promise.all(uploadedFiles.map(async (file) => {
        const originalName = decodeUploadFileName(file.originalname);
        const category = classifyFile(originalName, file.mimetype);
        const speakerCount = category === "audio" ? normalizeSpeakerCount(req.body.speakerCount) : null;
        const enableSpeakerDiarization =
          category === "audio" && (req.body.enableSpeakerDiarization === "true" || Boolean(speakerCount));
        const storage = await storeUploadedFile(file, { projectId: req.params.id, originalName });
        return {
          id: makeId("src"),
          tenantId: db.projects.find((project) => project.id === req.params.id)?.tenantId || req.user.tenantId || "tenant_default",
          projectId: req.params.id,
          title: uploadedFiles.length === 1 && req.body.title ? req.body.title : originalName,
          originalName,
          fileName: file.filename,
          mimeType: file.mimetype,
          category,
          documentStage,
          documentPurpose,
          size: file.size,
          path: storage.path,
          storageProvider: storage.storageProvider,
          bucket: storage.bucket,
          objectKey: storage.objectKey,
          etag: storage.etag,
          contentHash: storage.contentHash,
          storageRegion: storage.storageRegion,
          previewUrlExpiresAt: null,
          speakerCount,
          speakerLabels: {},
          enableSpeakerDiarization,
          asrOptions:
            category === "audio"
              ? {
                  engine: "doubao",
                  enableSpeakerInfo: enableSpeakerDiarization,
                  speakerCount,
                  ssdVersion: "200",
                  showUtterances: true
                }
              : null,
          parsedText: "",
          aiSummary: "",
          status: category === "audio" ? "transcription_pending" : "uploaded",
          uploadedBy: req.user.name || "当前用户",
          uploadedAt: timestamp,
          updatedAt: timestamp
        };
      })).then((items) => {
      db.sourceFiles.push(...items);
      appendAuditLog(db, {
        projectId: req.params.id,
        actor: req.user,
        action: "SOURCE_FILES_UPLOADED",
        targetType: "SourceFile",
        targetId: items.map((item) => item.id).join(","),
        detail: `上传 ${items.length} 个资料文件到 ${storageProvider()} 存储`
      });
      return items;
      });
    });
    res.status(201).json({ sourceFiles, sourceFile: sourceFiles[0] });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:id/source-files/upload-token", async (req, res, next) => {
  try {
    const db = await loadDb();
    assertCanManageProjectId(db, req.user, req.params.id);
    const originalName = decodeUploadFileName(req.body.originalName || req.body.fileName || "source-file");
    const token = await createUploadToken({
      projectId: req.params.id,
      originalName,
      mimeType: req.body.mimeType || "application/octet-stream"
    });
    res.json({ token });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:id/source-files/complete-upload", async (req, res, next) => {
  try {
    const sourceFile = await mutateDb(async (db) => {
      assertCanManageProjectId(db, req.user, req.params.id);
      if (storageProvider() !== "oss") {
        const error = new Error("当前不是 OSS 存储模式，请使用后端上传接口。");
        error.status = 400;
        throw error;
      }
      const originalName = decodeUploadFileName(req.body.originalName || req.body.fileName || "source-file");
      const objectKey = String(req.body.objectKey || "");
      if (!objectKey.startsWith(`projects/${req.params.id}/sources/`)) {
        const error = new Error("objectKey 不属于当前项目。");
        error.status = 400;
        throw error;
      }
      const stat = await statObject(objectKey);
      const category = classifyFile(originalName, req.body.mimeType || stat?.mimeType || "");
      const speakerCount = category === "audio" ? normalizeSpeakerCount(req.body.speakerCount) : null;
      const timestamp = nowIso();
      const item = {
        id: makeId("src"),
        tenantId: db.projects.find((project) => project.id === req.params.id)?.tenantId || req.user.tenantId || "tenant_default",
        projectId: req.params.id,
        title: req.body.title || originalName,
        originalName,
        fileName: path.basename(objectKey),
        mimeType: req.body.mimeType || stat?.mimeType || "application/octet-stream",
        category,
        documentStage: normalizeDocumentStage(req.body.documentStage),
        documentPurpose: normalizeDocumentPurpose(req.body.documentPurpose),
        size: Number(req.body.size || stat?.size || 0),
        path: `oss://${process.env.ALI_OSS_BUCKET}/${objectKey}`,
        storageProvider: "oss",
        bucket: process.env.ALI_OSS_BUCKET,
        objectKey,
        etag: req.body.etag || stat?.etag || "",
        contentHash: req.body.contentHash || "",
        storageRegion: process.env.ALI_OSS_REGION,
        previewUrlExpiresAt: null,
        speakerCount,
        speakerLabels: {},
        enableSpeakerDiarization: category === "audio" && Boolean(speakerCount),
        asrOptions:
          category === "audio"
            ? {
                engine: "doubao",
                enableSpeakerInfo: Boolean(speakerCount),
                speakerCount,
                ssdVersion: "200",
                showUtterances: true
              }
            : null,
        parsedText: "",
        aiSummary: "",
        status: category === "audio" ? "transcription_pending" : "uploaded",
        uploadedBy: req.user.name || "当前用户",
        uploadedAt: timestamp,
        updatedAt: timestamp
      };
      db.sourceFiles.push(item);
      appendAuditLog(db, {
        projectId: req.params.id,
        actor: req.user,
        action: "SOURCE_FILE_DIRECT_UPLOAD_COMPLETED",
        targetType: "SourceFile",
        targetId: item.id,
        detail: `登记 OSS 直传资料 ${item.title}`
      });
      return item;
    });
    res.status(201).json({ sourceFile, sourceFiles: [sourceFile] });
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:id/source-files", async (req, res, next) => {
  try {
    const db = await loadDb();
    getProjectOrThrow(db, req.params.id);
    const sourceFiles = sortSourceFilesByDocumentDateDesc(
      db.sourceFiles.filter((item) => item.projectId === req.params.id)
    );
    res.json({ sourceFiles });
  } catch (error) {
    next(error);
  }
});

app.get("/api/source-files/:id", async (req, res, next) => {
  try {
    const db = await loadDb();
    const sourceFile = getSourceFileOrThrow(db, req.params.id);
    assertCanAccessEntityProject(db, req.user, sourceFile.projectId);
    res.json({ sourceFile });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/source-files/:id", async (req, res, next) => {
  try {
    const sourceFile = await mutateDb((db) => {
      const item = getSourceFileOrThrow(db, req.params.id);
      assertCanManageEntityProject(db, req.user, item.projectId);
      if (Object.prototype.hasOwnProperty.call(req.body, "note")) {
        item.note = String(req.body.note || "").slice(0, 5000);
      }
      if (Object.prototype.hasOwnProperty.call(req.body, "speakerLabels")) {
        item.speakerLabels = normalizeSpeakerLabels(req.body.speakerLabels);
      }
      if (Object.prototype.hasOwnProperty.call(req.body, "title")) {
        const title = String(req.body.title || "").trim();
        if (title) item.title = title.slice(0, 200);
      }
      if (Object.prototype.hasOwnProperty.call(req.body, "documentStage")) {
        item.documentStage = normalizeDocumentStage(req.body.documentStage);
      }
      if (Object.prototype.hasOwnProperty.call(req.body, "documentPurpose")) {
        item.documentPurpose = normalizeDocumentPurpose(req.body.documentPurpose);
      }
      item.updatedAt = nowIso();
      return item;
    });
    res.json({ sourceFile });
  } catch (error) {
    next(error);
  }
});

app.get("/api/source-files/:id/preview", async (req, res, next) => {
  try {
    const db = await loadDb();
    const sourceFile = getSourceFileOrThrow(db, req.params.id);
    assertCanAccessEntityProject(db, req.user, sourceFile.projectId);
    const transcripts = db.transcripts
      .filter((item) => item.sourceFileId === sourceFile.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const jobs = db.ingestJobs
      .filter((item) => item.sourceFileId === sourceFile.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const transcriptText = transcripts[0]?.text || "";
    const speakerLabels = normalizeSpeakerLabels(sourceFile.speakerLabels || {});
    res.json({
      sourceFile,
      transcript: transcripts[0] || null,
      transcripts,
      jobs,
      speakerLabels,
      detectedSpeakers: detectSpeakerLabels(sourceFile, sourceFile.parsedText || "", transcriptText),
      transcriptDisplayText: applySpeakerLabelsToText(transcriptText, speakerLabels),
      parsedDisplayText: applySpeakerLabelsToText(sourceFile.parsedText || "", speakerLabels),
      rawUrl: `/api/source-files/${sourceFile.id}/raw`,
      previewUrl: `/api/source-files/${sourceFile.id}/preview-url`,
      downloadUrl: `/api/source-files/${sourceFile.id}/download-url`
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/source-files/:id/preview-url", async (req, res, next) => {
  try {
    const db = await loadDb();
    const sourceFile = getSourceFileOrThrow(db, req.params.id);
    assertCanAccessEntityProject(db, req.user, sourceFile.projectId);
    const result = await signedFileUrl(sourceFile, { download: false });
    await mutateDb((nextDb) => {
      const item = getSourceFileOrThrow(nextDb, req.params.id);
      item.previewUrlExpiresAt = result.expiresAt;
      appendAuditLog(nextDb, {
        projectId: item.projectId,
        actor: req.user,
        action: "SOURCE_FILE_PREVIEW_URL_CREATED",
        targetType: "SourceFile",
        targetId: item.id,
        detail: `生成资料预览链接 ${item.title}`
      });
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/source-files/:id/download-url", async (req, res, next) => {
  try {
    const db = await loadDb();
    const sourceFile = getSourceFileOrThrow(db, req.params.id);
    assertCanAccessEntityProject(db, req.user, sourceFile.projectId);
    const result = await signedFileUrl(sourceFile, { download: true });
    await mutateDb((nextDb) => {
      const item = getSourceFileOrThrow(nextDb, req.params.id);
      appendAuditLog(nextDb, {
        projectId: item.projectId,
        actor: req.user,
        action: "SOURCE_FILE_DOWNLOAD_URL_CREATED",
        targetType: "SourceFile",
        targetId: item.id,
        detail: `生成资料下载链接 ${item.title}`
      });
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/source-files/:id/raw", async (req, res, next) => {
  try {
    const db = await loadDb();
    const sourceFile = getSourceFileOrThrow(db, req.params.id);
    assertCanAccessEntityProject(db, req.user, sourceFile.projectId);
    if (sourceFile.storageProvider === "oss" || sourceFile.objectKey?.startsWith("projects/")) {
      const result = await signedFileUrl(sourceFile, { download: false });
      res.redirect(result.url);
      return;
    }
    const filePath = resolveLocalPath(sourceFile);
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(sourceFile.originalName)}"`);
    res.sendFile(filePath);
  } catch (error) {
    next(error);
  }
});

app.post("/api/source-files/:id/ingest", async (req, res, next) => {
  try {
    const result = await mutateDb((db) => {
      const sourceFile = getSourceFileOrThrow(db, req.params.id);
      assertCanManageEntityProject(db, req.user, sourceFile.projectId);
      if (sourceFile.status === "compiled" && req.body?.force !== true) {
        const error = new Error("该资料已经编译完成，不会重复编译。");
        error.status = 409;
        throw error;
      }
      const project = getProjectOrThrow(db, sourceFile.projectId);
      const job = createIngestJob(db, project, sourceFile, { reason: req.body?.force ? "force" : "manual" });
      return { job, sourceFile };
    });
    await enqueueIngestJob(result.job.id);
    res.status(202).json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/source-files/:id/compile", async (req, res, next) => {
  try {
    const result = await mutateDb((db) => {
      const sourceFile = getSourceFileOrThrow(db, req.params.id);
      assertCanManageEntityProject(db, req.user, sourceFile.projectId);
      const project = getProjectOrThrow(db, sourceFile.projectId);
      if (sourceFile.status === "compiled" && req.body?.force !== true) {
        const error = new Error("该资料已经编译完成，不会重复编译。");
        error.status = 409;
        throw error;
      }
      const job = createIngestJob(db, project, sourceFile, { reason: req.body?.force ? "force-compile" : "compile" });
      appendAuditLog(db, {
        projectId: project.id,
        actor: req.user,
        action: "SOURCE_FILE_COMPILE_REQUESTED",
        targetType: "SourceFile",
        targetId: sourceFile.id,
        detail: `请求编译资料 ${sourceFile.title || sourceFile.originalName}`
      });
      return { job, sourceFile };
    });
    await enqueueIngestJob(result.job.id);
    res.status(202).json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:id/wiki/compile-new", async (req, res, next) => {
  try {
    const result = await mutateDb((db) => {
      const project = getProjectOrThrow(db, req.params.id);
      assertCanManageEntityProject(db, req.user, project.id);
      const candidates = db.sourceFiles
        .filter((item) => item.projectId === project.id)
        .filter((item) => item.status !== "compiled" && item.status !== "processing")
        .sort(compareSourceFileByDocumentDateAsc);
      const jobs = candidates.map((sourceFile) => createIngestJob(db, project, sourceFile, { reason: "compile-new" }));
      appendAuditLog(db, {
        projectId: project.id,
        actor: req.user,
        action: "WIKI_COMPILE_NEW_REQUESTED",
        targetType: "Project",
        targetId: project.id,
        detail: `请求一键编译新增资料 ${jobs.length} 个，按资料日期从旧到新入队。`
      });
      return { jobs, sourceFiles: candidates };
    });
    for (const job of result.jobs) await enqueueIngestJob(job.id);
    res.status(202).json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:id/wiki/recompile", async (req, res, next) => {
  try {
    const result = await mutateDb((db) => {
      const project = getProjectOrThrow(db, req.params.id);
      assertCanManageEntityProject(db, req.user, project.id);
      const requestedIds = Array.isArray(req.body?.sourceFileIds) ? req.body.sourceFileIds : [];
      const allProjectSources = db.sourceFiles.filter((item) => item.projectId === project.id);
      const sourceFiles = requestedIds.length
        ? allProjectSources.filter((item) => requestedIds.includes(item.id))
        : allProjectSources;
      const sourceIds = new Set(sourceFiles.map((item) => item.id));
      clearCompilerOutputsForSources(db, project.id, sourceIds);
      const jobs = sourceFiles
        .sort(compareSourceFileByDocumentDateAsc)
        .map((sourceFile) => createIngestJob(db, project, sourceFile, { reason: "recompile" }));
      appendAuditLog(db, {
        projectId: project.id,
        actor: req.user,
        action: "WIKI_RECOMPILE_REQUESTED",
        targetType: "Project",
        targetId: project.id,
        detail: `请求重新编译 ${jobs.length} 个资料；已清理对应未确认 AI 产物，保留已确认需求和确认记录。`
      });
      return { jobs, sourceFiles };
    });
    for (const job of result.jobs) await enqueueIngestJob(job.id);
    res.status(202).json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/ingest-jobs/:id", async (req, res, next) => {
  try {
    const db = await loadDb();
    const job = db.ingestJobs.find((item) => item.id === req.params.id);
    if (!job) return res.status(404).json({ error: "Ingest job not found" });
    assertCanAccessEntityProject(db, req.user, job.projectId);
    res.json({ job });
  } catch (error) {
    next(error);
  }
});

app.post("/api/ingest-jobs/:id/retry", async (req, res, next) => {
  try {
    const result = await mutateDb((db) => {
      const job = db.ingestJobs.find((item) => item.id === req.params.id);
      if (!job) {
        const error = new Error("Ingest job not found");
        error.status = 404;
        throw error;
      }
      assertCanManageEntityProject(db, req.user, job.projectId);
      const sourceFile = getSourceFileOrThrow(db, job.sourceFileId);
      job.status = "processing";
      job.step = "queued";
      job.error = null;
      job.updatedAt = nowIso();
      sourceFile.status = "processing";
      sourceFile.updatedAt = nowIso();
      appendAuditLog(db, {
        projectId: job.projectId,
        actor: req.user,
        action: "INGEST_JOB_RETRIED",
        targetType: "IngestJob",
        targetId: job.id,
        detail: `重试资料处理任务 ${job.id}`
      });
      return { job, sourceFile };
    });
    await retryQueuedJob(result.job.id);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/ingest-jobs/:id/cancel", async (req, res, next) => {
  try {
    const queueResult = await cancelQueuedJob(req.params.id);
    const result = await mutateDb((db) => {
      const job = db.ingestJobs.find((item) => item.id === req.params.id);
      if (!job) {
        const error = new Error("Ingest job not found");
        error.status = 404;
        throw error;
      }
      assertCanManageEntityProject(db, req.user, job.projectId);
      const sourceFile = getSourceFileOrThrow(db, job.sourceFileId);
      if (!["completed", "failed"].includes(job.status)) {
        job.status = "cancelled";
        job.step = "cancelled";
        job.updatedAt = nowIso();
        sourceFile.status = sourceFile.parsedText ? "parsed" : "uploaded";
        sourceFile.updatedAt = nowIso();
      }
      appendAuditLog(db, {
        projectId: job.projectId,
        actor: req.user,
        action: "INGEST_JOB_CANCELLED",
        targetType: "IngestJob",
        targetId: job.id,
        detail: `取消资料处理任务 ${job.id}`
      });
      return { job, sourceFile, queue: queueResult };
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:id/wiki", async (req, res, next) => {
  try {
    const db = await loadDb();
    const project = getProjectOrThrow(db, req.params.id);
    assertCanAccessEntityProject(db, req.user, project.id);
    const pages = ensureManagerBriefForResponse(db.wikiPages.filter((item) => item.projectId === req.params.id), db, project);
    res.json({ pages });
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:id/wiki/index", async (req, res, next) => {
  try {
    const db = await loadDb();
    const project = getProjectOrThrow(db, req.params.id);
    assertCanAccessEntityProject(db, req.user, project.id);
    const pages = ensureManagerBriefForResponse(db.wikiPages.filter((item) => item.projectId === project.id), db, project);
    const grouped = pages.reduce((acc, page) => {
      acc[page.type] ||= [];
      acc[page.type].push(page);
      return acc;
    }, {});
    for (const typePages of Object.values(grouped)) {
      typePages.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    }
    res.json({
      project,
      stats: {
        pages: pages.length,
        sources: db.sourceFiles.filter((item) => item.projectId === project.id).length,
        changes: db.changes.filter((item) => item.projectId === project.id).length
      },
      indexPage: pages.find((item) => item.type === "INDEX") || null,
      timelinePage: pages.find((item) => item.type === "TIMELINE") || null,
      lintPage: pages.find((item) => item.type === "LINT") || null,
      logPage: pages.find((item) => item.type === "LOG") || null,
      grouped
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:id/wiki/lint", async (req, res, next) => {
  try {
    const db = await loadDb();
    const project = getProjectOrThrow(db, req.params.id);
    assertCanAccessEntityProject(db, req.user, project.id);
    res.json({ report: buildWikiLintReport(project, db) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/wiki-pages/:id", async (req, res, next) => {
  try {
    const db = await loadDb();
    const page = db.wikiPages.find((item) => item.id === req.params.id);
    if (!page) return res.status(404).json({ error: "Wiki page not found" });
    assertCanAccessEntityProject(db, req.user, page.projectId);
    res.json({
      page,
      versions: db.wikiPageVersions.filter((item) => item.wikiPageId === page.id),
      evidences: db.sourceEvidences.filter((item) => item.projectId === page.projectId && page.sourceIds.includes(item.sourceFileId))
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/wiki-pages/:id/versions", async (req, res, next) => {
  try {
    const db = await loadDb();
    const page = db.wikiPages.find((item) => item.id === req.params.id);
    if (!page) return res.status(404).json({ error: "Wiki page not found" });
    assertCanAccessEntityProject(db, req.user, page.projectId);
    res.json({ versions: db.wikiPageVersions.filter((item) => item.wikiPageId === req.params.id) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:id/changes", async (req, res, next) => {
  try {
    const db = await loadDb();
    getProjectOrThrow(db, req.params.id);
    const status = req.query.status;
    const changes = db.changes
      .filter((item) => item.projectId === req.params.id)
      .filter((item) => !status || item.status === status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json({ changes: changes.map((change) => enrichChangeForResponse(db, change)) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/changes/:id/trace", async (req, res, next) => {
  try {
    const db = await loadDb();
    const change = db.changes.find((item) => item.id === req.params.id);
    if (!change) return res.status(404).json({ error: "Change not found" });
    assertCanAccessEntityProject(db, req.user, change.projectId);
    const enriched = enrichChangeForResponse(db, change);
    const sourceFile = change.sourceFileId ? db.sourceFiles.find((item) => item.id === change.sourceFileId) : null;
    const transcript = sourceFile
      ? db.transcripts.filter((item) => item.sourceFileId === sourceFile.id).sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0] || null
      : null;
    const dependencyChanges = (change.dependencyChangeIds || [])
      .map((id) => db.changes.find((item) => item.id === id))
      .filter(Boolean)
      .map((item) => enrichChangeForResponse(db, item));
    const relatedRequirements = (change.relatedRequirementIds || [])
      .map((id) => db.requirements.find((item) => item.id === id))
      .filter(Boolean);
    const relatedWikiPages = (change.relatedWikiPageIds || [])
      .map((id) => db.wikiPages.find((item) => item.id === id))
      .filter(Boolean);
    const evidences = (db.sourceEvidences || []).filter((item) => item.entityId === change.id || item.targetId === change.id || (change.evidenceIds || []).includes(item.id));
    res.json({
      change: enriched,
      sourceFile,
      transcript,
      evidences,
      dependencyChanges,
      relatedRequirements,
      relatedWikiPages
    });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/changes/:id/status", async (req, res, next) => {
  try {
    const result = await mutateDb((db) => {
      const change = db.changes.find((item) => item.id === req.params.id);
      if (!change) {
        const error = new Error("Change not found");
        error.status = 404;
        throw error;
      }
      assertCanManageEntityProject(db, req.user, change.projectId);
      const requirement = updateChangeStatus(db, change, req.body.status || change.status);
      db.auditLogs.push({
        id: makeId("aud"),
        projectId: change.projectId,
        actorId: req.user.id,
        actorName: req.user.name,
        actor: req.user.name,
        action: "CHANGE_STATUS_UPDATED",
        targetType: "Change",
        targetId: change.id,
        detail: `变更状态更新为 ${change.status}`,
        createdAt: nowIso()
      });
      return { change, requirement };
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/customer/projects", requireRole(SYSTEM_ROLES.CUSTOMER), async (req, res, next) => {
  try {
    const db = await loadDb();
    const usersById = Object.fromEntries(db.users.map((user) => [user.id, user]));
    const projects = db.projects
      .filter((project) => isCustomerForProject(req.user, project.id, db))
      .map((project) => ({ ...project, owner: usersById[project.ownerId] ? sanitizeUser(usersById[project.ownerId]) : null }));
    res.json({ projects });
  } catch (error) {
    next(error);
  }
});

app.get("/api/customer/projects/:id/portal", requireRole(SYSTEM_ROLES.CUSTOMER), async (req, res, next) => {
  try {
    const db = await loadDb();
    const project = getProjectOrThrow(db, req.params.id);
    if (!isCustomerForProject(req.user, project.id, db)) {
      const error = new Error("无权访问该客户项目");
      error.status = 403;
      throw error;
    }
    res.json({
      project,
      dashboard: buildDashboard(db, project),
      changes: db.changes
        .filter((item) => item.projectId === project.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((change) => enrichChangeForResponse(db, change)),
      requirements: db.requirements.filter((item) => item.projectId === project.id),
      wikiPages: db.wikiPages.filter((item) => item.projectId === project.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      sourceFiles: sortSourceFilesByDocumentDateDesc(db.sourceFiles.filter((item) => item.projectId === project.id)),
      confirmations: db.changeConfirmations.filter((item) => item.projectId === project.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/customer/changes/:id/confirm", requireRole(SYSTEM_ROLES.CUSTOMER), async (req, res, next) => {
  try {
    const result = await mutateDb((db) => {
      const change = db.changes.find((item) => item.id === req.params.id);
      if (!change) {
        const error = new Error("Change not found");
        error.status = 404;
        throw error;
      }
      if (!isCustomerForProject(req.user, change.projectId, db)) {
        const error = new Error("无权确认该变更");
        error.status = 403;
        throw error;
      }
      if (change.status !== "需客户确认") {
        const error = new Error("只有需客户确认的变更可由客户确认");
        error.status = 409;
        throw error;
      }
      change.status = "已确认";
      change.updatedAt = nowIso();
      const confirmation = addChangeConfirmation(db, change, req.user, "确认通过", req.body.comment || "");
      const requirement = applyConfirmedChange(db, change);
      appendAuditLog(db, {
        projectId: change.projectId,
        actor: req.user,
        action: "CUSTOMER_CHANGE_CONFIRMED",
        targetType: "Change",
        targetId: change.id,
        after: { status: change.status, comment: req.body.comment || "" },
        detail: `客户确认变更 ${change.title}`
      });
      return { change, confirmation, requirement };
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/customer/changes/:id/reject", requireRole(SYSTEM_ROLES.CUSTOMER), async (req, res, next) => {
  try {
    const result = await mutateDb((db) => {
      const change = db.changes.find((item) => item.id === req.params.id);
      if (!change) {
        const error = new Error("Change not found");
        error.status = 404;
        throw error;
      }
      if (!isCustomerForProject(req.user, change.projectId, db)) {
        const error = new Error("无权退回该变更");
        error.status = 403;
        throw error;
      }
      if (change.status !== "需客户确认") {
        const error = new Error("只有需客户确认的变更可由客户退回");
        error.status = 409;
        throw error;
      }
      change.status = "客户退回";
      change.updatedAt = nowIso();
      const confirmation = addChangeConfirmation(db, change, req.user, "退回修改", req.body.comment || "");
      appendAuditLog(db, {
        projectId: change.projectId,
        actor: req.user,
        action: "CUSTOMER_CHANGE_REJECTED",
        targetType: "Change",
        targetId: change.id,
        after: { status: change.status, comment: req.body.comment || "" },
        detail: `客户退回变更 ${change.title}`
      });
      return { change, confirmation };
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:id/wiki/export-markdown", async (req, res, next) => {
  try {
    const exportRecord = await mutateDb((db) => {
      assertCanManageProjectId(db, req.user, req.params.id);
      return exportProjectMarkdown(db, req.params.id);
    });
    res.status(201).json({ export: exportRecord });
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:id/search", async (req, res, next) => {
  try {
    const db = await loadDb();
    getProjectOrThrow(db, req.params.id);
    const q = String(req.query.q || "").trim();
    const includes = (value) => q && String(value || "").toLowerCase().includes(q.toLowerCase());
    res.json({
      wikiPages: db.wikiPages.filter((item) => item.projectId === req.params.id && [item.title, item.summary, item.content].some(includes)),
      requirements: db.requirements.filter((item) => item.projectId === req.params.id && [item.title, item.description, item.moduleName].some(includes)),
      changes: db.changes.filter((item) => item.projectId === req.params.id && [item.title, item.summary, item.moduleName].some(includes)),
      sourceFiles: sortSourceFilesByDocumentDateDesc(
        db.sourceFiles.filter((item) => item.projectId === req.params.id && [item.title, item.originalName, item.aiSummary, item.note].some(includes))
      )
    });
  } catch (error) {
    next(error);
  }
});

const distDir = path.join(__dirname, "..", "dist");
app.use(express.static(distDir));

app.get(/^(?!\/api).*/, (req, res) => {
  res.sendFile(path.join(distDir, "index.html"));
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(error.status || 500).json({ error: error.message || "Internal server error" });
});

app.listen(port, () => {
  console.log(`API server listening on http://localhost:${port}`);
});

async function requireAuth(req, res, next) {
  try {
    const headerToken = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const queryToken = typeof req.query.access_token === "string" ? req.query.access_token : "";
    const token = headerToken || queryToken;
    if (!token) {
      const error = new Error("请先登录");
      error.status = 401;
      throw error;
    }
    const db = await loadDb();
    const tokenHash = hashToken(token);
    const session = db.sessions.find((item) => item.tokenHash === tokenHash && new Date(item.expiresAt).getTime() > Date.now());
    const user = session ? db.users.find((item) => item.id === session.userId) : null;
    if (!user || user.status === "disabled") {
      const error = new Error("登录已失效，请重新登录");
      error.status = 401;
      throw error;
    }
    req.session = session;
    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.systemRole)) {
      const error = new Error("无权访问该功能");
      error.status = 403;
      next(error);
      return;
    }
    next();
  };
}

function assertCanAccessProjectId(db, user, projectId) {
  const project = getProjectOrThrow(db, projectId);
  if (!canAccessProject(user, project, db)) {
    const error = new Error("无权访问该项目");
    error.status = 403;
    throw error;
  }
  return project;
}

function assertCanManageProjectId(db, user, projectId) {
  const project = assertCanAccessProjectId(db, user, projectId);
  if (user.systemRole === SYSTEM_ROLES.CUSTOMER) {
    const error = new Error("客户角色无权执行该管理操作");
    error.status = 403;
    throw error;
  }
  return project;
}

function assertCanAccessEntityProject(db, user, projectId) {
  return assertCanAccessProjectId(db, user, projectId);
}

function assertCanManageEntityProject(db, user, projectId) {
  return assertCanManageProjectId(db, user, projectId);
}

function buildAdminProjects(db) {
  return db.projects.map((project) => buildAdminProjectView(db, project)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function buildAdminUserView(db, user) {
  const safeUser = sanitizeUser(user);
  const memberships = (db.projectMembers || [])
    .filter((member) => member.userId === user.id)
    .map((member) => {
      const project = db.projects.find((item) => item.id === member.projectId);
      return {
        id: member.id,
        projectId: member.projectId,
        projectName: project?.name || "未知项目",
        projectStatus: project?.status || "active",
        role: member.role,
        memberType: member.memberType || inferMemberType(member.role),
        isPrimaryManager: Boolean(member.isPrimaryManager),
        canConfirmChanges: Boolean(member.canConfirmChanges)
      };
    })
    .sort((a, b) => a.projectName.localeCompare(b.projectName, "zh-CN"));
  return { ...safeUser, memberships };
}

function buildAdminProjectView(db, project) {
  const owner = db.users.find((user) => user.id === project.ownerId);
  const members = buildProjectMembers(db, project.id);
  return {
    ...project,
    owner: sanitizeUser(owner),
    managers: members.filter((member) => member.memberType === "manager" || member.role.includes("经理")),
    users: members.filter((member) => member.memberType !== "manager" && !member.role.includes("经理")),
    recentLogs: db.auditLogs
      .filter((item) => item.projectId === project.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 8)
  };
}

function buildAdminProjectUsers(db, projectId) {
  const members = buildProjectMembers(db, projectId);
  return {
    managers: members.filter((member) => member.memberType === "manager" || member.role.includes("经理")),
    users: members.filter((member) => member.memberType !== "manager" && !member.role.includes("经理"))
  };
}

function getAdminManagerOrThrow(db, userId) {
  const manager = db.users.find((user) => user.id === userId);
  if (!manager) {
    const error = new Error("请选择项目经理");
    error.status = 400;
    throw error;
  }
  manager.systemRole = SYSTEM_ROLES.PROJECT_MANAGER;
  manager.role = manager.role || "项目经理";
  return manager;
}

function ensureProjectManagerMember(db, projectId, userId, isPrimaryManager = false) {
  let member = db.projectMembers.find((item) => item.projectId === projectId && item.userId === userId);
  if (!member) {
    member = {
      id: makeId("mem"),
      tenantId: db.projects?.find((project) => project.id === projectId)?.tenantId || "tenant_default",
      projectId,
      userId,
      role: "项目经理",
      memberType: "manager",
      permissions: defaultPermissionsForMemberType("manager"),
      canConfirmChanges: false,
      isPrimaryManager
    };
    db.projectMembers.push(member);
  }
  member.memberType = "manager";
  member.role = member.role || "项目经理";
  member.isPrimaryManager = Boolean(isPrimaryManager || member.isPrimaryManager);
  return member;
}

function addChangeConfirmation(db, change, actor, action, comment) {
  if (!Array.isArray(db.changeConfirmations)) db.changeConfirmations = [];
  const confirmation = {
    id: makeId("ccf"),
    tenantId: db.projects?.find((project) => project.id === change.projectId)?.tenantId || actor?.tenantId || "tenant_default",
    changeId: change.id,
    projectId: change.projectId,
    actorId: actor.id,
    actorName: actor.name,
    action,
    comment,
    createdAt: nowIso()
  };
  db.changeConfirmations.push(confirmation);
  return confirmation;
}

function ensureRequirementSuggestions(db) {
  if (!Array.isArray(db.requirementSuggestions)) db.requirementSuggestions = [];
  return db.requirementSuggestions;
}

function normalizeDocumentStage(value) {
  return DOCUMENT_STAGE_OPTIONS.includes(value) ? value : "需求确认阶段";
}

function normalizeDocumentPurpose(value) {
  return DOCUMENT_PURPOSE_OPTIONS.includes(value) ? value : "通用资料";
}

function updateChangeStatus(db, change, nextStatus) {
  const status = CHANGE_STATUS_OPTIONS.includes(nextStatus) ? nextStatus : "";
  if (!status) {
    const error = new Error("Unsupported change status");
    error.status = 400;
    throw error;
  }
  if (change.status === status) {
    const error = new Error(`该变更已经是「${status}」状态`);
    error.status = 409;
    throw error;
  }
  if (["已确认", "已驳回"].includes(change.status)) {
    const error = new Error("已完成处理的变更不能重复更新");
    error.status = 409;
    throw error;
  }
  if (status === "已确认" && change.status !== "需客户确认") {
    const error = new Error("需求变更需先提交客户确认，再写入需求");
    error.status = 409;
    throw error;
  }
  if (status === "需客户确认" && !["待确认", "客户退回"].includes(change.status)) {
    const error = new Error("只有待确认或客户退回的变更可提交客户确认");
    error.status = 409;
    throw error;
  }
  change.status = status;
  change.updatedAt = nowIso();
  return applyConfirmedChange(db, change);
}

function buildRequirementSuggestionContext(db, project) {
  const byProject = (items = []) => items.filter((item) => item.projectId === project.id);
  return {
    project: {
      id: project.id,
      name: project.name,
      customerName: project.customerName,
      stage: project.stage,
      status: project.status
    },
    managerBrief: buildManagerBrief(db, project),
    requirements: byProject(db.requirements).slice(-80).map((item) => ({
      id: item.id,
      moduleName: item.moduleName,
      title: item.title,
      description: shortPlainText(item.description, 180),
      status: item.status,
      priority: item.priority
    })),
    changes: byProject(db.changes).slice(-80).map((item) => ({
      id: item.id,
      moduleName: item.moduleName,
      title: item.title,
      changeType: item.changeType,
      summary: shortPlainText(item.summary || item.afterContent, 180),
      status: item.status,
      confidence: item.confidence,
      sourceFileId: item.sourceFileId
    })),
    risks: byProject(db.risks).slice(-40).map((item) => ({
      id: item.id,
      title: item.title,
      summary: shortPlainText(item.summary, 180),
      severity: item.severity,
      sourceFileId: item.sourceFileId
    })),
    openQuestions: byProject(db.openQuestions).slice(-40).map((item) => ({
      id: item.id,
      title: item.title,
      summary: shortPlainText(item.summary, 180),
      owner: item.owner,
      status: item.status,
      sourceFileId: item.sourceFileId
    })),
    wikiPages: byProject(db.wikiPages)
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
      .slice(0, 50)
      .map((item) => ({
        id: item.id,
        type: item.type,
        title: item.title,
        summary: shortPlainText(item.summary || item.content, 220),
        signalLevel: item.signalLevel,
        sourceIds: item.sourceIds || []
      })),
    sources: byProject(db.sourceFiles)
      .sort((a, b) => String(b.uploadedAt || b.createdAt || "").localeCompare(String(a.uploadedAt || a.createdAt || "")))
      .slice(0, 30)
      .map((item) => ({
        id: item.id,
        title: item.title || item.originalName,
        category: item.category,
        signalLevel: item.signalLevel,
        uploadedAt: item.uploadedAt
      }))
  };
}

function buildHeuristicRequirementSuggestions(db, project) {
  const context = buildRequirementSuggestionContext(db, project);
  const existingTitles = new Set(context.requirements.map((item) => normalizeSuggestionKey(item.title)));
  const suggestions = [];
  const push = (item) => {
    const normalizedTitle = normalizeSuggestionKey(item.title);
    if (!normalizedTitle || existingTitles.has(normalizedTitle)) return;
    if (suggestions.some((suggestion) => normalizeSuggestionKey(suggestion.title) === normalizedTitle)) return;
    suggestions.push(item);
  };

  for (const question of context.openQuestions.filter((item) => !["已确认", "已关闭"].includes(item.status)).slice(0, 4)) {
    const moduleName = inferModuleName(question.title, question.summary);
    push({
      moduleName,
      title: `${moduleName}确认规则`,
      description: `客户下一轮可能会要求明确「${question.title}」的处理口径。建议提前补充配置项、边界条件、责任人和验收方式，避免后续沟通只停留在待确认状态。`,
      reason: `来自待确认事项：${question.summary || question.title}`,
      priority: "高",
      confidence: 0.72,
      customerQuestion: `这个问题最终按什么规则执行？由谁确认？`,
      acceptanceCriteria: "形成明确处理规则；标注适用范围；关联来源资料；客户或项目经理完成确认。",
      sourceIds: question.sourceFileId ? [question.sourceFileId] : [],
      relatedWikiPageIds: [],
      relatedChangeIds: []
    });
  }

  for (const risk of context.risks.slice(0, 3)) {
    const moduleName = inferModuleName(risk.title, risk.summary);
    push({
      moduleName,
      title: `${moduleName}风险预警与处理机制`,
      description: `客户可能会追问「${risk.title}」如何控制。建议补充风险等级、触发条件、通知对象、处理流程和留痕方式。`,
      reason: `来自风险台账：${risk.summary || risk.title}`,
      priority: risk.severity === "高" ? "高" : "中",
      confidence: 0.66,
      customerQuestion: "如果这个风险发生，系统如何提醒、谁来处理、是否有记录？",
      acceptanceCriteria: "配置风险触发条件；展示处理状态；保留操作记录；支持后续复盘。",
      sourceIds: risk.sourceFileId ? [risk.sourceFileId] : [],
      relatedWikiPageIds: [],
      relatedChangeIds: []
    });
  }

  for (const change of context.changes.filter((item) => item.status !== "已驳回").slice(0, 5)) {
    const moduleName = change.moduleName || inferModuleName(change.title, change.summary);
    push({
      moduleName,
      title: `${moduleName}变更影响评估`,
      description: `围绕「${change.title}」已经出现变更信号，客户可能会继续要求说明对流程、权限、数据和交付周期的影响。`,
      reason: `来自需求变更：${change.summary || change.title}`,
      priority: change.status === "需客户确认" ? "高" : "中",
      confidence: Math.max(0.58, Number(change.confidence || 0.58)),
      customerQuestion: "这个变更会影响哪些页面、角色、数据和上线时间？",
      acceptanceCriteria: "列出影响范围；关联依赖需求；给出是否进入本期的建议；保留来源证据。",
      sourceIds: change.sourceFileId ? [change.sourceFileId] : [],
      relatedWikiPageIds: [],
      relatedChangeIds: [change.id]
    });
  }

  for (const page of context.wikiPages.filter((item) => ["TOPIC", "PROJECT_EVOLUTION", "REQUIREMENT_BASELINE", "DELIVERY_COMPILATION"].includes(item.type)).slice(0, 5)) {
    const moduleName = inferModuleName(page.title, page.summary);
    push({
      moduleName,
      title: `${page.title}操作闭环`,
      description: `Wiki 中「${page.title}」已经形成主题沉淀，客户很可能会进一步要求落到可操作页面、状态流转、权限控制和验收标准。`,
      reason: `来自 Wiki 页面：${page.summary || page.title}`,
      priority: "中",
      confidence: page.signalLevel === "high" ? 0.64 : 0.56,
      customerQuestion: "这个主题最终在系统里怎么操作，谁能看，谁能改？",
      acceptanceCriteria: "明确入口页面；定义角色权限；给出状态流转；列出关键字段和验收口径。",
      sourceIds: page.sourceIds || [],
      relatedWikiPageIds: [page.id],
      relatedChangeIds: []
    });
  }

  if (!suggestions.length) {
    push({
      moduleName: "项目范围",
      title: "客户确认与需求留痕",
      description: "当前项目资料仍不足以预测具体业务需求，但商业项目通常会继续追问确认流程、责任边界和历史依据。建议先补充统一确认与留痕能力。",
      reason: "来自项目通用沟通闭环",
      priority: "中",
      confidence: 0.45,
      customerQuestion: "后续如果双方理解不一致，系统如何证明当时确认了什么？",
      acceptanceCriteria: "每条需求可追溯来源；每次确认有操作者和时间；支持导出确认记录。",
      sourceIds: [],
      relatedWikiPageIds: [],
      relatedChangeIds: []
    });
  }

  return normalizeRequirementSuggestions(db, project, suggestions, {
    generatedBy: "wiki-rules",
    timestamp: nowIso(),
    persist: false
  }).slice(0, 10);
}

async function generateRequirementSuggestionsWithModel(db, project) {
  const adapter = getActiveModelAdapter(db, "LLM");
  if (!adapter || !isOpenAICompatibleAdapter(adapter)) throw new Error("未配置可用的大模型适配器。");
  const config = adapterClientTestConfig(adapter);
  if (!config.baseURL) throw new Error("缺少大模型 Base URL。");
  if (!config.model) throw new Error("缺少大模型名称。");
  if (!config.apiKey) throw new Error("缺少大模型 API Key。");

  const context = buildRequirementSuggestionContext(db, project);
  const prompt = [
    "你是木铎知会的需求预测分析师。请基于项目 LLM Wiki 编译结果、需求池、变更、风险、待确认事项和来源摘要，预测客户下一轮可能提出的需求。",
    "要求：不要重复已有需求；不要把猜测写成已确认；每条建议必须说明为什么客户可能会提、可能会问什么、建议验收口径是什么。",
    "输出 JSON，不要代码围栏。最多 8 条。",
    "JSON 格式：",
    JSON.stringify(
      {
        suggestions: [
          {
            moduleName: "模块",
            title: "建议需求标题",
            description: "需求建议描述",
            reason: "预测依据",
            priority: "高|中|低",
            confidence: 0.68,
            customerQuestion: "客户可能会怎么问",
            acceptanceCriteria: "建议验收标准",
            sourceIds: ["来源文件ID"],
            relatedWikiPageIds: ["Wiki页面ID"],
            relatedChangeIds: ["变更ID"]
          }
        ]
      },
      null,
      2
    ),
    "项目上下文：",
    JSON.stringify(context, null, 2)
  ].join("\n");

  const response = await fetchWithTimeout(joinUrl(config.baseURL, "/chat/completions"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: "system", content: "你只输出合法 JSON。" },
        { role: "user", content: prompt }
      ],
      temperature: 0.25,
      max_tokens: 2200
    })
  }, adapter.timeoutSeconds || 120);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(extractProviderError(data) || `HTTP ${response.status}`);
  const content = data.choices?.[0]?.message?.content || data.choices?.[0]?.text || "";
  const parsed = parseJsonObject(content);
  return Array.isArray(parsed) ? parsed : parsed.suggestions || [];
}

function normalizeRequirementSuggestions(db, project, suggestions, options = {}) {
  const timestamp = options.timestamp || nowIso();
  const projectSourceIds = new Set((db.sourceFiles || []).filter((item) => item.projectId === project.id).map((item) => item.id));
  const projectWikiPageIds = new Set((db.wikiPages || []).filter((item) => item.projectId === project.id).map((item) => item.id));
  const projectChangeIds = new Set((db.changes || []).filter((item) => item.projectId === project.id).map((item) => item.id));
  const existingTitles = new Set((db.requirements || []).filter((item) => item.projectId === project.id).map((item) => normalizeSuggestionKey(item.title)));
  const seen = new Set();
  return (Array.isArray(suggestions) ? suggestions : [])
    .map((item, index) => {
      const title = cleanText(item.title || item.name || `需求建议 ${index + 1}`);
      const key = normalizeSuggestionKey(title);
      if (!key || existingTitles.has(key) || seen.has(key)) return null;
      seen.add(key);
      const sourceIds = arrayOfStrings(item.sourceIds).filter((id) => projectSourceIds.has(id)).slice(0, 5);
      const relatedWikiPageIds = arrayOfStrings(item.relatedWikiPageIds).filter((id) => projectWikiPageIds.has(id)).slice(0, 5);
      const relatedChangeIds = arrayOfStrings(item.relatedChangeIds).filter((id) => projectChangeIds.has(id)).slice(0, 5);
      return {
        id: item.id || (options.persist ? makeId("rsug") : `rsug_preview_${index}_${key.slice(0, 10)}`),
        projectId: project.id,
        moduleName: cleanText(item.moduleName || inferModuleName(title, item.description || item.reason)),
        title,
        description: cleanText(item.description || item.summary || "建议进一步确认该需求。"),
        reason: cleanText(item.reason || item.basis || "基于 Wiki 编译结果推断。"),
        priority: ["高", "中", "低"].includes(item.priority) ? item.priority : "中",
        confidence: clampConfidence(item.confidence),
        customerQuestion: cleanText(item.customerQuestion || "客户可能会进一步追问该能力如何落地。"),
        acceptanceCriteria: cleanText(item.acceptanceCriteria || "明确业务口径、角色权限、流程边界和验收标准。"),
        sourceIds,
        relatedWikiPageIds,
        relatedChangeIds,
        status: item.status || "建议",
        generatedBy: options.generatedBy || item.generatedBy || "llm-wiki",
        createdAt: item.createdAt || timestamp,
        updatedAt: timestamp
      };
    })
    .filter(Boolean);
}

function parseJsonObject(text = "") {
  const cleaned = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const firstObject = cleaned.indexOf("{");
    const lastObject = cleaned.lastIndexOf("}");
    if (firstObject >= 0 && lastObject > firstObject) return JSON.parse(cleaned.slice(firstObject, lastObject + 1));
    const firstArray = cleaned.indexOf("[");
    const lastArray = cleaned.lastIndexOf("]");
    if (firstArray >= 0 && lastArray > firstArray) return JSON.parse(cleaned.slice(firstArray, lastArray + 1));
    throw new Error("模型未返回合法 JSON。");
  }
}

function inferModuleName(...values) {
  const text = values.filter(Boolean).join(" ");
  const match = text.match(/([\u4e00-\u9fa5A-Za-z0-9]{2,16})(?:模块|管理|中心|平台|系统|流程|权限|报表|支付|对账|合同|档案|提醒|任务)/);
  if (match?.[0]) return match[0].slice(0, 18);
  if (text.includes("权限")) return "权限管理";
  if (text.includes("风险")) return "风险管理";
  if (text.includes("确认")) return "确认流程";
  if (text.includes("客户")) return "客户协同";
  return "项目范围";
}

function normalizeSuggestionKey(value = "") {
  return String(value).trim().toLowerCase().replace(/\s+/g, "");
}

function arrayOfStrings(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function cleanText(value = "", max = 320) {
  return shortPlainText(String(value || "").replace(/\s+/g, " ").trim(), max);
}

function shortPlainText(value = "", max = 160) {
  const text = String(value || "").replace(/[#>*_\-\[\]()`]/g, "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function clampConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0.58;
  return Math.min(0.95, Math.max(0.35, number > 1 ? number / 100 : number));
}

function buildDashboard(db, project) {
  const requirements = db.requirements.filter((item) => item.projectId === project.id);
  const changes = db.changes.filter((item) => item.projectId === project.id);
  const sourceFiles = db.sourceFiles.filter((item) => item.projectId === project.id);
  const communications = db.communications.filter((item) => item.projectId === project.id);
  const wikiPages = db.wikiPages.filter((item) => item.projectId === project.id);
  const openQuestions = db.openQuestions.filter((item) => item.projectId === project.id && item.status === "待确认");

  const confirmed = requirements.filter((item) => item.status === "已确认").length;
  const pendingChanges = changes.filter((item) => item.status === "待确认");
  const statusCounts = countBy(requirements, "status");

  return {
    project,
    metrics: {
      requirementTotal: requirements.length,
      confirmedRequirements: confirmed,
      confirmedRatio: requirements.length ? Math.round((confirmed / requirements.length) * 1000) / 10 : 0,
      changeTotal: changes.length,
      pendingChangeTotal: pendingChanges.length,
      communicationTotal: communications.length,
      documentTotal: sourceFiles.length,
      wikiPageTotal: wikiPages.length,
      openQuestionTotal: openQuestions.length
    },
    requirementStatus: Object.entries(statusCounts).map(([name, value]) => ({ name, value })),
    trend: buildTrend(changes),
    pendingChanges: pendingChanges.slice(0, 6),
    recentChanges: changes.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 8),
    communications: communications
      .sort((a, b) => String(b.meetingTime || b.createdAt).localeCompare(String(a.meetingTime || a.createdAt))),
    wikiPages: wikiPages.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8),
    sourceFiles: sortSourceFilesByDocumentDateDesc(sourceFiles).slice(0, 8),
    risks: db.risks.filter((item) => item.projectId === project.id).slice(0, 6),
    openQuestions,
    managerBrief: buildManagerBrief(db, project)
  };
}

function ensureManagerBriefForResponse(pages, db, project) {
  const list = [...pages];
  const existing = list.find((item) => item.type === "MANAGER_BRIEF" || item.slug === "manager-brief");
  if (existing) {
    existing.managerBrief ||= buildManagerBrief(db, project);
  } else {
    list.push(buildManagerBriefWikiPage(project, db));
  }
  return list.sort(compareWikiPageForResponse);
}

function compareWikiPageForResponse(a, b) {
  const weightDiff = wikiPageTypeWeight(a.type) - wikiPageTypeWeight(b.type);
  if (weightDiff) return weightDiff;
  return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
}

function wikiPageTypeWeight(type) {
  return {
    MANAGER_BRIEF: 0,
    PROJECT_OVERVIEW: 1,
    REQUIREMENT_BASELINE: 2,
    PROJECT_EVOLUTION: 3,
    DELIVERY_COMPILATION: 4,
    RISK_REGISTER: 5,
    OPEN_QUESTION: 6,
    DECISION_LOG: 7,
    TOPIC: 8,
    SOURCE_SUMMARY: 9,
    INDEX: 10,
    TIMELINE: 11,
    LINT: 12,
    LOG: 13
  }[type] ?? 50;
}

function sortSourceFilesByDocumentDateDesc(sourceFiles) {
  return [...sourceFiles].sort(compareSourceFileByDocumentDateDesc);
}

function createIngestJob(db, project, sourceFile, { reason = "manual" } = {}) {
  const timestamp = nowIso();
  const job = {
    id: makeId("job"),
    tenantId: project.tenantId || sourceFile.tenantId || "tenant_default",
    projectId: project.id,
    sourceFileId: sourceFile.id,
    status: "processing",
    step: "extract",
    progress: 0,
    error: null,
    resultSummary: { reason },
    attempts: 0,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  db.ingestJobs.push(job);
  sourceFile.status = "processing";
  sourceFile.updatedAt = timestamp;
  return job;
}

function clearCompilerOutputsForSources(db, projectId, sourceIds) {
  const projectSourceIds = (db.sourceFiles || []).filter((item) => item.projectId === projectId).map((item) => item.id);
  const isFullProjectRecompile = projectSourceIds.length > 0 && projectSourceIds.every((id) => sourceIds.has(id));
  const wikiPageIds = new Set((db.wikiPages || [])
    .filter((item) => item.projectId === projectId)
    .filter((item) => {
      if (isFullProjectRecompile) return true;
      return item.type === "SOURCE_SUMMARY" && (item.sourceIds || []).some((id) => sourceIds.has(id));
    })
    .map((item) => item.id));
  const unconfirmedChangeIds = new Set((db.changes || [])
    .filter((item) => item.projectId === projectId && sourceIds.has(item.sourceFileId) && item.status !== "已确认")
    .map((item) => item.id));
  const decisionIds = new Set((db.decisions || []).filter((item) => item.projectId === projectId && sourceIds.has(item.sourceFileId)).map((item) => item.id));
  const riskIds = new Set((db.risks || []).filter((item) => item.projectId === projectId && sourceIds.has(item.sourceFileId)).map((item) => item.id));
  const questionIds = new Set((db.openQuestions || []).filter((item) => item.projectId === projectId && sourceIds.has(item.sourceFileId)).map((item) => item.id));

  db.wikiPages = (db.wikiPages || []).filter((item) => !wikiPageIds.has(item.id));
  db.wikiPageVersions = (db.wikiPageVersions || []).filter((item) => !wikiPageIds.has(item.wikiPageId));
  db.wikiLinks = (db.wikiLinks || []).filter((item) => !wikiPageIds.has(item.fromPageId) && !wikiPageIds.has(item.toPageId));
  db.changes = (db.changes || []).filter((item) => !unconfirmedChangeIds.has(item.id));
  db.decisions = (db.decisions || []).filter((item) => !decisionIds.has(item.id));
  db.risks = (db.risks || []).filter((item) => !riskIds.has(item.id));
  db.openQuestions = (db.openQuestions || []).filter((item) => !questionIds.has(item.id));
  db.communications = (db.communications || []).filter((item) => !sourceIds.has(item.sourceFileId));
  db.sourceEvidences = (db.sourceEvidences || []).filter((item) => {
    if (sourceIds.has(item.sourceFileId)) return false;
    if (wikiPageIds.has(item.targetId) || wikiPageIds.has(item.entityId)) return false;
    if (unconfirmedChangeIds.has(item.targetId) || unconfirmedChangeIds.has(item.entityId)) return false;
    if (decisionIds.has(item.targetId) || decisionIds.has(item.entityId)) return false;
    if (riskIds.has(item.targetId) || riskIds.has(item.entityId)) return false;
    if (questionIds.has(item.targetId) || questionIds.has(item.entityId)) return false;
    return true;
  });
  for (const sourceFile of db.sourceFiles || []) {
    if (sourceIds.has(sourceFile.id)) {
      sourceFile.status = sourceFile.parsedText ? "parsed" : "uploaded";
      sourceFile.aiSummary = "";
      sourceFile.updatedAt = nowIso();
    }
  }
}

function enrichChangeForResponse(db, change) {
  const sourceFile = change.sourceFileId ? db.sourceFiles.find((item) => item.id === change.sourceFileId) : null;
  const transcript = sourceFile
    ? (db.transcripts || [])
        .filter((item) => item.sourceFileId === sourceFile.id)
        .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0] || null
    : null;
  const requirement = change.requirementId ? db.requirements.find((item) => item.id === change.requirementId) : null;
  const evidences = (db.sourceEvidences || [])
    .filter((item) => (item.entityType === "Change" && item.entityId === change.id) || (item.targetType === "Change" && item.targetId === change.id) || (change.evidenceIds || []).includes(item.id))
    .map((item) => ({
      id: item.id,
      quote: item.quote || "",
      location: item.location || "",
      sourceFileId: item.sourceFileId,
      timestampStart: item.timestampStart || null,
      timestampEnd: item.timestampEnd || null,
      speaker: item.speaker || null,
      confidence: item.confidence
    }));
  const dependencyChanges = (change.dependencyChangeIds || [])
    .map((id) => db.changes.find((item) => item.id === id))
    .filter(Boolean)
    .slice(0, 6)
    .map((item) => ({
      id: item.id,
      changeType: item.changeType,
      moduleName: item.moduleName,
      title: item.title,
      status: item.status,
      relation: "依赖变更"
    }));
  const relatedWikiPages = (change.relatedWikiPageIds || [])
    .map((id) => db.wikiPages.find((item) => item.id === id))
    .filter(Boolean)
    .slice(0, 8)
    .map((item) => ({ id: item.id, type: item.type, title: item.title, summary: item.summary }));
  const relatedChanges = findRelatedChanges(db, change).map((item) => ({
    id: item.id,
    changeType: item.changeType,
    moduleName: item.moduleName,
    title: item.title,
    status: item.status,
    relation: changeRelationLabel(change, item)
  }));
  const sameModuleRequirements = (db.requirements || [])
    .filter((item) => item.projectId === change.projectId && item.moduleName === change.moduleName && item.id !== requirement?.id)
    .slice(0, 4)
    .map((item) => ({
      id: item.id,
      moduleName: item.moduleName,
      title: item.title,
      status: item.status
    }));
  return {
    ...change,
    sourceFile: sourceFile ? sanitizeSourceFileForChange(sourceFile) : null,
    transcriptSnippet: buildTranscriptSnippet(change, sourceFile, transcript),
    evidences,
    structuralContext: {
      sourceFileId: change.sourceFileId || null,
      requirement: requirement
        ? {
            id: requirement.id,
            moduleName: requirement.moduleName,
            title: requirement.title,
            status: requirement.status
          }
        : null,
      relatedChanges,
      dependencyChanges,
      relatedWikiPages,
      sameModuleRequirements
    }
  };
}

function sanitizeSourceFileForChange(sourceFile) {
  return {
    id: sourceFile.id,
    title: sourceFile.title,
    originalName: sourceFile.originalName,
    category: sourceFile.category,
    status: sourceFile.status,
    uploadedAt: sourceFile.uploadedAt,
    rawUrl: `/api/source-files/${sourceFile.id}/raw`,
    previewApi: `/api/source-files/${sourceFile.id}/preview`
  };
}

function findRelatedChanges(db, change) {
  return (db.changes || [])
    .filter((item) => item.projectId === change.projectId && item.id !== change.id)
    .filter((item) => {
      if (change.requirementId && item.requirementId === change.requirementId) return true;
      if ((change.dependencyChangeIds || []).includes(item.id)) return true;
      if (change.sourceFileId && item.sourceFileId === change.sourceFileId) return true;
      if (change.moduleName && item.moduleName === change.moduleName) return true;
      return false;
    })
    .sort((a, b) => relationWeight(change, b) - relationWeight(change, a) || String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, 6);
}

function relationWeight(base, item) {
  let score = 0;
  if (base.requirementId && item.requirementId === base.requirementId) score += 4;
  if ((base.dependencyChangeIds || []).includes(item.id)) score += 5;
  if (base.sourceFileId && item.sourceFileId === base.sourceFileId) score += 3;
  if (base.moduleName && item.moduleName === base.moduleName) score += 2;
  return score;
}

function changeRelationLabel(base, item) {
  const labels = [];
  if (base.requirementId && item.requirementId === base.requirementId) labels.push("同一需求");
  if ((base.dependencyChangeIds || []).includes(item.id)) labels.push("依赖变更");
  if (base.sourceFileId && item.sourceFileId === base.sourceFileId) labels.push("同一来源");
  if (base.moduleName && item.moduleName === base.moduleName) labels.push("同一模块");
  return labels.join(" / ") || "相关变更";
}

function buildTranscriptSnippet(change, sourceFile, transcript) {
  const text = transcript?.text || sourceFile?.parsedText || "";
  if (!text) return null;
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const keywords = extractChangeKeywords(change);
  const matched = lines.filter((line) => keywords.some((keyword) => keyword && line.includes(keyword))).slice(0, 5);
  const snippet = (matched.length ? matched : lines.slice(0, 4)).join("\n").slice(0, 900);
  return {
    source: transcript ? "转录稿" : "解析文本",
    text: snippet
  };
}

function extractChangeKeywords(change) {
  const raw = [change.moduleName, change.title, change.summary, change.afterContent]
    .filter(Boolean)
    .join(" ");
  return [...new Set(String(raw).split(/[\s,，。；;：:、\[\]（）()<>《》|\/\\-]+/).map((item) => item.trim()).filter((item) => item.length >= 2))].slice(0, 12);
}

function compareSourceFileByDocumentDateDesc(a, b) {
  const diff = sourceDocumentTimestamp(b) - sourceDocumentTimestamp(a);
  if (diff !== 0) return diff;
  const uploadedDiff = Date.parse(b.uploadedAt || "") - Date.parse(a.uploadedAt || "");
  if (Number.isFinite(uploadedDiff) && uploadedDiff !== 0) return uploadedDiff;
  return String(b.originalName || b.title || "").localeCompare(String(a.originalName || a.title || ""), "zh-CN");
}

function compareSourceFileByDocumentDateAsc(a, b) {
  return compareSourceFileByDocumentDateDesc(b, a);
}

function sourceDocumentTimestamp(source) {
  const filenameTime = extractDateFromSourceName([source?.title, source?.originalName, source?.fileName].filter(Boolean).join(" "));
  if (filenameTime) return filenameTime;
  const uploadedTime = Date.parse(source?.uploadedAt || source?.createdAt || source?.updatedAt || "");
  return Number.isFinite(uploadedTime) ? uploadedTime : 0;
}

function extractDateFromSourceName(value = "") {
  const text = String(value);
  const patterns = [
    /((?:19|20)\d{2})[年./_\-\s]+(1[0-2]|0?[1-9])[月./_\-\s]+(3[01]|[12]\d|0?[1-9])(?:[日号])?(?:[\sT_\-]*(?:([01]?\d|2[0-3])(?:[点时:._-]?([0-5]\d))?(?:[分:._-]?([0-5]\d))?秒?))?/g,
    /((?:19|20)\d{2})(1[0-2]|0[1-9])(3[01]|[12]\d|0[1-9])(?:[\sT_\-]?([01]\d|2[0-3])([0-5]\d)?([0-5]\d)?)?/g
  ];
  let latest = 0;
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
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
  return latest;
}

function buildProjectTasks(db, projectId) {
  const changes = db.changes
    .filter((item) => item.projectId === projectId)
    .map((item) => buildTaskFromEntity("change", item));
  const questions = db.openQuestions
    .filter((item) => item.projectId === projectId)
    .map((item) => buildTaskFromEntity("question", item));
  const risks = db.risks
    .filter((item) => item.projectId === projectId)
    .map((item) => buildTaskFromEntity("risk", item));

  return [...changes, ...questions, ...risks].sort((a, b) => {
    if (taskDone(a.status) !== taskDone(b.status)) return taskDone(a.status) ? 1 : -1;
    return b.createdAt.localeCompare(a.createdAt);
  });
}

function buildTaskFromEntity(entityType, item) {
  const typeLabel = {
    change: "变更确认",
    question: "待确认事项",
    risk: "风险跟进"
  }[entityType];
  const owner = item.owner || item.proposer || "项目经理";
  const priority =
    item.priority ||
    item.severity ||
    (item.changeType === "删除" || item.changeType === "修改" ? "高" : item.changeType === "新增" ? "中" : "低");

  return {
    id: `${entityType}_${item.id}`,
    entityType,
    entityId: item.id,
    type: typeLabel,
    title: item.title,
    moduleName: item.moduleName || "项目范围",
    summary: item.summary,
    owner,
    priority,
    status: item.status,
    sourceFileId: item.sourceFileId || null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt || item.createdAt
  };
}

function taskDone(status) {
  return ["已确认", "已完成", "已关闭", "已驳回"].includes(status);
}

function buildProjectMembers(db, projectId) {
  return db.projectMembers
    .filter((item) => item.projectId === projectId)
    .map((item) => buildMemberView(db, item))
    .sort((a, b) => a.role.localeCompare(b.role, "zh-CN"));
}

function buildMemberView(db, member) {
  const user = db.users.find((item) => item.id === member.userId) || { name: "未知成员", role: "项目成员" };
  const requirementsOwned = db.requirements.filter((item) => item.projectId === member.projectId && item.owner === user.name).length;
  const changesRaised = db.changes.filter((item) => item.projectId === member.projectId && item.proposer === user.name).length;
  const pendingTasks = buildProjectTasks(db, member.projectId).filter((task) => task.owner === user.name && !taskDone(task.status)).length;
  return {
    id: member.id,
    userId: member.userId,
    name: user.name,
    account: user.account,
    phone: user.phone || "",
    email: user.email || "",
    status: user.status || "active",
    systemRole: user.systemRole,
    userRole: user.role,
    role: member.role,
    memberType: member.memberType || inferMemberType(member.role),
    isPrimaryManager: Boolean(member.isPrimaryManager),
    canConfirmChanges: Boolean(member.canConfirmChanges),
    side: member.role.includes("客户") ? "甲方" : "乙方",
    permissions: member.permissions || defaultPermissionsForRole(member.role),
    requirementsOwned,
    changesRaised,
    pendingTasks
  };
}

function defaultPermissionsForRole(role = "") {
  if (role.includes("客户")) return ["查看项目", "确认需求", "查看文档"];
  if (role.includes("开发")) return ["查看已确认需求", "评论", "查看文档"];
  if (role.includes("产品")) return ["管理需求", "管理变更", "导入资料", "导出报告"];
  if (role.includes("项目经理")) return ["管理项目", "管理成员", "确认变更", "导出报告"];
  return ["查看项目", "评论"];
}

async function testModelAdapter(adapter, prompt = "") {
  const startedAt = Date.now();
  const testedAt = nowIso();
  try {
    if (adapter.capability === "ASR" && String(adapter.provider || "").toLowerCase() === "doubao") {
      return validateDoubaoAsrAdapter(adapter, startedAt, testedAt);
    }
    if (adapter.capability === "PDF_PARSER" && String(adapter.provider || "").toLowerCase() === "local") {
      return {
        ok: true,
        capability: adapter.capability,
        testedAt,
        latencyMs: Date.now() - startedAt,
        message: "本地 PDF 解析器可用，无需外部接口。"
      };
    }
    if (adapter.capability === "EMBEDDING" && isOpenAICompatibleAdapter(adapter)) {
      return await testOpenAIEmbeddingAdapter(adapter, startedAt, testedAt, prompt);
    }
    if (["LLM", "VISION"].includes(adapter.capability) && isOpenAICompatibleAdapter(adapter)) {
      return await testOpenAIChatAdapter(adapter, startedAt, testedAt, prompt);
    }
    if (adapter.baseUrl) {
      return await testHttpReachability(adapter, startedAt, testedAt);
    }
    return {
      ok: false,
      capability: adapter.capability,
      testedAt,
      latencyMs: Date.now() - startedAt,
      message: "该适配器暂未配置可测试的 Base URL。"
    };
  } catch (error) {
    return {
      ok: false,
      capability: adapter.capability,
      testedAt,
      latencyMs: Date.now() - startedAt,
      message: error.message || "模型测试失败"
    };
  }
}

async function testOpenAIChatAdapter(adapter, startedAt, testedAt, prompt = "") {
  const config = adapterClientTestConfig(adapter);
  if (!config.baseURL) throw new Error("缺少 Base URL。");
  if (!config.model) throw new Error("缺少模型名称。");
  if (!config.apiKey) throw new Error(`缺少 API Key${config.envVarName ? `，请配置 ${config.envVarName} 或在页面保存 Key` : ""}。`);
  const response = await fetchWithTimeout(joinUrl(config.baseURL, "/chat/completions"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: "system", content: "You are a connectivity test endpoint. Reply briefly." },
        { role: "user", content: String(prompt || "请用一句话介绍人工智能。") }
      ],
      temperature: 0,
      max_tokens: 8
    })
  }, adapter.timeoutSeconds || 120);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(extractProviderError(data) || `HTTP ${response.status}`);
  const text = data.choices?.[0]?.message?.content || data.choices?.[0]?.text || "";
  return {
    ok: true,
    capability: adapter.capability,
    testedAt,
    latencyMs: Date.now() - startedAt,
    message: `连接成功，模型返回：${String(text || "OK").slice(0, 80)}`
  };
}

async function testOpenAIEmbeddingAdapter(adapter, startedAt, testedAt, prompt = "") {
  const config = adapterClientTestConfig(adapter);
  if (!config.baseURL) throw new Error("缺少 Base URL。");
  if (!config.model) throw new Error("缺少模型名称。");
  if (!config.apiKey) throw new Error(`缺少 API Key${config.envVarName ? `，请配置 ${config.envVarName} 或在页面保存 Key` : ""}。`);
  const response = await fetchWithTimeout(joinUrl(config.baseURL, "/embeddings"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      input: String(prompt || "connection test")
    })
  }, adapter.timeoutSeconds || 120);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(extractProviderError(data) || `HTTP ${response.status}`);
  return {
    ok: true,
    capability: adapter.capability,
    testedAt,
    latencyMs: Date.now() - startedAt,
    message: `连接成功，返回 ${data.data?.[0]?.embedding?.length || 0} 维向量。`
  };
}

function adapterClientTestConfig(adapter) {
  const config = adapterClientConfig(adapter);
  const envApiKey = config.envVarName ? process.env[config.envVarName] : "";
  const storedApiKey = adapter?.apiKey || "";
  const allowsNoKey = isLocalBaseUrl(config.baseURL);
  return {
    ...config,
    apiKey: storedApiKey || envApiKey || (allowsNoKey ? "local-dev-key" : "")
  };
}

function isLocalBaseUrl(baseUrl = "") {
  try {
    const url = new URL(baseUrl);
    return ["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(url.hostname);
  } catch {
    return false;
  }
}

function validateDoubaoAsrAdapter(adapter, startedAt, testedAt) {
  const config = adapterClientConfig(adapter, "DOUBAO_ASR_ACCESS_KEY");
  const missing = [];
  if (!adapter.baseUrl) missing.push("ASR 地址");
  if (!adapter.model) missing.push("资源 ID");
  if (!adapter.appKey && !config.apiKey) missing.push("App Key / API Key");
  return {
    ok: missing.length === 0,
    capability: adapter.capability,
    testedAt,
    latencyMs: Date.now() - startedAt,
    message: missing.length
      ? `豆包 ASR 配置不完整：缺少 ${missing.join("、")}。`
      : adapter.appKey && config.apiKey
        ? "豆包 ASR 配置完整，将使用旧版控制台鉴权：X-Api-App-Key + X-Api-Access-Key。真实识别会在上传音频并点击转写编译时验证。"
        : "豆包 ASR 配置完整，将使用新版控制台鉴权：X-Api-Key。真实识别会在上传音频并点击转写编译时验证。"
  };
}

async function testHttpReachability(adapter, startedAt, testedAt) {
  const response = await fetchWithTimeout(adapter.baseUrl, { method: "GET" }, Math.min(adapter.timeoutSeconds || 30, 30));
  return {
    ok: response.ok,
    capability: adapter.capability,
    testedAt,
    latencyMs: Date.now() - startedAt,
    message: response.ok ? `服务可访问，HTTP ${response.status}。` : `服务返回 HTTP ${response.status}。`
  };
}

async function fetchWithTimeout(url, options, timeoutSeconds) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(timeoutSeconds || 30, 10) * 1000);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") throw new Error("测试超时，请检查 Base URL、网络或模型服务状态。");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function joinUrl(baseUrl, suffix) {
  return `${String(baseUrl || "").replace(/\/+$/, "")}/${String(suffix || "").replace(/^\/+/, "")}`;
}

function extractProviderError(data) {
  if (!data || typeof data !== "object") return "";
  if (typeof data.error === "string") return data.error;
  if (typeof data.error?.message === "string") return data.error.message;
  if (typeof data.message === "string") return data.message;
  return "";
}

function defaultProjectSettings() {
  return {
    enableAutoWiki: true,
    enableChangeDetection: true,
    requireHumanConfirmation: true,
    exportFrontmatter: true
  };
}

function buildTrend(changes) {
  const days = new Map();
  for (let index = 6; index >= 0; index -= 1) {
    const date = new Date();
    date.setDate(date.getDate() - index);
    const key = date.toISOString().slice(5, 10);
    days.set(key, { day: key, added: 0, updated: 0, removed: 0 });
  }
  for (const change of changes) {
    const key = change.createdAt.slice(5, 10);
    if (!days.has(key)) continue;
    const row = days.get(key);
    if (change.changeType === "新增") row.added += 1;
    else if (change.changeType === "删除") row.removed += 1;
    else row.updated += 1;
  }
  return [...days.values()];
}

function applyConfirmedChange(db, change) {
  if (change.status !== "已确认") return null;
  const timestamp = nowIso();
  let requirement = change.requirementId ? db.requirements.find((item) => item.id === change.requirementId) : null;

  if (!requirement && change.changeType === "新增") {
    requirement = {
      id: makeId("req"),
      projectId: change.projectId,
      moduleName: change.moduleName,
      title: change.title,
      description: change.afterContent || change.summary,
      acceptanceCriteria: "",
      status: "已确认",
      priority: "中",
      proposer: change.proposer,
      owner: "未分配",
      sourceIds: change.sourceFileId ? [change.sourceFileId] : [],
      createdAt: timestamp,
      updatedAt: timestamp
    };
    db.requirements.push(requirement);
    change.requirementId = requirement.id;
  }

  if (requirement) {
    if (change.changeType === "删除") {
      requirement.status = "已驳回";
    } else {
      requirement.description = change.afterContent || requirement.description;
      requirement.status = "已确认";
      requirement.sourceIds = [...new Set([...(requirement.sourceIds || []), change.sourceFileId].filter(Boolean))];
    }
    requirement.updatedAt = timestamp;
    const version = db.requirementVersions.filter((item) => item.requirementId === requirement.id).length + 1;
    db.requirementVersions.push({
      id: makeId("rver"),
      requirementId: requirement.id,
      projectId: requirement.projectId,
      version,
      description: requirement.description,
      acceptanceCriteria: requirement.acceptanceCriteria,
      sourceChangeId: change.id,
      createdBy: "变更确认",
      createdAt: timestamp
    });
  }

  return requirement;
}

function countBy(items, key) {
  return items.reduce((acc, item) => {
    acc[item[key]] = (acc[item[key]] || 0) + 1;
    return acc;
  }, {});
}

function safeFileName(value) {
  return value.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim();
}

function decodeUploadFileName(value = "") {
  const name = String(value);
  if (!/[ÃÂÆçèéåäö]/.test(name)) return name;
  try {
    const decoded = Buffer.from(name, "latin1").toString("utf8");
    return decoded.includes("�") ? name : decoded;
  } catch {
    return name;
  }
}

function normalizeSpeakerCount(value) {
  const count = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(count)) return 4;
  return Math.min(10, Math.max(1, count));
}
