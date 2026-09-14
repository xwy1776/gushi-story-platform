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
function buildRoundsMarkdown(rounds: RunResult[][], arms: Arm[]): string {
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

  const lines: string[] = [];
  lines.push('# 多轮汇总（跨轮聚合）');
  lines.push('');
  lines.push(`> 数据来源：${rounds.length} 轮独立实验，每轮 ${storyTitles.length} 故事 × ${arms.length} 档。`);
  lines.push('> 各轮结果文件按修改时间排序，全部纳入。');
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

  lines.push('## 二、按故事配对的 t 检验（以跨轮平均的非退化中位数为配对样本）');
  lines.push('');
  const base = storySeries('none');
  if (base.length >= 2) {
    lines.push(`配对单位：故事（n=${base.length}），每档相对 \`none\` 基线。`);
    lines.push('');
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
  lines.push('## 三、逐故事明细（跨轮平均的非退化中位数）');
  lines.push('');
  lines.push(`| 故事 | ${arms.map(a => `\`${a}\``).join(' | ')} |`);
  lines.push(`|------|${arms.map(() => '------:').join('|')}|`);
  for (const s of storyTitles) {
    lines.push(`| ${s} | ${arms.map(a => { const v = perStory(a, s); return v === null ? '—' : v.toFixed(3); }).join(' | ')} |`);
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
 * 配对样本 t 检验（对比某档位与基线）。
 * 样本量小时（n=5）只作参考，正式投稿需扩样本。
 * 返回 t 值与近似双尾 p 值的粗估。
 */
export function pairedTTest(baseline: number[], treatment: number[]): {
  t: number; df: number; significant: boolean;
} {
  const n = Math.min(baseline.length, treatment.length);
  if (n < 2) return { t: 0, df: 0, significant: false };

  const diffs = Array.from({ length: n }, (_, i) => treatment[i] - baseline[i]);
  const dMean = diffs.reduce((s, v) => s + v, 0) / n;
  const dStd = Math.sqrt(
    diffs.reduce((s, v) => s + (v - dMean) ** 2, 0) / (n - 1),
  );
  if (dStd === 0) return { t: 0, df: n - 1, significant: false };

  const t = dMean / (dStd / Math.sqrt(n));
  // 小样本下用 |t| > 2.776 (df=4, p<0.05) 作粗略判据
  const critical = n === 5 ? 2.776 : n === 4 ? 3.182 : 2.0;
  return { t, df: n - 1, significant: Math.abs(t) > critical };
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
 * 成为图谱噪声的一部分。改成两端都按名单+边类型推断。
 *
 * 名单显式列在这里而不是靠猜，是因为这些是实验夹具（fixture）的一部分，
 * 新增故事时如果用到新的地点/事件，一并补进来即可。
 */
const SEED_LOCATIONS = new Set(['洛阳', '长安', '咸阳', '赤壁']);
const SEED_EVENTS = new Set(['桃园结义', '出使西域', '刺秦', '火攻', '单骑退敌']);

function inferSeedNodeType(name: string, charNames: Set<string>): NodeType {
  if (charNames.has(name)) return 'character';
  if (SEED_LOCATIONS.has(name)) return 'location';
  if (SEED_EVENTS.has(name)) return 'event';
  // 兜底当角色，并留痕，避免新故事里的实体被静默归错类
  console.warn(`[ab_ablation] 种子实体「${name}」不在角色/地点/事件名单内，按角色处理`);
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
  for (const e of def.graphEdges) {
    const n1 = await knowledgeGraph.getOrCreateNode({
      type: inferSeedNodeType(e.from, seedCharNames), name: e.from, branchId,
    });
    const n2 = await knowledgeGraph.getOrCreateNode({
      type: inferSeedNodeType(e.to, seedCharNames), name: e.to, branchId,
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
  const { arms, stories, segments, reportOnly, roundsReport } = parseArgs();

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
    const files = listResultFiles();
    if (files.length === 0) {
      console.error(`未找到历史结果。请先跑一次实验（去掉 --rounds-report）。\n查找目录：${outDir}`);
      process.exit(1);
    }
    const rounds = files.map(f => JSON.parse(readFileSync(join(outDir, f), 'utf-8')) as RunResult[]);
    console.log(`\n📂 纳入 ${rounds.length} 轮结果：`);
    files.forEach((f, i) => console.log(`   ${i + 1}. ${f}（${rounds[i].length} 条记录）`));

    const presentArms = arms.filter(a => rounds.some(r => r.some(x => x.arm === a)));
    const mdPath = join(outDir, 'ablation_report_rounds.md');
    writeFileSync(mdPath, buildRoundsMarkdown(rounds, presentArms), 'utf-8');
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

main()
  .catch((e) => { console.error('失败:', e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
