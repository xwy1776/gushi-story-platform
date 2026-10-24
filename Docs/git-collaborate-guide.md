# 古事项目 Git 协作规范
> 适用仓库：gushi‑story‑platform
## 1、分支策略
1. `master`：保护主分支，存放稳定可运行版本，**禁止直接在master修改代码**。
2. 个人开发分支命名格式：`名字/任务简述`
    示例：`ronghai/kg-engine`、`xiaowenyu/eval‑script`
3. 工作流程：从master拉取个人分支，在自己分支写代码；完成后提交PR合并回master。
4. 多人并行开发：开工前先拉取master最新代码，避免后期大量冲突。

## 2、Commit 提交信息规范
格式：`类型: 简短描述`

| 前缀 | 用途 | 示例 |
|---|---|---|
| `feat:` | 新增功能 | `feat: 知识图谱接入续写接口` |
| `fix:` | 修复bug | `fix: 修复BFS搜索边界问题` |
| `docs:` | 文档新增/修改 | `docs: 新增Neo4j调研报告` |
| `test:` | 单元测试、测试脚本 | `test: 增加图谱单元用例` |
| `chore:` | 配置、依赖、工程杂项 | `chore: tsconfig排除scripts目录` |

> 要求：提交信息写清楚改动内容，不要写 `update`、`fix bug` 这种模糊描述。

## 3、Pull Request（PR）流程
1. 本地开发完成，commit完毕，push到远程个人分支。
2. GitHub页面点击 Compare & pull request，发起PR。
3. PR标题使用同样commit前缀风格，描述写明：做了什么、改动文件、测试情况。
4. 至少一名组员（组长）review，确认没问题再点Merge。
5. Merge之后，本地切回master，执行pull同步最新代码。

## 4、计划CI配置（GitHub Actions）
目标：提交PR时自动执行检查，拦截类型错误代码合并进master。
- 触发时机：push、Pull Request 到 master分支
- 执行步骤：
  1. 安装依赖 `npm install`
  2. 执行类型检查 `npx tsc`
> 如果tsc报错，CI直接失败，不允许合并PR。

### CI配置文件位置
`.github/workflows/type‑check.yml`
> 本阶段仅编写规范文档；yaml配置文件可以后续再补实现。

## 5、日常操作模板
```bash
# 每次开工，同步master最新
git checkout master
git pull origin master

# 创建自己分支
git checkout -b ronghai/xxx‑task

# 改完代码
git add .
git status
git commit -m "feat: xxx功能"

# 推远程
git push origin ronghai/xxx‑task
# 去网页提交PR