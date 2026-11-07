/**
 * paired-stats 单元测试
 *
 * 验证「3 段 × N 故事 × 前后 2 组」配对比较所需的统计工具：
 *  - Wilcoxon 符号秩：无结案例用手算基准（2/2^n），有结案例用独立暴力枚举交叉验证
 *  - 符号检验 / McNemar 精确检验：二项分布手算基准
 *  - bootstrap CI：可复现性与收缩性
 *  - Cohen's κ / 描述统计
 *
 * 运行：npx vitest run tests/paired-stats.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
  bootstrapMeanCI,
  cohensKappa,
  mean,
  mcnemarExact,
  mcnemarFromPairs,
  median,
  sd,
  signTest,
  summarizePaired,
  wilcoxonSignedRank,
} from '@/lib/paired-stats';

// ── 独立暴力枚举（测试内实现，与 DP 精确分布交叉验证） ────────────────

/** 平均秩（与主实现独立重写一遍：排序 + 并列取平均） */
function avgRanks(absDiffs: number[]): number[] {
  const s = absDiffs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array<number>(absDiffs.length).fill(0);
  let i = 0;
  while (i < s.length) {
    let j = i;
    while (j + 1 < s.length && s[j + 1].v === s[i].v) j++;
    const avg = (i + j + 2) / 2;
    for (let k = i; k <= j; k++) out[s[k].i] = avg;
    i = j + 1;
  }
  return out;
}

/** 朴素枚举全部 2^n 符号分配，计算双侧 p（与 DP 实现应逐一相符） */
function bruteForceWilcoxonP(diffs: number[]): { wPlus: number; p: number } {
  const nonZero = diffs.filter(d => d !== 0);
  const n = nonZero.length;
  const ranks = avgRanks(nonZero.map(Math.abs));
  const wPlus = nonZero.reduce((acc, d, i) => acc + (d > 0 ? ranks[i] : 0), 0);

  let ge = 0;
  let le = 0;
  const total = Math.pow(2, n);
  for (let mask = 0; mask < total; mask++) {
    let w = 0;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) w += ranks[i];
    }
    if (w >= wPlus) ge++;
    if (w <= wPlus) le++;
  }
  return { wPlus, p: Math.min(1, (2 * Math.min(ge, le)) / total) };
}

// ── 描述统计 ──────────────────────────────────────────────────────────

describe('描述统计', () => {
  it('mean / sd / median', () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(sd([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.13809, 4);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });

  it('边界：空数组', () => {
    expect(Number.isNaN(mean([]))).toBe(true);
    expect(sd([])).toBe(0);
    expect(Number.isNaN(median([]))).toBe(true);
  });
});

// ── Wilcoxon 符号秩 ───────────────────────────────────────────────────

describe('wilcoxonSignedRank（双侧精确）', () => {
  it('全正差值 n=12（无结）：p = 2/2^12，效应量 = 1', () => {
    const r = wilcoxonSignedRank(Array.from({ length: 12 }, () => 1));
    expect(r.n).toBe(12);
    expect(r.exact).toBe(true);
    expect(r.wPlus).toBe(78); // 1+2+…+12
    expect(r.wMinus).toBe(0);
    expect(r.pValue).toBeCloseTo(2 / 4096, 10);
    expect(r.rankBiserial).toBe(1);
  });

  it('全正差值 n=6：p = 2/2^6 = 0.03125', () => {
    const r = wilcoxonSignedRank([1, 2, 3, 4, 5, 6]);
    expect(r.pValue).toBeCloseTo(0.03125, 10);
    expect(r.wPlus).toBe(21);
  });

  it('有结混合案例：与独立暴力枚举完全一致', () => {
    const diffs = [1, -1, 2, -2, 3];
    const r = wilcoxonSignedRank(diffs);
    const brute = bruteForceWilcoxonP(diffs);
    expect(r.wPlus).toBeCloseTo(brute.wPlus, 10);
    expect(r.pValue).toBeCloseTo(brute.p, 10);
    expect(r.exact).toBe(true);
  });

  it('随机案例批量交叉验证（含结、含零）', () => {
    // 固定几组（不依赖随机）：确保覆盖各种符号组合
    const cases: number[][] = [
      [2, 2, 2, -2, -2, -2, 1, 1],
      [3, 0, 1, -1, -3, 2, 2, -2, 0, 1],
      [1, 1, 1, 1, 1, 0, -1],
      [-5, -4, -3, -2, -1],
    ];
    for (const diffs of cases) {
      const r = wilcoxonSignedRank(diffs);
      const brute = bruteForceWilcoxonP(diffs);
      expect(r.pValue).toBeCloseTo(brute.p, 10);
    }
  });

  it('零差值剔除：[1,0,0,1,1] → n=3，p = 2/8 = 0.25', () => {
    const r = wilcoxonSignedRank([1, 0, 0, 1, 1]);
    expect(r.n).toBe(3);
    expect(r.zeros).toBe(2);
    expect(r.pValue).toBeCloseTo(0.25, 10);
  });

  it('全零差值 / 空输入 → p = 1', () => {
    expect(wilcoxonSignedRank([0, 0, 0]).pValue).toBe(1);
    expect(wilcoxonSignedRank([]).pValue).toBe(1);
  });

  it('大样本走正态近似（n=25）且 p 有界', () => {
    const r = wilcoxonSignedRank(Array.from({ length: 25 }, () => 1));
    expect(r.exact).toBe(false);
    expect(r.pValue).toBeGreaterThan(0);
    expect(r.pValue).toBeLessThan(0.01);
  });
});

// ── 符号检验 / McNemar ────────────────────────────────────────────────

describe('signTest（双侧精确）', () => {
  it('10 正 / 12：p = 2×(C12,0+C12,1+C12,2)/2^12 = 158/4096', () => {
    const diffs = [...Array(10).fill(1), -1, -1];
    const r = signTest(diffs);
    expect(r.positives).toBe(10);
    expect(r.negatives).toBe(2);
    expect(r.pValue).toBeCloseTo(158 / 4096, 10);
  });

  it('6 正 / 6：p = 2/64 = 0.03125；零差值剔除', () => {
    const r = signTest([1, 1, 1, 1, 1, 1, 0, 0]);
    expect(r.n).toBe(6);
    expect(r.zeros).toBe(2);
    expect(r.pValue).toBeCloseTo(0.03125, 10);
  });

  it('3 正 3 负（对称）→ p = 1', () => {
    expect(signTest([1, 1, 1, -1, -1, -1]).pValue).toBe(1);
  });
});

describe('mcnemarExact（双侧精确）', () => {
  it('b=6,c=0 → p = 2/64 = 0.03125', () => {
    expect(mcnemarExact(6, 0).pValue).toBeCloseTo(0.03125, 10);
  });

  it('b=5,c=1 → p = 2×(1+6)/64 = 0.21875', () => {
    expect(mcnemarExact(5, 1).pValue).toBeCloseTo(0.21875, 10);
  });

  it('b=c → p = 1；无不一致对 → p = 1', () => {
    expect(mcnemarExact(3, 3).pValue).toBe(1);
    expect(mcnemarExact(0, 0).pValue).toBe(1);
  });

  it('mcnemarFromPairs 正确统计不一致对', () => {
    const r = mcnemarFromPairs([
      { before: 0, after: 1 },
      { before: 0, after: 1 },
      { before: 1, after: 1 }, // 一致，不计
      { before: 0, after: 0 }, // 一致，不计
      { before: 0, after: 1 },
    ]);
    expect(r.b).toBe(3);
    expect(r.c).toBe(0);
    expect(r.pValue).toBeCloseTo(0.25, 10); // 2/8
  });
});

// ── Bootstrap CI ──────────────────────────────────────────────────────

describe('bootstrapMeanCI', () => {
  it('同 seed 结果可复现', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8];
    const a = bootstrapMeanCI(xs, { seed: 42 });
    const b = bootstrapMeanCI(xs, { seed: 42 });
    expect(a).toEqual(b);
  });

  it('恒定数据：CI 收缩到点值', () => {
    const r = bootstrapMeanCI([5, 5, 5, 5]);
    expect(r.estimate).toBe(5);
    expect(r.lower).toBe(5);
    expect(r.upper).toBe(5);
  });

  it('CI 覆盖点估计；空输入返回 NaN', () => {
    const r = bootstrapMeanCI([1, 2, 2, 3, 9]);
    expect(r.lower).toBeLessThanOrEqual(r.estimate);
    expect(r.upper).toBeGreaterThanOrEqual(r.estimate);
    expect(Number.isNaN(bootstrapMeanCI([]).estimate)).toBe(true);
  });
});

// ── Kappa / 汇总 ──────────────────────────────────────────────────────

describe("cohensKappa", () => {
  it('完全一致 → 1', () => {
    expect(cohensKappa([1, 0, 1, 0], [1, 0, 1, 0])).toBe(1);
  });

  it('手算案例：po=0.75, pe=0.5 → κ=0.5', () => {
    expect(cohensKappa([1, 1, 1, 1, 0, 0, 0, 0], [1, 1, 1, 0, 0, 0, 0, 1])).toBeCloseTo(0.5, 10);
  });
});

describe('summarizePaired', () => {
  it('汇总字段自洽（均值差 = 前后均值差）', () => {
    const pairs = [
      { before: 1, after: 4 },
      { before: 2, after: 5 },
      { before: 3, after: 6 },
    ];
    const s = summarizePaired(pairs);
    expect(s.n).toBe(3);
    expect(s.meanBefore).toBe(2);
    expect(s.meanAfter).toBe(5);
    expect(s.meanDiff).toBeCloseTo(s.meanAfter - s.meanBefore, 10);
    expect(s.wilcoxon.pValue).toBeCloseTo(0.25, 10); // 3 个正差值 → 2/8
    expect(s.ci.estimate).toBe(3);
  });
});
