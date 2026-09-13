/**
 * 统一测试入口：`npm test`
 *
 * 项目里有两类测试（见 scripts/test-manifest.ts 的说明），分开跑：
 *
 *   1. vitest 原生用例   → npx vitest run
 *   2. 独立 tsx 脚本     → npx tsx tests/xxx.test.ts（逐个跑，汇总断言数）
 *
 * 之所以不硬编码文件名，是为了新增测试文件时不用回来改这里。
 *
 * 前置条件：独立脚本需要数据库，先起 postgres
 *   docker compose up -d postgres
 * （DATABASE_URL 由 tests/test-env.ts 自动改写成宿主机地址）
 *
 * 用法：
 *   npm test                  # 跑全部
 *   npm test -- --unit        # 只跑 vitest 原生用例
 *   npm test -- --scripts     # 只跑独立 tsx 脚本
 *   npm test -- state-tracker # 只跑文件名匹配该关键字的独立脚本
 */
import { spawnSync } from 'child_process';
import { VITEST_TESTS, STANDALONE_TESTS } from './test-manifest';

const args = process.argv.slice(2);
const onlyUnit = args.includes('--unit');
const onlyScripts = args.includes('--scripts');
const keyword = args.find((a) => !a.startsWith('-'));

/** 用 shell: true 以便在 Windows 上解析 npx.cmd */
function run(cmd: string, cmdArgs: string[]): number {
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', shell: true });
  if (r.error) {
    console.error(`执行失败: ${cmd} ${cmdArgs.join(' ')}\n`, r.error);
    return 1;
  }
  return r.status ?? 1;
}

/** 从子进程输出里抠出 "N passed, M failed" 的统计 */
function runScript(file: string): { passed: number; failed: number; exit: number } {
  console.log(`\n${'─'.repeat(70)}\n▶ ${file}\n${'─'.repeat(70)}`);
  const r = spawnSync('npx', ['tsx', file], { encoding: 'utf8', shell: true });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  // 完整透传，避免断言详情被吞掉
  process.stdout.write(out);

  const m = out.match(/(\d+) passed, (\d+) failed/);
  return {
    passed: m ? Number(m[1]) : 0,
    failed: m ? Number(m[2]) : 0,
    exit: r.status ?? 1,
  };
}

function main(): void {
  const started = Date.now();
  let unitFailed = 0;
  let scriptPassed = 0;
  let scriptFailed = 0;
  const crashed: string[] = [];

  if (!onlyScripts) {
    console.log(`\n${'═'.repeat(70)}\n▶ vitest 原生用例（${VITEST_TESTS.length} 个文件）\n${'═'.repeat(70)}`);
    unitFailed = run('npx', ['vitest', 'run']);
  }

  if (!onlyUnit) {
    const scripts = keyword
      ? STANDALONE_TESTS.filter((f) => f.includes(keyword))
      : STANDALONE_TESTS;
    console.log(
      `\n${'═'.repeat(70)}\n▶ 独立 tsx 脚本（${scripts.length} 个文件）\n${'═'.repeat(70)}`,
    );

    for (const file of scripts) {
      const { passed, failed, exit } = runScript(file);
      scriptPassed += passed;
      scriptFailed += failed;
      // 断言全过但进程非 0 退出，说明是崩了（连不上库、抛异常等）
      if (exit !== 0 && failed === 0) crashed.push(file);
    }
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`\n${'═'.repeat(70)}\n📊 测试总览（耗时 ${secs}s）\n${'═'.repeat(70)}`);
  if (!onlyScripts) {
    console.log(`vitest 原生用例      : ${unitFailed === 0 ? '✅ 通过' : '❌ 失败'}`);
  }
  if (!onlyUnit) {
    console.log(`独立脚本断言         : ${scriptPassed} passed, ${scriptFailed} failed`);
    if (crashed.length) {
      console.log(`⚠️  异常退出（未产出断言统计）: ${crashed.join('、')}`);
    }
  }

  const ok = unitFailed === 0 && scriptFailed === 0 && crashed.length === 0;
  console.log(ok ? '\n✅ 全部通过\n' : '\n❌ 存在失败项\n');
  process.exit(ok ? 0 : 1);
}

main();
