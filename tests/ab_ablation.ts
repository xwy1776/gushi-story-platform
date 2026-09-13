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
 *   ② 相邻段重复度（trigram Jaccard，越低越好）—— 情节是否套路化
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
 * DATABASE_URL 会被 tests/test-env.ts 自动改写为宿主机地址，无需手动指定。
 * 结果输出到 Docs/ablation/ 目录（JSON + Markdown）。
 */
import './test-env';
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import prisma from '../src/lib/prisma';
import { buildFullPrompt } from '../src/lib/prompt-builder';
import { knowledgeGraph } from '../src/lib/knowledge-graph';
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
  };
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
  for (const e of def.graphEdges) {
    const n1 = await knowledgeGraph.getOrCreateNode({
      type: e.type === 'located_at' ? 'location' : (e.type === 'involves' ? 'event' : 'character'),
      name: e.from, branchId,
    });
    const n2 = await knowledgeGraph.getOrCreateNode({ type: 'character', name: e.to, branchId });
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
  lines.push('| 故事 | 档位 | Prompt均值(字) | 注入增量(字) | 相邻段重复度 | 角色覆盖率 | 图谱节点 | 状态表对象 |');
  lines.push('|------|------|------:|------:|------:|------:|------:|------:|');

  for (const title of storyTitles) {
    const base = results.find(r => r.story === title && r.arm === 'none');
    const basePrompt = base ? base.promptLens.reduce((s, v) => s + v, 0) / base.promptLens.length : 0;

    for (const arm of arms) {
      const r = results.find(x => x.story === title && x.arm === arm);
      if (!r) continue;
      const avgPrompt = r.promptLens.reduce((s, v) => s + v, 0) / r.promptLens.length;
      const inj = arm === 'none' ? 0 : Math.round(avgPrompt - basePrompt);
      lines.push(
        `| ${title} | \`${arm}\` | ${Math.round(avgPrompt)} | ${inj > 0 ? '+' : ''}${inj} | ` +
        `${r.adjacentSim.avg.toFixed(3)} | ${(r.charCoverage * 100).toFixed(0)}% | ${r.graphNodes} | ${r.stateObjects} |`,
      );
    }
  }
  lines.push('');

  // 跨故事平均（带标准差 + 相对基线的配对检验）
  lines.push('## 三、跨故事平均（各档位，均值 ± 标准差）');
  lines.push('');
  lines.push('| 档位 | 相邻段重复度 ↓ | 角色覆盖率 ↑ | Prompt 字数 | 图谱节点 |');
  lines.push('|------|------:|------:|------:|------:|');

  const baselineSim = results.filter(r => r.arm === 'none').map(r => r.adjacentSim.avg);

  for (const arm of arms) {
    const rs = results.filter(r => r.arm === arm);
    if (rs.length === 0) continue;
    const simS = stats(rs.map(r => r.adjacentSim.avg));
    const covS = stats(rs.map(r => r.charCoverage));
    const pS = stats(rs.map(r => r.promptLens.reduce((s, v) => s + v, 0) / r.promptLens.length));
    const nS = stats(rs.map(r => r.graphNodes));
    lines.push(
      `| \`${arm}\` | ${simS.mean.toFixed(3)} ± ${simS.std.toFixed(3)} | ` +
      `${(covS.mean * 100).toFixed(0)}% ± ${(covS.std * 100).toFixed(0)}% | ` +
      `${pS.mean.toFixed(0)} ± ${pS.std.toFixed(0)} | ${nS.mean.toFixed(1)} ± ${nS.std.toFixed(1)} |`,
    );
  }
  lines.push('');

  // 相对基线的假设检验
  if (baselineSim.length >= 2) {
    lines.push('### 相对基线的配对 t 检验（相邻段重复度）');
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
    lines.push('> 注：n=5 时样本量偏小，p 值仅作参考。正式投稿前建议每个配置重复 3 次以增强统计效力。');
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
  const { arms, stories, segments, reportOnly } = parseArgs();

  if (reportOnly) {
    // 复用最近一次落盘的结果，只重新生成汇总，不重新调 AI
    const outDir = join(process.cwd(), 'Docs', 'ablation');
    const files = existsSync(outDir)
      ? readdirSync(outDir).filter(f => f.startsWith('ablation_results_') && f.endsWith('.json')).sort()
      : [];
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
  console.log('\n' + '═'.repeat(78));
  console.log('📊 消融实验汇总（跨故事，均值 ± 标准差）');
  console.log('═'.repeat(78));
  console.log(`${'档位'.padEnd(20)} ${'相邻段重复度 ↓'.padEnd(20)} ${'角色覆盖率 ↑'.padEnd(16)}`);
  console.log('─'.repeat(78));
  for (const arm of arms) {
    const rs = results.filter(r => r.arm === arm);
    if (rs.length === 0) continue;
    const simS = stats(rs.map(r => r.adjacentSim.avg));
    const covS = stats(rs.map(r => r.charCoverage));
    console.log(
      `${ARM_LABELS[arm].padEnd(18)} ` +
      `${(simS.mean.toFixed(3) + ' ± ' + simS.std.toFixed(3)).padEnd(20)} ` +
      `${((covS.mean * 100).toFixed(0) + '% ± ' + (covS.std * 100).toFixed(0) + '%')}`,
    );
  }
  console.log('─'.repeat(78));
  console.log('提示：重复度越低越好（情节不套路）；角色覆盖率越高越好（不丢角色）');
}

main()
  .catch((e) => { console.error('失败:', e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
