/**
 * Build the v1.1 review draft from the maintained section drafts.
 *
 * The source files keep their original section numbering because they contain
 * many cross-references. The v1.1 file is an editorial assembly for review,
 * not a camera-ready layout.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DOCS = path.join(ROOT, 'Docs', 'ablation');
const OUT = path.join(DOCS, '古事论文_v1.1_20261031.md');

const PARTS = [
  ['论文_引言与方法_草稿.md', '第一部分 · 引言与方法'],
  ['论文_评测方法_草稿.md', '第二部分 · 评测方法'],
  ['论文_实验与结果_草稿.md', '第三部分 · 实验与结果'],
  ['论文_相关工作_草稿.md', '第四部分 · 相关工作'],
];

function readPart(file) {
  const raw = fs.readFileSync(path.join(DOCS, file), 'utf8').replace(/\r\n/g, '\n');
  const lines = raw.split('\n');
  let i = 0;
  if (lines[0] && lines[0].startsWith('# ')) i = 1;
  while (i < lines.length && lines[i].trim() === '') i++;
  const quote = [];
  while (i < lines.length && (lines[i].startsWith('>') || lines[i].trim() === '')) {
    quote.push(lines[i]);
    i++;
    if (lines[i] && lines[i].trim() === '---') {
      i++;
      break;
    }
  }
  return { body: lines.slice(i).join('\n').trim(), note: quote.join('\n').trim() };
}

function insertAfter(text, needle, addition) {
  const index = text.indexOf(needle);
  if (index < 0) {
    console.warn(`insertion marker not found: ${needle.slice(0, 50)}`);
    return text;
  }
  const end = text.indexOf('\n\n', index);
  if (end < 0) return `${text}\n\n${addition}`;
  return `${text.slice(0, end)}\n\n${addition}${text.slice(end)}`;
}

function stripFirstH1(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[0] && lines[0].startsWith('# ')) lines.shift();
  while (lines.length && lines[0].trim() === '') lines.shift();
  return lines.join('\n').trim();
}

const intro = readPart(PARTS[0][0]);
const evalPart = readPart(PARTS[1][0]);
const experiments = readPart(PARTS[2][0]);
const related = readPart(PARTS[3][0]);

let introBody = intro.body;
introBody = insertAfter(
  introBody,
  '关键设计是**检索与回写的每一步都携带 `branchId`**',
  [
    '![图 1 分支感知记忆参考管线](figures/fig1_pipeline.png)',
    '',
    '> **图 1** 分支感知记忆参考管线。写入时打标、读取时按 `branchId` 过滤；新段落继续回写当前分支。',
  ].join('\n'),
);

let experimentBody = experiments.body;
experimentBody = insertAfter(
  experimentBody,
  '#### RQ4：分支隔离能否抑制跨分支事实泄漏？',
  [
    '![图 2 跨分支污染基准与评测协议](figures/fig2_benchmark.png)',
    '',
    '> **图 2** 跨分支污染基准的构造与三档评测协议。每条分叉的两侧都必须是非标准历史。',
  ].join('\n'),
);
experimentBody = insertAfter(
  experimentBody,
  '## 2. 结果',
  [
    '![图 3 主要实验结果](figures/fig3_results.png)',
    '',
    '> **图 3** 主要实验结果。(a) 实验 A 四档消融；(b) 实验 B 两档主分析；(c) 三档同轮外部 RAG 对照。',
    '> 注意：两档主结果为 12% / 67%，三档重跑为 5% / 12% / 61%，两组绝对值来自不同跑批，不能混合汇报。',
  ].join('\n'),
);

const abstractAndConclusion = stripFirstH1(
  fs.readFileSync(path.join(DOCS, '论文_摘要与结论_草稿.md'), 'utf8'),
);
const conclusionMarker = '\n# 结论';
const conclusionIndex = abstractAndConclusion.indexOf(conclusionMarker);
if (conclusionIndex < 0) throw new Error('conclusion marker not found');
const abstract = abstractAndConclusion.slice(0, conclusionIndex).trim();
const conclusion = abstractAndConclusion.slice(conclusionIndex + 1).trim();
const references = stripFirstH1(fs.readFileSync(path.join(DOCS, '论文_参考文献_草稿.md'), 'utf8'));

const out = [];
const add = (line = '') => out.push(line);

add('# 古事（Gushi）· 多分支叙事的一致性维护');
add('');
add('**论文 v1.1 · 内部评审稿**');
add('');
add('> 汇总日期：2026-10-31 ｜ 汇总：肖文宇');
add('> 本稿由仓库 `Docs/ablation/` 下四份分章草稿、摘要/结论与参考文献合并而成。');
add('> 数据以落盘 JSON 与生成报告为准；本稿中的两档主结果与三档 RAG 对照严格分开。');
add('');
add('---');
add('');
add('## 版本说明');
add('');
add('### v1.1 相对 2026-10-19 合并稿的改动');
add('');
add('1. 写入 RAG 三档正式结果，并明确“显著优于单线结构化记忆、与 RAG 差异不显著”的边界；');
add('2. 人工评估更新为两位组内标注者，报告 κ = 0.668 与人工净增量 57.4%–69.9%；');
add('3. 新增摘要、关键词、结论、参考文献工作版；');
add('4. 新增三张论文用图（参考管线、基准协议、主要结果）；');
add('5. 统一全稿的 RAG 与人工评估口径，避免把不同跑批或不同标注者的数字混写。');
add('');
add('### 当前仍待补的实验性材料');
add('');
add('| 项 | 状态 | 对本稿的影响 |');
add('|---|---|---|');
add('| 图像层人工 κ | 待补 | 正文只写文本层强、图像层方向性，不写显著 |');
add('| KG 真实 P/R/F1 | 待补 | 本稿不把 KG 评测作为已完成结果 |');
add('| 第二基础模型 | 未做 | 写入限制，不作跨模型泛化声明 |');
add('| embedding RAG / top-k 敏感性 | 未做 | 当前只声明 BM25 top-3 |');
add('| 正式排版与统一编号 | 待编辑 | 本稿保留四部分源编号，便于审计与交叉引用 |');
add('');
add('---');
add('');
add(abstract);
add('');
add('---');
add('');

for (const [file, title] of PARTS) {
  const source = file === PARTS[0][0]
    ? { body: introBody, note: intro.note }
    : file === PARTS[1][0]
      ? evalPart
      : file === PARTS[2][0]
        ? { body: experimentBody, note: experiments.note }
        : related;
  add(`# ${title}`);
  add('');
  if (source.note) {
    add(source.note);
    add('');
  }
  add(source.body);
  add('');
  add('---');
  add('');
}

add(conclusion);
add('');
add('---');
add('');
add('# 参考文献');
add('');
add(references);
add('');
add('---');
add('');
add('## 附录：数据与代码的可核查处');
add('');
add('```bash');
add('cd D:/项目/Another-chance-new');
add('npx tsc --noEmit');
add('npm test');
add('npx tsx tests/ab_ablation.ts --report-only');
add('npx tsx tests/ab_branch_isolation.ts --report-only --out=branch20_rounds_report.md');
add('```');
add('');
add('主要数据：');
add('');
add('- 实验 A：`ablation_results_*s30x5seg*.json`、`s30_rounds_report.md`、`s30_robustness.md`；');
add('- 实验 B 两档主分析：`branch_isolation_n20_2026-10-06T*.json`、`branch20_rounds_report.md`；');
add('- 实验 B 三档 RAG 对照：`branch_isolation_n20_rag20_*.json`、`branch20_rag_report.md`；');
add('- 人工评估：`human_eval/人工评估报告.md`、`human_eval/标注者间一致性报告.md`；');
add('- 论文图：`figures/fig1_pipeline.png`、`fig2_benchmark.png`、`fig3_results.png`。');
add('');

const rendered = out.join('\n');
fs.writeFileSync(OUT, rendered, 'utf8');
console.log(`wrote ${OUT}`);
console.log(`${rendered.split('\n').length} lines, ${Buffer.byteLength(rendered, 'utf8')} bytes`);
