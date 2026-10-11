import fs from "fs";
import path from "path";
import { extractEntitiesAndRelations } from "../src/lib/knowledge-graph";

type TruthItem = {
  text: string;
  entities: Array<{ name: string; type: string }>;
  relations: Array<{ source: string; target: string; relation: string }>;
};

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
  const raw = fs.readFileSync(filePath, "utf-8");
  const truth: TruthItem = JSON.parse(raw);

  //调用抽取函数
  const pred = await extractEntitiesAndRelations(truth.text);

  //实体集合：name+type作为key
  const goldEnt = new Set(truth.entities.map(e => `${e.name}|${e.type}`));
  const predEnt = new Set(pred.entities.map(e => `${e.name}|${e.type}`));
  const entMetric = calcPRF1(goldEnt, predEnt);

  //关系集合：source-target-relation作为key
  const goldRel = new Set(truth.relations.map(r => `${r.source}|${r.target}|${r.relation}`));
  const predRel = new Set(pred.relations.map(r => `${r.source}|${r.target}|${r.relation}`));
  const relMetric = calcPRF1(goldRel, predRel);

  console.log(`\n====== ${path.basename(filePath)} ======`);
  console.log("【实体评测】", entMetric);
  console.log("【关系评测】", relMetric);

  return { file: path.basename(filePath), entMetric, relMetric };
}

async function main() {
  const evalDir = path.resolve(__dirname, "../data/eval");
  const files = fs.readdirSync(evalDir)
    .filter(f => f.startsWith("truth_") && f.endsWith(".json"))
    .map(f => path.join(evalDir, f));

  if(files.length === 0) {
    console.error("data/eval 下没有找到 truth_*.json 真值文件");
    return;
  }

  const results = [];
  for(const f of files) {
    const res = await runEval(f);
    results.push(res);
  }

  console.log("\n==========全部评测完成，汇总==========");
  console.table(results.map(r=>({
    文件: r.file,
    实体P: r.entMetric.precision.toFixed(3),
    实体R: r.entMetric.recall.toFixed(3),
    实体F1: r.entMetric.f1.toFixed(3),
    关系P: r.relMetric.precision.toFixed(3),
    关系R: r.relMetric.recall.toFixed(3),
    关系F1: r.relMetric.f1.toFixed(3),
  })));
}

main().catch(e=>{console.error(e);process.exit(1);});