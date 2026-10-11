/**
 * 配对比较实验编排：一条命令跑齐「N 故事 × 3 段 × 前后 2 组」
 *
 * 顺序调用 image-prompt-before-after.ts（每个 preset 一个子目录），
 * 跑完汇总 manifest.json，供配对统计脚本（analyze-paired-consistency.ts）聚合分析。
 *
 * 用法：
 *   npm run experiment:paired                              # 全部 preset（jingke / xuanwu / chibi / hongmen）
 *   npm run experiment:paired -- --presets jingke,chibi    # 指定子集
 *   npm run experiment:paired -- --dry-run                 # 零图片成本预检（只组装 prompt）
 *   npm run experiment:paired -- --max-images 2 --segments 3
 *   npm run experiment:paired -- --out experiments/paired-xxx   # 自定义父目录
 *
 * 产出（experiments/paired-before-after-<时间戳>/）：
 *   <preset>/           每故事一个 run 目录（report.html / prompts.md / result.json / before / after）
 *   manifest.json       聚合清单（preset、目录、图数、占位图数），配对统计脚本的输入之一
 *
 * 前置：与单故事实验一致（.env / .env.local 配置 AI_API_KEY 与 AI_IMAGE_API_KEY）。
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { PRESETS } from './preset-stories';

const args = process.argv.slice(2);
const has = (f: string) => args.includes(`--${f}`);
const get = (f: string, d?: string): string | undefined => {
  const i = args.indexOf(`--${f}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};

const DRY_RUN = has('dry-run');
const PRESET_KEYS = (get('presets', Object.keys(PRESETS).join(',')) as string)
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const SEGMENTS = get('segments', '3') as string;
const MAX_IMAGES = get('max-images', '1') as string;

const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const parentDir = path.resolve(
  process.cwd(),
  get('out') ?? path.join('experiments', `paired-before-after-${timestamp}`),
);
fs.mkdirSync(parentDir, { recursive: true });

const unknown = PRESET_KEYS.filter(p => !PRESETS[p]);
if (unknown.length > 0) {
  console.error(`未知 preset：${unknown.join(', ')}（可用：${Object.keys(PRESETS).join(' / ')}）`);
  process.exit(1);
}

// 子进程：优先直接调用 node_modules/.bin/tsx（跨平台，带 shell 以兼容 Windows 的 .cmd）
// shell 模式下参数需自行加引号（路径可能含空格/中文）
const tsxBin = path.join(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
const useNpx = !fs.existsSync(tsxBin);
const bin = useNpx ? (process.platform === 'win32' ? 'npx.cmd' : 'npx') : tsxBin;
const q = (s: string) => (/\s/.test(s) ? `"${s}"` : s);

const runnerPath = path.join('scripts', 'image-prompt-before-after.ts');

console.log('========================================');
console.log('配对比较实验编排：多故事 × 3 段 × 前后 2 组');
console.log(`故事（${PRESET_KEYS.length}）：${PRESET_KEYS.join(' / ')}`);
console.log(`每故事段落数：${SEGMENTS} ｜ 每格张数：${MAX_IMAGES}${DRY_RUN ? ' ｜ dry-run（不调用生图 API）' : ''}`);
console.log(`输出父目录：${path.relative(process.cwd(), parentDir)}/`);
console.log('========================================');

for (let i = 0; i < PRESET_KEYS.length; i++) {
  const preset = PRESET_KEYS[i];
  const outDir = path.join(parentDir, preset);
  console.log(`\n========== [${i + 1}/${PRESET_KEYS.length}] 故事「${preset}」 ==========`);
  const childArgs = [runnerPath, '--preset', preset, '--out-dir', outDir, '--segments', SEGMENTS, '--max-images', MAX_IMAGES];
  if (DRY_RUN) childArgs.push('--dry-run');
  const argv = useNpx ? ['tsx', ...childArgs] : childArgs;
  const cmd = `${q(bin)} ${argv.map(q).join(' ')}`;
  const res = spawnSync(cmd, { shell: true, stdio: 'inherit', cwd: process.cwd(), env: process.env });
  if (res.status !== 0) {
    console.error(`\n✗ preset「${preset}」运行失败（退出码 ${res.status}），已中止。`);
    process.exit(1);
  }
}

// ── 汇总 manifest ─────────────────────────────────────────────────────

interface RunSummary {
  preset: string;
  dir: string;
  label: string | null;
  imageCount: number;
  placeholders: number;
  anchorHitsBefore: number | null;
}

const runs: RunSummary[] = PRESET_KEYS.map(preset => {
  const dir = path.join(parentDir, preset);
  let result: {
    label?: string;
    anchorHitsBefore?: number;
    before?: { images?: { placeholder?: boolean }[] }[];
    after?: { images?: { placeholder?: boolean }[] }[];
  } | null = null;
  try {
    result = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
  } catch {
    console.warn(`⚠ 子目录 ${preset}/ 缺少可解析的 result.json`);
  }
  const allImages = [...(result?.before ?? []), ...(result?.after ?? [])].flatMap(r => r.images ?? []);
  return {
    preset,
    dir: path.relative(process.cwd(), dir),
    label: result?.label ?? null,
    imageCount: allImages.length,
    placeholders: allImages.filter(x => x?.placeholder).length,
    anchorHitsBefore: result?.anchorHitsBefore ?? null,
  };
});

const totalImages = runs.reduce((a, r) => a + r.imageCount, 0);
const totalPlaceholders = runs.reduce((a, r) => a + r.placeholders, 0);

fs.writeFileSync(
  path.join(parentDir, 'manifest.json'),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      dryRun: DRY_RUN,
      segmentsPerStory: parseInt(SEGMENTS, 10),
      imagesPerCell: parseInt(MAX_IMAGES, 10),
      totalImages,
      totalPlaceholders,
      runs,
    },
    null,
    2,
  ),
);

console.log('\n========================================');
console.log(`✅ 编排完成：${PRESET_KEYS.length} 个故事，共 ${totalImages} 张图${totalPlaceholders > 0 ? `（⚠ ${totalPlaceholders} 张占位图！）` : ''}${DRY_RUN ? '（dry-run）' : ''}`);
console.log(`输出：${path.relative(process.cwd(), parentDir)}/ ｜ manifest.json 已写入`);
console.log('下一步：');
console.log(`  评分表模板：npx tsx scripts/analyze-paired-consistency.ts --runs ${path.relative(process.cwd(), parentDir)} --emit-template`);
console.log(`  统计出数：  npx tsx scripts/analyze-paired-consistency.ts --runs ${path.relative(process.cwd(), parentDir)}`);
console.log('========================================');
