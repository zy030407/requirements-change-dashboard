import React, { useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import {
  AlertTriangle,
  Bell,
  BookOpen,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ClipboardList,
  Cpu,
  Database,
  Download,
  Eye,
  FileAudio,
  FileStack,
  FileText,
  GitBranch,
  LayoutDashboard,
  ListChecks,
  Loader2,
  MessageSquareText,
  MessagesSquare,
  PencilLine,
  Plus,
  Search,
  Settings,
  Sparkles,
  Upload,
  UserRound,
  Users,
  X
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import { renderRicoMarkdown } from "./ricoMarkdown.js";

const API_BASE = window.location.protocol === "file:" ? "http://127.0.0.1:4000/api" : "/api";
const AUTH_TOKEN_KEY = "requirements_dashboard_token";

const sidebarGroups = [
  {
    type: "single",
    label: "项目概览",
    icon: LayoutDashboard,
    view: "overview"
  },
  {
    label: "需求管理",
    icon: ClipboardList,
    children: [
      { label: "需求池", view: "requirementPool" },
      { label: "需求建议", view: "requirementSuggestions" },
      { label: "需求变更", view: "changes" }
    ]
  },
  {
    label: "沟通管理",
    icon: MessagesSquare,
    children: [{ label: "沟通记录", view: "communications" }]
  },
  {
    label: "资料管理",
    icon: FileStack,
    children: [{ label: "资料库", view: "documents" }]
  },
  {
    label: "项目管理",
    icon: ListChecks,
    children: [
      { label: "项目 Wiki", view: "wiki" },
      { label: "里程碑", view: "milestones" }
    ]
  },
  {
    type: "single",
    label: "设置",
    icon: Settings,
    view: "settings"
  }
];

const statusColors = {
  待确认: "#2563eb",
  已确认: "#5b7cfa",
  已驳回: "#ef4444",
  设计中: "#f97316",
  开发中: "#16a34a",
  已完成: "#64748b"
};

const defaultNavByView = {
  overview: "项目概览",
  wiki: "项目 Wiki",
  ingest: "资料库",
  requirementList: "需求池",
  requirementPool: "需求池",
  requirementSuggestions: "需求建议",
  changes: "需求变更",
  communications: "沟通记录",
  meetingRecords: "沟通记录",
  documents: "资料库",
  materials: "资料库",
  milestones: "里程碑",
  tasks: "项目概览",
  members: "设置",
  settings: "设置"
};

const mergedViewAliases = {
  requirementList: "requirementPool",
  ingest: "documents",
  materials: "documents",
  meetingRecords: "communications",
  tasks: "overview",
  members: "settings"
};

const defaultSettingsForm = {
  name: "",
  customerName: "",
  stage: "需求沟通阶段",
  expectedEndDate: "",
  enableAutoWiki: true,
  enableChangeDetection: true,
  requireHumanConfirmation: true,
  exportFrontmatter: true
};

const defaultModelForm = {
  name: "OpenAI 兼容大模型",
  provider: "openai-compatible",
  capability: "LLM",
  protocol: "responses",
  model: "",
  baseUrl: "",
  appKey: "",
  apiKey: "",
  envVarName: "",
  status: "active",
  description: "",
  timeoutSeconds: 120
};

const defaultRequirementForm = {
  moduleName: "项目范围",
  title: "",
  description: "",
  acceptanceCriteria: "",
  status: "待确认",
  priority: "中",
  proposer: "",
  owner: ""
};

const defaultUploadMetadata = {
  documentStage: "需求确认阶段",
  documentPurpose: "需求确认文件"
};

const documentStageOptions = ["需求确认阶段", "开发阶段", "测试阶段", "上线阶段"];
const documentPurposeOptions = ["需求确认文件", "需求变更文件", "合同文件", "会议纪要", "通用资料"];
const processedSuggestionStatuses = new Set(["已采纳", "已放弃"]);

function homePathForUser(user) {
  if (user?.systemRole === "admin") return "/setting";
  if (user?.systemRole === "customer") return "/customer";
  return "/";
}

function App() {
  const [authUser, setAuthUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [pathname, setPathname] = useState(window.location.pathname);

  useEffect(() => {
    const syncPathname = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", syncPathname);
    return () => window.removeEventListener("popstate", syncPathname);
  }, []);

  useEffect(() => {
    let active = true;
    const token = getAuthToken();
    if (!token) {
      setAuthUser(null);
      setAuthLoading(false);
      if (pathname !== "/login") navigateTo("/login", { replace: true });
      return;
    }
    setAuthLoading(true);
    apiGet("/auth/me")
      .then((data) => {
        if (!active) return;
        setAuthUser(data.user);
        if (pathname === "/login") navigateTo(homePathForUser(data.user), { replace: true });
      })
      .catch(() => {
        if (!active) return;
        clearAuthToken();
        setAuthUser(null);
        if (pathname !== "/login") navigateTo("/login", { replace: true });
      })
      .finally(() => {
        if (active) setAuthLoading(false);
      });
    return () => {
      active = false;
    };
  }, [pathname]);

  function navigateTo(path, options = {}) {
    const method = options.replace ? "replaceState" : "pushState";
    if (window.location.pathname !== path) window.history[method]({}, "", path);
    setPathname(path);
  }

  async function handleLogin(credentials) {
    const data = await apiPost("/auth/login", credentials);
    setAuthToken(data.token);
    setAuthUser(data.user);
    navigateTo(homePathForUser(data.user), { replace: true });
  }

  async function handleLogout() {
    await apiPost("/auth/logout", {}).catch(() => {});
    clearAuthToken();
    setAuthUser(null);
    navigateTo("/login", { replace: true });
  }

  if (authLoading) return <LoadingState />;
  if (pathname === "/login") return <LoginPage onLogin={handleLogin} />;
  if (!authUser) return <LoginPage onLogin={handleLogin} />;
  const isSystemSettingsRoute = ["/setting", "/settings"].includes(pathname);
  if (isSystemSettingsRoute) {
    if (authUser.systemRole !== "admin") return <ForbiddenPage user={authUser} onLogout={handleLogout} />;
    return <SystemSettingsApp user={authUser} onLogout={handleLogout} />;
  }
  if (pathname === "/customer" && authUser.systemRole !== "customer") return <ForbiddenPage user={authUser} onLogout={handleLogout} />;
  if (authUser.systemRole === "customer") return <CustomerPortalApp user={authUser} onLogout={handleLogout} />;
  return <ProjectApp user={authUser} onLogout={handleLogout} />;
}

function LoginPage({ onLogin }) {
  const [form, setForm] = useState({ account: "pm", password: "pm123" });
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await onLogin(form);
    } catch (err) {
      setError(err.message || "登录失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-card">
        <div className="brand login-brand">
          <span className="brand-mark"><Sparkles size={22} /></span>
          <span>
            <strong>木铎知会</strong>
            <small>组织沟通与知识沉淀平台</small>
          </span>
        </div>
        <form className="login-form" onSubmit={submit}>
          <h1>登录工作台</h1>
          <p>管理员、项目经理和客户使用各自账号进入对应页面。</p>
          {error ? <div className="error-banner">{error}</div> : null}
          <label>
            登录账号
            <input value={form.account} onChange={(event) => setForm({ ...form, account: event.target.value })} autoFocus />
          </label>
          <label>
            密码
            <input type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} />
          </label>
          <button className="primary-action" type="submit" disabled={submitting}>
            {submitting ? <Loader2 className="spin" size={16} /> : <UserRound size={16} />}
            登录
          </button>
          <div className="login-demo">
            <span>默认账号：admin/admin123</span>
            <span>项目经理：pm/pm123</span>
            <span>客户：customer/customer123</span>
          </div>
        </form>
      </section>
    </main>
  );
}

function ForbiddenPage({ user, onLogout }) {
  return (
    <main className="login-page">
      <section className="login-card">
        <h1>无权访问</h1>
        <p>{user?.name} 当前角色不能访问该页面。</p>
        <div className="modal-actions">
          <a className="secondary-action" href={user?.systemRole === "customer" ? "/customer" : "/"}>返回工作台</a>
          <button className="primary-action" type="button" onClick={onLogout}>退出登录</button>
        </div>
      </section>
    </main>
  );
}

function SystemSettingsApp({ user, onLogout }) {
  const [activeAdminView, setActiveAdminView] = useState("models");
  const [modelRegistry, setModelRegistry] = useState({ capabilities: [], pipeline: {}, adapters: [] });
  const [adminProjects, setAdminProjects] = useState([]);
  const [adminUsers, setAdminUsers] = useState([]);
  const [auditLogs, setAuditLogs] = useState([]);
  const [selectedAdminProjectId, setSelectedAdminProjectId] = useState("");
  const [adminProjectForm, setAdminProjectForm] = useState({ name: "", customerName: "", stage: "需求沟通阶段", ownerId: "", expectedEndDate: "" });
  const [adminUserForm, setAdminUserForm] = useState({ name: "", account: "", phone: "", email: "", systemRole: "customer", password: "123456", status: "active" });
  const [modelForm, setModelForm] = useState(defaultModelForm);
  const [modelTestResults, setModelTestResults] = useState({});
  const [testingModelId, setTestingModelId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    loadModelRegistry();
    loadAdminData();
  }, []);

  async function loadAdminData() {
    const [projectData, userData, logData] = await Promise.all([
      apiGet("/admin/projects"),
      apiGet("/admin/users"),
      apiGet("/admin/audit-logs")
    ]);
    setAdminProjects(projectData.projects);
    setAdminUsers(userData.users);
    setAuditLogs(logData.logs);
    setSelectedAdminProjectId((current) => current || projectData.projects[0]?.id || "");
  }

  async function loadModelRegistry() {
    setLoading(true);
    setError("");
    try {
      setModelRegistry(await apiGet("/admin/model-adapters"));
    } catch (err) {
      setError("模型后台服务未连接。请确认 API 服务正在运行。");
    } finally {
      setLoading(false);
    }
  }

  function updateModelForm(nextForm) {
    if (nextForm.capability !== modelForm.capability) {
      setModelForm({ ...modelDefaultsForCapability(nextForm.capability), capability: nextForm.capability });
      return;
    }
    setModelForm(nextForm);
  }

  async function createModelAdapter(event) {
    event.preventDefault();
    if (!modelForm.name.trim()) {
      setError("请填写模型名称。");
      return;
    }
    setError("");
    try {
      await apiPost("/admin/model-adapters", {
        ...modelForm,
        timeoutSeconds: Number(modelForm.timeoutSeconds) || 120
      });
      await loadModelRegistry();
      setModelForm(defaultModelForm);
    } catch (err) {
      setError(err.message || "新增模型适配器失败");
    }
  }

  async function createModelAdapterFromPayload(payload) {
    setError("");
    try {
      const result = await apiPost("/admin/model-adapters", {
        ...payload,
        timeoutSeconds: Number(payload.timeoutSeconds) || 120
      });
      await loadModelRegistry();
      return result.adapter;
    } catch (err) {
      setError(err.message || "新增模型适配器失败");
      throw err;
    }
  }

  async function updateModelAdapter(adapterId, patch) {
    setError("");
    try {
      const adapter = modelRegistry.adapters.find((item) => item.id === adapterId);
      await apiPatch(`/admin/model-adapters/${adapterId}`, { ...adapter, ...patch });
      await loadModelRegistry();
    } catch (err) {
      setError(err.message || "更新模型适配器失败");
    }
  }

  async function saveModelConfig(adapterId, patch) {
    setError("");
    try {
      const adapter = modelRegistry.adapters.find((item) => item.id === adapterId);
      if (!adapter) {
        setError("未找到默认模型配置。");
        return;
      }
      await apiPatch(`/admin/model-adapters/${adapterId}`, { ...adapter, ...patch });
      await loadModelRegistry();
    } catch (err) {
      setError(err.message || "保存模型配置失败");
    }
  }

  async function updateModelPipeline(capability, adapterId) {
    setError("");
    try {
      const nextPipeline = { ...(modelRegistry.pipeline || {}), [capability]: adapterId };
      const result = await apiPatch("/admin/model-pipeline", { pipeline: nextPipeline });
      setModelRegistry((current) => ({ ...current, pipeline: result.pipeline }));
    } catch (err) {
      setError(err.message || "更新模型管线失败");
    }
  }

  async function testModelAdapter(adapterId, prompt = "") {
    setError("");
    setTestingModelId(adapterId);
    setModelTestResults((current) => ({
      ...current,
      [adapterId]: { ok: null, message: "正在测试模型连接...", latencyMs: 0, testedAt: new Date().toISOString() }
    }));
    try {
      const result = await apiPost(`/admin/model-adapters/${adapterId}/test`, { prompt });
      setModelTestResults((current) => ({ ...current, [adapterId]: result.result }));
      await loadModelRegistry();
    } catch (err) {
      setModelTestResults((current) => ({
        ...current,
        [adapterId]: {
          ok: false,
          message: err.message || "模型测试失败",
          latencyMs: 0,
          testedAt: new Date().toISOString()
        }
      }));
    } finally {
      setTestingModelId("");
    }
  }

  async function createAdminProject(event) {
    event.preventDefault();
    const ownerId = adminProjectForm.ownerId || adminUsers.find((item) => item.systemRole === "project_manager")?.id;
    await apiPost("/admin/projects", { ...adminProjectForm, ownerId });
    setAdminProjectForm({ name: "", customerName: "", stage: "需求沟通阶段", ownerId: "", expectedEndDate: "" });
    await loadAdminData();
  }

  async function updateAdminProject(projectId, payload) {
    await apiPatch(`/admin/projects/${projectId}`, payload);
    await loadAdminData();
  }

  async function deleteAdminProject(projectId) {
    await apiDelete(`/admin/projects/${projectId}`);
    setSelectedAdminProjectId("");
    await loadAdminData();
  }

  async function createAdminUser(event) {
    event.preventDefault();
    await apiPost("/admin/users", adminUserForm);
    setAdminUserForm({ name: "", account: "", phone: "", email: "", systemRole: "customer", password: "123456", status: "active" });
    await loadAdminData();
  }

  async function attachUserToProject(userId, memberType = "customer") {
    if (!selectedAdminProjectId) return;
    const selectedUser = adminUsers.find((item) => item.id === userId);
    await apiPost(`/admin/projects/${selectedAdminProjectId}/users`, {
      userId,
      memberType,
      projectRole: memberType === "manager" ? "项目经理" : memberType === "customer" ? "客户成员" : "技术组员",
      isPrimaryManager: false,
      canConfirmChanges: memberType === "customer"
    });
    await loadAdminData();
    if (selectedUser?.systemRole !== (memberType === "customer" ? "customer" : "project_manager")) {
      await apiPatch(`/admin/users/${userId}`, { ...selectedUser, systemRole: memberType === "customer" ? "customer" : "project_manager" });
      await loadAdminData();
    }
  }

  return (
    <div className="system-settings-page">
      <aside className="system-settings-sidebar">
        <a className="system-brand" href="/">
          <span className="brand-mark"><Sparkles size={21} /></span>
          <strong>木铎知会</strong>
        </a>
        <nav className="system-settings-nav" aria-label="系统设置导航">
          <button className={activeAdminView === "models" ? "active" : ""} type="button" onClick={() => setActiveAdminView("models")}>
            <Cpu size={17} />
            模型配置
          </button>
          <button className={activeAdminView === "projects" ? "active" : ""} type="button" onClick={() => setActiveAdminView("projects")}>
            <LayoutDashboard size={17} />
            项目管理
          </button>
          <button className={activeAdminView === "users" ? "active" : ""} type="button" onClick={() => setActiveAdminView("users")}>
            <Users size={17} />
            用户管理
          </button>
          <button className={activeAdminView === "logs" ? "active" : ""} type="button" onClick={() => setActiveAdminView("logs")}>
            <FileText size={17} />
            操作记录
          </button>
        </nav>
      </aside>

      <main className="system-settings-main">
        <header className="system-settings-header">
          <div>
            <h1>系统设置</h1>
            <span>模型、项目与用户管理</span>
          </div>
          <div className="top-actions">
            <span className="session-user">{user.name}</span>
            <button className="secondary-action" type="button" onClick={onLogout}>退出登录</button>
          </div>
        </header>
        <section className="content system-settings-content">
          {error && <div className="error-banner">{error}</div>}
          {loading ? (
            <LoadingState />
          ) : activeAdminView === "models" ? (
            <ModelsView
              registry={modelRegistry}
              form={modelForm}
              onFormChange={updateModelForm}
              onSubmit={createModelAdapter}
              onCreateAdapter={createModelAdapterFromPayload}
              onAdapterStatus={updateModelAdapter}
              onAdapterConfig={saveModelConfig}
              onPipelineChange={updateModelPipeline}
              onAdapterTest={testModelAdapter}
              testResults={modelTestResults}
              testingAdapterId={testingModelId}
            />
          ) : activeAdminView === "projects" ? (
            <AdminProjectsView
              projects={adminProjects}
              users={adminUsers}
              selectedProjectId={selectedAdminProjectId}
              onSelectProject={setSelectedAdminProjectId}
              form={adminProjectForm}
              onFormChange={setAdminProjectForm}
              onSubmit={createAdminProject}
              onUpdateProject={updateAdminProject}
              onDeleteProject={deleteAdminProject}
              onAttachUser={attachUserToProject}
            />
          ) : activeAdminView === "users" ? (
            <AdminUsersView users={adminUsers} form={adminUserForm} onFormChange={setAdminUserForm} onSubmit={createAdminUser} onRefresh={loadAdminData} />
          ) : (
            <AdminAuditLogsView logs={auditLogs} />
          )}
        </section>
      </main>
    </div>
  );
}

function CustomerPortalApp({ user, onLogout }) {
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState("");
  const [portal, setPortal] = useState(null);
  const [selectedWikiPage, setSelectedWikiPage] = useState(null);
  const [sourcePreview, setSourcePreview] = useState(null);
  const [sourcePreviewLoading, setSourcePreviewLoading] = useState(false);
  const [activeView, setActiveView] = useState("confirm");
  const [confirmAction, setConfirmAction] = useState(null);
  const [comment, setComment] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    loadCustomerProjects();
  }, []);

  useEffect(() => {
    if (projectId) loadPortal(projectId);
  }, [projectId]);

  async function loadCustomerProjects() {
    setLoading(true);
    try {
      const data = await apiGet("/customer/projects");
      setProjects(data.projects);
      setProjectId(data.projects[0]?.id || "");
    } catch (err) {
      setError(err.message || "客户项目加载失败");
    } finally {
      setLoading(false);
    }
  }

  async function loadPortal(id = projectId) {
    if (!id) return;
    const data = await apiGet(`/customer/projects/${id}/portal`);
    setPortal(data);
    setSelectedWikiPage(data.wikiPages?.[0] || null);
  }

  async function openSourcePreview(sourceFileId) {
    setSourcePreviewLoading(true);
    setError("");
    try {
      const data = await apiGet(`/source-files/${sourceFileId}/preview`);
      setSourcePreview(data);
    } catch (err) {
      setError(err.message || "资料预览失败");
    } finally {
      setSourcePreviewLoading(false);
    }
  }

  async function submitCustomerDecision() {
    if (!confirmAction) return;
    const path = confirmAction.type === "confirm" ? `/customer/changes/${confirmAction.change.id}/confirm` : `/customer/changes/${confirmAction.change.id}/reject`;
    await apiPost(path, { comment });
    setConfirmAction(null);
    setComment("");
    await loadPortal();
  }

  const pending = (portal?.changes || []).filter((item) => item.status === "需客户确认");

  return (
    <div className="customer-page">
      <aside className="customer-sidebar">
        <div className="brand">
          <span className="brand-mark"><Sparkles size={21} /></span>
          <span><strong>木铎知会</strong><small>客户协作门户 · {user.name}</small></span>
        </div>
        <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
        <button className={activeView === "confirm" ? "active" : ""} type="button" onClick={() => setActiveView("confirm")}>待我确认</button>
        <button className={activeView === "requirements" ? "active" : ""} type="button" onClick={() => setActiveView("requirements")}>需求池</button>
        <button className={activeView === "wiki" ? "active" : ""} type="button" onClick={() => setActiveView("wiki")}>项目 Wiki</button>
        <button className={activeView === "documents" ? "active" : ""} type="button" onClick={() => setActiveView("documents")}>资料库</button>
        <button type="button" onClick={onLogout}>退出登录</button>
      </aside>
      <main className="customer-main">
        <header className="topbar">
          <div className="project-heading"><h1>{portal?.project?.name || "客户门户"}</h1><span>{portal?.project?.stage || "需求确认"}</span></div>
          <strong>{pending.length} 条待客户确认</strong>
        </header>
        <section className="content">
          {error ? <div className="error-banner">{error}</div> : null}
          {loading ? <LoadingState /> : null}
          {!loading && activeView === "confirm" && (
            <section className="panel">
              <PanelHeader title="待我确认的需求变更" />
              <div className="change-page-list">
                {pending.length ? pending.map((change) => (
                  <article className="change-page-card" key={change.id}>
                    <div className="change-card-head"><span className={`type-tag ${typeClass(change.changeType)}`}>{change.changeType}</span><strong>{change.moduleName} - {change.title}</strong></div>
                    <p>{change.summary}</p>
                    <div className="diff-grid"><div><small>变更前</small><span>{change.beforeContent || "无"}</span></div><div><small>变更后</small><span>{change.afterContent || "无"}</span></div></div>
                    <div className="change-card-actions">
                      <button type="button" onClick={() => setConfirmAction({ type: "confirm", change })}><Check size={15} /> 确认通过</button>
                      <button type="button" onClick={() => setConfirmAction({ type: "reject", change })}><X size={15} /> 退回修改</button>
                    </div>
                  </article>
                )) : <EmptyState icon={CheckCircle2} title="暂无待确认变更" text="项目经理标记为需客户确认后，会出现在这里。" />}
              </div>
            </section>
          )}
          {!loading && activeView === "requirements" && <RequirementsView requirements={portal?.requirements || []} />}
          {!loading && activeView === "wiki" && (
            <WikiView
              pages={portal?.wikiPages || []}
              selectedPage={selectedWikiPage}
              onSelectPage={setSelectedWikiPage}
              changes={portal?.changes || []}
              sourceFiles={portal?.sourceFiles || []}
              onPreviewSource={openSourcePreview}
            />
          )}
          {!loading && activeView === "documents" && (
            <MaterialsView
              sourceFiles={portal?.sourceFiles || []}
              onPreview={openSourcePreview}
            />
          )}
        </section>
      </main>
      {confirmAction && (
        <div className="modal-backdrop" role="presentation">
          <section className="project-modal" role="dialog" aria-modal="true">
            <div className="modal-header"><h2>{confirmAction.type === "confirm" ? "确认通过变更？" : "退回该变更？"}</h2><button className="modal-close" type="button" onClick={() => setConfirmAction(null)}><X size={18} /></button></div>
            <div className="project-form">
              <p>{confirmAction.change.moduleName} - {confirmAction.change.title}</p>
              <label>确认意见<textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="可填写确认意见、退回原因或补充说明" /></label>
              <div className="modal-actions"><button className="secondary-action" type="button" onClick={() => setConfirmAction(null)}>取消</button><button className="primary-action" type="button" onClick={submitCustomerDecision}>确认</button></div>
            </div>
          </section>
        </div>
      )}
      {(sourcePreview || sourcePreviewLoading) && (
        <SourcePreviewModal
          preview={sourcePreview}
          loading={sourcePreviewLoading}
          onClose={() => setSourcePreview(null)}
        />
      )}
    </div>
  );
}

function ProjectApp({ user, onLogout }) {
  const [activeView, setActiveView] = useState("overview");
  const [activeNavLabel, setActiveNavLabel] = useState("项目概览");
  const [collapsedNavGroups, setCollapsedNavGroups] = useState({});
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState("");
  const [dashboard, setDashboard] = useState(null);
  const [wikiPages, setWikiPages] = useState([]);
  const [selectedWikiPage, setSelectedWikiPage] = useState(null);
  const [requirements, setRequirements] = useState([]);
  const [requirementSuggestions, setRequirementSuggestions] = useState([]);
  const [suggestionStatus, setSuggestionStatus] = useState("");
  const [suggestionGenerating, setSuggestionGenerating] = useState(false);
  const [changes, setChanges] = useState([]);
  const [sourceFiles, setSourceFiles] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [members, setMembers] = useState([]);
  const [query, setQuery] = useState("");
  const [uploadFiles, setUploadFiles] = useState([]);
  const [uploadMetadata, setUploadMetadata] = useState(defaultUploadMetadata);
  const [uploadSpeakerCount, setUploadSpeakerCount] = useState(4);
  const [uploadStatus, setUploadStatus] = useState("");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [ingestProgressBySource, setIngestProgressBySource] = useState({});
  const [batchCompileStatus, setBatchCompileStatus] = useState("");
  const [batchCompiling, setBatchCompiling] = useState(false);
  const [savingSourceNoteId, setSavingSourceNoteId] = useState("");
  const [sourceEditor, setSourceEditor] = useState(null);
  const [sourcePreview, setSourcePreview] = useState(null);
  const [sourcePreviewLoading, setSourcePreviewLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [exportPath, setExportPath] = useState("");
  const [changeStatusConfirm, setChangeStatusConfirm] = useState(null);
  const [changeStatusSubmitting, setChangeStatusSubmitting] = useState(false);
  const [memberForm, setMemberForm] = useState({
    name: "",
    account: "",
    phone: "",
    password: "123456",
    projectRole: "客户成员",
    userRole: "业务代表"
  });
  const [settingsForm, setSettingsForm] = useState(defaultSettingsForm);
  const [showProjectForm, setShowProjectForm] = useState(false);
  const [showRequirementForm, setShowRequirementForm] = useState(false);
  const [projectForm, setProjectForm] = useState({
    name: "",
    customerName: "",
    stage: "需求沟通阶段",
    expectedEndDate: ""
  });
  const [requirementForm, setRequirementForm] = useState(defaultRequirementForm);
  const [requirementDraftSourceSuggestionId, setRequirementDraftSourceSuggestionId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const project = useMemo(() => projects.find((item) => item.id === projectId), [projects, projectId]);

  useEffect(() => {
    loadProjects();
  }, []);

  useEffect(() => {
    if (!projectId) return;
    refreshProjectData(projectId);
  }, [projectId]);

  useEffect(() => {
    if (project) setSettingsForm(projectToSettingsForm(project));
  }, [project?.id]);

  async function loadProjects() {
    setLoading(true);
    setError("");
    try {
      const data = await apiGet("/projects");
      setProjects(data.projects);
      setProjectId(data.projects[0]?.id || "");
    } catch (err) {
      setError("后端服务未连接。请运行 npm run dev 启动 API 和前端。");
    } finally {
      setLoading(false);
    }
  }

  async function refreshProjectData(nextProjectId = projectId) {
    if (!nextProjectId) return;
    const [dashboardData, wikiData, requirementData, suggestionData, changeData, sourceData, taskData, memberData] = await Promise.all([
      apiGet(`/projects/${nextProjectId}/dashboard`),
      apiGet(`/projects/${nextProjectId}/wiki`),
      apiGet(`/projects/${nextProjectId}/requirements`),
      apiGet(`/projects/${nextProjectId}/requirement-suggestions`),
      apiGet(`/projects/${nextProjectId}/changes`),
      apiGet(`/projects/${nextProjectId}/source-files`),
      apiGet(`/projects/${nextProjectId}/tasks`),
      apiGet(`/projects/${nextProjectId}/members`)
    ]);
    setDashboard(dashboardData);
    setWikiPages(wikiData.pages);
    setRequirements(requirementData.requirements);
    setRequirementSuggestions(suggestionData.suggestions || []);
    setSuggestionStatus(suggestionData.stale ? "当前显示的是基于 Wiki 编译结果的实时草案，点击刷新预测可调用大模型生成正式建议。" : "");
    setChanges(changeData.changes);
    setSourceFiles(sourceData.sourceFiles);
    setTasks(taskData.tasks);
    setMembers(memberData.members);
    setSelectedWikiPage((current) => selectPreferredWikiPage(wikiData.pages, current));
  }

  async function handleUploadAndIngest(event) {
    event.preventDefault();
    if (!uploadFiles.length || !projectId) return;
    setUploadStatus("正在上传资料...");
    setUploadProgress(0);
    setError("");
    try {
      const uploadResult = await uploadSourceFiles({
        projectId,
        files: uploadFiles,
        metadata: uploadMetadata,
        speakerCount: uploadSpeakerCount,
        onProgress: setUploadProgress,
        onStatus: setUploadStatus
      });
      const count = uploadResult.sourceFiles?.length || 0;
      setUploadStatus(`上传完成：${count} 个文件已进入资料库。需要转写或编译时，请在资料列表点击对应按钮。`);
      setUploadFiles([]);
      setUploadMetadata(defaultUploadMetadata);
      setUploadSpeakerCount(4);
      setUploadProgress(100);
      await refreshProjectData();
      navigate("documents");
    } catch (err) {
      setUploadStatus("");
      setUploadProgress(0);
      setError(err.message || "资料导入失败");
    }
  }

  function requestChangeStatusUpdate(changeId, status) {
    const change = changes.find((item) => item.id === changeId) || dashboard?.pendingChanges?.find((item) => item.id === changeId);
    setChangeStatusConfirm({
      mode: "change",
      changeId,
      status,
      title: change?.title || "该需求变更",
      moduleName: change?.moduleName || "需求变更",
      summary: change?.summary || "",
      currentStatus: change?.status || "待确认"
    });
  }

  function requestTaskStatusUpdate(task, status) {
    if (task.entityType === "change") {
      setChangeStatusConfirm({
        mode: "task",
        task,
        status,
        title: task.title || "该需求变更",
        moduleName: task.moduleName || "需求变更",
        summary: task.summary || "",
        currentStatus: task.status || "待确认"
      });
      return;
    }
    updateTaskStatus(task, status);
  }

  async function updateTaskStatus(task, status) {
    await apiPatch(`/tasks/${task.entityType}/${task.entityId}/status`, { status });
    await refreshProjectData();
  }

  async function confirmChangeStatusUpdate() {
    if (!changeStatusConfirm || changeStatusSubmitting) return;
    setChangeStatusSubmitting(true);
    setError("");
    try {
      if (changeStatusConfirm.mode === "task") {
        const task = changeStatusConfirm.task;
        await apiPatch(`/tasks/${task.entityType}/${task.entityId}/status`, { status: changeStatusConfirm.status });
      } else {
        await apiPatch(`/changes/${changeStatusConfirm.changeId}/status`, { status: changeStatusConfirm.status });
      }
      setNotice(changeStatusNotice(changeStatusConfirm.status));
      setChangeStatusConfirm(null);
      await refreshProjectData();
    } catch (err) {
      setError(err.message || "变更状态更新失败");
    } finally {
      setChangeStatusSubmitting(false);
    }
  }

  async function reingestSourceFile(sourceFileId) {
    setError("");
    setIngestProgressBySource((current) => ({
      ...current,
      [sourceFileId]: { status: "processing", step: "queued", message: "任务已提交，等待处理..." }
    }));
    try {
      const result = await apiPost(`/source-files/${sourceFileId}/ingest`, {});
      await refreshProjectData();
      navigate("documents");
      await pollIngestJob(result.job.id, sourceFileId);
    } catch (err) {
      setError(err.message || "重新编译失败");
      setIngestProgressBySource((current) => ({
        ...current,
        [sourceFileId]: { status: "failed", step: "failed", message: err.message || "处理失败" }
      }));
      await refreshProjectData();
    }
  }

  async function compileNewSourceFiles() {
    if (batchCompiling) return;
    const pendingSources = sourceFiles
      .filter((source) => shouldCompileSource(source))
      .sort(compareSourceFileByDocumentDateAsc);
    if (!pendingSources.length) {
      setNotice("没有新增待编译资料。已编译资料不会重复编译。");
      return;
    }
    setBatchCompiling(true);
    setBatchCompileStatus(`准备按文件名时间顺序编译 ${pendingSources.length} 个新增资料...`);
    setError("");
    try {
      for (let index = 0; index < pendingSources.length; index += 1) {
        const source = pendingSources[index];
        setBatchCompileStatus(`正在编译 ${index + 1}/${pendingSources.length}：${source.title || source.originalName}`);
        await reingestSourceFile(source.id);
      }
      setBatchCompileStatus(`一键编译完成：已处理 ${pendingSources.length} 个新增资料。`);
      await refreshProjectData();
    } finally {
      setBatchCompiling(false);
    }
  }

  async function pollIngestJob(jobId, sourceFileId) {
    for (let attempt = 0; attempt < 240; attempt += 1) {
      const { job } = await apiGet(`/ingest-jobs/${jobId}`);
      setIngestProgressBySource((current) => ({
        ...current,
        [sourceFileId]: {
          status: job.status,
          step: job.step,
          message: ingestStepMessage(job)
        }
      }));
      await refreshProjectData();
      if (job.status === "completed") {
        setTimeout(() => {
          setIngestProgressBySource((current) => {
            const next = { ...current };
            delete next[sourceFileId];
            return next;
          });
        }, 1800);
        return;
      }
      if (job.status === "failed") {
        setError(job.error || "处理失败");
        return;
      }
      await wait(1500);
    }
    setError("处理任务仍在后台运行，请稍后刷新资料库查看结果。");
  }

  async function openSourcePreview(sourceFileId) {
    setSourcePreviewLoading(true);
    setError("");
    try {
      const data = await apiGet(`/source-files/${sourceFileId}/preview`);
      setSourcePreview(data);
    } catch (err) {
      setError(err.message || "资料预览失败");
    } finally {
      setSourcePreviewLoading(false);
    }
  }

  function openSourceEditor(source, mode = "note") {
    setSourceEditor({
      mode,
      id: source.id,
      title: source.title || source.originalName || "",
      originalName: source.originalName || source.title || "",
      category: source.category || "",
      documentStage: source.documentStage || "需求确认阶段",
      documentPurpose: source.documentPurpose || "通用资料",
      speakerCount: source.speakerCount || 0,
      speakerLabels: normalizeSpeakerLabels(source.speakerLabels || {}),
      detectedSpeakers: detectSpeakerLabels(source),
      note: source.note || ""
    });
  }

  function updateSourceEditor(patch) {
    setSourceEditor((current) => (current ? { ...current, ...patch } : current));
  }

  async function saveSourceEditor(event) {
    event.preventDefault();
    if (!sourceEditor?.id) return;
    setSavingSourceNoteId(sourceEditor.id);
    setError("");
    try {
      const result = await apiPatch(`/source-files/${sourceEditor.id}`, {
        title: sourceEditor.title,
        note: sourceEditor.note,
        documentStage: sourceEditor.documentStage,
        documentPurpose: sourceEditor.documentPurpose,
        speakerLabels: sourceEditor.speakerLabels || {}
      });
      setSourceFiles((current) => current.map((source) => (source.id === sourceEditor.id ? result.sourceFile : source)));
      setSourcePreview((current) =>
        current?.sourceFile?.id === sourceEditor.id ? { ...current, sourceFile: result.sourceFile } : current
      );
      setNotice(sourceEditor.mode === "note" ? "资料备注已保存，下一次编译会作为 LLM 编译提示使用。" : "资料信息已保存。");
      setSourceEditor(null);
    } catch (err) {
      setError(err.message || "保存资料信息失败");
    } finally {
      setSavingSourceNoteId("");
    }
  }

  async function exportMarkdown() {
    setExportPath("");
    setNotice("");
    const result = await apiPost(`/projects/${projectId}/wiki/export-markdown`, {});
    setExportPath(result.export.path);
    setNotice(`报告已导出：${result.export.path}`);
    await refreshProjectData();
  }

  async function searchProject(value) {
    setQuery(value);
    if (!value.trim() || !projectId) {
      await refreshProjectData();
      return;
    }
    const result = await apiGet(`/projects/${projectId}/search?q=${encodeURIComponent(value)}`);
    setWikiPages(result.wikiPages);
    setRequirements(result.requirements);
    setChanges(result.changes);
    setSourceFiles(result.sourceFiles || []);
  }

  async function createProjectMember(event) {
    event.preventDefault();
    if (!memberForm.name.trim()) {
      setError("请填写成员姓名。");
      return;
    }
    setError("");
    try {
      await apiPost(`/projects/${projectId}/members`, memberForm);
      setMemberForm({ name: "", account: "", phone: "", password: "123456", projectRole: "客户成员", userRole: "业务代表" });
      await refreshProjectData();
    } catch (err) {
      setError(err.message || "新增成员失败");
    }
  }

  async function saveProjectSettings(event) {
    event.preventDefault();
    setError("");
    try {
      const result = await apiPatch(`/projects/${projectId}`, {
        name: settingsForm.name,
        customerName: settingsForm.customerName,
        stage: settingsForm.stage,
        expectedEndDate: settingsForm.expectedEndDate || null,
        settings: {
          enableAutoWiki: settingsForm.enableAutoWiki,
          enableChangeDetection: settingsForm.enableChangeDetection,
          requireHumanConfirmation: settingsForm.requireHumanConfirmation,
          exportFrontmatter: settingsForm.exportFrontmatter
        }
      });
      setProjects((current) =>
        current.map((item) => (item.id === result.project.id ? { ...result.project, owner: item.owner } : item))
      );
      await refreshProjectData();
    } catch (err) {
      setError(err.message || "保存设置失败");
    }
  }

  async function createProject(event) {
    event.preventDefault();
    const name = projectForm.name.trim();
    if (!name) {
      setError("请填写项目名称。");
      return;
    }
    setError("");
    try {
      const result = await apiPost("/projects", {
        name,
        customerName: projectForm.customerName.trim() || "未填写客户",
        stage: projectForm.stage,
        expectedEndDate: projectForm.expectedEndDate || null
      });
      const data = await apiGet("/projects");
      setProjects(data.projects);
      setProjectId(result.project.id);
      setSelectedWikiPage(null);
      navigate("overview");
      setShowProjectForm(false);
      setProjectForm({
        name: "",
        customerName: "",
        stage: "需求沟通阶段",
        expectedEndDate: ""
      });
    } catch (err) {
      setError(err.message || "新建项目失败");
    }
  }

  async function createRequirement(event) {
    event.preventDefault();
    if (!requirementForm.title.trim()) {
      setError("请填写需求标题。");
      return;
    }
    setError("");
    setNotice("");
    try {
      await apiPost(`/projects/${projectId}/requirements`, {
        ...requirementForm,
        title: requirementForm.title.trim(),
        moduleName: requirementForm.moduleName.trim() || "项目范围",
        sourceSuggestionId: requirementDraftSourceSuggestionId || undefined
      });
      setRequirementForm(defaultRequirementForm);
      const fromSuggestion = Boolean(requirementDraftSourceSuggestionId);
      setRequirementDraftSourceSuggestionId("");
      setShowRequirementForm(false);
      await refreshProjectData();
      if (fromSuggestion) {
        navigate("requirementSuggestions", "需求建议");
        setNotice("需求建议已采纳为待确认需求，可继续处理下一条建议。");
      } else {
        navigate("requirementPool", "需求池");
        setNotice("需求已创建，并进入需求池。");
      }
    } catch (err) {
      setError(err.message || "新建需求失败");
    }
  }

  async function generateRequirementSuggestions() {
    if (!projectId || suggestionGenerating) return;
    setSuggestionGenerating(true);
    setSuggestionStatus("正在根据 LLM Wiki 编译结果预测客户可能提出的需求...");
    setError("");
    setNotice("");
    try {
      const result = await apiPost(`/projects/${projectId}/requirement-suggestions/generate`, {});
      setRequirementSuggestions(result.suggestions || []);
      setSuggestionStatus(result.warning || `已生成 ${result.suggestions?.length || 0} 条需求建议。`);
      if (result.warning) setNotice("大模型预测未完成，已生成本地草案。");
    } catch (err) {
      setError(err.message || "需求建议生成失败");
      setSuggestionStatus("");
    } finally {
      setSuggestionGenerating(false);
    }
  }

  function adoptRequirementSuggestion(suggestion) {
    setRequirementDraftSourceSuggestionId(suggestion.id || "");
    setRequirementForm({
      moduleName: suggestion.moduleName || "项目范围",
      title: suggestion.title || "",
      description: suggestion.description || "",
      acceptanceCriteria: suggestion.acceptanceCriteria || "",
      status: "待确认",
      priority: suggestion.priority || "中",
      proposer: "需求建议",
      owner: ""
    });
    setShowRequirementForm(true);
  }

  async function updateRequirementSuggestionStatus(suggestionId, status) {
    setError("");
    setNotice("");
    try {
      const result = await apiPatch(`/requirement-suggestions/${suggestionId}/status`, { status });
      setRequirementSuggestions((current) => current.map((item) => (item.id === suggestionId ? result.suggestion : item)));
      setNotice(status === "已放弃" ? "需求建议已放弃，不再出现在待处理列表。" : "需求建议状态已更新。");
    } catch (err) {
      setError(err.message || "需求建议状态更新失败");
    }
  }

  async function deleteRequirementSuggestion(suggestionId) {
    setError("");
    setNotice("");
    try {
      await apiDelete(`/requirement-suggestions/${suggestionId}`);
      setRequirementSuggestions((current) => current.filter((item) => item.id !== suggestionId));
      setNotice("需求建议已删除。");
    } catch (err) {
      setError(err.message || "需求建议删除失败");
    }
  }

  const metrics = dashboard?.metrics || {};
  const requirementStatus = dashboard?.requirementStatus?.length
    ? dashboard.requirementStatus.map((item) => ({
        ...item,
        color: statusColors[item.name] || "#64748b"
      }))
    : [];
  const requirementTotal = requirementStatus.reduce((sum, item) => sum + item.value, 0);

  function navigate(view, navLabel = defaultNavByView[view]) {
    const nextView = mergedViewAliases[view] || view;
    setActiveView(nextView);
    setActiveNavLabel(defaultNavByView[nextView] || navLabel || nextView);
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <button className="brand-mark brand-home" type="button" onClick={() => navigate("overview", "项目概览")} title="返回首页">
            <Sparkles size={21} />
          </button>
          <span>
            <strong>木铎知会</strong>
            <small>组织沟通与知识沉淀平台</small>
          </span>
        </div>

        <section className="project-switch-card" aria-label="当前项目">
          <label htmlFor="project-switch">当前项目</label>
          <select id="project-switch" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            {projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <p>{project?.stage || "需求沟通阶段"}</p>
        </section>

        <nav className="nav-list" aria-label="主导航">
          {sidebarGroups.map((group) =>
            group.type === "single" ? (
              <SidebarNavButton
                key={group.label}
                item={group}
                active={activeNavLabel === group.label}
                onClick={() => navigate(group.view, group.label)}
              />
            ) : (
              <SidebarNavGroup
                key={group.label}
                group={group}
                activeLabel={activeNavLabel}
                collapsed={collapsedNavGroups[group.label]}
                onToggle={() =>
                  setCollapsedNavGroups((current) => ({
                    ...current,
                    [group.label]: !current[group.label]
                  }))
                }
                onNavigate={navigate}
              />
            )
          )}
        </nav>

      </aside>

      <main className="workspace">
        <header className="topbar">
          <div className="project-heading">
            <h1>{activeNavLabel || "项目概览"}</h1>
            <span>{project?.name || "需求沟通看板"}</span>
          </div>

          <div className="top-actions">
            <button className="toolbar-action primary" type="button" onClick={() => setShowRequirementForm(true)}>
              <Plus size={16} />
              新建需求
            </button>
            <button className="toolbar-action" type="button" onClick={() => navigate("documents", "资料库")}>
              <Upload size={16} />
              导入资料
            </button>
            <button className="toolbar-action" type="button" onClick={exportMarkdown}>
              <Download size={16} />
              导出报告
            </button>
            <button
              className="icon-button"
              type="button"
              title="查看待确认变更"
              aria-label={`${metrics.pendingChangeTotal || 0} 个待确认变更`}
              onClick={() => navigate("changes", "变更记录")}
            >
              <Bell size={18} />
              <i>{metrics.pendingChangeTotal || 0}</i>
            </button>
            <div className="user-avatar">
              <UserRound size={18} />
            </div>
            <button className="toolbar-action" type="button" onClick={onLogout}>
              退出
            </button>
          </div>
        </header>

        <section className="content">
          {error && <div className="error-banner">{error}</div>}
          {notice && <div className="success-banner">{notice}</div>}
          {loading && <LoadingState />}
          {!loading && activeView === "overview" && (
            <OverviewView
              dashboard={dashboard}
              metrics={metrics}
              requirementStatus={requirementStatus}
              requirementTotal={requirementTotal}
              onChangeStatus={requestChangeStatusUpdate}
              onOpenView={navigate}
            />
          )}
          {!loading && activeView === "wiki" && (
            <WikiView
              pages={wikiPages}
              selectedPage={selectedWikiPage}
              onSelectPage={setSelectedWikiPage}
              managerBrief={dashboard?.managerBrief}
              changes={changes}
              sourceFiles={sourceFiles}
              onPreviewSource={openSourcePreview}
              onOpenChange={(changeId) => {
                navigate("changes", "需求变更");
                window.setTimeout(() => scrollToChange(changeId), 80);
              }}
              onExport={exportMarkdown}
              exportPath={exportPath}
            />
          )}
          {!loading && activeView === "ingest" && (
            <IngestView
              dashboard={dashboard}
              uploadFiles={uploadFiles}
              speakerCount={uploadSpeakerCount}
              uploadStatus={uploadStatus}
              uploadProgress={uploadProgress}
              onFileChange={setUploadFiles}
              onSpeakerCountChange={setUploadSpeakerCount}
              onSubmit={handleUploadAndIngest}
            />
          )}
          {!loading && activeView === "documents" && (
            <DocumentsView
              sourceFiles={sourceFiles}
              uploadFiles={uploadFiles}
              uploadMetadata={uploadMetadata}
              speakerCount={uploadSpeakerCount}
              uploadStatus={uploadStatus}
              uploadProgress={uploadProgress}
              ingestProgressBySource={ingestProgressBySource}
              onFileChange={setUploadFiles}
              onUploadMetadataChange={setUploadMetadata}
              onSpeakerCountChange={setUploadSpeakerCount}
              onSubmit={handleUploadAndIngest}
              onPreview={openSourcePreview}
              onReingest={reingestSourceFile}
              onOpenEditor={openSourceEditor}
              onCompileNew={compileNewSourceFiles}
              batchCompileStatus={batchCompileStatus}
              batchCompiling={batchCompiling}
            />
          )}
          {!loading && activeView === "materials" && (
            <MaterialsView
              sourceFiles={sourceFiles}
              onPreview={openSourcePreview}
              onOpenIngest={() => navigate("ingest", "资料导入")}
            />
          )}
          {!loading && activeView === "requirementList" && <RequirementsView requirements={requirements} />}
          {!loading && activeView === "requirementPool" && <RequirementPoolView requirements={requirements} changes={changes} />}
          {!loading && activeView === "requirementSuggestions" && (
            <RequirementSuggestionsView
              suggestions={requirementSuggestions}
              requirements={requirements}
              sourceFiles={sourceFiles}
              wikiPages={wikiPages}
              status={suggestionStatus}
              generating={suggestionGenerating}
              onGenerate={generateRequirementSuggestions}
              onAdopt={adoptRequirementSuggestion}
              onDismiss={updateRequirementSuggestionStatus}
              onDelete={deleteRequirementSuggestion}
              onPreviewSource={openSourcePreview}
              onOpenChange={(changeId) => {
                navigate("changes", "需求变更");
                window.setTimeout(() => scrollToChange(changeId), 80);
              }}
              onOpenWiki={(wikiPageId) => {
                const page = wikiPages.find((item) => item.id === wikiPageId);
                if (page) {
                  setSelectedWikiPage(page);
                  navigate("wiki", "项目 Wiki");
                }
              }}
            />
          )}
          {!loading && activeView === "changes" && <ChangesView changes={changes} onChangeStatus={requestChangeStatusUpdate} onPreviewSource={openSourcePreview} />}
          {!loading && activeView === "communications" && (
            <CommunicationsView
              dashboard={dashboard}
              changes={changes}
              requirements={requirements}
              sourceFiles={sourceFiles}
              wikiPages={wikiPages}
            />
          )}
          {!loading && activeView === "meetingRecords" && <MeetingRecordsView dashboard={dashboard} />}
          {!loading && activeView === "milestones" && <MilestonesView project={project} />}
          {!loading && activeView === "tasks" && <TasksView tasks={tasks} onTaskStatus={requestTaskStatusUpdate} onOpenChanges={() => navigate("changes")} />}
          {!loading && activeView === "members" && (
            <MembersView members={members} form={memberForm} onChange={setMemberForm} onSubmit={createProjectMember} />
          )}
          {!loading && activeView === "settings" && (
            <SettingsView
              project={project}
              form={settingsForm}
              onChange={setSettingsForm}
              onSubmit={saveProjectSettings}
              members={members}
              memberForm={memberForm}
              onMemberChange={setMemberForm}
              onMemberSubmit={createProjectMember}
            />
          )}
        </section>
      </main>
      {showProjectForm && (
        <ProjectModal
          form={projectForm}
          onChange={setProjectForm}
          onClose={() => setShowProjectForm(false)}
          onSubmit={createProject}
        />
      )}
      {showRequirementForm && (
        <RequirementModal
          form={requirementForm}
          onChange={setRequirementForm}
          onClose={() => {
            setShowRequirementForm(false);
            setRequirementDraftSourceSuggestionId("");
          }}
          onSubmit={createRequirement}
        />
      )}
      {(sourcePreview || sourcePreviewLoading) && (
        <SourcePreviewModal
          preview={sourcePreview}
          loading={sourcePreviewLoading}
          onClose={() => setSourcePreview(null)}
        />
      )}
      {sourceEditor && (
        <SourceEditModal
          editor={sourceEditor}
          saving={savingSourceNoteId === sourceEditor.id}
          onChange={updateSourceEditor}
          onClose={() => setSourceEditor(null)}
          onSubmit={saveSourceEditor}
        />
      )}
      {changeStatusConfirm && (
        <ChangeStatusConfirmModal
          action={changeStatusConfirm}
          submitting={changeStatusSubmitting}
          onCancel={() => setChangeStatusConfirm(null)}
          onConfirm={confirmChangeStatusUpdate}
        />
      )}
    </div>
  );
}

function SidebarNavButton({ item, active, onClick }) {
  const Icon = item.icon;
  return (
    <button className={active ? "nav-item active" : "nav-item"} type="button" onClick={onClick}>
      <Icon size={17} />
      <span>{item.label}</span>
    </button>
  );
}

function SidebarNavGroup({ group, activeLabel, collapsed, onToggle, onNavigate }) {
  const Icon = group.icon;
  const active = group.children.some((item) => item.label === activeLabel);
  return (
    <div className={`${active ? "nav-group active" : "nav-group"}${collapsed ? " collapsed" : ""}`}>
      <button className="nav-group-title" type="button" aria-expanded={!collapsed} onClick={onToggle}>
        <Icon size={17} />
        <span>{group.label}</span>
        <ChevronDown size={14} />
      </button>
      <div className="nav-children">
        {group.children.map((item) => (
          <button
            key={item.label}
            className={activeLabel === item.label ? "nav-child active" : "nav-child"}
            type="button"
            onClick={() => onNavigate(item.view, item.label)}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function OverviewView({ dashboard, metrics, requirementStatus, requirementTotal, onChangeStatus, onOpenView }) {
  const [dateRange, setDateRange] = useState("2025-04-24 ~ 2025-04-30");
  const [memberScope, setMemberScope] = useState("全部项目成员");
  const [trendRange, setTrendRange] = useState("近7天");
  const [changeType, setChangeType] = useState("全部类型");
  const metricCards = [
    { label: "需求总数", value: metrics.requirementTotal || 0, note: "较上周 ↑ 12", icon: FileText, tone: "blue" },
    { label: "已确认需求", value: metrics.confirmedRequirements || 0, note: `${metrics.confirmedRatio || 0}% · 较上周 ↑ 8`, icon: CheckCircle2, tone: "green" },
    { label: "变更次数", value: metrics.changeTotal || 0, note: "较上周 ↑ 10", icon: GitBranch, tone: "orange" },
    { label: "未决变更", value: metrics.pendingChangeTotal || 0, note: "较上周 ↓ 2", icon: Bell, tone: "red" },
    { label: "沟通记录", value: metrics.communicationTotal || 0, note: "较上周 ↑ 5", icon: MessagesSquare, tone: "purple" },
    { label: "资料文件", value: metrics.documentTotal || 0, note: "较上周 ↑ 2", icon: FileStack, tone: "indigo" }
  ];

  const pendingChanges = dashboard?.pendingChanges || [];
  const recentChanges =
    changeType === "全部类型"
      ? dashboard?.recentChanges || []
      : (dashboard?.recentChanges || []).filter((item) => item.changeType === changeType);
  const nextDateRange = dateRange === "2025-04-24 ~ 2025-04-30" ? "近30天" : "2025-04-24 ~ 2025-04-30";
  const nextMemberScope = memberScope === "全部项目成员" ? "客户成员" : memberScope === "客户成员" ? "内部成员" : "全部项目成员";
  const nextTrendRange = trendRange === "近7天" ? "近30天" : "近7天";
  const nextChangeType = changeType === "全部类型" ? "新增" : changeType === "新增" ? "修改" : changeType === "修改" ? "删除" : "全部类型";

  return (
    <>
      <section className="dashboard-toolbar" aria-label="项目筛选">
        <div className="dashboard-toolbar-copy">
          <strong>{dashboard?.project?.name || "当前项目"}</strong>
          <span>{dashboard?.project?.stage || "需求沟通阶段"} · AI 自动编译 Wiki 与待确认变更</span>
        </div>
        <div className="dashboard-filters">
          <button type="button" onClick={() => setDateRange(nextDateRange)} title="切换时间范围">
            <CalendarDays size={15} />
            {dateRange}
            <ChevronDown size={14} />
          </button>
          <button type="button" onClick={() => setMemberScope(nextMemberScope)} title="切换成员范围">
            {memberScope}
            <ChevronDown size={14} />
          </button>
        </div>
      </section>

      <section className="metrics-grid" aria-label="核心指标">
        {metricCards.map((metric) => {
          const Icon = metric.icon;
          return (
            <article className="metric-card" key={metric.label}>
              <div className={`metric-icon ${metric.tone}`}>
                <Icon size={20} />
              </div>
              <div>
                <span>{metric.label}</span>
                <strong>{metric.value}</strong>
                <small>{metric.note}</small>
              </div>
            </article>
          );
        })}
      </section>

      <div className="dashboard-grid">
        <div className="dashboard-main">
          <div className="chart-row">
            <section className="panel trend-panel">
              <PanelHeader title="需求变更趋势" action={trendRange} select onAction={() => setTrendRange(nextTrendRange)} />
              <MeasuredTrendChart data={dashboard?.trend || []} />
              <div className="legend">
                <Legend color="#16a34a" label="新增" />
                <Legend color="#2563eb" label="修改" />
                <Legend color="#ef4444" label="删除" />
              </div>
            </section>

            <section className="panel status-panel">
              <PanelHeader title="需求状态分布" />
              <div className="status-body">
                <div className="donut">
                  <MeasuredPieChart data={requirementStatus} />
                  <div className="donut-center">
                    <strong>{requirementTotal}</strong>
                    <span>总需求</span>
                  </div>
                </div>
                <div className="status-list">
                  {requirementStatus.map((item) => (
                    <div className="status-item" key={item.name}>
                      <span>
                        <i style={{ background: item.color }} />
                        {item.name}
                      </span>
                      <strong>{item.value}</strong>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          </div>

          <div className="lower-row">
            <section className="panel pending-panel">
              <PanelHeader title={`待处理变更（${pendingChanges.length}）`} action="查看全部" onAction={() => onOpenView("changes")} />
              <div className="pending-summary">
                <strong>{pendingChanges.length || 0} 条变更等待确认</strong>
                <span>AI 已自动写入 Wiki，但不会覆盖当前确认需求；确认后才更新需求池和历史版本。</span>
              </div>
              <div className="pending-list">
                {pendingChanges.slice(0, 2).map((change) => (
                  <ChangeCompactRow key={change.id} change={change} onChangeStatus={onChangeStatus} />
                ))}
                <div className="pending-folded">
                  <span>其余 {Math.max(pendingChanges.length - 2, 0)} 条已收起</span>
                  <button type="button" onClick={() => onOpenView("changes")}>按优先级查看</button>
                </div>
              </div>
            </section>

            <section className="panel communication-panel">
              <PanelHeader title="最近编译资料" action="导入资料" onAction={() => onOpenView("ingest")} />
              <div className="communication-list">
                {(dashboard?.sourceFiles || []).slice(0, 5).map((item) => (
                  <article className="communication-row" key={item.id}>
                    <div className="communication-icon">
                      {item.category === "audio" ? <FileAudio size={18} /> : <FileText size={18} />}
                    </div>
                    <div>
                      <h3>{item.title}</h3>
                      <p>{item.category} · {item.status}</p>
                    </div>
                    <time>{formatDate(item.uploadedAt)}</time>
                  </article>
                ))}
              </div>
            </section>
          </div>
        </div>

        <aside className="panel recent-panel">
          <PanelHeader title="最近变更" action={changeType} select onAction={() => setChangeType(nextChangeType)} />
          <div className="recent-list">
            {recentChanges.map((item) => (
              <article className="recent-item" key={item.id}>
                <div className={`recent-dot ${typeClass(item.changeType)}`} />
                <time>
                  <strong>{formatDate(item.createdAt)}</strong>
                  <span>{item.status}</span>
                </time>
                <div>
                  <h3>
                    <span className={`type-tag ${typeClass(item.changeType)}`}>{item.changeType}</span>
                    {item.moduleName} &gt; {item.title}
                  </h3>
                  <p>{item.summary}</p>
                  <small>置信度 {Math.round((item.confidence || 0) * 100)}%</small>
                </div>
              </article>
            ))}
          </div>
        </aside>
      </div>

      <section className="panel milestone-panel">
        <PanelHeader title="项目里程碑" action="查看全部里程碑" onAction={() => onOpenView("milestones", "里程碑")} />
        <div className="milestones">
          {[
            ["需求沟通阶段", "进行中", "04-01 ~ 04-30", true],
            ["原型设计阶段", "未开始", "05-01 ~ 05-20", false],
            ["开发阶段", "未开始", "05-21 ~ 07-10", false],
            ["测试阶段", "未开始", "07-11 ~ 07-25", false],
            ["上线阶段", "未开始", "07-26 ~ 08-05", false]
          ].map(([title, status, date, active], index, list) => (
            <article className={active ? "milestone active" : "milestone"} key={title}>
              {index < list.length - 1 && <i className="milestone-line" />}
              <div className="milestone-icon">
                {active ? <GitBranch size={17} /> : <FileText size={16} />}
              </div>
              <div>
                <h3>{title}</h3>
                <p>{status}</p>
                <span>{date}</span>
              </div>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}

function MeasuredTrendChart({ data }) {
  const [ref, size] = useElementSize();
  const width = Math.max(320, size.width || 0);
  const height = Math.max(160, size.height || 178);

  return (
    <div className="trend-chart" ref={ref}>
      {size.width > 0 && (
        <LineChart width={width} height={height} data={data} margin={{ top: 12, right: 18, left: -18, bottom: 0 }}>
          <CartesianGrid stroke="#e7edf5" strokeDasharray="4 4" vertical={false} />
          <XAxis dataKey="day" axisLine={false} tickLine={false} tick={{ fill: "#667085", fontSize: 12 }} />
          <YAxis axisLine={false} tickLine={false} tick={{ fill: "#667085", fontSize: 12 }} />
          <Tooltip content={<TrendTooltip />} />
          <Line type="monotone" dataKey="added" name="新增" stroke="#16a34a" strokeWidth={2.2} dot={{ r: 4 }} />
          <Line type="monotone" dataKey="updated" name="修改" stroke="#2563eb" strokeWidth={2.2} dot={{ r: 4 }} />
          <Line type="monotone" dataKey="removed" name="删除" stroke="#ef4444" strokeWidth={2.2} dot={{ r: 4 }} />
        </LineChart>
      )}
    </div>
  );
}

function MeasuredPieChart({ data }) {
  const [ref, size] = useElementSize();
  const width = Math.max(184, size.width || 0);
  const height = Math.max(184, size.height || 184);

  return (
    <div className="measured-pie" ref={ref}>
      {size.width > 0 && (
        <PieChart width={width} height={height}>
          <Pie data={data} innerRadius={62} outerRadius={88} dataKey="value" paddingAngle={2} stroke="none">
            {data.map((item) => (
              <Cell key={item.name} fill={item.color} />
            ))}
          </Pie>
        </PieChart>
      )}
    </div>
  );
}

function useElementSize() {
  const ref = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const update = () => {
      const width = Math.max(0, Math.floor(element.clientWidth || 0));
      const height = Math.max(0, Math.floor(element.clientHeight || 0));
      setSize((current) => (current.width === width && current.height === height ? current : { width, height }));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, size];
}

function WikiView({ pages, selectedPage, onSelectPage, managerBrief, changes = [], sourceFiles = [], onPreviewSource, onOpenChange, onExport, exportPath }) {
  const pageLookup = useMemo(() => buildWikiPageLookup(pages), [pages]);
  const activeManagerBrief = useMemo(
    () => selectedPage?.type === "MANAGER_BRIEF"
      ? selectedPage.managerBrief || managerBrief || buildFallbackManagerBrief(selectedPage, changes, sourceFiles)
      : null,
    [selectedPage, managerBrief, changes, sourceFiles]
  );
  const renderedMarkdown = useMemo(
    () => renderRicoMarkdown(enrichWikiLinks(selectedPage?.content || "", pageLookup)),
    [selectedPage?.content, pageLookup]
  );
  const wikiContext = useMemo(() => buildWikiContext(selectedPage, pages, sourceFiles), [selectedPage, pages, sourceFiles]);
  const markdownRef = useRef(null);

  function navigateWikiTarget(target) {
    const page = resolveWikiPageTarget(target, pageLookup);
    if (page) onSelectPage(page);
  }

  useEffect(() => {
    const root = markdownRef.current;
    if (!root) return;
    const handleClick = (event) => {
      const missingLink = event.target.closest("a[data-wiki-missing]");
      if (missingLink) {
        event.preventDefault();
        return;
      }
      const link = event.target.closest("a[data-wiki-target]");
      if (!link) return;
      event.preventDefault();
      navigateWikiTarget(link.getAttribute("data-wiki-target"));
    };
    root.addEventListener("click", handleClick);
    return () => root.removeEventListener("click", handleClick);
  }, [pageLookup, onSelectPage]);

  useEffect(() => {
    const root = markdownRef.current;
    if (!root) return;
    const diagrams = Array.from(root.querySelectorAll(".rico-mermaid"));
    if (!diagrams.length) return;

    let active = true;
    async function renderDiagrams() {
      const { default: mermaid } = await import("mermaid");
      if (!active) return;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "loose",
        theme: "base",
        themeVariables: {
          background: "transparent",
          primaryColor: "#eef4ff",
          primaryTextColor: "#121826",
          primaryBorderColor: "#b8d4ff",
          lineColor: "#98a2b3",
          secondaryColor: "#f8fbff",
          tertiaryColor: "#ffffff",
          fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
        }
      });

      diagrams.forEach(async (node, index) => {
        const source = node.textContent.trim();
        if (!source) return;
        node.setAttribute("aria-busy", "true");
        try {
          const { svg, bindFunctions } = await mermaid.render(`wiki-diagram-${Date.now()}-${index}`, source);
          if (!active) return;
          node.innerHTML = svg;
          bindFunctions?.(node);
          node.removeAttribute("aria-busy");
        } catch (error) {
          if (!active) return;
          node.innerHTML = `<pre class="rico-mermaid-error">${escapeHtml(source)}</pre>`;
          node.setAttribute("data-render-error", "true");
          node.removeAttribute("aria-busy");
        }
      });
    }

    renderDiagrams();

    return () => {
      active = false;
    };
  }, [renderedMarkdown]);

  return (
    <div className="wiki-layout">
      <section className="panel wiki-list-panel">
        <PanelHeader title="项目 Wiki" action="导出 Markdown" onAction={onExport} />
        {exportPath && <div className="success-banner">已导出到：{exportPath}</div>}
        <div className="wiki-quick-nav">
          {["MANAGER_BRIEF", "PROJECT_OVERVIEW", "REQUIREMENT_BASELINE", "PROJECT_EVOLUTION", "DELIVERY_COMPILATION", "INDEX"].map((type) => {
            const page = pages.find((item) => item.type === type);
            return page ? (
              <button key={type} type="button" onClick={() => onSelectPage(page)}>
                {wikiTypeLabel(type)}
              </button>
            ) : null;
          })}
        </div>
        <div className="wiki-list">
          {pages.map((page) => (
            <button
              className={selectedPage?.id === page.id ? "wiki-list-item active" : "wiki-list-item"}
              key={page.id}
              type="button"
              onClick={() => onSelectPage(page)}
            >
              <span>{wikiTypeLabel(page.type)}</span>
              <strong>{page.title}</strong>
              <small>{page.summary}</small>
            </button>
          ))}
        </div>
      </section>

      <section className="panel wiki-detail-panel">
        {selectedPage ? (
          <>
            <PanelHeader title={selectedPage.title} action={`${selectedPage.sourceIds?.length || 0} 个来源`} select />
            <article className="markdown-preview">
              <p className="wiki-summary">{selectedPage.summary}</p>
              <div className="wiki-meta-bar">
                <span>{wikiTypeLabel(selectedPage.type)}</span>
                {selectedPage.status ? <span>{selectedPage.status}</span> : null}
                {selectedPage.signalLevel ? <span>信号：{signalLevelLabel(selectedPage.signalLevel)}</span> : null}
                {selectedPage.canonicalTerms?.slice(0, 5).map((term) => <span key={term}>{term}</span>)}
              </div>
              {activeManagerBrief ? (
                <ManagerBriefPanel
                  brief={activeManagerBrief}
                  pages={pages}
                  onSelectPage={onSelectPage}
                  onPreviewSource={onPreviewSource}
                  onOpenChange={onOpenChange}
                />
              ) : (
                <>
                  <div className="rico-preview-shell">
                    <div
                      className="rico-markdown"
                      ref={markdownRef}
                      dangerouslySetInnerHTML={{ __html: renderedMarkdown }}
                    />
                  </div>
                  <WikiInsightPanel
                    context={wikiContext}
                    onSelectPage={onSelectPage}
                    onPreviewSource={onPreviewSource}
                  />
                </>
              )}
            </article>
          </>
        ) : (
          <EmptyState icon={BookOpen} title="暂无 Wiki 页面" text="导入资料后，AI 会自动编译项目 Wiki。" />
        )}
      </section>
    </div>
  );
}

function ManagerBriefPanel({ brief, pages = [], onSelectPage, onPreviewSource, onOpenChange }) {
  const technicalPages = ["REQUIREMENT_BASELINE", "DELIVERY_COMPILATION", "RISK_REGISTER", "OPEN_QUESTION"]
    .map((type) => pages.find((page) => page.type === type))
    .filter(Boolean);
  return (
    <div className="manager-brief">
      <section className="manager-brief-hero">
        <span>当前一句话结论</span>
        <strong>{brief.summary || "暂无需要项目经理立即处理的事项。"}</strong>
        <div>
          <small>待确认 {brief.stats?.pendingManagerCount || 0}</small>
          <small>客户确认 {brief.stats?.customerConfirmCount || 0}</small>
          <small>风险 {brief.stats?.riskCount || 0}</small>
        </div>
      </section>

      <section className="manager-brief-grid">
        <ManagerBriefSection title="本周关键变化" empty="暂无关键变化">
          {(brief.keyChanges || []).slice(0, 5).map((item) => (
            <button className="manager-brief-item" key={item.id || item.title} type="button" onClick={() => item.changeId && onOpenChange?.(item.changeId)}>
              <span className={`type-tag ${typeClass(item.type)}`}>{item.type || "变更"}</span>
              <strong>{item.title}</strong>
              <p>{item.result || item.impact}</p>
              <small>{item.status || "待确认"} · {item.source || "来源待补充"}</small>
            </button>
          ))}
        </ManagerBriefSection>

        <ManagerBriefSection title="需要处理" empty="暂无待处理动作">
          {(brief.actions || []).slice(0, 6).map((item) => (
            <article className="manager-brief-item" key={item.id || item.title}>
              <strong>{item.title}</strong>
              <p>{item.summary}</p>
              <div className="manager-brief-actions">
                <small>{item.owner || "待确认"} · {item.due || "待定"}</small>
                {item.changeId ? <button type="button" onClick={() => onOpenChange?.(item.changeId)}>查看变更</button> : null}
                {item.sourceFileId ? <button type="button" onClick={() => onPreviewSource?.(item.sourceFileId)}>看来源</button> : null}
              </div>
            </article>
          ))}
        </ManagerBriefSection>

        <ManagerBriefSection title="风险简报" empty="暂无高优先级风险">
          {(brief.risks || []).slice(0, 3).map((item) => (
            <article className="manager-brief-item risk" key={item.id || item.title}>
              <span className={`priority ${priorityClass(item.severity)}`}>{item.severity || "中"}</span>
              <strong>{item.title}</strong>
              <p>{item.summary}</p>
              <small>建议：{item.action || "指定负责人跟进。"}</small>
            </article>
          ))}
        </ManagerBriefSection>

        <ManagerBriefSection title="下一步动作" empty="继续导入沟通资料，等待下一轮编译">
          {(brief.actions || []).slice(0, 4).map((item) => (
            <article className="manager-brief-item compact" key={`next-${item.id || item.title}`}>
              <strong>{item.title}</strong>
              <small>{item.owner || "待确认"} · {item.due || "待定"}</small>
            </article>
          ))}
        </ManagerBriefSection>
      </section>

      <section className="manager-brief-drilldown">
        <div>
          <strong>技术下钻</strong>
          <span>完整需求基线、开发管理编译、风险台账和待确认事项仍保留给产品/开发查看。</span>
        </div>
        <div>
          {technicalPages.map((page) => (
            <button key={page.id} type="button" onClick={() => onSelectPage(page)}>
              {wikiTypeLabel(page.type)}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function ManagerBriefSection({ title, empty, children }) {
  const items = React.Children.toArray(children).filter(Boolean);
  return (
    <section className="manager-brief-section">
      <h3>{title}</h3>
      {items.length ? items : <p className="manager-brief-empty">{empty}</p>}
    </section>
  );
}

function WikiInsightPanel({ context, onSelectPage, onPreviewSource }) {
  if (!context) return null;
  const { sources, outgoingPages, backlinks, sameSourcePages } = context;
  const hasContent = sources.length || outgoingPages.length || backlinks.length || sameSourcePages.length;
  if (!hasContent) return null;
  return (
    <aside className="wiki-insight-panel">
      {outgoingPages.length ? (
        <section>
          <h3>相关页面</h3>
          <div className="wiki-chip-list">
            {outgoingPages.map((page) => (
              <button key={page.id} type="button" onClick={() => onSelectPage(page)}>
                <span>{wikiTypeLabel(page.type)}</span>
                {page.title}
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {backlinks.length ? (
        <section>
          <h3>反向链接</h3>
          <div className="wiki-chip-list">
            {backlinks.map((page) => (
              <button key={page.id} type="button" onClick={() => onSelectPage(page)}>
                <span>{wikiTypeLabel(page.type)}</span>
                {page.title}
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {sources.length ? (
        <section>
          <h3>来源资料</h3>
          <div className="wiki-source-list">
            {sources.map((source) => (
              <button key={source.id} type="button" onClick={() => onPreviewSource?.(source.id)}>
                <strong>{source.title || source.originalName}</strong>
                <small>{categoryLabel(source.category)} · {statusLabel(source.status)} · {formatDate(source.uploadedAt)}</small>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {sameSourcePages.length ? (
        <section>
          <h3>同源沉淀</h3>
          <div className="wiki-chip-list">
            {sameSourcePages.map((page) => (
              <button key={page.id} type="button" onClick={() => onSelectPage(page)}>
                <span>{wikiTypeLabel(page.type)}</span>
                {page.title}
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </aside>
  );
}

function IngestView({ dashboard, uploadFiles = [], speakerCount, uploadStatus, uploadProgress, onFileChange, onSpeakerCountChange, onSubmit }) {
  const isAudio = uploadFiles.some((file) => isAudioUploadFile(file));

  return (
    <div className="ingest-layout">
      <section className="panel ingest-panel">
        <PanelHeader title="资料导入与自动编译" />
        <form className="upload-box" onSubmit={onSubmit}>
          <Upload size={28} />
          <h2>上传录音、文档或截图</h2>
          <p>支持 Word、PDF、Markdown、TXT、Excel、图片、MP3、WAV、M4A。支持一次上传多个文件，上传完成后可在资料库逐个转写或编译。</p>
          <input type="file" multiple onChange={(event) => onFileChange(Array.from(event.target.files || []))} />
          {isAudio && (
            <div className="speaker-options">
              <div>
                <strong>会议人数</strong>
                <p>用于豆包语音识别的说话人聚类分离，建议 1-10 人；转写后可继续标注甲方、乙方和内部成员。</p>
              </div>
              <label>
                <Users size={16} />
                <select value={speakerCount} onChange={(event) => onSpeakerCountChange(Number(event.target.value))}>
                  {Array.from({ length: 10 }, (_, index) => index + 1).map((count) => (
                    <option value={count} key={count}>
                      {count} 人
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          <button className="primary-action" type="submit" disabled={!uploadFiles.length || (uploadProgress > 0 && uploadProgress < 100)}>
            {uploadFiles.length ? `上传 ${uploadFiles.length} 个文件` : "选择文件后开始"}
          </button>
          {uploadProgress > 0 && uploadProgress < 100 ? <ProgressLine value={uploadProgress} label={`上传中 ${uploadProgress}%`} /> : null}
          {uploadStatus && <div className="success-banner">{uploadStatus}</div>}
        </form>
      </section>

      <section className="panel">
        <PanelHeader title="最近来源资料" />
        <div className="source-list">
          {(dashboard?.sourceFiles || []).map((source) => (
            <article className="source-row" key={source.id}>
              <Database size={18} />
              <div>
                <h3>{source.title}</h3>
                <p>
                  {source.category} · {source.status} · {formatDate(source.uploadedAt)}
                  {source.category === "audio" && source.speakerCount ? ` · ${source.speakerCount} 人说话人分离` : ""}
                </p>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function DocumentsView({
  sourceFiles,
  uploadFiles = [],
  uploadMetadata = defaultUploadMetadata,
  speakerCount,
  uploadStatus,
  uploadProgress,
  ingestProgressBySource = {},
  onFileChange,
  onUploadMetadataChange,
  onSpeakerCountChange,
  onSubmit,
  onPreview,
  onReingest,
  onOpenEditor,
  onCompileNew,
  batchCompileStatus,
  batchCompiling
}) {
  const isAudio = uploadFiles.some((file) => isAudioUploadFile(file));
  const pendingCompileCount = sourceFiles.filter((source) => shouldCompileSource(source)).length;
  const documentBuckets = [
    { label: "需求确认文件", value: sourceFiles.filter((source) => source.documentPurpose === "需求确认文件").length, text: "形成需求基线与确认记录" },
    { label: "需求变更文件", value: sourceFiles.filter((source) => source.documentPurpose === "需求变更文件").length, text: "开发阶段变更建议来源" },
    { label: "合同文件", value: sourceFiles.filter((source) => source.documentPurpose === "合同文件").length, text: "计划、报价和工期依据" }
  ];

  return (
    <div className="subpage-stack">
      <section className="panel documents-upload-panel">
        <PanelHeader title="上传资料" />
        <form className="upload-box compact" onSubmit={onSubmit}>
          <div className="upload-copy">
            <div className="upload-icon">
              <Upload size={20} />
            </div>
            <div>
              <h2>上传录音、文档、截图或表格</h2>
              <p>支持一次上传多个文件。上传只进入资料库，不会自动转写或编译。</p>
            </div>
          </div>
          <div className="upload-controls">
            <input type="file" multiple onChange={(event) => onFileChange(Array.from(event.target.files || []))} />
            <button className="primary-action" type="submit" disabled={!uploadFiles.length || (uploadProgress > 0 && uploadProgress < 100)}>
              {uploadFiles.length ? `上传 ${uploadFiles.length} 个文件` : "选择文件后开始"}
            </button>
          </div>
          <div className="upload-classifiers">
            <label>
              业务阶段
              <select value={uploadMetadata.documentStage} onChange={(event) => onUploadMetadataChange({ ...uploadMetadata, documentStage: event.target.value })}>
                {documentStageOptions.map((item) => <option value={item} key={item}>{item}</option>)}
              </select>
            </label>
            <label>
              资料分类
              <select value={uploadMetadata.documentPurpose} onChange={(event) => onUploadMetadataChange({ ...uploadMetadata, documentPurpose: event.target.value })}>
                {documentPurposeOptions.map((item) => <option value={item} key={item}>{item}</option>)}
              </select>
            </label>
          </div>
          {isAudio && (
            <div className="speaker-options">
              <div>
                <strong>会议人数</strong>
                <p>用于豆包语音识别的说话人聚类分离。</p>
              </div>
              <label>
                <Users size={16} />
                <select value={speakerCount} onChange={(event) => onSpeakerCountChange(Number(event.target.value))}>
                  {Array.from({ length: 10 }, (_, index) => index + 1).map((count) => (
                    <option value={count} key={count}>
                      {count} 人
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {uploadFiles.length ? (
            <div className="selected-file-list">
              {uploadFiles.map((file) => (
                <span key={`${file.name}-${file.size}`}>{file.name}</span>
              ))}
            </div>
          ) : null}
          {uploadProgress > 0 && uploadProgress < 100 ? <ProgressLine value={uploadProgress} label={`上传中 ${uploadProgress}%`} /> : null}
          {uploadStatus && <div className="success-banner">{uploadStatus}</div>}
        </form>
      </section>

      <section className="task-summary-grid document-stage-grid">
        {documentBuckets.map((bucket) => (
          <article className="summary-card" key={bucket.label}>
            <span>{bucket.label}</span>
            <strong>{bucket.value}</strong>
            <small>{bucket.text}</small>
          </article>
        ))}
      </section>

      <section className="panel documents-panel">
        <PanelHeader
          title="来源资料清单"
          action={batchCompiling ? "编译中..." : `一键编译新增${pendingCompileCount ? `（${pendingCompileCount}）` : ""}`}
          onAction={onCompileNew}
        />
        <div className="documents-intro">
          <div>
            <strong>原文件、转写稿和编译记录</strong>
            <p>点查看可预览原文件、解析文本、转录文本和编译状态；资料按需求确认文件、需求变更文件和合同文件区分，便于分阶段生成需求基线和变更建议。</p>
          </div>
          <span>{sourceFiles.length} 个来源文件</span>
        </div>
        {batchCompileStatus ? <div className="documents-batch-status">{batchCompileStatus}</div> : null}
        <div className="document-list">
          {sourceFiles.length ? (
            sourceFiles.map((source) => {
              const progress = ingestProgressBySource[source.id];
              const isProcessing = source.status === "processing" || progress?.status === "processing";
              const canIngest = shouldCompileSource(source) || isProcessing;
              return (
              <article className="document-card" key={source.id}>
                <div className="document-card-head">
                  <div className="document-icon">
                    {source.category === "audio" ? <FileAudio size={20} /> : <FileText size={20} />}
                  </div>
                  <div>
                    <h3>{source.title}</h3>
                    <p>{displaySourceName(source)}</p>
                  </div>
                  <div className="document-head-actions">
                    <span className={`status-chip ${source.status}`}>{statusLabel(source.status)}</span>
                    <button type="button" onClick={() => onOpenEditor(source, "edit")} title="编辑资料">
                      <PencilLine size={14} />
                      编辑
                    </button>
                  </div>
                </div>
                <p className="document-summary">{progress?.message || source.aiSummary || "尚未生成 AI 摘要，可点击编译或等待处理完成。"}</p>
                {isProcessing ? <ProgressLine value={progressValueForStep(progress?.step)} label={progress?.message || "后台处理中..."} /> : null}
                <div className="document-meta">
                  <span>{categoryLabel(source.category)}</span>
                  <span>{source.documentStage || "需求确认阶段"}</span>
                  <span>{source.documentPurpose || "通用资料"}</span>
                  {source.category === "audio" && source.speakerCount ? (
                    <span>说话人分离 · {source.speakerCount} 人</span>
                  ) : null}
                  {Object.keys(source.speakerLabels || {}).length ? (
                    <span>已标注说话人 · {Object.keys(source.speakerLabels || {}).length} 个</span>
                  ) : null}
                  <span>{formatBytes(source.size)}</span>
                  <span>{formatDate(source.uploadedAt)}</span>
                  <span>{source.uploadedBy || "当前用户"}</span>
                </div>
                <div className="document-actions">
                  <button type="button" onClick={() => onPreview(source.id)}>
                    <Eye size={15} />
                    查看
                  </button>
                  {canIngest ? (
                    <button
                      type="button"
                      onClick={() => onReingest(source.id)}
                      disabled={isProcessing}
                    >
                      {isProcessing ? <Loader2 className="spin" size={15} /> : <Sparkles size={15} />}
                      {isProcessing ? "处理中" : source.category === "audio" ? "转写并编译" : "编译"}
                    </button>
                  ) : null}
                  {hasSpeakerCandidates(source) ? (
                    <button type="button" onClick={() => onOpenEditor(source, "speakers")}>
                      <Users size={15} />
                      说话人
                    </button>
                  ) : null}
                </div>
              </article>
            );
            })
          ) : (
            <EmptyState icon={FileStack} title="暂无来源资料" text="上传文件后，这里会显示项目的原始文档、解析状态、转写稿和 AI 摘要。" />
          )}
        </div>
      </section>
    </div>
  );
}

function MaterialsView({ sourceFiles, onPreview, onOpenIngest }) {
  const materialFiles = sourceFiles.filter((source) => ["image", "audio", "spreadsheet", "excel"].includes(source.category));
  const buckets = [
    { label: "截图素材", value: materialFiles.filter((item) => item.category === "image").length, icon: FileText },
    { label: "录音素材", value: materialFiles.filter((item) => item.category === "audio").length, icon: FileAudio },
    { label: "表格素材", value: materialFiles.filter((item) => ["spreadsheet", "excel"].includes(item.category)).length, icon: Database }
  ];

  return (
    <div className="subpage-stack">
      <section className="panel subpage-hero">
        <div>
          <span>资料管理</span>
          <h2>素材库</h2>
          <p>集中管理项目沟通中的截图、录音、表格和辅助素材，后续可作为 Wiki 编译、界面说明和需求追溯的证据来源。</p>
        </div>
        {onOpenIngest ? (
          <button className="primary-action" type="button" onClick={onOpenIngest}>
            <Upload size={16} />
            导入素材
          </button>
        ) : null}
      </section>
      <section className="task-summary-grid">
        {buckets.map((bucket) => {
          const Icon = bucket.icon;
          return (
            <article className="summary-card" key={bucket.label}>
              <Icon size={18} />
              <span>{bucket.label}</span>
              <strong>{bucket.value}</strong>
              <small>已进入项目资料库</small>
            </article>
          );
        })}
      </section>
      <section className="panel documents-panel">
        <PanelHeader title="素材清单" />
        <div className="document-list">
          {materialFiles.length ? (
            materialFiles.map((source) => (
              <article
                className="document-card clickable"
                key={source.id}
                role="button"
                tabIndex={0}
                onClick={() => onPreview?.(source.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onPreview?.(source.id);
                  }
                }}
              >
                <div className="document-card-head">
                  <div className="document-icon">
                    {source.category === "audio" ? <FileAudio size={20} /> : <FileText size={20} />}
                  </div>
                  <div>
                    <h3>{source.title}</h3>
                    <p>{displaySourceName(source)}</p>
                  </div>
                  <span className={`status-chip ${source.status}`}>{statusLabel(source.status)}</span>
                </div>
                <p className="document-summary">{source.aiSummary || "该素材尚未生成摘要。"}</p>
                <div className="document-meta">
                  <span>{categoryLabel(source.category)}</span>
                  {source.category === "audio" && source.speakerCount ? (
                    <span>说话人分离 · {source.speakerCount} 人</span>
                  ) : null}
                  <span>{formatBytes(source.size)}</span>
                  <span>{formatDate(source.uploadedAt)}</span>
                </div>
                <div className="document-actions">
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onPreview?.(source.id);
                    }}
                  >
                    <Eye size={15} />
                    查看
                  </button>
                </div>
              </article>
            ))
          ) : (
            <EmptyState icon={FileStack} title="暂无素材" text="上传截图、录音或表格后，这里会按素材类型归档。" />
          )}
        </div>
      </section>
    </div>
  );
}

function RequirementsView({ requirements }) {
  return (
    <section className="panel table-panel">
      <PanelHeader title="需求管理闭环" />
      <div className="data-table">
        <div className="table-head requirements-grid">
          <span>模块</span>
          <span>需求</span>
          <span>状态</span>
          <span>优先级</span>
          <span>负责人</span>
        </div>
        {requirements.map((item) => (
          <article className="table-row requirements-grid" key={item.id}>
            <span>{item.moduleName}</span>
            <strong>{item.title}</strong>
            <span>{item.status}</span>
            <span>{item.priority}</span>
            <span>{item.owner}</span>
            <p>{item.description}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function RequirementPoolView({ requirements, changes }) {
  const modules = Array.from(
    requirements.reduce((map, requirement) => {
      const current = map.get(requirement.moduleName) || { moduleName: requirement.moduleName, total: 0, confirmed: 0, pending: 0, high: 0 };
      current.total += 1;
      if (requirement.status === "已确认") current.confirmed += 1;
      if (requirement.status === "待确认") current.pending += 1;
      if (requirement.priority === "高") current.high += 1;
      map.set(requirement.moduleName, current);
      return map;
    }, new Map()).values()
  );
  const pendingChanges = changes.filter((change) => change.status === "待确认").length;

  return (
    <div className="subpage-stack">
      <section className="panel subpage-hero">
        <div>
          <span>需求管理</span>
          <h2>需求池</h2>
          <p>需求池展示当前项目沉淀出的需求资产，按模块汇总确认状态、优先级和待确认变更，便于产品经理进入细化和确认流程。</p>
        </div>
        <div className="hero-metrics">
          <strong>{requirements.length}</strong>
          <span>总需求</span>
          <strong>{pendingChanges}</strong>
          <span>待确认变更</span>
        </div>
      </section>
      <section className="requirement-pool-grid">
        {modules.length ? (
          modules.map((module) => (
            <article className="panel pool-card" key={module.moduleName}>
              <div>
                <h3>{module.moduleName}</h3>
                <span>{module.total} 条需求</span>
              </div>
              <div className="pool-stats">
                <span>已确认 <strong>{module.confirmed}</strong></span>
                <span>待确认 <strong>{module.pending}</strong></span>
                <span>高优先级 <strong>{module.high}</strong></span>
              </div>
            </article>
          ))
        ) : (
          <section className="panel">
            <EmptyState icon={ClipboardList} title="暂无需求" text="导入资料后，AI 会把需求要点编译进需求池。" />
          </section>
        )}
      </section>
      <section className="panel table-panel">
        <PanelHeader title="需求清单" />
        <div className="data-table">
          <div className="table-head requirements-grid">
            <span>模块</span>
            <span>需求</span>
            <span>状态</span>
            <span>优先级</span>
            <span>负责人</span>
          </div>
          {requirements.length ? (
            requirements.map((item) => (
              <article className="table-row requirements-grid" key={item.id}>
                <span>{item.moduleName}</span>
                <strong>{item.title}</strong>
                <span>{item.status}</span>
                <span>{item.priority}</span>
                <span>{item.owner}</span>
                <p>{item.description}</p>
              </article>
            ))
          ) : (
            <EmptyState icon={ClipboardList} title="暂无需求清单" text="导入资料或新建需求后，这里会显示完整需求列表。" />
          )}
        </div>
      </section>
    </div>
  );
}

function RequirementSuggestionsView({
  suggestions,
  requirements,
  sourceFiles,
  wikiPages,
  status,
  generating,
  onGenerate,
  onAdopt,
  onDismiss,
  onDelete,
  onPreviewSource,
  onOpenChange,
  onOpenWiki
}) {
  const sourceById = useMemo(() => new Map(sourceFiles.map((item) => [item.id, item])), [sourceFiles]);
  const wikiPageById = useMemo(() => new Map(wikiPages.map((item) => [item.id, item])), [wikiPages]);
  const existingTitles = useMemo(() => new Set(requirements.map((item) => item.title)), [requirements]);
  const activeSuggestions = suggestions.filter((item) => !processedSuggestionStatuses.has(item.status));
  const processedCount = suggestions.length - activeSuggestions.length;
  const highConfidence = activeSuggestions.filter((item) => Number(item.confidence || 0) >= 0.7).length;

  return (
    <div className="subpage-stack">
      <section className="panel subpage-hero suggestion-hero">
        <div>
          <span>需求管理</span>
          <h2>需求建议</h2>
          <p>根据 LLM Wiki 已编译出的项目理解、变更、风险、待确认事项和来源资料，预测客户下一轮可能提出的需求。建议不会自动写入需求池，采纳后仍以待确认需求进入管理流程。</p>
        </div>
        <div className="suggestion-hero-actions">
          <div className="hero-metrics">
            <strong>{activeSuggestions.length}</strong>
            <span>待处理</span>
            <strong>{highConfidence}</strong>
            <span>高置信</span>
          </div>
          <button className="toolbar-action primary" type="button" onClick={onGenerate} disabled={generating}>
            {generating ? <Loader2 className="spin" size={16} /> : <Sparkles size={16} />}
            刷新预测
          </button>
        </div>
      </section>

      {status && <div className="suggestion-status">{status}</div>}
      {processedCount ? <div className="suggestion-status">已处理 {processedCount} 条建议，采纳或放弃后不会继续挂在待处理列表。</div> : null}

      <section className="suggestion-grid">
        {activeSuggestions.length ? (
          activeSuggestions.map((suggestion) => {
            const sources = (suggestion.sourceIds || []).map((id) => sourceById.get(id)).filter(Boolean);
            const pages = (suggestion.relatedWikiPageIds || []).map((id) => wikiPageById.get(id)).filter(Boolean);
            const alreadyExists = existingTitles.has(suggestion.title);
            return (
              <article className="panel suggestion-card" key={suggestion.id}>
                <div className="suggestion-card-head">
                  <span className={`priority priority-${suggestion.priority || "中"}`}>{suggestion.priority || "中"}</span>
                  <strong>{suggestion.title}</strong>
                  <span className="confidence-badge">{Math.round((suggestion.confidence || 0) * 100)}%</span>
                </div>
                <div className="suggestion-module">{suggestion.moduleName || "项目范围"}</div>
                <p>{suggestion.description}</p>

                <div className="suggestion-detail-grid">
                  <div>
                    <small>预测依据</small>
                    <span>{suggestion.reason || "基于 Wiki 编译结果推断。"}</span>
                  </div>
                  <div>
                    <small>客户可能会问</small>
                    <span>{suggestion.customerQuestion || "这个能力如何落地？"}</span>
                  </div>
                  <div>
                    <small>建议验收口径</small>
                    <span>{suggestion.acceptanceCriteria || "明确流程、权限、字段和确认标准。"}</span>
                  </div>
                </div>

                <div className="suggestion-links">
                  {sources.slice(0, 3).map((source) => (
                    <button key={source.id} type="button" onClick={() => onPreviewSource(source.id)}>
                      <FileText size={14} />
                      {source.title || source.originalName}
                    </button>
                  ))}
                  {pages.slice(0, 3).map((page) => (
                    <button key={page.id} type="button" onClick={() => onOpenWiki(page.id)}>
                      <BookOpen size={14} />
                      {page.title}
                    </button>
                  ))}
                  {(suggestion.relatedChangeIds || []).slice(0, 3).map((changeId) => (
                    <button key={changeId} type="button" onClick={() => onOpenChange(changeId)}>
                      <GitBranch size={14} />
                      关联变更
                    </button>
                  ))}
                </div>

                <div className="suggestion-actions">
                  <span>{suggestion.status || (suggestion.generatedBy === "wiki-rules" ? "Wiki 草案" : "LLM Wiki 预测")}</span>
                  <button type="button" onClick={() => onAdopt(suggestion)} disabled={alreadyExists}>
                    <Plus size={15} />
                    {alreadyExists ? "已在需求池" : "采纳为需求"}
                  </button>
                  <button type="button" onClick={() => onDismiss(suggestion.id, "已放弃")}>
                    <X size={15} />
                    放弃
                  </button>
                  <button type="button" onClick={() => onDelete(suggestion.id)}>
                    <X size={15} />
                    删除
                  </button>
                </div>
              </article>
            );
          })
        ) : (
          <section className="panel">
            <EmptyState icon={Sparkles} title={suggestions.length ? "需求建议已处理完" : "暂无需求建议"} text={suggestions.length ? "已采纳或放弃的建议不会继续停留在待处理列表。" : "导入并编译资料后，点击刷新预测生成客户可能提出的下一批需求。"} />
          </section>
        )}
      </section>
    </div>
  );
}

function ChangesView({ changes, onChangeStatus, onPreviewSource }) {
  return (
    <section className="panel table-panel">
      <PanelHeader title="变更待确认" />
      <div className="change-page-list">
        {changes.map((change) => {
          const canSubmitCustomer = ["待确认", "客户退回"].includes(change.status);
          const waitingCustomer = change.status === "需客户确认";
          const confirmed = change.status === "已确认";
          const rejected = change.status === "已驳回";
          return (
          <article className="change-page-card" id={`change-${change.id}`} key={change.id}>
            <div className="change-card-head">
              <span className={`type-tag ${typeClass(change.changeType)}`}>{change.changeType}</span>
              <strong>{change.moduleName} - {change.title}</strong>
              <span className="confidence-badge">{Math.round((change.confidence || 0) * 100)}%</span>
            </div>
            <p>{change.summary}</p>
            <div className="diff-grid">
              <div>
                <small>变更前</small>
                <span>{change.beforeContent || "无"}</span>
              </div>
              <div>
                <small>变更后</small>
                <span>{change.afterContent || "无"}</span>
              </div>
            </div>
            <ChangeTraceability change={change} onPreviewSource={onPreviewSource} />
            <div className="change-card-actions">
              <span>{change.status}</span>
              {canSubmitCustomer ? (
                <button type="button" onClick={() => onChangeStatus(change.id, "需客户确认")}>
                  <AlertTriangle size={15} /> 提交客户确认
                </button>
              ) : null}
              {waitingCustomer ? (
                <button type="button" disabled>
                  <AlertTriangle size={15} /> 等待客户确认
                </button>
              ) : null}
              {confirmed ? (
                <button type="button" disabled>
                  <Check size={15} /> 已写入需求
                </button>
              ) : null}
              {rejected ? (
                <button type="button" disabled>
                  <X size={15} /> 已驳回
                </button>
              ) : null}
              {!confirmed && !rejected ? (
                <button type="button" onClick={() => onChangeStatus(change.id, "已驳回")}>
                <X size={15} /> 驳回
                </button>
              ) : null}
            </div>
          </article>
          );
        })}
      </div>
    </section>
  );
}

function ChangeTraceability({ change, onPreviewSource }) {
  const source = change.sourceFile;
  const context = change.structuralContext || {};
  const relatedChanges = context.relatedChanges || [];
  const dependencyChanges = context.dependencyChanges || [];
  const relatedWikiPages = context.relatedWikiPages || [];
  const sameModuleRequirements = context.sameModuleRequirements || [];
  const evidences = change.evidences || [];

  if (!source && !context.requirement && !relatedChanges.length && !dependencyChanges.length && !relatedWikiPages.length && !sameModuleRequirements.length && !change.transcriptSnippet && !evidences.length) {
    return null;
  }

  return (
    <div className="change-traceability">
      <div className="change-trace-head">
        <strong>结构关联</strong>
        <span>来源、转录、需求和相互依赖</span>
      </div>

      <div className="change-trace-grid">
        {source ? (
          <div className="change-trace-block">
            <small>来源资料</small>
            <button className="trace-link-button" type="button" onClick={() => onPreviewSource?.(source.id)}>
              <FileText size={14} />
              {source.title || source.originalName}
            </button>
            <div className="trace-meta">
              <span>{categoryLabel(source.category)}</span>
              <span>{statusLabel(source.status)}</span>
              <span>{formatDate(source.uploadedAt)}</span>
            </div>
          </div>
        ) : null}

        {context.requirement ? (
          <div className="change-trace-block">
            <small>关联需求</small>
            <strong>{context.requirement.moduleName} - {context.requirement.title}</strong>
            <div className="trace-meta"><span>{context.requirement.status}</span></div>
          </div>
        ) : null}

        {change.transcriptSnippet ? (
          <div className="change-trace-block wide">
            <small>{change.transcriptSnippet.source}</small>
            <pre>{change.transcriptSnippet.text}</pre>
          </div>
        ) : null}

        {evidences.length ? (
          <div className="change-trace-block wide">
            <small>AI 判断依据</small>
            {evidences.slice(0, 2).map((evidence) => (
              <blockquote key={evidence.id}>
                {evidence.speaker ? <em>{evidence.speaker} </em> : null}
                {evidence.timestampStart ? <em>{evidence.timestampStart}{evidence.timestampEnd ? `-${evidence.timestampEnd}` : ""} </em> : null}
                {evidence.quote || "无引用片段"}
              </blockquote>
            ))}
          </div>
        ) : null}
      </div>

      {(relatedChanges.length || dependencyChanges.length || relatedWikiPages.length || sameModuleRequirements.length) ? (
        <div className="change-dependency-list">
          {dependencyChanges.length ? (
            <div>
              <small>依赖变更</small>
              <div className="dependency-chips">
                {dependencyChanges.map((item) => (
                  <button type="button" key={item.id} onClick={() => scrollToChange(item.id)}>
                    {item.moduleName} - {item.title}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {relatedChanges.length ? (
            <div>
              <small>相关变更</small>
              <div className="dependency-chips">
                {relatedChanges.map((item) => (
                  <button type="button" key={item.id} onClick={() => scrollToChange(item.id)}>
                    {item.relation}：{item.moduleName} - {item.title}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {relatedWikiPages.length ? (
            <div>
              <small>关联 Wiki</small>
              <div className="dependency-chips">
                {relatedWikiPages.map((item) => (
                  <span key={item.id}>{item.type}：{item.title}</span>
                ))}
              </div>
            </div>
          ) : null}

          {sameModuleRequirements.length ? (
            <div>
              <small>同模块需求</small>
              <div className="dependency-chips">
                {sameModuleRequirements.map((item) => (
                  <span key={item.id}>{item.status}：{item.title}</span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function CommunicationsView({ dashboard, changes = [], requirements = [], sourceFiles = [], wikiPages = [] }) {
  const records = dashboard?.communications || [];
  const meetingCount = records.filter((item) => item.type?.includes("会议") || item.title?.includes("会议")).length;
  const relatedChanges = records.reduce((sum, item) => sum + (item.relatedChangeCount || 0), 0);
  const graph = useMemo(
    () => buildCommunicationGraph({ records, changes, requirements, sourceFiles, wikiPages }),
    [records, changes, requirements, sourceFiles, wikiPages]
  );

  return (
    <div className="subpage-stack">
      <section className="task-summary-grid">
        <article className="summary-card">
          <MessagesSquare size={18} />
          <span>全部沟通</span>
          <strong>{records.length}</strong>
          <small>已归档</small>
        </article>
        <article className="summary-card">
          <CalendarDays size={18} />
          <span>会议记录</span>
          <strong>{meetingCount}</strong>
          <small>会议、评审、访谈</small>
        </article>
        <article className="summary-card">
          <GitBranch size={18} />
          <span>关联变更</span>
          <strong>{relatedChanges}</strong>
          <small>由沟通触发</small>
        </article>
      </section>
      <CommunicationForceGraph graph={graph} />
      <section className="panel table-panel">
        <PanelHeader title="沟通记录清单" />
        <div className="communication-list expanded">
          {records.length ? (
            records.map((item) => (
              <article className="communication-row" key={item.id}>
                <div className="communication-icon">
                  {item.type?.includes("会议") || item.title?.includes("会议") ? <CalendarDays size={18} /> : <MessageSquareText size={18} />}
                </div>
                <div>
                  <h3>{item.title}</h3>
                  <p>{item.type} · {item.summary}</p>
                  <small>参与人：{Array.isArray(item.participants) ? item.participants.join("、") : item.participants || "未记录"}</small>
                </div>
                <time>{formatDate(item.meetingTime || item.createdAt)}</time>
              </article>
            ))
          ) : (
            <EmptyState icon={MessagesSquare} title="暂无沟通记录" text="上传会议纪要、录音或沟通文档后，系统会自动归档。" />
          )}
        </div>
      </section>
    </div>
  );
}

function CommunicationForceGraph({ graph }) {
  const svgRef = useRef(null);
  const wrapRef = useRef(null);
  const [selectedNode, setSelectedNode] = useState(null);

  useEffect(() => {
    const wrapper = wrapRef.current;
    const svgElement = svgRef.current;
    if (!wrapper || !svgElement || !graph.nodes.length) return undefined;

    const width = Math.max(wrapper.clientWidth || 720, 520);
    const height = 460;
    const svg = d3.select(svgElement);
    svg.selectAll("*").remove();
    svg.attr("viewBox", `0 0 ${width} ${height}`).attr("role", "img");

    const root = svg.append("g");
    const zoom = d3
      .zoom()
      .scaleExtent([0.45, 2.8])
      .on("zoom", (event) => root.attr("transform", event.transform));
    svg.call(zoom);

    const links = graph.links.map((item) => ({ ...item }));
    const nodes = graph.nodes.map((item) => ({ ...item }));
    const linked = new Set(links.flatMap((link) => [`${link.source}->${link.target}`, `${link.target}->${link.source}`]));
    const color = d3.scaleOrdinal()
      .domain(["communication", "source", "change", "requirement", "wiki", "participant"])
      .range(["#2563eb", "#0f766e", "#f97316", "#16a34a", "#7c3aed", "#64748b"]);

    const link = root
      .append("g")
      .attr("class", "force-links")
      .selectAll("line")
      .data(links)
      .join("line")
      .attr("stroke-width", (d) => Math.max(1.2, d.weight || 1));

    const linkLabel = root
      .append("g")
      .attr("class", "force-link-labels")
      .selectAll("text")
      .data(links.filter((item) => item.label))
      .join("text")
      .text((d) => d.label);

    const node = root
      .append("g")
      .attr("class", "force-nodes")
      .selectAll("g")
      .data(nodes)
      .join("g")
      .attr("class", (d) => `force-node ${d.type}`)
      .call(
        d3.drag()
          .on("start", (event, d) => {
            if (!event.active) simulation.alphaTarget(0.3).restart();
            d.fx = d.x;
            d.fy = d.y;
          })
          .on("drag", (event, d) => {
            d.fx = event.x;
            d.fy = event.y;
          })
          .on("end", (event, d) => {
            if (!event.active) simulation.alphaTarget(0);
            d.fx = null;
            d.fy = null;
          })
      );

    node
      .append("circle")
      .attr("r", (d) => d.radius)
      .attr("fill", (d) => color(d.type))
      .attr("stroke", "#ffffff")
      .attr("stroke-width", 2);

    node
      .append("text")
      .attr("x", (d) => d.radius + 7)
      .attr("y", 4)
      .text((d) => truncateText(d.label, d.type === "communication" ? 18 : 12));

    node.append("title").text((d) => `${graphNodeTypeLabel(d.type)}：${d.label}`);

    node
      .on("click", (event, d) => {
        event.stopPropagation();
        setSelectedNode({
          id: d.id,
          type: d.type,
          label: d.label,
          description: d.description,
          meta: d.meta || []
        });
      })
      .on("mouseenter", function handleEnter(event, d) {
        node.classed("is-dimmed", (n) => n.id !== d.id && !linked.has(`${d.id}->${n.id}`));
        link.classed("is-highlighted", (l) => {
          const sourceId = typeof l.source === "object" ? l.source.id : l.source;
          const targetId = typeof l.target === "object" ? l.target.id : l.target;
          return sourceId === d.id || targetId === d.id;
        });
        d3.select(this).classed("is-active", true);
      })
      .on("mouseleave", function handleLeave() {
        node.classed("is-dimmed", false).classed("is-active", false);
        link.classed("is-highlighted", false);
      });

    svg.on("click", () => setSelectedNode(null));

    const simulation = d3
      .forceSimulation(nodes)
      .force("link", d3.forceLink(links).id((d) => d.id).distance((d) => d.distance || 92).strength(0.55))
      .force("charge", d3.forceManyBody().strength(-360))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collide", d3.forceCollide().radius((d) => d.radius + 22).iterations(2))
      .force("x", d3.forceX(width / 2).strength(0.035))
      .force("y", d3.forceY(height / 2).strength(0.045));

    simulation.on("tick", () => {
      link
        .attr("x1", (d) => d.source.x)
        .attr("y1", (d) => d.source.y)
        .attr("x2", (d) => d.target.x)
        .attr("y2", (d) => d.target.y);

      linkLabel
        .attr("x", (d) => (d.source.x + d.target.x) / 2)
        .attr("y", (d) => (d.source.y + d.target.y) / 2);

      node.attr("transform", (d) => `translate(${d.x},${d.y})`);
    });

    return () => simulation.stop();
  }, [graph]);

  return (
    <section className="panel force-graph-panel">
      <PanelHeader title="沟通关系导图" />
      <div className="force-graph-layout">
        <div className="force-graph-canvas" ref={wrapRef}>
          {graph.nodes.length ? (
            <svg ref={svgRef} aria-label="沟通记录关系导图" />
          ) : (
            <EmptyState icon={GitBranch} title="暂无可生成导图的数据" text="沟通记录归档后，会自动连接来源资料、变更、需求和 Wiki 页面。" />
          )}
        </div>
        <aside className="force-graph-side">
          <div>
            <strong>{selectedNode ? selectedNode.label : "点击节点查看详情"}</strong>
            <span>{selectedNode ? graphNodeTypeLabel(selectedNode.type) : "支持拖拽节点、滚轮缩放、悬浮高亮关系。"}</span>
          </div>
          {selectedNode?.description && <p>{selectedNode.description}</p>}
          {selectedNode?.meta?.length ? (
            <ul>
              {selectedNode.meta.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : null}
          <div className="force-graph-legend">
            {[
              ["communication", "沟通"],
              ["source", "资料"],
              ["change", "变更"],
              ["requirement", "需求"],
              ["wiki", "Wiki"],
              ["participant", "参与人"]
            ].map(([type, label]) => (
              <span key={type}>
                <i className={`legend-dot ${type}`} />
                {label}
              </span>
            ))}
          </div>
        </aside>
      </div>
    </section>
  );
}

function MeetingRecordsView({ dashboard }) {
  const records = (dashboard?.communications || []).filter((item) => item.type?.includes("会议") || item.title?.includes("会议"));

  return (
    <div className="subpage-stack">
      <section className="panel subpage-hero">
        <div>
          <span>沟通管理</span>
          <h2>会议记录</h2>
          <p>按会议维度沉淀参与人、会议摘要、转写状态和关联变更，用于复盘每次需求沟通对项目范围的影响。</p>
        </div>
        <div className="hero-metrics">
          <strong>{records.length}</strong>
          <span>会议</span>
          <strong>{records.reduce((sum, item) => sum + (item.relatedChangeCount || 0), 0)}</strong>
          <span>关联变更</span>
        </div>
      </section>
      <section className="panel table-panel">
        <PanelHeader title="会议清单" />
        <div className="communication-list expanded">
          {records.length ? (
            records.map((item) => (
              <article className="communication-row meeting-row" key={item.id}>
                <div className="communication-icon">
                  <CalendarDays size={18} />
                </div>
                <div>
                  <h3>{item.title}</h3>
                  <p>{item.type} · {item.summary}</p>
                  <small>参与人：{Array.isArray(item.participants) ? item.participants.join("、") : item.participants || "未记录"}</small>
                </div>
                <time>{formatDate(item.meetingTime || item.createdAt)}</time>
              </article>
            ))
          ) : (
            <EmptyState icon={CalendarDays} title="暂无会议记录" text="上传会议纪要或录音后，系统会自动生成会议记录。" />
          )}
        </div>
      </section>
    </div>
  );
}

function MilestonesView({ project }) {
  return (
    <div className="subpage-stack">
      <section className="panel subpage-hero">
        <div>
          <span>项目管理</span>
          <h2>里程碑</h2>
          <p>展示从需求沟通、原型设计、开发、测试到上线的阶段计划，后续可以关联需求冻结、客户确认和交付风险。</p>
        </div>
        <div className="hero-metrics">
          <strong>{project?.stage || "需求沟通阶段"}</strong>
          <span>当前阶段</span>
        </div>
      </section>
      <section className="panel milestone-panel">
        <PanelHeader title="项目阶段计划" />
        <div className="milestones expanded">
          {milestoneItems().map((item, index, list) => (
            <article className={item.active ? "milestone active" : "milestone"} key={item.title}>
              {index < list.length - 1 && <i className="milestone-line" />}
              <div className="milestone-icon">
                {item.active ? <GitBranch size={17} /> : <FileText size={16} />}
              </div>
              <div>
                <h3>{item.title}</h3>
                <p>{item.status}</p>
                <span>{item.date}</span>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function TasksView({ tasks, onTaskStatus, onOpenChanges }) {
  const openTasks = tasks.filter((task) => !isTaskDone(task.status));
  const changeTasks = tasks.filter((task) => task.entityType === "change").length;
  const riskTasks = tasks.filter((task) => task.entityType === "risk").length;
  const questionTasks = tasks.filter((task) => task.entityType === "question").length;

  return (
    <div className="task-layout">
      <section className="task-summary-grid">
        <article className="summary-card">
          <span>待处理任务</span>
          <strong>{openTasks.length}</strong>
          <small>来自变更、风险、待确认事项</small>
        </article>
        <article className="summary-card">
          <span>变更确认</span>
          <strong>{changeTasks}</strong>
          <small>可直接进入确认闭环</small>
        </article>
        <article className="summary-card">
          <span>风险跟进</span>
          <strong>{riskTasks}</strong>
          <small>影响范围、交付、报价</small>
        </article>
        <article className="summary-card">
          <span>客户待确认</span>
          <strong>{questionTasks}</strong>
          <small>来源于 AI 编译结论</small>
        </article>
      </section>

      <section className="panel task-panel">
        <PanelHeader title="任务管理" action="查看变更记录" onAction={onOpenChanges} />
        <div className="task-list">
          {tasks.length ? (
            tasks.map((task) => {
              const changeCanSubmitCustomer = task.entityType === "change" && ["待确认", "客户退回"].includes(task.status);
              const changeWaitingCustomer = task.entityType === "change" && task.status === "需客户确认";
              return (
              <article className="task-card" key={task.id}>
                <div className="task-card-head">
                  <span className={`task-type ${task.entityType}`}>{task.type}</span>
                  <strong>{task.title}</strong>
                  <span className={`priority ${priorityClass(task.priority)}`}>{task.priority}</span>
                </div>
                <p>{task.summary}</p>
                <div className="task-meta">
                  <span>{task.moduleName}</span>
                  <span>{task.owner}</span>
                  <span>{formatDate(task.createdAt)}</span>
                  <span>{task.status}</span>
                </div>
                <div className="task-actions">
                  {task.entityType !== "change" && !isTaskDone(task.status) && (
                    <button type="button" onClick={() => onTaskStatus(task, task.entityType === "risk" ? "已关闭" : "已确认")}>
                      <Check size={15} />
                      标记完成
                    </button>
                  )}
                  {changeCanSubmitCustomer && (
                    <>
                      <button type="button" onClick={() => onTaskStatus(task, "需客户确认")}>
                        <AlertTriangle size={15} />
                        提交客户确认
                      </button>
                      <button type="button" onClick={() => onTaskStatus(task, "已驳回")}>
                        <X size={15} />
                        驳回
                      </button>
                    </>
                  )}
                  {changeWaitingCustomer ? (
                    <button type="button" disabled>
                      <AlertTriangle size={15} />
                      等待客户确认
                    </button>
                  ) : null}
                </div>
              </article>
              );
            })
          ) : (
            <EmptyState icon={ListChecks} title="暂无任务" text="待确认变更、风险和待确认事项会自动汇总到这里。" />
          )}
        </div>
      </section>
    </div>
  );
}

function MembersView({ members, form, onChange, onSubmit }) {
  return (
    <div className="members-layout">
      <section className="panel members-panel">
        <PanelHeader title="客户与成员" />
        <div className="member-list">
          {members.map((member) => (
            <article className="member-card" key={member.id}>
              <div className="member-avatar">{member.name.slice(0, 1)}</div>
              <div className="member-copy">
                <div>
                  <strong>{member.name}</strong>
                  <span>{member.side} · {member.role}</span>
                </div>
                <p>{member.permissions.join("、")}</p>
              </div>
              <div className="member-stats">
                <span>需求 {member.requirementsOwned}</span>
                <span>变更 {member.changesRaised}</span>
                <span>待办 {member.pendingTasks}</span>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="panel member-form-panel">
        <PanelHeader title="新增成员" />
        <form className="member-form" onSubmit={onSubmit}>
          <label>
            成员姓名
            <input value={form.name} onChange={(event) => onChange({ ...form, name: event.target.value })} placeholder="例如：陈晨" />
          </label>
          <label>
            项目角色
            <select value={form.projectRole} onChange={(event) => onChange({ ...form, projectRole: event.target.value })}>
              <option value="项目经理">项目经理</option>
              <option value="产品经理">产品经理</option>
              <option value="开发负责人">开发负责人</option>
              <option value="销售/客户成功">销售/客户成功</option>
              <option value="客户负责人">客户负责人</option>
              <option value="客户成员">客户成员</option>
            </select>
          </label>
          <label>
            人员身份
            <select value={form.userRole} onChange={(event) => onChange({ ...form, userRole: event.target.value })}>
              <option value="项目经理">项目经理</option>
              <option value="产品经理">产品经理</option>
              <option value="开发负责人">开发负责人</option>
              <option value="客户负责人">客户负责人</option>
              <option value="业务代表">业务代表</option>
            </select>
          </label>
          <button className="primary-action" type="submit">
            <Plus size={16} />
            添加成员
          </button>
        </form>
      </section>
    </div>
  );
}

function AdminProjectsView({ projects, users, selectedProjectId, onSelectProject, form, onFormChange, onSubmit, onUpdateProject, onDeleteProject, onAttachUser }) {
  const [query, setQuery] = useState("");
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingProject, setEditingProject] = useState(null);
  const [attachMenu, setAttachMenu] = useState("");
  const selectedProject = projects.find((item) => item.id === selectedProjectId) || projects[0];
  const managers = users.filter((item) => item.systemRole === "project_manager" || item.systemRole === "admin");
  const projectMembers = [...(selectedProject?.managers || []), ...(selectedProject?.users || [])];
  const filteredProjects = projects.filter((project) => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return true;
    return [project.name, project.customerName, project.owner?.name]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(keyword));
  });
  const attachCandidates = attachMenu === "manager"
    ? users.filter((item) => item.systemRole === "project_manager" || item.systemRole === "admin")
    : users.filter((item) => item.systemRole !== "admin");

  async function submitCreateProject(event) {
    await onSubmit(event);
    setShowCreateModal(false);
  }

  async function submitEditProject(event) {
    event.preventDefault();
    if (!editingProject?.id) return;
    await onUpdateProject(editingProject.id, {
      name: editingProject.name,
      customerName: editingProject.customerName,
      stage: editingProject.stage,
      status: editingProject.status,
      ownerId: editingProject.ownerId,
      expectedEndDate: editingProject.expectedEndDate
    });
    setEditingProject(null);
  }

  async function deleteSelectedProject() {
    if (!selectedProject) return;
    const confirmed = window.confirm(`确认删除项目「${selectedProject.name}」吗？删除后该项目的资料、Wiki、需求、变更和成员关系都会被移除。`);
    if (!confirmed) return;
    await onDeleteProject(selectedProject.id);
  }

  async function attachSelectedUser(userId) {
    if (!userId) return;
    await onAttachUser(userId, attachMenu === "manager" ? "manager" : "customer");
    setAttachMenu("");
  }

  return (
    <div className="admin-project-workbench">
      <aside className="admin-project-sidebar">
        <div className="admin-project-sidebar-head">
          <h2>项目</h2>
          <div className="admin-project-search">
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目名称或客户" />
            <Search size={17} />
          </div>
        </div>
        <div className="admin-project-list">
          {filteredProjects.map((project) => (
            <button key={project.id} className={project.id === selectedProject?.id ? "admin-project-card active" : "admin-project-card"} type="button" onClick={() => onSelectProject(project.id)}>
              <span>
                <strong>{project.name}</strong>
                <small>{project.customerName || "未填写客户"} · {project.owner?.name || "未分配项目经理"}</small>
              </span>
              <i className={`project-status ${projectStatusClass(project.status)}`}>{projectStatusLabel(project.status)}</i>
            </button>
          ))}
          {!filteredProjects.length ? <EmptyState icon={Search} title="未找到项目" text="换一个关键词再试。" /> : null}
        </div>
        <button className="admin-create-project-button" type="button" onClick={() => setShowCreateModal(true)}>
          <Plus size={17} />
          新建项目
        </button>
      </aside>

      <section className="admin-project-detail">
        {selectedProject ? (
          <>
            <div className="admin-project-hero">
              <div className="admin-project-icon"><LayoutDashboard size={28} /></div>
              <div className="admin-project-title">
                <h2>{selectedProject.name}</h2>
                <p>
                  客户：{selectedProject.customerName || "未填写客户"} · 项目经理：{selectedProject.owner?.name || "未分配"} ·
                  <span>{selectedProject.stage || "未设置阶段"}</span>
                  <i className={`project-status ${projectStatusClass(selectedProject.status)}`}>{projectStatusLabel(selectedProject.status)}</i>
                </p>
              </div>
              <div className="admin-project-hero-actions">
                <button className="secondary-action" type="button" onClick={() => setEditingProject(projectToAdminEditForm(selectedProject))}>
                  <PencilLine size={16} />
                  编辑项目
                </button>
                <button className="danger-action" type="button" onClick={deleteSelectedProject}>
                  <X size={16} />
                  删除项目
                </button>
              </div>
            </div>

            <div className="admin-detail-card">
              <div className="admin-section-head">
                <h3><Users size={17} /> 成员管理</h3>
                <div className="admin-section-actions">
                  <button className="secondary-action" type="button" onClick={() => setAttachMenu(attachMenu === "manager" ? "" : "manager")}>
                    添加项目经理 <ChevronDown size={14} />
                  </button>
                  <button className="secondary-action" type="button" onClick={() => setAttachMenu(attachMenu === "member" ? "" : "member")}>
                    添加客户/成员 <ChevronDown size={14} />
                  </button>
                </div>
                {attachMenu ? (
                  <div className="admin-attach-popover">
                    <strong>{attachMenu === "manager" ? "选择项目经理" : "选择客户或成员"}</strong>
                    {attachCandidates.map((candidate) => (
                      <button key={candidate.id} type="button" onClick={() => attachSelectedUser(candidate.id)}>
                        <span>{candidate.name}</span>
                        <small>{roleText(candidate.systemRole)} · {candidate.account}</small>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="admin-member-table">
                <div className="admin-member-row head">
                  <span>姓名</span>
                  <span>角色</span>
                  <span>身份类型</span>
                  <span>手机号状态</span>
                  <span>账号状态</span>
                  <span>操作</span>
                </div>
                {projectMembers.map((member) => (
                  <div className="admin-member-row" key={member.id}>
                    <span className="member-name-cell"><b>{member.name.slice(0, 1)}</b><strong>{member.name}</strong>{member.isPrimaryManager ? <em>主项目经理</em> : null}</span>
                    <span>{member.role || roleText(member.systemRole)}</span>
                    <span>{memberTypeLabel(member.memberType)} · {member.account}</span>
                    <span>{member.phone || "未填写手机号"}</span>
                    <span><i className={`account-dot ${member.status === "active" ? "active" : "disabled"}`} /> {member.status || "active"}</span>
                    <span><button className="row-more-button" type="button" title="更多操作">...</button></span>
                  </div>
                ))}
                {!projectMembers.length ? <div className="admin-member-empty">暂无成员，请先添加项目经理或客户成员。</div> : null}
              </div>
            </div>

            <div className="admin-detail-card">
              <div className="admin-section-head">
                <h3><FileText size={17} /> 项目动态</h3>
                <button className="secondary-action" type="button">全部类型</button>
              </div>
              <div className="admin-project-timeline">
                {(selectedProject.recentLogs || []).map((log) => (
                  <article className="admin-timeline-item" key={log.id}>
                    <time><strong>{formatDate(log.createdAt)}</strong><small>{formatTime(log.createdAt)}</small></time>
                    <span className={isAiActor(log) ? "timeline-actor ai" : "timeline-actor"}>{log.actorName || log.actor || "当前用户"}</span>
                    <p>{log.detail || log.action}</p>
                  </article>
                ))}
                {!(selectedProject.recentLogs || []).length ? <div className="admin-member-empty">暂无项目动态。</div> : null}
              </div>
            </div>
          </>
        ) : <EmptyState icon={LayoutDashboard} title="暂无项目" text="先创建一个项目并指定项目经理。" />}
      </section>
      {showCreateModal ? (
        <AdminProjectCreateModal
          form={form}
          managers={managers}
          onChange={onFormChange}
          onClose={() => setShowCreateModal(false)}
          onSubmit={submitCreateProject}
        />
      ) : null}
      {editingProject ? (
        <AdminProjectEditModal
          form={editingProject}
          managers={managers}
          onChange={setEditingProject}
          onClose={() => setEditingProject(null)}
          onSubmit={submitEditProject}
        />
      ) : null}
    </div>
  );
}

function projectToAdminEditForm(project) {
  return {
    id: project.id,
    name: project.name || "",
    customerName: project.customerName || "",
    stage: project.stage || "需求沟通阶段",
    status: project.status || "active",
    ownerId: project.ownerId || project.owner?.id || "",
    expectedEndDate: project.expectedEndDate?.slice(0, 10) || ""
  };
}

function AdminProjectCreateModal({ form, managers, onChange, onClose, onSubmit }) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="project-modal" role="dialog" aria-modal="true" aria-labelledby="admin-project-modal-title">
        <div className="modal-header">
          <div>
            <h2 id="admin-project-modal-title">新建项目</h2>
            <p>填写项目基础信息，并指定首位项目经理。</p>
          </div>
          <button className="modal-close" type="button" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </div>
        <form className="project-form" onSubmit={onSubmit}>
          <label>项目名称<input value={form.name} onChange={(event) => onChange({ ...form, name: event.target.value })} placeholder="例如：智慧零售系统" required autoFocus /></label>
          <label>客户名称<input value={form.customerName} onChange={(event) => onChange({ ...form, customerName: event.target.value })} placeholder="例如：星河商业集团" /></label>
          <label>
            指定项目经理
            <select value={form.ownerId} onChange={(event) => onChange({ ...form, ownerId: event.target.value })}>
              <option value="">选择项目经理</option>
              {managers.map((user) => <option key={user.id} value={user.id}>{user.name} · {user.account}</option>)}
            </select>
          </label>
          <label>
            项目阶段
            <select value={form.stage} onChange={(event) => onChange({ ...form, stage: event.target.value })}>
              <option value="需求沟通阶段">需求沟通阶段</option>
              <option value="需求确认">需求确认</option>
              <option value="原型设计">原型设计</option>
              <option value="开发阶段">开发阶段</option>
              <option value="测试验收">测试验收</option>
            </select>
          </label>
          <label>预计结束日期<input type="date" value={form.expectedEndDate} onChange={(event) => onChange({ ...form, expectedEndDate: event.target.value })} /></label>
          <div className="modal-actions">
            <button className="secondary-action" type="button" onClick={onClose}>取消</button>
            <button className="primary-action" type="submit"><Plus size={16} /> 创建项目</button>
          </div>
        </form>
      </section>
    </div>
  );
}

function AdminProjectEditModal({ form, managers, onChange, onClose, onSubmit }) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="project-modal" role="dialog" aria-modal="true" aria-labelledby="admin-project-edit-modal-title">
        <div className="modal-header">
          <div>
            <h2 id="admin-project-edit-modal-title">编辑项目</h2>
            <p>修改项目基础信息、主项目经理和项目状态。</p>
          </div>
          <button className="modal-close" type="button" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </div>
        <form className="project-form" onSubmit={onSubmit}>
          <label>项目名称<input value={form.name} onChange={(event) => onChange({ ...form, name: event.target.value })} required autoFocus /></label>
          <label>客户名称<input value={form.customerName} onChange={(event) => onChange({ ...form, customerName: event.target.value })} /></label>
          <label>
            主项目经理
            <select value={form.ownerId} onChange={(event) => onChange({ ...form, ownerId: event.target.value })}>
              <option value="">选择项目经理</option>
              {managers.map((user) => <option key={user.id} value={user.id}>{user.name} · {user.account}</option>)}
            </select>
          </label>
          <label>
            项目阶段
            <select value={form.stage} onChange={(event) => onChange({ ...form, stage: event.target.value })}>
              <option value="需求沟通阶段">需求沟通阶段</option>
              <option value="需求确认">需求确认</option>
              <option value="原型设计">原型设计</option>
              <option value="开发阶段">开发阶段</option>
              <option value="测试验收">测试验收</option>
            </select>
          </label>
          <label>
            项目状态
            <select value={form.status} onChange={(event) => onChange({ ...form, status: event.target.value })}>
              <option value="active">进行中</option>
              <option value="pending">待确认</option>
              <option value="completed">已完成</option>
              <option value="archived">已归档</option>
            </select>
          </label>
          <label>预计结束日期<input type="date" value={form.expectedEndDate} onChange={(event) => onChange({ ...form, expectedEndDate: event.target.value })} /></label>
          <div className="modal-actions">
            <button className="secondary-action" type="button" onClick={onClose}>取消</button>
            <button className="primary-action" type="submit"><Check size={16} /> 保存修改</button>
          </div>
        </form>
      </section>
    </div>
  );
}

function AdminUsersView({ users, form, onFormChange, onSubmit, onRefresh }) {
  const managedUsers = useMemo(() => users.filter((user) => ["project_manager", "customer"].includes(user.systemRole)), [users]);
  const [query, setQuery] = useState("");
  const [selectedUserId, setSelectedUserId] = useState("");
  const [editing, setEditing] = useState(null);
  const [showCreateModal, setShowCreateModal] = useState(false);

  const filteredUsers = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return managedUsers;
    return managedUsers.filter((user) => {
      return [user.name, user.account].some((value) => String(value || "").toLowerCase().includes(keyword));
    });
  }, [managedUsers, query]);

  const selectedUser = managedUsers.find((user) => user.id === selectedUserId) || filteredUsers[0] || managedUsers[0] || null;
  const activeEditing = editing && selectedUser && editing.id === selectedUser.id;

  useEffect(() => {
    if (!managedUsers.length) {
      setSelectedUserId("");
      setEditing(null);
      return;
    }
    if (!selectedUserId || !managedUsers.some((user) => user.id === selectedUserId)) {
      setSelectedUserId(managedUsers[0].id);
      setEditing(null);
    }
  }, [managedUsers, selectedUserId]);

  function openCreateModal() {
    onFormChange({ name: "", account: "", phone: "", email: "", systemRole: "customer", password: "123456", status: "active" });
    setShowCreateModal(true);
  }

  async function createUser(event) {
    await onSubmit(event);
    setShowCreateModal(false);
  }

  function selectUser(user) {
    setSelectedUserId(user.id);
    setEditing(null);
  }

  function startEdit() {
    if (!selectedUser) return;
    setEditing({ ...selectedUser });
  }

  async function saveUser(event) {
    event.preventDefault();
    if (!editing) return;
    await apiPatch(`/admin/users/${editing.id}`, {
      name: editing.name,
      account: editing.account,
      phone: editing.phone || "",
      email: editing.email || "",
      systemRole: editing.systemRole,
      status: editing.status || "active"
    });
    const userId = editing.id;
    setEditing(null);
    setSelectedUserId(userId);
    await onRefresh();
  }

  async function resetPassword(user) {
    const password = window.prompt(`请输入 ${user.name} 的新密码`, "123456");
    if (!password) return;
    await apiPost(`/admin/users/${user.id}/reset-password`, { password });
    await onRefresh();
  }

  return (
    <div className="admin-users-workbench">
      <section className="admin-users-list-panel">
        <div className="admin-users-list-head">
          <h2>用户列表</h2>
          <div className="admin-user-search-row">
            <label className="admin-user-search">
              <Search size={16} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索姓名或账号" />
            </label>
            <button className="primary-action" type="button" onClick={openCreateModal}>
              <Plus size={16} />
              新增用户
            </button>
          </div>
        </div>
        <div className="admin-user-list">
          {filteredUsers.map((user) => (
            <button
              className={selectedUser?.id === user.id ? "admin-user-list-item active" : "admin-user-list-item"}
              key={user.id}
              type="button"
              onClick={() => selectUser(user)}
            >
              <b>{userInitial(user.name)}</b>
              <span>
                <strong>{user.name}</strong>
                <small>{user.account} · {(user.memberships || []).length} 个项目</small>
              </span>
              <em className={`admin-role-tag ${user.systemRole === "project_manager" ? "pm" : "customer"}`}>{roleText(user.systemRole)}</em>
              <i className="admin-user-status"><span />{user.status || "active"}</i>
            </button>
          ))}
          {!filteredUsers.length ? <div className="admin-empty-state">暂无匹配用户</div> : null}
        </div>
      </section>

      <section className="admin-user-detail-panel">
        <h2>用户信息</h2>
        {selectedUser ? (
          <form className="admin-user-detail-form" onSubmit={saveUser}>
            <div className="admin-user-detail-head">
              <div className="admin-user-profile">
                <b>{userInitial(selectedUser.name)}</b>
                <div>
                  <div className="admin-user-title-row">
                    <h3>{selectedUser.name}</h3>
                    <em className={`admin-role-tag ${selectedUser.systemRole === "project_manager" ? "pm" : "customer"}`}>{roleText(selectedUser.systemRole)}</em>
                  </div>
                  <p>账号：{selectedUser.account}</p>
                  <i className="admin-user-status"><span />{selectedUser.status || "active"}</i>
                </div>
              </div>
              {activeEditing ? (
                <div className="admin-user-inline-actions">
                  <button className="secondary-action" type="button" onClick={() => setEditing(null)}>取消</button>
                  <button className="primary-action" type="submit"><Check size={16} /> 保存</button>
                </div>
              ) : (
                <button className="secondary-action" type="button" onClick={startEdit}>
                  <PencilLine size={16} />
                  编辑
                </button>
              )}
            </div>

            <div className="admin-user-section">
              <h3>基本信息</h3>
              {activeEditing ? (
                <div className="admin-user-form-grid">
                  <label>姓名<input value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} required /></label>
                  <label>登录账号<input value={editing.account} onChange={(event) => setEditing({ ...editing, account: event.target.value })} required /></label>
                  <label>手机号<input value={editing.phone || ""} onChange={(event) => setEditing({ ...editing, phone: event.target.value })} /></label>
                  <label>邮箱<input value={editing.email || ""} onChange={(event) => setEditing({ ...editing, email: event.target.value })} /></label>
                  <label>
                    角色
                    <select value={editing.systemRole} onChange={(event) => setEditing({ ...editing, systemRole: event.target.value })}>
                      <option value="project_manager">项目经理</option>
                      <option value="customer">客户</option>
                    </select>
                  </label>
                </div>
              ) : (
                <div className="admin-user-info-grid">
                  <UserInfoRow label="姓名" value={selectedUser.name} />
                  <UserInfoRow label="登录账号" value={selectedUser.account} />
                  <UserInfoRow label="手机号" value={selectedUser.phone || "无手机号"} />
                  <UserInfoRow label="邮箱" value={selectedUser.email || "未设置"} />
                  <UserInfoRow label="角色" value={roleText(selectedUser.systemRole)} />
                </div>
              )}
            </div>

            <div className="admin-user-section">
              <h3>项目权限</h3>
              {(selectedUser.memberships || []).length ? (
                <div className="admin-user-project-list">
                  {selectedUser.memberships.map((membership) => (
                    <article className="admin-user-project-row" key={membership.id}>
                      <span>
                        <strong>{membership.projectName}</strong>
                        <small>{memberTypeLabel(membership.memberType)} · {membership.role || roleText(selectedUser.systemRole)}</small>
                      </span>
                      {membership.isPrimaryManager ? <em>主项目经理</em> : null}
                    </article>
                  ))}
                </div>
              ) : (
                <div className="admin-empty-state compact">未绑定项目</div>
              )}
            </div>

            <div className="admin-user-section">
              <h3>操作</h3>
              <div className="admin-user-security-row">
                <span>登录密码</span>
                <strong>********</strong>
                <button className="secondary-action" type="button" onClick={() => resetPassword(selectedUser)}>重置密码</button>
              </div>
            </div>
          </form>
        ) : (
          <div className="admin-empty-state">暂无用户，请先新增项目经理或客户。</div>
        )}
      </section>

      {showCreateModal && (
        <div className="modal-backdrop" role="presentation">
          <section className="project-modal" role="dialog" aria-modal="true" aria-labelledby="admin-user-create-title">
            <div className="modal-header">
              <h2 id="admin-user-create-title">新增用户</h2>
              <button className="modal-close" type="button" onClick={() => setShowCreateModal(false)}><X size={18} /></button>
            </div>
            <form className="project-form" onSubmit={createUser}>
              <label>姓名<input value={form.name} onChange={(event) => onFormChange({ ...form, name: event.target.value })} required /></label>
              <label>登录账号<input value={form.account} onChange={(event) => onFormChange({ ...form, account: event.target.value })} required /></label>
              <label>手机号<input value={form.phone} onChange={(event) => onFormChange({ ...form, phone: event.target.value })} /></label>
              <label>邮箱<input value={form.email} onChange={(event) => onFormChange({ ...form, email: event.target.value })} /></label>
              <label>
                角色
                <select value={form.systemRole} onChange={(event) => onFormChange({ ...form, systemRole: event.target.value })}>
                  <option value="project_manager">项目经理</option>
                  <option value="customer">客户</option>
                </select>
              </label>
              <label>初始密码<input value={form.password} onChange={(event) => onFormChange({ ...form, password: event.target.value })} required /></label>
              <div className="modal-actions">
                <button className="secondary-action" type="button" onClick={() => setShowCreateModal(false)}>取消</button>
                <button className="primary-action" type="submit"><Plus size={16} /> 创建用户</button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}

function UserInfoRow({ label, value }) {
  return (
    <div className="admin-user-info-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function AdminAuditLogsView({ logs }) {
  return (
    <section className="panel settings-panel">
      <PanelHeader title="操作记录" />
      <div className="audit-log-list">
        {logs.map((log) => (
          <article key={log.id} className="audit-log-row">
            <strong>{log.action}</strong>
            <span>{log.actorName || log.actor} · {formatDate(log.createdAt)}</span>
            <p>{log.detail}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function ModelsView({
  registry,
  form,
  onFormChange,
  onSubmit,
  onCreateAdapter,
  onAdapterStatus,
  onAdapterConfig,
  onPipelineChange,
  onAdapterTest,
  testResults,
  testingAdapterId
}) {
  const capabilities = registry.capabilities || [];
  const adapters = registry.adapters || [];
  const pipeline = registry.pipeline || {};
  const [selectedCapability, setSelectedCapability] = useState("LLM");
  const selectedCapabilityMeta = capabilities.find((item) => item.key === selectedCapability) || { key: selectedCapability, label: capabilityLabel(selectedCapability) };
  const selectedAdapter = adapters.find((adapter) => adapter.id === pipeline[selectedCapability])
    || adapters.find((adapter) => adapter.capability === selectedCapability)
    || null;
  const [draft, setDraft] = useState(() => modelAdapterToConfigDraft(selectedAdapter, selectedCapability));
  const [showApiKey, setShowApiKey] = useState(false);
  const [testPrompt, setTestPrompt] = useState("请用一句话介绍人工智能。");
  const [localTestResult, setLocalTestResult] = useState(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(modelAdapterToConfigDraft(selectedAdapter, selectedCapability));
    setLocalTestResult(null);
    setShowApiKey(false);
  }, [
    selectedCapability,
    selectedAdapter?.id,
    selectedAdapter?.model,
    selectedAdapter?.baseUrl,
    selectedAdapter?.provider,
    selectedAdapter?.protocol,
    selectedAdapter?.appKey,
    selectedAdapter?.envVarName,
    selectedAdapter?.timeoutSeconds
  ]);

  const testResult = localTestResult || (draft.id ? testResults[draft.id] : null);

  function updateDraft(patch) {
    setDraft((current) => {
      const next = { ...current, ...patch };
      if (patch.provider) return { ...next, ...providerDefaults(patch.provider, current.capability) };
      return next;
    });
  }

  function newModelDraft() {
    setDraft(modelAdapterToConfigDraft(null, selectedCapability));
    setLocalTestResult(null);
    setShowApiKey(false);
  }

  function buildPayload() {
    return {
      name: draft.name || `${selectedCapabilityMeta.label}配置`,
      capability: selectedCapability,
      provider: draft.provider,
      protocol: draft.protocol,
      model: draft.model,
      baseUrl: draft.baseUrl,
      appKey: draft.appKey,
      apiKey: draft.apiKey,
      envVarName: draft.envVarName,
      status: "active",
      description: draft.description || `${selectedCapabilityMeta.label}配置`,
      timeoutSeconds: Number(draft.timeoutSeconds) || 120
    };
  }

  async function saveConfig(event) {
    event?.preventDefault();
    setSaving(true);
    try {
      const payload = buildPayload();
      if (draft.id) {
        await onAdapterConfig(draft.id, payload);
        if (pipeline[selectedCapability] !== draft.id) await onPipelineChange(selectedCapability, draft.id);
      } else {
        const adapter = await onCreateAdapter(payload);
        if (adapter?.id) {
          await onPipelineChange(selectedCapability, adapter.id);
          setDraft((current) => ({ ...current, id: adapter.id, apiKey: "" }));
        }
      }
    } finally {
      setSaving(false);
    }
  }

  async function resetConfig() {
    setDraft(modelAdapterToConfigDraft(selectedAdapter, selectedCapability));
    setLocalTestResult(null);
    setShowApiKey(false);
  }

  async function testConfig() {
    setTesting(true);
    setLocalTestResult({ ok: null, message: "正在测试连接...", testedAt: new Date().toISOString(), latencyMs: 0 });
    try {
      const payload = buildPayload();
      const result = draft.id
        ? await apiPost(`/admin/model-adapters/${draft.id}/test`, { adapter: payload, prompt: testPrompt })
        : await apiPost("/admin/model-adapters/test", { adapter: payload, prompt: testPrompt });
      setLocalTestResult(result.result);
    } catch (err) {
      setLocalTestResult({
        ok: false,
        message: err.message || "连接失败",
        latencyMs: 0,
        testedAt: new Date().toISOString()
      });
    } finally {
      setTesting(false);
    }
  }

  return (
    <section className="model-config-page">
      <header className="model-config-header">
        <div>
          <h2>模型配置</h2>
        </div>
        <button className="primary-action" type="button" onClick={saveConfig} disabled={saving}>
          {saving ? <Loader2 className="spin" size={16} /> : <Check size={16} />}
          保存所有配置
        </button>
      </header>

      <div className="model-config-workbench">
        <aside className="model-type-nav">
          <strong>模型类型</strong>
          {capabilities.map((capability) => (
            <button
              key={capability.key}
              className={selectedCapability === capability.key ? "active" : ""}
              type="button"
              onClick={() => setSelectedCapability(capability.key)}
            >
              {capability.label}
            </button>
          ))}
          <button className="add-model-button" type="button" onClick={newModelDraft}>
            <Plus size={16} />
            添加模型
          </button>
        </aside>

        <form className="model-config-form-panel" onSubmit={saveConfig}>
          <h3>{selectedCapabilityMeta.label}配置</h3>
          <div className="model-config-form-grid">
            <label>
              模型名称
              <input value={draft.model} onChange={(event) => updateDraft({ model: event.target.value })} placeholder={modelPlaceholder(selectedCapability)} />
            </label>
            <label>
              模型类型
              <select value={draft.provider} onChange={(event) => updateDraft({ provider: event.target.value })}>
                {providerOptionsForCapability(selectedCapability).map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label>
              Base URL
              <input value={draft.baseUrl} onChange={(event) => updateDraft({ baseUrl: event.target.value })} placeholder={baseUrlPlaceholder(selectedCapability)} />
            </label>
            <label>
              API Key
              <span className="secret-input">
                <input
                  type={showApiKey ? "text" : "password"}
                  value={draft.apiKey}
                  onChange={(event) => updateDraft({ apiKey: event.target.value })}
                  placeholder={draft.hasApiKey || draft.envConfigured ? "已配置，留空则不修改" : "请输入 API Key"}
                />
                <button type="button" onClick={() => setShowApiKey((current) => !current)} title={showApiKey ? "隐藏" : "显示"}>
                  <Eye size={16} />
                </button>
              </span>
            </label>
            <label>
              超时时间
              <input type="number" min="10" max="900" value={draft.timeoutSeconds} onChange={(event) => updateDraft({ timeoutSeconds: event.target.value })} />
            </label>
            <label>
              环境变量名
              <input value={draft.envVarName} onChange={(event) => updateDraft({ envVarName: event.target.value })} placeholder={envPlaceholder(selectedCapability)} />
            </label>
          </div>
          {selectedCapability === "ASR" ? (
            <label className="model-config-wide">
              豆包 APP ID / App Key
              <input value={draft.appKey} onChange={(event) => updateDraft({ appKey: event.target.value })} placeholder="火山引擎控制台 App Key" />
            </label>
          ) : null}
          <div className="model-config-actions">
            <button className="secondary-action" type="button" onClick={resetConfig}>重置</button>
            <button className="primary-action" type="submit" disabled={saving}>
              {saving ? <Loader2 className="spin" size={16} /> : <Check size={16} />}
              保存配置
            </button>
          </div>
        </form>

        <section className="model-test-panel">
          <h3>连接测试</h3>
          <label>
            测试内容
            <textarea value={testPrompt} onChange={(event) => setTestPrompt(event.target.value)} />
          </label>
          <button className="primary-action" type="button" onClick={testConfig} disabled={testing}>
            {testing ? <Loader2 className="spin" size={16} /> : <Sparkles size={16} />}
            {testing ? "测试中" : "测试连接"}
          </button>
          <ConnectionTestResult result={testResult} />
        </section>
      </div>
    </section>
  );
}

function modelAdapterToConfigDraft(adapter, capability) {
  const defaults = modelDefaultsForCapability(capability);
  return {
    id: adapter?.id || "",
    name: adapter?.name || defaults.name,
    capability,
    provider: adapter?.provider || defaults.provider,
    protocol: adapter?.protocol || defaults.protocol,
    model: adapter?.model || defaults.model || "",
    baseUrl: adapter?.baseUrl || defaults.baseUrl || "",
    appKey: adapter?.appKey || defaults.appKey || "",
    apiKey: "",
    envVarName: adapter?.envVarName ?? defaults.envVarName ?? "",
    timeoutSeconds: adapter?.timeoutSeconds || defaults.timeoutSeconds || 120,
    description: adapter?.description || defaults.description || "",
    hasApiKey: Boolean(adapter?.hasApiKey),
    envConfigured: Boolean(adapter?.envConfigured)
  };
}

function providerOptionsForCapability(capability) {
  if (capability === "ASR") return [{ value: "doubao", label: "豆包语音识别" }, { value: "custom-http", label: "自定义 HTTP" }];
  if (capability === "PDF_PARSER") return [{ value: "local", label: "本地解析" }, { value: "mineru", label: "MinerU" }, { value: "custom-http", label: "自定义 HTTP" }];
  if (capability === "OCR") return [{ value: "mineru", label: "MinerU" }, { value: "custom-http", label: "自定义 HTTP" }];
  return [
    { value: "openai-compatible", label: "OpenAI 兼容" },
    { value: "openai", label: "OpenAI" },
    { value: "qwen", label: "通义千问" },
    { value: "deepseek", label: "DeepSeek" },
    { value: "ollama", label: "Ollama / 本地" },
    { value: "custom-http", label: "自定义 HTTP" }
  ];
}

function providerDefaults(provider, capability) {
  if (capability === "ASR" && provider === "doubao") return { protocol: "doubao-asr", envVarName: "DOUBAO_ASR_ACCESS_KEY" };
  if (capability === "PDF_PARSER" && provider === "local") return { protocol: "local-pdf-parse", envVarName: "" };
  if (provider === "mineru") return { protocol: "mineru", envVarName: "PDF_MINERU_API_KEY" };
  if (capability === "EMBEDDING") return { protocol: "embeddings" };
  if (["openai", "openai-compatible", "qwen", "deepseek", "ollama"].includes(provider)) return { protocol: "chat-completions" };
  return { protocol: "custom-http" };
}

function modelPlaceholder(capability) {
  return {
    LLM: "gpt-4.1-mini / qwen-plus / deepseek-chat",
    VISION: "gpt-4.1-mini / qwen-vl-plus",
    ASR: "volc.bigasr.auc_turbo",
    OCR: "mineru",
    PDF_PARSER: "pdf-parse",
    EMBEDDING: "text-embedding-3-large"
  }[capability] || "模型名称";
}

function baseUrlPlaceholder(capability) {
  return capability === "ASR"
    ? "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash"
    : "https://api.openai.com/v1";
}

function envPlaceholder(capability) {
  return {
    ASR: "DOUBAO_ASR_ACCESS_KEY",
    OCR: "PDF_MINERU_API_KEY",
    PDF_PARSER: "",
    EMBEDDING: "OPENAI_API_KEY"
  }[capability] || "OPENAI_API_KEY";
}

function ConnectionTestResult({ result }) {
  if (!result) return null;
  const pending = result.ok == null;
  const message = result.message || "";
  return (
    <div className={`connection-test-result ${pending ? "pending" : result.ok ? "success" : "failed"}`}>
      <strong>{pending ? "正在测试" : result.ok ? "✓ 测试通过" : "✗ 连接失败"}</strong>
      {Number.isFinite(result.latencyMs) && result.latencyMs > 0 ? <span>响应时间：{result.latencyMs}ms</span> : null}
      <span>{result.ok ? `返回内容：${truncateText(message, 120)}` : `错误信息：${truncateText(message, 120)}`}</span>
    </div>
  );
}

function QuickLlmConfig({ adapter, onSave, onTest, testResult, testing }) {
  const [form, setForm] = useState(() => llmAdapterToForm(adapter));

  useEffect(() => {
    setForm(llmAdapterToForm(adapter));
  }, [adapter?.id, adapter?.model, adapter?.baseUrl, adapter?.hasApiKey, adapter?.envVarName]);

  function submit(event) {
    event.preventDefault();
    if (!adapter) return;
    onSave(adapter.id, {
      name: adapter.name || "OpenAI 兼容大模型",
      capability: "LLM",
      provider: "openai-compatible",
      protocol: "responses",
      model: form.model,
      baseUrl: form.baseUrl,
      apiKey: form.apiKey,
      envVarName: form.envVarName,
      status: "active",
      description: "所有 LLM 按 OpenAI API 兼容方式接入，填写 base 地址、模型名称和 key 即可。",
      timeoutSeconds: Number(form.timeoutSeconds) || 120
    });
    setForm((current) => ({ ...current, apiKey: "" }));
  }

  return (
    <section className="panel quick-config-card">
      <PanelHeader title="大模型配置" />
      <form className="quick-config-form" onSubmit={submit}>
        <label>
          Base 地址
          <input value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} placeholder="https://api.openai.com/v1" />
        </label>
        <label>
          模型名称
          <input value={form.model} onChange={(event) => setForm({ ...form, model: event.target.value })} placeholder="gpt-4.1-mini / qwen-plus / deepseek-chat" />
        </label>
        <label>
          API Key
          <input
            type="password"
            value={form.apiKey}
            onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
            placeholder={adapter?.hasApiKey || adapter?.envConfigured ? "已配置，留空则不修改" : "sk-..."}
          />
        </label>
        <div className="model-form-grid">
          <label>
            环境变量名
            <input value={form.envVarName} onChange={(event) => setForm({ ...form, envVarName: event.target.value })} placeholder="OPENAI_API_KEY" />
          </label>
          <label>
            超时秒数
            <input type="number" min="10" max="900" value={form.timeoutSeconds} onChange={(event) => setForm({ ...form, timeoutSeconds: event.target.value })} />
          </label>
        </div>
        <div className="quick-config-footer">
          <span className={adapter?.hasApiKey || adapter?.envConfigured ? "env-status ready" : "env-status missing"}>
            {adapter?.hasApiKey || adapter?.envConfigured ? "Key 已配置" : "Key 未配置"}
          </span>
          <button className="secondary-action" type="button" disabled={!adapter || testing} onClick={() => onTest(adapter.id)}>
            {testing ? <Loader2 className="spin" size={16} /> : <Sparkles size={16} />}
            {testing ? "测试中" : "测试"}
          </button>
          <button className="primary-action" type="submit" disabled={!adapter}>
            <Check size={16} />
            保存大模型
          </button>
        </div>
        <ModelTestResult result={testResult || adapter?.lastTest} />
      </form>
    </section>
  );
}

function QuickDoubaoAsrConfig({ adapter, onSave, onTest, testResult, testing }) {
  const [form, setForm] = useState(() => doubaoAdapterToForm(adapter));

  useEffect(() => {
    setForm(doubaoAdapterToForm(adapter));
  }, [adapter?.id, adapter?.model, adapter?.baseUrl, adapter?.appKey, adapter?.hasApiKey, adapter?.envVarName]);

  function submit(event) {
    event.preventDefault();
    if (!adapter) return;
    onSave(adapter.id, {
      name: "豆包语音识别",
      capability: "ASR",
      provider: "doubao",
      protocol: "doubao-asr",
      model: form.model,
      baseUrl: form.baseUrl,
      appKey: form.appKey,
      apiKey: form.apiKey,
      envVarName: form.envVarName,
      status: "active",
      description: "默认语音识别服务，按火山引擎豆包录音文件极速版配置 App Key、Access Key 和资源 ID。",
      timeoutSeconds: Number(form.timeoutSeconds) || 300
    });
    setForm((current) => ({ ...current, apiKey: "" }));
  }

  return (
    <section className="panel quick-config-card">
      <PanelHeader title="豆包语音识别配置" />
      <form className="quick-config-form" onSubmit={submit}>
        <label>
          ASR 地址
          <input value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} placeholder="https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash" />
        </label>
        <label>
          APP ID / App Key
          <input value={form.appKey} onChange={(event) => setForm({ ...form, appKey: event.target.value })} placeholder="火山引擎控制台中的 App Key" />
        </label>
        <label>
          资源 ID
          <input value={form.model} onChange={(event) => setForm({ ...form, model: event.target.value })} placeholder="volc.bigasr.auc_turbo" />
        </label>
        <label>
          Access Key
          <input
            type="password"
            value={form.apiKey}
            onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
            placeholder={adapter?.hasApiKey || adapter?.envConfigured ? "已配置，留空则不修改" : "豆包 Access Key"}
          />
        </label>
        <div className="model-form-grid">
          <label>
            环境变量名
            <input value={form.envVarName} onChange={(event) => setForm({ ...form, envVarName: event.target.value })} placeholder="DOUBAO_ASR_ACCESS_KEY" />
          </label>
          <label>
            超时秒数
            <input type="number" min="10" max="900" value={form.timeoutSeconds} onChange={(event) => setForm({ ...form, timeoutSeconds: event.target.value })} />
          </label>
        </div>
        <div className="quick-config-footer">
          <span className={adapter?.hasApiKey || adapter?.envConfigured ? "env-status ready" : "env-status missing"}>
            {adapter?.hasApiKey || adapter?.envConfigured ? "Access Key 已配置" : "Access Key 未配置"}
          </span>
          <button className="secondary-action" type="button" disabled={!adapter || testing} onClick={() => onTest(adapter.id)}>
            {testing ? <Loader2 className="spin" size={16} /> : <Sparkles size={16} />}
            {testing ? "测试中" : "测试"}
          </button>
          <button className="primary-action" type="submit" disabled={!adapter}>
            <Check size={16} />
            保存豆包 ASR
          </button>
        </div>
        <ModelTestResult result={testResult || adapter?.lastTest} />
      </form>
    </section>
  );
}

function ModelTestResult({ result }) {
  if (!result) return null;
  const pending = result.ok == null;
  return (
    <div className={`model-test-result ${pending ? "pending" : result.ok ? "success" : "failed"}`}>
      <strong>{pending ? "测试中" : result.ok ? "测试通过" : "测试失败"}</strong>
      <span>{result.message}</span>
      {Number.isFinite(result.latencyMs) && result.latencyMs > 0 && <small>耗时 {result.latencyMs} ms</small>}
    </div>
  );
}

function SettingsView({ project, form, onChange, onSubmit, members = [], memberForm, onMemberChange, onMemberSubmit }) {
  const notificationRules = [
    ["待确认变更提醒", "当 AI 识别到新增、修改、删除或待客户确认事项时通知项目负责人。"],
    ["资料编译完成提醒", "文档、录音或截图完成解析并写入 Wiki 后通知上传人。"],
    ["里程碑风险提醒", "未确认需求过多或变更频率升高时提醒项目经理关注交付风险。"]
  ];

  return (
    <div className="settings-page-grid">
      <section className="panel settings-panel">
        <PanelHeader title="项目设置" />
        <form className="settings-form" onSubmit={onSubmit}>
          <div className="settings-section">
            <h3>基础信息</h3>
            <div className="settings-grid">
              <label>
                项目名称
                <input value={form.name} onChange={(event) => onChange({ ...form, name: event.target.value })} />
              </label>
              <label>
                客户名称
                <input value={form.customerName} onChange={(event) => onChange({ ...form, customerName: event.target.value })} />
              </label>
              <label>
                项目阶段
                <select value={form.stage} onChange={(event) => onChange({ ...form, stage: event.target.value })}>
                  <option value="需求沟通阶段">需求沟通阶段</option>
                  <option value="需求确认">需求确认</option>
                  <option value="原型设计">原型设计</option>
                  <option value="开发阶段">开发阶段</option>
                  <option value="测试验收">测试验收</option>
                </select>
              </label>
              <label>
                预计结束日期
                <input type="date" value={form.expectedEndDate} onChange={(event) => onChange({ ...form, expectedEndDate: event.target.value })} />
              </label>
            </div>
          </div>

          <div className="settings-section">
            <h3>AI 编译规则</h3>
            <div className="toggle-list">
              <ToggleRow
                title="自动更新项目 Wiki"
                text="资料上传并解析后，自动维护项目总览、模块页、来源页和相关概念页。"
                checked={form.enableAutoWiki}
                onChange={(checked) => onChange({ ...form, enableAutoWiki: checked })}
              />
              <ToggleRow
                title="自动识别需求差异"
                text="AI 对比新资料和当前需求池，生成新增、修改、删除、待确认变更。"
                checked={form.enableChangeDetection}
                onChange={(checked) => onChange({ ...form, enableChangeDetection: checked })}
              />
              <ToggleRow
                title="变更需人工确认后生效"
                text="AI 只生成待确认变更，不直接覆盖当前确认需求。"
                checked={form.requireHumanConfirmation}
                onChange={(checked) => onChange({ ...form, requireHumanConfirmation: checked })}
              />
              <ToggleRow
                title="Markdown 导出包含 frontmatter"
                text="导出到 Obsidian 时附带类型、来源、更新时间等结构化信息。"
                checked={form.exportFrontmatter}
                onChange={(checked) => onChange({ ...form, exportFrontmatter: checked })}
              />
            </div>
          </div>

          <div className="settings-footer">
            <span>最后更新：{formatDate(project?.updatedAt)}</span>
            <button className="primary-action" type="submit">
              <Check size={16} />
              保存设置
            </button>
          </div>
        </form>
      </section>

      <section className="panel settings-panel">
        <PanelHeader title="成员与权限" />
        <div className="settings-members">
          <div className="member-list compact">
            {members.map((member) => (
              <article className="member-card" key={member.id}>
                <div className="member-avatar">{member.name.slice(0, 1)}</div>
                <div className="member-copy">
                  <div>
                    <strong>{member.name}</strong>
                    <span>{member.side} · {member.role}</span>
                  </div>
                  <p>{member.permissions.join("、")}</p>
                </div>
              </article>
            ))}
          </div>
          {memberForm && (
            <form className="member-form compact" onSubmit={onMemberSubmit}>
              <label>
                成员姓名
                <input value={memberForm.name} onChange={(event) => onMemberChange({ ...memberForm, name: event.target.value })} placeholder="例如：陈晨" />
              </label>
              <label>
                登录账号
                <input value={memberForm.account || ""} onChange={(event) => onMemberChange({ ...memberForm, account: event.target.value })} placeholder="例如：chenchen" />
              </label>
              <label>
                手机号
                <input value={memberForm.phone || ""} onChange={(event) => onMemberChange({ ...memberForm, phone: event.target.value })} placeholder="用于联系和识别客户" />
              </label>
              <label>
                初始密码
                <input value={memberForm.password || ""} onChange={(event) => onMemberChange({ ...memberForm, password: event.target.value })} placeholder="默认 123456" />
              </label>
              <label>
                项目角色
                <select value={memberForm.projectRole} onChange={(event) => onMemberChange({ ...memberForm, projectRole: event.target.value })}>
                  <option value="开发负责人">开发负责人</option>
                  <option value="客户负责人">客户负责人</option>
                  <option value="客户成员">客户成员</option>
                </select>
              </label>
              <label>
                人员身份
                <select value={memberForm.userRole} onChange={(event) => onMemberChange({ ...memberForm, userRole: event.target.value })}>
                  <option value="开发负责人">开发负责人</option>
                  <option value="客户负责人">客户负责人</option>
                  <option value="业务代表">业务代表</option>
                </select>
              </label>
              <button className="primary-action" type="submit">
                <Plus size={16} />
                添加成员
              </button>
            </form>
          )}
        </div>
      </section>

      <section className="panel settings-panel">
        <PanelHeader title="通知管理" />
        <div className="toggle-list">
          {notificationRules.map(([title, text]) => (
            <ToggleRow key={title} title={title} text={text} checked onChange={() => {}} />
          ))}
        </div>
      </section>
    </div>
  );
}

function ToggleRow({ title, text, checked, onChange }) {
  return (
    <label className="toggle-row">
      <span>
        <strong>{title}</strong>
        <small>{text}</small>
      </span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

function SourceEditModal({ editor, saving, onChange, onClose, onSubmit }) {
  const isNoteMode = editor.mode === "note";
  const isSpeakerMode = editor.mode === "speakers";
  const speakerRows = speakerRowsForEditor(editor);
  const updateSpeakerName = (label, value) => {
    const next = { ...(editor.speakerLabels || {}) };
    const normalizedLabel = normalizeSpeakerLabel(label);
    if (value.trim()) {
      next[normalizedLabel] = value;
    } else {
      delete next[normalizedLabel];
    }
    onChange({ speakerLabels: next });
  };
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="source-edit-modal" role="dialog" aria-modal="true" aria-labelledby="source-edit-title">
        <div className="modal-header">
          <div>
            <h2 id="source-edit-title">{isSpeakerMode ? "说话人标注" : isNoteMode ? "资料备注" : "编辑资料"}</h2>
            <p>{editor.originalName}</p>
          </div>
          <button className="modal-close" type="button" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </div>
        <form className="source-edit-form" onSubmit={onSubmit}>
          {!isNoteMode && !isSpeakerMode && (
            <label>
              显示名称
              <input
                value={editor.title}
                onChange={(event) => onChange({ title: event.target.value })}
                placeholder="用于资料库、Wiki 来源页和搜索结果展示"
              />
            </label>
          )}
          {!isNoteMode && !isSpeakerMode && (
            <label>
              原文件名
              <input value={editor.originalName} readOnly />
            </label>
          )}
          {!isNoteMode && !isSpeakerMode && (
            <div className="modal-form-grid">
              <label>
                业务阶段
                <select value={editor.documentStage || "需求确认阶段"} onChange={(event) => onChange({ documentStage: event.target.value })}>
                  {documentStageOptions.map((item) => <option value={item} key={item}>{item}</option>)}
                </select>
              </label>
              <label>
                资料分类
                <select value={editor.documentPurpose || "通用资料"} onChange={(event) => onChange({ documentPurpose: event.target.value })}>
                  {documentPurposeOptions.map((item) => <option value={item} key={item}>{item}</option>)}
                </select>
              </label>
            </div>
          )}
          {isSpeakerMode ? (
            <div className="speaker-edit-panel">
              <div className="speaker-edit-head">
                <strong>说话人对应关系</strong>
                <span>{speakerRows.length} 个标签</span>
              </div>
              <p>把 ASR 里的“说话人1 / Speaker A”标成真实姓名或角色。保存后，资料预览和下一次 Wiki 编译都会使用这些标注。</p>
              <div className="speaker-edit-list">
                {speakerRows.length ? (
                  speakerRows.map((label) => (
                    <label className="speaker-edit-row" key={label}>
                      <span>{label}</span>
                      <input
                        value={(editor.speakerLabels || {})[label] || ""}
                        onChange={(event) => updateSpeakerName(label, event.target.value)}
                        placeholder="例如：张伟 / 客户负责人 / 产品经理"
                      />
                    </label>
                  ))
                ) : (
                  <div className="speaker-edit-empty">当前资料还没有识别到说话人。转写完成后可继续标注。</div>
                )}
              </div>
            </div>
          ) : null}
          {!isSpeakerMode ? (
            <label>
            编译备注
            <textarea
              value={editor.note}
              onChange={(event) => onChange({ note: event.target.value })}
              placeholder="补充背景、来源口径、甲乙方角色或需要 AI 特别注意的点。保存后下次编译会带入。"
              rows={isNoteMode ? 8 : 5}
            />
            </label>
          ) : null}
          <div className="modal-actions">
            <button className="secondary-action" type="button" onClick={onClose}>
              取消
            </button>
            <button className="primary-action" type="submit" disabled={saving || !editor.title.trim()}>
              {saving ? <Loader2 className="spin" size={16} /> : <Check size={16} />}
              保存
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function ChangeStatusConfirmModal({ action, submitting, onCancel, onConfirm }) {
  const meta = changeStatusActionMeta(action.status);
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="change-confirm-title">
        <div className="modal-header">
          <div>
            <h2 id="change-confirm-title">{meta.title}</h2>
            <p>{meta.description}</p>
          </div>
          <button className="modal-close" type="button" onClick={onCancel} title="关闭" disabled={submitting}>
            <X size={18} />
          </button>
        </div>
        <div className="confirm-modal-body">
          <div className="confirm-target">
            <span className={`type-tag ${meta.tone}`}>{meta.label}</span>
            <div>
              <strong>{action.moduleName} - {action.title}</strong>
              {action.summary ? <p>{action.summary}</p> : null}
            </div>
          </div>
          <div className="confirm-status-flow">
            <span>{action.currentStatus}</span>
            <span>→</span>
            <strong>{action.status}</strong>
          </div>
        </div>
        <div className="modal-actions confirm-actions">
          <button className="secondary-action" type="button" onClick={onCancel} disabled={submitting}>
            取消
          </button>
          <button className="primary-action" type="button" onClick={onConfirm} disabled={submitting}>
            {submitting ? <Loader2 size={16} className="spin" /> : <Check size={16} />}
            确认
          </button>
        </div>
      </section>
    </div>
  );
}

function SourcePreviewModal({ preview, loading, onClose }) {
  const source = preview?.sourceFile;
  const speakerLabels = normalizeSpeakerLabels(preview?.speakerLabels || source?.speakerLabels || {});
  const transcriptText = preview?.transcriptDisplayText ?? applySpeakerLabelsToText(preview?.transcript?.text || "", speakerLabels);
  const parsedText = preview?.parsedDisplayText ?? applySpeakerLabelsToText(source?.parsedText || "", speakerLabels);
  const rawUrl = apiRawUrl(preview?.rawUrl);
  const speakerRows = preview?.detectedSpeakers?.length ? preview.detectedSpeakers : detectSpeakerLabels(source || {});

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="source-preview-modal" role="dialog" aria-modal="true" aria-labelledby="source-preview-title">
        <div className="modal-header">
          <div>
            <h2 id="source-preview-title">{source?.title || "资料预览"}</h2>
            <p>{source ? `${categoryLabel(source.category)} · ${statusLabel(source.status)} · ${formatBytes(source.size)}` : "正在读取资料信息"}</p>
          </div>
          <button className="modal-close" type="button" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </div>

        {loading || !source ? (
          <div className="source-preview-loading">
            <Loader2 size={20} />
            正在加载资料...
          </div>
        ) : (
          <div className="source-preview-body">
            <section className="source-preview-card">
              <div className="source-preview-card-head">
                <strong>原文件</strong>
                <a href={rawUrl} target="_blank" rel="noreferrer">
                  打开原文件
                </a>
              </div>
              <SourceRawPreview source={source} rawUrl={rawUrl} />
              <div className="document-meta">
                <span>{displaySourceName(source)}</span>
                <span>{source.documentStage || "需求确认阶段"}</span>
                <span>{source.documentPurpose || "通用资料"}</span>
                <span>{formatDate(source.uploadedAt)}</span>
                {source.category === "audio" && source.speakerCount ? <span>{source.speakerCount} 人会议</span> : null}
              </div>
              {speakerRows.length ? (
                <div className="speaker-preview-map">
                  {speakerRows.map((label) => (
                    <span key={label}>
                      {label}
                      <strong>{speakerLabels[label] || "未标注"}</strong>
                    </span>
                  ))}
                </div>
              ) : null}
              {source.note ? <p className="source-preview-note">编译备注：{source.note}</p> : null}
            </section>

            <section className="source-preview-card">
              <div className="source-preview-card-head">
                <strong>{source.category === "audio" ? "转录文本" : "解析文本"}</strong>
                <span>{source.category === "audio" ? "ASR 输出" : "文件解析输出"}</span>
              </div>
              <pre className="source-text-preview">
                {source.category === "audio"
                  ? transcriptText || "尚未完成转录。配置 ASR 后点击“转写并编译”。"
                  : parsedText || "尚未解析。点击“重新编译”后会生成解析文本。"}
              </pre>
            </section>

            {source.category === "audio" && parsedText && parsedText !== transcriptText ? (
              <section className="source-preview-card">
                <div className="source-preview-card-head">
                  <strong>编译输入文本</strong>
                  <span>进入 Wiki 编译前的文本</span>
                </div>
                <pre className="source-text-preview">{parsedText}</pre>
              </section>
            ) : null}

            <section className="source-preview-card">
              <div className="source-preview-card-head">
                <strong>处理记录</strong>
                <span>{preview.jobs?.length || 0} 条</span>
              </div>
              <div className="source-job-list">
                {(preview.jobs || []).length ? (
                  preview.jobs.map((job) => (
                    <div key={job.id}>
                      <strong>{statusLabel(job.status)}</strong>
                      <span>{job.step} · {formatDate(job.createdAt)}</span>
                      {job.error ? <p>{job.error}</p> : null}
                    </div>
                  ))
                ) : (
                  <p>尚未开始解析或转写。</p>
                )}
              </div>
            </section>
          </div>
        )}
      </section>
    </div>
  );
}

function SourceRawPreview({ source, rawUrl }) {
  if (source.category === "image") {
    return <img className="source-raw-media" src={rawUrl} alt={source.title} />;
  }
  if (source.category === "audio") {
    return <audio className="source-raw-audio" controls src={rawUrl} />;
  }
  if (source.category === "pdf") {
    return <iframe className="source-raw-frame" title={source.title} src={rawUrl} />;
  }
  return (
    <div className="source-file-placeholder">
      <FileText size={22} />
      <span>当前文件类型请通过“打开原文件”查看。</span>
    </div>
  );
}

function RequirementModal({ form, onChange, onClose, onSubmit }) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="project-modal" role="dialog" aria-modal="true" aria-labelledby="requirement-modal-title">
        <div className="modal-header">
          <div>
            <h2 id="requirement-modal-title">新建需求</h2>
            <p>手动补充客户已提出但尚未进入需求池的需求，后续可继续关联来源资料和变更记录。</p>
          </div>
          <button className="modal-close" type="button" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </div>
        <form className="project-form" onSubmit={onSubmit}>
          <label>
            需求标题
            <input value={form.title} onChange={(event) => onChange({ ...form, title: event.target.value })} placeholder="例如：会员积分冻结规则" />
          </label>
          <label>
            所属模块
            <input value={form.moduleName} onChange={(event) => onChange({ ...form, moduleName: event.target.value })} placeholder="例如：会员管理" />
          </label>
          <label>
            需求描述
            <textarea value={form.description} onChange={(event) => onChange({ ...form, description: event.target.value })} placeholder="简要描述需求背景、范围和主要规则" />
          </label>
          <label>
            验收标准
            <textarea value={form.acceptanceCriteria} onChange={(event) => onChange({ ...form, acceptanceCriteria: event.target.value })} placeholder="描述可验收的结果和边界" />
          </label>
          <div className="modal-form-grid">
            <label>
              状态
              <select value={form.status} onChange={(event) => onChange({ ...form, status: event.target.value })}>
                {["待确认", "已确认", "已驳回", "设计中", "开发中", "已完成"].map((item) => (
                  <option key={item} value={item}>{item}</option>
                ))}
              </select>
            </label>
            <label>
              优先级
              <select value={form.priority} onChange={(event) => onChange({ ...form, priority: event.target.value })}>
                {["高", "中", "低"].map((item) => (
                  <option key={item} value={item}>{item}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="modal-form-grid">
            <label>
              提出人
              <input value={form.proposer} onChange={(event) => onChange({ ...form, proposer: event.target.value })} placeholder="客户或内部提出人" />
            </label>
            <label>
              负责人
              <input value={form.owner} onChange={(event) => onChange({ ...form, owner: event.target.value })} placeholder="需求负责人" />
            </label>
          </div>
          <div className="modal-actions">
            <button className="secondary-action" type="button" onClick={onClose}>取消</button>
            <button className="primary-action" type="submit">创建需求</button>
          </div>
        </form>
      </section>
    </div>
  );
}

function ProjectModal({ form, onChange, onClose, onSubmit }) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="project-modal" role="dialog" aria-modal="true" aria-labelledby="project-modal-title">
        <div className="modal-header">
          <div>
            <h2 id="project-modal-title">新建项目</h2>
            <p>创建项目空间后即可导入资料，系统会自动编译项目 Wiki 和变更记录。</p>
          </div>
          <button className="modal-close" type="button" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </div>
        <form className="project-form" onSubmit={onSubmit}>
          <label>
            项目名称
            <input
              value={form.name}
              onChange={(event) => onChange({ ...form, name: event.target.value })}
              placeholder="例如：智慧门店管理系统"
              autoFocus
            />
          </label>
          <label>
            客户名称
            <input
              value={form.customerName}
              onChange={(event) => onChange({ ...form, customerName: event.target.value })}
              placeholder="例如：星河商业集团"
            />
          </label>
          <label>
            项目阶段
            <select value={form.stage} onChange={(event) => onChange({ ...form, stage: event.target.value })}>
              <option value="需求沟通阶段">需求沟通阶段</option>
              <option value="需求确认">需求确认</option>
              <option value="原型设计">原型设计</option>
              <option value="开发阶段">开发阶段</option>
              <option value="测试验收">测试验收</option>
            </select>
          </label>
          <label>
            预计结束日期
            <input
              type="date"
              value={form.expectedEndDate}
              onChange={(event) => onChange({ ...form, expectedEndDate: event.target.value })}
            />
          </label>
          <div className="modal-actions">
            <button className="secondary-action" type="button" onClick={onClose}>
              取消
            </button>
            <button className="primary-action" type="submit">
              <Plus size={16} />
              创建项目
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function ChangeCompactRow({ change, onChangeStatus }) {
  const canSubmitCustomer = ["待确认", "客户退回"].includes(change.status);
  return (
    <article className="pending-row">
      <div className="pending-main">
        <span className={`type-tag ${typeClass(change.changeType)}`}>{change.changeType}</span>
        <div className="pending-copy">
          <h3>{change.moduleName} - {change.title}</h3>
          <p>{change.summary}</p>
        </div>
      </div>
      <div className="pending-meta">
        <span>{change.proposer}</span>
        <span>{formatDate(change.createdAt)}</span>
        <strong className="priority high">{change.status}</strong>
      </div>
      <div className="row-actions pending-actions">
        {canSubmitCustomer ? (
          <>
            <button type="button" title="提交客户确认" onClick={() => onChangeStatus(change.id, "需客户确认")}>
              <AlertTriangle size={15} />
            </button>
            <button type="button" title="驳回变更" onClick={() => onChangeStatus(change.id, "已驳回")}>
              <X size={15} />
            </button>
          </>
        ) : (
          <button type="button" title="等待客户确认" disabled>
            <AlertTriangle size={15} />
          </button>
        )}
      </div>
    </article>
  );
}

function PanelHeader({ title, action, select, onAction }) {
  return (
    <div className="panel-header">
      <h2>{title}</h2>
      {action && (
        <button className={select ? "select-action" : "text-action"} type="button" onClick={onAction}>
          {action}
          {select && <ChevronDown size={14} />}
        </button>
      )}
    </div>
  );
}

function ProgressLine({ value, label }) {
  const safeValue = Math.min(100, Math.max(0, Number(value) || 0));
  return (
    <div className="progress-line" aria-label={label}>
      <div>
        <span>{label}</span>
        <strong>{safeValue}%</strong>
      </div>
      <i>
        <b style={{ width: `${safeValue}%` }} />
      </i>
    </div>
  );
}

function Legend({ color, label }) {
  return (
    <span>
      <i style={{ background: color }} />
      {label}
    </span>
  );
}

function TrendTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="tooltip">
      <strong>{label}</strong>
      {payload.map((item) => (
        <span key={item.dataKey}>
          <i style={{ background: item.stroke }} />
          {item.name} {item.value}
        </span>
      ))}
    </div>
  );
}

function LoadingState() {
  return (
    <div className="panel loading-state">
      <Loader2 className="spin" size={24} />
      <span>正在加载项目知识库...</span>
    </div>
  );
}

function EmptyState({ icon: Icon, title, text }) {
  return (
    <div className="empty-state">
      <Icon size={28} />
      <h2>{title}</h2>
      <p>{text}</p>
    </div>
  );
}

function milestoneItems() {
  return [
    { title: "需求沟通阶段", status: "进行中", date: "04-01 ~ 04-30", active: true },
    { title: "原型设计阶段", status: "未开始", date: "05-01 ~ 05-20", active: false },
    { title: "开发阶段", status: "未开始", date: "05-21 ~ 07-10", active: false },
    { title: "测试阶段", status: "未开始", date: "07-11 ~ 07-25", active: false },
    { title: "上线阶段", status: "未开始", date: "07-26 ~ 08-05", active: false }
  ];
}

async function apiGet(path) {
  const response = await fetch(`${API_BASE}${path}`, { headers: authHeaders() });
  return readJson(response);
}

async function apiPost(path, body) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body)
  });
  return readJson(response);
}

async function apiPostFormWithProgress(path, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE}${path}`);
    const token = getAuthToken();
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || !onProgress) return;
      onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = async () => {
      const response = new Response(xhr.responseText, {
        status: xhr.status,
        statusText: xhr.statusText,
        headers: { "Content-Type": xhr.getResponseHeader("Content-Type") || "application/json" }
      });
      try {
        resolve(await readJson(response));
      } catch (error) {
        reject(error);
      }
    };
    xhr.onerror = () => reject(new Error("上传失败，请检查后端服务。"));
    xhr.send(formData);
  });
}

async function apiPostForm(path, formData, onProgress) {
  if (onProgress) return apiPostFormWithProgress(path, formData, onProgress);
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: authHeaders(),
    body: formData
  });
  return readJson(response);
}

async function uploadSourceFiles({ projectId, files, metadata, speakerCount, onProgress, onStatus }) {
  const firstFile = files[0];
  const firstToken = await apiPost(`/projects/${projectId}/source-files/upload-token`, {
    originalName: firstFile.name,
    fileName: firstFile.name,
    mimeType: uploadMimeType(firstFile)
  });

  if (firstToken.token?.uploadMode !== "direct-put") {
    return uploadSourceFilesThroughBackend({ projectId, files, metadata, speakerCount, onProgress });
  }

  return uploadSourceFilesDirectly({
    projectId,
    files,
    metadata,
    speakerCount,
    firstToken: firstToken.token,
    onProgress,
    onStatus
  });
}

async function uploadSourceFilesThroughBackend({ projectId, files, metadata, speakerCount, onProgress }) {
  const formData = new FormData();
  files.forEach((file) => formData.append("files", file));
  formData.append("documentStage", metadata.documentStage);
  formData.append("documentPurpose", metadata.documentPurpose);
  if (files.some((file) => isAudioUploadFile(file))) {
    formData.append("speakerCount", String(speakerCount));
    formData.append("enableSpeakerDiarization", "true");
  }
  return apiPostForm(`/projects/${projectId}/source-files`, formData, onProgress);
}

async function uploadSourceFilesDirectly({ projectId, files, metadata, speakerCount, firstToken, onProgress, onStatus }) {
  const totalBytes = Math.max(files.reduce((sum, file) => sum + file.size, 0), 1);
  const sourceFiles = [];
  let uploadedBytes = 0;

  for (const [index, file] of files.entries()) {
    onStatus?.(`正在上传资料 ${index + 1}/${files.length}...`);
    const token = index === 0
      ? firstToken
      : (await apiPost(`/projects/${projectId}/source-files/upload-token`, {
          originalName: file.name,
          fileName: file.name,
          mimeType: uploadMimeType(file)
        })).token;

    if (token?.uploadMode !== "direct-put" || !token.uploadUrl || !token.objectKey) {
      throw new Error("上传通道不可用，请稍后重试。");
    }

    const uploadResult = await uploadFileToSignedUrl(token, file, (loaded) => {
      const progress = Math.round(((uploadedBytes + loaded) / totalBytes) * 100);
      onProgress?.(Math.min(99, Math.max(1, progress)));
    });
    uploadedBytes += file.size;

    const completed = await apiPost(`/projects/${projectId}/source-files/complete-upload`, {
      objectKey: token.objectKey,
      originalName: file.name,
      fileName: file.name,
      mimeType: uploadMimeType(file),
      size: file.size,
      etag: uploadResult.etag,
      title: files.length === 1 ? file.name : undefined,
      documentStage: metadata.documentStage,
      documentPurpose: metadata.documentPurpose,
      speakerCount: isAudioUploadFile(file) ? String(speakerCount) : undefined
    });
    if (completed.sourceFile) sourceFiles.push(completed.sourceFile);
  }

  onProgress?.(100);
  return { sourceFiles, sourceFile: sourceFiles[0] };
}

function uploadFileToSignedUrl(token, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(token.method || "PUT", token.uploadUrl);
    Object.entries(token.headers || {}).forEach(([name, value]) => {
      if (value) xhr.setRequestHeader(name, value);
    });
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      onProgress?.(event.loaded);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({ etag: xhr.getResponseHeader("ETag") || xhr.getResponseHeader("etag") || "" });
        return;
      }
      reject(new Error(`上传失败：HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error("上传失败，请检查网络或对象存储跨域设置。"));
    xhr.send(file);
  });
}

function uploadMimeType(file) {
  return file.type || "application/octet-stream";
}

async function apiPatch(path, body) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body)
  });
  return readJson(response);
}

async function apiDelete(path) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "DELETE",
    headers: authHeaders()
  });
  return readJson(response);
}

function apiRawUrl(path) {
  if (!path) return "";
  const token = getAuthToken();
  const withToken = token
    ? `${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`
    : path;
  if (/^https?:\/\//.test(path)) return path;
  if (API_BASE.startsWith("http")) return `${API_BASE.replace(/\/api$/, "")}${withToken}`;
  return withToken;
}

function scrollToChange(changeId) {
  const node = document.getElementById(`change-${changeId}`);
  if (!node) return;
  node.scrollIntoView({ behavior: "smooth", block: "center" });
  node.classList.add("change-card-flash");
  window.setTimeout(() => node.classList.remove("change-card-flash"), 1200);
}

async function readJson(response) {
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) clearAuthToken();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function getAuthToken() {
  return window.localStorage.getItem(AUTH_TOKEN_KEY);
}

function setAuthToken(token) {
  window.localStorage.setItem(AUTH_TOKEN_KEY, token);
}

function clearAuthToken() {
  window.localStorage.removeItem(AUTH_TOKEN_KEY);
}

function authHeaders() {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function buildCommunicationGraph({ records = [], changes = [], requirements = [], sourceFiles = [], wikiPages = [] }) {
  const nodes = new Map();
  const links = new Map();
  const sourceById = new Map(sourceFiles.map((item) => [item.id, item]));
  const requirementById = new Map(requirements.map((item) => [item.id, item]));
  const recordSourceIds = new Set(records.map((item) => item.sourceFileId).filter(Boolean));

  const addNode = (node) => {
    if (!node?.id || nodes.has(node.id)) return;
    nodes.set(node.id, node);
  };
  const addLink = (source, target, label, distance = 98, weight = 1.4) => {
    if (!source || !target || source === target) return;
    const key = [source, target, label || ""].join("__");
    if (!links.has(key)) links.set(key, { source, target, label, distance, weight });
  };

  for (const record of records) {
    const recordId = `communication:${record.id}`;
    addNode({
      id: recordId,
      type: "communication",
      label: record.title || "未命名沟通",
      radius: 15,
      description: record.summary || "暂无摘要",
      meta: [
        `类型：${record.type || "沟通记录"}`,
        `时间：${formatDate(record.meetingTime || record.createdAt) || "未记录"}`,
        `关联变更：${record.relatedChangeCount || 0}`
      ]
    });

    const participants = Array.isArray(record.participants) ? record.participants : String(record.participants || "").split(/[、,，\s]+/);
    participants
      .map((item) => String(item || "").trim())
      .filter((item) => item && item !== "待补充")
      .slice(0, 8)
      .forEach((participant) => {
        const participantId = `participant:${participant}`;
        addNode({
          id: participantId,
          type: "participant",
          label: participant,
          radius: 9,
          description: "沟通参与人",
          meta: ["来自沟通记录参与人字段"]
        });
        addLink(participantId, recordId, "参与", 76, 1);
      });

    if (record.sourceFileId) {
      const source = sourceById.get(record.sourceFileId);
      const sourceId = `source:${record.sourceFileId}`;
      addNode({
        id: sourceId,
        type: "source",
        label: source?.title || record.title || "来源资料",
        radius: 12,
        description: source?.notes || source?.aiSummary || "沟通记录关联的原始资料。",
        meta: [
          `资料类型：${source?.category || "未知"}`,
          `状态：${source?.status || "已归档"}`,
          `上传：${formatDate(source?.uploadedAt) || "未记录"}`
        ]
      });
      addLink(recordId, sourceId, "来源", 82, 1.6);
    }
  }

  const linkedChanges = changes
    .filter((change) => change.sourceFileId && recordSourceIds.has(change.sourceFileId))
    .slice(0, 120);
  for (const change of linkedChanges) {
    const sourceId = `source:${change.sourceFileId}`;
    const changeId = `change:${change.id}`;
    addNode({
      id: changeId,
      type: "change",
      label: change.title || change.summary || "需求变更",
      radius: 11,
      description: change.summary || change.afterContent || "暂无变更摘要",
      meta: [
        `状态：${change.status || "待确认"}`,
        `类型：${change.changeType || "变更"}`,
        `模块：${change.moduleName || "未归类"}`
      ]
    });
    addLink(sourceId, changeId, "触发", 92, 1.4);

    if (change.requirementId && requirementById.has(change.requirementId)) {
      const requirement = requirementById.get(change.requirementId);
      const requirementId = `requirement:${requirement.id}`;
      addNode({
        id: requirementId,
        type: "requirement",
        label: requirement.title || "需求",
        radius: 12,
        description: requirement.description || "暂无需求描述",
        meta: [`状态：${requirement.status || "未记录"}`, `模块：${requirement.moduleName || "未归类"}`]
      });
      addLink(changeId, requirementId, "影响", 94, 1.2);
    }
  }

  for (const requirement of requirements.slice(0, 160)) {
    const matchedSourceIds = (requirement.sourceIds || []).filter((sourceId) => recordSourceIds.has(sourceId));
    if (!matchedSourceIds.length) continue;
    const requirementId = `requirement:${requirement.id}`;
    addNode({
      id: requirementId,
      type: "requirement",
      label: requirement.title || "需求",
      radius: 12,
      description: requirement.description || "暂无需求描述",
      meta: [`状态：${requirement.status || "未记录"}`, `模块：${requirement.moduleName || "未归类"}`]
    });
    matchedSourceIds.slice(0, 4).forEach((sourceId) => addLink(`source:${sourceId}`, requirementId, "沉淀", 110, 1));
  }

  for (const page of wikiPages.slice(0, 120)) {
    const matchedSourceIds = (page.sourceIds || []).filter((sourceId) => recordSourceIds.has(sourceId));
    if (!matchedSourceIds.length) continue;
    const pageId = `wiki:${page.id}`;
    addNode({
      id: pageId,
      type: "wiki",
      label: page.title || "Wiki 页面",
      radius: 10,
      description: page.summary || "由资料编译生成的 Wiki 页面。",
      meta: [`页面类型：${page.type || "wiki"}`, `更新：${formatDate(page.updatedAt) || "未记录"}`]
    });
    matchedSourceIds.slice(0, 3).forEach((sourceId) => addLink(`source:${sourceId}`, pageId, "编译", 116, 0.9));
  }

  return {
    nodes: [...nodes.values()],
    links: [...links.values()]
  };
}

function graphNodeTypeLabel(type) {
  return {
    communication: "沟通记录",
    source: "来源资料",
    change: "需求变更",
    requirement: "需求",
    wiki: "Wiki 页面",
    participant: "参与人"
  }[type] || "节点";
}

function selectPreferredWikiPage(pages = [], current) {
  return pages.find((page) => page.id === current?.id) ||
    pages.find((page) => page.type === "MANAGER_BRIEF") ||
    pages[0] ||
    null;
}

function buildWikiPageLookup(pages = []) {
  const byId = new Map();
  const byTitle = new Map();
  const bySlug = new Map();
  for (const page of pages) {
    byId.set(page.id, page);
    bySlug.set(String(page.slug || "").toLowerCase(), page);
    for (const key of wikiPageTitleKeys(page)) {
      if (!byTitle.has(key)) byTitle.set(key, page);
    }
  }
  return { byId, byTitle, bySlug, pages };
}

function wikiPageTitleKeys(page) {
  const title = String(page?.title || "").trim();
  const keys = [title, title.replace(/^来源：/, "")];
  return uniqueStrings(keys.map(normalizeWikiLookupKey));
}

function normalizeWikiLookupKey(value) {
  return String(value || "")
    .replace(/^#*/, "")
    .replace(/\.md$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function enrichWikiLinks(markdown, lookup) {
  const linked = String(markdown || "").replace(/\[\[([^\]\n]+)\]\]/g, (_, rawTarget) => {
    const [target, alias] = String(rawTarget).split("|").map((item) => item.trim());
    const label = alias || target;
    const exists = resolveWikiPageTarget(target, lookup);
    return exists
      ? `[${label}](wiki:${encodeURIComponent(target)})`
      : `[${label}](wiki-missing:${encodeURIComponent(label)})`;
  });
  return linked.replace(/\[([^\]\n]+)\]\((?!https?:|mailto:|#|\/|wiki:)([^)\n]+)\)/g, (match, label, href) => {
    if (!resolveWikiPageTarget(href, lookup) && !resolveWikiPageTarget(label, lookup)) return match;
    return `[${label}](wiki:${encodeURIComponent(href)})`;
  });
}

function resolveWikiPageTarget(target, lookup) {
  if (!target || !lookup) return null;
  const decoded = safeDecode(String(target).replace(/^wiki:/, ""));
  const cleanTarget = decoded.split("#")[0].trim();
  const normalized = normalizeWikiLookupKey(cleanTarget);
  return lookup.byId.get(cleanTarget) || lookup.bySlug.get(normalized) || lookup.byTitle.get(normalized) || null;
}

function buildWikiContext(selectedPage, pages = [], sourceFiles = []) {
  if (!selectedPage) return null;
  const sourceIds = new Set(selectedPage.sourceIds || []);
  const lookup = buildWikiPageLookup(pages);
  const linkTargets = extractWikiLinkTargets(selectedPage.content || "");
  const outgoingPages = uniqueById([
    ...(selectedPage.relatedPageIds || []).map((id) => lookup.byId.get(id)).filter(Boolean),
    ...linkTargets.map((target) => resolveWikiPageTarget(target, lookup)).filter(Boolean)
  ]).filter((page) => page.id !== selectedPage.id).slice(0, 12);
  const backlinks = pages
    .filter((page) => page.id !== selectedPage.id)
    .filter((page) => {
      if ((page.relatedPageIds || []).includes(selectedPage.id)) return true;
      return extractWikiLinkTargets(page.content || "").some((target) => resolveWikiPageTarget(target, lookup)?.id === selectedPage.id);
    })
    .slice(0, 12);
  const sameSourcePages = pages
    .filter((page) => page.id !== selectedPage.id)
    .filter((page) => (page.sourceIds || []).some((id) => sourceIds.has(id)))
    .slice(0, 12);
  const sources = sourceFiles.filter((source) => sourceIds.has(source.id)).slice(0, 12);
  return { sources, outgoingPages, backlinks, sameSourcePages };
}

function extractWikiLinkTargets(content) {
  const targets = [];
  for (const match of String(content || "").matchAll(/\[\[([^\]\n]+)\]\]/g)) {
    targets.push(match[1].split("|")[0].trim());
  }
  for (const match of String(content || "").matchAll(/\[([^\]\n]+)\]\((?!https?:|mailto:|#|\/)([^)\n]+)\)/g)) {
    targets.push(match[2].trim(), match[1].trim());
  }
  return uniqueStrings(targets);
}

function uniqueById(items = []) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item?.id || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function wikiTypeLabel(type) {
  return {
    MANAGER_BRIEF: "经理摘要",
    PROJECT_OVERVIEW: "总览",
    SOURCE_SUMMARY: "来源",
    TOPIC: "主题",
    PROJECT_EVOLUTION: "演进",
    REQUIREMENT_BASELINE: "基线",
    DELIVERY_COMPILATION: "交付",
    DECISION_LOG: "决策",
    RISK_REGISTER: "风险",
    OPEN_QUESTION: "待确认",
    INDEX: "索引",
    TIMELINE: "时间线",
    LINT: "健康检查",
    LOG: "日志"
  }[type] || type || "页面";
}

function buildFallbackManagerBrief(page, changes = [], sourceFiles = []) {
  const activeChanges = [...changes]
    .filter((item) => item.status !== "已驳回")
    .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));
  const pendingManager = activeChanges.filter((item) => item.status === "待确认");
  const customerConfirm = activeChanges.filter((item) => item.status === "需客户确认");
  const keyChanges = activeChanges.slice(0, 5).map((item) => ({
    id: item.id,
    title: `${item.moduleName || "项目范围"} - ${item.title}`,
    type: item.changeType,
    status: item.status,
    result: truncateText(item.summary || item.afterContent || "需要进一步确认。", 90),
    impact: truncateText(item.impactScope || item.summary || "影响范围待评估。", 90),
    changeId: item.id,
    sourceFileId: item.sourceFileId,
    source: sourceTitleForBriefClient(sourceFiles, item.sourceFileId)
  }));
  const actions = [...pendingManager, ...customerConfirm].slice(0, 6).map((item) => ({
    id: `action-${item.id}`,
    title: `${item.status === "需客户确认" ? "跟进客户确认" : "确认变更"}：${item.moduleName || "项目范围"} - ${item.title}`,
    summary: truncateText(item.summary || item.afterContent || "该事项需要确认后继续推进。", 88),
    owner: item.status === "需客户确认" ? "客户负责人" : "项目经理",
    due: item.status === "需客户确认" ? "本周" : "下次沟通前",
    status: item.status,
    changeId: item.id,
    sourceFileId: item.sourceFileId,
    source: sourceTitleForBriefClient(sourceFiles, item.sourceFileId)
  }));
  return {
    summary: page?.summary || (actions.length ? `当前有 ${actions.length} 项需要确认，建议先处理确认闭环。` : "暂无需要项目经理立即处理的事项。"),
    keyChanges,
    risks: [],
    actions,
    sourceRefs: [],
    stats: {
      pendingManagerCount: pendingManager.length,
      customerConfirmCount: customerConfirm.length,
      riskCount: 0,
      questionCount: 0,
      changeCount: activeChanges.length
    }
  };
}

function sourceTitleForBriefClient(sourceFiles, sourceFileId) {
  const source = sourceFiles.find((item) => item.id === sourceFileId);
  return source ? source.title || source.originalName : "";
}

function signalLevelLabel(value) {
  return { high: "高", medium: "中", low: "低" }[value] || value;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function truncateText(value, maxLength = 14) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function typeClass(type) {
  return {
    新增: "add",
    修改: "edit",
    删除: "remove",
    待确认: "pending"
  }[type] || "pending";
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function projectToSettingsForm(project) {
  const settings = project.settings || {};
  return {
    name: project.name || "",
    customerName: project.customerName || "",
    stage: project.stage || "需求沟通阶段",
    expectedEndDate: project.expectedEndDate?.slice(0, 10) || "",
    enableAutoWiki: settings.enableAutoWiki ?? true,
    enableChangeDetection: settings.enableChangeDetection ?? true,
    requireHumanConfirmation: settings.requireHumanConfirmation ?? true,
    exportFrontmatter: settings.exportFrontmatter ?? true
  };
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return "未知大小";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round((value / 1024) * 10) / 10} KB`;
  return `${Math.round((value / 1024 / 1024) * 10) / 10} MB`;
}

function categoryLabel(category) {
  return {
    audio: "音频",
    image: "图片",
    pdf: "PDF",
    word: "Word",
    excel: "表格",
    spreadsheet: "表格",
    document: "文档",
    text: "文本"
  }[category] || "资料";
}

function displaySourceName(source) {
  if (!source) return "";
  const originalName = source.originalName || "";
  if (/[ÃÂÆçèéåäö]/.test(originalName) && source.title) return source.title;
  return originalName || source.title || "未命名资料";
}

function hasSpeakerCandidates(source) {
  return Boolean(source?.category === "audio" || source?.speakerCount || Object.keys(source?.speakerLabels || {}).length || detectSpeakerLabels(source).length);
}

function speakerRowsForEditor(editor) {
  return uniqueStrings([
    ...(editor.detectedSpeakers || []),
    ...Object.keys(editor.speakerLabels || {}),
    ...speakerLabelsFromCount(editor.speakerCount)
  ]).slice(0, 20);
}

function detectSpeakerLabels(source = {}) {
  const labels = new Set(Object.keys(normalizeSpeakerLabels(source.speakerLabels || {})));
  for (const label of speakerLabelsFromCount(source.speakerCount || source.asrOptions?.speakerCount)) labels.add(label);
  const text = [source.parsedText, source.aiSummary, source.title, source.originalName].filter(Boolean).join("\n");
  for (const match of text.matchAll(/(?:Speaker|说话人)\s*[_-]?\s*([A-Za-z0-9一二三四五六七八九十]+)/g)) {
    const label = /^speaker/i.test(match[0]) ? `Speaker ${match[1]}` : `说话人${match[1]}`;
    labels.add(normalizeSpeakerLabel(label));
    if (labels.size >= 20) break;
  }
  return [...labels].filter(Boolean).slice(0, 20);
}

function speakerLabelsFromCount(count) {
  const number = Number(count || 0);
  if (!Number.isFinite(number) || number <= 1) return [];
  return Array.from({ length: Math.min(number, 20) }, (_, index) => `说话人${index + 1}`);
}

function normalizeSpeakerLabels(input) {
  if (!input || typeof input !== "object") return {};
  const entries = Array.isArray(input)
    ? input.map((item) => [item?.label ?? item?.key ?? item?.speaker, item?.name ?? item?.value ?? item?.displayName])
    : Object.entries(input);
  return Object.fromEntries(
    entries
      .map(([label, name]) => [normalizeSpeakerLabel(label), String(name || "").trim().slice(0, 80)])
      .filter(([label, name]) => label && name)
  );
}

function normalizeSpeakerLabel(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const speakerMatch = raw.match(/^speaker\s*[_-]?\s*([A-Za-z0-9一二三四五六七八九十]+)$/i);
  if (speakerMatch) return `Speaker ${speakerMatch[1]}`;
  const cnMatch = raw.match(/^说话人\s*[_-]?\s*([A-Za-z0-9一二三四五六七八九十]+)$/i);
  if (cnMatch) return `说话人${cnMatch[1]}`;
  return raw.replace(/\s+/g, " ").slice(0, 80);
}

function applySpeakerLabelsToText(text, speakerLabels = {}) {
  const labels = normalizeSpeakerLabels(speakerLabels);
  let output = String(text || "");
  for (const label of Object.keys(labels).sort((a, b) => b.length - a.length)) {
    const name = labels[label];
    if (!name) continue;
    output = output.replace(speakerLabelPattern(label), `${name}（${label}）`);
  }
  return output;
}

function speakerLabelPattern(label) {
  const normalized = normalizeSpeakerLabel(label);
  if (/^Speaker\s+/i.test(normalized)) {
    const suffix = normalized.replace(/^Speaker\s+/i, "");
    return new RegExp(`Speaker\\s*[_-]?\\s*${escapeRegExp(suffix)}(?![A-Za-z0-9])`, "g");
  }
  if (/^说话人/.test(normalized)) {
    const suffix = normalized.replace(/^说话人/, "");
    return new RegExp(`说话人\\s*[_-]?\\s*${escapeRegExp(suffix)}(?![A-Za-z0-9一二三四五六七八九十])`, "g");
  }
  return new RegExp(escapeRegExp(normalized), "g");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function isAudioUploadFile(file) {
  if (!file) return false;
  const name = file.name || "";
  return file.type?.startsWith("audio/") || /\.(mp3|wav|m4a|aac|flac|ogg|webm)$/i.test(name);
}

function capabilityLabel(capability) {
  return {
    LLM: "大模型",
    VISION: "视觉理解",
    ASR: "语音转写",
    OCR: "OCR",
    PDF_PARSER: "PDF 解析",
    EMBEDDING: "向量检索"
  }[capability] || capability || "模型";
}

function modelDefaultsForCapability(capability) {
  const shared = { ...defaultModelForm, capability };
  if (capability === "ASR") {
    return {
      ...shared,
      name: "豆包语音识别",
      provider: "doubao",
      protocol: "doubao-asr",
      model: "volc.bigasr.auc_turbo",
      baseUrl: "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash",
      envVarName: "DOUBAO_ASR_ACCESS_KEY",
      timeoutSeconds: 300,
      description: "用于会议录音、电话录音和访谈音频转写。"
    };
  }
  if (capability === "OCR") {
    return {
      ...shared,
      name: "MinerU OCR / 文档解析",
      provider: "mineru",
      protocol: "mineru",
      model: "mineru",
      envVarName: "PDF_MINERU_API_KEY",
      timeoutSeconds: 300,
      description: "用于扫描件、图片文字、复杂 PDF 版面和表格解析。"
    };
  }
  if (capability === "PDF_PARSER") {
    return {
      ...shared,
      name: "PDF 文档解析",
      provider: "local",
      protocol: "local-pdf-parse",
      model: "pdf-parse",
      envVarName: "",
      timeoutSeconds: 60,
      description: "用于普通文本型 PDF 的本地解析。"
    };
  }
  return {
    ...shared,
    name: capability === "VISION" ? "OpenAI 兼容视觉模型" : capability === "EMBEDDING" ? "OpenAI 兼容向量模型" : "OpenAI 兼容大模型",
    provider: "openai-compatible",
    protocol: capability === "EMBEDDING" ? "embeddings" : "responses",
    baseUrl: "https://api.openai.com/v1",
    envVarName: "OPENAI_API_KEY",
    description: "按 OpenAI API 兼容方式接入。"
  };
}

function llmAdapterToForm(adapter) {
  return {
    baseUrl: adapter?.baseUrl || "https://api.openai.com/v1",
    model: adapter?.model || "",
    apiKey: "",
    envVarName: adapter?.envVarName || "OPENAI_API_KEY",
    timeoutSeconds: adapter?.timeoutSeconds || 120
  };
}

function doubaoAdapterToForm(adapter) {
  return {
    baseUrl: adapter?.baseUrl || "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash",
    appKey: adapter?.appKey || "",
    model: adapter?.model || "volc.bigasr.auc_turbo",
    apiKey: "",
    envVarName: adapter?.envVarName || "DOUBAO_ASR_ACCESS_KEY",
    timeoutSeconds: adapter?.timeoutSeconds || 300
  };
}

function modelStatusLabel(status) {
  return {
    active: "启用",
    disabled: "停用",
    draft: "草稿"
  }[status] || status || "未知";
}

function statusLabel(status) {
  return {
    uploaded: "已上传",
    transcription_pending: "待转写",
    processing: "处理中",
    parsed: "已解析",
    compiled: "已编译",
    completed: "已完成",
    failed: "失败"
  }[status] || status || "未知";
}

function roleText(role) {
  return {
    admin: "管理员",
    project_manager: "项目经理",
    customer: "客户"
  }[role] || role || "成员";
}

function userInitial(name) {
  return String(name || "用").trim().slice(0, 1) || "用";
}

function memberTypeLabel(type) {
  return {
    manager: "项目经理",
    customer: "客户成员",
    tech: "技术组员"
  }[type] || type || "成员";
}

function projectStatusLabel(status) {
  return {
    active: "进行中",
    pending: "待确认",
    completed: "已完成",
    archived: "已归档",
    disabled: "已停用"
  }[status] || status || "进行中";
}

function projectStatusClass(status) {
  return {
    active: "active",
    pending: "pending",
    completed: "completed",
    archived: "archived",
    disabled: "archived"
  }[status] || "active";
}

function isAiActor(log = {}) {
  const actor = `${log.actorName || ""}${log.actor || ""}${log.detail || ""}`;
  return actor.includes("AI") || actor.includes("编译器") || actor.includes("自动");
}

function ingestStepMessage(job = {}) {
  if (job.status === "completed") return "处理完成，资料库和 Wiki 已更新。";
  if (job.status === "failed") return job.error || "处理失败。";
  return {
    queued: "任务已提交，等待后台处理...",
    extract: "正在解析文件内容...",
    transcribe: "正在转写录音并做说话人分离...",
    compile: "正在编译 Wiki、识别需求差异和变更记录...",
    completed: "处理完成。"
  }[job.step] || "后台处理中...";
}

function progressValueForStep(step) {
  return {
    queued: 12,
    extract: 35,
    transcribe: 45,
    compile: 78,
    completed: 100
  }[step] || 20;
}

function shouldCompileSource(source) {
  return Boolean(source && source.status !== "compiled" && source.status !== "processing");
}

function changeStatusActionMeta(status) {
  if (status === "已确认") {
    return {
      title: "客户已确认，写入当前需求？",
      label: "写入",
      tone: "add",
      description: "仅在客户已确认后使用。确认后，这条变更会写入当前需求池，并保留来源和历史记录。"
    };
  }
  if (status === "需客户确认") {
    return {
      title: "提交客户确认？",
      label: "待确认",
      tone: "pending",
      description: "确认后，这条变更会进入客户待确认状态；客户确认前不会写入当前需求池。"
    };
  }
  if (status === "已驳回") {
    return {
      title: "确认驳回这条变更？",
      label: "驳回",
      tone: "remove",
      description: "确认后，这条变更会被标记为已驳回，当前需求池不会采用该变更。"
    };
  }
  return {
    title: "确认更新变更状态？",
    label: "更新",
    tone: "edit",
    description: "确认后，系统会更新这条变更的处理状态。"
  };
}

function changeStatusNotice(status) {
  if (status === "已确认") return "变更已确认并写入需求。";
  if (status === "需客户确认") return "变更已标记为需客户确认。";
  if (status === "已驳回") return "变更已驳回。";
  return "变更状态已更新。";
}

function compareSourceFileByDocumentDateAsc(a, b) {
  const diff = sourceDocumentTimestamp(a) - sourceDocumentTimestamp(b);
  if (diff !== 0) return diff;
  const uploadedDiff = Date.parse(a.uploadedAt || "") - Date.parse(b.uploadedAt || "");
  if (Number.isFinite(uploadedDiff) && uploadedDiff !== 0) return uploadedDiff;
  return String(a.originalName || a.title || "").localeCompare(String(b.originalName || b.title || ""), "zh-CN");
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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isTaskDone(status) {
  return ["已确认", "已完成", "已关闭", "已驳回"].includes(status);
}

function priorityClass(priority) {
  if (["高", "严重", "高风险"].includes(priority)) return "high";
  if (["中", "中风险"].includes(priority)) return "medium";
  return "low";
}

export default App;
