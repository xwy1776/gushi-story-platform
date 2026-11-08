/**
 * KG 实体/关系抽取评测：P / R / F1
 *
 * 原稿：喻荣海 2026-10-08（`scripts/kg-evaluate.ts`）
 *
 * ⚠️ 2026-10-11 适配说明（肖文宇改）——原稿无法运行，改动如下：
 *
 *   1. 原稿 `import { extractEntitiesAndRelations } from "../src/lib/knowledge-graph"`
 *      该函数不存在。真实接口是 `knowledgeGraph.extractFromSegment(text, branchId, segmentId, callAIFn)`，
 *      见 src/lib/knowledge-graph.ts:738。
 *   2. 原稿按 `pred.entities` / `pred.relations` 取值，但真实返回值是
 *      `{ nodes: KnowledgeNode[], edges: KnowledgeEdge[] }`。
 *   3. `KnowledgeEdge` 的 source/target 存的是**节点 ID**，不是名字，
 *      故比较前需先用节点表把 ID 映射回名字。
 *   4. 真值用 `"person"`，图谱的 NodeType 用 `"character"`；加了别名归一化，
 *      否则实体集恒为空交集、F1 恒为 0。
 *   5. 图谱的关系类型是固定枚举（ally_of / conflicts_with …），真值用的是
 *      自由中文词（相识 …），两套词汇不相交 → 严格口径的关系 F1 必然是 0。
 *      因此额外输出一列「关系（忽略关系名）」，只比 source→target 对。
 *      关系名怎么对齐请喻荣海定。
 *   6. 每条真值前 `resetForTest()`，避免上一条故事的节点混进下一条。
 *
 * 另注：`data/eval/truth_chibi.json` 的 `text` 字段目前只有「赤壁之战」四个字，
 * 没有故事正文，抽取模型无输入可抽 —— 该条数据需要重做（见交接文档）。
 *
 * 运行: npx tsx scripts/kg-evaluate.ts
 */
import '../tests/test-env';
import fs from 'fs';
import path from 'path';
import { knowledgeGraph } from '../src/lib/knowledge-graph';
import { callAIText } from '../src/lib/ai-client';

type TruthItem = {
  text: string;
  entities: Array<{ name: string; type: string }>;
  relations: Array<{ source: string; target: string; relation: string }>;
};

const BRANCH = 'kg_eval';

/** 真值里的类型词 → 图谱 NodeType（只做加法，两边同时归一化） */
const TYPE_ALIAS: Record<string, string> = {
  person: 'character',
  people: 'character',
  place: 'location',
  organization: 'faction',
};
const normType = (t: string) => TYPE_ALIAS[t] ?? t;

// 计算集合P/R/F1
function calcPRF1(goldSet: Set<string>, predSet: Set<string>) {
  const tp = [...predSet].filter(x => goldSet.has(x)).length;
  const fp = [...predSet].filter(x => !goldSet.has(x)).length;
  const fn = [...goldSet].filter(x => !predSet.has(x)).length;

  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall);
  return { tp, fp, fn, precision, recall, f1 };
}

async function runEval(filePath: string) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const truth: TruthItem = JSON.parse(raw);

  // 清空图谱，避免上一条故事的节点残留
  await knowledgeGraph.resetForTest();

  // 调用抽取函数（会实际发起 LLM 请求）
  const pred = await knowledgeGraph.extractFromSegment(
    truth.text,
    BRANCH,
    path.basename(filePath),
    (p) => callAIText(p, { maxTokens: 1500 }),
  );

  // 实体集合：name+type作为key
  const goldEnt = new Set(truth.entities.map(e => `${e.name}|${normType(e.type)}`));
  const predEnt = new Set(pred.nodes.map(n => `${n.name}|${n.type}`));
  const entMetric = calcPRF1(goldEnt, predEnt);

  // 边的 source/target 是节点 ID，先建 ID → 名字的映射
  const idToName = new Map(pred.nodes.map(n => [n.id, n.name]));
  const edgePairs: Array<{ s: string; t: string; type: string }> = [];
  for (const e of pred.edges) {
    const s = idToName.get(e.source);
    const t = idToName.get(e.target);
    if (s && t) edgePairs.push({ s, t, type: e.type });
  }

  // 关系集合：source-target-relation作为key
  const goldRel = new Set(truth.relations.map(r => `${r.source}|${r.target}|${r.relation}`));
  const predRel = new Set(edgePairs.map(e => `${e.s}|${e.t}|${e.type}`));
  const relMetric = calcPRF1(goldRel, predRel);

  // 关系（忽略关系名）：只比 source→target 对，用于绕开两套关系词汇不相交的问题
  const goldPair = new Set(truth.relations.map(r => `${r.source}|${r.target}`));
  const predPair = new Set(edgePairs.map(e => `${e.s}|${e.t}`));
  const relPairMetric = calcPRF1(goldPair, predPair);

  console.log(`\n====== ${path.basename(filePath)} ======`);
  console.log("【实体评测】", entMetric);
  console.log("【关系评测】", relMetric);
  console.log("【关系评测（忽略关系名）】", relPairMetric);

  return { file: path.basename(filePath), entMetric, relMetric, relPairMetric };
}

async function main() {
  const evalDir = path.resolve(__dirname, '../data/eval');
  const files = fs.readdirSync(evalDir)
    .filter(f => f.startsWith('truth_') && f.endsWith('.json'))
    .map(f => path.join(evalDir, f));

  if (files.length === 0) {
    console.error("data/eval 下没有找到 truth_*.json 真值文件");
    return;
  }

  const results = [];
  for (const f of files) {
    const res = await runEval(f);
    results.push(res);
  }

  console.log("\n==========全部评测完成，汇总==========");
  console.table(results.map(r => ({
    文件: r.file,
    实体P: r.entMetric.precision.toFixed(3),
    实体R: r.entMetric.recall.toFixed(3),
    实体F1: r.entMetric.f1.toFixed(3),
    关系P: r.relMetric.precision.toFixed(3),
    关系R: r.relMetric.recall.toFixed(3),
    关系F1: r.relMetric.f1.toFixed(3),
    关系F1_忽略关系名: r.relPairMetric.f1.toFixed(3),
  })));
}

main().catch(e => { console.error(e); process.exit(1); });
