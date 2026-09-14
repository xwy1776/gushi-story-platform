/**
 * 测试环境辅助：解析数据库连接串
 *
 * 背景：项目在 Docker 里跑时 DATABASE_URL 用的是容器主机名 `postgres:5432`，
 * 而在宿主机的脚本里跑（npx tsx tests/xxx.test.ts）时该主机名无法解析，
 * 必须换成 `localhost:5433`（见 docker-compose.yml 的端口映射 5433:5432）。
 *
 * 每个测试都要手动写 DATABASE_URL=... 前缀很容易忘，忘了就报
 * "getaddrinfo ENOTFOUND postgres"。这里统一处理：
 *
 *   - 若 DATABASE_URL 指向容器主机名（postgres / db 等），自动改写为 localhost:5433
 *   - 若显式设置了非容器地址，则尊重用户的设置
 *
 * 必须在 import prisma 之前调用 resolveDatabaseUrl()，因为 Prisma Client
 * 在初始化时就会读取环境变量。
 */
import 'dotenv/config';

/** 容器内部主机名 → 宿主机映射端口 */
const CONTAINER_HOSTS = ['postgres', 'db', 'gushi-postgres'];
const HOST_PORT = '5433';

export function resolveDatabaseUrl(): string | undefined {
  const url = process.env.DATABASE_URL;
  if (!url) {
    // 没设也兜一个可用的默认值，便于本地直接跑测试
    process.env.DATABASE_URL = `postgresql://gushi:gushi_dev@localhost:${HOST_PORT}/gushi_dev`;
    return process.env.DATABASE_URL;
  }

  // 已经是 localhost / 127.0.0.1 的连接串说明用户手动指定过，原样尊重
  if (/@(localhost|127\.0\.0\.1):/.test(url)) {
    return url;
  }

  // 把容器主机名替换为 localhost，并套上宿主机的映射端口
  const rewritten = url.replace(
    /@([^:/]+):(\d+)/,
    (match, host: string, port: string) =>
      CONTAINER_HOSTS.includes(host) ? `@localhost:${HOST_PORT}` : match,
  );

  if (rewritten !== url) {
    console.log(
      `[test-env] DATABASE_URL 指向容器主机，已自动改写为宿主机地址：` +
      `${url.replace(/:[^:@]+@/, ':***@')} → ${rewritten.replace(/:[^:@]+@/, ':***@')}`,
    );
    process.env.DATABASE_URL = rewritten;
  }

  return process.env.DATABASE_URL;
}

/** 在 import prisma 之前调用，返回改写后的连接串 */
export const DATABASE_URL = resolveDatabaseUrl();
