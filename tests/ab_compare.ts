/**
 * A/B 前后对比测试脚本（多故事 + 量化指标版）
 *
 * 对比"无记忆注入 vs 有记忆注入"的生成效果：
 *  - 多个测试故事（桃园结义、张骞出使西域）
 *  - A组（关闭注入）/ B组（开启注入）各续写 N 段
 *  - 量化指标：Prompt注入差 / 相邻段重复度 / 图谱状态表增长 / 角色名一致性
 *
 * 运行：DATABASE_URL=postgresql://gushi:gushi_dev@localhost:5433/gushi_dev npx tsx tests/ab_compare.ts
 */
import 'dotenv/config';
import prisma from '../src/lib/prisma';
import { buildFullPrompt } from '../src/lib/prompt-builder';
import { knowledgeGraph } from '../src/lib/knowledge-graph';
import { narrativeStateTracker } from '../src/lib/narrative-state-tracker';
import { getOrderedChain } from '../src/lib/chain-helpers';
import { callAIText } from '../src/lib/ai-client';

const AB_SEGMENTS = 3;  // 每组续写段数
const systemPrompt = '你是一位专业的文学作家。请用中文回答，用现代白话文写作，保持与前文的风格和情节连续性。';

// ============================================================================
// 量化指标工具
// ============================================================================

/** 字符 trigram Jaccard 相似度（0=完全不同，1=完全一样） */
function trigramSimilarity(a: string, b: string): number {
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
function avgAdjacentSimilarity(segments: string[]): { values: number[]; avg: number } {
  const values: number[] = [];
  for (let i = 1; i < segments.length; i++) {
    values.push(trigramSimilarity(segments[i - 1], segments[i]));
  }
  const avg = values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length;
  return { values, avg };
}

/** 已知角色名在文本中的出现次数（角色名一致性粗检） */
function countCharacterMentions(text: string, names: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const n of names) {
    out[n] = (text.match(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
  }
  return out;
}

// ============================================================================
// 测试故事定义
// ============================================================================

type StoryDef = {
  title: string;
  description: string;
  genre: string;
  opener: string;      // 起始段
  characters: Array<{ name: string; era: string; role: string; traits: string[] }>;
  graphEdges: Array<{ from: string; to: string; type: 'ally_of' | 'conflicts_with' | 'involves' | 'belongs_to' | 'located_at' }>;
  states: Array<Record<string, any>>;
};

const STORY_DEFS: StoryDef[] = [
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
];

// ============================================================================
// 测试流程
// ============================================================================

async function setup(storyDef: StoryDef, tag: string, brA: string, brB: string): Promise<string> {
  const titleKey = `AB对比·${storyDef.title}`;
  const oldStories = await prisma.story.findMany({ where: { title: { contains: titleKey } }, select: { id: true } });
  for (const old of oldStories) {
    // 先删引用方（branch 的 sourceSegmentId 指向 segment），再删被引用方
    await prisma.storyBranch.deleteMany({ where: { storyId: old.id } });
    await prisma.storySegment.deleteMany({ where: { storyId: old.id } });
    await prisma.character.deleteMany({ where: { storyId: old.id } });
    await prisma.story.delete({ where: { id: old.id } });
  }

  const testEmail = 'ab_test@gushi.local';
  let user = await prisma.user.findUnique({ where: { email: testEmail } });
  if (!user) {
    user = await prisma.user.create({
      data: { email: testEmail, name: 'AB测试用户', passwordHash: '$2b$10$x', id: `user_ab_test` } as any,
    });
  }

  const story = await prisma.story.create({
    data: {
      title: titleKey,
      description: storyDef.description,
      genre: storyDef.genre,
      visibility: 'PUBLIC',
      id: `story_${tag}_${Date.now()}`,
      owner: { connect: { id: user.id } },
    } as any,
  });

  const charIds: string[] = [];
  for (const c of storyDef.characters) {
    const created = await prisma.character.create({
      data: { name: c.name, era: c.era, role: c.role, traits: c.traits, storyId: story.id, id: `char_${tag}_${c.name}` } as any,
    });
    charIds.push(created.id);
  }

  // main 根段
  await prisma.storySegment.create({
    data: {
      storyId: story.id, title: '起点', content: storyDef.opener,
      isBranchPoint: false, branchId: 'main', parentSegmentId: null,
      imageUrls: [], characterIds: charIds, id: `seg_${tag}_main_000`,
    } as any,
  });

  // A/B 两个分支 + 图谱 + 状态表
  for (const branch of [brA, brB]) {
    await prisma.storyBranch.create({
      data: {
        id: branch, title: `AB-${branch}`, sourceSegmentId: `seg_${tag}_main_000`,
        storyId: story.id, userDirection: '对比测试', ownerId: user.id,
      } as any,
    });

    for (const e of storyDef.graphEdges) {
      const n1 = await knowledgeGraph.getOrCreateNode({ type: e.type === 'located_at' ? 'location' : (e.type === 'involves' ? 'event' : 'character'), name: e.from, branchId: branch });
      const n2 = await knowledgeGraph.getOrCreateNode({ type: 'character', name: e.to, branchId: branch });
      await knowledgeGraph.addEdge({ source: n1.id, target: n2.id, type: e.type, branchId: branch, segmentId: 'seed' });
    }

    await narrativeStateTracker.forceSetStates(story.id, branch, storyDef.states.map(s => ({
      ...s, branchId: branch, history: [], lastSeenSegmentId: 'seed',
    })) as any);
  }

  return story.id;
}

async function continueStory(storyId: string, branch: string, story: any, tag: string): Promise<string> {
  const chain = await getOrderedChain(storyId, branch);
  const tailSegment = chain[chain.length - 1];
  const result = await buildFullPrompt({
    storyId, branchId: branch, tailSegment: tailSegment as any, chain: chain as any,
    storyTitle: story.title, storyDescription: story.description ?? undefined,
  });
  const aiResponse = await callAIText(result.prompt, { systemPrompt, maxTokens: 700, story: story as any });
  const segId = `seg_${tag}_${branch}_${String(chain.length).padStart(3, '0')}`;
  await prisma.storySegment.create({
    data: {
      storyId, title: `续写${chain.length}`, content: aiResponse,
      isBranchPoint: false, branchId: branch, parentSegmentId: tailSegment.id,
      imageUrls: [], id: segId,
    } as any,
  });
  if (branch.endsWith('_B')) {
    try { await narrativeStateTracker.updateFromSegment(storyId, branch, segId, aiResponse); } catch {}
    try { await knowledgeGraph.extractFromSegment(aiResponse, branch, segId, (p: string) => callAIText(p, { maxTokens: 1500, story: story as any })); } catch {}
  }
  return aiResponse;
}

async function main() {
  const allResults: Array<{ title: string; a: string[]; b: string[]; aPromptLen: number; bPromptLen: number }> = [];

  for (let idx = 0; idx < STORY_DEFS.length; idx++) {
    const def = STORY_DEFS[idx];
    const tag = `s${idx}`;
    const brA = `branch_${tag}_A`;
    const brB = `branch_${tag}_B`;
    console.log(`\n${'='.repeat(70)}\n🎭 故事 ${idx + 1}: ${def.title}\n${'='.repeat(70)}`);
    const storyId = await setup(def, tag, brA, brB);
    const story = await prisma.story.findUnique({ where: { id: storyId } });
    if (!story) throw new Error('故事不存在');

    const stats0 = await knowledgeGraph.getStats();
    console.log(`初始图谱: ${stats0.totalNodes} 节点 / ${stats0.totalEdges} 边`);
    console.log(`初始状态表: A=${(await narrativeStateTracker.summarize(storyId, brA)).totalObjects} B=${(await narrativeStateTracker.summarize(storyId, brB)).totalObjects} 对象`);

    // A 组
    const a: string[] = [];
    process.env.MEMORY_MODULES_ENABLED = 'false';
    const aChain0 = await getOrderedChain(storyId, brA);
    const aPrompt1 = (await buildFullPrompt({ storyId, branchId: brA, tailSegment: aChain0[aChain0.length - 1] as any, chain: aChain0 as any, storyTitle: story.title, storyDescription: story.description ?? undefined })).prompt;
    for (let i = 0; i < AB_SEGMENTS; i++) a.push(await continueStory(storyId, brA, story, tag));

    // B 组
    const b: string[] = [];
    delete process.env.MEMORY_MODULES_ENABLED;
    const bChain0 = await getOrderedChain(storyId, brB);
    const bPrompt1 = (await buildFullPrompt({ storyId, branchId: brB, tailSegment: bChain0[bChain0.length - 1] as any, chain: bChain0 as any, storyTitle: story.title, storyDescription: story.description ?? undefined })).prompt;
    for (let i = 0; i < AB_SEGMENTS; i++) b.push(await continueStory(storyId, brB, story, tag));

    delete process.env.MEMORY_MODULES_ENABLED;
    allResults.push({ title: def.title, a, b, aPromptLen: aPrompt1.length, bPromptLen: bPrompt1.length });

    // 单故事输出
    const simA = avgAdjacentSimilarity(a);
    const simB = avgAdjacentSimilarity(b);
    const stats1 = await knowledgeGraph.getStats();
    console.log(`\n📊 量化指标（${def.title}）:`);
    console.log(`  Prompt 长度: A=${aPrompt1.length}字  B=${bPrompt1.length}字  (注入差 +${bPrompt1.length - aPrompt1.length}字)`);
    console.log(`  相邻段相似度: A=${simA.values.map(v => v.toFixed(2)).join(',')} (均${simA.avg.toFixed(3)})  B=${simB.values.map(v => v.toFixed(2)).join(',')} (均${simB.avg.toFixed(3)})`);
    console.log(`  图谱增长: ${stats0.totalNodes}→${stats1.totalNodes}节点  ${stats0.totalEdges}→${stats1.totalEdges}边  (B分支累计)`);
    console.log(`  状态表增长: B分支 ${(await narrativeStateTracker.summarize(storyId, brB)).totalObjects} 对象`);

    console.log('\n── A组 各段（前200字）──');
    a.forEach((s, i) => console.log(`[段${i + 1}] ${s.slice(0, 200)}...`));
    console.log('\n── B组 各段（前200字）──');
    b.forEach((s, i) => console.log(`[段${i + 1}] ${s.slice(0, 200)}...`));
  }

  // ================= 汇总分析 =================
  console.log('\n\n' + '═'.repeat(70));
  console.log('📊 多故事 A/B 对比汇总分析');
  console.log('═'.repeat(70));
  for (const r of allResults) {
    const simA = avgAdjacentSimilarity(r.a);
    const simB = avgAdjacentSimilarity(r.b);
    console.log(`\n【${r.title}】`);
    console.log(`  注入增量: +${r.bPromptLen - r.aPromptLen} 字`);
    console.log(`  相邻段重复度(越低越好): A=${simA.avg.toFixed(3)}  vs  B=${simB.avg.toFixed(3)}  (Δ=${(simB.avg - simA.avg).toFixed(3)})`);
    console.log(`  → ${simB.avg < simA.avg ? 'B组重复度更低，情节更不套路 ✅' : 'B组重复度相近/更高 ⚠️'}`);
  }

  console.log('\n✅ 全部对比完成');
}

main()
  .catch((e) => { console.error('失败:', e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
