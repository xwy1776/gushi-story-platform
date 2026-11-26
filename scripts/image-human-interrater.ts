/**
 * 图像人工评分 · 双评分者一致性（人工 A × 人工 B）与 人工 × AI
 *
 * 背景：`scripts/analyze-paired-consistency.ts` 只支持「一份人工表 vs AI」。
 * 任务卡要求「人工-人工 κ 与人工-AI κ 分开报告」，本脚本专门补前者，
 * 并在提供 AI 表时同时输出 A×AI、B×AI，避免把三类 κ 混成一个数字。
 *
 * 运行：
 *   npx tsx scripts/image-human-interrater.ts --dir <实验输出目录>
 *   npx tsx scripts/image-human-interrater.ts --a=<A表> --b=<B表> [--ai=<AI表>] [--out=<报告路径>]
 *   npx tsx scripts/image-human-interrater.ts --selftest
 *
 * 输入（--dir 模式下的默认文件名）：
 *   scores_images_human.csv       评分者 A（原人工抽查表）
 *   scores_images_human_rater2.csv 评分者 B（第二评分者，恢复映射后）
 *   scores_images.csv             AI 逐图评分（可选）
 *
 * 口径（与 analyze-paired-consistency.ts 一致）：
 *   - 匹配键：`story|segment_index|condition`
 *   - 呈现分：char_present=0 → 0；否则 6 ×（6 项外观均值），缺失项从均值中剔除
 *   - 二值标签：呈现分 ≥ 5 记为「达标」，用于 κ
 *
 * 产出：默认写 `<A 表所在目录>/图像人工间一致性报告.md`
 */
import fs from 'fs';
import path from 'path';
import { cohensKappa } from '../src/lib/paired-stats';

const ITEM_COLUMNS = ['age_sex', 'face', 'hair', 'build', 'outfit', 'prop'] as const;
type ItemColumn = (typeof ITEM_COLUMNS)[number];

// ── 工具 ──────────────────────────────────────────────────────────────

const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '—');
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '—');
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '—');

function kappaTier(k: number): string {
  if (!Number.isFinite(k)) return '—';
  if (k < 0) return '差于随机';
  if (k < 0.21) return '轻微';
  if (k < 0.41) return '一般';
  if (k < 0.61) return '中等';
  if (k < 0.81) return '较强';
  return '很强';
}

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

function readCsv(file: string): CsvTable {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const table = parseCsv(text);
  if (table.length === 0) throw new Error(`CSV 为空：${file}`);
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

// ── 评分加载 ──────────────────────────────────────────────────────────

interface ImageScore {
  key: string;
  story: string;
  segmentIndex: number;
  condition: string;
  charPresent: number | null;
  appearanceScore: number;
  items: Partial<Record<ItemColumn, number | null>>;
}

interface LoadResult {
  map: Map<string, ImageScore>;
  warnings: string[];
  totalRows: number;
}

function loadImageScores(file: string, label: string): LoadResult {
  const warnings: string[] = [];
  const map = new Map<string, ImageScore>();
  const table = readCsv(file);
  for (const row of table.rows) {
    const story = row['story'];
    const segIdx = numOrNull(row['segment_index']);
    const cond = (row['condition'] || '').toLowerCase();
    if (!story || segIdx === null || (cond !== 'before' && cond !== 'after')) {
      warnings.push(`${label} 跳过无法解析的行：${JSON.stringify(row)}`);
      continue;
    }
    const key = `${story}|${segIdx}|${cond}`;
    const charPresent = numOrNull(row['char_present']);
    const items: Partial<Record<ItemColumn, number | null>> = {};
    const presentItems: number[] = [];
    for (const c of ITEM_COLUMNS) {
      const v = numOrNull(row[c]);
      items[c] = v;
      if (v !== null) presentItems.push(v);
    }
    if (charPresent === null) {
      warnings.push(`${label} 缺 char_present：${key}（该图不参与统计）`);
      continue;
    }
    let appearanceScore: number;
    if (charPresent === 0) appearanceScore = 0;
    else if (presentItems.length === 0) {
      warnings.push(`${label} 缺全部外观项：${key}（该图不参与统计）`);
      continue;
    } else appearanceScore = (6 * presentItems.reduce((a, b) => a + b, 0)) / presentItems.length;

    if (map.has(key)) warnings.push(`${label} 重复匹配键 ${key}，以最后一行为准`);
    map.set(key, {
      key,
      story,
      segmentIndex: segIdx,
      condition: cond,
      charPresent,
      appearanceScore,
      items,
    });
  }
  return { map, warnings, totalRows: table.rows.length };
}

// ── 一致性计算 ────────────────────────────────────────────────────────

interface PairAgreement {
  n: number;
  exactAgreement: number;
  labelAgreement: number;
  kappa: number;
  meanAbsDiff: number;
}

function compareScores(a: Map<string, ImageScore>, b: Map<string, ImageScore>): PairAgreement {
  const keys = [...a.keys()].filter(k => b.has(k));
  if (keys.length === 0) {
    return { n: 0, exactAgreement: NaN, labelAgreement: NaN, kappa: NaN, meanAbsDiff: NaN };
  }
  let exact = 0;
  let labelMatch = 0;
  let absDiff = 0;
  const la: number[] = [];
  const lb: number[] = [];
  for (const k of keys) {
    const sa = a.get(k)!.appearanceScore;
    const sb = b.get(k)!.appearanceScore;
    if (Math.abs(sa - sb) < 1e-9) exact++;
    absDiff += Math.abs(sa - sb);
    const ba = sa >= 5 ? 1 : 0;
    const bb = sb >= 5 ? 1 : 0;
    if (ba === bb) labelMatch++;
    la.push(ba);
    lb.push(bb);
  }
  return {
    n: keys.length,
    exactAgreement: exact / keys.length,
    labelAgreement: labelMatch / keys.length,
    kappa: cohensKappa(la, lb),
    meanAbsDiff: absDiff / keys.length,
  };
}

interface ItemAgreement {
  item: ItemColumn | 'char_present';
  n: number;
  exactAgreement: number;
  meanAbsDiff: number;
}

function compareItems(a: Map<string, ImageScore>, b: Map<string, ImageScore>): ItemAgreement[] {
  const keys = [...a.keys()].filter(k => b.has(k));
  const out: ItemAgreement[] = [];
  const columns: Array<ItemColumn | 'char_present'> = ['char_present', ...ITEM_COLUMNS];
  for (const item of columns) {
    let n = 0;
    let exact = 0;
    let absDiff = 0;
    for (const k of keys) {
      const va = item === 'char_present' ? a.get(k)!.charPresent : a.get(k)!.items[item];
      const vb = item === 'char_present' ? b.get(k)!.charPresent : b.get(k)!.items[item];
      if (va === null || va === undefined || vb === null || vb === undefined) continue;
      n++;
      if (va === vb) exact++;
      absDiff += Math.abs(va - vb);
    }
    out.push({ item, n, exactAgreement: n ? exact / n : NaN, meanAbsDiff: n ? absDiff / n : NaN });
  }
  return out;
}

function missingKeys(a: Map<string, ImageScore>, b: Map<string, ImageScore>): { onlyA: string[]; onlyB: string[] } {
  const onlyA = [...a.keys()].filter(k => !b.has(k));
  const onlyB = [...b.keys()].filter(k => !a.has(k));
  return { onlyA, onlyB };
}

// ── 报告 ──────────────────────────────────────────────────────────────

function buildReport(opts: {
  aPath: string;
  bPath: string;
  aiPath?: string;
  a: LoadResult;
  b: LoadResult;
  ai?: LoadResult;
}): string {
  const { aPath, bPath, aiPath, a, b, ai } = opts;
  const ab = compareScores(a.map, b.map);
  const items = compareItems(a.map, b.map);
  const miss = missingKeys(a.map, b.map);
  const L: string[] = [];

  L.push('# 图像人工评分一致性报告（人工 A × 人工 B）');
  L.push('');
  L.push(`> 生成时间：${new Date().toISOString()}`);
  L.push(`> 评分者 A：\`${aPath}\`（${a.map.size} 张可解析）`);
  L.push(`> 评分者 B：\`${bPath}\`（${b.map.size} 张可解析）`);
  if (aiPath && ai) L.push(`> AI 评分表：\`${aiPath}\`（${ai.map.size} 张可解析）`);
  L.push('> 匹配键：`story|segment_index|condition`；二值口径：呈现分 ≥ 5 记为「达标」；κ 用 Cohen\'s κ。');
  L.push('');

  if (ab.n === 0) {
    L.push('## ⚠ 无可比数据');
    L.push('');
    L.push(`A、B 两表没有共同匹配键。A 独有 ${miss.onlyA.length} 条、B 独有 ${miss.onlyB.length} 条。`);
    L.push('请检查：B 表是否已完成映射恢复（含 story / segment_index / condition 列）、condition 是否统一为 before/after、故事名是否逐字一致。');
    return L.join('\n') + '\n';
  }

  L.push('## 1. 人工 A × 人工 B');
  L.push('');
  L.push('| 可比图数 | 逐图完全一致率 | 二值一致率（≥5） | Cohen\'s κ | 平均绝对差 | 判读 |');
  L.push('|---:|---:|---:|---:|---:|---|');
  L.push(
    `| ${ab.n} | ${pct(ab.exactAgreement)} | ${pct(ab.labelAgreement)} | **${f2(ab.kappa)}** | ${f2(ab.meanAbsDiff)} | ${kappaTier(ab.kappa)} |`,
  );
  L.push('');

  L.push('## 2. 分项一致率');
  L.push('');
  L.push('| 项目 | 可比图数 | 完全一致率 | 平均绝对差 |');
  L.push('|---|---:|---:|---:|');
  for (const it of items) {
    L.push(`| ${it.item} | ${it.n} | ${pct(it.exactAgreement)} | ${f2(it.meanAbsDiff)} |`);
  }
  L.push('');

  if (aiPath && ai) {
    const aAI = compareScores(a.map, ai.map);
    const bAI = compareScores(b.map, ai.map);
    L.push('## 3. 人工 × AI（分开报告）');
    L.push('');
    L.push('| 对比 | 可比图数 | 逐图完全一致率 | 二值一致率（≥5） | Cohen\'s κ | 判读 |');
    L.push('|---|---:|---:|---:|---:|---|');
    L.push(
      `| 人工 A × AI | ${aAI.n} | ${pct(aAI.exactAgreement)} | ${pct(aAI.labelAgreement)} | ${f2(aAI.kappa)} | ${kappaTier(aAI.kappa)} |`,
    );
    L.push(
      `| 人工 B × AI | ${bAI.n} | ${pct(bAI.exactAgreement)} | ${pct(bAI.labelAgreement)} | ${f2(bAI.kappa)} | ${kappaTier(bAI.kappa)} |`,
    );
    L.push('');
  }

  L.push('## 4. 匹配覆盖与告警');
  L.push('');
  L.push(`- A 独有：${miss.onlyA.length} 条${miss.onlyA.length ? `（例：${miss.onlyA.slice(0, 5).join('、')}）` : ''}`);
  L.push(`- B 独有：${miss.onlyB.length} 条${miss.onlyB.length ? `（例：${miss.onlyB.slice(0, 5).join('、')}）` : ''}`);
  const warnings = [...a.warnings, ...b.warnings, ...(ai?.warnings ?? [])];
  if (warnings.length) {
    L.push(`- 解析告警 ${warnings.length} 条：`);
    for (const w of warnings.slice(0, 20)) L.push(`  - ${w}`);
    if (warnings.length > 20) L.push(`  - ……其余 ${warnings.length - 20} 条省略`);
  } else {
    L.push('- 解析告警：无');
  }
  L.push('');

  L.push('## 5. 判读与写法约束');
  L.push('');
  L.push('- 人工-人工、人工-AI 的 κ **必须分开报告**，不得只报其中一个或合并成一个「人工验证」数字；');
  L.push('- κ < 0.6 时，不得写成「人工验证通过」或「跨图身份一致性得到人工支持」；');
  L.push('- 若人工之间一致、人工与 AI 不一致，结论应为「AI 图像评分不可靠」，而不是否定人工；');
  L.push('- 若人工之间也不一致，应如实报告低 κ，并说明分歧集中在哪些评分项（见第 2 节）；');
  L.push('- 本报告只陈述计算口径，不替论文下结论；引用时保留 n 与 κ 的原始值。');

  return L.join('\n') + '\n';
}

// ── 自检 ──────────────────────────────────────────────────────────────

function selftest(): void {
  const assert = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(`SELFTEST FAILED: ${msg}`);
  };

  // κ：po=0.75, pe=0.5 → κ=0.5
  const k = cohensKappa([1, 0, 1, 0], [1, 0, 1, 0]);
  assert(Math.abs(k - 1) < 1e-9, `κ 完全一致应为 1，实际 ${k}`);
  const k2 = cohensKappa([1, 1, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0], [1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
  // 手工：po=12/16=0.75；A 的 1 比例 8/16，B 的 1 比例 8/16 → pe=0.5 → κ=0.5
  assert(Math.abs(k2 - 0.5) < 1e-9, `κ 应为 0.5，实际 ${k2}`);

  // 呈现分：char_present=0 → 0
  const make = (items: number[], charPresent = 1): ImageScore => ({
    key: 'k',
    story: 's',
    segmentIndex: 1,
    condition: 'before',
    charPresent,
    appearanceScore: charPresent === 0 ? 0 : (6 * items.reduce((a, b) => a + b, 0)) / items.length,
    items: { age_sex: items[0], face: items[1], hair: items[2], build: items[3], outfit: items[4], prop: items[5] },
  });
  // rubric 为 6 项二值项（0/1），呈现分 = 6 × 均值 → 0–6
  const s6 = make([1, 1, 1, 1, 1, 1]);
  assert(Math.abs(s6.appearanceScore - 6) < 1e-9, `6 项全 1 应得 6，实际 ${s6.appearanceScore}`);
  const s4 = make([1, 1, 0, 1, 0, 1]);
  assert(Math.abs(s4.appearanceScore - 4) < 1e-9, `6 项中 4 项为 1 应得 4，实际 ${s4.appearanceScore}`);
  const s0 = make([0, 0, 0, 0, 0, 0], 0);
  assert(s0.appearanceScore === 0, 'char_present=0 应得 0');

  // 匹配：只比较交集
  const A = new Map<string, ImageScore>([
    ['s1|1|before', make([1, 1, 1, 1, 1, 1])],
    ['s1|2|after', make([1, 1, 0, 0, 0, 0])],
  ]);
  const B = new Map<string, ImageScore>([
    ['s1|1|before', make([1, 1, 1, 1, 1, 1])],
    ['s1|3|before', make([1, 1, 1, 1, 1, 1])],
  ]);
  const cmp = compareScores(A, B);
  assert(cmp.n === 1, `交集应为 1，实际 ${cmp.n}`);
  assert(Math.abs(cmp.kappa - 1) < 1e-9, `单条同标签 κ 应为 1，实际 ${cmp.kappa}`);
  const miss = missingKeys(A, B);
  assert(miss.onlyA.length === 1 && miss.onlyB.length === 1, '独有键统计错误');

  console.log('SELFTEST PASS：κ、呈现分、交集匹配、缺失统计均符合预期。');
}

// ── CLI ───────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) {
    selftest();
    return;
  }
  const get = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
  };

  const dir = get('dir');
  let aPath = get('a');
  let bPath = get('b');
  let aiPath = get('ai');

  if (dir) {
    aPath = aPath ?? path.join(dir, 'scores_images_human.csv');
    bPath = bPath ?? path.join(dir, 'scores_images_human_rater2.csv');
    const aiCandidate = path.join(dir, 'scores_images.csv');
    aiPath = aiPath ?? (fs.existsSync(aiCandidate) ? aiCandidate : undefined);
  }

  if (!aPath || !bPath) {
    console.error(
      [
        '用法：npx tsx scripts/image-human-interrater.ts --dir <实验输出目录>',
        '  或：npx tsx scripts/image-human-interrater.ts --a=<A表> --b=<B表> [--ai=<AI表>] [--out=<报告路径>]',
        '  自检：npx tsx scripts/image-human-interrater.ts --selftest',
      ].join('\n'),
    );
    process.exit(1);
  }

  if (!fs.existsSync(aPath)) throw new Error(`找不到评分者 A 的表：${aPath}`);
  if (!fs.existsSync(bPath)) throw new Error(`找不到评分者 B 的表：${bPath}`);
  if (aiPath && !fs.existsSync(aiPath)) throw new Error(`找不到 AI 评分表：${aiPath}`);

  const a = loadImageScores(aPath, 'A');
  const b = loadImageScores(bPath, 'B');
  const ai = aiPath ? loadImageScores(aiPath, 'AI') : undefined;

  const report = buildReport({ aPath, bPath, aiPath, a, b, ai });
  const out = get('out') ?? path.join(path.dirname(aPath), '图像人工间一致性报告.md');
  fs.writeFileSync(out, report, 'utf8');

  const ab = compareScores(a.map, b.map);
  console.log(`可比图数：${ab.n}`);
  console.log(`A × B：二值一致率 ${pct(ab.labelAgreement)}，κ = ${f2(ab.kappa)}（${kappaTier(ab.kappa)}）`);
  if (aiPath && ai) {
    const aAI = compareScores(a.map, ai.map);
    const bAI = compareScores(b.map, ai.map);
    console.log(`A × AI：κ = ${f2(aAI.kappa)}（${kappaTier(aAI.kappa)}）`);
    console.log(`B × AI：κ = ${f2(bAI.kappa)}（${kappaTier(bAI.kappa)}）`);
  }
  console.log(`报告：${out}`);
}

main();
