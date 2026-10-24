import { NextRequest, NextResponse } from 'next/server';
import {
  analyzeStoryStyle,
  analyzeSegmentStyle,
  generateImagesForSegment,
  IMAGE_STYLES,
  type ImageStyle,
  type CharacterVisualHint,
} from '@/lib/image-generator';
import prisma from '@/lib/prisma';
import { callAIText } from '@/lib/ai-client';
import { characterManager } from '@/lib/character-engine';
import { resolveCharacterFields } from '@/lib/character-fields';
import { deriveImageSeed, type ImageSeedStrategy } from '@/lib/image-seed';
import { directorManager } from '@/lib/director-manager';
import { contextSummarizer } from '@/lib/context-summarizer';
import { getOrderedChain, locateSegmentContext } from '@/lib/chain-helpers';
import { getCachedReferenceImages, searchReferenceImages, type ReferenceImageHint } from '@/lib/reference-image-search';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { segmentId, segmentContent, style = 'auto', storyContent, maxImages = 3, reroll = false, seedStrategy: seedStrategyRaw } = body;

    if (!segmentId || !segmentContent) {
      return NextResponse.json(
        { error: '缺少必要的参数: segmentId 和 segmentContent' },
        { status: 400 }
      );
    }

    // 验证 style 是否合法
    const requestedStyle: ImageStyle = IMAGE_STYLES.find(s => s.value === style)
      ? style as ImageStyle
      : 'auto';

    // 拉取段落所属 story 的 genre / description / storyId，用于 auto 风格选择 + 角色还原
    let genre: string | undefined;
    let storyDescription: string | undefined;
    let storyIdForChars: string | undefined;
    let storyTitleForSeed: string | undefined;
    let storyEraForSeed: string | undefined;
    let branchIdForChain = 'main';
    let existingImageCount = 0;
    try {
      const seg = await prisma.storySegment.findUnique({
        where: { id: segmentId },
        select: {
          storyId: true,
          branchId: true,
          imageUrls: true,
          story: { select: { genre: true, description: true, era: true, title: true } },
        },
      });
      if (seg?.story) {
        genre = [seg.story.genre, seg.story.era].filter(Boolean).join(' ');
        storyDescription = seg.story.description ?? undefined;
        storyIdForChars = seg.storyId;
        storyTitleForSeed = seg.story.title;
        storyEraForSeed = seg.story.era ?? undefined;
        branchIdForChain = seg.branchId || 'main';
        existingImageCount = Array.isArray(seg.imageUrls) ? seg.imageUrls.length : 0;
      }
    } catch (e) {
      console.warn('[images/generate] 拉取 story 信息失败:', e);
    }

    // 方案 E：首次生成时，为已知 IP 预播 fandom 角色名册（有 web_search 的 LLM）
    if (storyIdForChars) {
      try {
        await characterManager.seedFandomRoster(storyIdForChars, {
          title: storyTitleForSeed,
          genre,
          storyDescription,
          era: storyEraForSeed,
          callAIWithWebSearchFn: (p: string) => callAIText(p, { maxTokens: 1200, webSearch: true }),
        });
      } catch (e) {
        console.warn('[images/generate] seedFandomRoster 失败:', e);
      }
    }

    // D1: 同人 IP 参考图搜索（在 fandom seeding 完成后执行）
    let referenceImageHints: ReferenceImageHint[] = [];
    if (storyIdForChars) {
      try {
        const state = await directorManager.getState(storyIdForChars);
        const wv = (state?.worldVariables as Record<string, any>) || {};
        if (wv.fandom_seeded && wv.fandom_name) {
          const cached = await getCachedReferenceImages(wv.fandom_name);
          if (cached.length > 0) {
            referenceImageHints = cached;
          } else {
            // 异步搜索，不阻塞当前图片生成
            const characterNames = (await characterManager.list(storyIdForChars))
              .map(c => resolveCharacterFields(c).canonicalName || c.name)
              .slice(0, 8);

            searchReferenceImages(
              wv.fandom_name,
              wv.fandom_name_en || '',
              characterNames,
            ).catch(e => console.warn('[images/generate] 参考图搜索失败:', e));
          }
        }
      } catch (e) {
        console.warn('[images/generate] 参考图搜索集成失败:', e);
      }
    }

    // 发现并自动注册段落中出现的所有角色（含新角色）
    // 外观存入 Character.appearance 结构化字段，下次命中缓存；新角色首次出现时 AI 实时登记
    const characters: CharacterVisualHint[] = [];
    if (storyIdForChars) {
      try {
        // C4: 先等待"续写后处理"的角色发现追平本段（流式续写的发现是异步的）——
        // 否则两侧并发注册同段新角色，会产生重复角色/外观不一致（表现为"图里的人和文里对不上"）。
        // 历史段落/已处理：零等待；超时（后处理未完成/失败）：本端照常自行发现并补写标记。
        const discoveryReady = await characterManager.waitForCharacterDiscovery(
          storyIdForChars,
          branchIdForChain,
          segmentId,
          { timeoutMs: 15000, intervalMs: 1000 },
        );

        const mentioned = await characterManager.discoverAndRegisterCharacters(
          storyIdForChars,
          segmentContent,
          (p: string) => callAIText(p, { maxTokens: 1200 }),
          {
            genre,
            storyDescription,
            // 联网查询分支：GLM 内置 web_search，用来补齐未知角色外观
            callAIWithWebSearchFn: (p: string) => callAIText(p, { maxTokens: 1500, webSearch: true }),
          },
        );
        if (!discoveryReady) {
          // 等待超时 → 本端已完成发现，补写标记，避免后续请求对同一段重复等待
          await characterManager.markCharacterDiscoveryDone(storyIdForChars, segmentId);
        }

        for (const c of mentioned) {
          // B2: 统一走结构化字段解析（appearance / canonicalName 独立列，兼容未迁移的旧前缀数据）
          const { canonicalName, appearance } = resolveCharacterFields(c);

          characters.push({
            name: c.name,
            canonicalName: canonicalName || undefined,
            appearance: appearance || undefined,
            role: c.role || undefined,
          });
        }
      } catch (e) {
        console.warn('[images/generate] 角色发现/注册失败:', e);
      }
    }

    // C4-② 图文对齐：先取分支链，统一用于两处决策——
    // ① 上下文窗口按"目标段"对齐（此前 slice(-6,-1) 永远取链路末端，为历史段落
    //    生图时喂的是结尾剧情 → 图文不符）；② 是否末段（决定滚动场景状态是否适用）。
    let contextSummary: string | undefined;
    let sceneStateEn: string | undefined;
    if (storyIdForChars) {
      let chain: Awaited<ReturnType<typeof getOrderedChain>> | null = null;
      try {
        chain = await getOrderedChain(storyIdForChars, branchIdForChain);
      } catch (e) {
        console.warn('[images/generate] 拉取分支链失败:', e);
      }
      const { isLatest, preceding } = chain
        ? locateSegmentContext(chain, segmentId, 5)
        : { isLatest: true, preceding: [] as any[] };

      // 上下文摘要：目标段之前的最近 5 段（历史段落再生成时同样按目标段对齐）
      if (preceding.length > 0) {
        try {
          contextSummary = await contextSummarizer.getContextForPrompt(preceding as any[], 1200, genre);
        } catch (e) {
          console.warn('[images/generate] 拉取上下文摘要失败:', e);
        }
      }

      // C1/C4-②：场景状态只对分支末段注入——scene_state 是滚动到最新段的快照，
      // 为历史段落生图时注入会把"最新时刻"的环境/在场角色强加到早期画面（图文不符）；
      // 历史段落不注入，让场景提取只依据该段文本与上文窗口。非末段也无需等待追平。
      if (isLatest) {
        try {
          await directorManager.waitForSceneStateFresh(storyIdForChars, branchIdForChain, segmentId, {
            timeoutMs: 12000,
            intervalMs: 1500,
          });
          sceneStateEn = await directorManager.getSceneStatePromptEnglish(storyIdForChars);
        } catch (e) {
          console.warn('[images/generate] 读取场景状态失败:', e);
        }
      } else {
        console.log('[images/generate] 目标为历史段落：跳过场景状态注入（避免最新状态与该段内容不符）');
      }
    }

    // C2/C5：seed 派生（角色集合 + 段落盐；重 roll 加变体 nonce）。
    // C5 策略解析（请求参数 > 环境变量 IMAGE_SEED_STRATEGY > 默认）：
    // - identity（默认）：同一故事内所有含角色的图片共享一个身份 seed —— 跨段、跨同框
    //   角色组合都不换"脸"；构图差异交给场景提示词；同段多图也共享 seed（seedStride=0）。
    // - diverse（C2 原行为）：角色集合 + 段落盐，跨段必不同（构图多样性优先）。
    const requestedSeedStrategy = typeof seedStrategyRaw === 'string' ? seedStrategyRaw : process.env.IMAGE_SEED_STRATEGY;
    const seedStrategy: ImageSeedStrategy = requestedSeedStrategy === 'diverse' ? 'diverse' : 'identity';

    const isReroll = reroll === true || existingImageCount > 0;
    const seed = deriveImageSeed({
      characters,
      storyId: storyIdForChars || '',
      segmentId,
      strategy: seedStrategy,
      variant: isReroll ? Date.now().toString(36) : undefined,
    });
    if (isReroll && seedStrategy === 'identity') {
      console.log('[images/generate] 重 roll 将更换身份种子（画面自然变化，脸部可能随之变化）');
    }
    console.log(
      `[images/generate] seed=${seed}（${isReroll ? '重roll' : '首生成'}，策略=${seedStrategy}，登场角色 ${characters.length} 个）`,
    );

    // 确定使用的风格：显式传入 > 自动分析
    let styleUsed: ImageStyle;
    let styleReason = '';

    if (requestedStyle !== 'auto') {
      styleUsed = requestedStyle;
      styleReason = '用户手动选择';
    } else {
      const storyStyleAnalysis = typeof storyContent === 'string' && storyContent.trim()
        ? analyzeStoryStyle(storyContent.slice(0, 2000))
        : undefined;
      const result = analyzeSegmentStyle(segmentContent, {
        storyStyle: storyStyleAnalysis && storyStyleAnalysis.confidence >= 0.5
          ? storyStyleAnalysis.recommendedStyle
          : undefined,
        genre,
        storyDescription,
      });
      styleUsed = result.style;
      styleReason =
        (!result.isAutoOverride && storyStyleAnalysis && storyStyleAnalysis.confidence >= 0.5
          ? storyStyleAnalysis.reason
          : result.reason) + (result.isAutoOverride ? '（段落级覆盖）' : '');
    }
    const images = await generateImagesForSegment({
      segmentId,
      segmentContent,
      style: styleUsed,
      maxImages,
      genre,
      storyDescription,
      characters,
      contextSummary,
      sceneStateEn,
      seed,
      // C5：identity 策略同段多图共享身份 seed（脸稳，构图靠提示词）；diverse 保持 seed+i
      seedStride: seedStrategy === 'identity' ? 0 : 1,
      referenceImages: referenceImageHints.length > 0 ? referenceImageHints : undefined,
      callAIFn: (p: string) => callAIText(p, { maxTokens: 4000 }),
    });

    // 更新段落的 imageUrls 到数据库（替换旧图，只保留最新一次生成的插图）
    if (images.length > 0) {
      try {
        const newUrls = images.map(img => img.url);
        await prisma.storySegment.update({
          where: { id: segmentId },
          data: { imageUrls: newUrls },
        });
      } catch (e) {
        console.warn('[images/generate] 更新段落 imageUrls 失败:', e);
      }
    }

    return NextResponse.json({
      success: true,
      segmentId,
      styleUsed,
      styleReason,
      images: images.map((img, i) => ({
        id: `img_${segmentId}_${i}`,
        url: img.url,
        description: img.description,
        type: img.type,
        width: 1024,
        height: 1024,
        alt: img.description,
      })),
      totalCount: images.length,
    });
  } catch (error) {
    console.error('图片生成失败:', error);
    return NextResponse.json(
      {
        success: false,
        error: '图片生成失败',
        details: error instanceof Error ? error.message : '未知错误'
      },
      { status: 500 }
    );
  }
}

export async function OPTIONS() {
  return NextResponse.json({
    allowedMethods: ['POST'],
    supportedStyles: IMAGE_STYLES.map(s => ({ value: s.value, label: s.label })),
  });
}
