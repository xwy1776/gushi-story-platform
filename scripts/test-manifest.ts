/**
 * 测试清单：区分两类测试
 *
 * tests/ 目录下其实混着两种东西：
 *
 *  1. **vitest 原生用例** —— 文件里 `import { describe, it, expect } from 'vitest'`，
 *     由 `npx vitest run` 执行。
 *  2. **独立 tsx 脚本** —— 自写 `assert()` 计数 + `process.exit()`，由
 *     `npx tsx tests/xxx.test.ts` 执行。这是本项目历史遗留的主流写法，
 *     好处是能直接连数据库、跑真实 AI 调用，不需要 mock。
 *
 * 混在一起会给 vitest 造成两个问题：
 *  - 独立脚本没有注册任何用例 → vitest 报 "No test suite found in file"
 *  - 独立脚本末尾的 `process.exit()` 会打死 vitest 的 worker → segfault
 *
 * 所以这里按「有没有 import vitest」自动分类，`vitest.config.ts` 与
 * `scripts/run-tests.ts` 共用同一份清单。**新增测试文件无需改任何配置**：
 * 想被 vitest 跑就 import vitest，想当独立脚本就直接写 assert。
 */
import fs from 'fs';
import path from 'path';

const TESTS_DIR = path.resolve(__dirname, '..', 'tests');

/** 判断一个用例文件是不是 vitest 原生用例 */
function isVitestNative(file: string): boolean {
  const src = fs.readFileSync(path.join(TESTS_DIR, file), 'utf8');
  // 只看 import 语句，避免把注释里提到 vitest 的文件误判
  return /^\s*import\s[^;]*from\s+['"]vitest['"]/m.test(src);
}

function listTestFiles(): string[] {
  return fs
    .readdirSync(TESTS_DIR)
    .filter((f) => f.endsWith('.test.ts'))
    .sort();
}

/** vitest 原生用例（相对仓库根目录的路径） */
export const VITEST_TESTS: string[] = listTestFiles()
  .filter(isVitestNative)
  .map((f) => `tests/${f}`);

/** 独立 tsx 脚本（相对仓库根目录的路径） */
export const STANDALONE_TESTS: string[] = listTestFiles()
  .filter((f) => !isVitestNative(f))
  .map((f) => `tests/${f}`);
