/**
 * LLM-as-Judge 多维打分器（NCI-2.0 风格）
 *
 * 用大模型给「故事续写文本」打四个维度的分，每维 1–5 分 + 一句理由：
 *
 *   ① 角色稳定 (character) —— 性格/身份/说话方式是否与设定和前文一致，有无 OOC
 *   ② 事件因果 (causality) —— 事件间因果链是否成立，动机是否充分，有无突兀转折
 *   ③ 时间线连续 (timeline) —— 时间推进是否连贯，与前文地/时是否矛盾
 *   ④ 情感连贯 (emotion)   —— 情感基调是否连贯、过渡是否有层次
 *
 * ── 为什么要自己写 API 调用，而不用 src/lib/ai-client.ts ──────────────
 * 打分器要求**可复现**，temperature 必须能压到 0。但 `ai-client.ts` 的
 * `buildOpenAIRequest()` 把 temperature 写死成按题材算出的 0.4 / 0.5 / 0.6
 * （见该文件 `getGenerationParams`），调用方没有任何覆盖入口。
 * 因此这里自建一个最小 fetch 封装（含 429/5xx 指数退避），只复用 ai-client
 * 里那个纯函数的 `extractJsonFromAI()` 来兜底解析。
 *
 * ── 研究背景 ─────────────────────────────────────────────────────────
 * 消融实验（tests/ab_ablation.ts）原先依赖词汇级指标「相邻段重复度均值」，
 * 但 4 轮数据表明该指标被稀疏的退化复读事件支配，轮间差大于档间差 —— 即
 * 指标失效。本打分器提供**语义层面**的四维质量分，作为词汇级指标的补充。
 *
 * ── 运行 ────────────────────────────────────────────────────────────
 *   # 拿 2 个故事试跑（默认 3 次采样取中位数）
 *   npx tsx tests/llm_judge.ts --stories=桃园结义,张骞出使西域
 *
 *   # 只跑 4 条、每次采样 5 遍，专门看打分稳不稳
 *   npx tsx tests/llm_judge.ts --limit=4 --repeats=5
 *
 *   # 不调 API，只把 prompt 打出来检查（省钱调试）
 *   npx tsx tests/llm_judge.ts --dry-run --limit=1
 *
 *   # 评任意一段文本
 *   npx tsx tests/llm_judge.ts --text=path/to/story.txt --story-title=桃园结义
 *
 * 结果输出到 Docs/ablation/ 目录（JSON + Markdown）。
 * 本脚本不连接数据库，无需启动 postgres。
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs';
import { join, resolve, basename } from 'path';
import { extractJsonFromAI } from '../src/lib/ai-client';
import {
  JUDGE_STORIES,
  findStory,
  roleLabel,
  storyTitles,
  type JudgeStory,
} from './story-fixtures';

// ============================================================================
// 配置
// ============================================================================

const OUT_DIR = resolve(__dirname, '..', 'Docs', 'ablation');
const DEFAULT_INPUT = join(OUT_DIR, 'ablation_results_full_5x5.json');

/** 四个维度，顺序即报告中的列顺序 */
const DIMENSIONS = ['character', 'causality', 'timeline', 'emotion'] as const;
type Dimension = (typeof DIMENSIONS)[number];

const DIMENSION_ZH: Record<Dimension, string> = {
  character: '角色稳定',
  causality: '事件因果',
  timeline: '时间线连续',
  emotion: '情感连贯',
};

const DIMENSION_HINT: Record<Dimension, string> = {
  character: '角色的身份、性格、说话方式、能力是否与角色设定和前文一致。出现 OOC（性格偏离）、' +
    '已登场角色凭空消失、或冒出未交代来路的新角色，都要扣分。',
  causality: '事件之间是否有清晰的因果链，人物行为的动机是否成立。无铺垫的突兀转折、' +
    '行为缺乏动机、情节靠巧合硬推，都要扣分。',
  timeline: '时间推进是否连贯有序，与故事梗概/前文交代的时间、季节、地点是否矛盾，' +
    '有无倒错、跳跃失据。',
  emotion: '情感基调是否连贯、有合理的过渡与层次。情绪突变、情感扁平、' +
    '在特定情境下出现不匹配的情绪，都要扣分。',
};

/** 环境变量读取（不依赖 dotenv，评测器保持零依赖启动） */
function env(key: string, fallback: string): string {
  return process.env[key]?.trim() || fallback;
}

// ============================================================================
// 命令行参数
// ============================================================================

function parseArgs() {
  const argv = process.argv.slice(2);
  const get = (flag: string, def: string): string => {
    const hit = argv.find((a) => a.startsWith(`--${flag}=`));
    return hit ? hit.split('=').slice(1).join('=') : def;
  };

  const stories = get('stories', '').split(',').map((s) => s.trim()).filter(Boolean);
  const arms = get('arms', '').split(',').map((s) => s.trim()).filter(Boolean);

  return {
    /** 输入：消融实验结果 JSON 路径 */
    input: get('input', DEFAULT_INPUT),
    /** 批量：扫 Docs/ablation 下全部 ablation_results_*.json，并按文件分轮次 */
    all: argv.includes('--all'),
    /** 输入：任意纯文本文件（与 --input 二选一） */
    text: get('text', ''),
    /** 配合 --text：这条文本属于哪个故事（决定角色设定） */
    storyTitle: get('story-title', ''),
    /** 过滤故事（空 = 全选） */
    stories,
    /** 过滤档位（空 = 全选） */
    arms,
    /** 最多评多少条（0 = 不限制） */
    limit: parseInt(get('limit', '0'), 10),
    /** 每条重复采样几次（取中位数以抗单次波动） */
    repeats: Math.max(1, parseInt(get('repeats', '3'), 10)),
    /** 并发数 */
    concurrency: Math.max(1, parseInt(get('concurrency', '4'), 10)),
    /** 只打印 prompt 不调 API */
    dryRun: argv.includes('--dry-run'),
    /** 校验 story-fixtures 与 ab_ablation.ts 是否同步 */
    checkFixtures: argv.includes('--check-fixtures'),
    /** 输出文件名前缀 */
    outPrefix: get('out', 'judge'),
  };
}

type Args = ReturnType<typeof parseArgs>;

// ============================================================================
// Prompt 构造
// ============================================================================

const SYSTEM_PROMPT = `你是一位严格、客观的中文叙事文学评审，专门评估故事续写文本的连贯性。

你的任务是按四个维度打分，每个维度 1–5 分，并为每个维度给出一句简短理由。

【四个评分维度】

① 角色稳定（character）
${DIMENSION_HINT.character}

② 事件因果（causality）
${DIMENSION_HINT.causality}

③ 时间线连续（timeline）
${DIMENSION_HINT.timeline}

④ 情感连贯（emotion）
${DIMENSION_HINT.emotion}

【评分锚点】（四个维度各自独立套用这同一套锚点）

5 分 = 优秀：该维度全程无瑕，处理得当，无一处可指摘
4 分 = 良好：整体不错，仅有个别轻微不足，不影响阅读
3 分 = 及格：有明显问题，但不算严重，整体仍可读
2 分 = 较差：该维度多处出错，已明显影响阅读体验
1 分 = 很差：该维度严重违反，破坏文本的基本可信度

【打分纪律】

- 严格基于文本证据打分，不要因为题材著名、文笔华丽就放宽连贯性标准。
- 不要因为文本「写得美」就抬高分数；你评的是连贯性，不是文采。
- 若某维度确实无法评估（例如文本过短、该维度无从体现），给 3 分，并在理由里说明原因。
- 每条理由必须具体、指向文本中的证据，一句话，不超过 40 字。
- 不要为了显得客观而机械地回避 1 分和 5 分；该给就给。

【输出格式】

只输出一个 JSON 对象，不要输出任何其他文字、不要用 markdown 代码块包裹：

{
  "character": { "score": 整数1到5, "reason": "一句话理由" },
  "causality": { "score": 整数1到5, "reason": "一句话理由" },
  "timeline":  { "score": 整数1到5, "reason": "一句话理由" },
  "emotion":   { "score": 整数1到5, "reason": "一句话理由" }
}`;

/** 组装给 Judge 的完整上下文 + 待评文本 */
function buildUserPrompt(story: JudgeStory | undefined, segments: string[]): string {
  const parts: string[] = [];

  if (story) {
    parts.push(
      '【故事梗概】',
      `标题：${story.title}`,
      `类型：${story.genre}`,
      `梗概：${story.description}`,
      '',
      '【角色设定】（判断「角色稳定」的基准）',
      ...story.characters.map(
        (c) => `- ${c.name}（${roleLabel(c.role)}）：${c.traits.join('、')}`,
      ),
      '',
      '【前文（已发生的起始段）】',
      story.opener,
    );
  } else {
    parts.push('【说明】', '未提供故事设定，请仅依据文本自身判断内部一致性。');
  }

  parts.push(
    '',
    '【待评续写文本】',
    segments.map((s, i) => `── 第 ${i + 1} 段 ──\n${s}`).join('\n\n'),
    '',
    '请按要求对上述续写文本打分，四个维度各自独立评分，只输出 JSON。',
  );

  return parts.join('\n');
}

// ============================================================================
// API 调用（自建，temperature 可控）
// ============================================================================

interface JudgeRaw {
  character: { score: number; reason: string };
  causality: { score: number; reason: string };
  timeline: { score: number; reason: string };
  emotion: { score: number; reason: string };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 解析失败的原始输出暂存，main 结束时统一落盘，便于诊断是截断还是真非法 JSON */
const PARSE_FAILURES: Array<{ id: string; sample: number; text: string }> = [];

/**
 * 调用一次 Judge。temperature 固定为 0、seed 固定，保证可复现。
 *
 * 不做并发排队 —— 并发由上层 mapLimit 控制；这里只负责单次调用 + 重试。
 */
async function callJudgeOnce(userPrompt: string, maxRetries = 3): Promise<string> {
  const baseUrl = env('AI_BASE_URL', 'https://api.deepseek.com');
  const apiKey = env('AI_API_KEY', '');
  const model = env('AI_JUDGE_MODEL', env('AI_MODEL', 'deepseek-chat'));

  if (!apiKey) throw new Error('AI_API_KEY 未设置（应在项目根 .env 里）');

  const body = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    // 打分器要可复现：temperature=0
    temperature: 0,
    // 四维 × (分数 + ≤40字理由) 的中文 JSON 用不到 500 token；
    // 留足余量是因为一旦被截断，json_object 会返回残破 JSON 导致解析失败。
    max_tokens: 2000,
    // DeepSeek 支持 json_object，配合 prompt 里的「只输出 JSON」约束
    response_format: { type: 'json_object' },
  });

  let lastErr: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body,
        signal: AbortSignal.timeout(180_000),
      });

      if (res.ok) {
        const data = await res.json();
        return data.choices?.[0]?.message?.content ?? '';
      }

      // 429 / 5xx 退避重试
      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        const delay = Math.min(2000 * 2 ** attempt, 30_000) * (0.75 + Math.random() * 0.5);
        console.warn(`  ⚠ HTTP ${res.status}，${Math.round(delay)}ms 后重试…`);
        await sleep(delay);
        continue;
      }

      const text = await res.text().catch(() => '');
      throw new Error(`Judge API ${res.status}: ${text.slice(0, 200)}`);
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      if (attempt < maxRetries) {
        const delay = Math.min(2000 * 2 ** attempt, 30_000) * (0.75 + Math.random() * 0.5);
        console.warn(`  ⚠ ${lastErr.message.slice(0, 120)}，${Math.round(delay)}ms 后重试…`);
        await sleep(delay);
      }
    }
  }

  throw lastErr ?? new Error('callJudgeOnce: 重试耗尽');
}

/**
 * 补齐被截断的 JSON 的闭合括号。
 *
 * 实测发现：DeepSeek 在 `response_format: json_object` 下会**概率性丢掉结尾的 `}`**
 * （约 37% 命中率），且此时 `finish_reason` 仍报 `stop`、completion_tokens 也正常，
 * 调用方无法从响应元数据察觉。丢一个括号的后果不只是解析失败 ——
 * `extractJsonFromAI` 的平衡括号匹配会退而匹配到**内层**的
 * `{"score":..,"reason":..}` 并成功返回，于是拿到一个缺 `character` 等键的对象。
 *
 * 这里按括号栈补齐缺失的闭合符；字符串内部与转义符会被跳过，避免误计数。
 * 返回 null 表示压根找不到 JSON 起点，无从修复。
 */
function repairTruncatedJson(text: string): string | null {
  const trimmed = text.trim();
  const start = trimmed.search(/[{[]/);
  if (start < 0) return null;

  let body = trimmed.slice(start);
  const stack: string[] = [];
  let inString = false;
  let escape = false;

  for (const ch of body) {
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (inString) {
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }

  if (!inString && stack.length === 0) return body; // 本来就完整

  if (inString) body += '"';
  for (let i = stack.length - 1; i >= 0; i--) {
    body += stack[i] === '{' ? '}' : ']';
  }
  return body;
}

/** 校验一个已解析的对象是否四维齐全且分数合法 */
function toJudgeRaw(parsed: unknown): JudgeRaw | null {
  if (!parsed || typeof parsed !== 'object') return null;

  const out = {} as JudgeRaw;
  for (const dim of DIMENSIONS) {
    const cell = (parsed as Record<string, unknown>)[dim];
    if (!cell || typeof cell !== 'object') return null;
    const { score, reason } = cell as { score?: unknown; reason?: unknown };
    const n = typeof score === 'number' ? score : Number(score);
    if (!Number.isFinite(n) || n < 1 || n > 5) return null;
    out[dim] = {
      score: Math.round(n),
      reason: typeof reason === 'string' ? reason.trim() : '',
    };
  }
  return out;
}

/**
 * 把模型返回的文本解析成结构化分数，非法值判为解析失败。
 *
 * 分两次尝试：先按原样解析（覆盖正常情况），失败再补齐闭合括号重试
 * （覆盖 DeepSeek 概率性丢失 `}` 的情况）。次序不能反 —— 先修复会把
 * 本来就完整、但内容里含多余括号的合法输出改坏。
 */
function parseJudgeOutput(text: string): JudgeRaw | null {
  const direct = toJudgeRaw(extractJsonFromAI<Record<string, unknown>>(text));
  if (direct) return direct;

  const repaired = repairTruncatedJson(text);
  if (repaired) {
    const fixed = toJudgeRaw(extractJsonFromAI<Record<string, unknown>>(repaired));
    if (fixed) return fixed;
  }
  return null;
}

// ============================================================================
// 采样聚合
// ============================================================================

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** 一次评测的完整结果 */
interface JudgeResult {
  id: string;
  story: string;
  /** 档位（来自消融结果）；纯文本输入时为 'unknown' */
  arm: string;
  /** 轮次标签（R1..Rn / full / adhoc） */
  round: string;
  /** 数据来源文件名 */
  source: string;
  segmentCount: number;
  /** 每维取多次采样的中位数 */
  scores: Record<Dimension, number>;
  /** 四维之和，范围 4–20 */
  total: number;
  /** 每维理由 —— 取最接近中位数的那次采样的理由 */
  reasons: Record<Dimension, string>;
  /** 每维的极差（max-min），0 表示多次采样完全一致 */
  spread: Record<Dimension, number>;
  /** 采样是否全部解析成功 */
  samplesOk: number;
  samplesTotal: number;
  /** 每次采样的原始四维分，便于事后诊断 */
  rawSamples: Array<Record<Dimension, number>>;
}

/** 对一条文本跑 repeats 次采样，取中位数聚合 */
async function scoreItem(
  target: JudgeTarget,
  story: JudgeStory | undefined,
  args: Args,
): Promise<JudgeResult | null> {
  const { id, storyName, arm, round, source, segments } = target;
  const userPrompt = buildUserPrompt(story, segments);

  if (args.dryRun) {
    console.log(`\n${'='.repeat(72)}\n[DRY-RUN] ${id}\n${'='.repeat(72)}`);
    console.log('── SYSTEM ──\n' + SYSTEM_PROMPT);
    console.log('\n── USER ──\n' + userPrompt);
    return null;
  }

  const samples: JudgeRaw[] = [];
  for (let i = 0; i < args.repeats; i++) {
    try {
      const text = await callJudgeOnce(userPrompt);
      const parsed = parseJudgeOutput(text);
      if (parsed) {
        samples.push(parsed);
      } else {
        // 完整原始输出落盘：截断的 JSON 与真·非法 JSON 需要区分，
        // 只看前 120 字符会把「被 max_tokens 截断」误判成「模型不听话」。
        PARSE_FAILURES.push({ id, sample: i + 1, text });
        console.warn(`  ⚠ ${id} 第 ${i + 1} 次采样解析失败（完整输出见 parse_failures 日志）`);
      }
    } catch (e) {
      console.warn(`  ⚠ ${id} 第 ${i + 1} 次采样调用失败：${(e as Error).message.slice(0, 120)}`);
    }
  }

  if (samples.length === 0) {
    console.error(`✗ ${id} 全部采样失败，跳过`);
    return null;
  }

  const scores = {} as Record<Dimension, number>;
  const reasons = {} as Record<Dimension, string>;
  const spread = {} as Record<Dimension, number>;

  for (const dim of DIMENSIONS) {
    const vals = samples.map((s) => s[dim].score);
    const med = median(vals);
    scores[dim] = med;
    spread[dim] = Math.max(...vals) - Math.min(...vals);

    // 理由取「最接近中位数」那次采样的表述，保证理由与展示的分数对得上
    let bestIdx = 0;
    for (let i = 1; i < samples.length; i++) {
      if (Math.abs(samples[i][dim].score - med) < Math.abs(samples[bestIdx][dim].score - med)) {
        bestIdx = i;
      }
    }
    reasons[dim] = samples[bestIdx][dim].reason;
  }

  // 保留每次采样的原始四维分，便于事后诊断分歧来源
  const rawSamples = samples.map(
    (s) => Object.fromEntries(DIMENSIONS.map((d) => [d, s[d].score])) as Record<Dimension, number>,
  );

  return {
    id,
    story: storyName,
    arm,
    round,
    source,
    segmentCount: segments.length,
    scores,
    total: DIMENSIONS.reduce((sum, d) => sum + scores[d], 0),
    reasons,
    spread,
    samplesOk: samples.length,
    samplesTotal: args.repeats,
    rawSamples,
  };
}

// ============================================================================
// 输出
// ============================================================================

function formatTimestamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-` +
    `${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`
  );
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

const CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

function buildMarkdown(results: JudgeResult[], args: Args, model: string): string {
  const L: string[] = [];
  // 章节编号动态生成 —— 否则「按档位汇总」被跳过时会出现「一、三、四」的跳号
  let sec = 0;
  const heading = (title: string) => `## ${CN_NUM[++sec]}、${title}`;

  L.push('# LLM-as-Judge 四维打分报告', '');
  L.push(`> 生成时间：${new Date().toISOString()}`);
  L.push(`> Judge 模型：\`${model}\`（temperature=0）`);
  L.push(`> 采样次数：每条 ${args.repeats} 次，取中位数`);
  L.push(`> 参评条数：${results.length}`, '');

  const rounds = [...new Set(results.map((r) => r.round))];
  const multiRound = rounds.length > 1;

  L.push(heading('总览'), '');
  L.push('每个维度 1–5 分，总分 = 四维之和（范围 4–20）。', '');

  const cols = [
    ...(multiRound ? ['轮次'] : []),
    '条目',
    '档位',
    ...DIMENSIONS.map((d) => DIMENSION_ZH[d]),
    '总分',
  ];
  L.push(`| ${cols.join(' | ')} |`);
  L.push(`|${cols.map(() => '---').join('|')}|`);
  for (const r of results) {
    const cells = [
      ...(multiRound ? [r.round] : []),
      r.story,
      r.arm,
      ...DIMENSIONS.map((d) => String(r.scores[d])),
      `**${r.total}**`,
    ];
    L.push(`| ${cells.join(' | ')} |`);
  }
  L.push('');

  // 按档位汇总
  const arms = [...new Set(results.map((r) => r.arm))].filter((a) => a !== 'unknown');
  if (arms.length > 1) {
    L.push(heading('按档位汇总'), '');
    L.push(`| 档位 | 条数 | ${DIMENSIONS.map((d) => DIMENSION_ZH[d]).join(' | ')} | 总分均值 |`);
    L.push(`|---|---|${DIMENSIONS.map(() => '---').join('|')}|---|`);
    for (const arm of arms) {
      const rs = results.filter((r) => r.arm === arm);
      const cells = DIMENSIONS.map((d) => mean(rs.map((r) => r.scores[d])).toFixed(2));
      L.push(`| ${arm} | ${rs.length} | ${cells.join(' | ')} | ${mean(rs.map((r) => r.total)).toFixed(2)} |`);
    }
    L.push('');
  }

  // 跨轮汇总：同一档位在不同轮次的表现是否稳定
  // 消融实验的教训是「轮间差大于档间差」会让结论翻转，所以这一节是判断
  // 打分器给出的排序能不能站住的关键 —— 单轮好看不算数，要看轮间是否一致。
  if (multiRound) {
    L.push(heading('跨轮汇总（档位 × 轮次，总分均值）'), '');
    L.push('看两点：① 同一档位在轮次间是否稳定；② 档位排序在每轮是否一致。', '');
    L.push(`| 档位 | ${rounds.join(' | ')} | 全部均值 |`);
    L.push(`|${['---', ...rounds.map(() => '---'), '---'].join('|')}|`);
    for (const arm of arms) {
      const cells = rounds.map((rd) => {
        const rs = results.filter((r) => r.arm === arm && r.round === rd);
        return rs.length ? mean(rs.map((r) => r.total)).toFixed(2) : '—';
      });
      const all = results.filter((r) => r.arm === arm);
      L.push(`| ${arm} | ${cells.join(' | ')} | **${mean(all.map((r) => r.total)).toFixed(2)}** |`);
    }
    L.push('');

    // 每轮的档位排序 —— 排序若在各轮间漂移，说明差异还没大到能下结论
    L.push('**各轮内部排序**（总分均值从高到低）：', '');
    for (const rd of rounds) {
      const ranked = arms
        .map((arm) => {
          const rs = results.filter((r) => r.arm === arm && r.round === rd);
          return { arm, avg: rs.length ? mean(rs.map((r) => r.total)) : NaN };
        })
        .filter((x) => Number.isFinite(x.avg))
        .sort((a, b) => b.avg - a.avg);
      L.push(`- ${rd}：${ranked.map((x) => `${x.arm}(${x.avg.toFixed(1)})`).join(' > ')}`);
    }
    L.push('');
  }

  // 稳定性
  L.push(heading('打分稳定性（多次采样的极差）'), '');
  L.push('极差 = 同一文本多次采样的最大分差。**0 表示完全一致**，越大越不稳定。', '');
  const anySpread = results.some((r) => DIMENSIONS.some((d) => r.spread[d] > 0));
  if (args.repeats < 2) {
    // 单次采样时极差恒为 0，此时断言「可复现」是假的 —— 必须明确区分
    L.push(
      `⚠ **未做重复采样（repeats=${args.repeats}），本节不构成稳定性证据。** ` +
        '要评估可复现性请用 `--repeats=3` 或更高重跑。',
      '',
    );
  } else if (!anySpread) {
    L.push('✅ 所有条目、所有维度的极差均为 0 —— 打分完全可复现。', '');
  } else {
    L.push(`| 条目 | 档位 | ${DIMENSIONS.map((d) => DIMENSION_ZH[d]).join(' | ')} |`);
    L.push(`|---|---|${DIMENSIONS.map(() => '---').join('|')}|`);
    for (const r of results.filter((x) => DIMENSIONS.some((d) => x.spread[d] > 0))) {
      L.push(
        `| ${r.story} | ${r.arm} | ${DIMENSIONS.map((d) => (r.spread[d] === 0 ? '0' : `**${r.spread[d]}**`)).join(' | ')} |`,
      );
    }
    L.push('');
  }

  // 逐条理由
  L.push(heading('逐条评分理由'), '');
  for (const r of results) {
    L.push(`### ${r.story} · ${r.arm}（总分 ${r.total}）`, '');
    for (const d of DIMENSIONS) {
      L.push(`- **${DIMENSION_ZH[d]}** ${r.scores[d]}/5 —— ${r.reasons[d]}`);
    }
    L.push('');
  }

  return L.join('\n');
}

// ============================================================================
// 并发控制
// ============================================================================

/** 限制并发的 map */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });

  await Promise.all(workers);
  return results;
}

// ============================================================================
// 主流程
// ============================================================================

/** 待评条目 */
interface JudgeTarget {
  /** 全局唯一 —— 多文件批量时同一个 (故事,档位) 会在每一轮各出现一次，id 必须带轮次 */
  id: string;
  /** 轮次标签：R1..Rn（时间戳文件按序编号）/ full / adhoc */
  round: string;
  /** 数据来源文件名 */
  source: string;
  storyName: string;
  arm: string;
  segments: string[];
}

/** 列出目录下所有消融结果文件（文件名排序：时间戳轮次在前，full_5x5 在后） */
function listAblationFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^ablation_results_.*\.json$/.test(f))
    .sort()
    .map((f) => join(dir, f));
}

function loadTargets(args: Args): JudgeTarget[] {
  // 模式一：任意纯文本
  if (args.text) {
    const p = resolve(args.text);
    if (!existsSync(p)) throw new Error(`--text 指定的文件不存在：${p}`);
    return [
      {
        id: `adhoc|${args.storyTitle || '未命名'}`,
        round: 'adhoc',
        source: basename(p),
        storyName: args.storyTitle || '未命名',
        arm: 'unknown',
        segments: [readFileSync(p, 'utf-8')],
      },
    ];
  }

  // 模式二：消融结果 JSON —— 单文件，或 --all 扫整个 Docs/ablation 目录
  const files = args.all ? listAblationFiles(OUT_DIR) : [resolve(args.input)];
  if (files.length === 0) {
    throw new Error(`在 ${OUT_DIR} 下没找到 ablation_results_*.json`);
  }
  for (const f of files) {
    if (!existsSync(f)) throw new Error(`输入文件不存在：${f}`);
  }

  const targets: JudgeTarget[] = [];
  let roundIdx = 0;

  for (const f of files) {
    const base = basename(f);
    const round = base.includes('full') ? 'full' : `R${++roundIdx}`;
    const raw = JSON.parse(readFileSync(f, 'utf-8')) as Array<{
      story: string;
      arm: string;
      segments: string[];
    }>;
    targets.push(
      ...raw.map((r) => ({
        id: `${round}|${r.story}#${r.arm}`,
        round,
        source: base,
        storyName: r.story,
        arm: r.arm,
        segments: r.segments,
      })),
    );
  }

  return filterTargets(targets, args);
}

/** 应用 --stories / --arms / --limit 过滤 */
function filterTargets(targets: JudgeTarget[], args: Args): JudgeTarget[] {
  if (args.stories.length) {
    targets = targets.filter((t) => args.stories.includes(t.storyName));
  }
  if (args.arms.length) {
    targets = targets.filter((t) => args.arms.includes(t.arm));
  }
  if (args.limit > 0) {
    targets = targets.slice(0, args.limit);
  }
  return targets;
}

async function main() {
  const args = parseArgs();

  // --check-fixtures：只校验 fixture 与 ab_ablation.ts 的同步性
  if (args.checkFixtures) {
    console.log('校验 story-fixtures.ts 与 ab_ablation.ts 的一致性…');
    const src = readFileSync(join(__dirname, 'ab_ablation.ts'), 'utf-8');
    let bad = 0;
    for (const s of JUDGE_STORIES) {
      for (const probe of [s.title, s.opener.slice(0, 20)]) {
        if (!src.includes(probe)) {
          console.error(`  ✗ 在 ab_ablation.ts 中找不到：${probe}`);
          bad++;
        }
      }
      for (const c of s.characters) {
        if (!src.includes(`name: '${c.name}'`)) {
          console.error(`  ✗ 在 ab_ablation.ts 中找不到角色：${c.name}（${s.title}）`);
          bad++;
        }
      }
    }
    console.log(bad === 0 ? '✅ 一致' : `✗ ${bad} 处不一致`);
    process.exit(bad === 0 ? 0 : 1);
  }

  const targets = loadTargets(args);

  console.log('LLM-as-Judge 四维打分器');
  console.log('─'.repeat(72));
  console.log(`待评条数：${targets.length}`);
  console.log(`采样次数：每条 ${args.repeats} 次（取中位数）`);
  console.log(`并发：${args.concurrency}`);
  console.log(`Judge 模型：${env('AI_JUDGE_MODEL', env('AI_MODEL', 'deepseek-chat'))}（temperature=0）`);
  if (args.stories.length) console.log(`故事过滤：${args.stories.join('、')}`);
  if (args.arms.length) console.log(`档位过滤：${args.arms.join('、')}`);
  console.log('─'.repeat(72));

  const known = JUDGE_STORIES.map((s) => s.title);
  const missing = [...new Set(targets.map((t) => t.storyName))].filter(
    (n) => n !== '未命名' && !known.includes(n),
  );
  if (missing.length) {
    console.warn(`⚠ 以下故事在 story-fixtures.ts 里没有设定，将降级为「无参照」打分：${missing.join('、')}`);
  }

  const started = Date.now();
  let done = 0;

  const results = await mapLimit(targets, args.concurrency, async (t) => {
    const r = await scoreItem(t, findStory(t.storyName), args);
    done++;
    if (r) {
      const detail = DIMENSIONS.map((d) => `${DIMENSION_ZH[d]}${r.scores[d]}`).join(' ');
      console.log(
        `[${String(done).padStart(3)}/${targets.length}] ${t.id.padEnd(28)} 总分 ${String(r.total).padStart(2)} | ${detail}`,
      );
    }
    return r;
  });

  const ok = results.filter((r): r is JudgeResult => r !== null);

  if (args.dryRun) {
    console.log('\n（--dry-run：未调用 API，无结果落盘）');
    return;
  }
  if (ok.length === 0) {
    console.error('没有任何条目成功打分。');
    process.exit(1);
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const model = env('AI_JUDGE_MODEL', env('AI_MODEL', 'deepseek-chat'));
  const stamp = formatTimestamp(new Date());

  mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = join(OUT_DIR, `${args.outPrefix}_results_${stamp}.json`);
  const mdPath = join(OUT_DIR, `${args.outPrefix}_report_${stamp}.md`);

  // 解析失败日志：有失败才写，避免污染目录
  if (PARSE_FAILURES.length > 0) {
    const failPath = join(OUT_DIR, `${args.outPrefix}_parse_failures_${stamp}.log`);
    writeFileSync(
      failPath,
      PARSE_FAILURES.map(
        (f) => `${'='.repeat(72)}\n${f.id} · 第 ${f.sample} 次采样\n${'='.repeat(72)}\n${f.text}\n`,
      ).join('\n'),
      'utf-8',
    );
    const totalSamples = ok.reduce((s, r) => s + r.samplesTotal, 0);
    console.warn(
      `⚠ ${PARSE_FAILURES.length}/${totalSamples} 次采样解析失败（${(
        (PARSE_FAILURES.length / totalSamples) * 100
      ).toFixed(0)}%），原始输出：${failPath}`,
    );
  }

  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        meta: {
          model,
          temperature: 0,
          repeats: args.repeats,
          concurrency: args.concurrency,
          input: args.text || args.input,
          dimensions: DIMENSIONS,
          generatedAt: new Date().toISOString(),
          elapsedSeconds: Number(elapsed),
        },
        results: ok,
      },
      null,
      2,
    ),
    'utf-8',
  );
  writeFileSync(mdPath, buildMarkdown(ok, args, model), 'utf-8');

  // 控制台汇总
  console.log('\n' + '─'.repeat(72));
  console.log(`完成 ${ok.length}/${targets.length} 条，耗时 ${elapsed}s`);
  const spreadTotal = ok.reduce(
    (s, r) => s + DIMENSIONS.reduce((a, d) => a + r.spread[d], 0),
    0,
  );
  console.log(
    args.repeats < 2
      ? `⚠ 只采样了 ${args.repeats} 次，无法评估可复现性（要测请加 --repeats=3）`
      : spreadTotal === 0
        ? '✅ 打分完全可复现（所有维度多次采样极差为 0）'
        : `⚠ 存在采样分歧（极差合计 ${spreadTotal}），详见报告稳定性一节`,
  );
  console.log(`JSON：${jsonPath}`);
  console.log(`报告：${mdPath}`);
}

main().catch((e) => {
  console.error('失败:', e);
  process.exit(1);
});
