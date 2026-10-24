# CLAUDE.md - 古事 (Gushi) 项目指南

## 项目概述

古事是一个基于历史/经典故事关键片段的分叉故事续写平台。用户选择历史故事的关键转折点，系统通过 AI 生成连续的分叉故事线。

## 技术栈

- **框架**: Next.js 13 (App Router) + TypeScript + React 18
- **样式**: TailwindCSS
- **数据库**: PostgreSQL (Prisma ORM) + JSON 文件存储 (`data/` 目录，通过 `src/lib/simple-db.ts`)
- **AI**: OpenAI-compatible API（文本续写 + 图片生成）
- **部署**: Docker / Docker Compose（Redis + Nginx）+ Capacitor（iOS/Android）
- **测试**: vitest（原生用例）+ 独立 `tsx` 脚本，两者混用，见下方「测试」一节
- **认证**: NextAuth.js

## 项目结构

```
src/
├── app/                    # Next.js App Router 页面和 API 路由
│   ├── api/                # API 端点
│   │   ├── stories/        # 故事 CRUD、续写、分叉、时间轴、导演模式
│   │   ├── knowledge/      # 知识搜索与事实核查
│   │   ├── images/         # 图片生成与风格推荐
│   │   ├── auth/           # 认证（注册/NextAuth）
│   │   └── me/             # 用户相关
│   └── page.tsx            # 主页面
├── components/             # React 组件
├── lib/                    # 核心库
│   ├── simple-db.ts        # JSON 文件存储引擎
│   ├── prisma.ts           # Prisma 客户端
│   ├── ai-client.ts        # AI API 客户端
│   ├── prompt-builder.ts   # AI 提示词构建
│   ├── timeline-engine.ts  # 时间轴校验（时间单调性检测）
│   ├── character-engine.ts # 角色系统
│   ├── pacing-engine.ts    # 叙事节奏控制 (rush/detailed/pause/summary)
│   ├── director-manager.ts # 导演模式（角色状态、世界变量、叙事约束）
│   ├── context-summarizer.ts  # 上下文摘要
│   ├── branch-memory.ts    # 分叉记忆
│   ├── consistency-checker.ts # 一致性检查
│   ├── lorebook.ts         # 世界观设定集
│   ├── knowledge-cache.ts  # 知识缓存
│   ├── web-search.ts       # 网络搜索
│   └── mcp-wikipedia.ts    # MCP 维基百科集成
├── types/                  # TypeScript 类型定义
└── middleware.ts           # Next.js 中间件

prisma/
├── schema.prisma           # 数据库 Schema（User, Account, Session, Story, StoryBranch 等）
├── seed.ts                 # 数据库种子
└── migrations/             # 数据库迁移

data/                       # JSON 文件存储（stories, branches, segments, characters 等）
scripts/                    # 工具脚本
tests/                      # 测试（见下方「测试」一节）
```

## 常用命令

```bash
npm run dev                 # 启动开发服务器
npm run build               # 构建
npm run db:migrate          # Prisma 迁移
npm run db:push             # Prisma 推送 Schema
npm run db:seed             # 数据库种子
npm run db:studio           # Prisma Studio
npm test                    # 跑全部测试（见下方「测试」一节）
npm run test:unit           # 只跑 vitest 原生用例
npm run test:scripts        # 只跑独立 tsx 脚本
npm run migrate:json        # JSON → PostgreSQL 迁移
npm run migrate:validate    # 验证迁移
npm run migrate:appearance  # 角色 traits 前缀 → 结构化 appearance/canonicalName 迁移（支持 --dry-run）
npm run experiment:consistency   # 图文一致性实验：有外观约束 vs 无约束（--dry-run 先零成本预览）
npm run experiment:before-after  # 生图 Prompt 优化前后对比：旧管线复现 vs C3 锚点（--dry-run 先预览）
npm run experiment:paired        # 配对比较批量实验：N 故事 × 3 段 × 前后 2 组（默认 4 个 preset；--dry-run 先预览；产出一父目录 + manifest.json）
npm run analyze:paired -- --runs <实验目录> [--emit-template]  # 配对统计：生成评分表模板 / 由评分与文本指标出 stats.md（Wilcoxon 精确符号秩 + McNemar + bootstrap CI）
```

## 测试

**`tests/` 目录下混着两类测试，这是本项目最容易踩的坑：**

| 类型 | 判断依据 | 运行方式 |
|---|---|---|
| **vitest 原生用例** | 文件里 `import { describe, it, expect } from 'vitest'` | `npx vitest run` |
| **独立 tsx 脚本** | 自写 `assert()` 计数 + 结尾 `process.exit()` | `npx tsx tests/xxx.test.ts` |

绝大多数测试是**独立 tsx 脚本**（因为它们要连真实数据库、跑真实 AI，不方便 mock）。
把它们交给 vitest 会报 `No test suite found in file`，并且结尾的 `process.exit()`
会把 vitest 的 worker 打崩（segfault）—— 所以 `vitest.config.ts` 按
「有没有 import vitest」自动把它们排除掉（判定逻辑见 `scripts/test-manifest.ts`）。

**统一入口**：`npm test` 两类都跑并汇总（`scripts/run-tests.ts`）。
新增测试文件**不需要改任何配置**：想被 vitest 跑就 import vitest，想当独立脚本就直接写 `assert()`。

```bash
npm test                    # 全部
npm test -- --unit          # 只跑 vitest 原生用例
npm test -- --scripts       # 只跑独立 tsx 脚本
npm test -- state-tracker   # 只跑文件名匹配关键字的独立脚本
```

**前置条件**：独立脚本需要数据库，先 `docker compose up -d postgres`。
`DATABASE_URL` 会被 `tests/test-env.ts` 自动从容器主机名改写为 `localhost:5433`，
**每个独立脚本都必须在所有其他 import 之前写 `import './test-env';`**，
否则报 `getaddrinfo ENOTFOUND postgres`。

## 开发约定

- API 路由遵循 Next.js App Router 约定（`route.ts`）
- 数据层双模式：Prisma（PostgreSQL）和 JSON 文件存储并存，正在从 JSON 迁移到 Prisma
- AI 续写支持流式输出（`stream-continue` 端点）
- 续写时自动通过维基百科检索历史实体注入事实锚点，防止幻觉
- 时间轴引擎会校验叙事时间单调性，自动检测时间倒流
- 角色外观使用独立结构化字段 `Character.appearance`（及 `canonicalName`）；`traits` 只存性格特征，禁止再以 `appearance:` 前缀形式拼装（旧数据用 `npm run migrate:appearance` 迁移，读写统一走 `src/lib/character-fields.ts`）
- 生图 prompt 由固定模板拼装（`src/lib/image-prompt-template.ts`）：场景描述 + 冻结"角色外观锚点"（逐字来自 `Character.appearance`）+ 风格模板；场景提取 LLM 禁止描写外貌、只输出每镜头登场角色名单，保证同一角色跨段落/跨图外观稳定（C3）
- 生图 seed 由 `src/lib/image-seed.ts` 统一派生（勿再手写哈希）：默认 identity 策略——同一故事共享身份 seed 锁脸/体态、同段多图 stride=0；diverse（角色集合+段落盐）保留可切换（请求 `seedStrategy` / 环境变量 `IMAGE_SEED_STRATEGY`）；已有图片的段落重生成自动加变体 nonce（C2/C5）
- 角色外观为固定 5 段结构（年龄性别→五官与须式→发型→身高体型体态→服装配饰，上限 480 字符，C5）；**须式必须明确写出（具体须型或 clean-shaven；女性角色豁免）**，生成（character-engine 两处）/ 存量升级（enrich）/ 完成度判定三处同口径走 `src/lib/appearance-structure.ts`；新增走 character-engine 生成（自动与已登记角色强制区分，C5-②），存量升级/撞脸体检用 `npm run enrich:appearance`；外观字段/结构升级（补维度、改段式）时必须连带同步「用户手填入口」链路——创建页「外貌描述」提示文案（`src/app/create/page.tsx`）、创建 API 截断上限（`src/app/api/stories/route.ts`，现 480）、角色面板展示（曾因漏掉此链路返工，2026-10-04 补记）；多角色同框锚点自动附加"互不串脸"约束行
- 生图与续写的同步约定（C1/C4）：场景状态带 `lastSegmentId` 新鲜度标记、生图端读前经 `waitForSceneStateFresh` 追平，且续写后处理中场景状态更新必须排在角色发现之前；角色发现完成后必须调用 `characterManager.markCharacterDiscoveryDone`，生图端自发现前先经 `waitForCharacterDiscovery` 等待追平（防双端并发注册、防"刚续写就生图"图文不符）
- 图文对齐约定（C4-②）：场景状态**仅对分支末段注入**（历史段落生图跳过）；上下文窗口必须按目标段对齐（`locateSegmentContext`，勿再用 `slice(-6,-1)` 取链路末端）；送 LLM 的段落文本一律经 `sampleSegmentText` 头+尾采样（长段落只截头会丢段尾关键画面）
- 生图提取有效性守卫（提取 LLM → 生图 API 之间的质检关卡，2026-10-02）：`extractSceneDescriptionsWithAI` 对提取结果逐条校验（`isValidEnPrompt`：enPrompt 经 CJK 剥离后 ≥60 字符且 ≥10 字母词）——0 条有效 → 强化指令整组重试一次；仍缺 → 按 `description` 兜底重写（**description 也没有 → 弃用该镜头**，不得拿残存 enPrompt 回炉重写）；全坏 → 启发式回退；`generateImagesForSegment` 装配末端有「守卫终检」（非 preset 通道低于阈值的场景 prompt 一律不送生图 API，宁缺毋滥）；启发式翻译通道逐条校验 + 英文兜底脚手架。改动此链路时跑 `tests/image-generator-guard.test.ts`；正常路径必须保持零额外 AI 调用
- 环境变量：`AI_API_KEY`, `AI_BASE_URL`, `DATABASE_URL` 等（参考 `.env.example`）

## 注意事项

- `data/` 目录包含 JSON 格式的运行时数据，修改时需谨慎
- Prisma schema 变更后需运行 `npx prisma generate` 和 `npx prisma db push`
- Docker 部署配置见 `docker-compose.yml`
