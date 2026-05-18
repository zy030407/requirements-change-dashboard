import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";

export const SYSTEM_ROLES = {
  ADMIN: "admin",
  TENANT_ADMIN: "tenant_admin",
  PROJECT_MANAGER: "project_manager",
  PRODUCT_MANAGER: "product_manager",
  TECH_MEMBER: "tech_member",
  CUSTOMER_OWNER: "customer_owner",
  CUSTOMER: "customer"
};

function makeId(prefix) {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function nowIso() {
  return new Date().toISOString();
}

export function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const hash = scryptSync(String(password || ""), salt, 64).toString("hex");
  return { passwordHash: hash, passwordSalt: salt };
}

export function verifyPassword(password, user) {
  if (!user?.passwordHash || !user?.passwordSalt) return false;
  const expected = Buffer.from(user.passwordHash, "hex");
  const actual = Buffer.from(hashPassword(password, user.passwordSalt).passwordHash, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function createSessionForUser(db, user) {
  if (!Array.isArray(db.sessions)) db.sessions = [];
  const token = randomBytes(32).toString("hex");
  const session = {
    id: makeId("ses"),
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 14).toISOString(),
    createdAt: nowIso()
  };
  db.sessions = db.sessions.filter((item) => item.userId !== user.id || new Date(item.expiresAt).getTime() > Date.now());
  db.sessions.push(session);
  return { token, session };
}

export function sanitizeUser(user) {
  if (!user) return null;
  const { passwordHash, passwordSalt, ...safeUser } = user;
  return safeUser;
}

export function ensureAuthData(db) {
  const timestamp = nowIso();
  if (!Array.isArray(db.users)) db.users = [];
  if (!Array.isArray(db.tenants)) db.tenants = [];
  if (!Array.isArray(db.projectMembers)) db.projectMembers = [];
  if (!Array.isArray(db.sessions)) db.sessions = [];
  if (!Array.isArray(db.changeConfirmations)) db.changeConfirmations = [];
  if (!db.tenants.some((tenant) => tenant.id === "tenant_default")) {
    db.tenants.push({
      id: "tenant_default",
      name: "默认租户",
      status: "active",
      settings: {},
      createdAt: timestamp,
      updatedAt: timestamp
    });
  }

  ensureUser(db, {
    id: "usr_admin",
    tenantId: "tenant_default",
    name: "系统管理员",
    account: "admin",
    password: "admin123",
    phone: "",
    email: "",
    role: "管理员",
    systemRole: SYSTEM_ROLES.ADMIN,
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp
  });

  for (const user of db.users) {
    user.tenantId ||= "tenant_default";
    const fallbackAccount = user.id === "usr_pm" ? "pm" : user.id === "usr_zhang" ? "customer" : slugAccount(user.name || user.id);
    const fallbackPassword = user.id === "usr_pm" ? "pm123" : user.id === "usr_zhang" ? "customer123" : "123456";
    user.account ||= fallbackAccount;
    user.phone ||= "";
    user.email ||= "";
    user.status ||= "active";
    user.createdAt ||= timestamp;
    user.updatedAt ||= timestamp;
    user.systemRole ||= inferSystemRole(user);
    if (!user.passwordHash || !user.passwordSalt) Object.assign(user, hashPassword(fallbackPassword));
  }

  for (const project of db.projects || []) {
    project.tenantId ||= "tenant_default";
    const owner = db.users.find((user) => user.id === project.ownerId);
    if (owner && owner.systemRole !== SYSTEM_ROLES.ADMIN) owner.systemRole = SYSTEM_ROLES.PROJECT_MANAGER;
    let ownerMember = db.projectMembers.find((member) => member.projectId === project.id && member.userId === project.ownerId);
    if (!ownerMember && project.ownerId) {
      ownerMember = {
        id: makeId("mem"),
        tenantId: project.tenantId || "tenant_default",
        projectId: project.id,
        userId: project.ownerId,
        role: "项目经理"
      };
      db.projectMembers.push(ownerMember);
    }
  }

  for (const member of db.projectMembers) {
    member.tenantId ||= db.projects?.find((project) => project.id === member.projectId)?.tenantId || "tenant_default";
    member.memberType ||= inferMemberType(member.role);
    member.isPrimaryManager = Boolean(member.isPrimaryManager || member.role === "项目经理");
    member.canConfirmChanges = member.canConfirmChanges ?? member.memberType === "customer";
    member.permissions ||= defaultPermissionsForMemberType(member.memberType);
  }

  const projectTenant = (projectId) => db.projects?.find((project) => project.id === projectId)?.tenantId || "tenant_default";
  for (const collectionName of [
    "sourceFiles",
    "ingestJobs",
    "transcripts",
    "wikiPages",
    "wikiPageVersions",
    "wikiLinks",
    "sourceEvidences",
    "requirements",
    "requirementVersions",
    "changes",
    "decisions",
    "risks",
    "openQuestions",
    "communications",
    "markdownExports",
    "changeConfirmations"
  ]) {
    for (const item of db[collectionName] || []) item.tenantId ||= projectTenant(item.projectId);
  }

  for (const sourceFile of db.sourceFiles || []) {
    sourceFile.storageProvider ||= "local";
    sourceFile.documentStage ||= "需求确认阶段";
    sourceFile.documentPurpose ||= "通用资料";
    sourceFile.bucket ??= null;
    sourceFile.objectKey ||= sourceFile.path || sourceFile.fileName || "";
    sourceFile.etag ||= "";
    sourceFile.contentHash ||= "";
    sourceFile.storageRegion ||= sourceFile.storageProvider === "local" ? "local" : "";
    sourceFile.previewUrlExpiresAt ??= null;
    sourceFile.note ||= "";
    sourceFile.speakerLabels ||= {};
  }

  for (const job of db.ingestJobs || []) {
    job.progress ??= job.status === "completed" ? 100 : 0;
    job.attempts ??= 0;
  }

  if (!Array.isArray(db.modelUsages)) db.modelUsages = [];
}

export function canAccessProject(user, project, db) {
  if (!user || !project) return false;
  if (user.systemRole === SYSTEM_ROLES.ADMIN) return true;
  if (user.tenantId && project.tenantId && user.tenantId !== project.tenantId) return false;
  if (user.systemRole === SYSTEM_ROLES.TENANT_ADMIN) return true;
  if (project.ownerId === user.id) return true;
  return db.projectMembers.some((member) => member.projectId === project.id && member.userId === user.id);
}

export function isCustomerForProject(user, projectId, db) {
  if (!user || user.systemRole !== SYSTEM_ROLES.CUSTOMER) return false;
  return db.projectMembers.some((member) => member.projectId === projectId && member.userId === user.id && member.memberType === "customer");
}

export function appendAuditLog(db, { projectId = null, actor, action, targetType, targetId, before = null, after = null, detail }) {
  if (!Array.isArray(db.auditLogs)) db.auditLogs = [];
  db.auditLogs.push({
    id: makeId("aud"),
    tenantId: projectId ? db.projects?.find((project) => project.id === projectId)?.tenantId || actor?.tenantId || null : actor?.tenantId || null,
    projectId,
    actorId: actor?.id || null,
    actorName: actor?.name || actor || "系统",
    actor: actor?.name || actor || "系统",
    action,
    targetType,
    targetId,
    before,
    after,
    detail,
    createdAt: nowIso()
  });
}

export function normalizeUserInput(input = {}, existing = {}) {
  const systemRole = input.systemRole || existing.systemRole || SYSTEM_ROLES.CUSTOMER;
  return {
    name: String(input.name ?? existing.name ?? "").trim() || "未命名用户",
    account: String(input.account ?? existing.account ?? "").trim() || slugAccount(input.name || existing.name || "user"),
    phone: String(input.phone ?? existing.phone ?? "").trim(),
    email: String(input.email ?? existing.email ?? "").trim(),
    role: input.role || input.userRole || roleLabel(systemRole),
    systemRole,
    status: input.status || existing.status || "active"
  };
}

export function roleLabel(systemRole) {
  if (systemRole === SYSTEM_ROLES.ADMIN) return "管理员";
  if (systemRole === SYSTEM_ROLES.TENANT_ADMIN) return "租户管理员";
  if (systemRole === SYSTEM_ROLES.PROJECT_MANAGER) return "项目经理";
  if (systemRole === SYSTEM_ROLES.PRODUCT_MANAGER) return "产品经理";
  if (systemRole === SYSTEM_ROLES.TECH_MEMBER) return "技术成员";
  if (systemRole === SYSTEM_ROLES.CUSTOMER_OWNER) return "客户负责人";
  return "客户";
}

export function inferMemberType(role = "") {
  if (role.includes("经理")) return "manager";
  if (role.includes("客户")) return "customer";
  return "tech";
}

export function defaultPermissionsForMemberType(memberType) {
  if (memberType === "manager") return ["管理项目", "管理成员", "确认变更", "导出报告"];
  if (memberType === "customer") return ["查看项目", "确认需求", "查看文档"];
  return ["查看已确认需求", "评论", "查看文档"];
}

function ensureUser(db, user) {
  if (db.users.some((item) => item.id === user.id || item.account === user.account)) return;
  const { password, ...rest } = user;
  db.users.push({ tenantId: "tenant_default", ...rest, ...hashPassword(password) });
}

function inferSystemRole(user) {
  if (user.role?.includes("管理员")) return SYSTEM_ROLES.ADMIN;
  if (user.role?.includes("项目经理") || user.role?.includes("产品经理") || user.id === "usr_pm") return SYSTEM_ROLES.PROJECT_MANAGER;
  return SYSTEM_ROLES.CUSTOMER;
}

function slugAccount(value) {
  return String(value || "user")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 24) || `user${Math.random().toString(36).slice(2, 8)}`;
}
