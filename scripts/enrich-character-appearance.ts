/**
 * C5 存量角色外观升级：把已有 appearance 改写为"五官 + 须式 + 体态"结构化描述
 *
 * 背景：C5 之前的外观描述多为"年龄段 + 发型 + 服装"的概括式（约束力弱），生图时
 * 脸部/体态仍有较大随机空间。本脚本把存量角色外观用 LLM 改写为固定顺序的 2-3 句
 * 英文（①年龄性别 ②五官与须式 ③发型 ④身高体型体态 ⑤服装配饰），保留全部既有特征、
 * 仅补全细节；配合 identity seed 策略（C5）与冻结锚点（C3），跨图面容/须式/体态更稳定。
 *
 * 幂等：外观已满足新标准（结构标记 ≥3 个 **且已写明须式**；女性角色豁免）的角色自动跳过；
 * 可反复运行，只处理"仍为旧格式 / 缺须式"的角色（判定见 src/lib/appearance-structure.ts）。
 *
 * 注意：改写会更换锚点文本 —— 被升级角色的旧插图与新文本不再一致，需重新生成。
 *
 * 用法：
 *   npx tsx scripts/enrich-character-appearance.ts --dry-run        # 预览改写结果
 *   npx tsx scripts/enrich-character-appearance.ts                  # 写入全部未达标角色
 *   npx tsx scripts/enrich-character-appearance.ts --story-id <id>  # 仅处理某个故事
 */
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { callAIText, extractJsonFromAI } from '../src/lib/ai-client';
import { findSimilarCharacterPairs } from '../src/lib/appearance-distinctness';
import {
  hasFacialHairSpec,
  isAppearanceComplete,
  isLikelyFemale,
} from '../src/lib/appearance-structure';
import { resolveCharacterFields } from '../src/lib/character-fields';

// 环境变量加载与 Next.js 对齐：.env.local 覆盖 .env
dotenv.config({ path: ['.env.local', '.env'], quiet: true });

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run') || args.has('-n');
const storyIdArgIdx = process.argv.indexOf('--story-id');
const STORY_ID = storyIdArgIdx >= 0 ? process.argv[storyIdArgIdx + 1] : undefined;

const callAI = (p: string) => callAIText(p, { maxTokens: 2000 });

const MAX_LEN = 480;

/** 改写结果的最低质量线：低于该长度（或缺少连续字母）视为截断/占位符，一律拒绝 */
const MIN_REWRITE_LEN = 60;

// 结构化完成度 / 须式判定统一走 src/lib/appearance-structure.ts：
// isAppearanceComplete = 结构标记 ≥3 且须式已明确（女性角色豁免须式）

async function rewriteAppearance(name: string, original: string): Promise<string | null> {
  const prompt = `你是角色视觉设定师。把下面这段用于 diffusion 生图的角色外观描述，改写为 2-3 句英文，按固定顺序覆盖：
1) age & gender  2) face (face shape, eyebrows, eyes, nose, lips) + facial hair  3) hair (style & color)  4) height, body build & posture  5) clothing & signature items.
要求：保留原文中的全部既有特征（颜色/服装/标志物等一律不得丢失或改变）；对缺失的五官与体态细节做合理补充，使其具体、可复现；facial hair（须式）必须明确：原文已写则原样保留；原文未提及的男性角色写具体须型，无法确定时默认 "clean-shaven"（不要凭空添加胡子；经典形象明确有须的按经典形象写，如长髯/虬髯）；女性角色无需提及；总长不超过 ${MAX_LEN} 字符；仅输出 JSON 对象 {"appearance": "..."}，不要 markdown、不要解释。

角色名：${name}
原文：${original}`;
  try {
    const raw = await callAI(prompt);
    const parsed = extractJsonFromAI<{ appearance?: string }>(raw);
    const next = (parsed?.appearance || '').trim().slice(0, MAX_LEN);
    if (!next) return null;
    // C5 加固：拒绝截断/占位符式结果 —— 推理模型在 maxTokens 耗尽时会返回
    // 思考过程中的模板（如 {"appearance":"..."}），提取器可能回退匹配到它。
    // 质量守卫：长度过短或缺少连续字母 → 视为无效，跳过（保留原外观，绝不写入）。
    if (next.length < MIN_REWRITE_LEN || !/[A-Za-z]{4,}/.test(next)) {
      console.warn(
        `  改写 ${name} 结果异常（长度 ${next.length}，疑似截断/占位符："${next.slice(0, 40)}"），已跳过并保留原外观`,
      );
      return null;
    }
    return next;
  } catch (e) {
    console.warn(`  改写 ${name} 失败:`, (e as Error).message);
    return null;
  }
}

async function main() {
  if (!process.env.AI_API_KEY) {
    console.error('缺少 AI_API_KEY，无法运行。请在 .env / .env.local 中配置后重试。');
    process.exit(1);
  }
  // 动态导入 prisma（确保 dotenv 已加载）
  const { default: prisma } = await import('../src/lib/prisma');

  const chars = await prisma.character.findMany({
    where: STORY_ID ? { storyId: STORY_ID } : undefined,
    select: { id: true, name: true, appearance: true },
  });

  console.log('========================================');
  console.log('C5 角色外观结构化升级（五官 + 须式 + 体态）');
  console.log(
    `模式：${DRY_RUN ? 'dry-run 预览' : '正式写入'} ｜ 角色：${chars.length} 个${STORY_ID ? `（故事 ${STORY_ID}）` : ''}`,
  );
  console.log('========================================');

  let skipped = 0;
  let enriched = 0;
  let failed = 0;
  const previews: string[] = [];

  for (const c of chars) {
    const current = (c.appearance || '').trim();
    if (!current || isAppearanceComplete(current)) {
      skipped++;
      continue;
    }
    // 原文未提须式（且非女性豁免）→ 本次改写会明确该维度，提示重点审阅
    const facialHairMissing = !hasFacialHairSpec(current) && !isLikelyFemale(current);

    const next = await rewriteAppearance(c.name, current);
    if (!next) {
      failed++;
      continue;
    }
    // 质量守卫：需要补须式的角色，改写结果必须真的写明须式，否则拒收（保留原外观，可重跑）
    if (facialHairMissing && !hasFacialHairSpec(next)) {
      console.warn(`\n- ${c.name}：改写结果未按要求明确须式，已跳过（保留原外观，可重跑）`);
      failed++;
      continue;
    }

    console.log(
      `\n- ${c.name}（${current.length} → ${next.length} 字符）` +
        (facialHairMissing ? ' ｜ ⚠ 原文未提须式 → 本次已明确，请重点审阅' : ''),
    );
    console.log(`  旧: ${current.slice(0, 100)}${current.length > 100 ? '…' : ''}`);
    console.log(`  新: ${next.slice(0, 140)}${next.length > 140 ? '…' : ''}`);

    previews.push(
      `## ${c.name}（${current.length} → ${next.length} 字符）\n\n` +
        (facialHairMissing
          ? '**须式：原文未提及，本次改写已明确（默认 clean-shaven；如有经典形象依据请核对）**\n\n'
          : '') +
        `**旧**\n\n${current}\n\n**新**\n\n${next}\n`,
    );

    if (!DRY_RUN) {
      await prisma.character
        .update({ where: { id: c.id }, data: { appearance: next } })
        .catch((e: Error) => console.warn(`  写入 ${c.name} 失败:`, e.message));
    }
    enriched++;
  }

  // 完整新旧对照写入预览文件（终端只显示截断预览；dry-run 也能完整审阅后再决定是否写入）
  if (previews.length > 0) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const previewDir = path.join(process.cwd(), 'experiments');
    fs.mkdirSync(previewDir, { recursive: true });
    const previewPath = path.join(previewDir, `appearance-preview-${timestamp}.md`);
    fs.writeFileSync(
      previewPath,
      [
        '# 角色外观改写预览（C5）',
        '',
        `模式：${DRY_RUN ? 'dry-run（未写入）' : '正式写入'} ｜ 生成于：${timestamp}`,
        '',
        ...previews,
      ].join('\n'),
    );
    console.log(`\n完整新旧对照已写入：${path.relative(process.cwd(), previewPath)}`);
  }

  console.log('\n----------------------------------------');
  console.log(
    `完成：升级 ${enriched} 个${DRY_RUN ? '（dry-run，未写入）' : ''}，跳过 ${skipped} 个（已结构化且须式明确 / 无外观），失败 ${failed} 个`,
  );
  if (!DRY_RUN && enriched > 0) {
    console.log('提示：被升级角色的旧插图与新外观文本不再对应，建议对相关段落重新生成图片。');
  }

  // C5-② 撞脸体检（两层）：
  // ① 别名重复：同故事内 canonicalName 相同的多个角色（疑似同一人的别名，应合并而非区分）——
  //    比文本相似度可靠得多，能兜住"同一人两份档案、措辞被改写"的情况；
  // ② 文本相似：同故事内外观描述高度相近的异名角色对（真·撞脸风险）。
  const all = await prisma.character.findMany({
    where: STORY_ID ? { storyId: STORY_ID } : undefined,
    select: { id: true, name: true, storyId: true, appearance: true, canonicalName: true, traits: true },
  });

  const canonGroups = new Map<string, { name: string; canon: string }[]>();
  for (const c of all) {
    const { canonicalName } = resolveCharacterFields(c);
    const canon = canonicalName.trim();
    if (!canon) continue;
    const key = `${c.storyId}::${canon.toLowerCase()}`;
    const group = canonGroups.get(key);
    if (group) group.push({ name: c.name, canon });
    else canonGroups.set(key, [{ name: c.name, canon }]);
  }
  const aliasDupes = [...canonGroups.values()].filter(g => g.length > 1);

  if (aliasDupes.length > 0) {
    console.log('\n⚠️ 别名重复（同故事内规范名相同，疑似同一人的多个名字）——应做合并清理：');
    for (const g of aliasDupes) {
      console.log(`  - ${g.map(x => x.name).join(' / ')}（canonicalName: ${g[0].canon}）`);
    }
  }

  const similarPairs = findSimilarCharacterPairs(
    all.map(c => ({ id: c.id, name: c.name, storyId: c.storyId, appearance: c.appearance || '' })),
    0.5,
  );
  if (similarPairs.length > 0) {
    console.log('\n⚠️ 文本撞脸体检（外观相似度 ≥ 50%）：');
    for (const p of similarPairs.slice(0, 20)) {
      console.log(`  - ${p.a.name} ↔ ${p.b.name}（相似 ${(p.similarity * 100).toFixed(0)}%）`);
    }
    console.log('  提示：请区分这些角色的脸型/发型/体型/服装主色；若其实是同一人的别名，应做合并清理。');
  }
  if (aliasDupes.length === 0 && similarPairs.length === 0) {
    console.log('\n✅ 撞脸体检：未发现别名重复或外观高度相似的异名角色');
  }

  await prisma.$disconnect().catch(() => {});
}

main().catch(e => {
  console.error('执行失败:', e);
  process.exit(1);
});
