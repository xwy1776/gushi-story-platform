/**
 * 实验 A 稳健性分析 —— 把「效应」拆成 批次 / 基线复读倾向 / 刺激材料 三个可能来源
 *
 * ── 为什么要单独跑这一遍 ──────────────────────────────────────────
 * 30 故事合并起来是显著的（`state` t=−3.62、`both` t=−4.98），但按批次拆开后，
 * 显著性几乎全部来自前 15 个故事（老 15 个 `state` t=−4.75，新 15 个 t=−1.15）。
 * 这正是本项目栽过好几次的「效应集中在子集」，所以写进论文之前必须回答：
 *
 *   1. 批次差异是真的，还是小样本噪声？          → §1 基线差异、§2 交互检验
 *   2. 新 15 个的 null 是「真没效应」还是「功效不够」？ → §5 等效性区间
 *   3. s15 → s30 之间刺激材料变过（种子类型改为从 states 派生 + 补了 20 条
 *      states），老故事上的效应翻倍有多少是它贡献的？  → §3 敏感性分析
 *
 * 三个问题都能用**已有数据**回答，不需要重跑：s15 那三份 JSON 就是「旧刺激材料」
 * 那一格，而配对单位是同一批故事，所以可以直接做「差分再差分」。
 *
 * 运行：npx tsx tests/ab_robustness.ts
 * 输出：Docs/ablation/s30_robustness.md
 */

import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { analyzePairedDiff, tTwoTailedP, tCritical } from './paired-stats';
import { BATCH2_STORY_DEFS } from './story-defs';

const DOCS = resolve(__dirname, '..', 'Docs', 'ablation');
const ARMS = ['none', 'state', 'graph', 'both'] as const;

interface Row {
  story: string;
  arm: string;
  segments: string[];
  promptLens?: number[];
  stateObjects?: number;
  graphNodes?: number;
  charCoverage?: number;
}

// ============================================================================
// 指标：与 ab_ablation.ts 逐字一致（抄一份，避免两处口径悄悄漂移）
// ============================================================================

function trigramSimilarity(a: string, b: string): number {
  const getTri = (s: string): Set<string> => {
    const set = new Set<string>();
    const clean = s.replace(/[\s。，！？；：""''《》【】\n]/g, '');
    for (let i = 0; i < clean.length - 2; i++) set.add(clean.slice(i, i + 3));
    return set;
  };
  const ta = getTri(a);
  const tb = getTri(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** 相邻段相似度数组 */
function adjacentSim(segments: string[]): number[] {
  const values: number[] = [];
  for (let i = 1; i < segments.length; i++) {
    values.push(trigramSimilarity(segments[i - 1], segments[i]));
  }
  return values;
}

const DEGENERATE_THRESHOLD = 0.9;

/** 该轮该故事该档触发了几次整段照抄 */
function degenerateCount(values: number[]): number {
  return values.filter((v) => v > DEGENERATE_THRESHOLD).length;
}

// ============================================================================
// 载入与发生率
// ============================================================================

function loadRounds(tag: string): { file: string; rows: Row[] }[] {
  const files = readdirSync(DOCS)
    .filter((f) => f.startsWith('ablation_results_') && f.endsWith('.json') && f.includes(tag))
    .sort();
  if (files.length === 0) throw new Error(`没有找到 ${tag} 的结果文件`);
  return files.map((f) => ({
    file: f,
    rows: JSON.parse(readFileSync(join(DOCS, f), 'utf8')) as Row[],
  }));
}

interface RateTable {
  rounds: number;
  /** 某故事某档在几轮里触发过退化复读（0–1） */
  rate: (arm: string, story: string) => number;
}

function buildRates(rounds: { file: string; rows: Row[] }[]): RateTable {
  const hits = new Map<string, number>();
  const totals = new Map<string, number>();
  for (const { rows } of rounds) {
    for (const row of rows) {
      if (!Array.isArray(row.segments)) {
        throw new Error(`结果行缺少 segments：${row.story} / ${row.arm}`);
      }
      const key = `${row.arm}|${row.story}`;
      totals.set(key, (totals.get(key) ?? 0) + 1);
      if (degenerateCount(adjacentSim(row.segments)) > 0) {
        hits.set(key, (hits.get(key) ?? 0) + 1);
      }
    }
  }
  return {
    rounds: rounds.length,
    rate: (arm, story) => {
      const key = `${arm}|${story}`;
      const total = totals.get(key) ?? 0;
      if (total === 0) throw new Error(`缺少数据：${story} / ${arm}`);
      return (hits.get(key) ?? 0) / total;
    },
  };
}

// ============================================================================
// 统计工具（t 分布 p 值复用 paired-stats，不另起口径）
// ============================================================================

const mean = (a: number[]): number => a.reduce((s, v) => s + v, 0) / a.length;

function variance(a: number[]): number {
  const m = mean(a);
  return a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1);
}

/** 两独立样本 t 检验（同时给 Welch 与合并方差两种口径） */
function twoSample(a: number[], b: number[]) {
  const n1 = a.length;
  const n2 = b.length;
  const m1 = mean(a);
  const m2 = mean(b);
  const v1 = variance(a);
  const v2 = variance(b);
  const seW = Math.sqrt(v1 / n1 + v2 / n2);
  const tW = (m1 - m2) / seW;
  const dfW = (v1 / n1 + v2 / n2) ** 2
    / ((v1 / n1) ** 2 / (n1 - 1) + (v2 / n2) ** 2 / (n2 - 1));
  const sp = ((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2);
  const seP = Math.sqrt(sp * (1 / n1 + 1 / n2));
  const tP = (m1 - m2) / seP;
  const dfP = n1 + n2 - 2;
  return {
    n1, n2, m1, m2,
    diff: m1 - m2,
    tWelch: tW, dfWelch: dfW, pWelch: tTwoTailedP(tW, dfW),
    tPooled: tP, dfPooled: dfP, pPooled: tTwoTailedP(tP, dfP),
  };
}

function pearson(x: number[], y: number[]) {
  const n = x.length;
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  const r = sxx === 0 || syy === 0 ? NaN : sxy / Math.sqrt(sxx * syy);
  const df = n - 2;
  const t = r * Math.sqrt(df / (1 - r * r));
  return { n, r, t, df, p: tTwoTailedP(t, df) };
}

/** 秩（并列取平均秩） */
function rank(a: number[]): number[] {
  const idx = a.map((v, i) => ({ v, i })).sort((p, q) => p.v - q.v);
  const out = new Array<number>(a.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1].v === idx[i].v) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k].i] = avg;
    i = j + 1;
  }
  return out;
}

function spearman(x: number[], y: number[]) {
  return pearson(rank(x), rank(y));
}

/** 方阵求逆（高斯-约当），奇异时抛错 */
function invert(m: number[][]): number[][] {
  const k = m.length;
  const a = m.map((row, i) => [...row, ...Array.from({ length: k }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < k; col++) {
    let piv = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    if (Math.abs(a[piv][col]) < 1e-12) throw new Error('回归设计矩阵奇异，无法求逆');
    [a[col], a[piv]] = [a[piv], a[col]];
    const p = a[col][col];
    for (let j = 0; j < 2 * k; j++) a[col][j] /= p;
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const factor = a[r][col];
      if (factor === 0) continue;
      for (let j = 0; j < 2 * k; j++) a[r][j] -= factor * a[col][j];
    }
  }
  return a.map((row) => row.slice(k));
}

/** 多元最小二乘（第一列应为常数项 1） */
function regress(X: number[][], y: number[]) {
  const n = y.length;
  const k = X[0].length;
  const xtx: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const xty: number[] = new Array<number>(k).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      xty[a] += X[i][a] * y[i];
      for (let b = 0; b < k; b++) xtx[a][b] += X[i][a] * X[i][b];
    }
  }
  const inv = invert(xtx);
  const beta = inv.map((row) => row.reduce((s, v, j) => s + v * xty[j], 0));
  let sse = 0;
  const my = mean(y);
  let sst = 0;
  for (let i = 0; i < n; i++) {
    const fit = beta.reduce((s, v, j) => s + v * X[i][j], 0);
    sse += (y[i] - fit) ** 2;
    sst += (y[i] - my) ** 2;
  }
  const df = n - k;
  const s2 = sse / df;
  const se = inv.map((row, a) => Math.sqrt(s2 * row[a]));
  const t = beta.map((b, a) => b / se[a]);
  return {
    beta, se, t, df,
    p: t.map((v) => tTwoTailedP(v, df)),
    r2: sst === 0 ? 0 : 1 - sse / sst,
  };
}

// ============================================================================
// 主流程
// ============================================================================

const s30 = loadRounds('s30x5seg');
const s15 = loadRounds('s15x5seg');
const R30 = buildRates(s30);
const R15 = buildRates(s15);

const allStories: string[] = [];
for (const row of s30[0].rows) if (!allStories.includes(row.story)) allStories.push(row.story);

const batch2Set = new Set(BATCH2_STORY_DEFS.map((d) => d.title));
const B1 = allStories.filter((s) => !batch2Set.has(s));
const B2 = allStories.filter((s) => batch2Set.has(s));

if (B1.length !== 15 || B2.length !== 15) {
  throw new Error(`批次拆分异常：第一批 ${B1.length} 个、第二批 ${B2.length} 个（期望各 15）`);
}
// s15 跑的正好是第一批那 15 个故事，§3 的「差分再差分」才成立。
// 这里逐个取一次值，缺故事会直接抛错，免得后面拿半截数据算出个看似合理的数。
for (const s of B1) {
  for (const arm of ARMS) R15.rate(arm, s);
}

const lines: string[] = [];
const f3 = (v: number): string => (Number.isFinite(v) ? v.toFixed(3) : '—');
const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
const pp = (v: number): string => `${(v * 100).toFixed(1)}pp`;

lines.push('# 实验 A 稳健性分析：效应来自哪里');
lines.push('');
lines.push('> 数据：s15（旧刺激材料，15 故事 × 4 档 × 5 段 × 3 轮）');
lines.push('> ＋ s30（新刺激材料，30 故事 × 4 档 × 5 段 × 3 轮）。');
lines.push('> 配对单位是**故事**；每个故事的「退化发生率」＝ 该故事该档在 3 轮里');
lines.push('> 触发过整段照抄的轮次占比。配对差值一律取「处理档 − `none`」，**负值 = 更好**。');
lines.push('> 脚本 `tests/ab_robustness.ts`，可重跑复现。');
lines.push('');

// ---- §0 口径校验 -----------------------------------------------------------
lines.push('## 0. 口径校验');
lines.push('');
lines.push(`本脚本重算的合并结果必须与 \`s30_rounds_report.md\` 一致（n=${allStories.length}，df=${allStories.length - 1}）。`);
lines.push('');
lines.push('| 档位 | 退化发生率 | 平均差值 | t | df | 精确 p |');
lines.push('|------|------:|------:|------:|------:|------:|');
const pooledResult: Record<string, ReturnType<typeof analyzePairedDiff>> = {};
for (const arm of ARMS) {
  const rates = allStories.map((s) => R30.rate(arm, s));
  const m = mean(rates);
  if (arm === 'none') {
    lines.push(`| \`none\`（基线） | ${pct(m)} | — | — | — | — |`);
    continue;
  }
  const diffs = allStories.map((s) => R30.rate(arm, s) - R30.rate('none', s));
  const r = analyzePairedDiff(diffs, 1);
  pooledResult[arm] = r;
  lines.push(`| \`${arm}\` | ${pct(m)} | ${f3(r.mean)} | ${f3(r.t)} | ${r.df} | ${r.p.toFixed(4)} |`);
}
lines.push('');
lines.push(`> 与报告对齐：三档 t 值应为 −3.62 / −1.61 / −4.98。未校正临界 t = ${f3(tCritical(29, 0.05))}，`
  + `Bonferroni k=3 → ${f3(tCritical(29, 0.05 / 3))}，k=4 → ${f3(tCritical(29, 0.05 / 4))}。`);
lines.push('');

// ---- §1 批次分解 -----------------------------------------------------------
lines.push('## 1. 拆批次：显著性集中在哪一半');
lines.push('');
lines.push('| 档位 | 样本 | 基线发生率 | 该档发生率 | 平均差值 | t | df | 精确 p |');
lines.push('|------|------|------:|------:|------:|------:|------:|------:|');
const groups: { name: string; stories: string[] }[] = [
  { name: '老 15 个（第一批）', stories: B1 },
  { name: '新 15 个（第二批）', stories: B2 },
  { name: '合并 30 个', stories: allStories },
];
for (const g of groups) {
  for (const arm of ARMS) {
    const base = mean(g.stories.map((s) => R30.rate('none', s)));
    const rates = g.stories.map((s) => R30.rate(arm, s));
    if (arm === 'none') {
      lines.push(`| \`none\` | ${g.name} | — | ${pct(mean(rates))} | — | — | — | — |`);
      continue;
    }
    const diffs = g.stories.map((s) => R30.rate(arm, s) - R30.rate('none', s));
    const r = analyzePairedDiff(diffs, 1);
    lines.push(`| \`${arm}\` | ${g.name} | ${pct(base)} | ${pct(mean(rates))} | ${f3(r.mean)} | ${f3(r.t)} | ${r.df} | ${r.p.toFixed(4)} |`);
  }
}
lines.push('');
lines.push('**两批的基线（`none` 档）本身就不一样** —— 老 15 个更容易复读，留给记忆注入的改善空间也更大：');
lines.push('');
const base1 = B1.map((s) => R30.rate('none', s));
const base2 = B2.map((s) => R30.rate('none', s));
const baseTest = twoSample(base1, base2);
lines.push(`- 老 15 个基线 ${pct(mean(base1))}，新 15 个 ${pct(mean(base2))}，差 ${pp(baseTest.diff)}`);
lines.push(`- 两独立样本 t 检验：Welch t = ${f3(baseTest.tWelch)}（df = ${baseTest.dfWelch.toFixed(1)}，p = ${baseTest.pWelch.toFixed(4)}）；`
  + `合并方差 t = ${f3(baseTest.tPooled)}（df = ${baseTest.dfPooled}，p = ${baseTest.pPooled.toFixed(4)}）`);
lines.push('');

// ---- §2 交互检验 -----------------------------------------------------------
lines.push('## 2. 交互检验：批次 × 档位');
lines.push('');
lines.push('每档取「新 15 个的平均差值 − 老 15 个的平均差值」，看批次会不会改变效应大小。');
lines.push('');
lines.push('| 档位 | 老 15 个差值 | 新 15 个差值 | 差值之差 | Welch t | df | p |');
lines.push('|------|------:|------:|------:|------:|------:|------:|');
for (const arm of ARMS) {
  if (arm === 'none') continue;
  const d1 = B1.map((s) => R30.rate(arm, s) - R30.rate('none', s));
  const d2 = B2.map((s) => R30.rate(arm, s) - R30.rate('none', s));
  const t = twoSample(d2, d1);
  lines.push(`| \`${arm}\` | ${f3(mean(d1))} | ${f3(mean(d2))} | ${f3(t.diff)} | ${f3(t.tWelch)} | ${t.dfWelch.toFixed(1)} | ${t.pWelch.toFixed(4)} |`);
}
lines.push('');

// ---- §3 刺激材料敏感性 -----------------------------------------------------
lines.push('## 3. 刺激材料敏感性：s15 → s30 之间还改了台架');
lines.push('');
lines.push('s15 跑在 2026-09-14 上午，而当天 16:12 的 `457d378` 把 `inferSeedNodeType` 的地点/事件名单');
lines.push('从**硬编码**改成**从故事定义的 `states` 派生**；9-25 的 `9b7519b` 又给第一批补了 **20 条 `states`**。');
lines.push('两处都只影响注入内容，且都落在 `graph` / `both` / `state` 三档上（`state` 档的状态表就是');
lines.push('`forceSetStates(def.states)` 直接播种的，见 [ab_ablation.ts:1060](../../tests/ab_ablation.ts#L1060)）。');
lines.push('');
lines.push('好在 s15 那三份 JSON 就是「旧刺激材料」那一格，而配对单位是**同一批 15 个故事**，');
lines.push('所以可以做「差分再差分」—— 差值 =（新材料下的改善）−（旧材料下的改善）：');
lines.push('');
lines.push('| 档位 | 旧材料改善 | 新材料改善 | 变化 | 配对 t | df | 精确 p | 95% CI |');
lines.push('|------|------:|------:|------:|------:|------:|------:|------|');
for (const arm of ARMS) {
  if (arm === 'none') continue;
  const oldImp = B1.map((s) => R15.rate(arm, s) - R15.rate('none', s));
  const newImp = B1.map((s) => R30.rate(arm, s) - R30.rate('none', s));
  const delta = newImp.map((v, i) => v - oldImp[i]);
  const r = analyzePairedDiff(delta, 1);
  lines.push(`| \`${arm}\` | ${f3(mean(oldImp))} | ${f3(mean(newImp))} | ${f3(r.mean)} | ${f3(r.t)} | ${r.df} | ${r.p.toFixed(4)} | ±${f3(r.ci95)} |`);
}
lines.push('');
lines.push('> 读法：**差值不显著**表示「刺激材料变更前后的改善幅度，在这个样本量下分不出来」。');
lines.push('> 这**不等于「没变」** —— 15 个故事的功效本来就弱（见 §5），区间宽度才是信息量所在。');
lines.push('');

// ---- §4 调节机制 -----------------------------------------------------------
lines.push('## 4. 调节机制：绝对降幅还是相对降幅');
lines.push('');
lines.push('老 15 个基线高、改善大，新 15 个基线低、改善小。要判断这是「真实的调节效应」还是');
lines.push('「尺子本身有上界」（改善幅度不可能超过基线），得看**相对降幅**是不是恒定的。');
lines.push('');
const baseAll = allStories.map((s) => R30.rate('none', s));
lines.push('### 4-1 绝对降幅 vs 基线（全部 30 个故事）');
lines.push('');
lines.push('| 档位 | Pearson r | p | Spearman ρ | p |');
lines.push('|------|------:|------:|------:|------:|');
for (const arm of ARMS) {
  if (arm === 'none') continue;
  const imp = allStories.map((s) => R30.rate('none', s) - R30.rate(arm, s));
  const pe = pearson(baseAll, imp);
  const sp = spearman(baseAll, imp);
  lines.push(`| \`${arm}\` | ${f3(pe.r)} | ${pe.p.toFixed(4)} | ${f3(sp.r)} | ${sp.p.toFixed(4)} |`);
}
lines.push('');
const posIdx = allStories.map((s, i) => i).filter((i) => baseAll[i] > 0);
lines.push(`> 上表把基线为 0% 的故事也算进去了 —— 那些故事**不可能改善**（地板效应），`);
lines.push(`> 会把相关性推向正。30 个故事里有 ${allStories.length - posIdx.length} 个基线为 0%。`);
lines.push('');
lines.push(`### 4-2 只看「有可能改善」的故事（基线 > 0，n=${posIdx.length}）`);
lines.push('');
lines.push('| 档位 | 基线均值 | 绝对降幅 | 相对降幅 | 相对降幅 vs 基线的 Spearman ρ | p |');
lines.push('|------|------:|------:|------:|------:|------:|');
for (const arm of ARMS) {
  if (arm === 'none') continue;
  const bl = posIdx.map((i) => baseAll[i]);
  const imp = posIdx.map((i) => baseAll[i] - R30.rate(arm, allStories[i]));
  const rel = imp.map((v, k) => v / bl[k]);
  const sp = spearman(bl, rel);
  lines.push(`| \`${arm}\` | ${pct(mean(bl))} | ${f3(mean(imp))} | ${pct(mean(rel))} | ${f3(sp.r)} | ${sp.p.toFixed(4)} |`);
}
lines.push('');
lines.push('### 4-3 「相对降幅」这个量本身有多吵');
lines.push('');
lines.push('每段故事每轮的基线只能取 0 / ⅓ / ⅔ / 1 四个值，所以「相对降幅」是一个**量子化且极不稳定**');
lines.push('的比值 —— 基线 ⅓ 的故事只要某一轮没触发，相对降幅就直接是 100%。列一下分布，');
lines.push('用来判断 §4-2 那个「不显著」到底该读成「真的没关系」还是「这个量太吵测不出来」：');
lines.push('');
lines.push('| 档位 | 相对降幅 < 0（反而变差） | = 0 | 0–50% | 50–100% | = 100%（降到 0） |');
lines.push('|------|:---:|:---:|:---:|:---:|:---:|');
for (const arm of ARMS) {
  if (arm === 'none') continue;
  const rel = posIdx.map((i) => (baseAll[i] - R30.rate(arm, allStories[i])) / baseAll[i]);
  const bucket = (lo: number, hi: number, loIncl: boolean, hiIncl: boolean): number =>
    rel.filter((v) => (loIncl ? v >= lo : v > lo) && (hiIncl ? v <= hi : v < hi)).length;
  lines.push(`| \`${arm}\` | ${bucket(-Infinity, 0, true, false)} | ${rel.filter((v) => v === 0).length} `
    + `| ${bucket(0, 0.5, false, false)} | ${bucket(0.5, 1, true, false)} | ${rel.filter((v) => v === 1).length} |`);
}
lines.push('');

lines.push('### 4-4 按基线分箱（比逐故事比值稳）');
lines.push('');
lines.push('| 基线区间 | n | 基线均值 | `state` 绝对降幅 | `state` 相对降幅 | `both` 绝对降幅 | `both` 相对降幅 |');
lines.push('|------|--:|------:|------:|------:|------:|------:|');
const bins: [string, number, number][] = [['0–33%', 0, 1 / 3], ['33–66%', 1 / 3, 2 / 3], ['66–100%', 2 / 3, 1.01]];
for (const [label, lo, hi] of bins) {
  const idx = allStories.map((s, i) => i).filter((i) => baseAll[i] >= lo && baseAll[i] < hi && baseAll[i] > 0);
  if (idx.length === 0) {
    lines.push(`| ${label} | 0 | — | — | — | — | — |`);
    continue;
  }
  const bl = mean(idx.map((i) => baseAll[i]));
  const cell = (arm: string): [string, string] => {
    const imp = mean(idx.map((i) => baseAll[i] - R30.rate(arm, allStories[i])));
    return [f3(imp), pct(imp / bl)];
  };
  const st = cell('state');
  const bo = cell('both');
  lines.push(`| ${label} | ${idx.length} | ${pct(bl)} | ${st[0]} | ${st[1]} | ${bo[0]} | ${bo[1]} |`);
}
lines.push('');

lines.push('### 4-5 协变量校正：批次差异是不是就是基线差异');
lines.push('');
lines.push('把「改善幅度」同时对**基线**和**批次**回归（`改善 = b0 + b1·基线 + b2·批次`，批次 1 = 老 15 个）。');
lines.push('`b2` 显著 → 批次在基线之外还有独立影响，那才是真正需要解释的东西；');
lines.push('`b2` 不显著 → 批次差异可以由基线差异解释掉，不必额外引入「两批故事不一样」这个说法。');
lines.push('');
lines.push('| 档位 | b1（基线斜率） | p | b2（批次） | p | R² | df |');
lines.push('|------|------:|------:|------:|------:|------:|------:|');
for (const arm of ARMS) {
  if (arm === 'none') continue;
  const y = allStories.map((s) => R30.rate('none', s) - R30.rate(arm, s));
  const X = allStories.map((s) => [1, R30.rate('none', s), batch2Set.has(s) ? 0 : 1]);
  const r = regress(X, y);
  lines.push(`| \`${arm}\` | ${f3(r.beta[1])} | ${r.p[1].toFixed(4)} | ${f3(r.beta[2])} | ${r.p[2].toFixed(4)} | ${f3(r.r2)} | ${r.df} |`);
}
lines.push('');

// ---- §5 新 15 个的等效性区间 -----------------------------------------------
lines.push('### 4-6 效应在做什么：把不同故事的复读倾向拉平');
lines.push('');
lines.push('按基线分箱后出现一个比「调节效应」更简洁的规律 —— **各箱在 `state` 档下落到同一个水平**：');
lines.push('');
lines.push('| 基线区间 | n | `none` | `state` | `graph` | `both` |');
lines.push('|------|--:|------:|------:|------:|------:|');
for (const [label, lo, hi] of bins) {
  const idx = allStories.map((s, i) => i).filter((i) => baseAll[i] >= lo && baseAll[i] < hi && baseAll[i] > 0);
  if (idx.length === 0) continue;
  const cell = (arm: string): string => pct(mean(idx.map((i) => R30.rate(arm, allStories[i]))));
  lines.push(`| ${label} | ${idx.length} | ${cell('none')} | ${cell('state')} | ${cell('graph')} | ${cell('both')} |`);
}
lines.push('');
lines.push('`none` 档下基线 33% 与 83% 的两组，在 `state` 档下都落到 **26–28%** —— ');
lines.push('也就是说「收益大小」只是「这个故事原本有多糟」的镜像，而注入后的水平大致是个常数。');
lines.push('同口径看批次，也是同一回事：');
lines.push('');
lines.push('| 样本 | n | `none` | `state` | `both` |');
lines.push('|------|--:|------:|------:|------:|');
{
  const st1 = mean(B1.map((s) => R30.rate('state', s)));
  const st2 = mean(B2.map((s) => R30.rate('state', s)));
  const bo1 = mean(B1.map((s) => R30.rate('both', s)));
  const bo2 = mean(B2.map((s) => R30.rate('both', s)));
  lines.push(`| 老 15 个 | 15 | ${pct(mean(base1))} | ${pct(st1)} | ${pct(bo1)} |`);
  lines.push(`| 新 15 个 | 15 | ${pct(mean(base2))} | ${pct(st2)} | ${pct(bo2)} |`);
  lines.push(`| **两批之差** | — | **${pp(baseTest.diff)}** | **${pp(st2 - st1)}** | **${pp(bo2 - bo1)}** |`);
}
lines.push('');
lines.push('**这才是「批次差异」的正确读法**：两批在 `none` 档相差 22pp，在注入档只差 6.7 / 8.9pp。');
lines.push('所以差异主要在**基线**上，而不在**处理效应**上 —— 与 §4-5 控制基线后批次系数不显著一致。');
lines.push('');
lines.push('离散度本身也可以直接检验（逐故事发生率相对各档中位数的绝对偏离，配对比较）：');
lines.push('');
lines.push('| 档位 | 发生率 SD | 极差 | IQR | 相对 `none` 的离散度变化 | 配对 t | df | p |');
lines.push('|------|------:|------:|------:|------:|------:|------:|------:|');
const medianOf = (a: number[]): number => {
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 === 1 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const ratesOf = (arm: string): number[] => allStories.map((s) => R30.rate(arm, s));
const noneRates = ratesOf('none');
const noneMed = medianOf(noneRates);
const sdOf = (a: number[]): number => Math.sqrt(variance(a));
const iqrOf = (a: number[]): number => {
  const s = [...a].sort((x, y) => x - y);
  const q = (p: number): number => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return q(0.75) - q(0.25);
};
for (const arm of ARMS) {
  const rr = ratesOf(arm);
  const dev = rr.map((v, i) => Math.abs(v - medianOf(rr)) - Math.abs(noneRates[i] - noneMed));
  const r = analyzePairedDiff(dev, 1);
  const sd = sdOf(rr);
  const range = Math.max(...rr) - Math.min(...rr);
  const rel = arm === 'none' ? '—' : `${f3(sd / sdOf(noneRates))}×`;
  const tCell = arm === 'none' ? '—' : f3(r.t);
  const pCell = arm === 'none' ? '—' : r.p.toFixed(4);
  const dfCell = arm === 'none' ? '—' : String(r.df);
  lines.push(`| \`${arm}\` | ${f3(sd)} | ${f3(range)} | ${f3(iqrOf(rr))} | ${rel} | ${tCell} | ${dfCell} | ${pCell} |`);
}
lines.push('');
lines.push('> ⚠️ **收敛只发生在「组均值」层面，不是「个体」层面**：SD 只从 0.323 降到 0.312');
lines.push('> （0.97×，配对检验 p = 0.88），而且有 5 个故事在 `state` 档**反而变差**（§6）。');
lines.push('> 所以准确的说法是「**平均而言**，注入后的发生率与故事原本的复读倾向脱钩」，');
lines.push('> 不能写成「注入消除了故事间的差异」—— 后者被离散度检验直接否掉。');
lines.push('');


lines.push('');
lines.push('## 5. 新 15 个的「不显著」到底排除了什么');
lines.push('');
lines.push('「p > 0.05」本身不是结论。把区间报出来，才知道这个 null 有多少信息量。');
lines.push('');
lines.push('| 档位 | n | 平均差值 | 观测 d | 95% CI（差值） | 95% CI（d） | 能排除的改善幅度 |');
lines.push('|------|------:|------:|------:|------|------|------|');
for (const arm of ARMS) {
  if (arm === 'none') continue;
  const diffs = B2.map((s) => R30.rate(arm, s) - R30.rate('none', s));
  const r = analyzePairedDiff(diffs, 1);
  const d = r.mean / r.sd;
  const ciD = r.ci95 / r.sd;
  const lo = r.mean - r.ci95;
  const hi = r.mean + r.ci95;
  const excluded = hi < 0
    ? '（区间整体为负 = 已达显著）'
    : `大于 ${pp(-lo)} 的改善`;
  lines.push(`| \`${arm}\` | ${r.n} | ${f3(r.mean)} | ${f3(d)} | `
    + `[${f3(lo)}, ${f3(hi)}] | [${f3(d - ciD)}, ${f3(d + ciD)}] | ${excluded} |`);
}
lines.push('');
lines.push('> 同样口径下，老 15 个的 `state` 平均差值是 '
  + `${f3(mean(B1.map((s) => R30.rate('state', s) - R30.rate('none', s))))}`
  + ' —— 两个批次的点估计差了一倍以上，但都落在 15 个故事的功效区间内。');
lines.push('');

// ---- §6 逐故事支配 ---------------------------------------------------------
lines.push('## 6. 逐故事支配关系（30 故事）');
lines.push('');
lines.push('比 p 值更保守的检查：如果有故事在某个档位上**反而变差**，就不能宣称该档位普遍有效。');
lines.push('');
lines.push('| 对比 | 更优 | 打平 | 更差 |');
lines.push('|------|:---:|:---:|:---:|');
const pairs: [string, string][] = [];
for (let i = 0; i < ARMS.length; i++) {
  for (let j = i + 1; j < ARMS.length; j++) pairs.push([ARMS[j], ARMS[i]]);
}
for (const [treat, base] of pairs) {
  const diffs = allStories.map((s) => R30.rate(treat, s) - R30.rate(base, s));
  lines.push(`| \`${treat}\` vs \`${base}\` | ${diffs.filter((d) => d < 0).length} `
    + `| ${diffs.filter((d) => d === 0).length} | ${diffs.filter((d) => d > 0).length} |`);
}
lines.push('');

// ---- §7 逐故事明细 ---------------------------------------------------------
lines.push('## 7. 逐故事明细（发生率，跨 3 轮）');
lines.push('');
lines.push('| 批次 | 故事 | `none` | `state` | `graph` | `both` | `state` 改善 | `both` 改善 |');
lines.push('|:---:|------|------:|------:|------:|------:|------:|------:|');
for (const s of allStories) {
  const tag = batch2Set.has(s) ? '2' : '1';
  const base = R30.rate('none', s);
  lines.push(`| ${tag} | ${s} | ${pct(base)} | ${pct(R30.rate('state', s))} | ${pct(R30.rate('graph', s))} `
    + `| ${pct(R30.rate('both', s))} | ${pp(base - R30.rate('state', s))} | ${pp(base - R30.rate('both', s))} |`);
}
lines.push('');

// ---- §8 小结 ---------------------------------------------------------------
lines.push('## 8. 小结');
lines.push('');
const relOf = (arm: string): number =>
  mean(posIdx.map((i) => (baseAll[i] - R30.rate(arm, allStories[i])) / baseAll[i]));
const interP: Record<string, number> = {};
const sensP: Record<string, number> = {};
const covB2: Record<string, { b: number; p: number }> = {};
for (const arm of ARMS) {
  if (arm === 'none') continue;
  const d1 = B1.map((s) => R30.rate(arm, s) - R30.rate('none', s));
  const d2 = B2.map((s) => R30.rate(arm, s) - R30.rate('none', s));
  interP[arm] = twoSample(d2, d1).pWelch;
  // 注意：敏感性检验必须**两边都用第一批**（s15 只有第一批），别顺手复用上面的 d2
  const newImpB1 = B1.map((s) => R30.rate(arm, s) - R30.rate('none', s));
  const oldImpB1 = B1.map((s) => R15.rate(arm, s) - R15.rate('none', s));
  sensP[arm] = analyzePairedDiff(newImpB1.map((v, i) => v - oldImpB1[i]), 1).p;
  const y = allStories.map((s) => R30.rate('none', s) - R30.rate(arm, s));
  const X = allStories.map((s) => [1, R30.rate('none', s), batch2Set.has(s) ? 0 : 1]);
  const r = regress(X, y);
  covB2[arm] = { b: r.beta[2], p: r.p[2] };
}
const absRhoState = spearman(baseAll, allStories.map((s) => R30.rate('none', s) - R30.rate('state', s)));
const relRhoState = spearman(posIdx.map((i) => baseAll[i]), posIdx.map((i) => 1 - R30.rate('state', allStories[i]) / baseAll[i]));
const b2state = analyzePairedDiff(B2.map((s) => R30.rate('state', s) - R30.rate('none', s)), 1);

lines.push('把前面几节压成几条**能直接约束论文措辞**的结论：');
lines.push('');
lines.push(`1. **合并结果成立，口径与自动报告一致**（§0）：\`state\` t = ${f3(pooledResult.state.t)}、`
  + `\`both\` t = ${f3(pooledResult.both.t)}，两个都过最保守的 k=4 校正（df=29 时临界 t = ${f3(tCritical(29, 0.0125))}）。`);
lines.push(`2. **两批的基线不同，但差异只是边缘**（§1）：${pct(mean(base1))} vs ${pct(mean(base2))}，差 ${pp(baseTest.diff)}，`
  + `Welch p = ${baseTest.pWelch.toFixed(3)}。批次×档位交互同理，只有 \`state\` 擦边`
  + `（p = ${interP.state.toFixed(3)}），\`graph\` / \`both\` 都不显著。`);
lines.push(`3. **刺激材料的变更无法被归因**（§3）：老 15 个故事上「新材料 − 旧材料」的改善变化，`
  + `三档 p = ${sensP.state.toFixed(2)} / ${sensP.graph.toFixed(2)} / ${sensP.both.toFixed(2)}，全不显著。`
  + `所以**不能写**「效应翻倍是种子修复带来的」——只能说这个样本量下分不出来。`);
lines.push(`4. **绝对降幅随基线上升，相对降幅不随**（§4-1 / §4-2）：\`state\` 的绝对降幅与基线 ρ = ${f3(absRhoState.r)}`
  + `（p = ${absRhoState.p.toFixed(4)}），而相对降幅与基线 ρ = ${f3(relRhoState.r)}（p = ${relRhoState.p.toFixed(3)}）；`
  + `基线 > 0 的 ${posIdx.length} 个故事上 \`state\` 平均相对降幅 ${pct(relOf('state'))}、\`both\` ${pct(relOf('both'))}。`);
lines.push(`   但 §4-3 显示相对降幅是个**量子化、极吵**的比值，所以「不相关」既可能是真的没关系，`
  + `也可能是测不出来 —— 这条只能作为待验证的规律，不能当乘性模型的证据。`);
lines.push(`   更有信息量的是 §4-6 的分箱：基线 33% 与 83% 两组在 \`state\` 档下分别落到 28.2% / 26.2%，`
  + `即「收益大小」基本是「原本有多糟」的镜像。但**这不能推广成「注入消除了故事间差异」**——`
  + `离散度配对检验 p = 0.88，个体层面没有收敛。`);
lines.push(`5. **控制基线之后，批次几乎不剩独立贡献**（§4-5）：\`state\` 的批次系数 ${f3(covB2.state.b)}`
  + `（p = ${covB2.state.p.toFixed(3)}）、\`graph\` ${f3(covB2.graph.b)}（p = ${covB2.graph.p.toFixed(3)}）、`
  + `\`both\` ${f3(covB2.both.b)}（p = ${covB2.both.p.toFixed(3)}）。`);
lines.push(`6. **新 15 个不是「证明了无效」，而是「没测到」**（§5）：\`state\` 在第二批上平均差值 ${f3(b2state.mean)}，`
  + `95% CI [${f3(b2state.mean - b2state.ci95)}, ${f3(b2state.mean + b2state.ci95)}]，`
  + `能排除的只有「大于 ${pp(-(b2state.mean - b2state.ci95))} 的改善」。`
  + `老 15 个同口径点估计是 ${f3(mean(B1.map((s) => R30.rate('state', s) - R30.rate('none', s))))} —— `
  + `**两个点估计都落在对方 15 故事的功效区间里**，所以「批次差异」本身也没被这批数据坐实。`);
lines.push('');
lines.push('> 给论文的净结论：**合并结论可以写，但必须同时给出（a）两批的分解结果、');
lines.push('> （b）新批的区间而非「不显著」三个字、（c）批次差异本身也只有边缘证据。**');
lines.push('> 把「效应集中在第一批」当成一个**待解释的异质性**如实报告，比只报合并 p 值安全。');
lines.push('');

// ---- §9 观测量（s30）-------------------------------------------------------
lines.push('## 9. 观测量（30 故事）');
lines.push('');
lines.push('论文 §2.4 用到的那几个观测量，按同样口径从 s30 的 JSON 重算一遍。');
lines.push('「轮均±轮间标准差」中的标准差是**三轮均值之间的**，不是跨故事的。');
lines.push('');
const armRows = (arm: string): Row[] => s30[0].rows.filter((r) => r.arm === arm);
const promptMean = (r: Row): number => (r.promptLens && r.promptLens.length > 0 ? mean(r.promptLens) : NaN);
const perRoundField = (arm: string, pick: (r: Row) => number): number[] =>
  s30.map(({ rows }) => mean(rows.filter((r) => r.arm === arm).map(pick)));
const asCells = (perRound: number[], decimals = 1): { text: string; m: number } => {
  const m = mean(perRound);
  const sd = perRound.length > 1 ? Math.sqrt(variance(perRound)) : 0;
  return { text: `${m.toFixed(decimals)} ± ${sd.toFixed(decimals)}`, m };
};
lines.push('| 档位 | Prompt 长度（字符） | 相对基线 | 状态表对象 | 角色覆盖率 | 图谱节点数 |');
lines.push('|------|------:|------:|------:|------:|------:|');
const promptBase = mean(perRoundField('none', promptMean));
for (const arm of ARMS) {
  const p = asCells(perRoundField(arm, promptMean), 0);
  const s = asCells(perRoundField(arm, (r) => r.stateObjects ?? NaN));
  const c = asCells(perRoundField(arm, (r) => r.charCoverage ?? NaN), 3);
  const g = asCells(perRoundField(arm, (r) => r.graphNodes ?? NaN), 0);
  const delta = arm === 'none' ? '—' : `+${(p.m - promptBase).toFixed(0)} (+${(((p.m - promptBase) / promptBase) * 100).toFixed(0)}%)`;
  lines.push(`| \`${arm}\` | ${p.text} | ${delta} | ${s.text} | ${c.text} | ${g.text} |`);
}
lines.push('');
lines.push('> ⚠️ **图谱节点数这一列仍然不可用于档位对比**：`knowledgeGraph.getStats()` 返回的是整个图谱');
lines.push('> 文件的节点数、**不按 `branchId` 过滤**（[knowledge-graph.ts:851](../../src/lib/knowledge-graph.ts#L851)），');
lines.push('> 脚本按 `none→state→graph→both` 顺序跑，后跑的档位天然看到更大的图。这条结论在 s30 上不变。');
lines.push('');
lines.push('> 状态表对象数是一份**有效的控制组证据**：不注入的 `none` / `graph` 两档应当恒等于种子数据量，');
lines.push('> 注入的 `state` / `both` 才会增长。若 `none` 档三轮之间出现波动，说明分支隔离漏了，');
lines.push('> 前面的主结果就不能用。');
lines.push('');
const nonePerRound = perRoundField('none', (r) => r.stateObjects ?? NaN);
lines.push(`实测 ` + '`none`' + ` 档三轮的状态表对象数：${nonePerRound.map((v) => v.toFixed(1)).join(' / ')}`
  + `（${new Set(nonePerRound.map((v) => v.toFixed(3))).size === 1 ? '三轮逐轮完全相同 → 分支隔离生效' : '三轮之间存在差异 → ⚠️ 需要排查'}）。`);
lines.push('');

const out = join(DOCS, 's30_robustness.md');
writeFileSync(out, lines.join('\n'), 'utf8');
process.stdout.write(lines.join('\n'));
process.stdout.write(`\n\n[已写入] ${out}\n`);
