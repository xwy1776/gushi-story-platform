/**
 * C5 角色脸部/体态一致性对照实验：同一角色跨段落生图
 * —— identity 策略（锁身份 seed + 同段共享，stable）vs diverse 策略（段落盐 + seed+i）
 *
 * 背景：扩散模型的"脸"高度依赖初始 seed。C2 的 diverse 策略让 seed 随段落变化
 * （构图多样），代价是同一角色跨段换脸；C5 的 identity 策略在同一故事内锁定身份
 * seed，构图差异交给场景提示词。本实验用同一批段落、同一外观锚点，对比两种策略下
 * 跨段"同一人"的稳定度与构图多样性。
 *
 * 产出形态与既往实验一致（experiments/face-consistency-<时间戳>/）：
 *   report.html    对照报告（两组图并排 + 完整 prompt + seed 断言 + 评分表）
 *   prompts.md     两侧最终 prompt 全文对照
 *   result.json    原始数据（prompt / 图片路径 / seed / 断言结果）
 *   stable/、diverse/  两组图片存档
 *
 * 用法：
 *   npx tsx scripts/image-face-consistency-experiment.ts                # 合成「荆轲」3 段
 *   npx tsx scripts/image-face-consistency-experiment.ts --dry-run      # 仅 prompt + seed 断言
 *   npx tsx scripts/image-face-consistency-experiment.ts --story-id <id> [--segments 3] [--max-images 1]
 *
 * 前置：`.env` / `.env.local` 配置 AI_API_KEY 与有效的 AI_IMAGE_API_KEY（--dry-run 可省略生图）。
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
import { deriveImageSeed, type ImageSeedStrategy } from '../src/lib/image-seed';
import { resolveCharacterFields } from '../src/lib/character-fields';

// 环境变量加载与 Next.js 对齐：.env.local 覆盖 .env
dotenv.config({ path: ['.env.local', '.env'], quiet: true });

const callAI = (p: string) => callAIText(p, { maxTokens: 4000 });

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

interface ExperimentSegment {
  id: string;
  title: string;
  content: string;
}

// ── 数据源：合成场景（默认，无需数据库）或真实故事 ─────────────────────

const SYNTHETIC_CHARACTERS: CharacterVisualHint[] = [
  {
    name: '荆轲',
    canonicalName: 'Jing Ke',
    appearance:
      'male, early 30s, lean weathered face, short black hair in a topknot, dark brown hanfu robe, leather forearm bracers, dagger at waist',
    role: 'protagonist',
  },
];

const SYNTHETIC_SEGMENTS: ExperimentSegment[] = [
  {
    id: 'exp_seg_1',
    title: '驿馆夜雨',
    content:
      '深夜，驿馆的油灯将残。荆轲独自坐在案前，用粗布一遍遍擦拭那把匕首，雨水顺着屋檐滴下。他想起太子丹的嘱托，眼神沉了下来，最终将匕首重新收回鞘中。',
  },
  {
    id: 'exp_seg_2',
    title: '秦殿献图',
    content:
      '咸阳宫大殿，群臣列立。荆轲手捧督亢地图，低头缓步走向阶上的秦王嬴政，衣袖纹丝不乱，只有指尖微微发紧。殿外钟声沉沉，阳光从高窗斜照进来。',
  },
  {
    id: 'exp_seg_3',
    title: '图穷匕见',
    content:
      '地图在秦王面前完全展开，寒光乍现。荆轲左手一把抓住秦王的衣袖，右手举起匕首直刺。殿中大乱，铜柱旁人影翻飞，卫士们的甲胄声由远及近。',
  },
];

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
    throw new Error('该故事没有任何带 appearance 的角色，实验无法成立');
  }
  return {
    segments,
    hints,
    label: `story:${storyId}`,
    genre: story?.genre || '历史',
    description: story?.description || `故事 ${storyId} 的实验场景`,
  };
}

// ── dry-run 用 prompt 组装（与 renderOne 拼装一致） ────────────────────

async function assemblePrompt(segment: ExperimentSegment, hints: CharacterVisualHint[]): Promise<string> {
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

// ── 实验主体 ─────────────────────────────────────────────────────────

interface ImageRecord {
  url: string;
  localFile?: string;
  placeholder?: boolean;
}

interface RunRecord {
  segment: ExperimentSegment;
  seed: number;
  seedStride: number;
  prompt: string;
  promptSource: 'pipeline' | 'assembled';
  images: ImageRecord[];
}

type ConditionKind = 'stable' | 'diverse';

async function runCondition(
  kind: ConditionKind,
  conditionName: string,
  segments: ExperimentSegment[],
  hints: CharacterVisualHint[],
  storyKey: string,
  outDir: string,
): Promise<RunRecord[]> {
  const strategy: ImageSeedStrategy = kind === 'stable' ? 'identity' : 'diverse';
  const seedStride = kind === 'stable' ? 0 : 1;
  const records: RunRecord[] = [];
  const imageDir = path.join(outDir, kind);
  fs.mkdirSync(imageDir, { recursive: true });

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const seed = deriveImageSeed({
      characters: hints,
      storyId: storyKey,
      segmentId: seg.id,
      strategy,
    });

    console.log(
      `\n[${conditionName}] (${i + 1}/${segments.length}) 「${seg.title}」 seed=${seed}（策略=${strategy}，stride=${seedStride}）`,
    );

    let images: ImageRecord[] = [];
    let prompt = '';
    let promptSource: RunRecord['promptSource'] = 'assembled';

    if (DRY_RUN) {
      prompt = await assemblePrompt(seg, hints);
      console.log(`  [dry-run] 已构建 prompt（${prompt.length} 字符）`);
    } else {
      const generated = await generateImagesForSegment({
        segmentId: `${seg.id}__${kind}`,
        segmentContent: seg.content,
        style: STYLE,
        maxImages: MAX_IMAGES,
        genre: EXPERIMENT_GENRE,
        storyDescription: EXPERIMENT_DESCRIPTION,
        characters: hints,
        seed,
        seedStride,
        callAIFn: callAI,
      });

      for (let k = 0; k < generated.length; k++) {
        const img = generated[k];
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
        prompt = await assemblePrompt(seg, hints);
        console.log('  [warn] 生图未产出（检查 AI_IMAGE_API_KEY），已改用组装 prompt 记录');
      } else if (placeholderCount > 0) {
        console.log(
          `  ⚠ 产出 ${images.length} 张，其中 ${placeholderCount} 张为降级占位图（生图 API 调用失败）`,
        );
      } else {
        console.log(`  ✓ 生成 ${images.length} 张（${images.map(x => x.localFile || x.url).join(', ')}）`);
      }
    }

    records.push({ segment: seg, seed, seedStride, prompt, promptSource, images });
  }
  return records;
}

// ── 报告生成 ─────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function writeReport(
  outDir: string,
  meta: { label: string; style: string; dryRun: boolean },
  hints: CharacterVisualHint[],
  stableRecords: RunRecord[],
  diverseRecords: RunRecord[],
) {
  const imgCell = (r: RunRecord) => {
    if (r.images.length === 0) {
      return `<div class="noimg">${meta.dryRun ? '（dry-run：未生图）' : '（无图片产出）'}</div>`;
    }
    return r.images
      .map(
        img =>
          (img.placeholder ? `<div class="ph">⚠ 占位图：本次生图调用失败（非真实图片）</div>` : '') +
          `<img src="${escapeHtml(img.localFile || '')}" alt="${escapeHtml(r.segment.title)}" loading="lazy">`,
      )
      .join('');
  };

  const promptCell = (r: RunRecord) =>
    `<details><summary>完整 prompt（${r.promptSource === 'pipeline' ? '生产管线实际发送' : '同构组装'}，${r.prompt.length} 字符）</summary><pre>${escapeHtml(r.prompt)}</pre></details>`;

  const rows = stableRecords
    .map((rs, i) => {
      const rd = diverseRecords[i];
      return `
      <tr>
        <td class="seg"><b>${escapeHtml(rs.segment.title)}</b><br><small>${escapeHtml(rs.segment.content.slice(0, 60))}…</small></td>
        <td class="stable">${imgCell(rs)}${promptCell(rs)}</td>
        <td class="diverse">${imgCell(rd)}${promptCell(rd)}</td>
      </tr>`;
    })
    .join('\n');

  const stableSeeds = stableRecords.map(r => r.seed);
  const diverseSeeds = diverseRecords.map(r => r.seed);
  const stableUnique = new Set(stableSeeds).size;
  const diverseUnique = new Set(diverseSeeds).size;
  const stableOk = stableUnique === 1 && stableSeeds.length > 1;
  const diverseOk = diverseUnique === diverseSeeds.length && diverseSeeds.length > 1;

  const seedTable =
    '<tr><th>段落</th><th>stable（identity 策略）</th><th>diverse（段落盐）</th></tr>' +
    stableRecords
      .map(
        (rs, i) =>
          `<tr><td>${escapeHtml(rs.segment.title)}</td><td><code>${rs.seed}</code></td><td><code>${diverseRecords[i].seed}</code></td></tr>`,
      )
      .join('\n');

  const seedAssertHtml =
    (stableOk
      ? `<p class="ok">✅ stable：${stableSeeds.length} 个段落共享同一身份 seed（${stableSeeds[0]}）——同段多图 stride=0 共 seed，脸/体态的随机分量被锁定</p>`
      : `<p class="warn">⚠️ stable 组 seed 未全部一致（出现 ${stableUnique} 个不同值），请检查策略接入</p>`) +
    (diverseOk
      ? `<p class="info">diverse：${diverseSeeds.length} 个段落 seed 全部不同（构图多样性优先，代价是脸随段变化）</p>`
      : `<p class="info">diverse 组 seed 出现重复（${diverseUnique}/${diverseSeeds.length} 个唯一值）</p>`);

  const segCount = stableRecords.length;
  const rubricHeader =
    '<tr><th>评估维度</th>' +
    Array.from({ length: segCount }, (_, i) => `<th>段落${i + 1} stable</th>`).join('') +
    Array.from({ length: segCount }, (_, i) => `<th>段落${i + 1} diverse</th>`).join('') +
    '</tr>';
  const emptyCells = '<td></td>'.repeat(segCount * 2);
  const rubricRows = [
    ['脸部一致性', '脸型 / 五官与外观描述一致'],
    ['脸部一致性', '跨段是否同一张脸（整体辨识）'],
    ['体态一致性', '身高 / 体型 / 体态是否一致'],
    ['外观一致性', '发型与服装是否一致'],
    ['构图多样性', '与同组其他段落的画面是否明显重复（越低越好）'],
  ]
    .map(([group, label]) => `<tr><td><small>${group}</small><br>${label}</td>${emptyCells}</tr>`)
    .join('\n');

  const html = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>角色脸/体态一致性实验 · ${escapeHtml(meta.label)}</title>
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
  small { color: #6b7280; }
</style>
</head>
<body>
<h1>角色脸 / 体态一致性实验：identity 锁身份 seed（stable） vs 段落盐（diverse）</h1>
<p>
  故事/数据源：<b>${escapeHtml(meta.label)}</b> ｜ 画风：<b>${escapeHtml(meta.style)}</b> ｜
  模式：<b>${meta.dryRun ? 'dry-run（仅 prompt + seed）' : '完整生图'}</b> ｜
  角色：${hints.map(h => escapeHtml(h.name)).join('、')} ｜ 段落数：${stableRecords.length} ｜
  每段张数：${stableRecords[0]?.images.length || 0}
</p>
<p>
  控制变量：两组使用<b>完全相同的段落文本、外观锚点（C3）、画风与张数</b>；唯一区别是 seed 策略——
  <b>stable</b>：同一故事共享身份 seed（stride=0，同段多图也共 seed）；
  <b>diverse</b>：C2 原行为（角色集合 + 段落盐，跨段 seed 必不同，seed+i 逐张偏移）。
</p>

<h2>客观指标：seed 派生断言</h2>
${seedAssertHtml}
<table>${seedTable}</table>

<h2>图与 Prompt 对照</h2>
<table>
  <tr><th>段落</th><th>stable（identity：锁脸/体态）</th><th>diverse（段落盐：构图多样）</th></tr>
  ${rows}
</table>

<h2>人工评分表（查看图片后填写）</h2>
<p>对每张图逐项打分：一致 = ✓，不一致 / 缺失 = ✗；最后一行为主观判断。</p>
<table>
  ${rubricHeader}
  ${rubricRows}
</table>
<p><small>
  预期结果：stable 组跨段（及同段多图）应为"同一张脸 + 同一副身体"，构图仍因镜头提示词不同而有差异；
  diverse 组构图差异更大，但脸/体态更易漂移。若两组差异不明显（或 stable 仍有明显漂移）：
  先确认所用生图提供商是否支持 seed（DALL-E 会忽略），再看外观文本是否已结构化（可先跑
  <code>npm run enrich:appearance</code> 升级存量外观）。
</small></p>
</body>
</html>`;

  fs.writeFileSync(path.join(outDir, 'report.html'), html);

  const md = [
    `# 角色脸/体态一致性实验（${meta.label}）`,
    '',
    `- stable：identity 策略（共享身份 seed + stride 0）`,
    `- diverse：段落盐（角色集合|段落，seed+i）`,
    `- 画风：${meta.style}；模式：${meta.dryRun ? 'dry-run' : '完整生图'}`,
    `- seed 断言：stable ${stableOk ? '✅ 全部一致' : '⚠️ 不一致'}；diverse ${diverseOk ? '✅ 全部不同' : '（出现重复）'}`,
    '',
    ...stableRecords.flatMap((rs, i) => {
      const rd = diverseRecords[i];
      return [
        `## 段落：${rs.segment.title}`,
        '',
        `seed：stable=${rs.seed} ｜ diverse=${rd.seed}`,
        '',
        `### stable（identity）`,
        '```',
        rs.prompt,
        '```',
        '',
        `### diverse（段落盐）`,
        '```',
        rd.prompt,
        '```',
        '',
      ];
    }),
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'prompts.md'), md);

  return { stableOk, diverseOk };
}

// ── main ────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.AI_API_KEY) {
    console.error('缺少 AI_API_KEY（文本模型），无法运行实验。请在 .env / .env.local 中配置后重试。');
    process.exit(1);
  }

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

  const data = STORY_ID
    ? await (async () => {
        const r = await loadFromStory(STORY_ID, BRANCH_ID, SEGMENT_COUNT);
        return { ...r, storyKey: STORY_ID };
      })()
    : {
        segments: SYNTHETIC_SEGMENTS.slice(0, SEGMENT_COUNT),
        hints: SYNTHETIC_CHARACTERS,
        label: '合成场景（荆轲刺秦王）',
        storyKey: 'experiment-synthetic',
        genre: '历史',
        description: '荆轲刺秦王实验场景',
      };
  const { segments, hints, label, storyKey } = data;
  EXPERIMENT_GENRE = data.genre;
  const charNames = hints.map(h => h.name).join('、');
  EXPERIMENT_DESCRIPTION =
    data.description +
    (charNames
      ? `（实验约束：每个镜头都必须包含角色「${charNames}」本人，不得输出纯环境或纯物体镜头）`
      : '');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = path.join(process.cwd(), 'experiments', `face-consistency-${timestamp}`);
  fs.mkdirSync(outDir, { recursive: true });

  console.log('========================================');
  console.log('角色脸/体态一致性实验：identity（stable） vs 段落盐（diverse）');
  console.log(`数据源：${label}`);
  console.log(`段落：${segments.length} 段 × 两组 × ${MAX_IMAGES} 张${DRY_RUN ? '（dry-run，不调用生图 API）' : ''}`);
  console.log(`输出：${path.relative(process.cwd(), outDir)}/`);
  console.log('========================================');

  const stableRecords = await runCondition('stable', 'stable·锁身份', segments, hints, storyKey, outDir);
  const diverseRecords = await runCondition('diverse', 'diverse·段落盐', segments, hints, storyKey, outDir);

  const { stableOk, diverseOk } = writeReport(outDir, { label, style: STYLE, dryRun: DRY_RUN }, hints, stableRecords, diverseRecords);

  fs.writeFileSync(
    path.join(outDir, 'result.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        label,
        style: STYLE,
        dryRun: DRY_RUN,
        seedAssert: { stableOk, diverseOk },
        stable: stableRecords,
        diverse: diverseRecords,
      },
      null,
      2,
    ),
  );

  console.log('\n----------------------------------------');
  console.log(
    stableOk
      ? `✅ seed 断言：stable 组 ${stableRecords.length} 段共享同一身份 seed（${stableRecords[0]?.seed}），同段多图共 seed`
      : '⚠️ stable 组 seed 未全部一致，请检查策略接入',
  );
  console.log(
    diverseOk
      ? `diverse 组 ${diverseRecords.length} 段 seed 全部不同（构图多样性优先）`
      : 'diverse 组 seed 出现重复（请检查派生输入）',
  );

  const allImages = [...stableRecords, ...diverseRecords].flatMap(r => r.images);
  const placeholders = allImages.filter(x => x.placeholder).length;
  if (!DRY_RUN && placeholders > 0) {
    console.log(
      `⚠️ 本次实验有 ${placeholders}/${allImages.length} 张为降级占位图（生图 API 认证/配置失败）——图片结论无效，先修复后重跑`,
    );
  }

  console.log(`报告：${path.join(outDir, 'report.html')}`);
  console.log('打开 report.html 对比两组的脸/体态一致性与构图多样性，按评分表逐项打勾。');
}

main().catch(e => {
  console.error('实验执行失败:', e);
  process.exit(1);
});
