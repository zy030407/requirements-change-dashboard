# 木铎知会

## 目录
- [项目简介](#项目简介)
- [核心功能](#核心功能)
- [技术栈](#技术栈)
- [快速开始](#快速开始)
- [环境变量配置](#环境变量配置)
- [数据库模型](#数据库模型)
- [商业化部署底座](#商业化部署底座)
- [验证](#验证)
- [参与贡献](#参与贡献)
- [开源协议](#开源协议)

## 项目简介

  一款结合“组织沟通”与”知识沉淀”的平台,核心功能是把会议录音、文档、截图和业务资料等信息源自动编译成项目内 LLM Wiki，并自动生成待确认的需求、决策以及伴随的风险。根据后续项目进程也会不断生成待确
  
  认的需求变更。
<img width="958" height="507" alt="image" src="https://github.com/user-attachments/assets/fc1f186b-dd4f-4c67-81be-9eafbcd39066" />



## 核心功能

```mermaid
flowchart LR
    A[上传资料] --> B[自动解析]
    B --> C[提取信息]
    C --> D[AI生成待确认需求清单]
    D --> E{人工确认}
    E -->|确认| F[写入需求池]
    E -->|修改| D
    F --> G[需求历史版本]
    G --> H[项目看板]
    G --> I[项目Wiki]
    G --> J[Markdown导出]
    H --> K[(PostgreSQL)]
    I --> K
    J --> K
```

- **资料上传**：支持文本、Markdown、PDF、Word、Excel、图片、音频等多种格式文件上传。

- **自动解析与更新**：上传资料后，系统自动分析内容，更新项目 Wiki 页面版本，并生成变更点、决策记录、风险提示、待确认事项。

- **AI 辅助变更**：AI 只负责生成“待确认的变更项”；只有你手动确认后，这些变更才会正式写入当前需求池和需求历史版本。

- **项目 Wiki 管理**：提供 Wiki 页面列表、详情查看、每个页面的来源资料数量、以及完整的版本记录。

- **一键导出为 Markdown**：可一键生成 Obsidian 可直接打开的 `index.md`、`log.md`、`changes.md`、`sources.md` 文件，以及每个 Wiki 页面的独立 Markdown 文件。

- **项目看板**：所有看板数据（指标、趋势、状态、最近变更、来源资料）都来自后端，实时更新。

- **生产级数据库模型**：使用 Prisma + PostgreSQL 定义并管理完整的数据结构，适合生产环境部署。

## 技术栈

（请填写：前端、后端、数据库、AI 模型/API、部署方式等）

## 快速开始

```bash
npm install
npm run dev
```

- **前端**：http://localhost:5173

- **API**：http://localhost:4000/api/health

如需完整的 OpenAI 编译能力，请复制 .env.example 为 .env，填写 OPENAI_API_KEY。

补充：未配置 Key 时，系统会使用本地启发式编译器跑通完整流程。


## 环境变量设置

# 开发环境

复制 .env.example 为 .env，至少配置

```bash
OPENAI_API_KEY=your key
```

# 生产环境

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

## 数据库模型

Prisma schema 定义在 prisma/schema.prisma，支持 PostgreSQL 生产环境。

本地开发可使用 JSON 模式：npm run migrate:json

## 商业化部署底座

当前代码保留本地 JSON 开发模式，同时已加入生产化边界：

- **数据库**：PostgreSQL schema → `prisma/schema.prisma`
- **本地开发备选**：JSON 迁移脚本 → `npm run migrate:json`
- **对象存储**：阿里云 OSS 抽象 → `STORAGE_PROVIDER=oss`
- **异步队列**：BullMQ + Redis → `JOB_QUEUE_PROVIDER=bullmq`
- **进程拆分**：API 与 Worker 分离 → `npm start` 与 `npm run start:worker`
- **容器编排**：Docker Compose 集成 → PostgreSQL、Redis、API、Worker

## 参与贡献

（请填写：如何提 Issue、Fork、PR 流程，贡献方向）

## 开源协议

（请填写：MIT / Apache 2.0 等）

## 验证

```bash
npm run build
npm run prisma:validate
npm run dev:server
npm run smoke
```
