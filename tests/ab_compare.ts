/**
 * A/B 前后对比测试脚本（多段版）
 *
 * 对比"无状态表+图谱注入" vs "有状态表+图谱注入"的生成效果：
 *  - A组（branchA）：关闭注入，连续续写 AB_SEGMENTS 段
 *  - B组（branchB）：开启注入，连续续写 AB_SEGMENTS 段
 *  - 两组独立分支，各自累积上下文，最后对比角色/时间/关系一致性
 *
 * 运行前提：Docker postgres + app 已启动
 * 运行：DATABASE_URL=postgresql://gushi:gushi_dev@localhost:5433/gushi_dev npx tsx tests/ab_compare.ts
 */
import 'dotenv/config';
import prisma from '../src/lib/prisma';
import { buildFullPrompt } from '../src/lib/prompt-builder';
import { knowledgeGraph } from '../src/lib/knowledge-graph';
import { narrativeStateTracker } from '../src/lib/narrative-state-tracker';
import { getOrderedChain } from '../src/lib/chain-helpers';
import { callAIText } from '../src/lib/ai-client';

const BRANCH_A = 'branchA';  // 无注入
const BRANCH_B = 'branchB';  // 有注入
const AB_SEGMENTS = 3;       // 每组续写段数

const systemPrompt = '你是一位专业的文学作家。请用中文回答，用现代白话文写作，保持与前文的风格和情节连续性。';

async function setup(): Promise<string> {
  // 清理旧测试数据
  const oldStories = await prisma.story.findMany({
    where: { title: { contains: 'AB对比' } },
    select: { id: true },
  });
  for (const old of oldStories) {
    await prisma.storySegment.deleteMany({ where: { storyId: old.id } });
    await prisma.character.deleteMany({ where: { storyId: old.id } });
    await prisma.storyBranch.deleteMany({ where: { storyId: old.id } });
    await prisma.story.delete({ where: { id: old.id } });
  }

  const testEmail = 'ab_test@gushi.local';
  let user = await prisma.user.findUnique({ where: { email: testEmail } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        email: testEmail,
        name: 'AB测试用户',
        passwordHash: '$2b$10$testhashforabtestuser0000000000000000000',
        id: `user_ab_test`,
      } as any,
    });
  }

  const story = await prisma.story.create({
    data: {
      title: 'AB对比·桃园结义',
      description: '东汉末年，刘备、关羽、张飞在桃园结为兄弟，共谋兴复汉室。董卓祸乱朝纲，洛阳危在旦夕。',
      genre: '三国',
      visibility: 'PUBLIC',
      id: `story_ab_${Date.now()}`,
      owner: { connect: { id: user.id } },
    } as any,
  });

  const charDefs = [
    { name: '刘备', era: '东汉末年', role: 'protagonist', traits: ['仁义', '沉稳', '坚韧'] },
    { name: '关羽', era: '东汉末年', role: 'protagonist', traits: ['忠义', '勇猛', '高傲'] },
    { name: '张飞', era: '东汉末年', role: 'supporting', traits: ['勇猛', '急躁', '忠诚'] },
    { name: '董卓', era: '东汉末年', role: 'antagonist', traits: ['残暴', '贪婪', '专横'] },
  ];
  const charIds: string[] = [];
  for (const c of charDefs) {
    const created = await prisma.character.create({
      data: { name: c.name, era: c.era, role: c.role, traits: c.traits, storyId: story.id, id: `char_ab_${c.name}` } as any,
    });
    charIds.push(created.id);
  }

  // main 根段（两个分支共享起点，保证公平对比）
  await prisma.storySegment.create({
    data: {
      storyId: story.id,
      title: '桃园结义（起点）',
      content: '东汉末年，天下大乱。刘备、关羽、张飞三人志向相投，于桃园中歃血为盟，结为异姓兄弟，誓同生死，共图兴复汉室。而此时洛阳城中，董卓把持朝政，横行无忌。',
      isBranchPoint: false,
      branchId: 'main',
      parentSegmentId: null,
      imageUrls: [],
      characterIds: charIds,
      id: 'seg_ab_main_000',
    } as any,
  });

  // 两个分支各建 StoryBranch 记录（getOrderedChain 对非 main 分支依赖此表）
  for (const branch of [BRANCH_A, BRANCH_B]) {
    await prisma.storyBranch.create({
      data: {
        id: branch,
        title: `AB对比·${branch === BRANCH_A ? '无注入' : '有注入'}`,
        sourceSegmentId: 'seg_ab_main_000',
        storyId: story.id,
        userDirection: branch === BRANCH_A ? '无记忆注入' : '有记忆注入',
        ownerId: user.id,
      } as any,
    });

    // 各分支独立知识图谱（同名节点不同 branchId）
    const liu = await knowledgeGraph.getOrCreateNode({ type: 'character', name: '刘备', branchId: branch });
    const guan = await knowledgeGraph.getOrCreateNode({ type: 'character', name: '关羽', branchId: branch });
    const zhang = await knowledgeGraph.getOrCreateNode({ type: 'character', name: '张飞', branchId: branch });
    const taoYuan = await knowledgeGraph.getOrCreateNode({ type: 'event', name: '桃园结义', branchId: branch });
    const luoYang = await knowledgeGraph.getOrCreateNode({ type: 'location', name: '洛阳', branchId: branch });
    const dongZhuo = await knowledgeGraph.getOrCreateNode({ type: 'character', name: '董卓', branchId: branch });
    await knowledgeGraph.addEdge({ source: liu.id, target: guan.id, type: 'ally_of', branchId: branch, segmentId: 'seed' });
    await knowledgeGraph.addEdge({ source: liu.id, target: zhang.id, type: 'ally_of', branchId: branch, segmentId: 'seed' });
    await knowledgeGraph.addEdge({ source: guan.id, target: zhang.id, type: 'ally_of', branchId: branch, segmentId: 'seed' });
    await knowledgeGraph.addEdge({ source: luoYang.id, target: dongZhuo.id, type: 'conflicts_with', branchId: branch, segmentId: 'seed' });
    await knowledgeGraph.addEdge({ source: liu.id, target: taoYuan.id, type: 'involves', branchId: branch, segmentId: 'seed' });

    // 各分支独立状态表
    await narrativeStateTracker.forceSetStates(story.id, branch, [
      { id: `ns_${branch}_liu`, type: 'character', name: '刘备', branchId: branch,
        properties: { isAlive: 'true', location: '桃园', status: '义军首领', mood: '坚定', faction: '汉室', goal: '兴复汉室' }, history: [], lastSeenSegmentId: 'seed' },
      { id: `ns_${branch}_guan`, type: 'character', name: '关羽', branchId: branch,
        properties: { isAlive: 'true', location: '桃园', status: '义军将领', mood: '忠义', faction: '汉室' }, history: [], lastSeenSegmentId: 'seed' },
      { id: `ns_${branch}_zhang`, type: 'character', name: '张飞', branchId: branch,
        properties: { isAlive: 'true', location: '桃园', status: '义军将领', mood: '激昂', faction: '汉室' }, history: [], lastSeenSegmentId: 'seed' },
      { id: `ns_${branch}_dong`, type: 'character', name: '董卓', branchId: branch,
        properties: { isAlive: 'true', location: '洛阳', status: '把持朝政', mood: '专横', faction: '董卓势力', goal: '独揽大权' }, history: [], lastSeenSegmentId: 'seed' },
      { id: `ns_${branch}_luoyang`, type: 'location', name: '洛阳', branchId: branch,
        properties: { status: '被董卓控制', controller: '董卓', population: '朝廷百官' }, history: [], lastSeenSegmentId: 'seed' },
      { id: `ns_${branch}_rel_lg`, type: 'relationship', name: '刘备-关羽', branchId: branch,
        properties: { between: '刘备-关羽', type: '兄弟', status: '正常', strength: '100' }, history: [], lastSeenSegmentId: 'seed' },
      { id: `ns_${branch}_rel_lz`, type: 'relationship', name: '刘备-张飞', branchId: branch,
        properties: { between: '刘备-张飞', type: '兄弟', status: '正常', strength: '100' }, history: [], lastSeenSegmentId: 'seed' },
      { id: `ns_${branch}_rel_dl`, type: 'relationship', name: '董卓-洛阳', branchId: branch,
        properties: { between: '董卓-洛阳', type: '控制', status: '控制中' }, history: [], lastSeenSegmentId: 'seed' },
    ] as any);
  }

  console.log(`  已创建测试故事: ${story.id}`);
  return story.id;
}

async function continueStory(storyId: string, branch: string, story: any): Promise<string> {
  const chain = await getOrderedChain(storyId, branch);
  const tailSegment = chain[chain.length - 1];

  const result = await buildFullPrompt({
    storyId,
    branchId: branch,
    tailSegment: tailSegment as any,
    chain: chain as any,
    storyTitle: story.title,
    storyDescription: story.description ?? undefined,
  });

  const aiResponse = await callAIText(result.prompt, { systemPrompt, maxTokens: 700, story: story as any });
  const segId = `seg_ab_${branch}_${String(chain.length).padStart(3, '0')}`;
  await prisma.storySegment.create({
    data: {
      storyId,
      title: `续写${chain.length}`,
      content: aiResponse,
      isBranchPoint: false,
      branchId: branch,
      parentSegmentId: tailSegment.id,
      imageUrls: [],
      id: segId,
    } as any,
  });

  // 更新状态表+图谱（仅 B 分支更新，A 分支保持无记忆，模拟纯基线）
  if (branch === BRANCH_B) {
    try {
      await narrativeStateTracker.updateFromSegment(storyId, branch, segId, aiResponse);
    } catch { /* 静默 */ }
    try {
      await knowledgeGraph.extractFromSegment(aiResponse, branch, segId, (p: string) =>
        callAIText(p, { maxTokens: 1500, story: story as any })
      );
    } catch { /* 静默 */ }
  }

  return aiResponse;
}

async function main() {
  const storyId = await setup();
  const story = await prisma.story.findUnique({ where: { id: storyId } });
  if (!story) throw new Error('故事不存在');

  console.log(`\n故事: ${story.title}`);
  console.log(`每组续写 ${AB_SEGMENTS} 段（A组无注入 / B组有状态表+图谱注入）`);
  console.log('='.repeat(70));

  // 统计初始图谱/状态表
  const stats = await knowledgeGraph.getStats();
  const sA = await narrativeStateTracker.summarize(storyId, BRANCH_A);
  const sB = await narrativeStateTracker.summarize(storyId, BRANCH_B);
  console.log(`初始图谱: ${stats.totalNodes} 节点 / ${stats.totalEdges} 边`);
  console.log(`初始状态表: A组=${sA.totalObjects} 对象, B组=${sB.totalObjects} 对象`);

  // 跑 A 组（无注入）
  console.log(`\n── A组（无状态表+图谱，关闭注入）──`);
  const aResults: string[] = [];
  process.env.MEMORY_MODULES_ENABLED = 'false';
  for (let i = 0; i < AB_SEGMENTS; i++) {
    const seg = await continueStory(storyId, BRANCH_A, story);
    aResults.push(seg);
    console.log(`\n[第${i + 1}段] ${seg.slice(0, 400)}`);
  }

  // 跑 B 组（有注入）
  console.log(`\n── B组（有状态表+图谱注入）──`);
  const bResults: string[] = [];
  delete process.env.MEMORY_MODULES_ENABLED;
  for (let i = 0; i < AB_SEGMENTS; i++) {
    const seg = await continueStory(storyId, BRANCH_B, story);
    bResults.push(seg);
    console.log(`\n[第${i + 1}段] ${seg.slice(0, 400)}`);
  }

  // 汇总
  console.log('\n' + '='.repeat(70));
  console.log('📊 A/B 对比结果汇总');
  console.log(`  A组（无注入）续写 ${AB_SEGMENTS} 段，共 ${aResults.reduce((s, r) => s + r.length, 0)} 字`);
  console.log(`  B组（有注入）续写 ${AB_SEGMENTS} 段，共 ${bResults.reduce((s, r) => s + r.length, 0)} 字`);

  const statsAfter = await knowledgeGraph.getStats();
  const sBAfter = await narrativeStateTracker.summarize(storyId, BRANCH_B);
  console.log(`  图谱（B分支累计）: ${statsAfter.totalNodes} 节点 / ${statsAfter.totalEdges} 边`);
  console.log(`  状态表（B分支累计）: ${sBAfter.totalObjects} 个对象`);

  delete process.env.MEMORY_MODULES_ENABLED;
  console.log('\n✅ A/B 对比完成');
}

main()
  .catch((e) => {
    console.error('A/B 对比失败:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
