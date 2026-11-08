/**
 * 评测图表生成器
 *
 * 读 llm_judge.ts 产出的 judge_results_*.json，生成一张**自包含**的 HTML 报告
 * （内联 SVG + 内联 CSS/JS，零外部依赖，双击即可用浏览器打开）。
 *
 * ── 三张图分别回答什么问题 ────────────────────────────────────────
 *   图1 四维 × 档位 小倍数柱状图 —— 「各档位在每个维度上表现如何」
 *   图2 跨轮趋势折线图         —— 「这个排序在不同轮次之间稳不稳」
 *   图3 配对差值 + 95%CI 点图  —— 「处理档相对基线的提升，是否显著」
 *
 * 图 2 和图 3 是这份数据的重点：档位间的差距若小于轮间波动，
 * 就不能宣称任何档位「更好」—— 图必须如实呈现这一点，而不是美化排序。
 *
 * ── 配色 ────────────────────────────────────────────────────────
 * 4 个档位是**并列类别**（state 与 graph 是两种平行的记忆，不是有序刻度），
 * 因此用 categorical 前 4 槽而非 sequential 渐变 —— 渐变会暗示一个不存在的
 * 大小顺序。取色与验证见 dataviz skill：light/dark 均已跑过
 * validate_palette.js，四色全项 PASS（最差相邻 CVD ΔE 9.1 light / 8.4 dark）。
 * light 模式下 aqua 与 yellow 对比度低于 3:1，故必须同时提供**图例 +
 * 直接标签 + 表格视图**三重冗余（见 relief rule）。
 *
 * ── 运行 ────────────────────────────────────────────────────────
 *   npx tsx tests/make_charts.ts                  # 用最新的 judge_results
 *   npx tsx tests/make_charts.ts --input=<path>   # 指定结果文件
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, resolve, basename } from 'path';
import { analyzePairedDiff, pairedDiffs } from './paired-stats';

const OUT_DIR = resolve(__dirname, '..', 'Docs', 'ablation');

// ============================================================================
// 数据
// ============================================================================

const DIMENSIONS = ['character', 'causality', 'timeline', 'emotion'] as const;
type Dimension = (typeof DIMENSIONS)[number];

const DIMENSION_ZH: Record<Dimension, string> = {
  character: '角色稳定',
  causality: '事件因果',
  timeline: '时间线连续',
  emotion: '情感连贯',
};

/** 档位 = 并列类别，固定取 categorical 前 4 槽（顺序即 CVD 安全的机制，不可打乱） */
const SERIES = [
  { key: 'none', zh: '无记忆', light: '#2a78d6', dark: '#3987e5' },
  { key: 'state', zh: '仅状态表', light: '#eb6834', dark: '#d95926' },
  { key: 'graph', zh: '仅图谱', light: '#1baf7a', dark: '#199e70' },
  { key: 'both', zh: '状态表+图谱', light: '#eda100', dark: '#c98500' },
] as const;

interface ResultRecord {
  id: string;
  story: string;
  arm: string;
  round: string;
  scores: Record<Dimension, number>;
  total: number;
}

interface Stats {
  mean: number;
  sd: number;
  se: number;
  n: number;
  ci95: number;
}

function stats(xs: number[]): Stats {
  if (xs.length === 0) return { mean: NaN, sd: NaN, se: NaN, n: 0, ci95: NaN };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.length > 1
    ? xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1)
    : 0;
  const sd = Math.sqrt(variance);
  const se = sd / Math.sqrt(xs.length);
  return { mean, sd, se, n: xs.length, ci95: 1.96 * se };
}

function loadResults(path: string): { records: ResultRecord[]; meta: Record<string, unknown> } {
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  return { records: raw.results as ResultRecord[], meta: raw.meta ?? {} };
}

// ============================================================================
// 基础工具
// ============================================================================

/** HTML 转义 —— 标签文本一律经此，绝不拼 innerHTML */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

/** 数字保留 n 位小数，去掉多余的 0 */
function fmt(x: number, n = 2): string {
  if (!Number.isFinite(x)) return '—';
  return x.toFixed(n);
}

/**
 * 顶部圆角、底部方角的柱子 path。
 * 规范：4px 圆角数据端、基线端方角 —— SVG rect 只能四角同圆，故用 path 画。
 */
function barPath(x: number, y: number, w: number, h: number, r = 4): string {
  if (h <= 0) return '';
  const rr = Math.min(r, w / 2, h);
  return [
    `M ${x} ${y + h}`,
    `L ${x} ${y + rr}`,
    `Q ${x} ${y} ${x + rr} ${y}`,
    `L ${x + w - rr} ${y}`,
    `Q ${x + w} ${y} ${x + w} ${y + rr}`,
    `L ${x + w} ${y + h}`,
    'Z',
  ].join(' ');
}

/** 线性比例尺 */
function scale(domain: [number, number], range: [number, number]) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  return (v: number) => (d1 === d0 ? r0 : r0 + ((v - d0) / (d1 - d0)) * (r1 - r0));
}

// ============================================================================
// 图 1：四维 × 档位 小倍数柱状图
// ============================================================================

function chartDimensionsByArm(records: ResultRecord[]): string {
  const CW = 300; // 单格宽
  const CH = 208; // 单格高
  const PAD_L = 34;
  const PAD_R = 10;
  const PAD_T = 18;
  const PAD_B = 42;
  const plotW = CW - PAD_L - PAD_R;
  const plotH = CH - PAD_T - PAD_B;

  const y = scale([1, 5], [PAD_T + plotH, PAD_T]);
  const bandW = plotW / SERIES.length;
  const BAR_W = Math.min(24, bandW - 16); // ≤24px，且留出 2px+ 的表面间隙

  const cells = DIMENSIONS.map((dim, ci) => {
    const cx = (ci % 2) * CW;
    const cy = Math.floor(ci / 2) * CH;

    // 注意：y() 返回的是「子图内部」坐标（PAD_T..PAD_T+plotH），
    // 每个子图还要叠上自己的行偏移 cy —— 漏掉它会把第 2 行的柱子画到第 1 行上。
    const bars = SERIES.map((s, si) => {
      const vals = records.filter((r) => r.arm === s.key).map((r) => r.scores[dim]);
      const st = stats(vals);
      const bx = cx + PAD_L + si * bandW + (bandW - BAR_W) / 2;
      const by = cy + y(st.mean);
      const bh = PAD_T + plotH - y(st.mean);
      const color = `var(--s-${s.key})`;

      return [
        `<path d="${barPath(bx, by, BAR_W, bh)}" fill="${color}"`,
        ` data-arm="${esc(s.key)}" data-dim="${esc(dim)}" data-val="${fmt(st.mean)}"`,
        ` data-n="${st.n}" class="bar-hit"/>`,
      ].join('');
    }).join('');

    // y 轴刻度（1..5，整数）
    const ticks = [1, 2, 3, 4, 5].map((t) =>
      [
        `<line x1="${cx + PAD_L}" y1="${cy + y(t)}" x2="${cx + PAD_L + plotW}" y2="${cy + y(t)}" class="grid"/>`,
        `<text x="${cx + PAD_L - 6}" y="${cy + y(t) + 3.5}" class="tick tick-end">${t}</text>`,
      ].join(''),
    ).join('');

    // x 轴档位名（直接标签 —— 4 系列时必须有，也是低对比色的 relief）
    const xLabels = SERIES.map((s, si) => {
      const lx = cx + PAD_L + si * bandW + bandW / 2;
      return `<text x="${lx}" y="${cy + PAD_T + plotH + 15}" class="tick tick-mid">${esc(s.zh)}</text>`;
    }).join('');

    return [
      `<g>`,
      `<text x="${cx + PAD_L}" y="${cy + 12}" class="cell-title">${esc(DIMENSION_ZH[dim])}</text>`,
      ticks,
      `<line x1="${cx + PAD_L}" y1="${cy + y(1)}" x2="${cx + PAD_L + plotW}" y2="${cy + y(1)}" class="axis"/>`,
      bars,
      xLabels,
      `</g>`,
    ].join('');
  }).join('');

  return [
    `<svg viewBox="0 0 ${CW * 2} ${CH * 2}" class="chart" role="img"`,
    ` aria-label="四个维度上各档位的平均得分对比">`,
    cells,
    `</svg>`,
  ].join('');
}

// ============================================================================
// 图 2：跨轮趋势折线图
// ============================================================================

function chartTrendByRound(records: ResultRecord[], rounds: string[]): string {
  const W = 780;
  const H = 300;
  const PAD_L = 52;
  const PAD_R = 140; // 右侧留给末端直接标签（中文档位名 + 数值）
  const PAD_T = 20;
  const PAD_B = 48;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  const seriesData = SERIES.map((s) => {
    const pts = rounds.map((rd) => {
      const rs = records.filter((r) => r.arm === s.key && r.round === rd);
      return stats(rs.map((r) => r.total)).mean;
    });
    const flat = pts.filter(Number.isFinite);
    return { s, pts, mean: flat.reduce((a, b) => a + b, 0) / (flat.length || 1) };
  });

  // y 轴范围：覆盖所有点的 min/max，留 12% 余量
  const allVals = seriesData.flatMap((d) => d.pts).filter(Number.isFinite);
  const lo = Math.floor(Math.min(...allVals) - 0.6);
  const hi = Math.ceil(Math.max(...allVals) + 0.6);
  const y = scale([lo, hi], [PAD_T + plotH, PAD_T]);
  const x = scale([0, Math.max(rounds.length - 1, 1)], [PAD_L, PAD_L + plotW]);

  const ticks = [];
  for (let t = lo; t <= hi; t++) {
    ticks.push(
      `<line x1="${PAD_L}" y1="${y(t)}" x2="${PAD_L + plotW}" y2="${y(t)}" class="grid"/>` +
        `<text x="${PAD_L - 8}" y="${y(t) + 3.5}" class="tick tick-end">${t}</text>`,
    );
  }

  const xLabels = rounds.map((rd, i) =>
    `<text x="${x(i)}" y="${PAD_T + plotH + 18}" class="tick tick-mid">${esc(rd)}</text>`,
  ).join('');

  const lines = seriesData.map(({ s, pts }) => {
    const d = pts
      .map((v, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(v)}`)
      .join(' ');
    // 末端 marker：r=4（≥8px 直径）+ 2px 表面色描边环
    const lastI = pts.length - 1;
    const marker = Number.isFinite(pts[lastI])
      ? `<circle cx="${x(lastI)}" cy="${y(pts[lastI])}" r="4" fill="var(--s-${s.key})" class="ring"/>`
      : '';
    return [
      `<path d="${d}" fill="none" stroke="var(--s-${s.key})" stroke-width="2"`,
      ` stroke-linecap="round" stroke-linejoin="round"/>`,
      marker,
    ].join('');
  }).join('');

  // 末端直接标签：四档的「全部均值」落在 11.8–12.3 的窄带里，直接按值定位必然重叠。
  // 规范禁止「把标签堆叠起来」（会脱离所属线条、读成噪声），故做垂直避让，
  // 并用一条细引线把标签连回它自己的线端。
  const LABEL_GAP = 15;
  const ranked = [...seriesData].sort((a, b) => y(a.mean) - y(b.mean));
  const placed: Array<{ key: string; zh: string; mean: number; y0: number; ly: number }> = [];
  let prevLy = -Infinity;
  for (const d of ranked) {
    const y0 = y(d.mean);
    const ly = Math.max(y0, prevLy + LABEL_GAP);
    prevLy = ly;
    placed.push({ key: d.s.key, zh: d.s.zh, mean: d.mean, y0, ly });
  }

  const endLabels = placed
    .map(({ key, zh, mean, y0, ly }) =>
      [
        `<path d="M ${PAD_L + plotW + 3} ${y0} L ${PAD_L + plotW + 13} ${ly}"`,
        ` fill="none" stroke="var(--axis)" stroke-width="1"/>`,
        `<text x="${PAD_L + plotW + 17}" y="${ly + 3.5}" class="tick end-label">`,
        `<tspan class="end-key" fill="var(--s-${key})">—</tspan> ${esc(zh)} ${fmt(mean)}</text>`,
      ].join(''),
    )
    .join('');

  // 每个数据点一个透明命中圆：r=12（24px 直径），远大于 2px 线宽，
  // 避免「必须精确落在线上」的 pinpoint 目标。
  const hitPoints = seriesData
    .flatMap(({ s, pts }) =>
      pts.map((v, i) =>
        Number.isFinite(v)
          ? [
              `<circle cx="${x(i)}" cy="${y(v)}" r="12" fill="transparent"`,
              ` data-arm="${esc(s.key)}" data-key="${esc(s.zh)}"`,
              ` data-round="${esc(rounds[i])}" data-val="${fmt(v)}" class="pt-hit"/>`,
            ].join('')
          : '',
      ),
    )
    .join('');

  return [
    `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img"`,
    ` aria-label="各档位总分在不同轮次间的变化趋势">`,
    ticks,
    `<line x1="${PAD_L}" y1="${PAD_T + plotH}" x2="${PAD_L + plotW}" y2="${PAD_T + plotH}" class="axis"/>`,
    xLabels,
    lines,
    hitPoints,
    endLabels,
    `<text x="${PAD_L}" y="${H - 10}" class="tick tick-start">横轴 = 实验轮次　纵轴 = 四维总分均值（4–20）</text>`,
    `</svg>`,
  ].join('');
}

// ============================================================================
// 图 3：配对差值 + 95% CI
// ============================================================================

function chartPairedDiff(records: ResultRecord[]): string {
  // 水平 forest plot：档位分成三行，**差值走横轴**。
  // （先前版本把差值放在纵轴、却又按档位分行 —— 两个维度打架，三个点全挤成一团，
  //   且与各自的行标签错位。）
  const W = 560;
  const H = 250;
  const PAD_L = 100; // 左侧：档位名 + 显著性
  const PAD_R = 74; // 右侧：值标签
  const PAD_T = 34;
  const PAD_B = 50;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  // 配对：同一 (轮次, 故事) 下，处理档 − none。
  // 比较次数 = 处理档个数，交给 analyzePairedDiff 做 Bonferroni 校正 ——
  // 不做校正的话，三个比较里最容易「碰巧显著」的那个会被误报成显著。
  const treatArms = SERIES.filter((s) => s.key !== 'none');
  const rows = treatArms.map((s) => {
    const diffs = pairedDiffs(records, s.key, 'none');
    return { s, pr: analyzePairedDiff(diffs, treatArms.length) };
  });

  const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r.pr.mean) + r.pr.ci)) * 1.05;
  const x = scale([-maxAbs, maxAbs], [PAD_L, PAD_L + plotW]);
  const bandH = plotH / rows.length;
  const zeroX = x(0);

  // 竖直零线：差值 = 0 的参考位置
  const zeroLine =
    `<line x1="${zeroX}" y1="${PAD_T - 6}" x2="${zeroX}" y2="${PAD_T + plotH + 6}" class="zero-line"/>` +
    `<text x="${zeroX}" y="${PAD_T + plotH + 22}" class="tick tick-mid">0 无差异</text>`;

  // 横轴刻度
  const xTicks: string[] = [];
  for (let v = Math.ceil(-maxAbs); v <= Math.floor(maxAbs); v++) {
    if (v === 0) continue;
    xTicks.push(
      `<line x1="${x(v)}" y1="${PAD_T}" x2="${x(v)}" y2="${PAD_T + plotH}" class="grid"/>` +
        `<text x="${x(v)}" y="${PAD_T + plotH + 22}" class="tick tick-mid">${v > 0 ? '+' : ''}${v}</text>`,
    );
  }

  const marks = rows.map(({ s, pr }, i) => {
    const cy = PAD_T + bandH * (i + 0.5);
    const cx = `var(--s-${s.key})`;
    const xLo = x(pr.mean - pr.ci);
    const xHi = x(pr.mean + pr.ci);
    const xm = x(pr.mean);
    return [
      // 水平误差棒（口径见下）+ 两端小帽
      `<line x1="${xLo}" y1="${cy}" x2="${xHi}" y2="${cy}" stroke="${cx}" stroke-width="2" stroke-linecap="round"/>`,
      `<line x1="${xLo}" y1="${cy - 6}" x2="${xLo}" y2="${cy + 6}" stroke="${cx}" stroke-width="2" stroke-linecap="round"/>`,
      `<line x1="${xHi}" y1="${cy - 6}" x2="${xHi}" y2="${cy + 6}" stroke="${cx}" stroke-width="2" stroke-linecap="round"/>`,
      // 中心点：r=5 + 2px 表面色环
      `<circle cx="${xm}" cy="${cy}" r="5" fill="${cx}" class="ring"/>`,
      // 行标签：档位名
      `<text x="${PAD_L - 12}" y="${cy - 2}" class="tick tick-end row-label">${esc(s.zh)}</text>`,
      // 显著性：标出 p 值而不只是 say-so —— 读者能看到判定依据
      `<text x="${PAD_L - 12}" y="${cy + 13}" class="tick tick-end ${pr.sig ? 'sig-yes' : 'sig-no'}">p=${
        pr.p < 0.001 ? '<0.001' : fmt(pr.p, 3)
      } ${pr.sig ? '显著' : '不显著'}</text>`,
      // 值标签在误差棒右端外侧
      `<text x="${xHi + 9}" y="${cy + 4}" class="tick tick-start val-strong">${pr.mean >= 0 ? '+' : ''}${fmt(pr.mean)}</text>`,
      `<title>${esc(s.zh)}：差值 ${fmt(pr.mean)}，区间 ±${fmt(pr.ci)}（校正后口径），t=${fmt(pr.t, 2)}，p=${fmt(pr.p, 4)}（Bonferroni α=${fmt(pr.alpha, 4)}，临界 t=${fmt(pr.tCrit, 2)}）；${pr.better} 优于 / ${pr.worse} 劣于基线（共 ${pr.n}）</title>`,
    ].join('');
  }).join('');

  return [
    `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img"`,
    ` aria-label="各处理档相对基线的配对差值及95%置信区间">`,
    // 标题从左边缘起排 —— 右对齐到 PAD_L 会因文本过长而左侧溢出
    `<text x="0" y="16" class="cell-title tick tick-start">相对「无记忆」的配对差值（总分，Bonferroni 校正区间）</text>`,
    xTicks.join(''),
    zeroLine,
    marks,
    // 误差棒口径必须写清楚：它用的是**校正后** α 的临界 t（≈2.57），
    // 不是常见的 1.96 —— 否则读者会拿它当 95% CI 去对照，得出相反结论。
    `<text x="${PAD_L}" y="${H - 8}" class="tick tick-start">误差棒为 Bonferroni 校正后区间（临界 t≈2.57，非 95%）；跨 0 ⇔ 与基线无统计差别</text>`,
    `</svg>`,
  ].join('');
}

// ============================================================================
// 表格视图（对比度不足时的 relief，也是无 hover 环境下的取值通道）
// ============================================================================

function tableByArm(records: ResultRecord[]): string {
  const head = ['档位', '条数', ...DIMENSIONS.map((d) => DIMENSION_ZH[d]), '总分均值'];
  const rows = SERIES.map((s) => {
    const rs = records.filter((r) => r.arm === s.key);
    const cells = DIMENSIONS.map((d) => fmt(stats(rs.map((r) => r.scores[d])).mean));
    return [
      `<tr><th scope="row"><span class="key" style="background:var(--s-${s.key})"></span>${esc(s.zh)}</th>`,
      `<td>${rs.length}</td>`,
      ...cells.map((c) => `<td>${c}</td>`),
      `<td class="strong">${fmt(stats(rs.map((r) => r.total)).mean)}</td></tr>`,
    ].join('');
  }).join('');

  return [
    `<table class="data-table"><caption>各档位四维均分与总分（全部轮次合并）</caption><thead><tr>`,
    head.map((h) => `<th scope="col">${esc(h)}</th>`).join(''),
    `</tr></thead><tbody>${rows}</tbody></table>`,
  ].join('');
}

function tableByRound(records: ResultRecord[], rounds: string[]): string {
  const head = ['档位', ...rounds, '全部均值'];
  const body = SERIES.map((s) => {
    const cells = rounds.map((rd) => {
      const rs = records.filter((r) => r.arm === s.key && r.round === rd);
      return rs.length ? fmt(stats(rs.map((r) => r.total)).mean) : '—';
    });
    const all = stats(records.filter((r) => r.arm === s.key).map((r) => r.total));
    return [
      `<tr><th scope="row"><span class="key" style="background:var(--s-${s.key})"></span>${esc(s.zh)}</th>`,
      ...cells.map((c) => `<td>${c}</td>`),
      `<td class="strong">${fmt(all.mean)}</td></tr>`,
    ].join('');
  }).join('');

  return [
    `<table class="data-table"><caption>跨轮总分均值（档位 × 轮次）</caption><thead><tr>`,
    head.map((h) => `<th scope="col">${esc(h)}</th>`).join(''),
    `</tr></thead><tbody>${body}</tbody></table>`,
  ].join('');
}

// ============================================================================
// 页面装配
// ============================================================================

function buildHtml(records: ResultRecord[], meta: Record<string, unknown>, srcName: string): string {
  const rounds = [...new Set(records.map((r) => r.round))];

  // 结论数字：经过 Bonferroni 校正后仍显著的档位数
  const treatArms = SERIES.filter((s) => s.key !== 'none');
  const sigCount = treatArms.filter(
    (s) => analyzePairedDiff(pairedDiffs(records, s.key, 'none'), treatArms.length).sig,
  ).length;

  const legend = SERIES.map((s) =>
    `<span class="legend-item"><span class="key" style="background:var(--s-${s.key})"></span>${esc(s.zh)}</span>`,
  ).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>古事项目 · LLM-as-Judge 评测图表</title>
<style>
  :root {
    color-scheme: light;
    --surface-1: #fcfcfb;
    --page: #f9f9f7;
    --text-primary: #0b0b0b;
    --text-secondary: #52514e;
    --muted: #898781;
    --grid: #e1e0d9;
    --axis: #c3c2b7;
    --border: rgba(11,11,11,0.10);
    --s-none: #2a78d6;
    --s-state: #eb6834;
    --s-graph: #1baf7a;
    --s-both: #eda100;
    --sig-yes: #006300;
  }
  /* 深色值在两个作用域各声明一次：媒体查询覆盖系统设置，
     data-theme 覆盖查看者的手动切换 —— 切换必须两个方向都能赢。 */
  @media (prefers-color-scheme: dark) {
    :root:where(:not([data-theme="light"])) {
      color-scheme: dark;
      --surface-1: #1a1a19;
      --page: #0d0d0d;
      --text-primary: #ffffff;
      --text-secondary: #c3c2b7;
      --muted: #898781;
      --grid: #2c2c2a;
      --axis: #383835;
      --border: rgba(255,255,255,0.10);
      --s-none: #3987e5;
      --s-state: #d95926;
      --s-graph: #199e70;
      --s-both: #c98500;
      --sig-yes: #0ca30c;
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --surface-1: #1a1a19;
    --page: #0d0d0d;
    --text-primary: #ffffff;
    --text-secondary: #c3c2b7;
    --muted: #898781;
    --grid: #2c2c2a;
    --axis: #383835;
    --border: rgba(255,255,255,0.10);
    --s-none: #3987e5;
    --s-state: #d95926;
    --s-graph: #199e70;
    --s-both: #c98500;
    --sig-yes: #0ca30c;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px 24px 64px;
    background: var(--page); color: var(--text-primary);
    font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    font-size: 14px; line-height: 1.6;
  }
  .wrap { max-width: 1000px; margin: 0 auto; }
  .topbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
  #theme-toggle {
    flex: none; font: inherit; font-size: 13px; padding: 6px 12px; cursor: pointer;
    background: var(--surface-1); color: var(--text-secondary);
    border: 1px solid var(--border); border-radius: 7px;
  }
  #theme-toggle:hover { color: var(--text-primary); }
  h1 { font-size: 22px; font-weight: 600; margin: 0 0 4px; }
  h2 { font-size: 15px; font-weight: 600; margin: 0 0 2px; }
  .sub { color: var(--text-secondary); margin: 0 0 24px; font-size: 13px; }
  .card {
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: 10px; padding: 20px 20px 16px; margin-bottom: 20px;
  }
  .card .desc { color: var(--text-secondary); font-size: 13px; margin: 0 0 14px; }
  .legend { display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 14px; }
  .legend-item { display: inline-flex; align-items: center; gap: 6px; color: var(--text-secondary); font-size: 13px; }
  .key { width: 10px; height: 10px; border-radius: 2px; display: inline-block; flex: none; }
  .chart { width: 100%; height: auto; display: block; overflow: visible; }
  .grid { stroke: var(--grid); stroke-width: 1; }
  .axis { stroke: var(--axis); stroke-width: 1; }
  .zero-line { stroke: var(--axis); stroke-width: 1; }
  .tick { fill: var(--muted); font-size: 11px; }
  .tick-end { text-anchor: end; }
  .tick-mid { text-anchor: middle; }
  .tick-start { text-anchor: start; }
  .cell-title { fill: var(--text-secondary); font-size: 12px; font-weight: 600; }
  .row-label { fill: var(--text-primary); font-size: 12px; font-weight: 600; }
  .sig-yes { fill: var(--sig-yes); font-size: 11px; }
  .sig-no { fill: var(--muted); font-size: 11px; }
  .val-strong { fill: var(--text-primary); font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .end-label { fill: var(--text-secondary); font-size: 11px; }
  .end-key { font-weight: 700; }
  .ring { stroke: var(--surface-1); stroke-width: 2; }
  .bar-hit { cursor: pointer; }
  .bar-hit:hover { opacity: .82; }
  .pt-hit { cursor: pointer; }
  .data-table { width: 100%; border-collapse: collapse; font-size: 13px; font-variant-numeric: tabular-nums; }
  .data-table caption { text-align: left; color: var(--text-secondary); font-size: 13px; padding-bottom: 8px; }
  .data-table th, .data-table td { padding: 7px 10px; border-bottom: 1px solid var(--border); text-align: right; }
  .data-table thead th { color: var(--muted); font-weight: 500; }
  .data-table th[scope="row"] { text-align: left; font-weight: 600; display: flex; align-items: center; gap: 7px; }
  .data-table .strong { font-weight: 600; }
  .callout {
    border-left: 3px solid var(--s-state); background: var(--surface-1);
    border: 1px solid var(--border); border-left-width: 3px;
    border-radius: 8px; padding: 14px 16px; margin-bottom: 20px;
  }
  .callout p { margin: 0 0 8px; }
  .callout p:last-child { margin-bottom: 0; }
  .callout strong { font-weight: 600; }
  #tip {
    position: fixed; pointer-events: none; opacity: 0; transition: opacity .1s;
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: 7px; padding: 8px 11px; font-size: 12px;
    box-shadow: 0 4px 16px rgba(0,0,0,.14); z-index: 50; max-width: 240px;
  }
  #tip .tv { font-weight: 600; font-size: 14px; color: var(--text-primary); }
  #tip .tn { color: var(--text-secondary); }
  .tv { font-variant-numeric: tabular-nums; }
</style>
</head>
<body>
<div class="wrap">

  <div class="topbar">
    <h1>古事项目 · LLM-as-Judge 四维一致性评测</h1>
    <button id="theme-toggle" type="button">切换深浅色</button>
  </div>
  <p class="sub">
    数据来源 <code>${esc(srcName)}</code> ·
    Judge 模型 <code>${esc(String(meta.model ?? '—'))}</code>（temperature=0）·
    每条采样 ${esc(String(meta.repeats ?? '—'))} 次取中位数 ·
    共 ${records.length} 条（${rounds.length} 轮 × ${SERIES.length} 档）
  </p>

  <div class="callout">
    <p><strong>怎么读这张报告。</strong>四维各 1–5 分，总分 = 四维之和（4–20）。</p>
    <p>图 3 是重点：三个处理档相对「无记忆」做配对比较，属<b>多重比较</b>，
       故按 <strong>Bonferroni 校正</strong>（3 次比较，α = 0.05/3 ≈ 0.0167，df=24 下临界 t ≈ 2.57）。
       校正后达到显著的档位数：<strong>${sigCount}</strong>。</p>
    <p>读图两个判据任一成立即「无差别」：误差棒跨过 0 线，或 p 值大于校正后的 α。</p>
    <p>图 2 是限制条件：如果同一档位在不同轮次之间的起伏，比档位之间的差距还大，
       那么<b>任何档位排序都不成立</b>——这正是消融实验先前踩过的坑。</p>
  </div>

  <div class="card">
    <h2>图 1 · 四个维度上的档位对比</h2>
    <p class="desc">每个小图是一个维度，横轴为四个档位。数值见表 1。</p>
    <div class="legend">${legend}</div>
    ${chartDimensionsByArm(records)}
  </div>

  <div class="card">
    <h2>图 2 · 跨轮趋势</h2>
    <p class="desc">同一档位在不同轮次的总分均值。线条大起大落 = 结论不稳。</p>
    <div class="legend">${legend}</div>
    ${chartTrendByRound(records, rounds)}
  </div>

  <div class="card">
    <h2>图 3 · 相对基线的配对差值（含 Bonferroni 校正区间）</h2>
    <p class="desc">配对口径：同一轮次、同一故事下，处理档总分 − 无记忆档总分。
       误差棒用<b>校正后</b>的临界 t（≈2.57）而非 1.96，与显著性判定保持同一口径。</p>
    ${chartPairedDiff(records)}
  </div>

  <div class="card">
    <h2>表 1 · 各档位四维均分</h2>
    <p class="desc">色块仅为识别辅助；数值本身即完整信息，不依赖颜色。</p>
    ${tableByArm(records)}
  </div>

  <div class="card">
    <h2>表 2 · 跨轮总分均值</h2>
    <p class="desc">对应图 2 的逐点数值。</p>
    ${tableByRound(records, rounds)}
  </div>

</div>
<div id="tip" role="status" aria-live="polite"></div>
<script>
(function () {
  var tip = document.getElementById('tip');
  var ZH = { character: '角色稳定', causality: '事件因果', timeline: '时间线连续', emotion: '情感连贯' };
  var ARM = { none: '无记忆', state: '仅状态表', graph: '仅图谱', both: '状态表+图谱' };

  function show(e, title, rows) {
    tip.textContent = '';
    var t = document.createElement('div');
    t.className = 'tn';
    t.textContent = title;
    tip.appendChild(t);
    rows.forEach(function (r) {
      var v = document.createElement('div');
      var s = document.createElement('span');
      s.className = 'tv';
      s.textContent = r.v;
      v.appendChild(s);
      var n = document.createElement('span');
      n.className = 'tn';
      n.textContent = '  ' + r.n;
      v.appendChild(n);
      tip.appendChild(v);
    });
    tip.style.opacity = '1';
  }
  function move(e) {
    var pad = 14;
    var x = e.clientX + pad, y = e.clientY + pad;
    var r = tip.getBoundingClientRect();
    if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - pad;
    if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - pad;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }
  function hide() { tip.style.opacity = '0'; }

  // 主题切换：显式盖上 data-theme，两个方向都能赢过系统的 prefers-color-scheme
  var root = document.documentElement;
  var btn = document.getElementById('theme-toggle');
  if (btn) {
    btn.addEventListener('click', function () {
      var dark = root.getAttribute('data-theme') === 'dark' ||
        (!root.hasAttribute('data-theme') &&
          window.matchMedia('(prefers-color-scheme: dark)').matches);
      root.setAttribute('data-theme', dark ? 'light' : 'dark');
    });
  }

  document.querySelectorAll('.bar-hit').forEach(function (el) {
    el.addEventListener('pointerenter', function (e) {
      show(e, ZH[el.dataset.dim] + ' · ' + ARM[el.dataset.arm], [{ v: el.dataset.val, n: '/ 5（n=' + el.dataset.n + '）' }]);
    });
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerleave', hide);
  });

  document.querySelectorAll('.pt-hit').forEach(function (el) {
    el.addEventListener('pointerenter', function (e) {
      show(e, el.dataset.round + ' · ' + ARM[el.dataset.arm],
        [{ v: el.dataset.val, n: '/ 20（四维总分）' }]);
    });
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerleave', hide);
  });
})();
</script>
</body>
</html>`;
}

// ============================================================================
// main
// ============================================================================

function main() {
  const argv = process.argv.slice(2);
  const get = (k: string, d: string) => {
    const hit = argv.find((a) => a.startsWith(`--${k}=`));
    return hit ? hit.split('=').slice(1).join('=') : d;
  };

  let input = get('input', '');
  if (!input) {
    const files = readdirSync(OUT_DIR)
      .filter((f) => f.startsWith('judge_results_') && f.endsWith('.json'))
      .sort();
    if (files.length === 0) {
      console.error(`没找到 judge_results_*.json，请先跑：npx tsx tests/llm_judge.ts --all`);
      process.exit(1);
    }
    input = join(OUT_DIR, files[files.length - 1]);
  }
  if (!existsSync(input)) {
    console.error(`输入不存在：${input}`);
    process.exit(1);
  }

  const { records, meta } = loadResults(input);
  if (records.length === 0) {
    console.error('结果文件里没有记录。');
    process.exit(1);
  }

  const html = buildHtml(records, meta, basename(input));
  const out = join(OUT_DIR, 'judge_charts.html');
  writeFileSync(out, html, 'utf-8');

  console.log('图表已生成');
  console.log('─'.repeat(60));
  console.log(`数据源   ${basename(input)}`);
  console.log(`记录数   ${records.length}`);
  console.log(`轮次     ${[...new Set(records.map((r) => r.round))].join(', ')}`);
  console.log(`输出     ${out}`);
  console.log('─'.repeat(60));
  console.log('用浏览器打开即可（自包含，无需联网）。');
}

main();
