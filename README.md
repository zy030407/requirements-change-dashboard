# 木铎知会

标准说明文件
目录
背景
安装
用途
发生器
徽章
示例 READMEs
相关努力
维护者
贡献
撰稿人
许可

组织沟通与知识沉淀平台。本项目已从静态前端原型升级为本地可运行的 Node 全栈 MVP，核心能力是把会议录音、文档、截图和业务资料自动编译成项目内 LLM Wiki，并生成待确认需求、决策、风险和变更记录。

## 启动

```bash
npm install
npm run dev
```

- 前端：http://localhost:5173
- API：http://localhost:4000/api/health

如需真实 OpenAI 编译能力，复制 `.env.example` 为 `.env`，填写 `OPENAI_API_KEY`。
未配置 Key 时，系统会使用本地启发式编译器跑通完整流程。

## 商业化部署底座

当前代码保留本地 JSON 开发模式，同时已加入生产化边界：

- PostgreSQL schema：`prisma/schema.prisma`
- JSON 迁移脚本：`npm run migrate:json`
- 阿里云 OSS 存储抽象：`STORAGE_PROVIDER=oss`
- BullMQ/Redis 异步任务队列：`JOB_QUEUE_PROVIDER=bullmq`
- API/Worker 拆分：`npm start` 与 `npm run start:worker`
- Docker Compose：PostgreSQL、Redis、API、Worker

生产环境必须配置：

```bash
NODE_ENV=production
SESSION_SECRET=足够长的随机字符串
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
JOB_QUEUE_PROVIDER=bullmq
STORAGE_PROVIDER=oss
ALI_OSS_REGION=oss-cn-hangzhou
ALI_OSS_BUCKET=你的私有 Bucket
ALI_OSS_ACCESS_KEY_ID=...
ALI_OSS_ACCESS_KEY_SECRET=...
```

OSS Bucket 应设置为私有读写；前端预览和下载通过后端鉴权后生成短期签名 URL。

## 已实现

- 项目看板 API 化：指标、趋势、状态、最近变更、来源资料均来自后端。
- 资料上传：支持文本、Markdown、PDF、Word、Excel、图片、音频等入口。
- 自动编译：解析资料后更新 Wiki 页面版本，并生成变更、决策、风险、待确认事项。
- 变更策略：AI 只生成待确认变更；确认后才写入当前需求池和需求历史版本。
- 项目 Wiki：支持页面列表、详情查看、来源数量、版本记录数据模型。
- Markdown 导出：一键生成 Obsidian 可打开的 `index.md`、`log.md`、`changes.md`、`sources.md` 和 wiki 页面。
- Prisma schema：提供 PostgreSQL 生产数据模型边界。

## 验证

```bash
npm run build
npm run prisma:validate
npm run dev:server
npm run smoke
```
