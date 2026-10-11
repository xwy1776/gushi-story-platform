/**
 * 人工评估 · 第三步：人工 / 关键词法 / Judge 三方一致率
 *
 * 运行：
 *   npx tsx tests/human_eval_agreement.ts                     # 用默认的 人工判定.csv
 *   npx tsx tests/human_eval_agreement.ts --input=<path.csv>  # 指定文件
 *   npx tsx tests/human_eval_agreement.ts --selftest          # 用合成数据自检（不写报告）
 *
 * 输入：`Docs/ablation/human_eval/抽样清单_盲化密钥.json` + 盲评表导出的 `人工判定.csv`
 * 产出：`Docs/ablation/human_eval/人工评估报告.md`
 *
 * ## 只有一位评审
 *
 * 本评估由**单人**完成，因此：
 *   - **算不了** Fleiss κ（需要 ≥3 位评审的同批标注），论文里不要写"三方 Fleiss κ"
 *   - 只能做**两两一致率 + Cohen's κ**（人工×关键词法、人工×Judge），
 *     以及"三方全部一致"的比例
 *   - 没有 inter-rater reliability —— 这条必须写进论文限制
 *
 * ## 为什么还要按层加权
 *
 * 抽样是**分层过采样**的（分歧段被刻意多抽，见 human_eval_prepare.ts）。
 * 直接算样本内一致率会高估/低估总体，所以除了原始一致率，还给出
 * **按抽样权重还原到 600 段总体**的估计（含 bootstrap 置信区间）。
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';

const ROOT = resolve(__dirname, '..');
const EVAL_DIR = join(ROOT, 'Docs', 'ablation', 'human_eval');
const KEY_PATH = join(EVAL_DIR, '抽样清单_盲化密钥.json');
const DEFAULT_INPUT = join(EVAL_DIR, '人工判定.csv');
const OUT_PATH = join(EVAL_DIR, '人工评估报告.md');

const BOOTSTRAP_N = 2000;
const SEED = 20261007;

type Label = '污染' | '干净';
type Rating = Label | '说不准';

type KeyRow = {
  编码: string;
  层: string;
  抽样权重: number;
  轮次: number;
  故事: string;
  档位: 'isolated' | 'shared';
  段号: number;
  关键词法: Rating;
  Judge: Rating;
  甲分支: string;
  乙分支: string;
  Judge原句: string;
  关键词命中: string[];
};

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Cohen's κ = (po − pe) / (1 − pe)，二分类 */
function cohenKappa(pairs: Array<[Label, Label]>): { po: number; pe: number; kappa: number } {
  const n = pairs.length;
  if (n === 0) return { po: NaN, pe: NaN, kappa: NaN };
  let a = 0; // 双方都判污染
  let d = 0; // 双方都判干净
  let b = 0; // 前者污染、后者干净
  let c = 0; // 前者干净、后者污染
  for (const [x, y] of pairs) {
    if (x === '污染' && y === '污染') a++;
    else if (x === '干净' && y === '干净') d++;
    else if (x === '污染') b++;
    else c++;
  }
  const po = (a + d) / n;
  const pYes = ((a + b) / n) * ((a + c) / n);
  const pNo = ((c + d) / n) * ((b + d) / n);
  const pe = pYes + pNo;
  return { po, pe, kappa: pe === 1 ? NaN : (po - pe) / (1 - pe) };
}

const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '—');
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '—');

/** κ 的通行判读档（Landis & Koch），写进报告免得读者自己查 */
function kappaTier(k: number): string {
  if (!Number.isFinite(k)) return '—';
  if (k < 0) return '差于随机';
  if (k < 0.21) return '轻微';
  if (k < 0.41) return '一般';
  if (k < 0.61) return '中等';
  if (k < 0.81) return '较强';
  return '很强';
}

// ---------------------------------------------------------------------------
// 读入
// ---------------------------------------------------------------------------

function loadKey(): KeyRow[] {
  if (!existsSync(KEY_PATH)) {
    throw new Error(`找不到盲化密钥 ${KEY_PATH}\n请先跑 npx tsx tests/human_eval_prepare.ts`);
  }
  return JSON.parse(readFileSync(KEY_PATH, 'utf-8')) as KeyRow[];
}

/** 读盲评表导出的 CSV（首列编码，次列判定）。兼容 BOM、空行、全角空格 */
function loadRatings(path: string): Map<string, Rating> {
  if (!existsSync(path)) {
    throw new Error(
      `找不到人工判定文件：${path}\n` +
        `请用盲评表 HTML 导出 CSV，或直接填 ${join(EVAL_DIR, '盲评表_空.csv')} 后改名为 人工判定.csv`,
    );
  }
  const raw = readFileSync(path, 'utf-8').replace(/^﻿/, '');
  const out = new Map<string, Rating>();
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || /^编码\s*,/.test(t)) continue;
    const i = t.indexOf(',');
    if (i < 0) continue;
    const code = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim().replace(/\s/g, '');
    if (!code) continue;
    if (v === '污染' || v === '干净' || v === '说不准') out.set(code, v);
    else if (v) console.warn(`  ⚠️ ${code} 的判定值无法识别：「${v}」——已跳过`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 统计
// ---------------------------------------------------------------------------

type Item = KeyRow & { 人工: Rating };

function analyze(items: Item[]) {
  // 只保留人工给出二值判定的条目用于一致率；「说不准」单独计数
  const decided = items.filter((x) => x.人工 === '污染' || x.人工 === '干净') as Array<
    KeyRow & { 人工: Label }
  >;
  const unsure = items.filter((x) => x.人工 === '说不准');

  const pairHM = cohenKappa(decided.map((x) => [x.人工, x.关键词法 as Label]));
  const pairHJ = cohenKappa(decided.map((x) => [x.人工, x.Judge as Label]));
  const pairMJ = cohenKappa(decided.map((x) => [x.关键词法 as Label, x.Judge as Label]));

  const allAgree = decided.filter(
    (x) => x.人工 === x.关键词法 && x.关键词法 === x.Judge,
  ).length;

  // 「人工 vs Judge」的混淆矩阵 —— 论文最关心这个：Judge 到底多准？
  const cmHJ = { bothYes: 0, humanYesJudgeNo: 0, humanNoJudgeYes: 0, bothNo: 0 };
  for (const x of decided) {
    if (x.人工 === '污染' && x.Judge === '污染') cmHJ.bothYes++;
    else if (x.人工 === '污染' && x.Judge === '干净') cmHJ.humanYesJudgeNo++;
    else if (x.人工 === '干净' && x.Judge === '污染') cmHJ.humanNoJudgeYes++;
    else cmHJ.bothNo++;
  }

  const cmHM = { bothYes: 0, humanYesKwNo: 0, humanNoKwYes: 0, bothNo: 0 };
  for (const x of decided) {
    if (x.人工 === '污染' && x.关键词法 === '污染') cmHM.bothYes++;
    else if (x.人工 === '污染' && x.关键词法 === '干净') cmHM.humanYesKwNo++;
    else if (x.人工 === '干净' && x.关键词法 === '污染') cmHM.humanNoKwYes++;
    else cmHM.bothNo++;
  }

  return { decided, unsure, pairHM, pairHJ, pairMJ, allAgree, cmHJ, cmHM };
}

/** 按抽样权重还原到总体的污染率（分层过采样的逆权重估计） */
function weightedRate(items: Array<{ w: number; y: number }>): number {
  const sw = items.reduce((s, x) => s + x.w, 0);
  if (sw === 0) return NaN;
  return items.reduce((s, x) => s + x.w * x.y, 0) / sw;
}

/** bootstrap 置信区间（重抽样本内条目，权重随条目走） */
function bootstrapCI(
  items: Array<{ w: number; y: number }>,
  rnd: () => number,
): { lo: number; hi: number } {
  if (items.length === 0) return { lo: NaN, hi: NaN };
  const n = items.length;
  const draws: number[] = [];
  for (let b = 0; b < BOOTSTRAP_N; b++) {
    const sample: Array<{ w: number; y: number }> = [];
    for (let i = 0; i < n; i++) sample.push(items[Math.floor(rnd() * n)]);
    draws.push(weightedRate(sample));
  }
  draws.sort((a, b) => a - b);
  return { lo: draws[Math.floor(0.025 * BOOTSTRAP_N)], hi: draws[Math.floor(0.975 * BOOTSTRAP_N)] };
}

const ARM_ZH: Record<string, string> = { isolated: '分支隔离（本文）', shared: '单线记忆（SCORE/DOME 式）' };

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

function buildReport(items: Item[], srcName: string): string {
  const a = analyze(items);
  const rnd = mulberry32(SEED);
  const L: string[] = [];

  const nSure = a.decided.length;
  const nAll = items.length;

  L.push('# 跨分支污染 · 人工评估报告');
  L.push('');
  L.push(`> 数据来源：\`${srcName}\``);
  L.push(`> 样本：${nAll} 条（分层抽样自 600 段总体，见 ${'`'}抽样清单_盲化密钥.json${'`'}）`);
  L.push('> 依据代码：`tests/human_eval_prepare.ts`（抽样）、`tests/human_eval_agreement.ts`（本报告）');
  L.push('');

  // 一、结论摘要
  L.push('## 一、结论摘要');
  L.push('');
  L.push(`- 人工判定「说不准」**${a.unsure.length} / ${nAll}** 条（${pct(a.unsure.length / nAll)}），其余 ${nSure} 条进入一致率计算。`);
  L.push(
    `- **人工 × Judge**：一致率 **${pct(a.pairHJ.po)}**，Cohen's κ = **${f2(a.pairHJ.kappa)}**（${kappaTier(a.pairHJ.kappa)}）。`,
  );
  L.push(
    `- **人工 × 关键词法**：一致率 **${pct(a.pairHM.po)}**，Cohen's κ = **${f2(a.pairHM.kappa)}**（${kappaTier(a.pairHM.kappa)}）。`,
  );
  L.push(`- 三方全部一致：**${a.allAgree} / ${nSure}**（${pct(a.allAgree / nSure)}）。`);
  L.push('');

  // 二、三方一致率
  L.push('## 二、三方一致率与 κ');
  L.push('');
  L.push('> 只有**一位**评审，故不做 Fleiss κ（那需要 ≥3 位评审标注同一批样本）。');
  L.push('> 下表是两两一致率与 Cohen\'s κ，外加「三方全一致」比例。');
  L.push('');
  L.push('| 对比 | n | 一致率 | Cohen\'s κ | κ 判读 |');
  L.push('|---|---:|---:|---:|---|');
  L.push(`| 人工 × Judge | ${nSure} | ${pct(a.pairHJ.po)} | ${f2(a.pairHJ.kappa)} | ${kappaTier(a.pairHJ.kappa)} |`);
  L.push(`| 人工 × 关键词法 | ${nSure} | ${pct(a.pairHM.po)} | ${f2(a.pairHM.kappa)} | ${kappaTier(a.pairHM.kappa)} |`);
  L.push(`| 关键词法 × Judge | ${nSure} | ${pct(a.pairMJ.po)} | ${f2(a.pairMJ.kappa)} | ${kappaTier(a.pairMJ.kappa)} |`);
  L.push(`| **三方全一致** | ${nSure} | ${pct(a.allAgree / nSure)} | — | — |`);
  L.push('');
  L.push('κ 判读按 Landis & Koch 通行分档：<0.21 轻微、0.21–0.40 一般、0.41–0.60 中等、');
  L.push('0.61–0.80 较强、>0.80 很强。');
  L.push('');

  // 三、Judge 混淆矩阵
  L.push('## 三、人工 × Judge 混淆矩阵');
  L.push('');
  L.push('这是本评估的核心 —— 主结果（净泄漏增量 55pp）全部由 Judge 产出，要看它偏在哪。');
  L.push('');
  L.push('| | Judge 判污染 | Judge 判干净 |');
  L.push('|---|---:|---:|');
  L.push(`| **人工判污染** | ${a.cmHJ.bothYes} | ${a.cmHJ.humanYesJudgeNo} |`);
  L.push(`| **人工判干净** | ${a.cmHJ.humanNoJudgeYes} | ${a.cmHJ.bothNo} |`);
  L.push('');
  const judgeMiss = a.cmHJ.humanYesJudgeNo;
  const judgeFalse = a.cmHJ.humanNoJudgeYes;
  L.push(`- Judge **漏判**（人工污染 / Judge 干净）：**${judgeMiss}** 条`);
  L.push(`- Judge **多报**（人工干净 / Judge 污染）：**${judgeFalse}** 条`);
  L.push(
    judgeFalse > judgeMiss
      ? '- 方向：Judge **偏多报**，即倾向把干净段判成污染 → 隔离档的 12% 可能被**高估**。'
      : judgeMiss > judgeFalse
        ? '- 方向：Judge **偏漏判**，即倾向把污染段判成干净 → 隔离档的 12% 可能被**低估**，净泄漏增量可能被**低估**。'
        : '- 两个方向的错误数相当，未见系统性偏向。',
  );
  L.push('');

  L.push('## 四、人工 × 关键词法 混淆矩阵');
  L.push('');
  L.push('| | 关键词法命中 | 关键词法未命中 |');
  L.push('|---|---:|---:|');
  L.push(`| **人工判污染** | ${a.cmHM.bothYes} | ${a.cmHM.humanYesKwNo} |`);
  L.push(`| **人工判干净** | ${a.cmHM.humanNoKwYes} | ${a.cmHM.bothNo} |`);
  L.push('');
  L.push(`- 关键词法**假阳性**（人工干净 / 词命中）：**${a.cmHM.humanNoKwYes}** 条`);
  L.push(`- 关键词法**假阴性**（人工污染 / 词未命中）：**${a.cmHM.humanYesKwNo}** 条`);
  L.push('');

  // 五、分档 + 加权还原
  L.push('## 五、分档污染率：人工 vs 两法（按抽样权重还原到 600 段总体）');
  L.push('');
  L.push('> ⚠️ 样本是**分层过采样**的（分歧段被刻意多抽），所以样本内的比例**不能**直接当总体比例。');
  L.push('> 下表用逆概率权重还原；括号内为 bootstrap 95% 区间（重抽 2000 次，固定种子）。');
  L.push('');
  L.push('| 档位 | 人工 | Judge | 关键词法 |');
  L.push('|---|---:|---:|---:|');
  for (const arm of ['isolated', 'shared'] as const) {
    const sub = items.filter((x) => x.档位 === arm);
    const mk = (pick: (x: Item) => Rating) => {
      // 「说不准」不计入分子也不计入分母（保守：不猜测）
      const usable = sub.filter((x) => pick(x) === '污染' || pick(x) === '干净');
      const arr = usable.map((x) => ({ w: x.抽样权重, y: pick(x) === '污染' ? 1 : 0 }));
      const r = weightedRate(arr);
      const ci = bootstrapCI(arr, rnd);
      return `${pct(r)} [${pct(ci.lo)}, ${pct(ci.hi)}]`;
    };
    L.push(`| ${ARM_ZH[arm]} | ${mk((x) => x.人工)} | ${mk((x) => x.Judge)} | ${mk((x) => x.关键词法)} |`);
  }
  L.push('');

  const armItems = (arm: 'isolated' | 'shared', pick: (x: Item) => Rating) =>
    items
      .filter((x) => x.档位 === arm && (pick(x) === '污染' || pick(x) === '干净'))
      .map((x) => ({ w: x.抽样权重, y: pick(x) === '污染' ? 1 : 0 }));

  const isoHuman = weightedRate(armItems('isolated', (x) => x.人工));
  const sharedHuman = weightedRate(armItems('shared', (x) => x.人工));
  const gapHuman = sharedHuman - isoHuman;

  /**
   * 差值本身的 bootstrap 区间 —— 论文要报的是这个数，必须给区间。
   * 两档的条目互不重叠，故各自独立重抽后相减。
   */
  const gapCI = (() => {
    const A = armItems('isolated', (x) => x.人工);
    const B = armItems('shared', (x) => x.人工);
    if (A.length === 0 || B.length === 0) return { lo: NaN, hi: NaN };
    const draws: number[] = [];
    for (let b = 0; b < BOOTSTRAP_N; b++) {
      const sa: typeof A = [];
      const sb: typeof B = [];
      for (let i = 0; i < A.length; i++) sa.push(A[Math.floor(rnd() * A.length)]);
      for (let i = 0; i < B.length; i++) sb.push(B[Math.floor(rnd() * B.length)]);
      draws.push(weightedRate(sb) - weightedRate(sa));
    }
    draws.sort((x, y) => x - y);
    return { lo: draws[Math.floor(0.025 * BOOTSTRAP_N)], hi: draws[Math.floor(0.975 * BOOTSTRAP_N)] };
  })();

  L.push(
    `**人工口径的净泄漏增量** = 单线 ${pct(sharedHuman)} − 隔离 ${pct(isoHuman)} = ` +
      `**${pct(gapHuman)}**  ［bootstrap 95% 区间 ${pct(gapCI.lo)}, ${pct(gapCI.hi)}］`,
  );
  const jIso = weightedRate(armItems('isolated', (x) => x.Judge));
  const jSha = weightedRate(armItems('shared', (x) => x.Judge));
  const kIso = weightedRate(armItems('isolated', (x) => x.关键词法));
  const kSha = weightedRate(armItems('shared', (x) => x.关键词法));
  const gapJudge = jSha - jIso;

  L.push('');
  L.push('| 口径 | 隔离档 | 单线档 | 净泄漏增量 |');
  L.push('|---|---:|---:|---:|');
  L.push(`| **人工**（本评估） | ${pct(isoHuman)} | ${pct(sharedHuman)} | **${pct(gapHuman)}** |`);
  L.push(`| Judge（原主结果） | ${pct(jIso)} | ${pct(jSha)} | **${pct(gapJudge)}** |`);
  L.push(`| 关键词法 | ${pct(kIso)} | ${pct(kSha)} | ${pct(kSha - kIso)} |`);
  L.push('');

  // 人工口径与 Judge 口径差多少：决定主结果能不能说"经人工锚定"
  const gapDiff = Math.abs(gapHuman - gapJudge);
  const overReport = a.cmHJ.humanNoJudgeYes;
  const underReport = a.cmHJ.humanYesJudgeNo;
  const balanced = Math.abs(overReport - underReport) <= Math.max(2, Math.round(0.25 * (overReport + underReport)));

  L.push(`人工口径与 Judge 口径的差值为 **${pct(gapDiff)}**（${pct(gapHuman)} vs ${pct(gapJudge)}）。`);
  L.push('');
  if (gapDiff <= 0.10) {
    L.push(
      `✅ **两个口径的净泄漏增量基本吻合，主结果得到人工锚定。**论文可写：` +
        `「净泄漏增量经人工抽样核验，与自动判定一致（${pct(gapHuman)} vs ${pct(gapJudge)}）」。`,
    );
  } else if (gapDiff <= 0.20) {
    L.push(
      `⚠️ **两个口径有可察觉的差距（${pct(gapDiff)}）。**主结果方向不变，但引用 55pp 这类` +
        `具体数字时应附上人工口径的区间，不要单独引用 Judge 的数字。`,
    );
  } else {
    L.push(
      `❌ **两个口径差距明显（${pct(gapDiff)}），Judge 很可能高估了效应。**` +
        `主结果必须以人工口径为准，或回头修 Judge 的判定标准后重跑。`,
    );
  }
  L.push('');
  L.push(
    '> ⚠️ **§三 与 §五 的口径不同，单个档位的符号可能对不上，这不是矛盾。**' +
      '§三 的方向判读来自**未加权**的混淆矩阵（同一批条目上 Judge 与人工谁报得多）；' +
      '§五 是**按逆概率权重还原到总体**的估计，而权重本身是按**自动标签**分层算的，' +
      '人工标签在层内还会变动，故加权后个别档位的符号可能与未加权时相反。' +
      '**稳健的量是「净泄漏增量」这个差值**，而非任一口径下单档的绝对水平——' +
      '单档绝对值的区间很宽（见上表），不宜单独引用。',
  );
  L.push('');
  if (balanced) {
    L.push(
      `**为什么「逐段一致率只是中等（§二）却仍能锚定聚合结论」**：见 §三，Judge 的误判在` +
        `两个方向上数量相近（多报 ${overReport} / 漏判 ${underReport}），逐段的噪声在**求率时相互抵消**，` +
        `所以**率**接近无偏，而**逐段标签**不宜单独引用。这两件事必须一起报告，只报其一都会误导。`,
    );
  } else {
    L.push(
      `⚠️ **但 Judge 的误判并不对称**（多报 ${overReport} / 漏判 ${underReport}），` +
        `这个方向的偏置会**直接传导到率上**，故上面的聚合吻合不能被当作 Judge 无偏的证据——` +
        `逐段偏置与聚合吻合同时存在，须并列报告并解释。`,
    );
  }
  L.push('');

  // 六、分歧明细
  const disagree = a.decided.filter((x) => x.人工 !== x.Judge || x.人工 !== (x.关键词法 as Label));
  L.push(`## 六、三方未全一致的条目（${disagree.length} 条）`);
  L.push('');
  if (disagree.length === 0) {
    L.push('无。');
  } else {
    L.push('| 编码 | 故事 | 段 | 人工 | 关键词法 | Judge | Judge 原句 |');
    L.push('|---|---|---:|---|---|---|---|');
    for (const x of disagree.slice(0, 60)) {
      const ev = x.Judge原句 ? x.Judge原句.slice(0, 28).replace(/\n/g, ' ') + '…' : '';
      L.push(
        `| ${x.编码} | ${x.故事} | ${x.段号} | **${x.人工}** | ${x.关键词法} | ${x.Judge} | ${ev} |`,
      );
    }
    if (disagree.length > 60) L.push(`\n> 仅列前 60 条，共 ${disagree.length} 条。`);
  }
  L.push('');

  // 七、限制
  L.push('## 七、本评估的限制（必须写进论文）');
  L.push('');
  L.push('1. **单一评审**：无 inter-rater reliability，无法排除个人判读偏好。');
  L.push('   论文只能写「经一位标注者抽样核验」，**不能**写「三方 Fleiss κ」或「多位标注者一致」。');
  L.push('2. **评审非盲于研究假设**：标注者即评测方法的设计者，知道 Judge 的构造。');
  L.push('   盲化只隐藏了每条样本的档位与两法结论，无法隐藏整体设计，存在期望偏差风险。');
  L.push(`3. **样本量小**：${nAll} 条，分档后每档更少，bootstrap 区间偏宽，仅作粗筛。`);
  L.push('4. **分层过采样**：样本内比例不代表总体，已用逆概率权重还原，但权重跨度大');
  L.push('   （最大 87.5），少数条目主导某些层的估计，稳健性有限。');
  L.push('5. **普查层故事集中**：关键词法漏判而 Judge 判污染的段（假阴性）在数据里本身就聚集，');
  L.push('   少数故事占了多数，故该方向的证据故事多样性有限。');
  L.push('6. **仅一轮分叉设计**：结论只适用于本实验的 20 组冲突分支设计。');
  L.push('');

  return L.join('\n');
}

// ---------------------------------------------------------------------------
// 自检：用合成判定跑通全链路
// ---------------------------------------------------------------------------

/**
 * 自检用的合成判定 —— **不是真实人工数据**。
 *
 * 刻意让合成判定与 Judge 有约 85% 一致、并引入少量偏置，用于验证统计口径
 * 与报告渲染是否正常。`--selftest` **只打印到终端，绝不写报告文件**，
 * 避免把合成数据混进仓库当成真实结果。
 */
function synthesize(key: KeyRow[]): Map<string, Rating> {
  const rnd = mulberry32(12345);
  const out = new Map<string, Rating>();
  for (const r of key) {
    const j = r.Judge as Label;
    if (rnd() < 0.05) out.set(r.编码, '说不准');
    else if (rnd() < 0.85) out.set(r.编码, j);
    else out.set(r.编码, j === '污染' ? '干净' : '污染');
  }
  return out;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function main(): void {
  const argv = process.argv.slice(2);
  const selftest = argv.includes('--selftest');
  const inputArg = argv.find((a) => a.startsWith('--input='));
  const inputPath = inputArg ? resolve(inputArg.slice('--input='.length)) : DEFAULT_INPUT;
  const srcName = selftest ? '（自检合成数据，非真实人工判定）' : inputPath;

  const key = loadKey();
  const ratings = selftest ? synthesize(key) : loadRatings(inputPath);

  const missing = key.filter((k) => !ratings.has(k.编码));
  if (missing.length > 0) {
    console.warn(`\n⚠️ 还有 ${missing.length} 条没有判定：${missing.map((m) => m.编码).join(' ')}`);
    console.warn('   这些条目会被排除在一致率之外（结果是部分的）。\n');
  }

  const items: Item[] = key
    .filter((k) => ratings.has(k.编码))
    .map((k) => ({ ...k, 人工: ratings.get(k.编码)! }));

  if (items.length === 0) throw new Error('没有任何可用判定，检查 CSV 的「编码」列是否与抽样清单对得上');

  const report = buildReport(items, srcName);

  if (selftest) {
    console.log('══════════ 自检（合成数据，不写文件）══════════\n');
    console.log(report);
    console.log('\n══════════ 自检结束：未写入任何报告文件 ══════════');
    return;
  }

  writeFileSync(OUT_PATH, report, 'utf-8');
  const a = analyze(items);
  console.log('══════════════════════════════════════════════════════════');
  console.log(`人工评估报告 → ${OUT_PATH}`);
  console.log('══════════════════════════════════════════════════════════');
  console.log(`  有效判定      ${a.decided.length} / ${items.length}（说不准 ${a.unsure.length}）`);
  console.log(`  人工 × Judge  一致 ${pct(a.pairHJ.po)}  κ=${f2(a.pairHJ.kappa)}`);
  console.log(`  人工 × 关键词法 一致 ${pct(a.pairHM.po)}  κ=${f2(a.pairHM.kappa)}`);
  console.log(`  三方全一致    ${pct(a.allAgree / a.decided.length)}`);
}

main();
