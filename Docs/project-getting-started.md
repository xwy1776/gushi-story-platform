# 古事项目前后端框架入门文档
> 面向零基础组员，本项目基于 Next.js14 App Router + Prisma + Docker。
读完本文档可以完成：本地环境搭建、启动项目、理解主要目录结构、数据库操作、常见报错排查。

## 一、技术栈总览
| 模块 | 技术 | 作用 |
|---|---|---|
| 全栈框架 | Next.js 14（App Router） | 前端页面 + 后端API接口一体化 |
| 前端 | React18 + TypeScript + TailwindCSS | 页面组件、交互逻辑 |
| 后端API | Next.js Route Handler | `src/app/api/**/route.ts` 编写后端接口 |
| ORM | Prisma | 操作PostgreSQL数据库，管理数据表模型 |
| 数据库 | PostgreSQL | 项目主存储；早期版本同时兼容JSON文件存储 |
| 运行部署 | Docker / Docker Compose | 容器一键拉起整套服务 |
| 类型检查 | TypeScript + npx tsc | 编译前做类型校验，提前发现bug |
| 测试 | Vitest | 单元测试脚本 |

## 二、本地环境前置依赖
### 方式A：裸机本地运行（不使用Docker）
需要本机安装：
1. Node.js >= 20 LTS
2. npm / pnpm
3. PostgreSQL数据库（本地或远程实例）

### 方式B：Docker容器运行（推荐，不需要本机装PostgreSQL）
需要本机安装：
1. Docker Desktop（Windows/macOS）
> Docker会自动拉起PostgreSQL数据库容器、Next.js应用容器。

## 三、获取代码
```bash
# 克隆仓库
git clone https://github.com/xwy1776/gushi-story-platform.git
cd gushi-story-platform

# 切换到master，拉取最新代码
git checkout master
git pull origin master
```

## 四、环境配置 .env
复制 .env.example 生成 .env，填写关键配置：
```env
# 数据库连接字符串（Docker环境无需修改；裸机运行改为自己本地PG地址）
DATABASE_URL="postgresql://xxx:xxx@localhost:5432/gushi?schema=public"

# AI接口配置，对接兼容OpenAI格式的大模型服务
AI_BASE_URL=""
AI_API_KEY=""
AI_MODEL=""

# 业务开关示例：开启后续写接口会加载本地知识图谱，将图谱设定注入AI提示词
ENABLE_KNOWLEDGE_GRAPH=false
```
重要：.env 文件包含密钥，不要提交到 git。
## 五、数据库初始化（Prisma）
Prisma 是本项目 ORM，数据表定义文件：prisma/schema.prisma
```bash
# 1. 根据schema生成数据库表
npx prisma migrate dev

# 2. 生成本地Prisma类型代码
npx prisma generate

# 3.（可选）图形化查看数据库
npx prisma studio
```
## 六、启动项目
裸机方式
```bash
# 安装依赖
npm install

# 开发模式启动
npm run dev
```
访问：http://localhost:3000

Docker Compose 方式
```bash
# 一键拉起全部服务（Next.js + PostgreSQL）
docker-compose up -d

# 查看日志
docker-compose logs -f
```
## 七、关键目录说明（核心业务逻辑）
```plaintext
src/
├── app/                # Next.js App Router
│   ├── api/            # 所有后端接口，**route.ts就是后端接口**
│   │   └── stories/[id]/continue/route.ts # 故事续写接口，包含知识图谱开关逻辑
│   └── 各个页面路由
├── lib/                # 核心业务库（论文核心模块全部在这里）
│   ├── knowledge-graph.ts      # 知识图谱引擎：加载JSON图谱、BFS多跳查询、格式化图谱内容
│   ├── narrative-state-tracker.ts #叙事状态追踪
│   ├── prisma.ts               # prisma数据库实例
│   ├── ai-client.ts            # 调用大模型统一封装
│   └── prompt-builder.ts       # prompt组装逻辑
├── types/              # TS类型定义
└── components/         # 前端UI组件

prisma/
└── schema.prisma       # 数据库表结构定义

data/                   # JSON样例数据、测试图谱json
Docs/                   # 文档、实验结果、调研报告
scripts/                # 临时调试脚本，tsconfig已排除编译检查
tests/                  # vitest单元测试
```
开发小常识 
1. 写后端接口：新建 src/app/api/xxx/route.ts，导出 async GET/POST 函数。 
2. 修改数据库字段：修改prisma/schema.prisma，执行npx prisma migrate dev生成迁移。 
3. 类型检查：npx tsc，零报错才代表类型没问题。
## 八、常见踩坑与排错
### 数据库连接失败
检查 .env 的DATABASE_URL，确认 PostgreSQL 已经启动，端口、账号密码正确。 
### prisma migrate
报错不要手动修改数据库表，全部通过schema.prisma + migrate dev变更。
### tsc 报类型错误
优先修改 src 下业务代码；scripts 目录临时脚本已经被 tsconfig 排除，不用管。
### AI 调用失败
检查AI_API_KEY、AI_BASE_URL，确认 API 服务网络可访问。
### 不要直接在 master 分支开发，新建个人开发分支。  
### 知识图谱功能不生效
确认.env 文件中 ENABLE_KNOWLEDGE_GRAPH=true；
同时确认 data 目录下存在对应的图谱 JSON 文件。
## 九、简单开发流程示例
```bash
# 从master拉新分支
git checkout -b yourname/task-name
# 修改代码后检查类型
npx tsc
# 提交代码
git add .
git commit -m "feat: xxx功能"
# 推送到远程仓库
git push origin yourname/task-name
```
推送完成后，去 GitHub 网页提交 PR 等待 review 合并。
```plaintext

### ✅ 要点说明
- Markdown 区分 **```bash**（终端命令）和 **```env**（环境变量），两种代码块标记不一样，所以不是一直都是bash。
- 第4部分是环境变量，所以用 ```env，不是bash；后面终端命令继续换回 ```bash。
- 你直接**全选复制上面整个框内内容**，粘贴覆盖你的md文件，VSCode会自动识别全部代码块。

粘贴保存完成后执行：
```powershell
git add Docs/project-getting-started.md
git commit -m "docs: 完善入门文档，统一代码块格式"
git status