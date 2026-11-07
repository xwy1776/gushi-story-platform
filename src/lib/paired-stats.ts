/**
 * 配对统计工具（实验数据分析用）
 *
 * 纯函数、零依赖。为「3 段 × N 故事 × 前后 2 组」配对比较实验提供：
 *  - Wilcoxon 符号秩检验（n ≤ 20 精确分布；更大样本正态近似 + 连续性校正/结校正）
 *  - 符号检验 / McNemar 精确检验（二值配对）
 *  - 成对差值的 bootstrap 置信区间（可复现随机种子）
 *  - 效应量（秩二列相关）与 Cohen's κ（评分一致性）
 *  - 基础描述统计（均值/样本标准差/中位数）
 *
 * 所有检验均为双侧。约定 p 值 = min(1, 2 × 单侧 p)。
 */

// ─── 基础描述统计 ─────────────────────────────────────────────────────

export function mean(xs: number[]): number {
  if (xs.length === 0) return NaN;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** 样本标准差（n-1 分母）；长度 < 2 时返回 0 */
export function sd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const varSum = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1);
  return Math.sqrt(varSum);
}

export function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ─── Wilcoxon 符号秩检验 ──────────────────────────────────────────────

export interface WilcoxonResult {
  /** 非零差值个数（零差值按惯例剔除） */
  n: number;
  zeros: number;
  /** 正秩和 */
  wPlus: number;
  /** 负秩和 */
  wMinus: number;
  /** 双侧 p 值 */
  pValue: number;
  /** 是否使用精确分布 */
  exact: boolean;
  /** 效应量：秩二列相关 (wPlus - wMinus) / (wPlus + wMinus)，全零差值为 0 */
  rankBiserial: number;
}

/** 精确分布的最大样本量（2^n 计数在 DP 中不放大，n ≤ 20 时总和 ≤ 2^20，安全） */
const WILCOXON_MAX_EXACT_N = 20;

/**
 * 计算 |差值| 的平均秩（并列取平均），返回按原顺序的平均秩数组
 */
function averageRanks(absDiffs: number[]): number[] {
  const idx = absDiffs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(absDiffs.length).fill(0);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1].v === idx[i].v) j++;
    // 位置 i..j（0-based）共享平均秩 (i+1 + j+1) / 2
    const avg = (i + 1 + (j + 1)) / 2;
    for (let k = i; k <= j; k++) ranks[idx[k].i] = avg;
    i = j + 1;
  }
  return ranks;
}

/**
 * 精确分布：把平均秩 ×2 化为整数后做子集和 DP（符号翻转枚举的等价计数）。
 * 返回 Map<缩放后秩和, 出现次数>，总次数 = 2^n。
 */
function exactRankSumCounts(avgRanks: number[]): Map<number, number> {
  const scaled = avgRanks.map(r => Math.round(r * 2));
  let dist = new Map<number, number>([[0, 1]]);
  for (const v of scaled) {
    const next = new Map<number, number>();
    for (const [s, c] of dist) {
      next.set(s, (next.get(s) ?? 0) + c); // 负号
      next.set(s + v, (next.get(s + v) ?? 0) + c); // 正号
    }
    dist = next;
  }
  return dist;
}

/**
 * Wilcoxon 符号秩检验（双侧）。
 * diffs = 同一配对单元下 after − before 的差值数组。
 */
export function wilcoxonSignedRank(diffs: number[]): WilcoxonResult {
  const nonZero = diffs.filter(d => d !== 0);
  const zeros = diffs.length - nonZero.length;
  const n = nonZero.length;

  if (n === 0) {
    return { n: 0, zeros, wPlus: 0, wMinus: 0, pValue: 1, exact: true, rankBiserial: 0 };
  }

  const avgRanks = averageRanks(nonZero.map(Math.abs));
  let wPlus = 0;
  let wMinus = 0;
  for (let i = 0; i < n; i++) {
    if (nonZero[i] > 0) wPlus += avgRanks[i];
    else wMinus += avgRanks[i];
  }

  const rankBiserial = wPlus + wMinus > 0 ? (wPlus - wMinus) / (wPlus + wMinus) : 0;

  if (n <= WILCOXON_MAX_EXACT_N) {
    const dist = exactRankSumCounts(avgRanks);
    const scaledWPlus = Math.round(wPlus * 2);
    const total = Math.pow(2, n);
    let geCount = 0; // P(W ≥ wPlus)
    let leCount = 0; // P(W ≤ wPlus)
    for (const [s, c] of dist) {
      if (s >= scaledWPlus) geCount += c;
      if (s <= scaledWPlus) leCount += c;
    }
    const pValue = Math.min(1, (2 * Math.min(geCount, leCount)) / total);
    return { n, zeros, wPlus, wMinus, pValue, exact: true, rankBiserial };
  }

  // 正态近似（含结校正）：W+ 的均值 n(n+1)/4，方差（无结）n(n+1)(2n+1)/24
  const mu = (n * (n + 1)) / 4;
  // 结校正：按 |差值| 分组，Σ(t^3 − t) / 48 从方差中扣除
  const counts = new Map<number, number>();
  for (const d of nonZero) {
    const a = Math.abs(d);
    counts.set(a, (counts.get(a) ?? 0) + 1);
  }
  let tieCorrection = 0;
  for (const t of counts.values()) tieCorrection += t * t * t - t;
  const sigma2 = (n * (n + 1) * (2 * n + 1)) / 24 - tieCorrection / 48;
  const sigma = Math.sqrt(sigma2);
  const z = sigma > 0 ? (Math.abs(wPlus - mu) - 0.5) / sigma : 0; // 连续性校正
  const pValue = Math.min(1, 2 * normalSf(Math.abs(z)));
  return { n, zeros, wPlus, wMinus, pValue, exact: false, rankBiserial };
}

// ─── 二项精确检验（符号检验 / McNemar 共用） ─────────────────────────

function binomialCoefficient(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 1; i <= k; i++) {
    result = (result * (n - k + i)) / i;
  }
  return result;
}

/**
 * 双侧二项精确检验：X ~ Binomial(n, 0.5)，观测到 k 次"成功"（取较小侧）。
 * p = min(1, 2 × P(X ≤ k))。
 */
function binomTwoSidedP(k: number, n: number): number {
  if (n === 0) return 1;
  const kk = Math.min(k, n - k);
  let tail = 0;
  for (let i = 0; i <= kk; i++) tail += binomialCoefficient(n, i);
  return Math.min(1, (2 * tail) / Math.pow(2, n));
}

function normalSf(z: number): number {
  // 正态分布上尾概率（Abramowitz-Stegun 近似）
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p =
    d * t * (1.330274429 * Math.pow(t, 4) - 1.821255978 * Math.pow(t, 3) + 1.781477937 * t * t - 0.356563782 * t + 0.319381530);
  const sf = z >= 0 ? p : 1 - p;
  return sf;
}

export interface SignTestResult {
  n: number;
  zeros: number;
  positives: number;
  negatives: number;
  /** 双侧精确 p 值 */
  pValue: number;
}

/** 符号检验（双侧精确）：剔除零差值后对符号做二项检验 */
export function signTest(diffs: number[]): SignTestResult {
  const nonZero = diffs.filter(d => d !== 0);
  const positives = nonZero.filter(d => d > 0).length;
  const negatives = nonZero.length - positives;
  return {
    n: nonZero.length,
    zeros: diffs.length - nonZero.length,
    positives,
    negatives,
    pValue: binomTwoSidedP(Math.min(positives, negatives), nonZero.length),
  };
}

export interface McNemarResult {
  /** 前=0 后=1 的不一致对数 */
  b: number;
  /** 前=1 后=0 的不一致对数 */
  c: number;
  discordant: number;
  pValue: number;
}

/**
 * McNemar 精确检验（双侧）：配对二值数据。
 * b / c 为两个方向的不一致对数，一致对不参与检验。
 */
export function mcnemarExact(b: number, c: number): McNemarResult {
  return {
    b,
    c,
    discordant: b + c,
    pValue: binomTwoSidedP(Math.min(b, c), b + c),
  };
}

/** 从配对数据 ({before, after} 0/1) 直接算 McNemar */
export function mcnemarFromPairs(pairs: { before: number; after: number }[]): McNemarResult {
  let b = 0;
  let c = 0;
  for (const p of pairs) {
    if (p.before === 0 && p.after === 1) b++;
    else if (p.before === 1 && p.after === 0) c++;
  }
  return mcnemarExact(b, c);
}

// ─── Bootstrap 置信区间 ───────────────────────────────────────────────

/** 可复现伪随机数（mulberry32）；同 seed 结果稳定，便于报告复核 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BootstrapCI {
  /** 点估计（样本均值） */
  estimate: number;
  lower: number;
  upper: number;
  level: number;
  iters: number;
}

/**
 * 均值的百分位 bootstrap 置信区间。
 * 对"配对差值数组"调用即为配对均值差的 CI（重采样单位 = 配对单元）。
 */
export function bootstrapMeanCI(
  values: number[],
  opts: { iters?: number; level?: number; seed?: number } = {},
): BootstrapCI {
  const { iters = 10000, level = 0.95, seed = 20261002 } = opts;
  if (values.length === 0) {
    return { estimate: NaN, lower: NaN, upper: NaN, level, iters };
  }
  const rand = mulberry32(seed);
  const means: number[] = [];
  for (let it = 0; it < iters; it++) {
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[Math.floor(rand() * values.length)];
    }
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  const alpha = (1 - level) / 2;
  const loIdx = Math.max(0, Math.floor(alpha * iters));
  const hiIdx = Math.min(iters - 1, Math.ceil((1 - alpha) * iters) - 1);
  return { estimate: mean(values), lower: means[loIdx], upper: means[hiIdx], level, iters };
}

// ─── 评分一致性（AI 与人工抽查） ──────────────────────────────────────

/**
 * Cohen's κ（二值/分类评分一致性）。
 * 边缘分布全为单一类别时：完全一致返回 1，否则返回 0。
 */
export function cohensKappa(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return NaN;
  let agree = 0;
  const countA = new Map<number, number>();
  const countB = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) agree++;
    countA.set(a[i], (countA.get(a[i]) ?? 0) + 1);
    countB.set(b[i], (countB.get(b[i]) ?? 0) + 1);
  }
  const po = agree / n;
  let pe = 0;
  const categories = new Set([...countA.keys(), ...countB.keys()]);
  for (const c of categories) {
    pe += ((countA.get(c) ?? 0) / n) * ((countB.get(c) ?? 0) / n);
  }
  if (pe >= 1) return po >= 1 ? 1 : 0;
  return (po - pe) / (1 - pe);
}

// ─── 配对汇总（报告用） ───────────────────────────────────────────────

export interface PairedSummary {
  n: number;
  meanBefore: number;
  meanAfter: number;
  sdBefore: number;
  sdAfter: number;
  meanDiff: number;
  sdDiff: number;
  medianDiff: number;
  wilcoxon: WilcoxonResult;
  ci: BootstrapCI;
}

/** 对 [before, after] 配对数组做全套汇总统计 */
export function summarizePaired(pairs: { before: number; after: number }[]): PairedSummary {
  const before = pairs.map(p => p.before);
  const after = pairs.map(p => p.after);
  const diffs = pairs.map(p => p.after - p.before);
  return {
    n: pairs.length,
    meanBefore: mean(before),
    meanAfter: mean(after),
    sdBefore: sd(before),
    sdAfter: sd(after),
    meanDiff: mean(diffs),
    sdDiff: sd(diffs),
    medianDiff: median(diffs),
    wilcoxon: wilcoxonSignedRank(diffs),
    ci: bootstrapMeanCI(diffs),
  };
}
