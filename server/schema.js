export const WIKI_PAGE_TYPES = [
  "MANAGER_BRIEF",
  "PROJECT_OVERVIEW",
  "REQUIREMENT",
  "MODULE",
  "CONCEPT",
  "SOURCE_SUMMARY",
  "DECISION",
  "RISK",
  "OPEN_QUESTION",
  "CHANGE_RECORD"
];

export const CHANGE_TYPES = ["新增", "修改", "删除", "待确认"];
export const CHANGE_STATUSES = ["待确认", "已确认", "已驳回", "需客户确认", "客户退回"];
export const REQUIREMENT_STATUSES = ["待确认", "已确认", "已驳回", "设计中", "开发中", "已完成"];

export function emptyDb() {
  return {
    projects: [],
    tenants: [],
    users: [],
    projectMembers: [],
    sourceFiles: [],
    ingestJobs: [],
    transcripts: [],
    wikiPages: [],
    wikiPageVersions: [],
    wikiLinks: [],
    sourceEvidences: [],
    requirements: [],
    requirementSuggestions: [],
    requirementVersions: [],
    changes: [],
    decisions: [],
    risks: [],
    openQuestions: [],
    communications: [],
    markdownExports: [],
    auditLogs: [],
    sessions: [],
    changeConfirmations: [],
    modelAdapters: [],
    modelPipeline: {},
    modelUsages: []
  };
}
