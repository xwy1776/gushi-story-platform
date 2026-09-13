/**
 * 临时诊断脚本：图谱注入到底往 Prompt 里塞了什么
 *
 * 背景：消融实验里 `both` 档（0.177）反而比 `state` 单档（0.043）更差，
 * `graph` 单档（0.254）几乎等于基线（0.332）。怀疑图谱注入是噪声源。
 *
 * 本脚本复现「郭子仪单骑退敌」这一档（最终图谱 312-360 节点）的构链过程：
 *   1. 按消融脚本的初始条件播种 5 条边
 *   2. 用消融实验真实生成的 5 段文本跑 extractFromSegment（会调 AI）
 *   3. 每步打印节点/边增长，最后打印 buildPromptContext 的全文与长度
 *
 * 运行: npx tsx scripts/diag-graph-injection.ts
 */
import '../tests/test-env';
import fs from 'fs';
import path from 'path';
import { knowledgeGraph } from '../src/lib/knowledge-graph';
import { callAIText } from '../src/lib/ai-client';

const BRANCH = 'diag_branch';
const STORY = '郭子仪单骑退敌';

/** 与 tests/ab_ablation.ts 的 ALL_STORY_DEFS 保持一致 */
const SEED_EDGES = [
  { from: '郭子仪', to: '回纥可汗', type: 'ally_of' },
  { from: '郭子仪', to: '吐蕃赞普', type: 'conflicts_with' },
  { from: '回纥可汗', to: '吐蕃赞普', type: 'ally_of' },
  { from: '郭子仪', to: '单骑退敌', type: 'involves' },
  { from: '长安', to: '郭子仪', type: 'located_at' },
];
const SEED_CHARACTERS = ['郭子仪', '回纥可汗', '吐蕃赞普'];

async function main() {
  const results = Object.values(
    JSON.parse(
      fs.readFileSync(path.resolve('Docs/ablation/ablation_results_full_5x5.json'), 'utf8'),
    ),
  ) as any[];
  const rec = results.find((r) => r.arm === 'none' && r.story === STORY);
  if (!rec) throw new Error(`找不到 ${STORY} 的结果记录`);

  await knowledgeGraph.resetForTest();

  for (const e of SEED_EDGES) {
    const n1 = await knowledgeGraph.getOrCreateNode({ type: 'character', name: e.from, branchId: BRANCH });
    const n2 = await knowledgeGraph.getOrCreateNode({ type: 'character', name: e.to, branchId: BRANCH });
    await knowledgeGraph.addEdge({
      source: n1.id, target: n2.id, type: e.type as any, branchId: BRANCH, segmentId: 'seed',
    });
  }
  let st = await knowledgeGraph.getStats();
  console.log(`\n播种后: ${st.totalNodes} 节点 / ${st.totalEdges} 边\n`);

  console.log('=== 逐段抽取（每段 1 次 AI 调用）===');
  for (let i = 0; i < rec.segments.length; i++) {
    const before = await knowledgeGraph.getStats();
    await knowledgeGraph.extractFromSegment(rec.segments[i], BRANCH, `diag_${i}`, (p) =>
      callAIText(p, { maxTokens: 1500 }),
    );
    const after = await knowledgeGraph.getStats();
    console.log(
      `  段${i + 1}: 节点 ${before.totalNodes} → ${after.totalNodes} (+${after.totalNodes - before.totalNodes})` +
      `  边 ${before.totalEdges} → ${after.totalEdges} (+${after.totalEdges - before.totalEdges})`,
    );
  }

  st = await knowledgeGraph.getStats();
  console.log(`\n最终: ${st.totalNodes} 节点 / ${st.totalEdges} 边`);

  // ── 关键：复现 prompt-builder 第 3.8 节的调用方式 ──
  const graphText = await knowledgeGraph.buildPromptContext(BRANCH, SEED_CHARACTERS, [], 2);
  console.log(`\n=== buildPromptContext 输出（${graphText.length} 字符）===`);
  console.log(graphText);

  // ── 图谱里都是些什么节点（直接读存储文件）──
  const raw = JSON.parse(fs.readFileSync(path.resolve('data/knowledge-graph.json'), 'utf8'));
  const byType: Record<string, string[]> = {};
  for (const n of raw.nodes) (byType[n.type] ||= []).push(n.name);
  console.log('\n=== 节点按类型分布 ===');
  for (const [t, names] of Object.entries(byType)) {
    console.log(`  ${t} (${names.length}): ${names.slice(0, 30).join('、')}${names.length > 30 ? ' …' : ''}`);
  }

  await knowledgeGraph.resetForTest();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
