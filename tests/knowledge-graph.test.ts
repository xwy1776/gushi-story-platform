/**
 * KnowledgeGraph — 图结构核心逻辑测试
 *
 * 运行: npx tsx tests/knowledge-graph.test.ts
 *
 * 验证：
 * 1. 节点添加 + 幂等 getOrCreateNode
 * 2. BFS 邻域查询（queryNeighborhood）
 * 3. 最短路径查询（findPath）
 * 4. 关系一致性检查（checkRelationshipConsistency）
 */
import { knowledgeGraph } from '../src/lib/knowledge-graph';

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

const BRANCH = 'main';
const TEST_NODES = ['刘备', '关羽', '张飞', '桃园结义', '洛阳', '董卓'];
void TEST_NODES; // 仅供文档参考

async function main() {
  console.log('\n📦 knowledge-graph tests\n');

  // ── 1. 节点添加 + 幂等 ──
  console.log('addNode + getOrCreateNode:');
  const liuBei = await knowledgeGraph.getOrCreateNode({ type: 'character', name: '刘备', branchId: BRANCH });
  const guanYu = await knowledgeGraph.getOrCreateNode({ type: 'character', name: '关羽', branchId: BRANCH });
  const zhangFei = await knowledgeGraph.getOrCreateNode({ type: 'character', name: '张飞', branchId: BRANCH });
  const taoYuan = await knowledgeGraph.getOrCreateNode({ type: 'event', name: '桃园结义', branchId: BRANCH });
  const luoYang = await knowledgeGraph.getOrCreateNode({ type: 'location', name: '洛阳', branchId: BRANCH });
  const dongZhuo = await knowledgeGraph.getOrCreateNode({ type: 'character', name: '董卓', branchId: BRANCH });

  assert(!!liuBei.id && !!guanYu.id && !!zhangFei.id, '三个角色节点创建成功');

  // 幂等：重复创建同名节点返回同一个
  const liuBeiAgain = await knowledgeGraph.getOrCreateNode({ type: 'character', name: '刘备', branchId: BRANCH });
  assert(liuBeiAgain.id === liuBei.id, 'getOrCreateNode 同名节点幂等');

  // ── 2. 加边 ──
  console.log('\naddEdge:');
  const e1 = await knowledgeGraph.addEdge({
    source: liuBei.id, target: guanYu.id, type: 'ally_of', branchId: BRANCH, segmentId: 's1',
    properties: { note: '桃园结义，情同手足' },
  });
  const e2 = await knowledgeGraph.addEdge({
    source: liuBei.id, target: zhangFei.id, type: 'ally_of', branchId: BRANCH, segmentId: 's1',
  });
  const e3 = await knowledgeGraph.addEdge({
    source: guanYu.id, target: taoYuan.id, type: 'involves', branchId: BRANCH, segmentId: 's1',
  });
  const e4 = await knowledgeGraph.addEdge({
    source: liuBei.id, target: luoYang.id, type: 'located_at', branchId: BRANCH, segmentId: 's2',
  });
  const e5 = await knowledgeGraph.addEdge({
    source: luoYang.id, target: dongZhuo.id, type: 'conflicts_with', branchId: BRANCH, segmentId: 's2',
  });
  assert(!!e1.id && !!e2.id && !!e3.id && !!e4.id && !!e5.id, '5条边创建成功');

  // ── 3. BFS 邻域查询 ──
  console.log('\nqueryNeighborhood (BFS):');
  const sub2 = await knowledgeGraph.queryNeighborhood('刘备', BRANCH, 2);
  assert(sub2 !== null, '刘备 2跳邻域查询返回结果');
  if (sub2) {
    // 刘备1跳：关羽、张飞、桃园结义、洛阳（盟友+参与+位于）
    // 刘备2跳：董卓（经洛阳）
    const names = sub2.nodes.map(n => n.name);
    assert(names.includes('关羽'), 'BFS 2跳包含关羽');
    assert(names.includes('张飞'), 'BFS 2跳包含张飞');
    assert(names.includes('桃园结义'), 'BFS 2跳包含桃园结义');
    assert(names.includes('洛阳'), 'BFS 2跳包含洛阳');
    assert(names.includes('董卓'), 'BFS 2跳包含董卓（2跳可达）');
    assert(sub2.edges.length >= 4, `BFS 返回${sub2.edges.length}条边`);
  }

  const sub1 = await knowledgeGraph.queryNeighborhood('董卓', BRANCH, 1);
  assert(sub1 !== null, '董卓 1跳邻域查询返回结果');
  if (sub1) {
    const names = sub1.nodes.map(n => n.name);
    assert(names.includes('洛阳'), '董卓1跳包含洛阳');
    assert(!names.includes('刘备'), '董卓1跳不包含刘备（刘备是2跳）');
  }

  // ── 4. 最短路径 ──
  console.log('\nfindPath (shortest path):');
  const path = await knowledgeGraph.findPath('张飞', '董卓', BRANCH);
  assert(path !== null, '张飞→董卓存在路径');
  if (path) {
    // 张飞 → 刘备 → 洛阳 → 董卓 (3条边)
    assert(path.edges.length === 3, `路径边数=${path.edges.length} (期望3)`);
    assert(path.nodes.length === 4, `路径节点数=${path.nodes.length} (期望4)`);
    const nameOrder = path.nodes.map(n => n.name);
    assert(nameOrder[0] === '张飞' && nameOrder[3] === '董卓', `路径 ${nameOrder.join('→')}`);
  }

  // ── 5. 关系一致性检查 ──
  console.log('\ncheckRelationshipConsistency:');
  // 董卓与洛阳是 conflicts_with，写"董卓与洛阳携手合作"应该报错
  const friendlyText = '董卓来到洛阳，与洛阳守军携手合作，共商大计。';
  const friendlyIssues = await knowledgeGraph.checkRelationshipConsistency(friendlyText, BRANCH);
  assert(friendlyIssues.some(i => i.edge.type === 'conflicts_with'), '敌对关系写成友好互动→报错');

  // 正常敌对描写不报错
  const hostileText = '董卓率军攻打洛阳，洛阳守军拼死抵抗。';
  const hostileIssues = await knowledgeGraph.checkRelationshipConsistency(hostileText, BRANCH);
  assert(!hostileIssues.some(i => i.edge.type === 'conflicts_with'), '正常敌对描写→不误报');

  // 刘备与关羽是 ally_of，写背叛应该预警
  const betrayalText = '刘备背叛了关羽，两人反目成仇。';
  const betrayalIssues = await knowledgeGraph.checkRelationshipConsistency(betrayalText, BRANCH);
  assert(betrayalIssues.some(i => i.edge.type === 'ally_of'), '盟友写成背叛→预警');

  // ── 6. 跨分支隔离 ──
  console.log('\nbranch isolation:');
  const otherBranch = 'branch_2';
  await knowledgeGraph.getOrCreateNode({ type: 'character', name: '刘备', branchId: otherBranch });
  const otherSub = await knowledgeGraph.queryNeighborhood('刘备', otherBranch, 2);
  assert(otherSub !== null && otherSub.nodes.length === 1, '另一分支的刘备无关联节点（隔离生效）');

  // 统计
  const stats = await knowledgeGraph.getStats();
  assert(stats.totalNodes >= 6, `图谱共${stats.totalNodes}个节点`);

  // ── 清理：重置空图，避免污染 data/ ──
  await knowledgeGraph.resetForTest();
  console.log('\n(测试结束已重置图谱文件)');

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('测试执行失败:', e);
  process.exit(1);
});
