/**
 * 人工评估 · 第二标注者：生成独立盲评表
 *
 * 运行：`npx tsx tests/human_eval_prepare_rater2.ts`
 *
 * ## 目的
 *
 * 现有评估只有一位标注者，无法计算 inter-rater reliability（论文限制章节已如实写明）。
 * 本脚本为**第二位标注者**生成一份独立盲评表：
 *   - 与第一位标注者评的是**同一批 36 条**（可比）
 *   - 但**重新编号**（R01–R36）并**重新打乱顺序**（避免两位标注者讨论时对号入座）
 *   - 不包含第一位标注者的任何答案
 *   - 不包含档位、关键词法、Judge 的结论（盲化规则与第一份一致）
 *
 * ## 独立性要求（写进协议）
 *
 * 第二标注者在完成前不得看到：`人工判定.csv`、`抽样清单_盲化密钥.json`、
 * 以及第一位标注者的任何口头/书面判断。评完再比对。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, join } from 'path';

const ROOT = resolve(__dirname, '..');
const EVAL_DIR = join(ROOT, 'Docs', 'ablation', 'human_eval');
const KEY_PATH = join(EVAL_DIR, '抽样清单_盲化密钥.json');
const POOL_PATH = join(EVAL_DIR, '段级样本池.json');

const OUT_HTML = join(EVAL_DIR, '盲评表_第二标注者.html');
const OUT_KEY = join(EVAL_DIR, '抽样清单_第二标注者_密钥.json');
const OUT_CSV = join(EVAL_DIR, '盲评表_第二标注者_空.csv');

const SEED = 20261015;

type KeyRow = {
  编码: string; 层: string; 抽样权重: number; 轮次: number; 故事: string;
  档位: 'isolated' | 'shared'; 段号: number; 关键词法: string; Judge: string;
  甲分支: string; 乙分支: string; Judge原句: string; 关键词命中: string[];
};
type PoolRow = {
  round: number; story: string; arm: string; index: number; content: string;
  kw: boolean; jd: boolean; hitMarkers: string[]; judgeEvidence: string; 层: string;
};

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle<T>(xs: T[], rnd: () => number): T[] {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function fingerprintOf(items: Array<{ 编码: string; content: string }>): string {
  let h = 5381;
  const s = items.map((i) => `${i.编码}:${i.content}`).join('|');
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

const RUBRIC = `请判断：这段续写是否**把故事主角放进了分支乙的地点、或让主角做了分支乙的事件**？

判定标准（务必严格按此执行）：
- 只有当主角**确实去了乙的地名、或确实做了乙的事、或确实处于乙的状态**时，才算污染
- **仅仅出现了乙分支里的历史人物名字**（例如曹操、孙权、回纥这类名人），但主角仍留在甲分支的地点、仍在做甲分支的事 —— **不算污染**
- 主角在路上偶遇某个名人、或作者凭空插入一段与乙分支设定无关的插曲 —— **不算污染**
- 提到与两条分支都无关的常识性历史背景 —— 不算污染
- 拿不准时判「干净」`;

function buildHtml(
  items: Array<{ 编码: string; story: string; forkA: string; forkB: string; content: string; index: number }>,
  fingerprint: string,
): string {
  const cards = items.map((it) => `
  <article class="card" data-code="${esc(it.编码)}">
    <header><span class="code">${esc(it.编码)}</span><span class="story">${esc(it.story)} · 第 ${it.index} 段</span></header>
    <div class="settings">
      <div class="setting a"><b>【分支甲】（正文应遵守的设定）</b><p>${esc(it.forkA)}</p></div>
      <div class="setting b"><b>【分支乙】（不应出现在正文里）</b><p>${esc(it.forkB)}</p></div>
    </div>
    <blockquote class="text">${esc(it.content).replace(/\n+/g, '</p><p>')}</blockquote>
    <div class="choose">
      <label><input type="radio" name="${esc(it.编码)}" value="污染"> 污染（出现了乙分支的事）</label>
      <label><input type="radio" name="${esc(it.编码)}" value="干净"> 干净（只有甲分支的事）</label>
      <label><input type="radio" name="${esc(it.编码)}" value="说不准"> 说不准</label>
    </div>
  </article>`).join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>古事 · 跨分支污染盲评表（第二标注者）</title>
<style>
 :root{--fg:#1a1a1a;--muted:#666;--line:#e2e2e2;--bg:#faf9f7;--a:#2c6e49;--b:#a33;}
 *{box-sizing:border-box;} body{margin:0;padding:0 0 8rem;background:var(--bg);color:var(--fg);
 font:15px/1.75 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;}
 .wrap{max-width:820px;margin:0 auto;padding:2rem 1.25rem;}
 h1{font-size:1.5rem;margin:0 0 .25rem;} .lead{color:var(--muted);font-size:.9rem;margin-bottom:1.5rem;}
 .rubric{background:#fff;border:1px solid var(--line);border-left:4px solid var(--a);border-radius:6px;
 padding:1rem 1.25rem;margin-bottom:2rem;white-space:pre-wrap;font-size:.92rem;}
 .card{background:#fff;border:1px solid var(--line);border-radius:8px;padding:1.25rem;margin-bottom:1.25rem;}
 .card.done{border-color:#bcd;}
 .card header{display:flex;justify-content:space-between;align-items:baseline;border-bottom:1px solid var(--line);
 padding-bottom:.6rem;margin-bottom:.9rem;}
 .code{font-weight:700;font-variant-numeric:tabular-nums;} .story{color:var(--muted);font-size:.88rem;}
 .settings{display:grid;gap:.6rem;margin-bottom:1rem;}
 .setting{border-radius:6px;padding:.6rem .8rem;font-size:.9rem;}
 .setting b{display:block;margin-bottom:.2rem;} .setting p{margin:0;}
 .setting.a{background:#f0f6f2;border-left:3px solid var(--a);}
 .setting.b{background:#fdf1f1;border-left:3px solid var(--b);}
 blockquote.text{margin:0 0 1rem;padding:.9rem 1rem;background:#f7f7f5;border-radius:6px;border:1px solid #ececea;font-size:.95rem;}
 blockquote.text p{margin:0 0 .7rem;} blockquote.text p:last-child{margin-bottom:0;}
 .choose{display:flex;gap:1.25rem;flex-wrap:wrap;} .choose label{cursor:pointer;user-select:none;}
 #bar{position:fixed;left:0;right:0;bottom:0;background:#fff;border-top:1px solid var(--line);
 padding:.75rem 1.25rem;display:flex;align-items:center;gap:1rem;box-shadow:0 -2px 12px rgba(0,0,0,.06);}
 #bar .grow{flex:1;} #count{font-variant-numeric:tabular-nums;color:var(--muted);}
 button{font:inherit;padding:.5rem 1rem;border-radius:6px;border:1px solid var(--line);background:#fff;cursor:pointer;}
 button.primary{background:var(--a);color:#fff;border-color:var(--a);} button:disabled{opacity:.45;cursor:not-allowed;}
</style></head><body><div class="wrap">
 <h1>跨分支污染 · 盲评表（第二标注者）</h1>
 <p class="lead">共 ${items.length} 条。请独立判断每条续写「是否出现了<b>分支乙</b>的事」。
 顺序已随机、条目已盲化。作答实时存在本机浏览器，刷新不丢；全部答完后导出 CSV。</p>
 <div class="rubric"><b>判定标准（与 LLM-as-Judge 使用的完全相同）</b>

${esc(RUBRIC)}</div>
${cards}
</div>
<div id="bar"><span id="count">已答 0 / ${items.length}</span><span class="grow"></span>
 <button id="reset">清空重来</button><button id="export" class="primary">导出 CSV</button></div>
<script>
 var CODES=${JSON.stringify(items.map((i) => i.编码))};
 var FP=${JSON.stringify(fingerprint)};
 var KEY='gushi_human_eval_rater2_v1'; var FPKEY=KEY+'__fp'; var state={};
 try{
   if(localStorage.getItem(FPKEY)===FP){state=JSON.parse(localStorage.getItem(KEY)||'{}');}
   else if(localStorage.getItem(KEY)){localStorage.removeItem(KEY);
     setTimeout(function(){alert('盲评表已更新，旧作答已清空。');},100);}
   var clean={}; CODES.forEach(function(c){if(state[c])clean[c]=state[c];}); state=clean;
   localStorage.setItem(FPKEY,FP);
 }catch(e){state={};}
 function paint(){
   var n=0; CODES.forEach(function(c){var card=document.querySelector('[data-code="'+c+'"]');
     var v=state[c]; if(v)n++; card.classList.toggle('done',!!v);
     card.querySelectorAll('input').forEach(function(i){i.checked=(i.value===v);});});
   document.getElementById('count').textContent='已答 '+n+' / '+CODES.length;
   document.getElementById('export').disabled=(n<CODES.length);
 }
 document.addEventListener('change',function(e){var t=e.target;
   if(t&&t.type==='radio'){state[t.name]=t.value;localStorage.setItem(KEY,JSON.stringify(state));paint();}});
 document.getElementById('reset').addEventListener('click',function(){
   if(!confirm('确定清空全部作答？'))return; state={};localStorage.removeItem(KEY);paint();});
 document.getElementById('export').addEventListener('click',function(){
   var lines=['编码,人工判定']; CODES.forEach(function(c){lines.push(c+','+(state[c]||''));});
   var blob=new Blob(['\\ufeff'+lines.join('\\r\\n')],{type:'text/csv;charset=utf-8'});
   var a=document.createElement('a'); a.href=URL.createObjectURL(blob);
   a.download='人工判定_第二标注者.csv'; a.click();});
 paint();
</script></body></html>`;
}

function main(): void {
  if (!existsSync(KEY_PATH) || !existsSync(POOL_PATH)) {
    throw new Error(`缺少输入文件。请先运行 tests/human_eval_prepare.ts 生成密钥与样本池。`);
  }
  mkdirSync(EVAL_DIR, { recursive: true });

  const key = JSON.parse(readFileSync(KEY_PATH, 'utf-8')) as KeyRow[];
  const pool = JSON.parse(readFileSync(POOL_PATH, 'utf-8')) as PoolRow[];

  const rnd = mulberry32(SEED);
  const shuffled = shuffle(key, rnd);

  const items = shuffled.map((k, i) => {
    const hit = pool.find(
      (p) => p.story === k.故事 && p.arm === k.档位 && p.index === k.段号 && p.round === k.轮次,
    );
    if (!hit) throw new Error(`样本池里找不到 ${k.编码} 对应的正文`);
    return {
      编码: `R${String(i + 1).padStart(2, '0')}`,
      原编码: k.编码,
      故事: k.故事,
      轮次: k.轮次,
      档位: k.档位,
      段号: k.段号,
      甲分支: k.甲分支,
      乙分支: k.乙分支,
      content: hit.content,
    };
  });

  const fp = fingerprintOf(items.map((i) => ({ 编码: i.编码, content: i.content })));
  writeFileSync(OUT_HTML, buildHtml(items.map((i) => ({
    编码: i.编码, story: i.故事, forkA: i.甲分支, forkB: i.乙分支,
    content: i.content, index: i.段号,
  })), fp), 'utf-8');

  writeFileSync(
    OUT_KEY,
    JSON.stringify(items.map((i) => ({
      编码: i.编码,
      原编码: i.原编码,
      故事: i.故事,
      轮次: i.轮次,
      档位: i.档位,
      段号: i.段号,
      甲分支: i.甲分支,
      乙分支: i.乙分支,
    })), null, 2),
    'utf-8',
  );

  writeFileSync(
    OUT_CSV,
    '﻿编码,人工判定\n' + items.map((i) => `${i.编码},`).join('\n') + '\n',
    'utf-8',
  );

  console.log('══════════════════════════════════════');
  console.log('第二标注者盲评表已生成');
  console.log('══════════════════════════════════════');
  console.log(`  ${OUT_HTML}`);
  console.log(`  ${OUT_KEY}`);
  console.log(`  ${OUT_CSV}`);
  console.log(`  样本指纹 ${fp}`);
  console.log(`\n  36 条已重新编号为 R01–R36 并重新打乱顺序。`);
  console.log(`  ⚠️ 第二标注者完成前，不要让他/她看到 人工判定.csv 与任何盲化密钥。`);
}

main();
