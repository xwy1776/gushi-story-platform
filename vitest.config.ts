import { defineConfig } from 'vitest/config';
import path from 'path';
import { STANDALONE_TESTS } from './scripts/test-manifest';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',

    /**
     * 排除「独立 tsx 脚本」（见 scripts/test-manifest.ts 的说明）。
     *
     * 这些脚本自写 assert() 并在结尾 process.exit()，被 vitest 收集时会
     * 报 "No test suite found" 并把 worker 打崩（segfault）。
     * 它们由 `npm run test:scripts` / `npm test` 用 tsx 跑。
     */
    exclude: ['**/node_modules/**', '**/dist/**', ...STANDALONE_TESTS],
  },
});
