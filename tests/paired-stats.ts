/**
 * 配对差值的统计工具 —— 供 llm_judge.ts 与 make_charts.ts 共用
 *
 * ── 为什么单独抽出来 ──────────────────────────────────────────────
 * 两个脚本各自实现过一份配对逻辑，且都用「|t| > 2.064」这个硬编码临界值判定显著。
 * 那个 2.064 是 **单次比较、α=0.05、df=24** 的临界值 —— 而实际做的是
 * **三个比较**（state/graph/both 各与基线比）。多重比较会抬高族错误率，
 * 不校正就宣称「显著」是错的。
 *
 * 这里改为：算真实 p 值 → 按比较次数做 Bonferroni 校正 → 再判定。
 *
 * 依赖：无（t 分布 p 值自己实现，避免为一次检验引入统计库）
 */

// ============================================================================
// t 分布 p 值（Lanczos + 连分数，Numerical Recipes 的标准做法）
// ============================================================================

const LANCZOS_G = 7;
const LANCZOS_C = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** 对数伽马函数 */
function lnGamma(z: number): number {
  if (z < 0.5) {
    // 反射公式
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  }
  let x = LANCZOS_C[0];
  const zz = z - 1;
  for (let i = 1; i < LANCZOS_G + 2; i++) x += LANCZOS_C[i] / (zz + i);
  const t = zz + LANCZOS_G + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (zz + 0.5) * Math.log(t) - t + Math.log(x);
}

/** 不完全贝塔函数的连分数展开 */
function betacf(a: number, b: number, x: number): number {
  const MAXIT = 300;
  const EPS = 3e-12;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;

  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;

    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** 正则化不完全贝塔函数 I_x(a, b) */
function betai(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Student t 分布的双尾 p 值 */
export function tTwoTailedP(t: number, df: number): number {
  if (!Number.isFinite(t) || df <= 0) return NaN;
  return betai(df / 2, 0.5, df / (df + t * t));
}

/**
 * 双侧检验的临界 t 值（数值反解）。
 * 用于报告「本检验的临界值是多少」，避免写死一个容易过期的数字。
 */
export function tCritical(df: number, alpha: number): number {
  let lo = 0;
  let hi = 100;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (tTwoTailedP(mid, df) > alpha) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ============================================================================
// 配对差值分析
// ============================================================================

export interface PairedResult {
  /** 配对样本数 */
  n: number;
  mean: number;
  sd: number;
  /** 均值的标准误 */
  se: number;
  /**
   * 校正后 α 对应的置信区间半宽 —— **与 sig 判定同一口径**。
   * 画误差棒必须用这个：若用未校正的 95% CI 配校正后的显著性判定，
   * 图上会出现「误差棒不跨 0 但标注不显著」的自相矛盾。
   */
  ci: number;
  /** 未校正的 95% 置信区间半宽（仅供参考对照） */
  ci95: number;
  t: number;
  df: number;
  /** 未校正的双尾 p 值 */
  p: number;
  /** 本次检验使用的显著性水平（Bonferroni 校正后） */
  alpha: number;
  /** 该 alpha 下的临界 t */
  tCrit: number;
  /** 校正后是否显著 */
  sig: boolean;
  /** 处理组更好的配对数 */
  better: number;
  /** 处理组更差的配对数 */
  worse: number;
  /** 打平的配对数 */
  tie: number;
}

/**
 * 对配对样本做单样本 t 检验（H0: 差值均值 = 0）。
 *
 * @param diffs       配对差值数组（处理组 − 基线，逐对计算好）
 * @param comparisons 本轮一共做了几个比较 —— 用于 Bonferroni 校正。
 *                    传 1 表示不校正。
 */
export function analyzePairedDiff(diffs: number[], comparisons = 1): PairedResult {
  const n = diffs.length;
  const cmp = Math.max(1, comparisons);
  const alpha = 0.05 / cmp;

  if (n < 2) {
    return {
      n, mean: n ? diffs[0] : NaN, sd: NaN, se: NaN, ci: NaN, ci95: NaN,
      t: NaN, df: Math.max(n - 1, 0), p: NaN, alpha, tCrit: NaN,
      sig: false, better: 0, worse: 0, tie: 0,
    };
  }

  const mean = diffs.reduce((a, b) => a + b, 0) / n;
  const variance = diffs.reduce((s, d) => s + (d - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  const se = sd / Math.sqrt(n);
  const df = n - 1;
  const t = se > 0 ? mean / se : 0;
  const p = tTwoTailedP(t, df);
  const tCrit = tCritical(df, alpha);

  return {
    n,
    mean,
    sd,
    se,
    // 与 sig 同一口径：用校正后 α 的临界 t
    ci: tCrit * se,
    ci95: 1.96 * se,
    t,
    df,
    p,
    alpha,
    tCrit,
    sig: p < alpha,
    better: diffs.filter((d) => d > 0).length,
    worse: diffs.filter((d) => d < 0).length,
    tie: diffs.filter((d) => d === 0).length,
  };
}

/**
 * 按 (轮次, 故事) 配对：把处理档的每条分数减去同轮同故事的基线分数。
 *
 * @param records 全部打分记录，需含 arm / round / story / total（或任意数值字段）
 * @param treatmentArm 处理档位 key
 * @param baselineArm  基线档位 key
 * @param valueOf      取值函数（默认取 total）
 */
export function pairedDiffs<T extends { arm: string; round: string; story: string }>(
  records: T[],
  treatmentArm: string,
  baselineArm: string,
  valueOf: (r: T) => number = (r) => (r as unknown as { total: number }).total,
): number[] {
  const base = new Map<string, number>();
  for (const r of records) {
    if (r.arm === baselineArm) base.set(`${r.round}|${r.story}`, valueOf(r));
  }
  const diffs: number[] = [];
  for (const r of records) {
    if (r.arm !== treatmentArm) continue;
    const b = base.get(`${r.round}|${r.story}`);
    if (b !== undefined) diffs.push(valueOf(r) - b);
  }
  return diffs;
}
