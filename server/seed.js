import { emptyDb } from "./schema.js";
import { ensureModelRegistry } from "./modelRegistry.js";

const now = new Date().toISOString();

export function createSeedDb() {
  const db = emptyDb();

  db.users.push(
    { id: "usr_pm", name: "李明", role: "产品经理" },
    { id: "usr_zhang", name: "张伟", role: "客户负责人" },
    { id: "usr_wang", name: "王芳", role: "业务代表" }
  );

  db.projects.push({
    id: "proj_retail",
    name: "智慧零售系统",
    customerName: "星河商业集团",
    stage: "需求沟通阶段",
    ownerId: "usr_pm",
    startDate: "2026-05-01",
    expectedEndDate: "2026-07-25",
    status: "active",
    createdAt: now,
    updatedAt: now
  });

  db.projectMembers.push(
    { id: "mem_pm", projectId: "proj_retail", userId: "usr_pm", role: "项目经理" },
    { id: "mem_zhang", projectId: "proj_retail", userId: "usr_zhang", role: "客户成员" },
    { id: "mem_wang", projectId: "proj_retail", userId: "usr_wang", role: "客户成员" }
  );

  db.requirements.push(
    {
      id: "req_member_level",
      projectId: "proj_retail",
      moduleName: "会员管理",
      title: "会员等级规则",
      description: "会员等级按累计消费金额升级，支持基础等级权益展示。",
      acceptanceCriteria: "会员等级、权益、升级条件可配置，前台可展示当前等级。",
      status: "已确认",
      priority: "高",
      proposer: "张伟",
      owner: "李明",
      sourceIds: [],
      createdAt: now,
      updatedAt: now
    },
    {
      id: "req_return_apply",
      projectId: "proj_retail",
      moduleName: "订单管理",
      title: "退货申请",
      description: "用户可在订单详情中提交退货申请，客服可查看并处理。",
      acceptanceCriteria: "退货申请需记录订单、商品、原因、申请人和处理状态。",
      status: "待确认",
      priority: "中",
      proposer: "王芳",
      owner: "李明",
      sourceIds: [],
      createdAt: now,
      updatedAt: now
    },
    {
      id: "req_coupon_share",
      projectId: "proj_retail",
      moduleName: "营销中心",
      title: "优惠券分享",
      description: "用户可将优惠券分享至社交平台。",
      acceptanceCriteria: "优惠券分享链接可追踪来源并限制领取次数。",
      status: "待确认",
      priority: "低",
      proposer: "陈晨",
      owner: "李明",
      sourceIds: [],
      createdAt: now,
      updatedAt: now
    }
  );

  db.requirements.forEach((requirement) => {
    db.requirementVersions.push({
      id: `ver_${requirement.id}`,
      requirementId: requirement.id,
      projectId: requirement.projectId,
      version: 1,
      description: requirement.description,
      acceptanceCriteria: requirement.acceptanceCriteria,
      sourceChangeId: null,
      createdBy: "seed",
      createdAt: now
    });
  });

  db.wikiPages.push(
    {
      id: "wiki_overview",
      projectId: "proj_retail",
      type: "PROJECT_OVERVIEW",
      title: "项目总览",
      slug: "project-overview",
      summary: "智慧零售系统需求沟通阶段的持续编译总览。",
      content:
        "# 项目总览\n\n智慧零售系统正在需求沟通阶段。当前重点模块包括会员管理、订单管理、营销中心和数据报表。\n\n## 当前焦点\n\n- 会员等级规则仍需确认升级口径。\n- 退货申请流程需要补充售后分派规则。\n- 优惠券分享范围存在一期边界讨论。\n\n## 项目知识结构图\n\n```mermaid\nflowchart LR\n  source[\"来源资料\"] --> compiler[\"AI 编译\"]\n  compiler --> wiki[\"项目 Wiki\"]\n  compiler --> changes[\"待确认变更\"]\n  changes --> requirements[\"确认后更新需求池\"]\n  wiki --> export[\"Markdown / Obsidian 导出\"]\n```",
      tags: ["overview"],
      sourceIds: [],
      updatedAt: now,
      createdAt: now
    },
    {
      id: "wiki_member_module",
      projectId: "proj_retail",
      type: "MODULE",
      title: "会员管理",
      slug: "module-member",
      summary: "会员等级、权益、积分和客户身份相关需求。",
      content: "# 会员管理\n\n会员管理模块覆盖会员等级规则、权益展示、积分口径和人工调整能力。",
      tags: ["module", "会员管理"],
      sourceIds: [],
      updatedAt: now,
      createdAt: now
    },
    {
      id: "wiki_return_apply",
      projectId: "proj_retail",
      type: "REQUIREMENT",
      title: "退货申请",
      slug: "requirement-return-apply",
      summary: "订单售后流程中的退货申请能力。",
      content: "# 退货申请\n\n用户可在订单详情中提交退货申请，客服可查看并处理。当前仍需确认分派规则和必填字段。",
      tags: ["requirement", "订单管理"],
      sourceIds: [],
      updatedAt: now,
      createdAt: now
    }
  );

  db.wikiPages.forEach((page) => {
    db.wikiPageVersions.push({
      id: `wver_${page.id}`,
      wikiPageId: page.id,
      projectId: page.projectId,
      version: 1,
      title: page.title,
      summary: page.summary,
      content: page.content,
      sourceFileId: null,
      changeReason: "初始种子数据",
      createdBy: "seed",
      createdAt: now
    });
  });

  db.changes.push(
    {
      id: "chg_member_level",
      projectId: "proj_retail",
      requirementId: "req_member_level",
      changeType: "修改",
      moduleName: "会员管理",
      title: "会员等级规则",
      beforeContent: "会员等级按累计消费金额升级。",
      afterContent: "会员等级可能改为自然年累计消费金额，并增加人工调整入口。",
      summary: "修改会员升级条件的计算逻辑。",
      impactScope: "会员等级、权益展示、后台配置",
      sourceFileId: null,
      proposer: "张伟",
      confidence: 0.9,
      status: "待确认",
      createdAt: now,
      updatedAt: now
    },
    {
      id: "chg_return_apply",
      projectId: "proj_retail",
      requirementId: "req_return_apply",
      changeType: "新增",
      moduleName: "订单管理",
      title: "退货申请",
      beforeContent: "",
      afterContent: "新增退货原因必填校验和处理人分派规则。",
      summary: "新增退货原因必填校验规则。",
      impactScope: "订单售后流程",
      sourceFileId: null,
      proposer: "王芳",
      confidence: 0.86,
      status: "待确认",
      createdAt: now,
      updatedAt: now
    }
  );

  db.communications.push({
    id: "comm_review_001",
    projectId: "proj_retail",
    title: "需求评审会议 2026-05-12",
    type: "需求评审会议",
    participants: ["张伟", "王芳", "李明", "陈晨"],
    sourceFileId: null,
    summary: "围绕会员等级、退货申请和优惠券边界进行评审。",
    meetingTime: "2026-05-12T10:00:00.000Z",
    createdBy: "李明",
    createdAt: now
  });

  return ensureModelRegistry(db);
}
