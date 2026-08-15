# Gushi Docker 部署步骤（团队版）

> 2026-08-16 整理 | 导师要求：代码必须在 Docker 环境实际跑通验证

## 部署结构

`docker-compose.yml` 包含 5 个服务：

| 服务 | 说明 | 端口 | 默认是否启动 |
|------|------|------|------------|
| `postgres` | PostgreSQL 16 数据库 | 5433（宿主机）/ 5432（容器） | ✅ 是 |
| `gushi-app` | 生产应用（Dockerfile 构建） | 3000 | ✅ 是 |
| `gushi-dev` | 开发热重载服务 | 3001 | ⏹ profile: dev |
| `gushi-redis` | Redis 缓存（可选） | 6379 | ⏹ profile: redis |
| `gushi-nginx` | Nginx 反代（可选） | 80/443 | ⏹ profile: nginx |

## 前置条件

- 安装 Docker Desktop（Windows）/ docker + docker-compose（Linux）
- `.env` 已配置：`AI_API_KEY`、`AI_BASE_URL`、`AI_MODEL`、`DATABASE_URL` 等
- 网络能拉取镜像（国内可用镜像加速器）

## 部署步骤（生产环境）

```bash
# 1. 进入项目目录
cd "d:/项目/Another-chance-new"

# 2. 启动 Postgres + 应用（Redis/Nginx 默认不启动）
docker compose up -d --build

# 3. 查看状态（两个服务都要 healthy/running）
docker compose ps

# 4. 初始化数据库表结构
docker compose exec gushi-app npx prisma migrate deploy
# 或：docker compose exec gushi-app npx prisma db push

# 5. 访问系统
# 浏览器打开 http://localhost:3000
```

## 跑通验证清单（导师要求）

| # | 验证项 | 预期结果 |
|---|--------|----------|
| 1 | `docker compose ps` | postgres healthy, gushi-app running |
| 2 | 打开 localhost:3000 | 看到首页，能注册/登录 |
| 3 | 创建故事 | 能建一个历史故事（如张骞出使西域） |
| 4 | 续写 3-5 段 | 每段能正常生成，页面流式输出 |
| 5 | 生成分支 | 能在某段分叉出新分支 |
| 6 | 查看日志确认新模块生效 | `docker compose logs gushi-app \| grep -i "叙事状态\|知识图谱"` 无报错 |

## 开发环境（热重载）

```bash
# 用 dev profile 启动（gushi-app 会被 gushi-dev 替代跑在 3001）
docker compose --profile dev up -d
# 访问 http://localhost:3001
```

## 常用命令

```bash
docker compose logs -f gushi-app        # 看应用日志
docker compose restart gushi-app        # 重启应用
docker compose down                     # 停止（保留数据卷）
docker compose down -v                  # 停止并清空数据（慎用！）
docker compose exec gushi-app sh        # 进入容器
```

## 常见问题

- **3000 端口被占用**：改 `docker-compose.yml` 里 `gushi-app.ports` 为 `"3001:3000"` 之类
- **数据库连不上**：确认 postgres 先 healthy（`docker compose ps`），重启 app：`docker compose restart gushi-app`
- **镜像拉取慢**：配置 Docker 镜像加速器，或设置代理
- **Windows 路径问题**：用 `cd /d "d:\项目\Another-chance-new"` 进目录
- **权限问题**：`backups/` 目录需存在且有写权限（`mkdir backups`）

## A/B 对比测试环境准备

跑通后，为了做"无状态表+图谱 vs 有"的对比测试，需要：
1. 建 2 个同样背景的故事（如两个"三国·桃园结义"）
2. 用 `docker compose exec gushi-app` 里的运行方式分别续写
3. 或者直接用 `/api/stories/[id]/continue` 接口，通过改代码开关状态表/图谱注入来控制 A/B

（对比脚本和结果记录由肖文宇后续补充）
