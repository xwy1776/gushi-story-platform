/**
 * 图文一致性实验（Blueprint C3 配套）：同一角色跨段落生图
 * ——「有 appearance 约束」（条件 A）vs「无约束」（条件 B）外观漂移对比
 *
 * 设计要点（控制变量）：
 *   - 两组的段落文本、画风、seed、maxImages 完全相同；
 *   - 唯一变量：条件 A 走生产管线（场景 LLM 只按名字指代 + 系统追加冻结外观锚点）；
 *     条件 B 不给生图管线任何角色外观信息（等价于"无约束"，漂移应显著更大）；
 *   - 两组共用同一个 seed（按 A 组角色集合派生后显式传入），隔离"外观约束"单变量。
 *
 * 产出（experiments/image-consistency-<时间戳>/）：
 *   report.html    对照报告（A/B 图并排 + 完整 prompt + 锚点核对结论 + 评分表）
 *   prompts.md     两侧最终 prompt 全文对照
 *   result.json    原始数据（prompt / 图片路径 / seed / 锚点一致性断言）
 *   condition-a/   A 组图片存档
 *   condition-b/   B 组图片存档
 *
 * 用法：
 *   npx tsx scripts/image-consistency-experiment.ts                # 合成「荆轲」3 段（默认，无需数据库）
 *   npx tsx scripts/image-consistency-experiment.ts --preset hongmen # 合成「鸿门宴」3 段（--preset jingke|xuanwu|chibi|hongmen）
 *   npx tsx scripts/image-consistency-experiment.ts --dry-run      # 只跑 prompt 对比，不调用生图 API（零图片成本）
 *   npx tsx scripts/image-consistency-experiment.ts --story-id <id> [--branch main] [--segments 3] [--max-images 2]
 *
 * 前置：`.env` / `.env.local` 配置 AI_API_KEY（文本，必须）与 AI_IMAGE_API_KEY（生图，--dry-run 可省略）。
 *       环境加载与 Next.js 对齐：.env.local 覆盖 .env。
 */
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { callAIText } from '../src/lib/ai-client';
import {
  STYLE_TEMPLATES,
  enforceNoTextInPrompt,
  extractSceneDescriptionsWithAI,
  generateImagesForSegment,
  type CharacterVisualHint,
} from '../src/lib/image-generator';
import type { ConcreteImageStyle } from '../src/lib/image-styles';
import {
  buildAnchorIndex,
  buildCharacterAnchors,
  composeConsistentScenePrompt,
  resolveSceneAnchorLines,
  translateAnchorsToEnglish,
} from '../src/lib/image-prompt-template';
import { deriveImageSeed } from '../src/lib/image-seed';
import { resolveCharacterFields } from '../src/lib/character-fields';
import { PRESETS, type ExperimentSegment } from './preset-stories';

// 环境变量加载与 Next.js 对齐：.env.local 覆盖 .env（先加载者生效）——
// 避免"网页（Next.js 读 .env.local）正常、脚本（原仅读 .env）401"的配置错位。
// 注意：所有依赖模块均在函数内读取 env（无模块级读取），此处加载时机安全。
dotenv.config({ path: ['.env.local', '.env'], quiet: true });

/** 文本 AI 调用（与生产路由同参） */
const callAI = (p: string) => callAIText(p, { maxTokens: 4000 });

/** 实验上下文（main 中按数据源赋值，供 prompt 组装使用） */
let EXPERIMENT_GENRE = '历史';
let EXPERIMENT_DESCRIPTION = '荆轲刺秦王实验场景';

// ── CLI 参数 ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const has = (f: string) => args.includes(`--${f}`);
const get = (f: string, d?: string): string | undefined => {
  const i = args.indexOf(`--${f}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};

const DRY_RUN = has('dry-run');
const STORY_ID = get('story-id');
const BRANCH_ID = get('branch', 'main')!;
const SEGMENT_COUNT = Math.max(1, parseInt(get('segments', '3')!, 10) || 3);
const MAX_IMAGES = Math.max(1, parseInt(get('max-images', '1')!, 10) || 1);
const STYLE = (get('style', 'historical-realistic') as ConcreteImageStyle);
const PRESET = get('preset', 'jingke')!;

// 数据源：合成场景预置共享库（scripts/preset-stories.ts，--preset 选择）或真实故事（--story-id）

async function loadFromStory(storyId: string, branchId: string, count: number) {
  const { getOrderedChain } = await import('../src/lib/chain-helpers');
  const { default: prisma } = await import('../src/lib/prisma');

  const story = await prisma.story.findUnique({ where: { id: storyId }, select: { genre: true, description: true } });

  const chain = await getOrderedChain(storyId, branchId);
  if (chain.length === 0) {
    throw new Error(`故事 ${storyId} 的分支 ${branchId} 没有段落`);
  }
  const segments: ExperimentSegment[] = chain.slice(-count).map(s => ({
    id: s.id,
    title: s.title || s.id,
    content: s.content,
  }));

  const chars = await prisma.character.findMany({ where: { storyId } });
  const hints: CharacterVisualHint[] = chars
    .map(c => {
      const { appearance, canonicalName } = resolveCharacterFields(c);
      return {
        name: c.name,
        canonicalName: canonicalName || undefined,
        appearance: appearance || undefined,
        role: c.role || undefined,
      };
    })
    .filter(h => h.appearance);

  if (hints.length === 0) {
    throw new Error('该故事没有任何带 appearance 的角色，实验无法成立（A 组将等于 B 组）');
  }
  return {
    segments,
    hints,
    label: `story:${storyId}`,
    genre: story?.genre || '历史',
    description: story?.description || `故事 ${storyId} 的实验场景`,
  };
}

// ── prompt 组装（--dry-run 用；与 image-generator renderOne 的拼装一致） ──

async function assembleFinalPrompt(
  segment: ExperimentSegment,
  hints: CharacterVisualHint[],
): Promise<string> {
  const scenes = await extractSceneDescriptionsWithAI(segment.content, callAI, {
    genre: EXPERIMENT_GENRE,
    storyDescription: EXPERIMENT_DESCRIPTION,
    characters: hints,
  });
  const scene = scenes[0];
  if (!scene) return '';

  const anchors = buildCharacterAnchors(hints);
  const lines = await translateAnchorsToEnglish(anchors.map(a => a.line), callAI);
  const index = buildAnchorIndex(anchors.map((a, i) => ({ ...a, line: lines[i] ?? a.line })));
  const anchorLines = resolveSceneAnchorLines(scene, index);
  const composed = composeConsistentScenePrompt({ scenePrompt: scene.prompt, anchorLines });

  // 与 applyStylePrompt 的显式风格分支一致；随后做 no-text 抑制
  const styled = `${composed}. ${STYLE_TEMPLATES[STYLE] ?? STYLE_TEMPLATES['historical-realistic']}`;
  return enforceNoTextInPrompt(styled);
}

// ── 实验主体 ─────────────────────────────────────────────────────────

interface ImageRecord {
  url: string;
  localFile?: string;
  /** 生图失败降级产生的占位图（SVG），不是真实图片 —— 不计入实验结论 */
  placeholder?: boolean;
}

interface RunRecord {
  segment: ExperimentSegment;
  seed: number;
  prompt: string;
  promptSource: 'pipeline' | 'assembled';
  images: ImageRecord[];
}

async function runCondition(
  conditionLabel: 'condition-a' | 'condition-b',
  conditionName: string,
  segments: ExperimentSegment[],
  hints: CharacterVisualHint[],
  seedHints: CharacterVisualHint[],
  storyKey: string,
  outDir: string,
): Promise<RunRecord[]> {
  const records: RunRecord[] = [];
  const imageDir = path.join(outDir, conditionLabel);
  fs.mkdirSync(imageDir, { recursive: true });

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];

    // 两组共用同一 seed（用 seedHints 派生；策略 pin 为 diverse 保持本实验历史语义，见 C5 文档）
    const seed = deriveImageSeed({ characters: seedHints, storyId: storyKey, segmentId: seg.id, strategy: 'diverse' });

    console.log(
      `\n[${conditionName}] (${i + 1}/${segments.length}) 「${seg.title}」 ` +
        `seed=${seed} ${hints.length === 0 ? '（不提供任何角色外观信息）' : `（角色 ${hints.length} 个）`}`,
    );

    let images: ImageRecord[] = [];
    let prompt = '';
    let promptSource: RunRecord['promptSource'] = 'assembled';

    if (DRY_RUN) {
      prompt = await assembleFinalPrompt(seg, hints);
      console.log(`  [dry-run] 已构建 prompt（${prompt.length} 字符）`);
    } else {
      const generated = await generateImagesForSegment({
        segmentId: `${seg.id}__${conditionLabel}`,
        segmentContent: seg.content,
        style: STYLE,
        maxImages: MAX_IMAGES,
        genre: EXPERIMENT_GENRE,
        storyDescription: EXPERIMENT_DESCRIPTION,
        characters: hints.length > 0 ? hints : undefined,
        seed,
        callAIFn: callAI,
      });

      for (let k = 0; k < generated.length; k++) {
        const img = generated[k];
        // 生图失败时管线按设计降级为占位 SVG（url 以 .svg 结尾）——如实标记，不冒充成功
        const isPlaceholder = typeof img.url === 'string' && img.url.endsWith('.svg');
        const src = path.join(process.cwd(), 'public', img.url.replace(/^\//, ''));
        const ext = path.extname(src) || '.png';
        const dest = path.join(imageDir, `${seg.id}_${k}${ext}`);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, dest);
        }
        images.push({
          url: img.url,
          localFile: fs.existsSync(dest) ? path.relative(outDir, dest) : undefined,
          placeholder: isPlaceholder,
        });
        if (!prompt && img.prompt) {
          prompt = img.prompt;
          promptSource = 'pipeline';
        }
      }
      const placeholderCount = images.filter(x => x.placeholder).length;
      if (!prompt) {
        // 生图被跳过（如未配置 AI_IMAGE_API_KEY）→ 退回组装 prompt，保证报告仍有内容
        prompt = await assembleFinalPrompt(seg, hints);
        console.log('  [warn] 生图未产出（检查 AI_IMAGE_API_KEY），已改用组装 prompt 记录');
      } else if (placeholderCount > 0) {
        console.log(
          `  ⚠ 产出 ${images.length} 张，其中 ${placeholderCount} 张为降级占位图` +
            `（生图 API 调用失败，检查 AI_IMAGE_API_KEY / AI_IMAGE_BASE_URL / AI_IMAGE_MODEL）`,
        );
      } else {
        console.log(`  ✓ 生成 ${images.length} 张（${images.map(x => x.localFile || x.url).join(', ')}）`);
      }
    }

    records.push({ segment: seg, seed, prompt, promptSource, images });
  }
  return records;
}

// ── 报告生成 ─────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 客观指标：A 组"含角色的镜头"中，锚点行是否逐字命中。
 *
 * 口径说明（实验实测校准）：
 * - 场景提取模型有时会产出不含角色的纯环境/纯物体镜头（如"大殿全景""匕首特写"），
 *   此时按 C3 设计**不应**附加锚点 —— 这类段落单独计数（环境镜头），不计入核对；
 * - 只有当镜头文本中出现了角色的中文名 / 规范英文名（角色确实在画面里），
 *   锚点行才必须逐字命中；缺失即判定为"绕过拼装"的真实失败。
 * - 判定用"镜头文本含名字"代替直接读 scene.characterNames：最终 prompt 才是
 *   实际发给模型的内容，且锚点行本身以角色名开头，口径自洽。
 */
interface AnchorAudit {
  anchorLines: string[];
  perSegment: { id: string; title: string; characterPresent: boolean; anchorPresent: boolean }[];
  presentCount: number;
  total: number;
  absentCount: number;
  failures: { id: string; title: string }[];
  allIdentical: boolean;
}

async function buildAnchorAudit(hints: CharacterVisualHint[], records: RunRecord[]): Promise<AnchorAudit> {
  const rawLines = buildCharacterAnchors(hints).map(a => a.line);
  const anchorLines = await translateAnchorsToEnglish(rawLines, callAI);

  const matchKeys = Array.from(
    new Set(
      hints
        .flatMap(h => [h.name, h.canonicalName])
        .filter((k): k is string => typeof k === 'string' && k.trim().length >= 2),
    ),
  );

  const perSegment = records.map(r => {
    const prompt = r.prompt || '';
    const characterPresent = matchKeys.some(k => prompt.includes(k));
    const anchorPresent = anchorLines.length > 0 && anchorLines.every(l => prompt.includes(l));
    return { id: r.segment.id, title: r.segment.title, characterPresent, anchorPresent };
  });

  const presentSegments = perSegment.filter(s => s.characterPresent);
  const failures = presentSegments
    .filter(s => !s.anchorPresent)
    .map(s => ({ id: s.id, title: s.title }));

  return {
    anchorLines,
    perSegment,
    presentCount: presentSegments.length,
    total: perSegment.length,
    absentCount: perSegment.length - presentSegments.length,
    failures,
    allIdentical: anchorLines.length > 0 && presentSegments.length > 0 && failures.length === 0,
  };
}

function writeReport(
  outDir: string,
  meta: { label: string; style: string; dryRun: boolean },
  hints: CharacterVisualHint[],
  recordsA: RunRecord[],
  recordsB: RunRecord[],
  audit: AnchorAudit,
) {

  const imgCell = (r: RunRecord) => {
    if (r.images.length === 0) {
      return `<div class="noimg">${meta.dryRun ? '（dry-run：未生图）' : '（无图片产出）'}</div>`;
    }
    return r.images
      .map(
        img =>
          (img.placeholder ? `<div class="ph">⚠ 占位图：本次生图调用失败（非真实图片，请勿用于评判外观）</div>` : '') +
          `<img src="${escapeHtml(img.localFile || '')}" alt="${escapeHtml(r.segment.title)}" loading="lazy">`,
      )
      .join('');
  };

  const promptCell = (r: RunRecord) =>
    `<details><summary>完整 prompt（${r.promptSource === 'pipeline' ? '生产管线实际发送' : '同构组装'}，${r.prompt.length} 字符）</summary><pre>${escapeHtml(r.prompt)}</pre></details>`;

  const rows = recordsA
    .map((ra, i) => {
      const rb = recordsB[i];
      return `
      <tr>
        <td class="seg"><b>${escapeHtml(ra.segment.title)}</b><br><small>${escapeHtml(ra.segment.content.slice(0, 60))}…</small><br><small>seed=${ra.seed}</small></td>
        <td class="a">${imgCell(ra)}${promptCell(ra)}</td>
        <td class="b">${imgCell(rb)}${promptCell(rb)}</td>
      </tr>`;
    })
    .join('\n');

  const auditHtml =
    audit.failures.length > 0
      ? `<p class="warn">⚠️ 有 ${audit.failures.length} 个含角色的段落缺失锚点（疑似绕过了 image-prompt-template 拼装）：${audit.failures.map(f => escapeHtml(f.title)).join('、')}</p>`
      : audit.allIdentical
        ? `<p class="ok">✅ 锚点核对通过：含角色的 ${audit.presentCount}/${audit.total} 个段落中，锚点行全部逐字命中（跨段外观描述 100% 一致）</p>`
        : `<p class="warn">⚠️ 没有任何段落检测到角色，无法核对（请检查实验约束是否生效 / 提取模型是否遵守 characters 字段）</p>`;

  const auditHtmlExtra =
    audit.failures.length === 0 && audit.absentCount > 0
      ? `<p class="info">ℹ️ 另有 ${audit.absentCount} 个段落为纯环境/物体镜头（画面中未包含角色，按设计不附加锚点，不计入核对）</p>`
      : '';

  const auditTable =
    '<tr><th>段落</th><th>镜头是否含角色</th><th>锚点是否逐字命中</th></tr>' +
    audit.perSegment
      .map(
        s =>
          `<tr><td>${escapeHtml(s.title)}</td><td>${s.characterPresent ? '是' : '<span class="muted">否（环境镜头）</span>'}</td><td>${s.characterPresent ? (s.anchorPresent ? '✅' : '❌') : '—'}</td></tr>`,
      )
      .join('\n');

  const anchorLinesList = audit.anchorLines
    .map(l => `<li><code>${escapeHtml(l)}</code></li>`)
    .join('');

  // 评分表列数跟随实际段落数
  const segCount = recordsA.length;
  const rubricHeader =
    '<tr><th>外观维度</th>' +
    Array.from({ length: segCount }, (_, i) => `<th>段落${i + 1} A</th>`).join('') +
    Array.from({ length: segCount }, (_, i) => `<th>段落${i + 1} B</th>`).join('') +
    '</tr>';
  const emptyCells = '<td></td>'.repeat(segCount * 2);
  const rubricRows = [
    '发型 / 发色（发髻）',
    '服装（深褐汉服袍）',
    '标志配饰（皮护腕 / 腰间匕首）',
    '脸型 / 年龄段（30 出头、清瘦）',
    '跨段是否同一人（整体）',
  ]
    .map(label => `<tr><td>${label}</td>${emptyCells}</tr>`)
    .join('\n');

  const html = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>图文一致性实验 · ${escapeHtml(meta.label)}</title>
<style>
  :root { color-scheme: light; }
  body { font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; margin: 24px; color: #1f2937; background: #fafaf9; }
  h1 { font-size: 20px; } h2 { font-size: 16px; margin-top: 28px; }
  table { border-collapse: collapse; width: 100%; background: #fff; }
  th, td { border: 1px solid #e5e7eb; padding: 10px; vertical-align: top; }
  th { background: #f3f4f6; }
  td.seg { width: 220px; font-size: 13px; }
  img { max-width: 320px; display: block; margin-bottom: 6px; border-radius: 6px; }
  pre { white-space: pre-wrap; word-break: break-word; font-size: 12px; background: #f9fafb; padding: 8px; border-radius: 6px; max-height: 320px; overflow: auto; }
  .ok { color: #047857; } .warn { color: #b45309; } .info { color: #0369a1; } .muted { color: #9ca3af; }
  .noimg { color: #9ca3af; font-size: 13px; padding: 40px 0; text-align: center; }
  .ph { color: #b45309; font-size: 12px; margin-bottom: 6px; }
  small { color: #6b7280; }
  .rubric td { font-size: 13px; }
</style>
</head>
<body>
<h1>图文一致性实验：有 appearance 约束（A） vs 无约束（B）</h1>
<p>
  故事/数据源：<b>${escapeHtml(meta.label)}</b> ｜ 画风：<b>${escapeHtml(meta.style)}</b> ｜
  模式：<b>${meta.dryRun ? 'dry-run（仅 prompt）' : '完整生图'}</b> ｜
  角色：${hints.map(h => escapeHtml(h.name)).join('、') || '（无）'} ｜ 段落数：${recordsA.length} ｜
  每段张数：${recordsA[0]?.images.length || 0}
</p>
<p>
  控制变量：两组使用<b>完全相同的段落文本、画风、seed 与张数</b>；唯一区别是
  <b>A 组</b>走生产管线（场景 LLM 禁止描写外貌 + 系统逐字追加冻结外观锚点），
  <b>B 组</b>不向生图管线提供任何角色外观信息（无约束）。
</p>

<h2>锚点核对（客观指标）</h2>
${auditHtml}
${auditHtmlExtra}
<table>${auditTable}</table>
<details><summary>核对用的锚点行（${audit.anchorLines.length} 条；含角色段落必须逐字出现）</summary><ul>${anchorLinesList}</ul></details>

<h2>图与 Prompt 对照</h2>
<table>
  <tr><th>段落</th><th>条件 A：有 appearance 约束（当前生产路径）</th><th>条件 B：无约束</th></tr>
  ${rows}
</table>

<h2>人工评分表（查看图片后填写）</h2>
<p>对每张图逐项打分：<b>与 A 组锚点描述一致 = ✓，不一致/缺失 = ✗</b>；重点看跨段落之间的一致性。</p>
<table class="rubric">
  ${rubricHeader}
  ${rubricRows}
</table>
<p><small>
  说明：B 组的 prompt 中不含任何外观约束，模型只能凭段落文字自由发挥，跨段外观漂移应显著大于 A 组。
  若所用生图提供商不支持 seed（如 DALL-E），构图控制会失效，但"外观文字约束"的对比结论依然成立。
</small></p>
</body>
</html>`;

  fs.writeFileSync(path.join(outDir, 'report.html'), html);

  const md = [
    `# 图文一致性实验 Prompt 对照（${meta.label}）`,
    '',
    `- 条件 A：有 appearance 约束（生产管线：冻结锚点）`,
    `- 条件 B：无约束（不提供任何角色外观信息）`,
    `- 画风：${meta.style}；模式：${meta.dryRun ? 'dry-run' : '完整生图'}`,
    '',
    ...recordsA.flatMap((ra, i) => {
      const rb = recordsB[i];
      return [
        `## 段落：${ra.segment.title}（seed=${ra.seed}，两组共用）`,
        '',
        `### A（有约束）`,
        '```',
        ra.prompt,
        '```',
        '',
        `### B（无约束）`,
        '```',
        rb.prompt,
        '```',
        '',
      ];
    }),
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'prompts.md'), md);
}

// ── main ────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.AI_API_KEY) {
    console.error('缺少 AI_API_KEY（文本模型），无法运行实验。请在 .env 中配置后重试。');
    process.exit(1);
  }

  // 完整模式开跑前先亮出生图配置（便于第一时间发现 key/地址配错）
  if (!DRY_RUN) {
    const imgBase = process.env.AI_IMAGE_BASE_URL || 'https://api.openai.com/v1';
    const imgModel = process.env.AI_IMAGE_MODEL || 'dall-e-3';
    const imgKey = process.env.AI_IMAGE_API_KEY || '';
    console.log(
      `生图配置：baseUrl=${imgBase} ｜ model=${imgModel} ｜ key=${
        imgKey ? `已配置（${imgKey.length} 字符，尾号 …${imgKey.slice(-4)}）` : '未配置'
      }`,
    );
  }

  if (!STORY_ID && !PRESETS[PRESET]) {
    console.error(`未知 preset：「${PRESET}」（可用：${Object.keys(PRESETS).join(' / ')}）`);
    process.exit(1);
  }
  const preset = PRESETS[PRESET] || PRESETS.jingke;

  const data = STORY_ID
    ? await (async () => {
        const r = await loadFromStory(STORY_ID, BRANCH_ID, SEGMENT_COUNT);
        return { ...r, storyKey: STORY_ID };
      })()
    : {
        segments: preset.segments.slice(0, SEGMENT_COUNT),
        hints: preset.characters,
        label: preset.label,
        storyKey: preset.storyKey,
        genre: preset.genre,
        description: preset.description,
      };
  const { segments, hints, label, storyKey } = data;
  EXPERIMENT_GENRE = data.genre;
  // 两组注入同一条实验约束：保证每段都产出"含角色"的镜头，A/B 对比才真正测外观漂移。
  // 仅实验脚本注入，生产管线不受影响；两组同文约束，公平性不受影响。
  const charNames = hints.map(h => h.name).join('、');
  EXPERIMENT_DESCRIPTION =
    data.description +
    (charNames
      ? `（实验约束：每个镜头都必须包含角色「${charNames}」本人，不得输出纯环境或纯物体镜头）`
      : '');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = path.join(process.cwd(), 'experiments', `image-consistency-${timestamp}`);
  fs.mkdirSync(outDir, { recursive: true });

  console.log('========================================');
  console.log('图文一致性实验：有 appearance 约束（A） vs 无约束（B）');
  console.log(`数据源：${label}`);
  console.log(`段落：${segments.length} 段 × 两组 × ${MAX_IMAGES} 张${DRY_RUN ? '（dry-run，不调用生图 API）' : ''}`);
  console.log(`输出：${path.relative(process.cwd(), outDir)}/`);
  console.log('========================================');

  const recordsA = await runCondition('condition-a', 'A·有约束', segments, hints, hints, storyKey, outDir);
  const recordsB = await runCondition('condition-b', 'B·无约束', segments, [], hints, storyKey, outDir);

  const audit = await buildAnchorAudit(hints, recordsA);
  writeReport(outDir, { label, style: STYLE, dryRun: DRY_RUN }, hints, recordsA, recordsB, audit);
  fs.writeFileSync(
    path.join(outDir, 'result.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        label,
        style: STYLE,
        dryRun: DRY_RUN,
        sharedSeedPerSegment: recordsA.map(r => ({ segmentId: r.segment.id, seed: r.seed })),
        anchorAudit: audit,
        conditionA: recordsA,
        conditionB: recordsB,
      },
      null,
      2,
    ),
  );

  console.log('\n----------------------------------------');
  if (audit.failures.length > 0) {
    console.log(
      `⚠️ A 组有 ${audit.failures.length} 个含角色段落缺失锚点：${audit.failures.map(f => f.title).join('、')}（疑似绕过拼装）`,
    );
  } else if (audit.allIdentical) {
    console.log(
      `✅ 客观指标：含角色的 ${audit.presentCount}/${audit.total} 段锚点全部逐字一致（外观文本约束 100% 命中）` +
        (audit.absentCount > 0 ? `；另有 ${audit.absentCount} 段为环境镜头（无锚点属预期）` : ''),
    );
  } else {
    console.log('⚠️ 未检测到含角色的段落，无法核对（检查提取模型是否遵守实验约束）');
  }
  console.log(`B 组未提供外观信息（漂移对照组）`);

  // 占位图体检：生图失败时管线按设计降级为占位 SVG，此类结果不能用于评判外观
  const allImages = [...recordsA, ...recordsB].flatMap(r => r.images);
  const placeholders = allImages.filter(x => x.placeholder).length;
  if (!DRY_RUN && placeholders > 0) {
    console.log(
      `⚠️ 本次实验有 ${placeholders}/${allImages.length} 张为降级占位图（生图 API 认证/配置失败）——` +
        '图片结论无效，请先按 C3_consistency_experiment.md「故障排查」修复后重跑。',
    );
  }
  console.log(`报告：${path.join(outDir, 'report.html')}`);
  console.log('打开 report.html 查看 A/B 对照图，按评分表逐项打勾即可得到实验结论。');
}

main().catch(e => {
  console.error('实验执行失败:', e);
  process.exit(1);
});
