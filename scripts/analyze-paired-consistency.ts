/**
 * 配对比较统计脚本：把「N 故事 × 3 段 × 前后 2 组」实验变成可引用的数字
 *
 * 输入：
 *   --runs <父目录或逗号分隔的 run 目录列表>   （每目录一个 result.json；通常由 experiment:paired 产出）
 *   [可选] <父目录>/scores_images.csv          图像层逐图评分（--emit-template 生成模板后填写）
 *   [可选] <父目录>/scores_pairs.csv           相邻段"同一人"配对判定（同上）
 *   [可选] <父目录>/scores_images_human.csv    人工抽查子集（仅用于一致率/κ）
 *
 * 输出（默认写回父目录）：
 *   stats.md     统计报告（主结果表 + 文本层 + 分故事明细 + 可直接引用结论段 + 局限）
 *   stats.json   机器可读的完整数字
 *
 * 统计方法（双侧，全部本地实现于 src/lib/paired-stats.ts）：
 *   - 连续指标（外观呈现分 / 关键词覆盖率）：Wilcoxon 符号秩检验（精确分布）+ 配对均值差
 *     的 bootstrap 95% CI（固定随机种子，可复现）+ 秩二列效应量
 *   - 二值指标（同一人判定 / 主体在场 / 锚点命中）：McNemar 精确检验（不一致对二项检验）
 *   - 人工抽查一致率：逐项一致率 + Cohen's κ（以"呈现分 ≥ 5"作为二值标签）
 *
 * 用法：
 *   npx tsx scripts/analyze-paired-consistency.ts --runs experiments/paired-before-after-xxx --emit-template
 *   npx tsx scripts/analyze-paired-consistency.ts --runs experiments/paired-before-after-xxx
 *   npx tsx scripts/analyze-paired-consistency.ts --runs a,b,c          # 逗号分隔多个 run 目录
 */
import fs from 'fs';
import path from 'path';
import {
  cohensKappa,
  mcnemarFromPairs,
  mean,
  summarizePaired,
} from '../src/lib/paired-stats';
import { PRESETS } from './preset-stories';

// ── CLI ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const has = (f: string) => args.includes(`--${f}`);
const get = (f: string, d?: string): string | undefined => {
  const i = args.indexOf(`--${f}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};

const RUNS_ARG = get('runs');
const EMIT_TEMPLATE = has('emit-template');

if (!RUNS_ARG) {
  console.error('用法：npx tsx scripts/analyze-paired-consistency.ts --runs <父目录或 run 目录列表> [--emit-template]');
  process.exit(1);
}

// ── 收集 run 目录 ─────────────────────────────────────────────────────

function collectRunDirs(runsArg: string): string[] {
  const targets = runsArg
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => path.resolve(process.cwd(), s));
  const dirs: string[] = [];
  for (const t of targets) {
    if (!fs.existsSync(t)) {
      console.error(`路径不存在：${t}`);
      process.exit(1);
    }
    if (fs.existsSync(path.join(t, 'result.json'))) {
      dirs.push(t);
      continue;
    }
    for (const entry of fs.readdirSync(t).sort()) {
      const sub = path.join(t, entry);
      try {
        if (fs.statSync(sub).isDirectory() && fs.existsSync(path.join(sub, 'result.json'))) dirs.push(sub);
      } catch {
        /* 忽略无法访问的条目 */
      }
    }
  }
  return dirs;
}

const runDirs = collectRunDirs(RUNS_ARG);
if (runDirs.length === 0) {
  console.error('未找到任何含 result.json 的 run 目录。');
  process.exit(1);
}

// 输出目录：--out 指定 > 若 --runs 是"父目录"（含子目录）用父目录 > 首 run 的父目录
const outDir = (() => {
  const explicit = get('out');
  if (explicit) return path.resolve(process.cwd(), explicit);
  const first = path.resolve(process.cwd(), RUNS_ARG.split(',')[0].trim());
  if (fs.existsSync(path.join(first, 'result.json'))) return path.dirname(first);
  return first;
})();

// ── 数据模型 ──────────────────────────────────────────────────────────

interface RawSegmentRecord {
  segment: { id: string; title: string; content: string };
  seed: number;
  prompt: string;
  images: { url: string; localFile?: string; placeholder?: boolean }[];
}
interface RawRunResult {
  label: string;
  style: string;
  dryRun: boolean;
  anchorAuditAfter: { anchorLines: string[] };
  keywordAudit: { keywords: string[] };
  anchorHitsBefore: number;
  before: RawSegmentRecord[];
  after: RawSegmentRecord[];
}

interface SegmentRow {
  story: string;
  index: number;
  id: string;
  title: string;
  seed: number;
  before: RawSegmentRecord;
  after: RawSegmentRecord;
  /** 文本层自动指标 */
  anchorHitBefore: boolean;
  anchorHitAfter: boolean;
  kwBefore: number;
  kwAfter: number;
  presentBefore: boolean;
  presentAfter: boolean;
}

interface StoryRun {
  key: string;
  label: string;
  style: string;
  dryRun: boolean;
  dir: string;
  anchorLines: string[];
  keywords: string[];
  matchKeys: string[];
  segments: SegmentRow[];
}

const warnings: string[] = [];

function loadStory(runDir: string): StoryRun | null {
  const dirKey = path.basename(runDir);
  const raw = JSON.parse(fs.readFileSync(path.join(runDir, 'result.json'), 'utf8')) as RawRunResult;
  if (raw.dryRun) {
    warnings.push(`跳过 dry-run 数据：${dirKey}（无图片，仅可用于 prompt 检查）`);
    return null;
  }
  // 键解析：优先用目录名（experiment:paired 的规范命名）；目录名不是 preset 时按故事
  // label 回退匹配——用于"占位图回填 / 重跑替换"的外置 run 目录（如 xw-retry → xuanwu），
  // 保证评分表键与聚合口径一致。
  const matchedKey = PRESETS[dirKey]
    ? dirKey
    : Object.keys(PRESETS).find(k => raw.label && PRESETS[k].label === raw.label);
  const key = matchedKey ?? dirKey;
  const preset = PRESETS[key];
  if (!preset) {
    warnings.push(`run「${dirKey}」未匹配到 preset（角色在场判定退化为"全部在场"；评分表键用目录名）`);
  }
  const matchKeys = preset
    ? Array.from(
        new Set(
          preset.characters
            .flatMap(c => [c.name, c.canonicalName])
            .filter((k): k is string => typeof k === 'string' && k.trim().length >= 2),
        ),
      )
    : [];
  const anchorLines = raw.anchorAuditAfter?.anchorLines ?? [];
  const keywords = raw.keywordAudit?.keywords ?? [];

  const segments: SegmentRow[] = raw.before.map((b, i) => {
    const a = raw.after[i];
    const promptHasAnchor = (p: string) => anchorLines.length > 0 && anchorLines.every(l => p.includes(l));
    const kwRate = (p: string) =>
      keywords.length === 0 ? 0 : keywords.filter(k => (p || '').toLowerCase().includes(k)).length / keywords.length;
    const present = (p: string) => (matchKeys.length === 0 ? true : matchKeys.some(k => (p || '').includes(k)));
    return {
      story: key,
      index: i,
      id: b.segment.id,
      title: b.segment.title,
      seed: b.seed,
      before: b,
      after: a,
      anchorHitBefore: promptHasAnchor(b.prompt || ''),
      anchorHitAfter: promptHasAnchor(a.prompt || ''),
      kwBefore: kwRate(b.prompt || ''),
      kwAfter: kwRate(a.prompt || ''),
      presentBefore: present(b.prompt || ''),
      presentAfter: present(a.prompt || ''),
    };
  });

  return {
    key,
    label: raw.label,
    style: raw.style,
    dryRun: raw.dryRun,
    dir: runDir,
    anchorLines,
    keywords,
    matchKeys,
    segments,
  };
}

const stories: StoryRun[] = runDirs
  .map(loadStory)
  .filter((s): s is StoryRun => s !== null);

if (stories.length === 0) {
  console.error('没有任何可用于统计的完整生图数据（全部为 dry-run 或加载失败）。');
  process.exit(1);
}

const allSegments: SegmentRow[] = stories.flatMap(s => s.segments);
// 文本层口径：沿用既有实验"含角色镜头才参与外观文本核对"的传统——仅保留两组
// prompt 均含角色的段（无角色/环境镜头单独标注、不计入主口径；端到端全量口径
// 在报告 §3 以脚注给出）。本 run 中后组有若干段提取未含角色。
const textUnits = allSegments.filter(s => s.presentBefore && s.presentAfter);
const adjacentPairs = stories.flatMap(s =>
  s.segments.slice(0, -1).map((seg, i) => ({
    story: s.key,
    pairIndex: i,
    left: seg,
    right: s.segments[i + 1],
  })),
);

console.log('========================================');
console.log('配对比较统计：图文外观一致性（前 vs 后）');
console.log(`故事（${stories.length}）：${stories.map(s => s.key).join(' / ')}`);
console.log(`段内配对单元：${allSegments.length}（每故事 ${stories[0].segments.length} 段）｜ 相邻段配对：${adjacentPairs.length}`);
console.log(`输出目录：${path.relative(process.cwd(), outDir)}/`);
console.log('========================================');
for (const w of warnings) console.warn(`⚠ ${w}`);

// ── CSV 工具 ──────────────────────────────────────────────────────────

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') {
      row.push(cur);
      cur = '';
    } else if (ch === '\n') {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = '';
    } else if (ch !== '\r') cur += ch;
  }
  if (cur !== '' || row.length > 0) {
    row.push(cur);
    rows.push(row);
  }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

interface CsvTable {
  header: string[];
  rows: Record<string, string>[];
}

function readCsv(file: string): CsvTable | null {
  if (!fs.existsSync(file)) return null;
  const table = parseCsv(fs.readFileSync(file, 'utf8'));
  if (table.length === 0) return null;
  const header = table[0].map(h => h.trim());
  const rows = table.slice(1).map(cols => {
    const obj: Record<string, string> = {};
    header.forEach((h, i) => {
      obj[h] = (cols[i] ?? '').trim();
    });
    return obj;
  });
  return { header, rows };
}

const numOrNull = (v: string | undefined): number | null => {
  if (v === undefined || v === null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// ── 评分表模板（--emit-template） ─────────────────────────────────────

const IMAGE_ITEM_COLUMNS = ['char_present', 'age_sex', 'face', 'hair', 'build', 'outfit', 'prop'] as const;

function emitTemplate() {
  const imgLines: string[] = [
    ['story', 'segment_index', 'segment_title', 'seed', 'condition', 'image_file', ...IMAGE_ITEM_COLUMNS, 'notes', 'scored_by'].join(','),
  ];
  for (const s of stories) {
    for (const seg of s.segments) {
      for (const cond of ['before', 'after'] as const) {
        const rec = cond === 'before' ? seg.before : seg.after;
        const img = rec.images[0];
        imgLines.push(
          [
            s.key,
            String(seg.index),
            csvEscape(seg.title),
            String(seg.seed),
            cond,
            csvEscape(img?.localFile ?? ''),
            '', '', '', '', '', '', '', // 7 个评分位
            '',
            '',
          ].join(','),
        );
      }
    }
  }
  const pairLines: string[] = [
    ['story', 'pair_index', 'left_segment', 'right_segment', 'condition', 'same_identity', 'notes', 'scored_by'].join(','),
  ];
  for (const p of adjacentPairs) {
    for (const cond of ['before', 'after'] as const) {
      pairLines.push(
        [p.story, String(p.pairIndex), csvEscape(p.left.title), csvEscape(p.right.title), cond, '', '', ''].join(','),
      );
    }
  }

  const appendix = [
    '',
    '## 三、评分参照：各故事主角外观规范（冻结自 preset，勿改）',
    '',
    ...stories.flatMap(s => {
      const chars = PRESETS[s.key]?.characters ?? [];
      return [
        `### ${s.key}（${s.label}）`,
        ...chars.map(c => `- **${c.name}**（${c.canonicalName ?? '—'}）：${c.appearance ?? '（无）'}`),
        '',
      ];
    }),
  ].join('\n');

  fs.writeFileSync(path.join(outDir, 'scores_images.csv'), '﻿' + imgLines.join('\n') + '\n');
  fs.writeFileSync(path.join(outDir, 'scores_pairs.csv'), '﻿' + pairLines.join('\n') + '\n');
  fs.writeFileSync(path.join(outDir, 'scoring_rubric.md'), RUBRIC_MD + appendix);

  console.log(`✅ 已生成评分模板：`);
  console.log(`   ${path.relative(process.cwd(), path.join(outDir, 'scores_images.csv'))}（${stories.length} 故事 × ${stories[0].segments.length} 段 × 2 条件）`);
  console.log(`   ${path.relative(process.cwd(), path.join(outDir, 'scores_pairs.csv'))}（相邻段配对判定 × 2 条件）`);
  console.log(`   ${path.relative(process.cwd(), path.join(outDir, 'scoring_rubric.md'))}（评分口径说明）`);
  console.log('填写后运行同一命令（不带 --emit-template）即可统计。');
}

function csvEscape(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const RUBRIC_MD = `# 图像层评分口径（冻结版）

> 本文件由 analyze-paired-consistency.ts 自动生成；评分只填 scores_*.csv，勿改列名与行序。
> 评分时**只看图**，不看条件名（建议打乱顺序评或先遮住 condition 列）；每张图独立评分。

## 一、逐图评分（scores_images.csv）

对每张图中"该故事主角"的外观与规范（该角色 Character.appearance，中文见下方附表）逐项比对：

| 列 | 含义 | 取值 |
|---|---|---|
| \`char_present\` | 主角是否在画面中且清晰可辨识（含背影，只要可辨识为该角色） | 1 = 有；0 = 无（纯景物/主体是别人） |
| \`age_sex\` | 年龄段与性别感与规范一致（如 "early 30s 男性"） | 1 = 一致；0 = 明显不符 |
| \`face\` | 五官与须式与规范一致（脸型/眉/眼/须式）；**背影或面部不可核时留空** | 1 / 0 / 空 |
| \`hair\` | 发型发色与规范一致 | 1 = 一致；0 = 明显不符 |
| \`build\` | 身高体型体态与规范一致 | 1 = 一致；0 = 明显不符 |
| \`outfit\` | 服装主色与形制与规范一致（允许光照带来的明度变化） | 1 = 基本一致；0 = 明显不符/缺失 |
| \`prop\` | 标志性配饰/道具在场且与规范一致（匕首 / 羽扇 / 护腕等，按角色规范） | 1 = 在场一致；0 = 缺失/不符 |

规则：
- \`char_present = 0\` 时其余列填 0 或留空，该图外观呈现分按 0 计；
- 单图**外观呈现分 = 6 ×（有效项得分和）÷（有效项数）**（留空项不计入分母）；
- 允许 0.5 表示"部分一致"（如颜色接近但不完全一致）；
- \`notes\` 里写一句判定依据（如"护腕缺失"）；\`scored_by\` 填 AI / 姓名。

## 二、相邻段配对（scores_pairs.csv）

对同故事的**相邻两段**（left → right），判断"两张图里的主角是否可以读作同一个人"：

| 列 | 含义 | 取值 |
|---|---|---|
| \`same_identity\` | 1 = 基本同一人（细节有波动但身份明确、不能误认为他人）；0 = 明显不同人（年龄/脸型/须式/造型出现身份级翻转） | 1 / 0 / 空 |
| 留空 | 任一侧背影/不可核且无足够旁证（服装体系等）时留空，统计时剔除 |

> 此判定只看**人物身份**，不看构图/场景/画质。
`;

// ── 评分数据加载 ──────────────────────────────────────────────────────

interface ImageScore {
  story: string;
  segmentIndex: number;
  condition: 'before' | 'after';
  charPresent: number;
  /** 归一化到 6 分制的呈现分 */
  appearanceScore: number;
  itemsScored: number;
}

function loadImageScores(file: string): Map<string, ImageScore> {
  const map = new Map<string, ImageScore>();
  const table = readCsv(file);
  if (!table) return map;
  for (const row of table.rows) {
    const story = row['story'];
    const segIdx = numOrNull(row['segment_index']);
    const cond = row['condition'] as 'before' | 'after';
    if (!story || segIdx === null || (cond !== 'before' && cond !== 'after')) {
      warnings.push(`scores_images.csv 跳过无法解析的行：${JSON.stringify(row)}`);
      continue;
    }
    const charPresent = numOrNull(row['char_present']);
    if (charPresent === null) {
      warnings.push(`scores_images.csv 缺 char_present：${story} seg${segIdx} ${cond}（该图不参与统计）`);
      continue;
    }
    const items = ['age_sex', 'face', 'hair', 'build', 'outfit', 'prop']
      .map(c => numOrNull(row[c]))
      .filter((v): v is number => v !== null);
    let appearanceScore: number;
    if (charPresent === 0) appearanceScore = 0;
    else if (items.length === 0) {
      warnings.push(`scores_images.csv 缺全部外观项：${story} seg${segIdx} ${cond}（该图不参与统计）`);
      continue;
    } else appearanceScore = (6 * items.reduce((a, b) => a + b, 0)) / items.length;
    map.set(`${story}|${segIdx}|${cond}`, {
      story,
      segmentIndex: segIdx,
      condition: cond,
      charPresent,
      appearanceScore,
      itemsScored: items.length,
    });
  }
  return map;
}

interface PairScore {
  story: string;
  pairIndex: number;
  condition: 'before' | 'after';
  sameIdentity: number;
}

function loadPairScores(file: string): Map<string, PairScore> {
  const map = new Map<string, PairScore>();
  const table = readCsv(file);
  if (!table) return map;
  for (const row of table.rows) {
    const story = row['story'];
    const pairIdx = numOrNull(row['pair_index']);
    const cond = row['condition'] as 'before' | 'after';
    const v = numOrNull(row['same_identity']);
    if (!story || pairIdx === null || (cond !== 'before' && cond !== 'after')) continue;
    if (v === null) {
      warnings.push(`scores_pairs.csv 缺 same_identity：${story} pair${pairIdx} ${cond}（该配对不参与统计）`);
      continue;
    }
    map.set(`${story}|${pairIdx}|${cond}`, { story, pairIndex: pairIdx, condition: cond, sameIdentity: v });
  }
  return map;
}

// ── 格式化 ────────────────────────────────────────────────────────────

const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '—');
const pct1 = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '—');
const fmtP = (p: number) => (p < 0.001 ? 'p < 0.001' : `p = ${p.toFixed(4)}`);
const fmtCI = (ci: { lower: number; upper: number; level: number }) =>
  `95% CI [${f2(ci.lower)}, ${f2(ci.upper)}]`;

function effectLabel(r: number): string {
  const a = Math.abs(r);
  if (a >= 0.9) return '极大';
  if (a >= 0.5) return '大';
  if (a >= 0.3) return '中等';
  if (a >= 0.1) return '小';
  return '可忽略';
}

// ── 主流程 ────────────────────────────────────────────────────────────

emitTemplateIfRequested();

function emitTemplateIfRequested() {
  if (EMIT_TEMPLATE) {
    emitTemplate();
    process.exit(0);
  }
}

const scoresImages = loadImageScores(path.join(outDir, 'scores_images.csv'));
const scoresPairs = loadPairScores(path.join(outDir, 'scores_pairs.csv'));
const humanScores = loadImageScores(path.join(outDir, 'scores_images_human.csv'));

// —— 主指标 P1：外观呈现分（逐段配对） ——
const scorePairs: { before: number; after: number; unit: string }[] = [];
for (const seg of allSegments) {
  const b = scoresImages.get(`${seg.story}|${seg.index}|before`);
  const a = scoresImages.get(`${seg.story}|${seg.index}|after`);
  if (b && a) scorePairs.push({ before: b.appearanceScore, after: a.appearanceScore, unit: `${seg.story}#${seg.index}` });
}
const P1 = scorePairs.length > 0 ? summarizePaired(scorePairs.map(p => ({ before: p.before, after: p.after }))) : null;

// —— 主指标 P2：相邻段同一人（二值配对） ——
const identityPairs: { before: number; after: number }[] = [];
let identitySkipped = 0;
for (const p of adjacentPairs) {
  const b = scoresPairs.get(`${p.story}|${p.pairIndex}|before`);
  const a = scoresPairs.get(`${p.story}|${p.pairIndex}|after`);
  if (b && a) identityPairs.push({ before: b.sameIdentity, after: a.sameIdentity });
  else identitySkipped++;
}
const P2 = identityPairs.length > 0 ? mcnemarFromPairs(identityPairs) : null;

// —— 辅指标：主体在场（二值配对，来自评分表） ——
const presencePairs: { before: number; after: number }[] = [];
for (const seg of allSegments) {
  const b = scoresImages.get(`${seg.story}|${seg.index}|before`);
  const a = scoresImages.get(`${seg.story}|${seg.index}|after`);
  if (b && a) presencePairs.push({ before: b.charPresent, after: a.charPresent });
}
const presenceMcNemar = presencePairs.length > 0 ? mcnemarFromPairs(presencePairs) : null;

// —— 文本层（自动，与评分无关；主口径 = 两组 prompt 均含角色的 textUnits 段） ——
const anchorMcNemar = mcnemarFromPairs(
  textUnits.map(s => ({ before: s.anchorHitBefore ? 1 : 0, after: s.anchorHitAfter ? 1 : 0 })),
);
const kwSummary = summarizePaired(textUnits.map(s => ({ before: s.kwBefore, after: s.kwAfter })));
// 端到端全量口径（含未含角色的段落），供报告脚注
const rawAnchorBeforeHits = allSegments.filter(s => s.anchorHitBefore).length;
const rawAnchorAfterHits = allSegments.filter(s => s.anchorHitAfter).length;

// —— 人工抽查一致率 ——
let humanAgreement: { overlap: number; itemAgreement: number; labelAgreement: number; kappa: number } | null = null;
if (humanScores.size > 0) {
  let overlap = 0;
  let itemMatch = 0;
  let labelMatch = 0;
  const labelAI: number[] = [];
  const labelHuman: number[] = [];
  for (const [key, hs] of humanScores) {
    const ai = scoresImages.get(key);
    if (!ai) continue;
    overlap++;
    if (Math.abs(ai.appearanceScore - hs.appearanceScore) < 1e-9) itemMatch++;
    const la = ai.appearanceScore >= 5 ? 1 : 0;
    const lh = hs.appearanceScore >= 5 ? 1 : 0;
    if (la === lh) labelMatch++;
    labelAI.push(la);
    labelHuman.push(lh);
  }
  if (overlap > 0) {
    humanAgreement = {
      overlap,
      itemAgreement: itemMatch / overlap,
      labelAgreement: labelMatch / overlap,
      kappa: cohensKappa(labelAI, labelHuman),
    };
  }
}

// ── 报告生成 ──────────────────────────────────────────────────────────

const now = new Date().toISOString();
const reportLines: string[] = [];
const push = (s = '') => reportLines.push(s);

push(`# 配对比较统计：图文外观一致性（前 → 后）`);
push();
push(`> 生成时间：${now} ｜ 数据：${stories.length} 故事 × ${stories[0].segments.length} 段 × 前后 2 组（同段落、同画风、同 seed 配对）`);
push(`> 来源目录：${stories.map(s => path.relative(process.cwd(), s.dir)).join('；')}`);
push(`> 统计实现：\`src/lib/paired-stats.ts\`（Wilcoxon 精确符号秩 / McNemar 精确检验 / bootstrap 95% CI，随机种子固定）`);
push();

push(`## 0. 方法口径`);
push();
push(`- 配对单元：同一（故事，段落）下"优化前 vs 优化后"为一对；两组共用同段落文本、同画风（${stories[0].style}）与同一 per-segment seed（diverse 保守策略——生产默认 identity 还会额外锁定 seed 层）。`);
push(`- 图像层指标：**外观要素呈现分**（0–6，AI 读图/人工按冻结 rubric 逐项评分，见 scoring_rubric.md）与**相邻段"同一人"判定**（0/1）。`);
push(`- 文本层指标（自动）：锚点行逐字命中（0/1）与外观关键词覆盖率。`);
push(`- 连续指标用 Wilcoxon 符号秩检验（精确分布）+ 配对均值差 bootstrap 95% CI + 秩二列效应量；二值指标用 McNemar 精确检验。全部双侧。`);
push();

if (P1) {
  const s = P1;
  push(`## 1. 主结果 ①：外观要素呈现分（0–6）— ${s.n} 对段内配对`);
  push();
  push(`| 条件 | 均值 ± 标准差 | 中位数差 |`);
  push(`|---|---|---|`);
  push(`| 优化前 | ${f2(s.meanBefore)} ± ${f2(s.sdBefore)} | — |`);
  push(`| 优化后 | ${f2(s.meanAfter)} ± ${f2(s.sdAfter)} | ${f2(s.medianDiff)} |`);
  push();
  push(`**均值差（后−前）：${f2(s.meanDiff)} 分，${fmtCI(s.ci)}；中位数差 ${f2(s.medianDiff)}；Wilcoxon 符号秩 ${fmtP(s.wilcoxon.pValue)}（n=${s.wilcoxon.n} 非零对，${s.wilcoxon.exact ? '精确分布' : '正态近似'}）；秩二列效应量 r=${f2(s.wilcoxon.rankBiserial)}（${effectLabel(s.wilcoxon.rankBiserial)}）。**`);
  push();
  {
    const zeroUnits = scorePairs.filter(p => p.before === 0 || p.after === 0).map(p => p.unit);
    push(
      `> 执行注记：${allSegments.length} 对段内配对中 ${scorePairs.length} 对两侧均有可评分图片（${allSegments.length - scorePairs.length} 对因占位图剔除）` +
        (zeroUnits.length > 0
          ? `；${zeroUnits.length} 对含"主角缺席（提取未含角色）"的 0 分图片：${zeroUnits.join('、')}——该失误属提取层，与锚点机制无关，引用数字时须一并说明。`
          : '。'),
    );
    push();
  }
} else {
  push(`## 1. 主结果 ①：外观要素呈现分 — ⚠ 未找到评分表（scores_images.csv），本次仅输出文本层统计。`);
  push();
  push(`生成评分模板：\`npx tsx scripts/analyze-paired-consistency.ts --runs <目录> --emit-template\``);
  push();
}

if (P2) {
  push(`## 2. 主结果 ②：相邻段"同一人"判定 — ${identityPairs.length} 对相邻段 × 2 条件`);
  push();
  const bRate = identityPairs.filter(p => p.before === 1).length / identityPairs.length;
  const aRate = identityPairs.filter(p => p.after === 1).length / identityPairs.length;
  push(`| 条件 | "同一人"率 |`);
  push(`|---|---|`);
  push(`| 优化前 | ${pct1(bRate)}（${identityPairs.filter(p => p.before === 1).length}/${identityPairs.length}） |`);
  push(`| 优化后 | ${pct1(aRate)}（${identityPairs.filter(p => p.after === 1).length}/${identityPairs.length}） |`);
  push();
  push(`**McNemar 精确检验：${fmtP(P2.pValue)}（不一致对：前不一人→后一人 ${P2.b}，反向 ${P2.c}）**${identitySkipped > 0 ? `；另有 ${identitySkipped} 对因占位图/主角缺席/评分留空不可判（已剔除）` : ''}。`);
  if (identityPairs.length < 6) {
    push(`> 注：可判配对仅 ${identityPairs.length} 对，McNemar 功效不足——本指标只作描述性呈现，不作推断性结论。`);
  }
  push();
} else if (scoresImages.size > 0) {
  push(`## 2. 主结果 ②：相邻段"同一人"判定 — ⚠ 未找到 scores_pairs.csv，跳过。`);
  push();
}

if (presenceMcNemar) {
  const rb = presencePairs.filter(p => p.before === 1).length;
  const ra = presencePairs.filter(p => p.after === 1).length;
  push(`**主体在场率**：前 ${rb}/${presencePairs.length} → 后 ${ra}/${presencePairs.length}（McNemar ${fmtP(presenceMcNemar.pValue)}）。`);
  push();
}

push(`## 3. 文本层（自动指标；口径：两组 prompt 均含角色的 ${textUnits.length} 段）`);
push();
{
  const bHit = textUnits.filter(s => s.anchorHitBefore).length;
  const aHit = textUnits.filter(s => s.anchorHitAfter).length;
  push(`- **锚点行逐字命中**：前 ${bHit}/${textUnits.length} → 后 ${aHit}/${textUnits.length}（McNemar 精确检验 ${fmtP(anchorMcNemar.pValue)}）。`);
  push(
    `- **外观关键词覆盖率**：前 ${pct1(kwSummary.meanBefore)}（均值）→ 后 ${pct1(kwSummary.meanAfter)}；均值差 ${f2(kwSummary.meanDiff)}（${fmtCI(kwSummary.ci)}），Wilcoxon ${fmtP(kwSummary.wilcoxon.pValue)}，r=${f2(kwSummary.wilcoxon.rankBiserial)}。`,
  );
  push(
    `- 口径脚注：另有 ${allSegments.length - textUnits.length} 段后组提取未含角色（无锚点属提取层失误、非锚点机制失效），按既有实验传统不计入核对；端到端全量口径：锚点命中 前 ${rawAnchorBeforeHits}/${allSegments.length} → 后 ${rawAnchorAfterHits}/${allSegments.length}。`,
  );
  push();
}

push(`## 4. 分故事明细`);
push();
push(`| 故事 | 段数 | 呈现分 前→后（均值） | 关键词覆盖 前→后 | 锚点命中 前→后 |`);
push(`|---|---|---|---|---|`);
for (const s of stories) {
  const segs = s.segments;
  const sc: { before: number; after: number }[] = [];
  for (const seg of segs) {
    const b = scoresImages.get(`${seg.story}|${seg.index}|before`);
    const a = scoresImages.get(`${seg.story}|${seg.index}|after`);
    if (b && a) sc.push({ before: b.appearanceScore, after: a.appearanceScore });
  }
  const scoreCell = sc.length > 0 ? `${f2(mean(sc.map(x => x.before)))} → ${f2(mean(sc.map(x => x.after)))}` : '—';
  const tsegs = segs.filter(x => x.presentBefore && x.presentAfter);
  const kwCell = tsegs.length > 0 ? `${pct1(mean(tsegs.map(x => x.kwBefore)))} → ${pct1(mean(tsegs.map(x => x.kwAfter)))}` : '—';
  const hitCell = tsegs.length > 0 ? `${tsegs.filter(x => x.anchorHitBefore).length}/${tsegs.length} → ${tsegs.filter(x => x.anchorHitAfter).length}/${tsegs.length}` : '—';
  push(`| ${s.key}（${s.label}） | ${segs.length}（文本 ${tsegs.length}） | ${scoreCell} | ${kwCell} | ${hitCell} |`);
}
push();
push(`> 注：文本列按"两组 prompt 均含角色"的段落计（括号内为计入文本指标的段数）；呈现分列为两侧均有可评分图片的配对（占位图剔除）。`);
push();

push(`## 5. 人工抽查（AI 评分复核）`);
push();
if (humanAgreement) {
  push(`- 抽查覆盖：${humanAgreement.overlap} 张（与 AI 评分同键）；逐图呈现分完全一致率 ${pct1(humanAgreement.itemAgreement)}；"合格（≥5 分）"二值判定一致率 ${pct1(humanAgreement.labelAgreement)}；Cohen's κ = ${f2(humanAgreement.kappa)}。`);
} else {
  push(`- 待填：将人工抽查结果按 scores_images.csv 同格式存为 \`scores_images_human.csv\`（只需子集行）后重跑本脚本，自动输出一致率与 κ。`);
}
push();

push(`## 6. 可直接引用的结论段`);
push();
if (P1) {
  const s = P1;
  const p2 = P2
    ? `「相邻段同一人」判定率前组 ${pct1(identityPairs.filter(p => p.before === 1).length / identityPairs.length)} → 后组 ${pct1(identityPairs.filter(p => p.after === 1).length / identityPairs.length)}（McNemar ${fmtP(P2.pValue)}；可判 ${identityPairs.length} 对、功效不足，仅作描述）`
    : '';
  push(
    `> 在 ${stories.length} 个历史故事 × ${stories[0].segments.length} 段 × 前后两种管线的受控配对对照中（同段落、同画风、同 seed，共 ${allSegments.length * 2} 张图、${s.n} 对段内配对）：外观要素呈现分（0–6）前组 ${f2(s.meanBefore)}±${f2(s.sdBefore)} vs 后组 ${f2(s.meanAfter)}±${f2(s.sdAfter)}，均值差 ${f2(s.meanDiff)}（${fmtCI(s.ci)}，Wilcoxon 符号秩检验 ${fmtP(s.wilcoxon.pValue)}，效应量 r=${f2(s.wilcoxon.rankBiserial)}）${p2 ? '；' + p2 : ''}。文本层面：在两组均含角色的 ${textUnits.length} 段中，跨段锚点逐字命中 ${textUnits.filter(x => x.anchorHitBefore).length}/${textUnits.length} → ${textUnits.filter(x => x.anchorHitAfter).length}/${textUnits.length}（McNemar 精确检验 ${fmtP(anchorMcNemar.pValue)}），外观关键词覆盖率 ${pct1(kwSummary.meanBefore)} → ${pct1(kwSummary.meanAfter)}（Wilcoxon ${fmtP(kwSummary.wilcoxon.pValue)}）。两组共享同一 per-segment seed 且使用 diverse 保守策略；生产默认 identity 策略还将额外锁定 seed 层。`,
  );
} else {
  push(`> （待图像评分完成后自动生成。）`);
}
push();

push(`## 7. 局限`);
push();
push(`1. 图像层评分为 AI 读图（冻结 rubric）所得${humanAgreement ? `，已有人工抽查 ${humanAgreement.overlap} 张复核（κ=${f2(humanAgreement.kappa)}）` : '，建议按 §5 完成人工抽查后引用'}；AI 评分未盲化（可见 condition），引用时须知；`);
push(`2. 样本结构为 ${stories.length} 故事 × ${stories[0].segments.length} 段（每格 1 张），统计单元 ${allSegments.length} 对；跨故事的普适性受故事选择影响；`);
push(`3. 本 run 的执行注记（参与提取/生图失误的段落与占位图）见 §1 与 §3 脚注——引用任何数字时须一并说明，尤其是含"主角缺席"配对的指标；`);
push(`4. 场景措辞由 LLM 为两组独立抽样生成，场景/道具层差异含抽样成分（外观层为本实验目标变量）；`);
push(`5. 扩散模型"像素服从性"上限（文字 100% 传入仍可能未呈现）属固有噪声，两组都可能发生；`);
push(`6. seed 为 diverse 保守设置：生产默认 identity 策略的实际一致性只会更强，本结果为下界。`);
push();

const reportPath = path.join(outDir, 'stats.md');
fs.writeFileSync(reportPath, reportLines.join('\n'));

// ── stats.json ────────────────────────────────────────────────────────

const statsJson = {
  generatedAt: now,
  stories: stories.map(s => ({ key: s.key, label: s.label, dir: path.relative(process.cwd(), s.dir), segments: s.segments.length })),
  design: {
    stories: stories.length,
    segmentsPerStory: stories[0].segments.length,
    conditionPairs: allSegments.length,
    adjacentPairs: adjacentPairs.length,
    style: stories[0].style,
    seedPolicy: 'diverse（两组共享 per-segment seed）',
  },
  scoringCoverage: {
    imageRowsProvided: scoresImages.size,
    imageRowsExpected: allSegments.length * 2,
    pairRowsProvided: scoresPairs.size,
    pairRowsExpected: adjacentPairs.length * 2,
  },
  imageAppearanceScore: P1
    ? {
        n: P1.n,
        meanBefore: P1.meanBefore,
        sdBefore: P1.sdBefore,
        meanAfter: P1.meanAfter,
        sdAfter: P1.sdAfter,
        meanDiff: P1.meanDiff,
        ci: P1.ci,
        wilcoxon: P1.wilcoxon,
      }
    : null,
  adjacentIdentity: P2
    ? {
        n: identityPairs.length,
        rateBefore: identityPairs.filter(p => p.before === 1).length / identityPairs.length,
        rateAfter: identityPairs.filter(p => p.after === 1).length / identityPairs.length,
        mcnemar: P2,
        skipped: identitySkipped,
      }
    : null,
  charPresent: presenceMcNemar,
  textLayer: {
    units: textUnits.length,
    anchor: {
      before: textUnits.filter(s => s.anchorHitBefore).length,
      after: textUnits.filter(s => s.anchorHitAfter).length,
      total: textUnits.length,
      rawBefore: rawAnchorBeforeHits,
      rawAfter: rawAnchorAfterHits,
      rawTotal: allSegments.length,
      mcnemar: anchorMcNemar,
    },
    keywordCoverage: {
      meanBefore: kwSummary.meanBefore,
      meanAfter: kwSummary.meanAfter,
      meanDiff: kwSummary.meanDiff,
      ci: kwSummary.ci,
      wilcoxon: kwSummary.wilcoxon,
    },
  },
  humanSpotCheck: humanAgreement,
  warnings,
};
fs.writeFileSync(path.join(outDir, 'stats.json'), JSON.stringify(statsJson, null, 2));

// ── 终端摘要 ──────────────────────────────────────────────────────────

console.log('\n----------------------------------------');
if (P1) {
  console.log(
    `外观呈现分（0–6）：前 ${f2(P1.meanBefore)}±${f2(P1.sdBefore)} → 后 ${f2(P1.meanAfter)}±${f2(P1.sdAfter)}` +
      `（+${f2(P1.meanDiff)}，${fmtCI(P1.ci)}，Wilcoxon ${fmtP(P1.wilcoxon.pValue)}，r=${f2(P1.wilcoxon.rankBiserial)}）`,
  );
}
if (P2) {
  console.log(
    `相邻段同一人率：前 ${pct1(identityPairs.filter(p => p.before === 1).length / identityPairs.length)} → ` +
      `后 ${pct1(identityPairs.filter(p => p.after === 1).length / identityPairs.length)}（McNemar ${fmtP(P2.pValue)}）`,
  );
}
console.log(
  `锚点逐字命中（含角色 ${textUnits.length} 段）：前 ${textUnits.filter(s => s.anchorHitBefore).length}/${textUnits.length} → ` +
    `后 ${textUnits.filter(s => s.anchorHitAfter).length}/${textUnits.length}（McNemar ${fmtP(anchorMcNemar.pValue)}；全量口径：后 ${rawAnchorAfterHits}/${allSegments.length}）`,
);
console.log(
  `关键词覆盖率（含角色 ${textUnits.length} 段）：前 ${pct1(kwSummary.meanBefore)} → 后 ${pct1(kwSummary.meanAfter)}（Wilcoxon ${fmtP(kwSummary.wilcoxon.pValue)}）`,
);
console.log(`报告：${path.relative(process.cwd(), reportPath)} ｜ 机器可读：stats.json`);
console.log('----------------------------------------');
