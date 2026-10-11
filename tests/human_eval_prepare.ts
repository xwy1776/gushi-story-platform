/**
 * 人工评估 · 第一步：建段级队列 → 分层抽样 → 生成盲评表
 *
 * 运行：`npx tsx tests/human_eval_prepare.ts`
 *
 * ## 为什么需要人工评估
 *
 * 论文主结果（实验 B：单线档 67% → 隔离档 12%，净泄漏增量 55pp）**完全由两个
 * 自动指标产出**——关键词法与 LLM-as-Judge。而《评测方法说明.md》§七.4 记着
 * 「**无人工标注锚定**」。人工判定是第三方基准，用来回答：Judge 那 55pp 可信吗？
 *
 * ## 公平性原则（关键，别搞错）
 *
 * **人工看到的上下文必须与 Judge 完全一致**：同一份 `factsForJudge`、同一段正文、
 * 同一套判定标准。少给信息会让人工处于劣势，算出来的「一致率」就成了信息量差异
 * 而不是能力差异。故本脚本从 `tests/ab_branch_isolation.ts` 源码里**抽取** FORKS。
 *
 * ⚠️ **不能 import 那个文件**：它末尾是无守卫的裸 `main()`，import 会直接触发
 * 整套实验（连库 + 调 API + 改数据库）。所以这里用括号扫描把 `const FORKS` 的
 * 数组字面量抠出来求值——该字面量是纯数据，可以安全求值（若含反引号会直接报错，
 * 见 extractForks）。
 *
 * ## 抽样设计
 *
 * 全量 600 段（3 轮 × 20 组 × 2 档 × 5 段）按 档位 × 关键词法 × Judge 分 8 层。
 * 分层情况极不均衡：144 条分歧里 **133 条是同一个方向**（关键词命中、Judge 判干净
 * ＝假阳性），反方向只有 11 条。所以**不能"分歧段全抽"**——那样样本会被假阳性
 * 淹没，也没法反推总体。改为**分层抽样 + 报告时按层加权还原到总体**。
 *
 * 产出落在 `Docs/ablation/human_eval/`。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, join } from 'path';

const ROOT = resolve(__dirname, '..');
const OUT_DIR = join(ROOT, 'Docs', 'ablation');
const EVAL_DIR = join(OUT_DIR, 'human_eval');

/** 本轮实验的三轮数据（按时间戳升序＝轮 1/2/3） */
const ROUND_FILES = [
  'branch_isolation_n20_2026-10-06T05-40-28.json',
  'branch_isolation_n20_2026-10-06T06-20-41.json',
  'branch_isolation_n20_2026-10-06T07-01-03.json',
];

/**
 * 抽样配额：8 个层各抽多少，合计 36。
 *
 * 配额要同时服务两个目标，而这两个目标想要的方向是相反的：
 *
 *   ① **诊断分歧**（论文里"关键词法不可靠"的证据）—— 想要多抽分歧层
 *   ② **还原总体污染率**（给 Judge 的 55pp 做锚定）—— 想要按总体比例抽
 *
 * 8 个层的大小极不均（最小的层 2 条，最大的 192 条），所以纯按目标 ① 抽会让
 * 「都判干净」那两层只抽到 1–2 条、权重飙到 87.5（两个条目代表 175 段），
 * 加权估计的 bootstrap 区间宽到没法看。故这里做了折中：普查层全取（不可让），
 * 其余层在"覆盖 8 格"的前提下，**给主导层多分一点**，把最大权重压到 48。
 *
 * 「假阴性」两格是**普查**（该层总共就只有 2 条 / 9 条，全取），因为它们是
 * Judge 相对关键词法**多抓出来**的段 —— 人工若认同，说明 Judge 确实在补关键词
 * 法的漏；人工若否定，说明 Judge 那部分判定是凭空多报。这是最关键的证据，不能抽样。
 * 注意该方向在数据里本身聚集（完璧归赵等少数故事占了多数），故事多样性有限，
 * 这一点已写进报告的「限制」。
 *
 * 若要更紧的总体估计，得加大 n 并继续向主导层倾斜（见 human_eval_agreement.ts
 * 报告 §五 的区间宽度）。
 */
const QUOTA = {
  // kw = 关键词法命中, jd = Judge 判污染
  'isolated|false|true': 2, // 假阴性（去重后仅 2 条，全取）
  'shared|false|true': 6, // 假阴性（去重后仅 6 条，全取）
  'isolated|true|false': 8, // 假阳性
  'shared|true|false': 5, // 假阳性
  'isolated|true|true': 4, // 一致：都判污染
  'shared|true|true': 4, // 一致：都判污染
  'isolated|false|false': 4, // 一致：都判干净
  'shared|false|false': 3, // 一致：都判干净
} as const;

/**
 * 单个故事最多出现几次。
 *
 * 不加这条约束时 `完璧归赵` 曾占到 5/36，评审会觉得「翻来覆去就这几个故事」。
 * 该故事在数据里本就占比高（假阴性事件聚集），故仍需允许它多出现几次，
 * 但设上限以免主导样本。
 */
const MAX_PER_STORY = 3;

/** 同一个 (故事, 档位) 最多抽几条，避免一个故事主导样本、也降低被认出规律的风险 */
const MAX_PER_STORY_ARM = 2;

/** 固定种子 —— 抽样必须可复现，论文里的样本要能被复算出来 */
const SEED = 20261006;

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** mulberry32：小巧的确定性 PRNG。不用 Math.random 是为了抽样可复现 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(xs: T[], rnd: () => number): T[] {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 样本指纹（djb2）—— 盲评表用它判断浏览器里存的作答是否还属于当前这一版样本。
 * 不是密码学哈希，只用来发现"表换了"，够用。
 */
function fingerprintOf(items: Array<{ 编码: string; content: string }>): string {
  let h = 5381;
  const s = items.map((i) => `${i.编码}:${i.content}`).join('|');
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

// ---------------------------------------------------------------------------
// 从源码抽取 FORKS
// ---------------------------------------------------------------------------

type BranchFacts = { label: string; factsForJudge: string; markers: string[] };
type ForkDef = { story: string; forkPoint: string; branchA: BranchFacts; branchB: BranchFacts };

/**
 * 用括号扫描抠出 `const FORKS: ForkDef[] = [ ... ]` 的字面量并求值。
 *
 * 扫描时跟踪字符串状态与转义，因此字面量里出现的 `]` `}` 不会提前截断
 * （与 `src/lib/*` 里解析 AI 输出的括号匹配是同一套思路）。
 * 出现反引号直接报错 —— 模板字面量里的 `${}` 会让这个朴素扫描失效，
 * 与其静默出错，不如喊出来。
 */
function extractForks(): ForkDef[] {
  const srcPath = join(ROOT, 'tests', 'ab_branch_isolation.ts');
  const src = readFileSync(srcPath, 'utf-8');

  const marker = 'const FORKS: ForkDef[] = ';
  const at = src.indexOf(marker);
  if (at < 0) throw new Error(`在 ${srcPath} 里没找到 \`${marker}\`，脚本结构变了？`);

  // 注意从 `= ` 之后开始找 —— 否则会命中类型注解 `ForkDef[]` 里的那个 `[`
  const start = src.indexOf('[', at + marker.length);
  if (start < 0) throw new Error('FORKS 数组字面量没有起始 `[`');
  let depth = 0;
  let quote: string | null = null;
  let esc = false;
  let end = -1;

  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      continue;
    }
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) throw new Error('FORKS 数组字面量没有正常闭合');

  const literal = src.slice(start, end);
  if (literal.includes('`')) {
    throw new Error('FORKS 字面量里出现了反引号，括号扫描不再可靠 —— 请改用别的方式抽取');
  }

  const forks = new Function(`return (${literal});`)() as ForkDef[];

  // 校验：20 个分叉，且每个都有可用的事实清单
  if (forks.length !== 20) throw new Error(`期望 20 个分叉，实际 ${forks.length}`);
  for (const f of forks) {
    for (const b of [f.branchA, f.branchB]) {
      if (!b?.factsForJudge) throw new Error(`${f.story} 缺少 factsForJudge`);
    }
  }
  return forks;
}

// ---------------------------------------------------------------------------
// 载入段级队列
// ---------------------------------------------------------------------------

type SegmentRow = {
  round: number;
  story: string;
  arm: 'isolated' | 'shared';
  index: number;
  content: string;
  /** 关键词法 */
  kw: boolean;
  /** Judge 法 */
  jd: boolean;
  /** 关键词法命中的标记词（仅审计用，不进盲评表） */
  hitMarkers: string[];
  /** Judge 给出的原句（仅审计用） */
  judgeEvidence: string;
};

type RunResult = {
  story: string;
  isolation: 'isolated' | 'shared';
  forkA: string;
  forkB: string;
  segments: Array<{
    index: number;
    content: string;
    hitMarkers: string[];
    judge: { contaminated: boolean; evidence: string };
  }>;
};

function loadSegments(): SegmentRow[] {
  const rows: SegmentRow[] = [];
  ROUND_FILES.forEach((f, ri) => {
    const p = join(OUT_DIR, f);
    if (!existsSync(p)) throw new Error(`找不到数据文件：${p}`);
    const items = JSON.parse(readFileSync(p, 'utf-8')) as RunResult[];
    for (const it of items) {
      for (const s of it.segments) {
        rows.push({
          round: ri + 1,
          story: it.story,
          arm: it.isolation,
          index: s.index,
          content: s.content,
          kw: (s.hitMarkers ?? []).length > 0,
          jd: s.judge?.contaminated === true,
          hitMarkers: s.hitMarkers ?? [],
          judgeEvidence: s.judge?.evidence ?? '',
        });
      }
    }
  });
  return rows;
}

const stratumKey = (r: SegmentRow) => `${r.arm}|${r.kw}|${r.jd}`;

// ---------------------------------------------------------------------------
// 分层抽样
// ---------------------------------------------------------------------------

type Sampled = SegmentRow & { 编码: string; 层: string; 抽样权重: number };

function sampleStratified(rows: SegmentRow[]): Sampled[] {
  const rnd = mulberry32(SEED);

  const used: Record<string, number> = {}; // (故事|档位) → 已抽数
  const perStory: Record<string, number> = {}; // 故事 → 已抽数
  const picked: Sampled[] = [];
  const chosenSlots = new Set<string>(); // 故事|档位|段号
  const chosenContent = new Set<string>(); // 正文逐字去重
  const slotOf = (r: SegmentRow) => `${r.story}|${r.arm}|${r.index}`;

  // 普查层优先
  const QUOTA_ENTRIES = Object.entries(QUOTA) as Array<[string, number]>;
  const censusKeys = new Set(['isolated|false|true', 'shared|false|true']);
  const ordered = [
    ...QUOTA_ENTRIES.filter(([k]) => censusKeys.has(k)),
    ...QUOTA_ENTRIES.filter(([k]) => !censusKeys.has(k)),
  ];

  for (const [key, want] of ordered) {
    const isCensus = censusKeys.has(key);
    // 普查层用**确定性顺序**（轮次→故事→段号）：去重后的可用条数与遍历顺序有关
    // （先碰到哪一条 完璧归赵 决定拿到 5 条还是 6 条），随机顺序会让普查结果不可复现。
    // 非普查层照常打乱。呈现顺序另有全局打乱，故这里不影响盲化。
    const inStratum = rows.filter((r) => stratumKey(r) === key);
    const pool = isCensus
      ? inStratum.sort(
          (a, b) => a.round - b.round || a.story.localeCompare(b.story) || a.index - b.index,
        )
      : shuffle(inStratum, rnd);
    let got = 0;

    // 三轮放宽：①全约束 → ②放开"每故事|档位"上限 → ③再放开"每故事"上限。
    // 普查层（不可让）直接用最宽的一档，避免取不满导致权重失真。
    const passes = isCensus ? [true] : [false, 'relaxArm', 'relaxStory'] as const;
    for (const relax of passes as Array<boolean | 'relaxArm' | 'relaxStory'>) {
      for (const r of pool) {
        if (got >= want) break;
        // ① 同一段落槽位只出现一次（同故事同段号跨轮次也只留一条）
        if (chosenSlots.has(slotOf(r))) continue;
        // ② 正文逐字相同只留一条 —— 退化复读会让不同槽位产出同一段文字，
        //    不去重的话评审会对同一段文字重复打分，人为抬高一致率
        if (chosenContent.has(r.content)) continue;
        if (relax !== 'relaxStory' && !isCensus && (perStory[r.story] ?? 0) >= MAX_PER_STORY) continue;
        if (relax === false && !isCensus && (used[`${r.story}|${r.arm}`] ?? 0) >= MAX_PER_STORY_ARM) continue;

        chosenSlots.add(slotOf(r));
        chosenContent.add(r.content);
        used[`${r.story}|${r.arm}`] = (used[`${r.story}|${r.arm}`] ?? 0) + 1;
        perStory[r.story] = (perStory[r.story] ?? 0) + 1;
        const popN = rows.filter((x) => stratumKey(x) === key).length;
        picked.push({
          ...r,
          编码: '', // 打乱后统一编号
          层: key,
          抽样权重: popN / want, // 顶层按此加权还原到总体
        });
        got++;
      }
    }
    if (got < want) {
      console.warn(`  ⚠️ 层 ${key} 只取到 ${got}/${want} 条（去重后该层可用条目不足）`);
    }
  }

  // 打乱呈现顺序：避免同一故事的甲/乙相邻，露出配对规律
  const ordered2: Sampled[] = [];
  const byStory: Record<string, Sampled[]> = {};
  for (const p of shuffle(picked, rnd)) (byStory[p.story] ??= []).push(p);
  const buckets = Object.values(byStory);
  let cursor = 0;
  while (ordered2.length < picked.length) {
    const b = buckets[cursor % buckets.length];
    if (b.length) ordered2.push(b.shift()!);
    cursor++;
  }

  ordered2.forEach((p, i) => {
    p.编码 = `S${String(i + 1).padStart(2, '0')}`;
  });
  return ordered2;
}

// ---------------------------------------------------------------------------
// 盲评表（自包含 HTML）
// ---------------------------------------------------------------------------

/** 判定标准：与 ab_branch_isolation.ts 的 JUDGE_PROMPT_PREFIX 逐条对齐，不得改写 */
const RUBRIC = `请判断：这段续写是否**把故事主角放进了分支乙的地点、或让主角做了分支乙的事件**？

判定标准（务必严格按此执行）：
- 只有当主角**确实去了乙的地名、或确实做了乙的事、或确实处于乙的状态**时，才算污染
- **仅仅出现了乙分支里的历史人物名字**（例如曹操、孙权、回纥这类名人），但主角仍留在甲分支的地点、仍在做甲分支的事 —— **不算污染**
- 主角在路上偶遇某个名人、或作者凭空插入一段与乙分支设定无关的插曲 —— **不算污染**
- 提到与两条分支都无关的常识性历史背景 —— 不算污染
- 拿不准时判「干净」`;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildHtml(items: Array<{ 编码: string; story: string; forkA: BranchFacts; forkB: BranchFacts; content: string; round: number; index: number }>, fingerprint: string): string {
  const cards = items
    .map(
      (it) => `
  <article class="card" data-code="${esc(it.编码)}">
    <header>
      <span class="code">${esc(it.编码)}</span>
      <span class="story">${esc(it.story)} · 第 ${it.index} 段</span>
    </header>
    <div class="settings">
      <div class="setting a"><b>【分支甲】（正文应遵守的设定）</b><p>${esc(it.forkA.factsForJudge)}</p></div>
      <div class="setting b"><b>【分支乙】（不应出现在正文里）</b><p>${esc(it.forkB.factsForJudge)}</p></div>
    </div>
    <blockquote class="text">${esc(it.content).replace(/\n+/g, '</p><p>')}</blockquote>
    <div class="choose">
      <label><input type="radio" name="${esc(it.编码)}" value="污染"> 污染（出现了乙分支的事）</label>
      <label><input type="radio" name="${esc(it.编码)}" value="干净"> 干净（只有甲分支的事）</label>
      <label><input type="radio" name="${esc(it.编码)}" value="说不准"> 说不准</label>
    </div>
  </article>`,
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>古事 · 跨分支污染人工盲评表</title>
<style>
  :root { --fg:#1a1a1a; --muted:#666; --line:#e2e2e2; --bg:#faf9f7; --a:#2c6e49; --b:#a33; }
  * { box-sizing:border-box; }
  body { margin:0; padding:0 0 8rem; background:var(--bg); color:var(--fg);
         font:15px/1.75 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif; }
  .wrap { max-width:820px; margin:0 auto; padding:2rem 1.25rem; }
  h1 { font-size:1.5rem; margin:0 0 .25rem; }
  .lead { color:var(--muted); font-size:.9rem; margin-bottom:1.5rem; }
  .rubric { background:#fff; border:1px solid var(--line); border-left:4px solid var(--a);
            border-radius:6px; padding:1rem 1.25rem; margin-bottom:2rem; white-space:pre-wrap; font-size:.92rem; }
  .card { background:#fff; border:1px solid var(--line); border-radius:8px;
          padding:1.25rem; margin-bottom:1.25rem; }
  .card.done { border-color:#bcd; }
  .card header { display:flex; justify-content:space-between; align-items:baseline;
                 border-bottom:1px solid var(--line); padding-bottom:.6rem; margin-bottom:.9rem; }
  .code { font-weight:700; font-variant-numeric:tabular-nums; }
  .story { color:var(--muted); font-size:.88rem; }
  .settings { display:grid; gap:.6rem; margin-bottom:1rem; }
  .setting { border-radius:6px; padding:.6rem .8rem; font-size:.9rem; }
  .setting b { display:block; margin-bottom:.2rem; }
  .setting p { margin:0; }
  .setting.a { background:#f0f6f2; border-left:3px solid var(--a); }
  .setting.b { background:#fdf1f1; border-left:3px solid var(--b); }
  blockquote.text { margin:0 0 1rem; padding:.9rem 1rem; background:#f7f7f5;
                    border-radius:6px; border:1px solid #ececea; font-size:.95rem; }
  blockquote.text p { margin:0 0 .7rem; }
  blockquote.text p:last-child { margin-bottom:0; }
  .choose { display:flex; gap:1.25rem; flex-wrap:wrap; }
  .choose label { cursor:pointer; user-select:none; }
  #bar { position:fixed; left:0; right:0; bottom:0; background:#fff; border-top:1px solid var(--line);
         padding:.75rem 1.25rem; display:flex; align-items:center; gap:1rem;
         box-shadow:0 -2px 12px rgba(0,0,0,.06); }
  #bar .grow { flex:1; }
  #count { font-variant-numeric:tabular-nums; color:var(--muted); }
  button { font:inherit; padding:.5rem 1rem; border-radius:6px; border:1px solid var(--line);
           background:#fff; cursor:pointer; }
  button.primary { background:var(--a); color:#fff; border-color:var(--a); }
  button:disabled { opacity:.45; cursor:not-allowed; }
</style>
</head>
<body>
<div class="wrap">
  <h1>跨分支污染 · 人工盲评表</h1>
  <p class="lead">
    共 ${items.length} 条，判断每条续写「是否出现了<b>分支乙</b>的事」。
    顺序已随机、条目已盲化——你<b>看不到</b>它属于哪一档、也看不到关键词法与 Judge 的结论。
    选择会实时存在本机浏览器里，刷新不丢；全部答完后点右下角导出 CSV。
  </p>
  <div class="rubric"><b>判定标准（与 LLM-as-Judge 使用的完全相同）</b>

${esc(RUBRIC)}</div>
${cards}
</div>
<div id="bar">
  <span id="count">已答 0 / ${items.length}</span>
  <span class="grow"></span>
  <button id="reset">清空重来</button>
  <button id="export" class="primary">导出 CSV</button>
</div>
<script>
  var CODES = ${JSON.stringify(items.map((i) => i.编码))};
  var FP = ${JSON.stringify(fingerprint)};
  var KEY = 'gushi_human_eval_v1';
  var FPKEY = KEY + '__fp';
  var state = {};

  // 样本指纹校验：重新抽样后编码会指向不同条目，旧的作答若继续沿用就会**静默错位**
  // （把 A 条的判定记到 B 条头上）。所以指纹不一致时一律丢弃旧作答并明示。
  try {
    var savedFp = localStorage.getItem(FPKEY);
    if (savedFp === FP) {
      state = JSON.parse(localStorage.getItem(KEY) || '{}');
    } else if (localStorage.getItem(KEY)) {
      localStorage.removeItem(KEY);
      setTimeout(function () {
        alert('盲评表已更新（样本重新抽样过）。此前的作答与当前编码无法对应，已自动清空，请重新评。');
      }, 100);
    }
    // 只保留当前表里存在的编码，防止残留键干扰
    var clean = {};
    CODES.forEach(function (c) { if (state[c]) clean[c] = state[c]; });
    state = clean;
    localStorage.setItem(FPKEY, FP);
  } catch (e) { state = {}; }

  function paint() {
    var n = 0;
    CODES.forEach(function (c) {
      var card = document.querySelector('[data-code="' + c + '"]');
      var v = state[c];
      if (v) n++;
      card.classList.toggle('done', !!v);
      card.querySelectorAll('input').forEach(function (i) { i.checked = (i.value === v); });
    });
    document.getElementById('count').textContent = '已答 ' + n + ' / ' + CODES.length;
    document.getElementById('export').disabled = (n < CODES.length);
  }

  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t && t.type === 'radio') {
      state[t.name] = t.value;
      localStorage.setItem(KEY, JSON.stringify(state));
      paint();
    }
  });

  document.getElementById('reset').addEventListener('click', function () {
    if (!confirm('确定清空全部作答？')) return;
    state = {};
    localStorage.removeItem(KEY);
    paint();
  });

  document.getElementById('export').addEventListener('click', function () {
    var lines = ['编码,人工判定'];
    CODES.forEach(function (c) { lines.push(c + ',' + (state[c] || '')); });
    var blob = new Blob(['\\ufeff' + lines.join('\\r\\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '人工判定.csv';
    a.click();
  });

  paint();
</script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function main(): void {
  mkdirSync(EVAL_DIR, { recursive: true });

  console.log('══════════════════════════════════════════════════════════');
  console.log('人工评估 · 建队列与抽样');
  console.log('══════════════════════════════════════════════════════════\n');

  console.log('① 从源码抽取分叉定义（不能 import，见文件头注释）…');
  const forks = extractForks();
  const forkByStory = new Map(forks.map((f) => [f.story, f]));
  console.log(`   ${forks.length} 个分叉，事实清单齐全 ✓\n`);

  console.log('② 载入三轮段级数据…');
  const rows = loadSegments();
  console.log(`   ${rows.length} 段（应为 3 轮 × 20 组 × 2 档 × 5 段 = 600）\n`);

  const strata: Record<string, number> = {};
  for (const r of rows) strata[stratumKey(r)] = (strata[stratumKey(r)] ?? 0) + 1;
  console.log('③ 分层情况（档位 | 关键词法 | Judge）');
  for (const [k, v] of Object.entries(strata).sort()) {
    const [arm, kw, jd] = k.split('|');
    const tag = kw !== jd ? '  ← 分歧' : '';
    console.log(
      `   ${arm.padEnd(9)} kw=${kw.padEnd(5)} jd=${jd.padEnd(5)} ${String(v).padStart(4)}${tag}`,
    );
  }
  const dissent = rows.filter((r) => r.kw !== r.jd).length;
  console.log(`   分歧合计 ${dissent} / ${rows.length}（${((dissent / rows.length) * 100).toFixed(0)}%）\n`);

  console.log('④ 分层抽样…');
  const sampled = sampleStratified(rows);
  console.log(`   抽出 ${sampled.length} 条\n`);

  const pickDist: Record<string, number> = {};
  for (const s of sampled) pickDist[s.层] = (pickDist[s.层] ?? 0) + 1;
  console.log('   各层抽取数 / 层内总数：');
  for (const [k, v] of Object.entries(pickDist).sort()) {
    console.log(`   ${k.padEnd(24)} ${String(v).padStart(3)} / ${String(strata[k]).padStart(4)}   权重 ${(strata[k] / v).toFixed(1)}`);
  }
  console.log();

  // 抽样清单 = 盲化密钥，评完之前不要打开
  const key = sampled.map((s) => {
    const f = forkByStory.get(s.story)!;
    return {
      编码: s.编码,
      层: s.层,
      抽样权重: Number(s.抽样权重.toFixed(4)),
      轮次: s.round,
      故事: s.story,
      档位: s.arm,
      段号: s.index,
      关键词法: s.kw ? '污染' : '干净',
      Judge: s.jd ? '污染' : '干净',
      甲分支: f.branchA.label,
      乙分支: f.branchB.label,
      Judge原句: s.judgeEvidence,
      关键词命中: s.hitMarkers,
    };
  });

  const keyPath = join(EVAL_DIR, '抽样清单_盲化密钥.json');
  writeFileSync(keyPath, JSON.stringify(key, null, 2), 'utf-8');

  // 全量池：审计用，含每段的层与标签
  writeFileSync(
    join(EVAL_DIR, '段级样本池.json'),
    JSON.stringify(
      rows.map((r) => ({ ...r, 层: stratumKey(r), content: r.content })),
      null,
      2,
    ),
    'utf-8',
  );

  // 盲评表：只有编码 + 故事 + 甲乙设定 + 正文，没有任何档位/标签信息
  const htmlItems = sampled.map((s) => {
    const f = forkByStory.get(s.story)!;
    return {
      编码: s.编码,
      story: s.story,
      round: s.round,
      index: s.index,
      forkA: f.branchA,
      forkB: f.branchB,
      content: s.content,
    };
  });

  const htmlPath = join(EVAL_DIR, '盲评表.html');
  const fp = fingerprintOf(htmlItems.map((i) => ({ 编码: i.编码, content: i.content })));
  writeFileSync(htmlPath, buildHtml(htmlItems, fp), 'utf-8');
  console.log(`   样本指纹 ${fp}（盲评表用它丢弃旧版本的作答）`);

  // 备选：CSV 模板（不想开浏览器时手填）
  writeFileSync(
    join(EVAL_DIR, '盲评表_空.csv'),
    '﻿编码,人工判定\n' + sampled.map((s) => `${s.编码},`).join('\n') + '\n',
    'utf-8',
  );

  console.log('⑤ 产出');
  console.log(`   ${htmlPath}`);
  console.log(`     ← 【交给评审的就是这一个文件】双击用浏览器打开即可，自包含、离线可用`);
  console.log(`   ${join(EVAL_DIR, '盲评表_空.csv')}   （不想用浏览器时的 CSV 备选）`);
  console.log(`   ${keyPath}`);
  console.log(`     ← ⚠️ 盲化密钥（含档位与两法结论）。**评完之前不要打开**，否则盲评失效`);
  console.log(`   ${join(EVAL_DIR, '段级样本池.json')}   （全 600 段，审计用）`);
  console.log('\n下一步：评审填完 → 导出 人工判定.csv → npx tsx tests/human_eval_agreement.ts');
}

main();
