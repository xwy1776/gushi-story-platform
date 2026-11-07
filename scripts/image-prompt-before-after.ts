/**
 * 生图 Prompt 优化前后对比实验（外观一致性 + 画面质量）
 *
 * —— 优化前（旧管线）：场景 LLM 按"外观关键词"自行转述角色外貌，无锚点机制
 * —— 优化后（当前生产管线，C3）：场景 LLM 禁止描写外貌 + 系统逐字追加冻结外观锚点
 *
 * 产出形态与「图文一致性实验」（scripts/image-consistency-experiment.ts）一致：
 *   experiments/prompt-before-after-<时间戳>/
 *     report.html    对照报告（前/后图并排 + 完整 prompt + 客观指标 + 评分表）
 *     prompts.md     两侧最终 prompt 全文对照
 *     result.json    原始数据（prompt / 图片路径 / seed / 客观指标）
 *     before/        优化前图片存档
 *     after/         优化后图片存档
 *
 * 控制变量：两组使用完全相同的段落文本、画风、seed、张数与实验约束；
 * 唯一变量 = 生图 prompt 管线。为保证对照公平，"优化前"复现也走与生产完全
 * 相同的生图代码路径（generateImagesForSegment + presetScenes，API 参数/重试/
 * 存档一致），仅替换"场景提取契约"并关闭锚点。
 *
 * 用法：
 *   npx tsx scripts/image-prompt-before-after.ts                    # 合成预置（默认「荆轲」）3 段
 *   npx tsx scripts/image-prompt-before-after.ts --preset hongmen   # 换故事（jingke | xuanwu | chibi | hongmen）
 *   npx tsx scripts/image-prompt-before-after.ts --dry-run          # 仅 prompt 对比，不调用生图 API
 *   npx tsx scripts/image-prompt-before-after.ts --out-dir <dir>    # 指定输出目录（默认 experiments/prompt-before-after-<时间戳>；
 *                                                                   #   配对实验编排脚本用它把多故事收进同一父目录）
 *   npx tsx scripts/image-prompt-before-after.ts --story-id <id> [--branch main] [--segments 3] [--max-images 2]
 *
 * 前置：`.env` / `.env.local` 配置 AI_API_KEY（文本，必须）与 AI_IMAGE_API_KEY（生图，--dry-run 可省略）。
 *       环境加载与 Next.js 对齐：.env.local 覆盖 .env。
 */
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { callAIText, extractJsonFromAI } from '../src/lib/ai-client';
import {
  STYLE_TEMPLATES,
  enforceNoTextInPrompt,
  extractSceneDescriptionsWithAI,
  generateImagesForSegment,
  type CharacterVisualHint,
  type SceneDescription,
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
// 避免"网页（Next.js 读 .env.local）正常、脚本（仅读 .env）401"的配置错位。
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
const PRESET = get('preset', 'jingke')!;
const BRANCH_ID = get('branch', 'main')!;
const SEGMENT_COUNT = Math.max(1, parseInt(get('segments', '3')!, 10) || 3);
const MAX_IMAGES = Math.max(1, parseInt(get('max-images', '1')!, 10) || 1);
const STYLE = (get('style', 'historical-realistic') as ConcreteImageStyle);
const OUT_DIR_ARG = get('out-dir');

// ── 数据源：合成场景预置共享库（scripts/preset-stories.ts，--preset 选择；默认 jingke）或真实故事 ──

async function loadFromStory(storyId: string, branchId: string, count: number) {
  const { getOrderedChain } = await import('../src/lib/chain-helpers');
  const { default: prisma } = await import('../src/lib/prisma');

  const story = await prisma.story.findUnique({
    where: { id: storyId },
    select: { genre: true, description: true },
  });

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
    throw new Error('该故事没有任何带 appearance 的角色，实验无法成立（优化前将等于优化后）');
  }
  return {
    segments,
    hints,
    label: `story:${storyId}`,
    genre: story?.genre || '历史',
    description: story?.description || `故事 ${storyId} 的实验场景`,
  };
}

// ── 优化后：当前生产管线组装（--dry-run 用；与 renderOne 拼装一致） ──

async function assembleAfterPrompt(
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

  const styled = `${composed}. ${STYLE_TEMPLATES[STYLE] ?? STYLE_TEMPLATES['historical-realistic']}`;
  return enforceNoTextInPrompt(styled);
}

// ── 优化前：旧管线行为复现 ───────────────────────────────────────────
// 场景提取契约逐字重建自 C3 改造前的 image-generator.ts：角色块含"外观："，
// 并明确要求 LLM"按外观关键词完整描写"——这正是外貌措辞跨段漂移的来源。

async function legacyExtractScenes(
  segment: ExperimentSegment,
  hints: CharacterVisualHint[],
): Promise<SceneDescription[]> {
  const charLines = hints
    .map(c => {
      const parts = [`- ${c.name}`];
      if (c.canonicalName) parts.push(`英文名：${c.canonicalName}`);
      if (c.appearance) parts.push(`外观：${c.appearance}`);
      if (c.role) parts.push(`定位：${c.role}`);
      return parts.join(' | ');
    })
    .join('\n');
  const characterBlock = `\n已登记角色（若出现在镜头中，必须按外观关键词完整描写 — 不要只写 "a boy / a man"，要写清楚发型、发色、服装、年龄段、标志性特征）：\n${charLines}\n`;

  const prompt = `你是一位电影分镜与 diffusion 模型 prompt 工程师。
分析下面这段中文故事（"当前段落"），提取 1-3 个最具视觉画面感的镜头，并为每个镜头同时给出：
- description：中文一句话镜头说明（10-40字，给人看）
- enPrompt：英文图片生成 prompt（给 diffusion 模型看），80-140 词，包含：**主体（含具体外观）、动作、环境、光线、镜头景别（wide shot / medium / close-up）、构图、氛围**。
- type：scene | character | object

【关键约束】
1. 镜头必须**只来自"当前段落"**。"近 N 段摘要"和"场景状态"仅用于理解世界观和画面连贯，不得把摘要中的历史事件当镜头。
2. enPrompt 必须是纯英文，不得出现任何中文字符、假名、朝鲜字；不得原样抄写段落里的中文句子。
3. 若镜头里出现"已登记角色"，必须按下方"外观"关键词还原（同人/动漫 IP 请用原作经典造型），不得笼统写 "a boy / a man / a woman"。
4. 若故事类型是动漫/同人/轻小说，在 enPrompt 里保留角色的英文名（如 "Obito Uchiha"），并附带外观描述。
5. 若给出了"已知场景状态"，enPrompt 里的环境/光线/时间描述必须与之一致（例如 scene state 说 dusk rainy，就不能写 sunny morning）。
6. 在 enPrompt 结尾追加固定短语：", no text, no captions, no subtitles, no speech bubbles, no calligraphy, no watermark"。
7. 严格输出 JSON 数组，不要 markdown、不要额外文字。

格式：
[{"description":"...","enPrompt":"...","type":"scene"}]

故事类型：${EXPERIMENT_GENRE}
故事简介：${EXPERIMENT_DESCRIPTION}
${characterBlock}
【当前段落】（镜头必须从这里取）：
${segment.content.slice(0, 1500)}`;

  try {
    const text = await callAI(prompt);
    const parsed = extractJsonFromAI<Array<{ description?: string; enPrompt?: string; type?: string }>>(text);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .slice(0, 3)
      .map(item => {
        const type = item.type === 'character' || item.type === 'object' ? item.type : 'scene';
        return {
          description: (item.description || '').trim(),
          type: type as SceneDescription['type'],
          prompt: (item.enPrompt || '').trim(),
        };
      })
      .filter(s => s.prompt.length > 0);
  } catch (e) {
    console.warn('[before-after] 旧管线复现提取失败:', e);
    return [];
  }
}

async function assembleBeforePrompt(
  segment: ExperimentSegment,
  hints: CharacterVisualHint[],
): Promise<string> {
  const scenes = await legacyExtractScenes(segment, hints);
  const scene = scenes[0];
  if (!scene) return '';
  const styled = `${scene.prompt}. ${STYLE_TEMPLATES[STYLE] ?? STYLE_TEMPLATES['historical-realistic']}`;
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

type ConditionKind = 'before' | 'after';

async function runCondition(
  kind: ConditionKind,
  conditionName: string,
  segments: ExperimentSegment[],
  hints: CharacterVisualHint[],
  seedHints: CharacterVisualHint[],
  storyKey: string,
  outDir: string,
): Promise<RunRecord[]> {
  const records: RunRecord[] = [];
  const imageDir = path.join(outDir, kind);
  fs.mkdirSync(imageDir, { recursive: true });

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];

    // 两组共用同一 seed（用 seedHints 派生；策略 pin 为 diverse 保持本实验历史语义，见 C5 文档）
    const seed = deriveImageSeed({ characters: seedHints, storyId: storyKey, segmentId: seg.id, strategy: 'diverse' });

    console.log(
      `\n[${conditionName}] (${i + 1}/${segments.length}) 「${seg.title}」 seed=${seed}`,
    );

    let images: ImageRecord[] = [];
    let prompt = '';
    let promptSource: RunRecord['promptSource'] = 'assembled';

    if (DRY_RUN) {
      prompt = kind === 'before' ? await assembleBeforePrompt(seg, hints) : await assembleAfterPrompt(seg, hints);
      console.log(`  [dry-run] 已构建 prompt（${prompt.length} 字符）`);
    } else {
      // 优化前：脚本按旧契约提取镜头（presetScenes 注入），随后走与生产完全相同的生图管线；
      // 不传 characters → 不附加锚点（旧管线无锚点机制）
      let presetScenes: SceneDescription[] | undefined;
      if (kind === 'before') {
        presetScenes = await legacyExtractScenes(seg, hints);
        if (presetScenes.length === 0) {
          console.log('  [warn] 旧管线复现提取失败，该段无镜头');
          records.push({ segment: seg, seed, prompt: '', promptSource: 'assembled', images: [] });
          continue;
        }
      }

      const generated = await generateImagesForSegment({
        segmentId: `${seg.id}__${kind}`,
        segmentContent: seg.content,
        style: STYLE,
        maxImages: MAX_IMAGES,
        genre: EXPERIMENT_GENRE,
        storyDescription: EXPERIMENT_DESCRIPTION,
        characters: kind === 'after' && hints.length > 0 ? hints : undefined,
        presetScenes,
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
        prompt = kind === 'before' ? await assembleBeforePrompt(seg, hints) : await assembleAfterPrompt(seg, hints);
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

// ── 客观指标 ─────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface AnchorAudit {
  anchorLines: string[];
  perSegment: { id: string; title: string; characterPresent: boolean; anchorPresent: boolean }[];
  presentCount: number;
  total: number;
  absentCount: number;
  failures: { id: string; title: string }[];
  allIdentical: boolean;
}

/** 解析锚点行（先过翻译缓存，保证与管线实际拼入的文本一致） */
async function resolveAnchorLines(hints: CharacterVisualHint[]): Promise<string[]> {
  const raw = buildCharacterAnchors(hints).map(a => a.line);
  return translateAnchorsToEnglish(raw, callAI);
}

/**
 * 优化后锚点核对（口径与图文一致性实验一致）：
 * 只在"含角色的镜头"上核对锚点行逐字命中；纯环境镜头单独计数、不计入。
 */
function buildAnchorAudit(anchorLines: string[], hints: CharacterVisualHint[], records: RunRecord[]): AnchorAudit {
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
  const failures = presentSegments.filter(s => !s.anchorPresent).map(s => ({ id: s.id, title: s.title }));

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

/** 某条件下锚点行逐字命中的段数（优化前期望为 0：旧管线无锚点机制） */
function countAnchorHits(anchorLines: string[], records: RunRecord[]): number {
  if (anchorLines.length === 0) return 0;
  return records.filter(r => (r.prompt || '').length > 0 && anchorLines.every(l => r.prompt.includes(l))).length;
}

// 外观要素跨段一致性（自动近似指标）：从 appearance 提取视觉关键词（长度≥5、去停用词），
// 统计各条件下每个关键词是否出现在每个段落的 prompt 中。
// 注意：这是近似指标——关键词可能偶然出现在非角色语境的画面文字里，结论以图为准。
const KEYWORD_STOPWORDS = new Set(['early', 'short', 'young', 'chinese', 'ancient']);

function deriveAppearanceKeywords(hints: CharacterVisualHint[]): string[] {
  const tokens: string[] = [];
  for (const h of hints) {
    const text = (h.appearance || '').toLowerCase();
    for (const t of text.split(/[^a-z0-9]+/)) {
      if (t.length >= 5 && !KEYWORD_STOPWORDS.has(t)) tokens.push(t);
    }
  }
  return Array.from(new Set(tokens)).sort();
}

interface KeywordConditionStats {
  perSegment: { title: string; present: boolean[] }[];
  avgHitRate: number;
  stableRate: number;
}

interface KeywordAudit {
  keywords: string[];
  before: KeywordConditionStats;
  after: KeywordConditionStats;
}

function buildKeywordAudit(
  keywords: string[],
  beforeRecords: RunRecord[],
  afterRecords: RunRecord[],
): KeywordAudit {
  const stats = (records: RunRecord[]): KeywordConditionStats => {
    const perSegment = records.map(r => ({
      title: r.segment.title,
      present: keywords.map(k => (r.prompt || '').toLowerCase().includes(k)),
    }));
    const rates = perSegment.map(s =>
      keywords.length > 0 ? s.present.filter(Boolean).length / keywords.length : 0,
    );
    const avgHitRate = rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : 0;
    const stableCount =
      keywords.length > 0 && perSegment.length > 0
        ? keywords.filter((_, ki) => perSegment.every(s => s.present[ki])).length
        : 0;
    return { perSegment, avgHitRate, stableRate: keywords.length > 0 ? stableCount / keywords.length : 0 };
  };
  return { keywords, before: stats(beforeRecords), after: stats(afterRecords) };
}

// ── 报告生成 ─────────────────────────────────────────────────────────

function writeReport(
  outDir: string,
  meta: { label: string; style: string; dryRun: boolean },
  hints: CharacterVisualHint[],
  beforeRecords: RunRecord[],
  afterRecords: RunRecord[],
  afterAudit: AnchorAudit,
  beforeAnchorHits: number,
  keywordAudit: KeywordAudit,
) {
  const pct = (v: number) => `${(v * 100).toFixed(0)}%`;

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

  const rows = beforeRecords
    .map((rb, i) => {
      const ra = afterRecords[i];
      return `
      <tr>
        <td class="seg"><b>${escapeHtml(ra.segment.title)}</b><br><small>${escapeHtml(ra.segment.content.slice(0, 60))}…</small><br><small>seed=${ra.seed}</small></td>
        <td class="before">${imgCell(rb)}${promptCell(rb)}</td>
        <td class="after">${imgCell(ra)}${promptCell(ra)}</td>
      </tr>`;
    })
    .join('\n');

  const afterAuditHtml =
    afterAudit.failures.length > 0
      ? `<p class="warn">⚠️ 优化后有 ${afterAudit.failures.length} 个含角色的段落缺失锚点（疑似绕过了 image-prompt-template 拼装）：${afterAudit.failures.map(f => escapeHtml(f.title)).join('、')}</p>`
      : afterAudit.allIdentical
        ? `<p class="ok">✅ 优化后锚点核对通过：含角色的 ${afterAudit.presentCount}/${afterAudit.total} 个段落中，锚点行全部逐字命中（跨段外观描述 100% 一致）</p>`
        : `<p class="warn">⚠️ 优化后没有任何段落检测到角色，无法核对（请检查实验约束是否生效）</p>`;

  const afterAuditExtra =
    afterAudit.failures.length === 0 && afterAudit.absentCount > 0
      ? `<p class="info">ℹ️ 优化后有 ${afterAudit.absentCount} 个段落为纯环境/物体镜头（画面中未包含角色，按设计不附加锚点，不计入核对）</p>`
      : '';

  const beforeAnchorHtml =
    beforeAnchorHits > 0
      ? `<p class="info">优化前：锚点行逐字命中 ${beforeAnchorHits}/${beforeRecords.length} 段（旧管线无锚点机制；出现命中属 LLM 巧合性复述）</p>`
      : `<p class="info">优化前：锚点行逐字命中 0/${beforeRecords.length} 段（旧管线无锚点机制，符合预期——外貌由 LLM 每段自由转述）</p>`;

  const beforeMatchKeys = hints
    .flatMap(h => [h.name, h.canonicalName])
    .filter((k): k is string => typeof k === 'string' && k.trim().length >= 2);

  const auditTable =
    '<tr><th>段落</th><th>前 · 镜头含角色</th><th>前 · 锚点逐字命中</th><th>后 · 镜头含角色</th><th>后 · 锚点逐字命中</th></tr>' +
    afterAudit.perSegment
      .map(s => {
        const beforeRecord = beforeRecords.find(r => r.segment.id === s.id);
        const beforePrompt = beforeRecord?.prompt || '';
        const beforePresent = beforeMatchKeys.some(k => beforePrompt.includes(k));
        const beforeAnchor = afterAudit.anchorLines.length > 0 && afterAudit.anchorLines.every(l => beforePrompt.includes(l));
        return `<tr><td>${escapeHtml(s.title)}</td><td>${beforePresent ? '是' : '<span class="muted">否（环境镜头）</span>'}</td><td>${beforePresent ? (beforeAnchor ? '⚠ 巧合命中' : '—') : '—'}</td><td>${s.characterPresent ? '是' : '<span class="muted">否（环境镜头）</span>'}</td><td>${s.characterPresent ? (s.anchorPresent ? '✅' : '❌') : '—'}</td></tr>`;
      })
      .join('\n');

  // 外观要素跨段一致性表
  const kw = keywordAudit;
  const kwHeader =
    '<tr><th>外观要素（自动提取）</th>' +
    kw.before.perSegment.map(s => `<th>前 · ${escapeHtml(s.title)}</th>`).join('') +
    kw.after.perSegment.map(s => `<th>后 · ${escapeHtml(s.title)}</th>`).join('') +
    '</tr>';
  const kwRows = kw.keywords
    .map((k, ki) => {
      const cell = (present: boolean) => (present ? '<td class="hit">✓</td>' : '<td class="miss">✗</td>');
      return (
        `<tr><td><code>${escapeHtml(k)}</code></td>` +
        kw.before.perSegment.map(s => cell(s.present[ki])).join('') +
        kw.after.perSegment.map(s => cell(s.present[ki])).join('') +
        '</tr>'
      );
    })
    .join('\n');
  const kwSummary = `<p><b>跨段稳定率</b>（在全部段落都出现的关键词占比）：优化前 <b>${pct(kw.before.stableRate)}</b>（各段平均命中率 ${pct(kw.before.avgHitRate)}） ｜ 优化后 <b>${pct(kw.after.stableRate)}</b>（各段平均命中率 ${pct(kw.after.avgHitRate)}）</p>`;

  // 评分表（外观一致性 + 画面质量），列数跟随段落数
  const segCount = afterRecords.length;
  const rubricHeader =
    '<tr><th>评估维度</th>' +
    Array.from({ length: segCount }, (_, i) => `<th>段落${i + 1} 前</th>`).join('') +
    Array.from({ length: segCount }, (_, i) => `<th>段落${i + 1} 后</th>`).join('') +
    '</tr>';
  const emptyCells = '<td></td>'.repeat(segCount * 2);
  const rubricRows = [
    ['外观一致性', '发型 / 发色是否与外观描述一致'],
    ['外观一致性', '服装是否与外观描述一致'],
    ['外观一致性', '标志配饰是否与外观描述一致（如皮护腕/匕首）'],
    ['外观一致性', '脸型 / 年龄段是否与外观描述一致'],
    ['外观一致性', '整体判定：跨段落是否同一人'],
    ['画面质量', '整体画面质量（构图 / 光影 / 无文字）'],
    ['画面质量', '主体辨识度（人物清晰、无畸变）'],
  ]
    .map(([group, label]) => `<tr><td><small>${group}</small><br>${label}</td>${emptyCells}</tr>`)
    .join('\n');

  const anchorLinesList = afterAudit.anchorLines
    .map(l => `<li><code>${escapeHtml(l)}</code></li>`)
    .join('');

  const html = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>生图 Prompt 优化前后对比 · ${escapeHtml(meta.label)}</title>
<style>
  :root { color-scheme: light; }
  body { font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; margin: 24px; color: #1f2937; background: #fafaf9; }
  h1 { font-size: 20px; } h2 { font-size: 16px; margin-top: 28px; }
  table { border-collapse: collapse; width: 100%; background: #fff; }
  th, td { border: 1px solid #e5e7eb; padding: 10px; vertical-align: top; }
  th { background: #f3f4f6; }
  td.seg { width: 200px; font-size: 13px; }
  img { max-width: 320px; display: block; margin-bottom: 6px; border-radius: 6px; }
  pre { white-space: pre-wrap; word-break: break-word; font-size: 12px; background: #f9fafb; padding: 8px; border-radius: 6px; max-height: 320px; overflow: auto; }
  .ok { color: #047857; } .warn { color: #b45309; } .info { color: #0369a1; } .muted { color: #9ca3af; }
  .noimg { color: #9ca3af; font-size: 13px; padding: 40px 0; text-align: center; }
  .ph { color: #b45309; font-size: 12px; margin-bottom: 6px; }
  td.hit { color: #047857; text-align: center; } td.miss { color: #dc2626; text-align: center; }
  small { color: #6b7280; }
</style>
</head>
<body>
<h1>生图 Prompt 优化前后对比：外观一致性 × 画面质量</h1>
<p>
  故事/数据源：<b>${escapeHtml(meta.label)}</b> ｜ 画风：<b>${escapeHtml(meta.style)}</b> ｜
  模式：<b>${meta.dryRun ? 'dry-run（仅 prompt）' : '完整生图'}</b> ｜
  角色：${hints.map(h => escapeHtml(h.name)).join('、') || '（无）'} ｜ 段落数：${afterRecords.length} ｜
  每段张数：${afterRecords[0]?.images.length || 0}
</p>
<p>
  控制变量：两组使用<b>完全相同的段落文本、画风、seed、张数与实验约束</b>；唯一区别是生图 prompt 管线——
  <b>优化前</b>：旧管线行为复现（场景 LLM 按"外观关键词"自行转述外貌，无锚点机制）；
  <b>优化后</b>：当前生产管线（场景 LLM 禁止描写外貌 + 系统逐字追加冻结外观锚点，C3）。
</p>

<h2>客观指标 ①：锚点核对</h2>
${afterAuditHtml}
${afterAuditExtra}
${beforeAnchorHtml}
<table>${auditTable}</table>
<details><summary>核对用的锚点行（${afterAudit.anchorLines.length} 条；优化后含角色段落必须逐字出现）</summary><ul>${anchorLinesList}</ul></details>

<h2>客观指标 ②：外观要素跨段一致性（自动近似指标）</h2>
${kwSummary}
<table>${kwHeader}${kwRows}</table>
<p><small>说明：关键词自动提取自 appearance（长度 ≥5、去停用词），用于机器化对比"外观文字是否稳定"；关键词可能偶然出现在非角色语境，最终以外观评分与图为准。</small></p>

<h2>图与 Prompt 对照</h2>
<table>
  <tr><th>段落</th><th>优化前（旧管线：LLM 自行转述外观）</th><th>优化后（C3：冻结外观锚点）</th></tr>
  ${rows}
</table>

<h2>人工评分表（查看图片后填写）</h2>
<p>逐项对照外观描述打分：一致 = ✓，不一致 / 缺失 = ✗；画面质量项按 1–5 分或优/中/差记录均可。</p>
<table>
  ${rubricHeader}
  ${rubricRows}
</table>
<p><small>
  期望结果：优化前出现外观漂移（发色/服装/配饰/年龄随机增减，三张图像三个人）；
  优化后跨段锚点文字逐字一致、人物可辨识为同一人，同时场景与构图保持多样。
  若生图提供商不支持 seed（如 DALL-E），构图控制会失效，但"外观文字约束"的对比结论依然成立。
</small></p>
</body>
</html>`;

  fs.writeFileSync(path.join(outDir, 'report.html'), html);

  const md = [
    `# 生图 Prompt 优化前后对比（${meta.label}）`,
    '',
    `- 优化前：旧管线行为复现（场景 LLM 按外观关键词自行转述外貌，无锚点）`,
    `- 优化后：当前生产管线（场景 LLM 禁止描写外貌 + 系统逐字追加冻结锚点，C3）`,
    `- 画风：${meta.style}；模式：${meta.dryRun ? 'dry-run' : '完整生图'}`,
    `- 客观指标：优化后锚点核对 ${afterAudit.failures.length === 0 && afterAudit.allIdentical ? `含角色 ${afterAudit.presentCount}/${afterAudit.total} 段逐字命中` : '见 report.html'}；优化前锚点命中 ${beforeAnchorHits}/${beforeRecords.length}（预期 0）`,
    `- 外观要素跨段稳定率：优化前 ${pct(kw.before.stableRate)} ｜ 优化后 ${pct(kw.after.stableRate)}`,
    '',
    ...beforeRecords.flatMap((rb, i) => {
      const ra = afterRecords[i];
      return [
        `## 段落：${rb.segment.title}（seed=${rb.seed}，两组共用）`,
        '',
        `### 优化前`,
        '```',
        rb.prompt,
        '```',
        '',
        `### 优化后`,
        '```',
        ra.prompt,
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
    console.error('缺少 AI_API_KEY（文本模型），无法运行实验。请在 .env / .env.local 中配置后重试。');
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
  // 两组注入同一条实验约束：保证每段都产出"含角色"的镜头，前/后对比才真正测外观漂移。
  // 两组同文约束，公平性不受影响；仅存在于实验脚本，生产管线不受影响。
  const charNames = hints.map(h => h.name).join('、');
  EXPERIMENT_DESCRIPTION =
    data.description +
    (charNames
      ? `（实验约束：每个镜头都必须包含角色「${charNames}」本人，不得输出纯环境或纯物体镜头）`
      : '');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = OUT_DIR_ARG
    ? path.resolve(process.cwd(), OUT_DIR_ARG)
    : path.join(process.cwd(), 'experiments', `prompt-before-after-${timestamp}`);
  fs.mkdirSync(outDir, { recursive: true });

  console.log('========================================');
  console.log('生图 Prompt 优化前后对比：旧管线 vs C3 冻结锚点');
  console.log(`数据源：${label}`);
  console.log(`段落：${segments.length} 段 × 两组 × ${MAX_IMAGES} 张${DRY_RUN ? '（dry-run，不调用生图 API）' : ''}`);
  console.log(`输出：${path.relative(process.cwd(), outDir)}/`);
  console.log('========================================');

  const beforeRecords = await runCondition('before', '优化前·旧管线', segments, hints, hints, storyKey, outDir);
  const afterRecords = await runCondition('after', '优化后·C3锚点', segments, hints, hints, storyKey, outDir);

  const anchorLines = await resolveAnchorLines(hints);
  const afterAudit = buildAnchorAudit(anchorLines, hints, afterRecords);
  const beforeAnchorHits = countAnchorHits(anchorLines, beforeRecords);
  const keywordAudit = buildKeywordAudit(deriveAppearanceKeywords(hints), beforeRecords, afterRecords);

  writeReport(outDir, { label, style: STYLE, dryRun: DRY_RUN }, hints, beforeRecords, afterRecords, afterAudit, beforeAnchorHits, keywordAudit);

  fs.writeFileSync(
    path.join(outDir, 'result.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        label,
        style: STYLE,
        dryRun: DRY_RUN,
        sharedSeedPerSegment: afterRecords.map(r => ({ segmentId: r.segment.id, seed: r.seed })),
        anchorAuditAfter: afterAudit,
        anchorHitsBefore: beforeAnchorHits,
        keywordAudit,
        before: beforeRecords,
        after: afterRecords,
      },
      null,
      2,
    ),
  );

  const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
  console.log('\n----------------------------------------');
  if (afterAudit.failures.length > 0) {
    console.log(
      `⚠️ 优化后有 ${afterAudit.failures.length} 个含角色段落缺失锚点：${afterAudit.failures.map(f => f.title).join('、')}（疑似绕过拼装）`,
    );
  } else if (afterAudit.allIdentical) {
    console.log(
      `✅ 优化后锚点核对：含角色的 ${afterAudit.presentCount}/${afterAudit.total} 段全部逐字一致` +
        (afterAudit.absentCount > 0 ? `；另有 ${afterAudit.absentCount} 段为环境镜头（无锚点属预期）` : ''),
    );
  } else {
    console.log('⚠️ 优化后未检测到含角色的段落，无法核对（检查提取模型是否遵守实验约束）');
  }
  console.log(`优化前锚点逐字命中：${beforeAnchorHits}/${beforeRecords.length} 段（旧管线无锚点机制，预期 0）`);
  console.log(
    `外观要素跨段稳定率：优化前 ${pct(keywordAudit.before.stableRate)}（平均命中 ${pct(keywordAudit.before.avgHitRate)}） ｜ 优化后 ${pct(keywordAudit.after.stableRate)}（平均命中 ${pct(keywordAudit.after.avgHitRate)}）`,
  );

  // 占位图体检：生图失败时管线按设计降级为占位 SVG，此类结果不能用于评判外观
  const allImages = [...beforeRecords, ...afterRecords].flatMap(r => r.images);
  const placeholders = allImages.filter(x => x.placeholder).length;
  if (!DRY_RUN && placeholders > 0) {
    console.log(
      `⚠️ 本次实验有 ${placeholders}/${allImages.length} 张为降级占位图（生图 API 认证/配置失败）——` +
        '图片结论无效，请先按 C3_consistency_experiment.md「故障排查」修复后重跑。',
    );
  }

  console.log(`报告：${path.join(outDir, 'report.html')}`);
  console.log('打开 report.html 查看前/后对照图，按评分表逐项打勾即可得到结论。');
}

main().catch(e => {
  console.error('实验执行失败:', e);
  process.exit(1);
});
