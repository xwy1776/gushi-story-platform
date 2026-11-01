/**
 * 人工评估 · 第二标注者：标注者间一致性
 *
 * 运行：
 *   npx tsx tests/human_eval_interrater.ts
 *   npx tsx tests/human_eval_interrater.ts --a=<path> --b=<path>
 *   npx tsx tests/human_eval_interrater.ts --selftest
 *
 * 输入：
 *   - 抽样清单_盲化密钥.json          （S01–S36 → 条目 + 关键词法/Judge）
 *   - 抽样清单_第二标注者_密钥.json    （R01–R36 → 原编码 S）
 *   - 人工判定.csv                     （标注者 A）
 *   - 人工判定_第二标注者.csv          （标注者 B）
 *
 * 产出：Docs/ablation/human_eval/标注者间一致性报告.md
 *
 * ## 口径
 *   - A×B：标注者间一致性（Cohen's κ）—— 这是补齐「单一标注者」限制的关键数字
 *   - A×Judge、B×Judge：两位标注者分别与自动判定的一致性
 *   - 共识×Judge：只在 A、B 一致的条目上，与 Judge 比较（更强的人工锚定）
 *   - A≠B：列出需裁决的条目
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';

const ROOT = resolve(__dirname, '..');
const EVAL_DIR = join(ROOT, 'Docs', 'ablation', 'human_eval');
const KEY_A = join(EVAL_DIR, '抽样清单_盲化密钥.json');
const KEY_B = join(EVAL_DIR, '抽样清单_第二标注者_密钥.json');
const DEF_A = join(EVAL_DIR, '人工判定.csv');
const DEF_B = join(EVAL_DIR, '人工判定_第二标注者.csv');
const OUT = join(EVAL_DIR, '标注者间一致性报告.md');

type Label = '污染' | '干净';
type Rating = Label | '说不准';

type KeyA = {
  编码: string; 层: string; 故事: string; 轮次: number; 档位: string; 段号: number;
  抽样权重: number;
  关键词法: Rating; Judge: Rating;
};
type KeyB = { 编码: string; 原编码: string };

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function cohenKappa(pairs: Array<[Label, Label]>): { po: number; pe: number; kappa: number } {
  const n = pairs.length;
  if (n === 0) return { po: NaN, pe: NaN, kappa: NaN };
  let a = 0, d = 0, b = 0, c = 0;
  for (const [x, y] of pairs) {
    if (x === '污染' && y === '污染') a++;
    else if (x === '干净' && y === '干净') d++;
    else if (x === '污染') b++;
    else c++;
  }
  const po = (a + d) / n;
  const pe = ((a + b) / n) * ((a + c) / n) + ((c + d) / n) * ((b + d) / n);
  return { po, pe, kappa: pe === 1 ? NaN : (po - pe) / (1 - pe) };
}

const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '—');
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '—');
function kappaTier(k: number): string {
  if (!Number.isFinite(k)) return '—';
  if (k < 0) return '差于随机';
  if (k < 0.21) return '轻微';
  if (k < 0.41) return '一般';
  if (k < 0.61) return '中等';
  if (k < 0.81) return '较强';
  return '很强';
}

function loadRatings(path: string): Map<string, Rating> {
  if (!existsSync(path)) {
    throw new Error(
      `找不到判定文件：${path}\n` +
        `请先用 盲评表_第二标注者.html 导出 CSV，重命名为 人工判定_第二标注者.csv 放到同目录。`,
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
    if (v === '污染' || v === '干净' || v === '说不准') out.set(code, v);
  }
  return out;
}

type Item = {
  s: string; story: string; round: number; arm: string; index: number;
  /** 分层抽样的逆概率权重（层内总数 / 该层抽样数） */
  w: number;
  kw: Rating; judge: Rating; a: Rating; b: Rating;
};

function analyze(items: Item[]) {
  const binary = (x: Rating): x is Label => x === '污染' || x === '干净';
  const both = items.filter((i) => binary(i.a) && binary(i.b));
  const ab = cohenKappa(both.map((i) => [i.a as Label, i.b as Label]));

  const aJudge = cohenKappa(items.filter((i) => binary(i.a)).map((i) => [i.a as Label, i.judge as Label]));
  const bJudge = cohenKappa(items.filter((i) => binary(i.b)).map((i) => [i.b as Label, i.judge as Label]));
  const aKw = cohenKappa(items.filter((i) => binary(i.a)).map((i) => [i.a as Label, i.kw as Label]));
  const bKw = cohenKappa(items.filter((i) => binary(i.b)).map((i) => [i.b as Label, i.kw as Label]));

  // 共识：只在 A、B 一致时取该标签
  const consensus = items.filter((i) => binary(i.a) && binary(i.b) && i.a === i.b);
  const cJudge = cohenKappa(consensus.map((i) => [i.a as Label, i.judge as Label]));
  const cKw = cohenKappa(consensus.map((i) => [i.a as Label, i.kw as Label]));

  const allThree = items.filter(
    (i) => binary(i.a) && binary(i.b) && i.a === i.b && i.a === i.judge,
  ).length;

  const disagree = items.filter((i) => binary(i.a) && binary(i.b) && i.a !== i.b);

  // 共识 × Judge 混淆矩阵
  const cm = { bothYes: 0, humanYesJudgeNo: 0, humanNoJudgeYes: 0, bothNo: 0 };
  for (const i of consensus) {
    if (i.a === '污染' && i.judge === '污染') cm.bothYes++;
    else if (i.a === '污染' && i.judge === '干净') cm.humanYesJudgeNo++;
    else if (i.a === '干净' && i.judge === '污染') cm.humanNoJudgeYes++;
    else cm.bothNo++;
  }

  // 分层逆概率加权：把两位标注者各自的判定还原到 600 段总体
  const weightedRate = (arm: string, pick: (i: Item) => Rating): number => {
    let sw = 0;
    let sy = 0;
    for (const i of items) {
      if (i.arm !== arm) continue;
      const v = pick(i);
      if (v !== '污染' && v !== '干净') continue;
      sw += i.w;
      if (v === '污染') sy += i.w;
    }
    return sw ? sy / sw : NaN;
  };
  const w = {
    isoA: weightedRate('isolated', (i) => i.a),
    shaA: weightedRate('shared', (i) => i.a),
    isoB: weightedRate('isolated', (i) => i.b),
    shaB: weightedRate('shared', (i) => i.b),
  };
  const gapA = w.shaA - w.isoA;
  const gapB = w.shaB - w.isoB;
  const unsureA = items.filter((i) => i.a === '说不准').length;
  const unsureB = items.filter((i) => i.b === '说不准').length;

  return {
    both, ab, aJudge, bJudge, aKw, bKw, consensus, cJudge, cKw, allThree, disagree, cm,
    w, gapA, gapB, unsureA, unsureB,
  };
}

function buildReport(items: Item[], aPath: string, bPath: string): string {
  const r = analyze(items);
  const L: string[] = [];
  const n = items.length;

  L.push('# 标注者间一致性报告');
  L.push('');
  L.push(`> 标注者 A：\`${aPath}\``);
  L.push(`> 标注者 B：\`${bPath}\``);
  L.push(`> 样本：同一批 **${n}** 条（B 的编码已通过第二份密钥映射回原编码）`);
  L.push('');

  L.push('## 一、结论摘要');
  L.push('');
  L.push(`- **标注者间一致性**（A × B）：一致率 **${pct(r.ab.po)}**，Cohen's κ = **${f2(r.ab.kappa)}**（${kappaTier(r.ab.kappa)}）。`);
  L.push(`- 标注者 A × Judge：${pct(r.aJudge.po)}，κ = ${f2(r.aJudge.kappa)}（${kappaTier(r.aJudge.kappa)}）。`);
  L.push(`- 标注者 B × Judge：${pct(r.bJudge.po)}，κ = ${f2(r.bJudge.kappa)}（${kappaTier(r.bJudge.kappa)}）。`);
  L.push(`- **共识 × Judge**（只在 A、B 一致的 ${r.consensus.length} 条上）：${pct(r.cJudge.po)}，κ = ${f2(r.cJudge.kappa)}（${kappaTier(r.cJudge.kappa)}）。`);
  L.push(`- 三方全一致（A = B = Judge）：**${r.allThree} / ${r.both.length}**（${pct(r.allThree / Math.max(1, r.both.length))}）。`);
  L.push(
    `- **加权口径**（还原到 600 段）：标注者 A 的净泄漏增量 **${pct(r.gapA)}**，标注者 B 为 **${pct(r.gapB)}**；` +
      `论文应报**范围 ${pct(Math.min(r.gapA, r.gapB))}–${pct(Math.max(r.gapA, r.gapB))}**，不能只挑一个点估计。`,
  );
  L.push(
    `- 「说不准」共 **${r.unsureA + r.unsureB}** 条（A ${r.unsureA} 条、B ${r.unsureB} 条）；上述 κ 与一致率均在去掉这些条目后计算。`,
  );
  L.push('');

  L.push('## 二、全部一致性对照');
  L.push('');
  L.push('| 对比 | n | 一致率 | Cohen\'s κ | 判读 |');
  L.push('|---|---:|---:|---:|---|');
  L.push(`| **标注者 A × 标注者 B** | ${r.both.length} | ${pct(r.ab.po)} | **${f2(r.ab.kappa)}** | ${kappaTier(r.ab.kappa)} |`);
  L.push(`| A × Judge | ${items.filter(i => i.a === '污染' || i.a === '干净').length} | ${pct(r.aJudge.po)} | ${f2(r.aJudge.kappa)} | ${kappaTier(r.aJudge.kappa)} |`);
  L.push(`| B × Judge | ${items.filter(i => i.b === '污染' || i.b === '干净').length} | ${pct(r.bJudge.po)} | ${f2(r.bJudge.kappa)} | ${kappaTier(r.bJudge.kappa)} |`);
  L.push(`| **共识 × Judge** | ${r.consensus.length} | ${pct(r.cJudge.po)} | **${f2(r.cJudge.kappa)}** | ${kappaTier(r.cJudge.kappa)} |`);
  L.push(`| A × 关键词法 | ${items.filter(i => i.a === '污染' || i.a === '干净').length} | ${pct(r.aKw.po)} | ${f2(r.aKw.kappa)} | ${kappaTier(r.aKw.kappa)} |`);
  L.push(`| B × 关键词法 | ${items.filter(i => i.b === '污染' || i.b === '干净').length} | ${pct(r.bKw.po)} | ${f2(r.bKw.kappa)} | ${kappaTier(r.bKw.kappa)} |`);
  L.push('');
  L.push('κ 判读按 Landis & Koch：<0.21 轻微、0.21–0.40 一般、0.41–0.60 中等、0.61–0.80 较强、>0.80 很强。');
  L.push('');

  L.push('## 三、加权口径：两位标注者各自的点估计');
  L.push('');
  L.push('> 样本是分层过采样的（分歧段被刻意多抽），样本内比例不能直接当总体比例。');
  L.push('> 下表用与第一位标注者相同的逆概率权重，分别还原 A、B 两人的判定。');
  L.push('');
  L.push('| 口径 | 隔离档 | 单线档 | 净泄漏增量 |');
  L.push('|---|---:|---:|---:|');
  L.push(`| 标注者 A | ${pct(r.w.isoA)} | ${pct(r.w.shaA)} | **${pct(r.gapA)}** |`);
  L.push(`| 标注者 B | ${pct(r.w.isoB)} | ${pct(r.w.shaB)} | **${pct(r.gapB)}** |`);
  L.push('');
  L.push(
    `**合并规则（写进论文）**：不把两人的点估计平均，也不事后挑一个；` +
      `报告**范围 ${pct(Math.min(r.gapA, r.gapB))}–${pct(Math.max(r.gapA, r.gapB))}**，` +
      `并说明两人的方向一致（均为大幅正增量），点估计差异来自个体判读。`,
  );
  L.push('');
  L.push('> ⚠️ 论文中**不能**写「两位标注者共同得到 57.4%」——57.4% 只是 A 的口径。');
  L.push('');

  L.push('## 四、共识 × Judge 混淆矩阵');
  L.push('');
  L.push('| | Judge 判污染 | Judge 判干净 |');
  L.push('|---|---:|---:|');
  L.push(`| **共识判污染** | ${r.cm.bothYes} | ${r.cm.humanYesJudgeNo} |`);
  L.push(`| **共识判干净** | ${r.cm.humanNoJudgeYes} | ${r.cm.bothNo} |`);
  L.push('');
  L.push(`- Judge 漏判（共识污染 / Judge 干净）：**${r.cm.humanYesJudgeNo}** 条`);
  L.push(`- Judge 多报（共识干净 / Judge 污染）：**${r.cm.humanNoJudgeYes}** 条`);
  L.push('');

  L.push(`## 五、两位标注者不一致的条目（${r.disagree.length} 条，需裁决）`);
  L.push('');
  if (r.disagree.length === 0) {
    L.push('无。两位标注者在全部条目上一致。');
  } else {
    L.push('| 编码 | 故事 | 段 | 标注者 A | 标注者 B | 关键词法 | Judge |');
    L.push('|---|---|---:|---|---|---|---|');
    for (const i of r.disagree) {
      L.push(`| ${i.s} | ${i.story} | ${i.index} | **${i.a}** | **${i.b}** | ${i.kw} | ${i.judge} |`);
    }
    L.push('');
    L.push('> 逐条证据与裁决建议见 `分歧裁决记录.md`（建议：污染 4 条、干净 1 条）。');
    L.push('> 最终裁决需由裁决人签字确认；**原始标签不覆盖**。');
  }
  L.push('');

  L.push('## 六、论文里可以怎么写');
  L.push('');
  if (Number.isFinite(r.ab.kappa) && r.ab.kappa >= 0.61) {
    L.push(`> 两位标注者在 ${r.both.length} 条样本上的 Cohen's κ = ${f2(r.ab.kappa)}（${kappaTier(r.ab.kappa)}），`);
    L.push('> 表明人工判定具有可接受的一致性；据此对自动判定进行锚定。');
  } else if (Number.isFinite(r.ab.kappa) && r.ab.kappa >= 0.41) {
    L.push(`> 两位标注者的 Cohen's κ = ${f2(r.ab.kappa)}（${kappaTier(r.ab.kappa)}），一致性中等。`);
    L.push('> 论文应报告该 κ，并在限制章节说明：人工判定本身存在分歧，');
    L.push('> 因此对自动判定的锚定应理解为「趋势层面的一致」，而非逐条精确对齐。');
  } else {
    L.push(`> ⚠️ 两位标注者的 κ 仅 ${f2(r.ab.kappa)}（${kappaTier(r.ab.kappa)}），一致性偏低。`);
    L.push('> 这本身是一个重要发现：说明「是否污染」的判定标准仍有歧义。');
    L.push('> 论文必须报告该结果，并回到判定协议（判据、示例、边界情况）重新对齐后再评。');
  }
  L.push('');
  L.push('## 七、限制');
  L.push('');
  L.push(`1. 样本量 ${n} 条，分档后更少；κ 的置信区间较宽，仅作粗筛。`);
  L.push('2. 两位标注者若来自同一研究组、且都了解研究假设，仍存在共同的期望偏差；');
  L.push('   κ 只能衡量「彼此一致」，不能消除共同偏差。');
  L.push('3. 本报告只统计二元判定；「说不准」不计入 κ，但会在不一致清单中保留原值。');
  L.push('');

  return L.join('\n');
}

function synthesize(keyA: KeyA[], keyB: KeyB[]): { a: Map<string, Rating>; b: Map<string, Rating> } {
  const rnd = mulberry32(20261016);
  const a = new Map<string, Rating>();
  const b = new Map<string, Rating>();
  for (const k of keyA) {
    const truth = k.Judge as Label;
    // A：与 Judge 约 85% 一致
    a.set(k.编码, rnd() < 0.85 ? truth : truth === '污染' ? '干净' : '污染');
  }
  for (const k of keyB) {
    const src = keyA.find((x) => x.编码 === k.原编码)!;
    const truth = src.Judge as Label;
    // B：与 A 约 75% 一致（模拟中等一致性）
    const va = a.get(src.编码)!;
    b.set(k.编码, rnd() < 0.75 ? va : va === '污染' ? '干净' : '污染');
  }
  return { a, b };
}

function main(): void {
  const argv = process.argv.slice(2);
  const selftest = argv.includes('--selftest');
  const aArg = argv.find((x) => x.startsWith('--a='));
  const bArg = argv.find((x) => x.startsWith('--b='));
  const aPath = aArg ? resolve(aArg.slice(4)) : DEF_A;
  const bPath = bArg ? resolve(bArg.slice(4)) : DEF_B;

  const keyA = JSON.parse(readFileSync(KEY_A, 'utf-8')) as KeyA[];
  const keyB = JSON.parse(readFileSync(KEY_B, 'utf-8')) as KeyB[];
  if (keyB.length !== keyA.length) throw new Error(`两份密钥条数不一致：A=${keyA.length}, B=${keyB.length}`);

  let aMap: Map<string, Rating>;
  let bMap: Map<string, Rating>;
  if (selftest) {
    const s = synthesize(keyA, keyB);
    aMap = s.a; bMap = s.b;
  } else {
    aMap = loadRatings(aPath);
    bMap = loadRatings(bPath);
  }

  const items: Item[] = keyB.map((kb) => {
    const ka = keyA.find((x) => x.编码 === kb.原编码);
    if (!ka) throw new Error(`第二份密钥的原编码 ${kb.原编码} 在 A 密钥里不存在`);
    return {
      s: kb.原编码, story: ka.故事, round: ka.轮次, arm: ka.档位, index: ka.段号,
      w: ka.抽样权重,
      kw: ka.关键词法, judge: ka.Judge,
      a: aMap.get(kb.原编码) ?? '说不准',
      b: bMap.get(kb.编码) ?? '说不准',
    };
  });

  const missingA = items.filter((i) => !aMap.has(i.s)).length;
  const missingB = items.filter((i) => !bMap.has(keyB.find((k) => k.原编码 === i.s)!.编码)).length;
  if (missingA || missingB) {
    console.warn(`⚠️ 缺失判定：A ${missingA} 条，B ${missingB} 条（按「说不准」处理）。`);
  }

  const report = buildReport(items, selftest ? '（自检合成数据）' : aPath, selftest ? '（自检合成数据）' : bPath);

  if (selftest) {
    console.log('══════ 自检（合成数据，不写文件）══════\n');
    console.log(report);
    return;
  }

  writeFileSync(OUT, report, 'utf-8');
  const r = analyze(items);
  console.log('══════════════════════════════════════');
  console.log(`报告 → ${OUT}`);
  console.log('══════════════════════════════════════');
  console.log(`  标注者 A × B  一致 ${pct(r.ab.po)}  κ=${f2(r.ab.kappa)}`);
  console.log(`  A × Judge      一致 ${pct(r.aJudge.po)}  κ=${f2(r.aJudge.kappa)}`);
  console.log(`  B × Judge      一致 ${pct(r.bJudge.po)}  κ=${f2(r.bJudge.kappa)}`);
  console.log(`  共识 × Judge   一致 ${pct(r.cJudge.po)}  κ=${f2(r.cJudge.kappa)}`);
  console.log(`  需裁决条目     ${r.disagree.length} 条`);
}

main();
