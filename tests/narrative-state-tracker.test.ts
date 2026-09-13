/**
 * NarrativeStateTracker — 叙事状态追踪器测试
 *
 * 运行: npx tsx tests/narrative-state-tracker.test.ts
 *
 * 覆盖肖文宇本周任务的重点：状态表核心逻辑 + 跨分支隔离 + 属性矛盾检测。
 *
 * 验证：
 * 1. forceSetStates / getAllStates 读写（含跨分支隔离）
 * 2. checkPropertyConflicts —— 死亡角色复活、地点归属矛盾等硬规则
 * 3. buildPromptContext —— 注入 Prompt 的状态表格式
 * 4. summarize —— 按类型统计
 *
 * 注意：本文件需要数据库（状态表挂在 DirectorState.worldVariables 上）。
 *   docker compose up -d postgres && npx tsx tests/narrative-state-tracker.test.ts
 * DATABASE_URL 会被 tests/test-env.ts 自动改写为宿主机地址，无需手动指定。
 */
import './test-env';
import prisma from '../src/lib/prisma';
import { narrativeStateTracker } from '../src/lib/narrative-state-tracker';
import { knowledgeGraph } from '../src/lib/knowledge-graph';
import type { NarrativeObjectState } from '../src/lib/narrative-state-tracker';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.error(`  ❌ ${message}`);
  }
}

const STORY_ID = `nst_test_${Date.now()}`;
const BRANCH_A = 'branch_a';
const BRANCH_B = 'branch_b';

/** 造一个状态对象，减少样板代码 */
function mkState(
  id: string,
  type: NarrativeObjectState['type'],
  name: string,
  branchId: string,
  properties: Record<string, string>,
  lastSeenSegmentId = 'seg_0',
): NarrativeObjectState {
  return {
    id, type, name, branchId, properties,
    history: [],
    lastSeenSegmentId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as NarrativeObjectState;
}

async function main() {
  console.log('\n📦 narrative-state-tracker tests\n');

  // ── 0. 准备：确保测试 story 存在（状态表外键依赖 story） ──
  const testEmail = `nst_test_${Date.now()}@gushi.local`;
  const user = await prisma.user.create({
    data: { email: testEmail, name: 'NST测试用户', passwordHash: '$2b$10$x' } as any,
  });
  await prisma.story.create({
    data: {
      id: STORY_ID,
      title: 'NST测试故事',
      description: '测试用',
      genre: '历史',
      visibility: 'PUBLIC',
      owner: { connect: { id: user.id } },
    } as any,
  });

  // 图谱数据：用于验证「敌对势力从图谱派生」这条泛化路径。
  // 洛阳 --conflicts_with--> 董卓，让"董卓控制洛阳"与"洛阳归汉室"的设定能被检出。
  const lyNode = await knowledgeGraph.getOrCreateNode({ type: 'location', name: '洛阳', branchId: BRANCH_A });
  const dzNode = await knowledgeGraph.getOrCreateNode({ type: 'character', name: '董卓', branchId: BRANCH_A });
  await knowledgeGraph.addEdge({
    source: lyNode.id, target: dzNode.id, type: 'conflicts_with',
    branchId: BRANCH_A, segmentId: 'seed',
  });

  // ── 1. 写入 + 读回 ──
  console.log('forceSetStates / getAllStates:');
  const statesA = [
    mkState('ns_liubei', 'character', '刘备', BRANCH_A, { isAlive: 'true', location: '桃园', goal: '兴复汉室' }),
    mkState('ns_guanyu', 'character', '关羽', BRANCH_A, { isAlive: 'true', location: '桃园' }),
    mkState('ns_luoyang', 'location', '洛阳', BRANCH_A, { controller: '董卓', status: '被控制' }),
  ];
  await narrativeStateTracker.forceSetStates(STORY_ID, BRANCH_A, statesA);

  const readA = await narrativeStateTracker.getAllStates(STORY_ID, BRANCH_A);
  assert(readA.length === 3, `写入3个对象，读回 ${readA.length} 个`);
  assert(!!readA.find(s => s.name === '刘备'), '读回包含「刘备」');
  assert(readA.find(s => s.name === '刘备')?.properties.goal === '兴复汉室', '属性值正确保留');

  // ── 2. 跨分支隔离（论文卖点，重点测） ──
  console.log('\nbranch isolation:');
  const statesB = [
    mkState('ns_liubei_b', 'character', '刘备', BRANCH_B, { isAlive: 'true', location: '荆州' }),
  ];
  await narrativeStateTracker.forceSetStates(STORY_ID, BRANCH_B, statesB);

  const readB = await narrativeStateTracker.getAllStates(STORY_ID, BRANCH_B);
  const readA2 = await narrativeStateTracker.getAllStates(STORY_ID, BRANCH_A);
  assert(readB.length === 1, `B分支独立存有 ${readB.length} 个对象`);
  assert(readA2.length === 3, `写入B分支后，A分支仍为 ${readA2.length} 个对象（互不污染）`);

  // 同一角色在不同分支下状态不同 —— 这是 Gushi 相对 SCORE/DOME 的增量创新点
  const liubeiA = readA2.find(s => s.name === '刘备');
  const liubeiB = readB.find(s => s.name === '刘备');
  assert(
    liubeiA?.properties.location === '桃园' && liubeiB?.properties.location === '荆州',
    '同一角色在不同分支状态不同（branch-aware 生效）',
  );

  // 未写入的分支返回空
  const readC = await narrativeStateTracker.getAllStates(STORY_ID, 'branch_never_written');
  assert(Array.isArray(readC) && readC.length === 0, '未写入过的分支返回空数组（不报错）');

  // ── 3. findByName / findByType ──
  console.log('\nfindByName / findByType:');
  const foundByName = await narrativeStateTracker.findByName(STORY_ID, BRANCH_A, '关羽');
  assert(foundByName?.name === '关羽', 'findByName 找到「关羽」');
  const notFound = await narrativeStateTracker.findByName(STORY_ID, BRANCH_A, '不存在的人');
  assert(notFound === undefined, 'findByName 查不到返回 undefined');
  const chars = await narrativeStateTracker.findByType(STORY_ID, BRANCH_A, 'character');
  assert(chars.length === 2, `findByType('character') 返回 ${chars.length} 个（期望2）`);
  const locs = await narrativeStateTracker.findByType(STORY_ID, BRANCH_A, 'location');
  assert(locs.length === 1, `findByType('location') 返回 ${locs.length} 个（期望1）`);

  // ── 4. checkPropertyConflicts —— 死亡角色复活（硬错误） ──
  console.log('\ncheckPropertyConflicts（硬规则检测，纯函数）:');
  const deadStates = [
    mkState('ns_dead', 'character', '董卓', BRANCH_A, { isAlive: 'false', location: '洛阳' }),
  ];

  // 死亡角色做出"活跃行为" → 应报 error
  const reviveText = '董卓大笑道："我岂会怕你！"说罢起身挥剑。';
  const reviveConflicts = narrativeStateTracker.checkPropertyConflicts(deadStates, reviveText);
  assert(
    reviveConflicts.some(c => c.objectName === '董卓' && c.property === 'isAlive' && c.severity === 'error'),
    '已死亡角色出现活跃行为 → 报 error',
  );

  // 死亡角色仅被"提及/回忆" → 不应误报
  const mentionText = '刘备想起了董卓当年的暴行，心中感慨。';
  const mentionConflicts = narrativeStateTracker.checkPropertyConflicts(deadStates, mentionText);
  assert(
    !mentionConflicts.some(c => c.objectName === '董卓' && c.property === 'isAlive'),
    '已死亡角色仅被回忆提及 → 不误报',
  );

  // 活着的人不会被误判
  const aliveText = '关羽站起身来，提刀而走。';
  const aliveConflicts = narrativeStateTracker.checkPropertyConflicts(
    [mkState('ns_alive', 'character', '关羽', BRANCH_A, { isAlive: 'true' })],
    aliveText,
  );
  assert(aliveConflicts.length === 0, '存活角色正常行动 → 无矛盾');

  // 地点归属矛盾：洛阳归汉室，但内容写"被董卓势力控制"应预警
  //
  // 关键：敌对势力不靠硬编码表，而是从知识图谱的 conflicts_with 边派生。
  // 这正是修复「势力表外就失效」缺陷后的泛化路径。
  console.log('\n地点归属矛盾（敌对势力从图谱派生）:');
  const locStates = [
    mkState('ns_ly', 'location', '洛阳', BRANCH_A, { controller: '汉室', status: '东汉都城' }),
  ];

  const oppositions = await knowledgeGraph.getOpposingFactions('洛阳', BRANCH_A);
  assert(oppositions.includes('董卓'), `从图谱派生出洛阳的敌对势力 [${oppositions.join('、')}]`);

  const locConflicts = narrativeStateTracker.checkPropertyConflicts(
    locStates, '董卓势力已牢牢控制洛阳城。', { opposingFactions: oppositions },
  );
  assert(
    locConflicts.some(c => c.objectName === '洛阳' && c.property === 'controller'),
    '地点归属与设定冲突 → 报矛盾（靠图谱派生，非硬编码表）',
  );

  // 只出现己方势力 → 不误报
  const locOkConflicts = narrativeStateTracker.checkPropertyConflicts(
    locStates, '汉室牢牢控制着洛阳城。', { opposingFactions: oppositions },
  );
  assert(
    !locOkConflicts.some(c => c.objectName === '洛阳' && c.property === 'controller'),
    '己方势力正常控制 → 不误报',
  );

  // 不传敌对势力时，退回内置兜底表也能识别常见势力
  const fallbackConflicts = narrativeStateTracker.checkPropertyConflicts(
    [mkState('ns_ly2', 'location', '洛阳', BRANCH_A, { controller: '汉室', status: '东汉都城' })],
    '董卓大军攻入洛阳。',
  );
  assert(
    fallbackConflicts.some(c => c.objectName === '洛阳'),
    '未传敌对势力时，内置兜底表仍能识别常见势力',
  );

  // 图谱里查不到的地点 → 派生为空数组，不报错
  const noOppositions = await knowledgeGraph.getOpposingFactions('不存在的地点', BRANCH_A);
  assert(Array.isArray(noOppositions) && noOppositions.length === 0, '图谱查不到的地点 → 返回空数组');

  // ── 4.5 关系矛盾 ──
  console.log('\n关系矛盾检测:');
  const brokenRel = [
    mkState('ns_rel', 'relationship', '刘备-关羽', BRANCH_A, { between: '刘备-关羽', status: '破裂' }),
  ];
  const relConflicts = narrativeStateTracker.checkPropertyConflicts(
    brokenRel, '刘备与关羽携手并肩，共图大业。',
  );
  assert(
    relConflicts.some(c => c.objectName === '刘备-关羽' && c.property === 'status'),
    '已破裂关系写成友好互动 → 报矛盾',
  );
  const relOk = narrativeStateTracker.checkPropertyConflicts(
    brokenRel, '刘备与关羽反目成仇，各奔东西。',
  );
  assert(
    !relOk.some(c => c.objectName === '刘备-关羽' && c.property === 'status'),
    '正常敌对描写 → 不误报',
  );

  // 空状态表 → 无矛盾（边界情况）
  const emptyConflicts = narrativeStateTracker.checkPropertyConflicts([], '任意文本');
  assert(emptyConflicts.length === 0, '空状态表 → 无矛盾（边界情况）');

  // ── 5. buildPromptContext —— 注入 Prompt 的格式 ──
  console.log('\nbuildPromptContext:');
  const promptCtx = await narrativeStateTracker.buildPromptContext(STORY_ID, BRANCH_A, 'seg_1');
  assert(promptCtx.includes('叙事状态表'), 'Prompt 上下文含标题「叙事状态表」');
  assert(promptCtx.includes('刘备'), 'Prompt 上下文含角色「刘备」');
  assert(promptCtx.includes('兴复汉室'), 'Prompt 上下文含属性值「兴复汉室」');
  assert(promptCtx.includes('👤 角色状态'), '按类型分组，含「👤 角色状态」小节');
  assert(promptCtx.includes('📍 地点状态'), '含「📍 地点状态」小节');

  // 空状态表 → 返回空串（不产生垃圾 Prompt）
  const emptyCtx = await narrativeStateTracker.buildPromptContext(STORY_ID, 'branch_never_written', 'seg_1');
  assert(emptyCtx === '', '空状态表 → 返回空串（不注入无用内容）');

  // ── 6. summarize —— 按类型统计 ──
  console.log('\nsummarize:');
  const summary = await narrativeStateTracker.summarize(STORY_ID, BRANCH_A);
  assert(summary.totalObjects === 3, `总计 ${summary.totalObjects} 个对象（期望3）`);
  assert(summary.byType.character === 2, `角色 ${summary.byType.character} 个（期望2）`);
  assert(summary.byType.location === 1, `地点 ${summary.byType.location} 个（期望1）`);

  // ── 7. forceSetStates 覆盖语义（幂等替换，不是追加） ──
  console.log('\nforceSetStates 覆盖语义:');
  await narrativeStateTracker.forceSetStates(STORY_ID, BRANCH_A, [statesA[0]]);
  const afterOverwrite = await narrativeStateTracker.getAllStates(STORY_ID, BRANCH_A);
  assert(afterOverwrite.length === 1, `再次 forceSet 后为 ${afterOverwrite.length} 个（覆盖而非追加）`);

  // ── 清理 ──
  await prisma.directorState.deleteMany({ where: { storyId: STORY_ID } }).catch(() => {});
  await prisma.story.delete({ where: { id: STORY_ID } }).catch(() => {});
  await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  // 图谱是 JSON 文件存储，重置以免污染 data/
  await knowledgeGraph.resetForTest().catch(() => {});
  console.log('\n(测试结束已重置图谱文件)');

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error('测试执行失败:', e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
