/**
 * 记忆注入消融实验脚本（4 档 × N 故事 × N 段）
 *
 * 用于论文「实验」章节的量化对比。相对旧版 ab_compare.ts 的升级：
 *   1. 从「A/B 两组」升级为「4 档消融」：none / state / graph / both
 *   2. 支持命令行参数：故事数、续写段数、档位，可分批跑
 *   3. 结果落盘成 JSON + Markdown 表格，便于汇总进论文
 *
 * ── 4 档消融 ──────────────────────────────────────────────────────
 *   none   无记忆          MEMORY_MODULES_ENABLED=false
 *   state  仅状态表        MEMORY_KNOWLEDGE_GRAPH=false
 *   graph  仅知识图谱      MEMORY_STATE_TABLE=false
 *   both   状态表+图谱     （全开，默认）
 *
 * ── 量化指标 ──────────────────────────────────────────────────────
 *   ① Prompt 注入增量（字）—— 记忆模块实际注入了多少内容
 *   ② 相邻段重复度（trigram Jaccard）—— **双峰指标，不可单独下结论**
 *      拆成两个量报：退化复读率（相似度>0.9，即整段照抄上一段）+ 非退化中位数
 *      原因与证据见 Docs/ablation/退化复读诊断.md
 *   ③ 角色名提及分布 —— 主要角色是否被稳定使用
 *   ④ 图谱 / 状态表增长量 —— 记忆系统是否真的在工作
 *
 * ── 运行 ──────────────────────────────────────────────────────────
 *   docker compose up -d postgres
 *
 *   # 跑全部 4 档，5 个故事，每档续写 5 段
 *   npx tsx tests/ab_ablation.ts
 *
 *   # 只跑指定档位 / 指定段数
 *   npx tsx tests/ab_ablation.ts --arms=both,state --segments=5 --stories=3
 *
 *   # 只看汇总（复用上次落盘结果，不重新生成）
 *   npx tsx tests/ab_ablation.ts --report-only
 *
 *   # 跨轮汇总（把所有历史结果文件当成独立轮次，输出 ablation_report_rounds.md）
 *   npx tsx tests/ab_ablation.ts --rounds-report
 *
 * DATABASE_URL 会被 tests/test-env.ts 自动改写为宿主机地址，无需手动指定。
 * 结果输出到 Docs/ablation/ 目录（JSON + Markdown）。
 */
import './test-env';
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import prisma from '../src/lib/prisma';
import { buildFullPrompt } from '../src/lib/prompt-builder';
import { knowledgeGraph, type NodeType } from '../src/lib/knowledge-graph';
import { narrativeStateTracker } from '../src/lib/narrative-state-tracker';
import { getOrderedChain } from '../src/lib/chain-helpers';
import { callAIText } from '../src/lib/ai-client';

// ============================================================================
// 消融档位定义
// ============================================================================

type Arm = 'none' | 'state' | 'graph' | 'both';

const ARM_LABELS: Record<Arm, string> = {
  none: '无记忆（基线）',
  state: '仅状态表',
  graph: '仅知识图谱',
  both: '状态表 + 图谱',
};

/** 应用某一档位的环境变量开关（prompt-builder 读取这些变量） */
function applyArm(arm: Arm): void {
  // 先清空，避免上一档残留
  delete process.env.MEMORY_MODULES_ENABLED;
  delete process.env.MEMORY_STATE_TABLE;
  delete process.env.MEMORY_KNOWLEDGE_GRAPH;

  switch (arm) {
    case 'none':
      process.env.MEMORY_MODULES_ENABLED = 'false';
      break;
    case 'state':
      process.env.MEMORY_KNOWLEDGE_GRAPH = 'false';
      break;
    case 'graph':
      process.env.MEMORY_STATE_TABLE = 'false';
      break;
    case 'both':
      // 全开，无需设置
      break;
  }
}

// ============================================================================
// 命令行参数
// ============================================================================

function parseArgs() {
  const argv = process.argv.slice(2);
  const get = (flag: string, def: string): string => {
    const hit = argv.find(a => a.startsWith(`--${flag}=`));
    return hit ? hit.split('=').slice(1).join('=') : def;
  };
  const arms = get('arms', 'none,state,graph,both')
    .split(',')
    .map(s => s.trim())
    .filter((s): s is Arm => ['none', 'state', 'graph', 'both'].includes(s));

  return {
    arms: arms.length > 0 ? arms : (['none', 'state', 'graph', 'both'] as Arm[]),
    stories: parseInt(get('stories', '2'), 10),
    segments: parseInt(get('segments', '3'), 10),
    reportOnly: argv.includes('--report-only'),
    roundsReport: argv.includes('--rounds-report'),
    // 只纳入文件名含指定子串的结果文件（逗号分隔）。
    // 用途：不同轮次可能跑在不同代码版本上，混在一起平均是错的。
    only: get('only', '').split(',').map(s => s.trim()).filter(Boolean),
    outName: get('out', 'ablation_report_rounds.md'),
  };
}

// ============================================================================
// 多轮汇总
// ============================================================================

/**
 * 跨轮汇总。
 *
 * 为什么需要：单轮 n=5 时，一个故事的退化复读事件就能把该档均值抬高约 0.1，
 * 超过档间真实差异（见 Docs/ablation/退化复读诊断.md）。所以必须跑多轮、
 * 并且只拿**非退化中位数**做检验。
 *
 * 两层聚合：
 *   ① 每轮各自汇总一次 → 得到每档「轮均值 ± 轮间标准差」，看稳定性
 *   ② 按故事配对：每个故事先在各轮内取中位数并跨轮平均 → 得到 n=故事数 的
 *      配对样本，再做配对 t 检验。这样配对单位仍然是故事，轮次只用来降噪。
 */
function buildRoundsMarkdown(rounds: RunResult[][], arms: Arm[], files: string[] = []): string {
  const storyTitles = [...new Set(rounds.flat().map(r => r.story))];

  // 每轮每档的汇总量
  const perRound: Record<string, { median: number; degRate: number; degCount: number; n: number }[]> = {};
  for (const arm of arms) perRound[arm] = [];
  for (const round of rounds) {
    for (const arm of arms) {
      const vals = round.filter(r => r.arm === arm).flatMap(r => r.adjacentSim.values);
      if (vals.length === 0) continue;
      const s = splitSimilarity(vals);
      perRound[arm].push({ median: s.restMedian, degRate: s.degenerateRate, degCount: s.degenerateCount, n: s.nPairs });
    }
  }

  // 按故事配对：每个故事跨轮平均后的非退化中位数
  const perStory = (arm: Arm, story: string): number | null => {
    const vals: number[] = [];
    for (const round of rounds) {
      const r = round.find(x => x.story === story && x.arm === arm);
      if (r) vals.push(splitSimilarity(r.adjacentSim.values).restMedian);
    }
    return vals.length === 0 ? null : vals.reduce((a, b) => a + b, 0) / vals.length;
  };
  const storySeries = (arm: Arm): number[] =>
    storyTitles.map(s => perStory(arm, s)).filter((v): v is number => v !== null);

  /**
   * 每个故事的「退化发生率」：该故事该档在多少轮里触发过退化复读。
   *
   * 这是比「非退化中位数」更适合做配对检验的量，原因：每个故事每轮只有
   * (段数-1) 个相邻对。若该故事某一轮触发了一次复读，它的"中位数"就会
   * 从 ~0.03 跳到 ~0.5，于是「跨轮平均的中位数」仍被污染。而发生率是计数，
   * 一次触发只贡献 1/R，不会被单个事件带偏。
   */
  const occRate = (arm: Arm, story: string): number | null => {
    let hit = 0, total = 0;
    for (const round of rounds) {
      const r = round.find(x => x.story === story && x.arm === arm);
      if (!r) continue;
      total++;
      if (splitSimilarity(r.adjacentSim.values).degenerateCount > 0) hit++;
    }
    return total === 0 ? null : hit / total;
  };
  const occSeries = (arm: Arm): number[] =>
    storyTitles.map(s => occRate(arm, s)).filter((v): v is number => v !== null);

  const lines: string[] = [];
  lines.push('# 多轮汇总（跨轮聚合）');
  lines.push('');
  lines.push(`> 数据来源：${rounds.length} 轮独立实验，每轮 ${storyTitles.length} 故事 × ${arms.length} 档。`);
  lines.push('> 各轮结果文件按修改时间排序，全部纳入。');
  if (files.length > 0) {
    lines.push('>');
    lines.push('> 纳入的文件：');
    files.forEach(f => lines.push(`> - \`${f}\``));
  }
  lines.push('');
  lines.push('## 一、每档的轮均值 ± 轮间标准差');
  lines.push('');
  lines.push('| 档位 | 非退化中位数 ↓ | 退化复读率 ↓ | 各轮中位数 |');
  lines.push('|------|------:|------:|------|');
  for (const arm of arms) {
    const rs = perRound[arm];
    if (rs.length === 0) continue;
    const med = stats(rs.map(x => x.median));
    const deg = stats(rs.map(x => x.degRate));
    const detail = rs.map(x => x.median.toFixed(3)).join(' / ');
    lines.push(
      `| \`${arm}\` | ${med.mean.toFixed(3)} ± ${med.std.toFixed(3)} | ` +
      `${deg.mean.toFixed(2)} ± ${deg.std.toFixed(2)} | ${detail} |`,
    );
  }
  lines.push('');
  lines.push('> **轮间标准差**这一列是关键：如果它和档间差同量级，说明这个样本量还测不出差异。');
  lines.push('');

  lines.push('## 二、主指标：退化复读发生率（按故事配对检验）');
  lines.push('');
  lines.push('**每个故事**在该档下、有多少比例的轮次触发过退化复读。次数为计数，');
  lines.push('不会被单个 1.00 事件带偏，因此比「跨轮平均中位数」更适合做配对检验。');
  lines.push('');
  const occBase = occSeries('none');
  if (occBase.length >= 2) {
    lines.push(`配对单位：故事（n=${occBase.length}），每档相对 \`none\` 基线。`);
    lines.push('');
    lines.push('| 档位 | 发生率均值 | 相对基线 | 平均差值 | t 值 | df | 显著 (p<0.05) |');
    lines.push('|------|------:|------:|------:|------:|------:|:---:|');
    for (const arm of arms) {
      const s = occSeries(arm);
      if (s.length < 2) continue;
      const m = stats(s);
      if (arm === 'none') {
        lines.push(`| \`${arm}\`（基线） | ${(m.mean * 100).toFixed(0)}% | — | — | — | — | — |`);
        continue;
      }
      const test = pairedTTest(occBase, s);
      const diff = m.mean - stats(occBase).mean;
      const rel = stats(occBase).mean === 0 ? '—' : `${((diff / stats(occBase).mean) * 100).toFixed(0)}%`;
      lines.push(
        `| \`${arm}\` | ${(m.mean * 100).toFixed(0)}% | ${rel} | ${diff >= 0 ? '+' : ''}${diff.toFixed(3)} | ` +
        `${test.t.toFixed(2)} | ${test.df} | ${test.significant ? '✅ 是' : '❌ 否'} |`,
      );
    }
  } else {
    lines.push('（故事数不足，无法配对检验）');
  }
  lines.push('');
  lines.push(`> ⚠️ 配对单位是**故事**（当前 n=${storyTitles.length}），轮次只用来降噪，不增加样本量。`);
  lines.push('> 要提升统计效力必须**增加故事数**，不是增加轮数。');
  lines.push('');

  // ── 两两比较（回答 RQ2：模块各自贡献 / RQ3：叠加是否更优）──
  lines.push('### 二-1、两两配对比较（退化发生率）');
  lines.push('');
  lines.push('每一格是「行档位 − 列档位」的配对 t 检验。负数 = 行档位触发更少（更好）。');
  lines.push('');
  lines.push(`| 行 vs 列 | ${arms.map(a => `\`${a}\``).join(' | ')} |`);
  lines.push(`|------|${arms.map(() => '------:').join('|')}|`);
  // 顺带统计本表有几格达到显著 —— 注释里写死临界值会让表格和结论自相矛盾
  let nSig = 0, maxAbsT = 0, critUsed = Infinity; let dfUsed = 0;
  for (const ra of arms) {
    const sa = occSeries(ra);
    if (sa.length < 2) continue;
    const cells = arms.map(ca => {
      if (ra === ca) return '—';
      const sc = occSeries(ca);
      if (sc.length < 2) return '—';
      const t = pairedTTest(sc, sa);
      dfUsed = t.df; critUsed = t.critical;
      if (t.significant) nSig++;
      if (Math.abs(t.t) > maxAbsT) maxAbsT = Math.abs(t.t);
      const d = stats(sa).mean - stats(sc).mean;
      return `${d >= 0 ? '+' : ''}${(d * 100).toFixed(0)}pp (t=${t.t.toFixed(2)})`;
    });
    lines.push(`| \`${ra}\` | ${cells.join(' | ')} |`);
  }
  lines.push('');
  lines.push(`> \`pp\` = 百分点。配对单位是故事，df=${dfUsed} 的双尾临界值是 **${critUsed.toFixed(3)}**。`);
  if (nSig === 0) {
    lines.push(`> 本表最大 |t| = ${maxAbsT.toFixed(2)}，**两两差异均未达显著**；但方向是否一致，看下一节。`);
  } else {
    // 每对档位在表里出现两次（行列各一次），|t| 相同，所以除以 2
    lines.push(`> 本表最大 |t| = ${maxAbsT.toFixed(2)}，**有 ${nSig / 2} 对档位达到显著**（含正负两向）。`);
  }
  lines.push('');

  // ── 逐故事支配关系：both 是否在任何故事上都劣于 state ──
  const dominance = (better: Arm, worse: Arm) => {
    let win = 0, tie = 0, lose = 0;
    for (const s of storyTitles) {
      const a = occRate(better, s), b = occRate(worse, s);
      if (a === null || b === null) continue;
      if (a < b) win++; else if (a === b) tie++; else lose++;
    }
    return { win, tie, lose };
  };
  lines.push('### 二-2、逐故事支配关系（关键：`both` 有没有在任何故事上劣于 `state`）');
  lines.push('');
  lines.push('| 对比 | 更优 | 打平 | 更差 | 结论 |');
  lines.push('|------|:---:|:---:|:---:|------|');
  for (const [a, b] of [['both', 'state'], ['both', 'graph'], ['both', 'none'], ['state', 'none'], ['graph', 'none'], ['state', 'graph']] as [Arm, Arm][]) {
    const d = dominance(a, b);
    const verdict = d.lose === 0 && d.win > 0
      ? `✅ \`${a}\` 在全部 ${d.win + d.tie} 个故事上不劣于 \`${b}\``
      : d.lose === 0
        ? `➖ 完全相同`
        : `⚠️ \`${a}\` 在 ${d.lose} 个故事上劣于 \`${b}\``;
    lines.push(`| \`${a}\` vs \`${b}\` | ${d.win} | ${d.tie} | ${d.lose} | ${verdict} |`);
  }
  lines.push('');

  lines.push('## 三、辅助指标：非退化中位数');
  lines.push('');
  lines.push('> ⚠️ 这一节的「跨轮平均中位数」仍可能被污染：每个故事每轮只有 (段数-1) 个相邻对，');
  lines.push('> 某一轮触发一次复读就足以把该故事的"中位数"从 ~0.03 抬到 ~0.5。');
  lines.push('> 所以第四节明细里出现的 0.1x–0.2x 数值不代表该档更"套路化"。**判断档位优劣请看第二节。**');
  lines.push('');
  const base = storySeries('none');
  if (base.length >= 2) {
    lines.push('| 档位 | 均值 | 平均差值 | t 值 | df | 显著 (p<0.05) |');
    lines.push('|------|------:|------:|------:|------:|:---:|');
    for (const arm of arms) {
      const s = storySeries(arm);
      if (s.length < 2) continue;
      const m = stats(s);
      if (arm === 'none') {
        lines.push(`| \`${arm}\`（基线） | ${m.mean.toFixed(3)} | — | — | — | — |`);
        continue;
      }
      const test = pairedTTest(base, s);
      const diff = m.mean - stats(base).mean;
      lines.push(
        `| \`${arm}\` | ${m.mean.toFixed(3)} | ${diff >= 0 ? '+' : ''}${diff.toFixed(3)} | ` +
        `${test.t.toFixed(2)} | ${test.df} | ${test.significant ? '✅ 是' : '❌ 否'} |`,
      );
    }
  } else {
    lines.push('（故事数不足，无法配对检验）');
  }
  lines.push('');
  lines.push('## 四、逐故事明细');
  lines.push('');
  lines.push(`| 故事 | ${arms.map(a => `\`${a}\``).join(' | ')} |`);
  lines.push(`|------|${arms.map(() => '------:').join('|')}|`);
  for (const s of storyTitles) {
    lines.push(`| ${s} | ${arms.map(a => { const v = perStory(a, s); return v === null ? '—' : v.toFixed(3); }).join(' | ')} |`);
  }
  lines.push('');
  lines.push('（上表为非退化中位数，跨轮平均；受污染问题见第三节说明）');
  lines.push('');
  lines.push(`### 退化发生率逐故事（各档触发过的轮次占比）`);
  lines.push('');
  lines.push(`| 故事 | ${arms.map(a => `\`${a}\``).join(' | ')} |`);
  lines.push(`|------|${arms.map(() => '------:').join('|')}|`);
  for (const s of storyTitles) {
    lines.push(`| ${s} | ${arms.map(a => { const v = occRate(a, s); return v === null ? '—' : `${(v * 100).toFixed(0)}%`; }).join(' | ')} |`);
  }
  lines.push('');
  return lines.join('\n');
}

// ============================================================================
// 量化指标工具
// ============================================================================

/** 字符 trigram Jaccard 相似度（0=完全不同，1=完全一样） */
export function trigramSimilarity(a: string, b: string): number {
  const getTri = (s: string) => {
    const set = new Set<string>();
    const clean = s.replace(/[\s。，！？；：""''《》【】\n]/g, '');
    for (let i = 0; i < clean.length - 2; i++) set.add(clean.slice(i, i + 3));
    return set;
  };
  const ta = getTri(a), tb = getTri(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** 相邻段平均相似度（越高=情节越重复/套模板） */
export function avgAdjacentSimilarity(segments: string[]): { values: number[]; avg: number } {
  const values: number[] = [];
  for (let i = 1; i < segments.length; i++) {
    values.push(trigramSimilarity(segments[i - 1], segments[i]));
  }
  const avg = values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length;
  return { values, avg };
}

/**
 * 退化复读阈值。超过这个相似度基本可以断定模型在**照抄上一段**，
 * 而不是"情节套路化"——实测这些相邻对的正文是逐字节相同的。
 */
export const DEGENERATE_THRESHOLD = 0.9;

/**
 * 把相邻段重复度拆成两个互相独立的量。
 *
 * 原因：该指标是**双峰**的。绝大多数相邻对落在 0.01–0.15（正常续写），
 * 但偶尔模型会整段照抄上一段 → 1.00。一旦触发，模型会连续照抄（照抄
 * 产生的文本又成了下一段的"上文"），于是一个触发点会一次性贡献 2 个
 * 以上的 1.00，把该故事的均值从 ~0.05 直接抬到 ~0.5。
 *
 * 结果是均值被这几个稀疏事件完全支配，测量的是"这次有没有抽到复读"
 * 而不是"这一档的记忆注入好不好"。所以必须拆开报：
 *   - degenerateRate：退化复读率（越小越好，反映稳定性）
 *   - restMedian：剔除退化对之后的**中位数**（反映正常的段间相似度）
 *
 * 阈值与结论见 Docs/ablation/退化复读诊断.md。
 */
export function splitSimilarity(values: number[]): {
  nPairs: number; degenerateCount: number; degenerateRate: number;
  restMedian: number; restMean: number;
} {
  const degenerate = values.filter(v => v > DEGENERATE_THRESHOLD);
  const rest = values.filter(v => v <= DEGENERATE_THRESHOLD).sort((a, b) => a - b);
  const median = rest.length === 0
    ? 0
    : rest.length % 2 === 1
      ? rest[(rest.length - 1) / 2]
      : (rest[rest.length / 2 - 1] + rest[rest.length / 2]) / 2;
  return {
    nPairs: values.length,
    degenerateCount: degenerate.length,
    degenerateRate: values.length === 0 ? 0 : degenerate.length / values.length,
    restMedian: median,
    restMean: rest.length === 0 ? 0 : rest.reduce((s, v) => s + v, 0) / rest.length,
  };
}

/** 已知角色名在文本中的出现次数 */
export function countCharacterMentions(text: string, names: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const n of names) {
    out[n] = (text.match(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
  }
  return out;
}

/**
 * 角色出现覆盖率：有多少个角色在整组续写中被提到了至少一次。
 * 越高说明故事没有"丢掉某个角色"。
 */
export function characterCoverage(segments: string[], names: string[]): number {
  if (names.length === 0) return 0;
  const joined = segments.join('\n');
  const mentioned = names.filter(n => (joined.match(new RegExp(n, 'g')) || []).length > 0);
  return mentioned.length / names.length;
}

/** 基础统计量：均值 / 样本标准差 / 最小值 / 最大值（n-1 自由度） */
export function stats(values: number[]): {
  mean: number; std: number; min: number; max: number; n: number;
} {
  const n = values.length;
  if (n === 0) return { mean: 0, std: 0, min: 0, max: 0, n: 0 };
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const variance = n > 1
    ? values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)
    : 0;
  return {
    mean,
    std: Math.sqrt(variance),
    min: Math.min(...values),
    max: Math.max(...values),
    n,
  };
}

/**
/**
 * 双尾 p<0.05 的 t 临界值，按自由度查表（中间自由度线性插值）。
 *
 * 早先是一个三元表达式 `n===5 ? 2.776 : n===4 ? 3.182 : 2.0` ——
 * **n>5 一律返回 2.0，是错的**。扩样到 15 个故事（df=14，真值 2.145）时，
 * 它会给出过于宽松的判据，把 t=2.05 这种本该不显著的判成显著。
 * 同时报告的注释里还写死了"df=4 临界值 2.776"，于是出现**表格判显著、
 * 注释说不显著**的自相矛盾。判据这种东西必须按自由度算，不能写死。
 */
const T_CRITICAL_05: Array<[number, number]> = [
  [1, 12.706], [2, 4.303], [3, 3.182], [4, 2.776], [5, 2.571],
  [6, 2.447], [7, 2.365], [8, 2.306], [9, 2.262], [10, 2.228],
  [11, 2.201], [12, 2.179], [13, 2.160], [14, 2.145], [15, 2.131],
  [16, 2.120], [17, 2.110], [18, 2.101], [19, 2.093], [20, 2.086],
  [22, 2.074], [24, 2.064], [26, 2.056], [28, 2.048], [30, 2.042],
  [40, 2.021], [50, 2.009], [60, 2.000], [80, 1.990], [100, 1.984],
  [1e9, 1.960],
];

export function tCritical05(df: number): number {
  if (df <= 0) return Infinity;
  for (let i = 0; i < T_CRITICAL_05.length; i++) {
    const [d, v] = T_CRITICAL_05[i];
    if (df === d) return v;
    if (df < d) {
      const [d0, v0] = T_CRITICAL_05[i - 1];
      return v0 + (v - v0) * ((df - d0) / (d - d0));  // 线性插值
    }
  }
  return 1.960;
}

/**
 * 配对样本 t 检验（对比某档位与基线）。
 * 显著性按自由度查表判定（见 tCritical05）。样本量小时结论只作参考。
 */
export function pairedTTest(baseline: number[], treatment: number[]): {
  t: number; df: number; critical: number; significant: boolean;
} {
  const n = Math.min(baseline.length, treatment.length);
  if (n < 2) return { t: 0, df: 0, critical: Infinity, significant: false };

  const diffs = Array.from({ length: n }, (_, i) => treatment[i] - baseline[i]);
  const dMean = diffs.reduce((s, v) => s + v, 0) / n;
  const dStd = Math.sqrt(
    diffs.reduce((s, v) => s + (v - dMean) ** 2, 0) / (n - 1),
  );
  const df = n - 1;
  const critical = tCritical05(df);
  if (dStd === 0) return { t: 0, df, critical, significant: false };

  const t = dMean / (dStd / Math.sqrt(n));
  return { t, df, critical, significant: Math.abs(t) > critical };
}

// ============================================================================
// 测试故事定义
// ============================================================================

type StoryDef = {
  title: string;
  description: string;
  genre: string;
  opener: string;
  characters: Array<{ name: string; era: string; role: string; traits: string[] }>;
  graphEdges: Array<{ from: string; to: string; type: 'ally_of' | 'conflicts_with' | 'involves' | 'belongs_to' | 'located_at' }>;
  states: Array<Record<string, any>>;
};

const ALL_STORY_DEFS: StoryDef[] = [
  {
    title: '桃园结义',
    description: '东汉末年，刘备、关羽、张飞在桃园结为兄弟，共谋兴复汉室。董卓祸乱朝纲，洛阳危在旦夕。',
    genre: '三国',
    opener: '东汉末年，天下大乱。刘备、关羽、张飞三人志向相投，于桃园中歃血为盟，结为异姓兄弟，誓同生死，共图兴复汉室。而此时洛阳城中，董卓把持朝政，横行无忌。',
    characters: [
      { name: '刘备', era: '东汉末年', role: 'protagonist', traits: ['仁义', '沉稳', '坚韧'] },
      { name: '关羽', era: '东汉末年', role: 'protagonist', traits: ['忠义', '勇猛', '高傲'] },
      { name: '张飞', era: '东汉末年', role: 'supporting', traits: ['勇猛', '急躁', '忠诚'] },
      { name: '董卓', era: '东汉末年', role: 'antagonist', traits: ['残暴', '贪婪', '专横'] },
    ],
    graphEdges: [
      { from: '刘备', to: '关羽', type: 'ally_of' },
      { from: '刘备', to: '张飞', type: 'ally_of' },
      { from: '关羽', to: '张飞', type: 'ally_of' },
      { from: '洛阳', to: '董卓', type: 'conflicts_with' },
      { from: '刘备', to: '桃园结义', type: 'involves' },
    ],
    states: [
      { id: 's_liu', type: 'character', name: '刘备', properties: { isAlive: 'true', location: '桃园', status: '义军首领', mood: '坚定', faction: '汉室', goal: '兴复汉室' } },
      { id: 's_guan', type: 'character', name: '关羽', properties: { isAlive: 'true', location: '桃园', status: '义军将领', mood: '忠义', faction: '汉室' } },
      { id: 's_zhang', type: 'character', name: '张飞', properties: { isAlive: 'true', location: '桃园', status: '义军将领', mood: '激昂', faction: '汉室' } },
      { id: 's_dong', type: 'character', name: '董卓', properties: { isAlive: 'true', location: '洛阳', status: '把持朝政', mood: '专横', faction: '董卓势力', goal: '独揽大权' } },
      { id: 's_luoyang', type: 'location', name: '洛阳', properties: { status: '被董卓控制', controller: '董卓' } },
      { id: 's_rel_lg', type: 'relationship', name: '刘备-关羽', properties: { between: '刘备-关羽', type: '兄弟', status: '正常', strength: '100' } },
      { id: 's_rel_lz', type: 'relationship', name: '刘备-张飞', properties: { between: '刘备-张飞', type: '兄弟', status: '正常', strength: '100' } },
    ],
  },
  {
    title: '张骞出使西域',
    description: '西汉建元三年，汉武帝派张骞出使西域，联络大月氏共同夹击匈奴。张骞率百余人出陇西，途中被匈奴扣留。',
    genre: '历史',
    opener: '建元三年，汉武帝下诏，命张骞为使臣，率百余人出陇西，西行联络大月氏，相约夹击匈奴。张骞领命辞行，武帝亲自送于未央宫前，嘱其"通西域，断匈奴右臂"。张骞奉节仗节，决然西行。',
    characters: [
      { name: '张骞', era: '西汉', role: 'protagonist', traits: ['坚毅', '忠诚', '勇敢'] },
      { name: '汉武帝', era: '西汉', role: 'protagonist', traits: ['雄才大略', '威严', '多疑'] },
      { name: '匈奴单于', era: '西汉', role: 'antagonist', traits: ['残暴', '狡诈', '强横'] },
    ],
    graphEdges: [
      { from: '张骞', to: '汉武帝', type: 'belongs_to' },
      { from: '张骞', to: '匈奴单于', type: 'conflicts_with' },
      { from: '张骞', to: '出使西域', type: 'involves' },
      { from: '长安', to: '汉武帝', type: 'located_at' },
    ],
    states: [
      { id: 's_zhq', type: 'character', name: '张骞', properties: { isAlive: 'true', location: '陇西', status: '使臣', mood: '决然', faction: '汉朝', goal: '联络大月氏' } },
      { id: 's_hanwu', type: 'character', name: '汉武帝', properties: { isAlive: 'true', location: '长安', status: '天子', mood: '期许', faction: '汉朝', goal: '断匈奴右臂' } },
      { id: 's_shanyu', type: 'character', name: '匈奴单于', properties: { isAlive: 'true', location: '匈奴王庭', status: '单于', mood: '强横', faction: '匈奴', goal: '控制西域' } },
      { id: 's_changan', type: 'location', name: '长安', properties: { status: '汉朝都城', controller: '汉武帝' } },
      { id: 's_rel_zhq_hanwu', type: 'relationship', name: '张骞-汉武帝', properties: { between: '张骞-汉武帝', type: '君臣', status: '正常', strength: '90' } },
      { id: 's_rel_zhq_shanyu', type: 'relationship', name: '张骞-匈奴单于', properties: { between: '张骞-匈奴单于', type: '敌对', status: '对峙' } },
    ],
  },
  {
    title: '荆轲刺秦',
    description: '战国末期，燕国太子丹派遣荆轲刺杀秦王嬴政。荆轲携樊於期首级与督亢地图入秦，图穷匕见。',
    genre: '历史',
    opener: '战国末年，秦军压境，燕国危如累卵。燕太子丹谋刺秦王，得荆轲为使者。荆轲携樊於期首级与督亢地图，与秦舞阳一同西入咸阳。易水送别，高渐离击筑，荆轲和而歌："风萧萧兮易水寒，壮士一去兮不复还。"',
    characters: [
      { name: '荆轲', era: '战国末期', role: 'protagonist', traits: ['勇敢', '侠义', '深沉', '重诺轻死'] },
      { name: '秦王嬴政', era: '战国末期', role: 'antagonist', traits: ['雄才大略', '多疑', '威严', '冷酷'] },
      { name: '燕太子丹', era: '战国末期', role: 'supporting', traits: ['忧国忧民', '重情义', '急躁'] },
    ],
    graphEdges: [
      { from: '燕太子丹', to: '荆轲', type: 'belongs_to' },
      { from: '荆轲', to: '秦王嬴政', type: 'conflicts_with' },
      { from: '荆轲', to: '刺秦', type: 'involves' },
      { from: '咸阳', to: '秦王嬴政', type: 'located_at' },
    ],
    states: [
      { id: 's_jk', type: 'character', name: '荆轲', properties: { isAlive: 'true', location: '易水', status: '刺客', mood: '决绝', faction: '燕国', goal: '刺杀秦王' } },
      { id: 's_qw', type: 'character', name: '秦王嬴政', properties: { isAlive: 'true', location: '咸阳', status: '秦王', mood: '威严', faction: '秦国', goal: '一统天下' } },
      { id: 's_taizi', type: 'character', name: '燕太子丹', properties: { isAlive: 'true', location: '蓟城', status: '太子', mood: '焦虑', faction: '燕国', goal: '保全燕国' } },
      { id: 's_xianyang', type: 'location', name: '咸阳', properties: { status: '秦国都城', controller: '秦王嬴政' } },
      { id: 's_rel_jk_taizi', type: 'relationship', name: '荆轲-燕太子丹', properties: { between: '荆轲-燕太子丹', type: '君臣', status: '正常', strength: '85' } },
      { id: 's_rel_jk_qw', type: 'relationship', name: '荆轲-秦王嬴政', properties: { between: '荆轲-秦王嬴政', type: '敌对', status: '对峙' } },
    ],
  },
  {
    title: '赤壁之战',
    description: '东汉建安十三年，曹操南下荆州，孙刘联军于赤壁以火攻大破曹军，奠定三国鼎立之势。',
    genre: '三国',
    opener: '建安十三年秋，曹操率大军南下，荆州刘琮望风而降。刘备败走夏口，与孙权结盟。周瑜、程普为左右都督，率水军三万，与曹军隔江对峙于赤壁。江上大雾弥漫，一场决定天下大势的决战即将展开。',
    characters: [
      { name: '周瑜', era: '东汉末年', role: 'protagonist', traits: ['儒雅', '果决', '善谋'] },
      { name: '曹操', era: '东汉末年', role: 'antagonist', traits: ['雄才大略', '多疑', '骄矜'] },
      { name: '诸葛亮', era: '东汉末年', role: 'supporting', traits: ['睿智', '沉稳', '善辩'] },
      { name: '黄盖', era: '东汉末年', role: 'supporting', traits: ['忠勇', '老练'] },
    ],
    graphEdges: [
      { from: '周瑜', to: '诸葛亮', type: 'ally_of' },
      { from: '周瑜', to: '曹操', type: 'conflicts_with' },
      { from: '黄盖', to: '周瑜', type: 'belongs_to' },
      { from: '赤壁', to: '曹操', type: 'conflicts_with' },
      { from: '黄盖', to: '火攻', type: 'involves' },
    ],
    states: [
      { id: 's_zhou', type: 'character', name: '周瑜', properties: { isAlive: 'true', location: '赤壁', status: '左都督', mood: '沉稳', faction: '江东', goal: '击退曹军' } },
      { id: 's_cao', type: 'character', name: '曹操', properties: { isAlive: 'true', location: '乌林', status: '丞相', mood: '骄矜', faction: '曹魏', goal: '一统江南' } },
      { id: 's_zgl', type: 'character', name: '诸葛亮', properties: { isAlive: 'true', location: '赤壁', status: '军师', mood: '从容', faction: '刘备军', goal: '促成孙刘联盟' } },
      { id: 's_huanggai', type: 'character', name: '黄盖', properties: { isAlive: 'true', location: '赤壁', status: '老将', mood: '刚烈', faction: '江东', goal: '火攻破曹' } },
      { id: 's_chibi', type: 'location', name: '赤壁', properties: { status: '孙刘联军驻地', controller: '周瑜' } },
      { id: 's_rel_zhou_zgl', type: 'relationship', name: '周瑜-诸葛亮', properties: { between: '周瑜-诸葛亮', type: '同盟', status: '正常', strength: '70' } },
      { id: 's_rel_zhou_cao', type: 'relationship', name: '周瑜-曹操', properties: { between: '周瑜-曹操', type: '敌对', status: '对峙' } },
    ],
  },
  {
    title: '郭子仪单骑退敌',
    description: '唐代宗年间，回纥、吐蕃联兵入寇，郭子仪单骑赴回纥营，以威信劝退联军，解长安之危。',
    genre: '历史',
    opener: '唐代宗永泰元年，吐蕃与回纥合兵数十万入寇，直逼长安。郭子仪奉命御敌，时兵力寡弱。回纥人素闻郭令公威名，郭子仪乃免胄释甲，单骑赴回纥营中，晓以利害。回纥诸酋大惊，下马罗拜。',
    characters: [
      { name: '郭子仪', era: '唐代', role: 'protagonist', traits: ['沉稳', '胆略过人', '威望素著'] },
      { name: '回纥可汗', era: '唐代', role: 'supporting', traits: ['骁勇', '重信义', '务实'] },
      { name: '吐蕃赞普', era: '唐代', role: 'antagonist', traits: ['贪婪', '强横', '善变'] },
    ],
    graphEdges: [
      { from: '郭子仪', to: '回纥可汗', type: 'ally_of' },
      { from: '郭子仪', to: '吐蕃赞普', type: 'conflicts_with' },
      { from: '回纥可汗', to: '吐蕃赞普', type: 'ally_of' },
      { from: '郭子仪', to: '单骑退敌', type: 'involves' },
      { from: '长安', to: '郭子仪', type: 'located_at' },
    ],
    states: [
      { id: 's_gzy', type: 'character', name: '郭子仪', properties: { isAlive: 'true', location: '长安', status: '副元帅', mood: '沉着', faction: '唐朝', goal: '退敌保长安' } },
      { id: 's_huihe', type: 'character', name: '回纥可汗', properties: { isAlive: 'true', location: '泾阳', status: '可汗', mood: '犹疑', faction: '回纥', goal: '劫掠中原' } },
      { id: 's_tubo', type: 'character', name: '吐蕃赞普', properties: { isAlive: 'true', location: '泾阳', status: '赞普', mood: '强横', faction: '吐蕃', goal: '攻取长安' } },
      { id: 's_rel_gzy_huihe', type: 'relationship', name: '郭子仪-回纥可汗', properties: { between: '郭子仪-回纥可汗', type: '旧交', status: '正常', strength: '75' } },
      { id: 's_rel_gzy_tubo', type: 'relationship', name: '郭子仪-吐蕃赞普', properties: { between: '郭子仪-吐蕃赞普', type: '敌对', status: '对峙' } },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────
  // 以下 10 个为扩样补充（2026-09-14）。
  //
  // 补充的目的不是"凑够 15 个"，而是**让故事在「可推进性」上有分布**：
  // 4 轮数据显示退化复读的触发倾向是故事级的（荆轲刺秦 100%、桃园结义 25%），
  // 而荆轲刺秦的 opener 停在"壮士一去兮不复还"——**终局已定，模型没有可推进的
  // 目标，只能复述上文**。若新故事全停在"待决"处，样本仍然有偏，扩样就白扩了。
  //
  // 因此下面刻意混了两类，并在注释里标出：
  //   【待决】opener 停在一个尚未做出的决定上 —— 可推进
  //   【终结】opener 停在一个已经落定的结局上 —— 容易触发复读
  // 跑完后应能检验"复读倾向 ∝ 结局已定"这个假设（论文 §2.2 提到但未验证）。
  // ──────────────────────────────────────────────────────────────────────
  {
    // 【待决】蔺相如刚拿到璧，还没见秦王
    title: '完璧归赵',
    description: '战国时赵惠文王得楚和氏璧，秦昭王愿以十五城易之。蔺相如奉命持璧入秦。',
    genre: '历史',
    opener: '战国之世，赵惠文王得楚人卞和之璧，秦昭王闻之，愿以十五城相易。赵王恐秦之诈，又惧其强，进退两难。宦者令缪贤荐其舍人蔺相如，赵王召而问之。相如曰："臣愿奉璧往使，城入赵而璧留秦；城不入，臣请完璧归赵。"赵王许之，相如遂奉璧西入咸阳。',
    characters: [
      { name: '蔺相如', era: '战国', role: 'protagonist', traits: ['机智', '勇敢', '有谋略'] },
      { name: '秦昭王', era: '战国', role: 'antagonist', traits: ['强横', '贪婪', '多变'] },
      { name: '赵惠文王', era: '战国', role: 'supporting', traits: ['谨慎', '怯懦', '纳谏'] },
    ],
    graphEdges: [
      { from: '蔺相如', to: '赵惠文王', type: 'belongs_to' },
      { from: '蔺相如', to: '秦昭王', type: 'conflicts_with' },
      { from: '蔺相如', to: '完璧归赵', type: 'involves' },
      { from: '咸阳', to: '秦昭王', type: 'located_at' },
    ],
    states: [
      { id: 's_lxr', type: 'character', name: '蔺相如', properties: { isAlive: 'true', location: '咸阳', status: '赵国使者', mood: '沉着', faction: '赵国', goal: '完璧归赵' } },
      { id: 's_qzw', type: 'character', name: '秦昭王', properties: { isAlive: 'true', location: '咸阳', status: '秦王', mood: '倨傲', faction: '秦国', goal: '骗取和氏璧' } },
      { id: 's_zxw', type: 'character', name: '赵惠文王', properties: { isAlive: 'true', location: '邯郸', status: '赵王', mood: '忧惧', faction: '赵国', goal: '保全和氏璧' } },
      { id: 's_rel_lxr_qzw', type: 'relationship', name: '蔺相如-秦昭王', properties: { between: '蔺相如-秦昭王', type: '敌对', status: '周旋' } },
    ],
  },
  {
    // 【待决】刘邦尚未赴宴
    title: '鸿门宴',
    description: '秦末，项羽驻军鸿门，欲击刘邦。刘邦亲赴鸿门谢罪，范增谋设宴杀之。',
    genre: '历史',
    opener: '秦末，沛公刘邦先入关中，项羽大怒，驻军鸿门，欲以四十万之众击之。刘邦兵仅十万，形势危殆。项羽季父项伯夜驰至刘邦军中，私见张良，欲携之俱去。张良以告刘邦，刘邦大惊，问计于张良。张良曰："请往谓项伯，言沛公不敢背项王也。"刘邦徘徊良久，终于决定明日亲赴鸿门。',
    characters: [
      { name: '刘邦', era: '秦末', role: 'protagonist', traits: ['隐忍', '善用人', '机变'] },
      { name: '项羽', era: '秦末', role: 'antagonist', traits: ['勇猛', '刚愎', '优柔'] },
      { name: '范增', era: '秦末', role: 'antagonist', traits: ['老谋深算', '果决'] },
      { name: '樊哙', era: '秦末', role: 'supporting', traits: ['勇猛', '忠直'] },
    ],
    graphEdges: [
      { from: '刘邦', to: '项羽', type: 'conflicts_with' },
      { from: '范增', to: '项羽', type: 'belongs_to' },
      { from: '樊哙', to: '刘邦', type: 'belongs_to' },
      { from: '刘邦', to: '鸿门宴', type: 'involves' },
      { from: '鸿门', to: '项羽', type: 'located_at' },
    ],
    states: [
      { id: 's_lb', type: 'character', name: '刘邦', properties: { isAlive: 'true', location: '霸上', status: '沛公', mood: '不安', faction: '汉军', goal: '化解项羽之怒' } },
      { id: 's_xy', type: 'character', name: '项羽', properties: { isAlive: 'true', location: '鸿门', status: '西楚霸王', mood: '震怒', faction: '楚军', goal: '问罪刘邦' } },
      { id: 's_fz', type: 'character', name: '范增', properties: { isAlive: 'true', location: '鸿门', status: '亚父', mood: '决绝', faction: '楚军', goal: '除掉刘邦' } },
      { id: 's_fk', type: 'character', name: '樊哙', properties: { isAlive: 'true', location: '霸上', status: '参乘', mood: '激愤', faction: '汉军', goal: '护卫刘邦' } },
      { id: 's_rel_lb_xy', type: 'relationship', name: '刘邦-项羽', properties: { between: '刘邦-项羽', type: '敌对', status: '剑拔弩张' } },
    ],
  },
  {
    // 【待决】勾践刚回国，尚未起步
    title: '卧薪尝胆',
    description: '春秋末年，越王勾践为吴所败，忍辱事吴三年后获释归国，立志复仇。',
    genre: '历史',
    opener: '春秋末年，吴王夫差大败越军于夫椒，越王勾践率残兵五千退保会稽。大夫文种、范蠡献策，勾践乃卑辞厚礼以求和，亲入吴宫为奴三年。夫差病，勾践尝其溲以取信，夫差感其忠，终释之归国。勾践返越之日，见宗庙残破、田野荒芜，立于会稽山下，久久不发一言。',
    characters: [
      { name: '勾践', era: '春秋', role: 'protagonist', traits: ['隐忍', '坚毅', '多疑'] },
      { name: '夫差', era: '春秋', role: 'antagonist', traits: ['骄矜', '好大喜功', '轻信'] },
      { name: '范蠡', era: '春秋', role: 'supporting', traits: ['睿智', '通达', '知进退'] },
      { name: '文种', era: '春秋', role: 'supporting', traits: ['忠诚', '善谋', '执着'] },
    ],
    graphEdges: [
      { from: '勾践', to: '夫差', type: 'conflicts_with' },
      { from: '范蠡', to: '勾践', type: 'belongs_to' },
      { from: '文种', to: '勾践', type: 'belongs_to' },
      { from: '勾践', to: '卧薪尝胆', type: 'involves' },
      { from: '会稽', to: '勾践', type: 'located_at' },
    ],
    states: [
      { id: 's_gj', type: 'character', name: '勾践', properties: { isAlive: 'true', location: '会稽', status: '越王', mood: '隐忍', faction: '越国', goal: '复仇灭吴' } },
      { id: 's_fc', type: 'character', name: '夫差', properties: { isAlive: 'true', location: '姑苏', status: '吴王', mood: '骄矜', faction: '吴国', goal: '称霸中原' } },
      { id: 's_fl', type: 'character', name: '范蠡', properties: { isAlive: 'true', location: '会稽', status: '上将军', mood: '沉稳', faction: '越国', goal: '辅佐勾践复国' } },
      { id: 's_wz', type: 'character', name: '文种', properties: { isAlive: 'true', location: '会稽', status: '大夫', mood: '坚定', faction: '越国', goal: '整顿国政' } },
      { id: 's_rel_gj_fc', type: 'relationship', name: '勾践-夫差', properties: { between: '勾践-夫差', type: '敌对', status: '臣服' } },
    ],
  },
  {
    // 【待决】刘备三顾未果，还在犹豫要不要再去
    title: '三顾茅庐',
    description: '东汉末年，刘备屯兵新野，三次前往隆中拜访诸葛亮，请其出山。',
    genre: '三国',
    opener: '东汉建安十二年，刘备屯兵新野，兵微将寡，寄人篱下。徐庶临去，荐南阳诸葛亮，称其为"卧龙"。刘备遂与关羽、张飞往隆中拜访。一顾不遇，二顾只见其弟诸葛均，冒雪而返。张飞怒曰："量一村夫，何必哥哥自去！"刘备叱之。归途中，刘备勒马回望隆中山色，沉吟不决。',
    characters: [
      { name: '刘备', era: '东汉末年', role: 'protagonist', traits: ['仁厚', '坚韧', '礼贤下士'] },
      { name: '诸葛亮', era: '东汉末年', role: 'supporting', traits: ['睿智', '淡泊', '自负'] },
      { name: '张飞', era: '东汉末年', role: 'supporting', traits: ['勇猛', '急躁', '忠诚'] },
      { name: '关羽', era: '东汉末年', role: 'supporting', traits: ['忠义', '沉稳', '高傲'] },
    ],
    graphEdges: [
      { from: '刘备', to: '诸葛亮', type: 'involves' },
      { from: '张飞', to: '刘备', type: 'belongs_to' },
      { from: '关羽', to: '刘备', type: 'belongs_to' },
      { from: '隆中', to: '诸葛亮', type: 'located_at' },
    ],
    states: [
      { id: 's_liubei', type: 'character', name: '刘备', properties: { isAlive: 'true', location: '新野', status: '左将军', mood: '求贤若渴', faction: '刘备军', goal: '请诸葛亮出山' } },
      { id: 's_zgl', type: 'character', name: '诸葛亮', properties: { isAlive: 'true', location: '隆中', status: '布衣', mood: '淡泊', faction: '无', goal: '待明主' } },
      { id: 's_zhangfei', type: 'character', name: '张飞', properties: { isAlive: 'true', location: '新野', status: '车骑将军', mood: '焦躁', faction: '刘备军', goal: '随兄长征战' } },
      { id: 's_guanyu', type: 'character', name: '关羽', properties: { isAlive: 'true', location: '新野', status: '偏将军', mood: '沉稳', faction: '刘备军', goal: '辅佐刘备' } },
      { id: 's_rel_lb_zgl', type: 'relationship', name: '刘备-诸葛亮', properties: { between: '刘备-诸葛亮', type: '君臣未定', status: '未遇' } },
    ],
  },
  {
    // 【待决】廉颇刚放话，冲突尚未发生
    title: '负荆请罪',
    description: '战国时赵国蔺相如因完璧归赵拜为上卿，位在廉颇之上，廉颇不服。',
    genre: '历史',
    opener: '战国时，蔺相如以完璧归赵、渑池之会两度折秦，赵王拜为上卿，位在大将廉颇之上。廉颇曰："我为赵将，有攻城野战之大功，而蔺相如徒以口舌为劳，而位居我上，吾羞，不忍为之下。"宣言曰："我见相如，必辱之。"相如闻之，每朝称病，不欲与廉颇争列。一日，相如出，望见廉颇，引车避匿。舍人皆以为耻。',
    characters: [
      { name: '蔺相如', era: '战国', role: 'protagonist', traits: ['宽厚', '识大体', '隐忍'] },
      { name: '廉颇', era: '战国', role: 'antagonist', traits: ['勇猛', '自负', '率直'] },
      { name: '赵惠文王', era: '战国', role: 'supporting', traits: ['纳谏', '优柔'] },
    ],
    graphEdges: [
      { from: '蔺相如', to: '廉颇', type: 'conflicts_with' },
      { from: '蔺相如', to: '赵惠文王', type: 'belongs_to' },
      { from: '廉颇', to: '赵惠文王', type: 'belongs_to' },
      { from: '蔺相如', to: '负荆请罪', type: 'involves' },
    ],
    states: [
      { id: 's_lxr2', type: 'character', name: '蔺相如', properties: { isAlive: 'true', location: '邯郸', status: '上卿', mood: '隐忍', faction: '赵国', goal: '避免将相失和' } },
      { id: 's_lp', type: 'character', name: '廉颇', properties: { isAlive: 'true', location: '邯郸', status: '大将军', mood: '愤懑', faction: '赵国', goal: '羞辱蔺相如' } },
      { id: 's_rel_lxr_lp', type: 'relationship', name: '蔺相如-廉颇', properties: { between: '蔺相如-廉颇', type: '同朝', status: '失和' } },
    ],
  },
  {
    // 【待决】项羽刚夺军权，尚未渡河
    title: '破釜沉舟',
    description: '秦末巨鹿之战，项羽杀宋义夺军权，率楚军渡河救赵，大破秦军。',
    genre: '历史',
    opener: '秦末，秦将章邯围赵王歇于巨鹿，楚怀王遣宋义为上将军、项羽为次将，率军救赵。宋义行至安阳，留四十六日不进，欲坐观秦赵相斗。时天寒大雨，士卒冻饥。项羽曰："今岁饥民贫，士卒食芋菽，军无见粮，而饮酒高会，不引兵渡河，非社稷之臣也。"晨朝，项羽即帐中斩宋义头，出令军中曰："宋义与齐谋反楚，楚王阴令籍诛之。"诸将皆慑服，莫敢枝梧。',
    characters: [
      { name: '项羽', era: '秦末', role: 'protagonist', traits: ['勇猛', '果决', '暴烈'] },
      { name: '宋义', era: '秦末', role: 'antagonist', traits: ['怯懦', '自私', '短视'] },
      { name: '章邯', era: '秦末', role: 'antagonist', traits: ['善战', '沉稳', '务实'] },
    ],
    graphEdges: [
      { from: '项羽', to: '宋义', type: 'conflicts_with' },
      { from: '项羽', to: '章邯', type: 'conflicts_with' },
      { from: '项羽', to: '破釜沉舟', type: 'involves' },
      { from: '巨鹿', to: '章邯', type: 'located_at' },
    ],
    states: [
      { id: 's_xiangyu', type: 'character', name: '项羽', properties: { isAlive: 'true', location: '安阳', status: '次将', mood: '激愤', faction: '楚军', goal: '渡河救赵' } },
      { id: 's_songyi', type: 'character', name: '宋义', properties: { isAlive: 'false', location: '安阳', status: '已诛', mood: '—', faction: '楚军', goal: '—' } },
      { id: 's_zhanghan', type: 'character', name: '章邯', properties: { isAlive: 'true', location: '巨鹿', status: '秦将', mood: '自信', faction: '秦军', goal: '灭赵' } },
      { id: 's_julu', type: 'location', name: '巨鹿', properties: { status: '被秦军围困', controller: '章邯' } },
    ],
  },
  {
    // 【终结】苏武已被流放北海 —— 结局已定，对照荆轲刺秦那类
    title: '苏武牧羊',
    description: '西汉天汉元年，苏武出使匈奴被扣，持节不屈，被流放北海牧羊十九年。',
    genre: '历史',
    opener: '西汉天汉元年，中郎将苏武奉命持节出使匈奴，因副使张胜牵涉谋反，被单于扣留。单于使卫律劝降，许以高官厚禄。苏武曰："屈节辱命，虽生，何面目以归汉！"引佩刀自刺，气绝半日乃苏。卫律知苏武终不可胁，白单于。单于愈益欲降之，乃幽武置大窖中，绝不饮食。天雨雪，武卧啮雪与旃毛并咽之，数日不死。匈奴以为神，乃徙武北海上无人处，使牧羝，羝乳乃得归。',
    characters: [
      { name: '苏武', era: '西汉', role: 'protagonist', traits: ['忠贞', '坚毅', '不屈'] },
      { name: '匈奴单于', era: '西汉', role: 'antagonist', traits: ['强横', '狡诈', '敬重气节'] },
      { name: '卫律', era: '西汉', role: 'antagonist', traits: ['反复', '谄媚', '狠毒'] },
    ],
    graphEdges: [
      { from: '苏武', to: '匈奴单于', type: 'conflicts_with' },
      { from: '卫律', to: '匈奴单于', type: 'belongs_to' },
      { from: '苏武', to: '苏武牧羊', type: 'involves' },
      { from: '北海', to: '苏武', type: 'located_at' },
    ],
    states: [
      { id: 's_sw', type: 'character', name: '苏武', properties: { isAlive: 'true', location: '北海', status: '牧羊', mood: '坚贞', faction: '汉朝', goal: '持节归汉' } },
      { id: 's_chanyu', type: 'character', name: '匈奴单于', properties: { isAlive: 'true', location: '匈奴王庭', status: '单于', mood: '恼怒', faction: '匈奴', goal: '逼降苏武' } },
      { id: 's_weilv', type: 'character', name: '卫律', properties: { isAlive: 'true', location: '匈奴王庭', status: '降将', mood: '阴狠', faction: '匈奴', goal: '劝降苏武' } },
      { id: 's_beihai', type: 'location', name: '北海', properties: { status: '荒无人烟', controller: '无' } },
    ],
  },
  {
    // 【终结】岳飞已奉诏班师 —— 结局已定
    title: '岳飞班师',
    description: '南宋绍兴十年，岳飞大破金军于郾城，正欲北进，高宗、秦桧连发金牌促其班师。',
    genre: '历史',
    opener: '南宋绍兴十年，岳飞大破金兀术于郾城，前锋直抵朱仙镇，金人震恐，河北豪杰并起响应。岳飞大喜，谓部下曰："直抵黄龙府，与诸君痛饮耳！"方欲渡河，而高宗、秦桧主和，一日之内连发十二道金牌，促其班师。岳飞扼腕泣下，东向再拜曰："十年之力，废于一旦！"遂班师南归，河南州县复陷于金。',
    characters: [
      { name: '岳飞', era: '南宋', role: 'protagonist', traits: ['忠勇', '刚直', '执着'] },
      { name: '秦桧', era: '南宋', role: 'antagonist', traits: ['奸诈', '阴狠', '善媚'] },
      { name: '赵构', era: '南宋', role: 'antagonist', traits: ['多疑', '怯懦', '自私'] },
      { name: '金兀术', era: '金', role: 'antagonist', traits: ['骁勇', '善战', '坚韧'] },
    ],
    graphEdges: [
      { from: '岳飞', to: '金兀术', type: 'conflicts_with' },
      { from: '秦桧', to: '赵构', type: 'belongs_to' },
      { from: '岳飞', to: '赵构', type: 'belongs_to' },
      { from: '岳飞', to: '班师', type: 'involves' },
    ],
    states: [
      { id: 's_yf', type: 'character', name: '岳飞', properties: { isAlive: 'true', location: '朱仙镇', status: '枢密副使', mood: '悲愤', faction: '南宋', goal: '直捣黄龙' } },
      { id: 's_qh', type: 'character', name: '秦桧', properties: { isAlive: 'true', location: '临安', status: '宰相', mood: '阴狠', faction: '南宋', goal: '促成和议' } },
      { id: 's_zg', type: 'character', name: '赵构', properties: { isAlive: 'true', location: '临安', status: '宋高宗', mood: '疑惧', faction: '南宋', goal: '偏安江南' } },
      { id: 's_jwz', type: 'character', name: '金兀术', properties: { isAlive: 'true', location: '开封', status: '金军统帅', mood: '惊惧', faction: '金国', goal: '稳固河南' } },
    ],
  },
  {
    // 【待决】商鞅刚立木，还没人搬
    title: '商鞅立木',
    description: '战国时商鞅在秦孝公支持下变法，为取信于民，立木于都城南门，悬赏徙之。',
    genre: '历史',
    opener: '战国时，卫人公孙鞅入秦，说秦孝公以变法强国之术，孝公大悦，任之为左庶长。新法未行，恐民不信。鞅乃立三丈之木于国都栎阳南门，下令曰："有能徙置北门者，予十金。"民怪之，莫敢徙。鞅复曰："能徙者予五十金。"百姓聚观，窃窃私议，终无一人应者。',
    characters: [
      { name: '商鞅', era: '战国', role: 'protagonist', traits: ['果决', '严酷', '务实'] },
      { name: '秦孝公', era: '战国', role: 'supporting', traits: ['雄才', '果断', '纳谏'] },
      { name: '甘龙', era: '战国', role: 'antagonist', traits: ['守旧', '固执', '多谋'] },
    ],
    graphEdges: [
      { from: '商鞅', to: '秦孝公', type: 'belongs_to' },
      { from: '商鞅', to: '甘龙', type: 'conflicts_with' },
      { from: '商鞅', to: '立木取信', type: 'involves' },
      { from: '栎阳', to: '秦孝公', type: 'located_at' },
    ],
    states: [
      { id: 's_sy', type: 'character', name: '商鞅', properties: { isAlive: 'true', location: '栎阳', status: '左庶长', mood: '果决', faction: '秦国', goal: '推行新法' } },
      { id: 's_qxg', type: 'character', name: '秦孝公', properties: { isAlive: 'true', location: '栎阳', status: '秦公', mood: '期待', faction: '秦国', goal: '富国强兵' } },
      { id: 's_gl', type: 'character', name: '甘龙', properties: { isAlive: 'true', location: '栎阳', status: '大夫', mood: '不满', faction: '秦国旧族', goal: '阻挠变法' } },
    ],
  },
  {
    // 【终结】淝水之战已打完 —— 结局已定
    title: '淝水之战',
    description: '东晋太元八年，前秦苻坚率大军南下，谢玄以八万北府兵大破之于淝水。',
    genre: '历史',
    opener: '东晋太元八年，前秦苻坚倾国南侵，众号百万，投鞭断流。晋廷震恐，以谢石为都督、谢玄为前锋，率北府兵八万拒之。玄遣使谓苻坚曰："君悬军深入，而置阵逼水，此持久之计，非欲速战也。若移阵少却，使晋兵得渡，以决胜负，不亦善乎？"苻坚许之，麾兵使退。秦兵一退，不可复止。朱序在阵后呼曰："秦兵败矣！"众遂大奔，自相蹈藉，投水死者不可胜计，淝水为之不流。苻坚中流矢，单骑走还淮北。',
    characters: [
      { name: '谢玄', era: '东晋', role: 'protagonist', traits: ['果决', '善战', '沉稳'] },
      { name: '苻坚', era: '前秦', role: 'antagonist', traits: ['宽仁', '自负', '轻敌'] },
      { name: '谢安', era: '东晋', role: 'supporting', traits: ['从容', '深沉', '雅量'] },
    ],
    graphEdges: [
      { from: '谢玄', to: '苻坚', type: 'conflicts_with' },
      { from: '谢玄', to: '谢安', type: 'belongs_to' },
      { from: '谢玄', to: '淝水之战', type: 'involves' },
      { from: '淝水', to: '谢玄', type: 'located_at' },
    ],
    states: [
      { id: 's_xx', type: 'character', name: '谢玄', properties: { isAlive: 'true', location: '淝水', status: '前锋都督', mood: '沉着', faction: '东晋', goal: '击退秦军' } },
      { id: 's_pj', type: 'character', name: '苻坚', properties: { isAlive: 'true', location: '淮北', status: '前秦天王', mood: '溃败', faction: '前秦', goal: '收拢败兵' } },
      { id: 's_xa', type: 'character', name: '谢安', properties: { isAlive: 'true', location: '建康', status: '宰相', mood: '从容', faction: '东晋', goal: '稳定朝局' } },
      { id: 's_feishui', type: 'location', name: '淝水', properties: { status: '战场', controller: '东晋' } },
    ],
  },
];

// ============================================================================
// 种子节点类型推断
// ============================================================================

/**
 * 实验台架用到的地点 / 事件名单。
 *
 * 旧实现按边的类型猜节点类型，而且**只猜 from 端、to 端一律当角色**。
 * 于是"洛阳 →敌对→ 董卓"把地点洛阳、"郭子仪 →参与→ 单骑退敌"把事件
 * 单骑退敌都登记成了角色，注入 Prompt 时它们会出现在「角色」那一行里，
 * 成为图谱噪声的一部分。改成两端都按类型推断。
 *
 * 类型来源**从故事定义自己派生**，而不是硬编码名单：每个 StoryDef 的 `states` 里
 * 已经有 type='location' / 'event' 的对象，直接用它们建索引即可。
 *
 * （早先是一份手写常量表，扩样加了 10 个故事后，"咸阳""巨鹿""淝水"这些新地点
 * 全部落到兜底分支被当成角色——正是这个函数当初要修的毛病又长回来了。
 * 派生比枚举可靠：新增故事再也不用记得回来改这里。）
 */
function inferSeedNodeType(
  name: string, charNames: Set<string>, locNames: Set<string>, evtNames: Set<string>,
): NodeType {
  if (charNames.has(name)) return 'character';
  if (locNames.has(name)) return 'location';
  if (evtNames.has(name)) return 'event';
  // 兜底当角色，并留痕，避免故事里的实体被静默归错类
  console.warn(`[ab_ablation] 种子实体「${name}」未在故事定义的 characters/location/event 中出现，按角色处理`);
  return 'character';
}

// ============================================================================
// 实验流程
// ============================================================================

const SYSTEM_PROMPT = '你是一位专业的文学作家。请用中文回答，用现代白话文写作，保持与前文的风格和情节连续性。';

async function cleanupStory(storyId: string): Promise<void> {
  await prisma.storyBranch.deleteMany({ where: { storyId } });
  await prisma.storySegment.deleteMany({ where: { storyId } });
  await prisma.character.deleteMany({ where: { storyId } });
  await prisma.story.delete({ where: { id: storyId } }).catch(() => {});
}

async function setupStory(def: StoryDef, tag: string, arm: Arm): Promise<{ storyId: string; branchId: string }> {
  const titleKey = `消融·${def.title}`;
  const oldStories = await prisma.story.findMany({ where: { title: { contains: titleKey } }, select: { id: true } });
  for (const old of oldStories) await cleanupStory(old.id);

  const testEmail = 'ablation_test@gushi.local';
  let user = await prisma.user.findUnique({ where: { email: testEmail } });
  if (!user) {
    user = await prisma.user.create({
      data: { email: testEmail, name: '消融测试用户', passwordHash: '$2b$10$x', id: 'user_ablation_test' } as any,
    });
  }

  const storyId = `story_${tag}_${arm}_${Date.now()}`;
  const branchId = `branch_${tag}_${arm}`;

  await prisma.story.create({
    data: {
      title: titleKey, description: def.description, genre: def.genre,
      visibility: 'PUBLIC', id: storyId, owner: { connect: { id: user.id } },
    } as any,
  });

  const charIds: string[] = [];
  for (const c of def.characters) {
    const created = await prisma.character.create({
      data: {
        name: c.name, era: c.era, role: c.role, traits: c.traits,
        storyId, id: `char_${tag}_${arm}_${c.name}`,
      } as any,
    });
    charIds.push(created.id);
  }

  await prisma.storySegment.create({
    data: {
      storyId, title: '起点', content: def.opener, isBranchPoint: false,
      branchId: 'main', parentSegmentId: null, imageUrls: [],
      characterIds: charIds, id: `seg_${tag}_${arm}_main_000`,
    } as any,
  });

  await prisma.storyBranch.create({
    data: {
      id: branchId, title: `消融-${arm}`, sourceSegmentId: `seg_${tag}_${arm}_main_000`,
      storyId, userDirection: '消融实验', ownerId: user.id,
    } as any,
  });

  // 图谱 + 状态表：无论哪档都先种好数据，档位只控制「是否注入 Prompt」
  // —— 这样各档的初始条件完全一致，差异只来自注入与否，实验才干净。
  const seedCharNames = new Set(def.characters.map(c => c.name));
  // 地点/事件名单从故事定义自己派生（见 inferSeedNodeType 的注释）
  const seedLocNames = new Set(def.states.filter(s => s.type === 'location').map(s => s.name as string));
  const seedEvtNames = new Set(def.states.filter(s => s.type === 'event').map(s => s.name as string));
  for (const e of def.graphEdges) {
    const n1 = await knowledgeGraph.getOrCreateNode({
      type: inferSeedNodeType(e.from, seedCharNames, seedLocNames, seedEvtNames), name: e.from, branchId,
    });
    const n2 = await knowledgeGraph.getOrCreateNode({
      type: inferSeedNodeType(e.to, seedCharNames, seedLocNames, seedEvtNames), name: e.to, branchId,
    });
    await knowledgeGraph.addEdge({ source: n1.id, target: n2.id, type: e.type, branchId, segmentId: 'seed' });
  }

  await narrativeStateTracker.forceSetStates(storyId, branchId, def.states.map(s => ({
    ...s, branchId, history: [], lastSeenSegmentId: 'seed',
  })) as any);

  return { storyId, branchId };
}

/** 续写一段，返回 { content, promptLen } */
async function continueOnce(
  storyId: string, branchId: string, story: any, tag: string, arm: Arm,
): Promise<{ content: string; promptLen: number }> {
  const chain = await getOrderedChain(storyId, branchId);
  const tail = chain[chain.length - 1];
  const { prompt } = await buildFullPrompt({
    storyId, branchId, tailSegment: tail as any, chain: chain as any,
    storyTitle: story.title, storyDescription: story.description ?? undefined,
  });

  const content = await callAIText(prompt, { systemPrompt: SYSTEM_PROMPT, maxTokens: 700, story });
  const segId = `seg_${tag}_${arm}_${branchId}_${String(chain.length).padStart(3, '0')}`;

  await prisma.storySegment.create({
    data: {
      storyId, title: `续写${chain.length}`, content, isBranchPoint: false,
      branchId, parentSegmentId: tail.id, imageUrls: [], id: segId,
    } as any,
  });

  // 记忆增量更新：只有「该模块参与」的档位才更新，否则基线会被污染
  if (arm === 'state' || arm === 'both') {
    try { await narrativeStateTracker.updateFromSegment(storyId, branchId, segId, content); } catch {}
  }
  if (arm === 'graph' || arm === 'both') {
    try {
      await knowledgeGraph.extractFromSegment(content, branchId, segId, (p: string) =>
        callAIText(p, { maxTokens: 1500, story }));
    } catch {}
  }

  return { content, promptLen: prompt.length };
}

type RunResult = {
  story: string;
  arm: Arm;
  segments: string[];
  promptLens: number[];
  promptInjection: number;      // 相对 none 档的注入增量（字）
  adjacentSim: { values: number[]; avg: number };
  charCoverage: number;
  charMentions: Record<string, number>;
  graphNodes: number;
  graphEdges: number;
  stateObjects: number;
};

async function runOneStory(def: StoryDef, idx: number, arm: Arm, segmentsPerArm: number): Promise<RunResult> {
  const tag = `s${idx}`;
  applyArm(arm);

  const { storyId, branchId } = await setupStory(def, tag, arm);
  const story = await prisma.story.findUnique({ where: { id: storyId } });
  if (!story) throw new Error('故事创建失败');

  const segments: string[] = [];
  const promptLens: number[] = [];
  for (let i = 0; i < segmentsPerArm; i++) {
    const { content, promptLen } = await continueOnce(storyId, branchId, story, tag, arm);
    segments.push(content);
    promptLens.push(promptLen);
  }

  const stats = await knowledgeGraph.getStats();
  const summary = await narrativeStateTracker.summarize(storyId, branchId);
  const names = def.characters.map(c => c.name);
  const joined = segments.join('\n');

  return {
    story: def.title,
    arm,
    segments,
    promptLens,
    promptInjection: -1,   // 稍后由汇总阶段填充
    adjacentSim: avgAdjacentSimilarity(segments),
    charCoverage: characterCoverage(segments, names),
    charMentions: countCharacterMentions(joined, names),
    graphNodes: stats.totalNodes,
    graphEdges: stats.totalEdges,
    stateObjects: summary.totalObjects,
  };
}

// ============================================================================
// 汇总 & 落盘
// ============================================================================

function buildMarkdown(results: RunResult[], stories: number, segments: number): string {
  const arms: Arm[] = ['none', 'state', 'graph', 'both'];
  const storyTitles = [...new Set(results.map(r => r.story))];

  const lines: string[] = [];
  lines.push('# 记忆注入消融实验报告');
  lines.push('');
  lines.push(`> 生成时间：${new Date().toISOString().slice(0, 10)} ｜ 故事数：${stories} ｜ 每档续写段数：${segments}`);
  lines.push('');
  lines.push('## 一、实验设置');
  lines.push('');
  lines.push('| 档位 | 说明 | 状态表注入 | 图谱注入 |');
  lines.push('|------|------|:---:|:---:|');
  lines.push('| `none` | 无记忆（基线） | ✗ | ✗ |');
  lines.push('| `state` | 仅状态表 | ✓ | ✗ |');
  lines.push('| `graph` | 仅知识图谱 | ✗ | ✓ |');
  lines.push('| `both` | 状态表 + 图谱 | ✓ | ✓ |');
  lines.push('');
  lines.push('## 二、量化结果总表');
  lines.push('');
  lines.push('| 故事 | 档位 | Prompt均值(字) | 注入增量(字) | 相邻段重复度 | 退化对 | 角色覆盖率 | 图谱节点 | 状态表对象 |');
  lines.push('|------|------|------:|------:|------:|:---:|------:|------:|------:|');

  for (const title of storyTitles) {
    const base = results.find(r => r.story === title && r.arm === 'none');
    const basePrompt = base ? base.promptLens.reduce((s, v) => s + v, 0) / base.promptLens.length : 0;

    for (const arm of arms) {
      const r = results.find(x => x.story === title && x.arm === arm);
      if (!r) continue;
      const avgPrompt = r.promptLens.reduce((s, v) => s + v, 0) / r.promptLens.length;
      const inj = arm === 'none' ? 0 : Math.round(avgPrompt - basePrompt);
      const deg = splitSimilarity(r.adjacentSim.values).degenerateCount;
      lines.push(
        `| ${title} | \`${arm}\` | ${Math.round(avgPrompt)} | ${inj > 0 ? '+' : ''}${inj} | ` +
        `${r.adjacentSim.avg.toFixed(3)} | ${deg > 0 ? `⚠️ ${deg}` : '—'} | ${(r.charCoverage * 100).toFixed(0)}% | ${r.graphNodes} | ${r.stateObjects} |`,
      );
    }
  }
  lines.push('');

  // 跨故事平均（带标准差 + 相对基线的配对检验）
  lines.push('## 三、跨故事平均（各档位，均值 ± 标准差）');
  lines.push('');
  lines.push('> ⚠️ 「相邻段重复度（均值）」一列**不可单独用作结论**：它是双峰指标，被稀疏的退化复读');
  lines.push('> 事件支配（详见 §三-1）。判断档位优劣请看「退化复读率」与「非退化中位数」两列。');
  lines.push('');
  lines.push('| 档位 | 相邻段重复度(均值) | **退化复读率** ↓ | **非退化中位数** ↓ | 角色覆盖率 ↑ | Prompt 字数 | 图谱节点 |');
  lines.push('|------|------:|------:|------:|------:|------:|------:|');

  const baselineSim = results.filter(r => r.arm === 'none').map(r => r.adjacentSim.avg);

  for (const arm of arms) {
    const rs = results.filter(r => r.arm === arm);
    if (rs.length === 0) continue;
    const simS = stats(rs.map(r => r.adjacentSim.avg));
    const allPairs = rs.flatMap(r => r.adjacentSim.values);
    const split = splitSimilarity(allPairs);
    const covS = stats(rs.map(r => r.charCoverage));
    const pS = stats(rs.map(r => r.promptLens.reduce((s, v) => s + v, 0) / r.promptLens.length));
    const nS = stats(rs.map(r => r.graphNodes));
    lines.push(
      `| \`${arm}\` | ${simS.mean.toFixed(3)} ± ${simS.std.toFixed(3)} | ` +
      `${split.degenerateRate.toFixed(2)} (${split.degenerateCount}/${split.nPairs}) | ` +
      `${split.restMedian.toFixed(3)} | ` +
      `${(covS.mean * 100).toFixed(0)}% ± ${(covS.std * 100).toFixed(0)}% | ` +
      `${pS.mean.toFixed(0)} ± ${pS.std.toFixed(0)} | ${nS.mean.toFixed(1)} ± ${nS.std.toFixed(1)} |`,
    );
  }
  lines.push('');

  // ── §三-1 指标诊断 ──
  lines.push('### 三-1、为什么「相邻段重复度」不能直接比：退化复读');
  lines.push('');
  lines.push('本指标实测为**双峰分布**：绝大多数相邻对相似度在 0.01–0.15（正常续写），');
  lines.push(`但会出现相似度 1.00 的相邻对——检查原文，这些段落是**逐字节完全相同**的，`);
  lines.push('即模型整段照抄了上一段，而不是"情节套路化"。');
  lines.push('');
  lines.push('它会把均值彻底带偏，原因是两个放大机制：');
  lines.push('');
  lines.push('1. **一个触发点贡献多个 1.00**。照抄出来的文本又成为下一段的"上文"，模型会继续照抄');
  lines.push('   （吸收态），所以第 3/4/5 段全同时，4 个相邻对里有 2 个是 1.00，该故事均值从 ~0.05 抬到 ~0.5。');
  lines.push('2. **n 太小**。n=5 故事时，一个故事触发就把该档均值抬高约 0.1，超过档间真实差异。');
  lines.push('');
  lines.push('已验证这不是台架 bug：逐步打印 Prompt 哈希与正文哈希，复读发生时相邻两步的');
  lines.push('**Prompt 内容与长度都不同**，输出却逐字节相同；且同一 Prompt 连调三次输出互不相同');
  lines.push('（采样是随机的）。诊断脚本：[scripts/repro-repeat.ts](../scripts/repro-repeat.ts)。');
  lines.push('');
  lines.push('**结论**：退化复读是模型侧的固有失效模式，与记忆档位无关（`none` 与 `graph` 在同一故事上');
  lines.push('同样触发），发生率约 5%/步。因此它应当**单独作为一个指标报告**（退化复读率），');
  lines.push('而不是混进"重复度均值"里当作被解释变量。');
  lines.push('');

  // 相对基线的假设检验
  if (baselineSim.length >= 2) {
    lines.push('### 三-2、相对基线的配对 t 检验（相邻段重复度均值）');
    lines.push('');
    lines.push('| 档位 | 平均差值 | t 值 | df | 显著 (p<0.05) |');
    lines.push('|------|------:|------:|------:|:---:|');
    for (const arm of arms) {
      if (arm === 'none') continue;
      const rs = results.filter(r => r.arm === arm).map(r => r.adjacentSim.avg);
      if (rs.length < 2) continue;
      const test = pairedTTest(baselineSim, rs);
      const diff = stats(rs).mean - stats(baselineSim).mean;
      lines.push(
        `| \`${arm}\` | ${diff >= 0 ? '+' : ''}${diff.toFixed(3)} | ${test.t.toFixed(2)} | ${test.df} | ${test.significant ? '✅ 是' : '❌ 否'} |`,
      );
    }
    lines.push('');
    lines.push('> ⚠️ **这张表目前不可用于任何结论**。重跑同一份代码（`none` / `state` 两档的 Prompt');
    lines.push('> 构造路径在两轮之间完全没有改动）后，档位排名整体翻转：');
    lines.push('> `none` 0.332→0.127、`state` 0.043→0.233。**轮间差（0.19–0.21）大于档间差（0.11）**，');
    lines.push('> 说明该指标在 n=5、单轮的条件下测不出档位差异。');
    lines.push('>');
    lines.push('> 扩样到每档 ≥3 轮、并把退化复读拆开后，才可以用这张表下结论。');
    lines.push('> 现阶段只能说：**四档在退化复读率与非退化中位数上均无可见差异**。');
    lines.push('');
  }

  // 生成片段（供人工阅读 / LLM-as-Judge 打分）
  lines.push('## 四、生成片段（供人工阅读与打分）');
  lines.push('');
  for (const title of storyTitles) {
    lines.push(`### ${title}`);
    lines.push('');
    for (const arm of arms) {
      const r = results.find(x => x.story === title && x.arm === arm);
      if (!r) continue;
      lines.push(`**${ARM_LABELS[arm]}（\`${arm}\`）**`);
      lines.push('');
      r.segments.forEach((s, i) => {
        lines.push(`- 第 ${i + 1} 段：${s.slice(0, 300)}${s.length > 300 ? '…' : ''}`);
      });
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ============================================================================
// 主流程
// ============================================================================

async function main() {
  const { arms, stories, segments, reportOnly, roundsReport, only, outName } = parseArgs();

  /** 列出落盘的结果文件，按修改时间升序 */
  const listResultFiles = (): string[] => {
    const outDir = join(process.cwd(), 'Docs', 'ablation');
    if (!existsSync(outDir)) return [];
    return readdirSync(outDir)
      .filter(f => f.startsWith('ablation_results_') && f.endsWith('.json'))
      // 按修改时间排序取最新。不能按文件名字典序：`ablation_results_2026-…`
      // 会排在 `ablation_results_full_5x5.json` 前面，取到旧数据。
      .map(f => ({ f, t: statSync(join(outDir, f)).mtimeMs }))
      .sort((a, b) => a.t - b.t)
      .map(x => x.f);
  };

  if (roundsReport) {
    // 跨轮汇总：把所有历史结果文件都当成独立的一轮
    const outDir = join(process.cwd(), 'Docs', 'ablation');
    const allFiles = listResultFiles();
    if (allFiles.length === 0) {
      console.error(`未找到历史结果。请先跑一次实验（去掉 --rounds-report）。\n查找目录：${outDir}`);
      process.exit(1);
    }
    const files = only.length === 0 ? allFiles : allFiles.filter(f => only.some(o => f.includes(o)));
    if (files.length === 0) {
      console.error(`--only=${only.join(',')} 没有匹配到任何结果文件。\n可选：\n` + allFiles.map(f => `  ${f}`).join('\n'));
      process.exit(1);
    }
    if (only.length > 0) {
      console.log(`\n🔎 只纳入匹配 --only=${only.join(',')} 的 ${files.length} 个文件（共 ${allFiles.length} 个）`);
    }
    const rounds = files.map(f => JSON.parse(readFileSync(join(outDir, f), 'utf-8')) as RunResult[]);
    console.log(`\n📂 纳入 ${rounds.length} 轮结果：`);
    files.forEach((f, i) => console.log(`   ${i + 1}. ${f}（${rounds[i].length} 条记录）`));

    const presentArms = arms.filter(a => rounds.some(r => r.some(x => x.arm === a)));
    const mdPath = join(outDir, outName);
    writeFileSync(mdPath, buildRoundsMarkdown(rounds, presentArms, files), 'utf-8');
    console.log(`\n💾 已生成跨轮汇总：${mdPath}`);

    // 控制台同步打印核心表
    console.log('\n' + '═'.repeat(96));
    console.log('📊 跨轮汇总');
    console.log('═'.repeat(96));
    console.log(`${'档位'.padEnd(20)} ${'非退化中位数（轮均±轮间标准差）'.padEnd(36)} 退化复读率`);
    console.log('─'.repeat(96));
    for (const arm of presentArms) {
      const rs: { median: number; degRate: number }[] = [];
      for (const round of rounds) {
        const vals = round.filter(r => r.arm === arm).flatMap(r => r.adjacentSim.values);
        if (vals.length === 0) continue;
        const s = splitSimilarity(vals);
        rs.push({ median: s.restMedian, degRate: s.degenerateRate });
      }
      if (rs.length === 0) continue;
      const med = stats(rs.map(x => x.median));
      const deg = stats(rs.map(x => x.degRate));
      console.log(
        `${ARM_LABELS[arm].padEnd(18)} ` +
        `${(med.mean.toFixed(3) + ' ± ' + med.std.toFixed(3)).padEnd(36)} ` +
        `${deg.mean.toFixed(2)} ± ${deg.std.toFixed(2)}`,
      );
    }
    console.log('─'.repeat(96));
    return;
  }

  if (reportOnly) {
    // 复用最近一次落盘的结果，只重新生成汇总，不重新调 AI
    const outDir = join(process.cwd(), 'Docs', 'ablation');
    const files = listResultFiles();
    if (files.length === 0) {
      console.error(`未找到历史结果。请先跑一次实验（去掉 --report-only）。\n查找目录：${outDir}`);
      process.exit(1);
    }
    const latest = files[files.length - 1];
    const results = JSON.parse(readFileSync(join(outDir, latest), 'utf-8')) as RunResult[];
    console.log(`\n📂 复用结果：${latest}（${results.length} 条记录）`);

    // --report-only 只覆盖一份固定名字的报告，避免每次重生成都堆一个新文件
    const mdPath = join(outDir, 'ablation_report.md');
    writeFileSync(mdPath, buildMarkdown(results, stories, segments), 'utf-8');
    console.log(`💾 已重新生成报告：${mdPath}`);
    printSummary(results, [...new Set(results.map(r => r.arm))]);
    return;
  }

  console.log(`\n🧪 消融实验：${arms.length} 档 × ${stories} 故事 × ${segments} 段`);
  console.log(`   档位：${arms.join(', ')}\n`);
  warnIfTooFewSegments([], segments);

  const results: RunResult[] = [];

  for (let i = 0; i < Math.min(stories, ALL_STORY_DEFS.length); i++) {
    const def = ALL_STORY_DEFS[i];
    const stats0 = await knowledgeGraph.getStats();
    const graph0 = { nodes: stats0.totalNodes, edges: stats0.totalEdges };

    for (const arm of arms) {
      console.log(`\n${'─'.repeat(60)}`);
      console.log(`🎭 ${def.title} ｜ 档位：${ARM_LABELS[arm]} (\`${arm}\`)`);
      console.log(`${'─'.repeat(60)}`);

      try {
        const r = await runOneStory(def, i, arm, segments);
        results.push(r);
        const avgPrompt = r.promptLens.reduce((s, v) => s + v, 0) / r.promptLens.length;
        console.log(`  Prompt 均值：${Math.round(avgPrompt)} 字`);
        console.log(`  相邻段重复度：${r.adjacentSim.avg.toFixed(3)}（各段 ${r.adjacentSim.values.map(v => v.toFixed(2)).join(',')}）`);
        console.log(`  角色覆盖率：${(r.charCoverage * 100).toFixed(0)}%`);
        console.log(`  图谱：+${r.graphNodes - graph0.nodes} 节点 ／ 状态表：${r.stateObjects} 对象`);
      } catch (e) {
        console.error(`  ❌ 档位 ${arm} 执行失败：`, e);
      }
    }
  }

  // 落盘
  //
  // 文件名必须带上实验参数 + 毫秒级时间戳，否则会互相覆盖：
  //   ① 不同规模的实验（1 故事冒烟 vs 5 故事正式）曾撞名，冒烟结果覆盖了正式结果；
  //   ② 同一秒内并发跑两次，秒级时间戳也会撞。
  const outDir = join(process.cwd(), 'Docs', 'ablation');
  mkdirSync(outDir, { recursive: true });
  const now = new Date();
  const stamp = [
    now.toISOString().slice(0, 19).replace(/[:T]/g, '-'),
    String(now.getMilliseconds()).padStart(3, '0'),
  ].join('-');
  const scope = `s${stories}x${segments}seg-${arms.join('_')}`;
  const jsonPath = join(outDir, `ablation_results_${stamp}_${scope}.json`);
  const mdPath = join(outDir, `ablation_report_${stamp}_${scope}.md`);

  writeFileSync(jsonPath, JSON.stringify(results, null, 2), 'utf-8');
  writeFileSync(mdPath, buildMarkdown(results, stories, segments), 'utf-8');
  console.log(`\n💾 已落盘：\n  ${jsonPath}\n  ${mdPath}`);

  printSummary(results, arms);

  console.log('\n✅ 消融实验完成');
}

/** 校验已有结果是否包含足够的段落对，否则重复度指标全为 0（无意义） */
function warnIfTooFewSegments(results: RunResult[], segmentsPerArm: number) {
  if (segmentsPerArm >= 2) return;
  console.warn(
    `\n⚠️  每档只续写 ${segmentsPerArm} 段 —— 相邻段重复度需要至少 2 段才有意义，` +
    `当前所有重复度都是 0.000。正式实验请用 --segments=5。`,
  );
}

function printSummary(results: RunResult[], arms: Arm[]) {
  console.log('\n' + '═'.repeat(96));
  console.log('📊 消融实验汇总（跨故事，均值 ± 标准差）');
  console.log('═'.repeat(96));
  console.log(
    `${'档位'.padEnd(20)} ${'重复度均值'.padEnd(18)} ${'退化复读率 ↓'.padEnd(18)} ${'非退化中位数 ↓'.padEnd(18)} ${'角色覆盖率 ↑'.padEnd(16)}`,
  );
  console.log('─'.repeat(96));
  for (const arm of arms) {
    const rs = results.filter(r => r.arm === arm);
    if (rs.length === 0) continue;
    const simS = stats(rs.map(r => r.adjacentSim.avg));
    const split = splitSimilarity(rs.flatMap(r => r.adjacentSim.values));
    const covS = stats(rs.map(r => r.charCoverage));
    console.log(
      `${ARM_LABELS[arm].padEnd(18)} ` +
      `${(simS.mean.toFixed(3) + ' ± ' + simS.std.toFixed(3)).padEnd(18)} ` +
      `${(split.degenerateRate.toFixed(2) + ` (${split.degenerateCount}/${split.nPairs})`).padEnd(18)} ` +
      `${split.restMedian.toFixed(3).padEnd(18)} ` +
      `${((covS.mean * 100).toFixed(0) + '% ± ' + (covS.std * 100).toFixed(0) + '%')}`,
    );
  }
  console.log('─'.repeat(96));
  console.log('提示：重复度均值是双峰指标、被稀疏的退化复读事件支配，**不可单独下结论**。');
  console.log('      判断档位优劣看「退化复读率」与「非退化中位数」；见报告 §三-1。');
}

// 只在「直接运行本文件」时才跑实验。被其它脚本 import 复用纯函数
// （splitSimilarity / pairedTTest 等）时绝不能跑——否则 import 一次就是几百次 AI 调用。
const isDirectRun = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('tests/ab_ablation.ts');
if (isDirectRun) {
  main()
    .catch((e) => { console.error('失败:', e); process.exit(1); })
    .finally(async () => { await prisma.$disconnect(); });
}
