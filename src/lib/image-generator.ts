/**
 * 文生图核心模块 (P6-2)
 *
 * 功能：
 * - 调用 OpenAI-compatible 图片生成 API（DALL-E / 硅基流动 / 通义万相等）
 * - 从段落内容提取 1-3 个场景描述作为 prompt
 * - 支持 10 种图片风格（历史/水墨/工笔/敦煌/现代/科幻/玄幻/武侠/动漫/悬疑）
 * - 智能风格检测（同人/动漫/仙侠/西幻/现代等）
 * - 重试 & 降级机制（失败返回占位图，不阻塞主流程）
 * - 图片本地缓存（保存到 public/generated-images/）
 * - 强力文字抑制（enforceNoTextInPrompt，兼容 GLM/cogview）
 * - 角色视觉一致性（seed + CharacterVisualHint + 冻结外观锚点，见 image-prompt-template.ts）
 * - AI 上下文感知场景提取（extractSceneDescriptionsWithAI）
 */

import { join } from 'path';
import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { extractJsonFromAI } from './ai-client';
import type { ReferenceImageHint } from './reference-image-search';
import { sampleSegmentText } from './text-window';
import {
  buildAnchorIndex,
  buildCharacterAnchors,
  composeConsistentScenePrompt,
  resolveSceneAnchorLines,
  translateAnchorsToEnglish,
} from './image-prompt-template';
import {
  IMAGE_STYLES,
  type ImageStyle,
  type ConcreteImageStyle,
  type SceneDescription,
  type GeneratedImage,
} from './image-styles';

// Re-export for convenience
export {
  IMAGE_STYLES,
  type ImageStyle,
  type ConcreteImageStyle,
  type SceneDescription,
  type GeneratedImage,
} from './image-styles';

// ─── 配置 ───────────────────────────────────────────────────────────

/** 图片生成提供商配置 */
export interface ImageGeneratorConfig {
  provider: string;
  apiKey: string;
  model: string;
  baseUrl: string;
}

// ─── 2.3 风格 Prompt 模板 ────────────────────────────────────────────

export const STYLE_TEMPLATES: Record<ConcreteImageStyle, string> = {
  'historical-realistic':
    'Chinese historical realistic painting, highly detailed, accurate ancient Chinese architecture and hanfu costumes, warm oil-paint lighting, cinematic composition',

  'ink-wash':
    'Traditional Chinese ink wash painting, elegant brush strokes, monochrome with subtle color accents, vast negative space, poetic atmosphere',

  'gongbi':
    'Chinese Gongbi fine-brush painting, meticulous detail, rich mineral pigments, gold leaf accents, courtly elegance, precise linework',

  'dunhuang-mural':
    'Dunhuang Mogao cave mural style, Buddhist art, flowing celestial robes, mineral pigments, oxidized earth tones, devotional atmosphere',

  'modern-realistic':
    'modern realistic photography, cinematic lighting, shallow depth of field, natural colors, contemporary setting, photorealistic details',

  'sci-fi-cinematic':
    'science fiction cinematic concept art, futuristic technology, volumetric lighting, neon accents, high-tech environment, Blade Runner / Interstellar mood, photorealistic',

  'fantasy-epic':
    'epic fantasy concept art, dramatic lighting, magical atmosphere, grand composition, intricate details, digital painting in the style of Greg Rutkowski',

  'wuxia':
    'Chinese wuxia / xianxia concept art, flowing robes mid-motion, martial arts pose, misty mountain backdrop, ethereal glow, cinematic wide shot, modern digital painting (not traditional ink)',

  'anime':
    'high quality Japanese anime key visual, clean line art, vibrant cel-shading, expressive characters, dynamic composition, Makoto Shinkai lighting',

  'noir-thriller':
    'film noir cinematic style, high-contrast chiaroscuro lighting, cold desaturated palette, dramatic shadows, suspenseful mood, photorealistic',
};

/** 根据故事 genre / 段落内容自动选择风格 */
export function autoPickStyle(
  genre?: string,
  description?: string,
  segmentContent?: string,
): ConcreteImageStyle {
  const blob = [genre, description, segmentContent].filter(Boolean).join(' ');

  // 科幻：标签 / 常见科幻名词（飞船、星舰、三体、机甲、虫洞、基地、超光速……）
  if (/科幻|末世|赛博|太空|三体|飞船|星舰|星际|机甲|虫洞|曲率|超光速|外星|AI|人工智能|量子|纳米/i.test(blob)) return 'sci-fi-cinematic';
  if (/悬疑|推理|惊悚|恐怖|凶案|密室/.test(blob)) return 'noir-thriller';
  if (/武侠|仙侠|江湖|内力|剑仙|道法/.test(blob)) return 'wuxia';
  if (/玄幻|奇幻|魔幻|法师|巫师|精灵|巨龙|魔法/.test(blob)) return 'fantasy-epic';
  if (/同人|动漫|轻小说|火影|海贼|死神|鬼灭|龙珠|漫画/.test(blob)) return 'anime';
  if (/历史|正史|古代|王朝|皇帝|将军|朝廷|宫廷|帝王/.test(blob)) return 'historical-realistic';
  if (/都市|现代|言情|职场|校园|办公室/.test(blob)) return 'modern-realistic';
  // 默认：没匹配到关键词时倾向于现代写实（更通用），不再默认套古风
  return 'modern-realistic';
}

// ─── 环境变量读取 ─────────────────────────────────────────────────────

function getConfig(): ImageGeneratorConfig {
  return {
    provider: process.env.AI_IMAGE_PROVIDER || 'openai',
    apiKey: process.env.AI_IMAGE_API_KEY || '',
    model: process.env.AI_IMAGE_MODEL || 'dall-e-3',
    baseUrl: process.env.AI_IMAGE_BASE_URL || 'https://api.openai.com/v1',
  };
}

// ─── 场景描述提取器 ──────────────────────────────────────────────────

/**
 * 从段落内容提取 1-3 个场景描述作为图片 prompt。
 */
export function extractSceneDescriptions(segment: string): SceneDescription[] {
  const sentences = segment
    .split(/[。！？\n]+/)
    .map(s => s.trim())
    .filter(s => s.length >= 10);

  if (sentences.length === 0) return [];

  const visualKeywords = [
    '山', '水', '河', '湖', '海', '天', '月', '日', '星', '云', '雨', '雪', '风', '花', '树', '林', '城', '墙', '宫', '殿', '楼', '亭', '桥', '路', '街',
    '战', '斗', '杀', '射', '骑', '跑', '走', '坐', '立', '跪', '拜', '舞', '唱', '奏', '饮', '食',
    '血', '火', '光', '暗', '烟', '尘', '影', '色', '声', '红', '黑', '白', '金', '银',
    '帝', '王', '将', '臣', '兵', '军', '骑', '马', '剑', '弓', '旗', '甲',
  ];

  type ScoredSentence = { text: string; score: number; type: SceneDescription['type'] };

  const scored: ScoredSentence[] = sentences.map(text => {
    let score = 0;
    let type: SceneDescription['type'] = 'scene';

    if (/[帝王子将臣帅侯伯公夫人娘妃妾仆]/.test(text) && /穿|着|披|戴|持|握|面|目|身/.test(text)) {
      type = 'character';
      score += 3;
    }

    if (/[剑刀弓枪戟盾印符卷书简鼎玉佩]/.test(text) && !/[帝王子将臣帅侯伯公夫人娘]/.test(text)) {
      type = 'object';
      score += 2;
    }

    for (const kw of visualKeywords) {
      if (text.includes(kw)) score += 1;
    }

    if (text.length >= 15 && text.length <= 60) score += 1;

    return { text, score, type };
  });

  scored.sort((a, b) => b.score - a.score);

  const results: SceneDescription[] = [];
  const usedTypes = new Set<SceneDescription['type']>();

  for (const item of scored) {
    if (results.length >= 3) break;
    if (results.length >= 1 && usedTypes.has(item.type) && scored.length > results.length) {
      continue;
    }

    const description = item.text;
    const prompt = buildImagePrompt(description, item.type);
    results.push({ prompt, description, type: item.type });
    usedTypes.add(item.type);
  }

  return results;
}

function buildImagePrompt(scene: string, type: SceneDescription['type']): string {
  // 中立的类型提示，不假设故事时代背景；具体风格由 applyStylePrompt 叠加
  const typeHint: Record<SceneDescription['type'], string> = {
    scene: 'A wide cinematic scene depicting',
    character: 'A character-focused portrait depicting',
    object: 'A close-up detailed shot depicting',
  };

  return `${typeHint[type]}: ${scene.slice(0, 200)}`;
}

/**
 * 将风格模板叠加到 prompt 上
 * 若 style 为 'auto'，依据 genre / description 自动挑选风格
 */
function applyStylePrompt(
  prompt: string,
  style: ImageStyle = 'auto',
  ctx?: { genre?: string; description?: string; segmentContent?: string }
): string {
  const resolved: ConcreteImageStyle =
    style === 'auto' ? autoPickStyle(ctx?.genre, ctx?.description, ctx?.segmentContent) : style;
  const template = STYLE_TEMPLATES[resolved] || STYLE_TEMPLATES['modern-realistic'];
  return `${prompt}. ${template}`;
}

/**
 * 强力确保图片 prompt 不会让文字出现在画面里。
 * GLM / cogview 系列不支持 negative_prompt 字段，所有抑制指令必须写进 prompt 本体。
 *
 * 策略：
 *  1. 去除任何残留的 CJK 字符 + 假名 + 朝鲜字（AI 偶尔会漏翻译）
 *  2. 剥掉引号包裹的短语（模型容易把 "xxx" 当作要渲染的文本）
 *  3. 在开头注入强抑制指令，让模型在生成早期就确立"无文字"的主方向
 *  4. 在末尾幂等地追加英文 no-text 后缀
 */
export function enforceNoTextInPrompt(rawPrompt: string): string {
  let p = rawPrompt || '';

  // 1. 去掉中日韩字符 —— 扩散模型看到中文/日文极易尝试把它"绘制"进画面
  p = p.replace(/[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\u3100-\u312f\u3200-\u32ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]+/g, ' ');

  // 2. 剥掉所有成对的引号内容（中英引号）—— 这些最容易被当作"要渲染的文字"
  p = p.replace(/["'""''「」『』《》](.*?)["'""''「」『』《』《》]/g, '$1');

  // 3. 压掉多余空白
  p = p.replace(/\s+/g, ' ').trim();

  // 4. 头部强抑制指令
  const HEAD_DIRECTIVE = 'Pure visual cinematic scene, no written language of any kind anywhere in the frame, no letters, no glyphs, no characters, no captions, no subtitles, no UI elements. ';

  // 5. 幂等 no-text 尾缀（如果 AI 已经补过就不重复）
  const TAIL = ', absolutely no text, no words, no letters, no captions, no subtitles, no speech bubbles, no calligraphy, no handwriting, no signage, no book pages, no screens with text, no watermark, no logo';
  if (!/no\s+text/i.test(p)) {
    p = p + TAIL;
  }

  return HEAD_DIRECTIVE + p;
}

// ─── 重试 & 降级机制 ──────────────────────────────────────────────────

const MAX_RETRIES = 2;
const RETRY_BASE_DELAY = 2000;

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── 图片本地缓存 ─────────────────────────────────────────────────────

const CACHE_DIR = join(process.cwd(), 'public', 'generated-images');

async function ensureCacheDir(): Promise<void> {
  if (!existsSync(CACHE_DIR)) {
    await mkdir(CACHE_DIR, { recursive: true });
  }
}

function cacheFilename(segmentId: string, index: number, ext: string): string {
  return `${segmentId}_${index}_${Date.now()}.${ext}`;
}

async function saveToCache(data: Buffer, filename: string): Promise<string> {
  await ensureCacheDir();
  const filepath = join(CACHE_DIR, filename);
  await writeFile(filepath, data);
  return `/generated-images/${filename}`;
}

// ─── 核心：调用图片生成 API ───────────────────────────────────────────

/**
 * 调用 OpenAI-compatible 图片生成 API
 * 支持 /v1/images/generations 端点
 */
async function callImageAPI(prompt: string, config: ImageGeneratorConfig, seed?: number): Promise<{ url: string } | { b64_json: string }> {
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/images/generations`;

  /**
   * 通用 negative prompt：规避常见低质量/不一致问题。
   * 很多厂商会忽略未知字段而不报错，所以可以安全地作为"锦上添花"字段附带。
   */
  const NEGATIVE_PROMPT = [
    // 画质
    'blurry, low quality, lowres, jpeg artifacts, worst quality, bad anatomy, bad hands, extra fingers, mutated hands, deformed, nsfw',
    // 水印/签名
    'watermark, signature, logo, stamp, copyright',
    // 所有文字类元素（强力禁止段落文字出现在画面里）
    'text, words, letters, caption, subtitle, title, label, handwriting, calligraphy, chinese text, chinese characters, english text, japanese text, kanji, hiragana, katakana, speech bubble, dialogue bubble, manga text, comic panel borders, ui overlay, hud, book page, newspaper',
  ].join(', ');

  const body: Record<string, unknown> = {
    model: config.model,
    prompt,
    n: 1,
    size: '1024x1024',
    response_format: 'b64_json', // 优先 b64 以便本地缓存
    // 以下字段部分模型/提供商会用到；其余忽略
    negative_prompt: NEGATIVE_PROMPT,
    num_inference_steps: 30,
    guidance_scale: 5.5,
  };

  if (typeof seed === 'number' && Number.isFinite(seed)) {
    body.seed = seed;
  }

  // DALL-E 3 不支持 response_format=b64_json 时用 url
  if (config.model.includes('dall-e')) {
    body.response_format = 'url';
    // DALL-E 不识别这些字段，移除以免 400
    delete body.negative_prompt;
    delete body.num_inference_steps;
    delete body.guidance_scale;
    delete body.seed;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Image API error ${response.status}: ${text}`);
  }

  const json = await response.json();
  return json.data?.[0] ?? json;
}

// ─── 风格分析（启发式） ────────────────────────────────────────────────

const STYLE_RULES: { keywords: string[]; style: ConcreteImageStyle; reason: string }[] = [
  { keywords: ['宫廷', '贵族', '后宫', '妃嫔', '皇后', '太子', '朝堂', '殿上', '锦衣', '华服', '玉玺', '龙袍', '御膳', '御花园', '金銮殿'], style: 'gongbi', reason: '宫廷贵族题材，工笔画风格更能展现华美细节' },
  { keywords: ['战争', '沙场', '攻城', '征伐', '铁骑', '战马', '烽火', '刀兵', '甲胄', '兵马', '兵临城下', '调兵', '兵符'], style: 'historical-realistic', reason: '战争军事题材，写实风格更具史诗感' },
  { keywords: ['隐逸', '山水', '田园', '诗酒', '竹林', '垂钓', '归隐', '悠然', '琴棋', '煮茶', '渔舟', '采菊'], style: 'ink-wash', reason: '山水田园题材，水墨画最能表达诗意' },
  { keywords: ['宗教', '佛教', '道教', '道士', '道观', '西域', '丝绸之路', '敦煌', '飞天', '梵文', '僧人', '袈裟', '石窟', '胡人', '佛寺', '佛经', '佛法', '寺庙', '和尚', '菩萨', '罗汉', '金刚'], style: 'dunhuang-mural', reason: '宗教西域题材，敦煌壁画风格最为贴切' },
];

function countKeywordMatches(text: string, keywords: string[]): number {
  let score = 0;
  for (const kw of keywords) {
    score += text.split(kw).length - 1;
  }
  return score;
}

/**
 * 分析故事整体风格
 */
export function analyzeStoryStyle(storyContent: string): {
  recommendedStyle: ConcreteImageStyle;
  reason: string;
  confidence: number;
  allScores: { style: ImageStyle; score: number }[];
} {
  const text = storyContent.slice(0, 2000);

  let bestScore = 0;
  let bestRule = STYLE_RULES[STYLE_RULES.length - 1];

  for (const rule of STYLE_RULES) {
    const score = countKeywordMatches(text, rule.keywords);
    if (score > bestScore) {
      bestScore = score;
      bestRule = rule;
    }
  }

  if (bestScore === 0) {
    const autoStyle = autoPickStyle(undefined, undefined, text);
    return {
      recommendedStyle: autoStyle,
      reason: '未检测到强烈的细分历史风格信号，按故事题材自动推荐',
      confidence: 0.4,
      allScores: computeAllScores(text),
    };
  }

  const confidence = Math.min(bestScore / 5, 1);
  return {
    recommendedStyle: bestRule.style,
    reason: bestRule.reason,
    confidence,
    allScores: computeAllScores(text),
  };
}

/** 计算所有风格的匹配分数 */
function computeAllScores(text: string): { style: ImageStyle; score: number }[] {
  const allStyles: ImageStyle[] = [
    'auto', 'historical-realistic', 'ink-wash', 'gongbi', 'dunhuang-mural',
    'modern-realistic', 'sci-fi-cinematic', 'fantasy-epic', 'wuxia', 'anime', 'noir-thriller',
  ];

  return allStyles.map(style => {
    let score = 0;
    for (const rule of STYLE_RULES) {
      if (rule.style === style) {
        for (const kw of rule.keywords) {
          score += text.split(kw).length - 1;
        }
        break;
      }
    }
    return { style, score };
  });
}

/**
 * 分析单个段落风格，可覆盖故事整体风格
 */
export function analyzeSegmentStyle(
  segmentContent: string,
  context?: {
    storyStyle?: ConcreteImageStyle;
    genre?: string;
    storyDescription?: string;
  }
): {
  style: ConcreteImageStyle;
  reason: string;
  isAutoOverride: boolean;
} {
  const fallbackStyle: ConcreteImageStyle =
    context?.storyStyle ??
    autoPickStyle(context?.genre, context?.storyDescription, segmentContent);

  // 先检测段落是否有强烈的特殊风格信号
  for (const rule of STYLE_RULES) {
    const matchCount = rule.keywords.filter(kw => segmentContent.includes(kw)).length;
    if (matchCount >= 2) {
      // 段落有明确风格信号，且与故事风格不同 → 覆盖
      if (rule.style !== fallbackStyle) {
        return { style: rule.style, reason: rule.reason, isAutoOverride: true };
      }
      return { style: rule.style, reason: rule.reason, isAutoOverride: false };
    }
  }

  // 无明确信号，跟随故事整体画风；若没有整体风格，则按题材自动推断
  return {
    style: fallbackStyle,
    reason: context?.storyStyle ? '跟随故事整体画风' : '根据故事题材自动推荐',
    isAutoOverride: false,
  };
}

// ─── 导出接口 ─────────────────────────────────────────────────────────

export interface GenerateImagesOptions {
  segmentId: string;
  segmentContent: string;
  /** 图片风格（默认 auto：按 genre 自动选择） */
  style?: ImageStyle;
  maxImages?: number;
  /** 故事类型（用于 style=auto 时自动挑选风格） */
  genre?: string;
  /** 故事简介（辅助 auto 风格判断） */
  storyDescription?: string;
  /** 可选：AI 文本调用函数，若提供则优先用它提取/翻译场景为高质量英文 prompt */
  callAIFn?: (prompt: string) => Promise<string>;
  /** 可选：已登记角色列表 —— appearance 会被冻结成跨图外观锚点（C3），同时供场景提取参考（尤其是同人 IP） */
  characters?: CharacterVisualHint[];
  /** 可选：近 N 段摘要（中文），注入到场景提取 prompt 里，让镜头更贴近上下文 */
  contextSummary?: string;
  /** 可选：滚动场景状态（英文短句，例如 "dusk, rainy, tense mood"），直接拼到 enPrompt 环境描述里 */
  sceneStateEn?: string;
  /** 可选：图片生成 seed，锁定视觉一致性（同一场景/角色组合下跨段复用） */
  seed?: number;
  /**
   * 可选：同段多张图的 seed 步进（C5）。
   * 默认 1 = 每张 seed+i（构图各异，脸随 i 变化）；0 = 同段共享同一 seed
   * （identity 策略使用：脸/体态稳定，构图差异交给各镜头的提示词）。
   */
  seedStride?: number;
  /** 可选：同人 IP 参考图路径列表，注入场景提取 prompt */
  referenceImages?: ReferenceImageHint[];
  /**
   * 可选：预构建的镜头清单（对照实验/复现用，如"优化前"旧管线行为复现）；提供时跳过场景提取。
   * 注意：①是否附加角色外观锚点仍由 characters 参数决定（复现旧行为时不传 characters 即可）；
   * ②preset 镜头跳过「守卫终检」（保证旧管线行为可逐字复现，包括其退化产物）。
   */
  presetScenes?: SceneDescription[];
}

/**
 * 为一段故事生成插图
 */
export async function generateImagesForSegment(
  options: GenerateImagesOptions
): Promise<GeneratedImage[]> {
  const { segmentId, segmentContent, style = 'auto', maxImages = 3, genre, storyDescription, callAIFn, characters, contextSummary, sceneStateEn, seed, seedStride = 1, referenceImages, presetScenes } = options;
  const config = getConfig();

  if (!config.apiKey) {
    console.warn('[image-generator] 未配置 AI_IMAGE_API_KEY，跳过图片生成');
    return [];
  }

  // 2.2 场景描述来源：预构建镜头（对照实验/复现）> AI 提取（更精准）> 启发式
  let scenes = presetScenes && presetScenes.length > 0
    ? presetScenes.slice(0, maxImages)
    : callAIFn
      ? (await extractSceneDescriptionsWithAI(segmentContent, callAIFn, { genre, storyDescription, characters, contextSummary, sceneStateEn, referenceImages })).slice(0, maxImages)
      : extractSceneDescriptions(segmentContent).slice(0, maxImages);

  if (scenes.length === 0) {
    console.warn('[image-generator] 未从段落中提取到有效场景描述');
    return [];
  }

  // 2.3 如果场景 prompt 含中文（启发式回退），用 AI 翻译为英文 diffusion prompt，
  //     避免后续 enforceNoTextInPrompt 把场景内容全部剥掉导致只剩风格模板。
  //     守卫加固：翻译结果逐条过有效性校验；不合格 / 缺失的条目改用英文兜底脚手架
  //     （兜底文本量仍不足的条目会在装配末端的「守卫终检」被拦下）。

  // 英文兜底脚手架：用 sceneStateEn + genre + 故事简介拼一个英文底座
  //（比 enforceNoTextInPrompt 剥光所有中文后只剩风格模板要好得多）
  const buildEnglishScaffold = (scene: SceneDescription): string => {
    const typeHint: Record<string, string> = {
      scene: 'A wide cinematic scene',
      character: 'A character portrait',
      object: 'A close-up detailed shot',
    };
    const parts: string[] = [typeHint[scene.type] || 'A cinematic scene'];

    // 用 sceneStateEn 补充环境描述
    if (sceneStateEn && sceneStateEn.trim()) {
      parts.push(`environment: ${sceneStateEn.trim()}`);
    }
    // 用 genre 补充题材
    if (genre) {
      parts.push(`genre: ${genre}`);
    }
    // 用 storyDescription 补充故事背景（取前 100 字符）
    if (storyDescription) {
      parts.push(`story context: ${storyDescription.slice(0, 100)}`);
    }
    // 段落片段大部分是中文（会被 CJK 剥离），保留是为了其中混入的拉丁字符
    return `${parts.join(', ')}, ${segmentContent.slice(0, 80)}`;
  };

  const scenesHaveCJK = scenes.some(s => /[\u4e00-\u9fff]/.test(s.prompt));
  if (scenesHaveCJK) {
    const translatedPrompts: (string | null)[] = scenes.map(() => null);

    // 优先：用 AI 翻译
    if (callAIFn) {
      try {
        const descList = scenes.map((s, i) => `[${i}] (${s.type}) ${s.description}`).join('\n');
        const translatePrompt =
          `Translate the Chinese scene descriptions below into English diffusion prompts (60-100 words each: subject, action, environment, lighting, camera angle, mood). Output ONLY a JSON array of strings, same order, no markdown.\n\n${descList}`;

        const transText = await callAIFn(translatePrompt);
        if (transText && transText.trim()) {
          const enPrompts = extractJsonFromAI<string[]>(transText);
          if (Array.isArray(enPrompts)) {
            scenes.forEach((_, i) => {
              const cand = typeof enPrompts[i] === 'string' ? (enPrompts[i] as string).trim() : '';
              if (isValidEnPrompt(cand)) translatedPrompts[i] = cand;
            });
            const okCount = translatedPrompts.filter(Boolean).length;
            if (okCount > 0) {
              console.log(`[image-generator] 启发式场景已翻译为英文 prompt（${okCount}/${scenes.length} 条）`);
            }
            if (okCount < scenes.length) {
              console.warn(
                `[image-generator][守卫] ${scenes.length - okCount} 条翻译未通过有效性校验，改用英文兜底脚手架`,
              );
            }
          }
        } else {
          console.warn('[image-generator] AI 翻译返回空响应');
        }
      } catch (e) {
        console.warn('[image-generator] heuristic 场景翻译失败:', e);
      }
    }

    // 逐条装配：翻译有效 → 采用；否则用英文兜底脚手架
    scenes = scenes.map((scene, i) => {
      const tp = translatedPrompts[i];
      if (tp) return { ...scene, prompt: tp };
      return { ...scene, prompt: buildEnglishScaffold(scene) };
    });

    if (translatedPrompts.every(p => !p)) {
      console.warn('[image-generator] AI 翻译不可用，使用 sceneStateEn + genre 兜底构建英文 prompt');
    }
  }

  // 守卫终检：无论场景来自哪条通道（AI 提取 / 兜底重写 / 启发式翻译 / 英文脚手架），
  // 场景 prompt 经 CJK 剥离后仍须达到最小体量，否则一律不送生图 API —— 宁缺毋滥。
  // （近空 prompt 会生成与段落完全无关的画面，污染图文一致性与后续读图分析。）
  // presetScenes 为对照实验显式注入的复现镜头，跳过终检以保持实验可比性。
  if (!(presetScenes && presetScenes.length > 0)) {
    const rejected: string[] = [];
    scenes = scenes.filter(s => {
      if (isValidEnPrompt(s.prompt)) return true;
      rejected.push(s.prompt.trim().slice(0, 60) || '(空)');
      return false;
    });
    if (rejected.length > 0) {
      console.warn(
        `[image-generator][守卫] 终检拦截 ${rejected.length} 个低于阈值的场景 prompt（未发送生图 API）: ${rejected.join(' / ')}`,
      );
    }
    if (scenes.length === 0) {
      console.warn('[image-generator][守卫] 全部镜头未通过终检，本段跳过图片生成（不发送近空 prompt）');
      return [];
    }
  }

  // C3: 角色外观锚点 —— 冻结自 Character.appearance（B2 结构化字段），
  // 逐字拼入每个相关镜头的 prompt，保证同一角色跨段落、跨图片外观一致。
  // 中文外观（用户手填）批量翻译一次并按原文缓存，译文在同一进程内跨段稳定。
  let anchorIndex = new Map<string, string>();
  if (characters && characters.length > 0) {
    const anchors = buildCharacterAnchors(characters);
    let lines = anchors.map(a => a.line);
    if (callAIFn) {
      lines = await translateAnchorsToEnglish(lines, callAIFn);
    }
    anchorIndex = buildAnchorIndex(anchors.map((a, idx) => ({ ...a, line: lines[idx] ?? a.line })));
    if (anchorIndex.size > 0) {
      console.log(`[image-generator] 角色外观锚点已启用：${anchors.length} 个角色（跨段/跨图一致性）`);
    }
  }

  // 并行生成所有镜头：每个镜头独立重试 + 独立降级，避免一张失败拖累整体
  const renderOne = async (scene: SceneDescription, i: number): Promise<GeneratedImage> => {
    // C3: 附加该镜头的角色外观锚点（无锚点时原样返回场景描述）
    const anchorLines = resolveSceneAnchorLines(scene, anchorIndex);
    const composedPrompt = composeConsistentScenePrompt({
      scenePrompt: scene.prompt,
      anchorLines,
    });
    const styledPromptRaw = applyStylePrompt(composedPrompt, style, {
      genre,
      description: storyDescription,
      segmentContent,
    });
    // 强力抑制：去 CJK、去引号短语、强抑制指令（GLM/cogview 无 negative_prompt）
    const styledPrompt = enforceNoTextInPrompt(styledPromptRaw);
    console.log(`\n[image-generator] ===== 最终图片 prompt (scene ${i}) =====`);
    console.log(styledPrompt);
    console.log('[image-generator] ========================================\n');
    // C5：同段多图 seed 步进——stride=1 时 seed+i（构图各异）；identity 策略下 stride=0
    // （共享身份 seed，脸/体态稳定，构图差异由各镜头提示词承担）
    const sceneSeed = typeof seed === 'number' ? seed + i * seedStride : undefined;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const imageData = await callImageAPI(styledPrompt, config, sceneSeed);

        let imageUrl: string;

        if ('b64_json' in imageData && imageData.b64_json) {
          const buffer = Buffer.from(imageData.b64_json, 'base64');
          const filename = cacheFilename(segmentId, i, 'png');
          imageUrl = await saveToCache(buffer, filename);
        } else if ('url' in imageData && imageData.url) {
          const imgResp = await fetch(imageData.url);
          if (!imgResp.ok) throw new Error(`下载图片失败: ${imgResp.status}`);
          const buffer = Buffer.from(await imgResp.arrayBuffer());
          const filename = cacheFilename(segmentId, i, 'png');
          imageUrl = await saveToCache(buffer, filename);
        } else {
          throw new Error('API 返回数据中无有效图片');
        }

        console.log(`[image-generator] 图片生成成功: ${imageUrl}`);
        return { url: imageUrl, description: scene.description, type: scene.type, prompt: styledPrompt };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.warn(
          `[image-generator] 图片生成失败 (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${lastError.message}`
        );
        if (attempt < MAX_RETRIES) {
          const delay = RETRY_BASE_DELAY * Math.pow(2, attempt);
          await sleep(delay);
        }
      }
    }

    // 降级：占位图
    const filename = cacheFilename(segmentId, i, 'svg');
    const placeholderSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#f3f4f6"/>
  <text x="256" y="240" text-anchor="middle" font-size="48" fill="#9ca3af">🎨</text>
  <text x="256" y="290" text-anchor="middle" font-size="14" fill="#6b7280">图片生成失败</text>
  <text x="256" y="316" text-anchor="middle" font-size="12" fill="#9ca3af">${scene.description.slice(0, 20)}...</text>
</svg>`;
    await ensureCacheDir();
    await writeFile(join(CACHE_DIR, filename), placeholderSvg);
    console.warn(`[image-generator] 降级为占位图: ${lastError?.message}`);
    return {
      url: `/generated-images/${filename}`,
      description: scene.description,
      type: scene.type,
      prompt: styledPrompt,
    };
  };

  return Promise.all(scenes.map((s, i) => renderOne(s, i)));
}

export interface CharacterVisualHint {
  /** 中文名（用于在段落中匹配） */
  name: string;
  /** 规范英文名 / 原作罗马音（可选） */
  canonicalName?: string;
  /** 视觉关键词：发型、服饰、标志性特征 */
  appearance?: string;
  /** 角色定位（主角/反派/配角等，可选） */
  role?: string;
}

// ─── enPrompt 有效性守卫（提取失败时重试 / 按 description 兜底重写） ─────
// 背景：提取 LLM 偶发采样退化（enPrompt 缺失 / 近空 / 混入中文）时，旧逻辑会经
// buildImagePrompt 拼出"近空 prompt"直送生图 API → 生成与段落完全无关的画面
// （实测案例：玄武门轮 B1 "A wide cinematic scene depicting:."）。守卫设三层防线：
//   ① 逐条校验：enPrompt 经 CJK 剥离后仍须达到最小体量（防"近空"与"将被剥空"）；
//   ② 整组重试：0 条有效（含解析失败 / 调用异常）→ 追加强化指令重发一次提取
//      （采样抖动通常一次即可恢复）；
//   ③ 兜底重写：重试后仍缺的镜头，按 description 重写为英文 prompt；description
//      也没有 → 弃用该镜头（不拿退化 enPrompt 当重写素材，避免产出"看着像样但
//      无文本依据"的幻觉画面）。全部不可用 → 回退启发式 extractSceneDescriptions
//      （沿用既有 CJK 翻译通道）。
// 另在 generateImagesForSegment 装配末端设有「守卫终检」：无论场景来自哪条通道
// （提取 / 重写 / 启发式翻译 / 英文脚手架），CJK 剥离后低于阈值的 prompt 一律
// 不送生图 API（宁缺毋滥；presetScenes 复现通道除外）。
// 正常路径零额外调用；失败路径最多多 1~2 次文本调用。

/** 提取 LLM 返回的原始镜头条目（字段不可信，一律按 unknown 处理后校验） */
interface RawSceneItem {
  description?: unknown;
  enPrompt?: unknown;
  type?: unknown;
  characters?: unknown;
}

function isRawSceneItem(it: unknown): it is RawSceneItem {
  return !!it && typeof it === 'object' && !Array.isArray(it);
}

/** enPrompt 经 CJK 剥离后视为有效的最小字符数 */
export const MIN_VALID_ENPROMPT_CHARS = 60;
/** enPrompt 经 CJK 剥离后视为有效的最小英文单词数 */
export const MIN_VALID_ENPROMPT_WORDS = 10;

/** 与 enforceNoTextInPrompt 使用同一字符集（会被剥离的字符） */
const CJK_CHARS_RE = /[　-〿぀-ゟ゠-ヿ㄀-ㄯ㈀-㋿㐀-䶿一-鿿가-힯豈-﫿＀-￯]+/g;

/**
 * 判定 enPrompt 是否"能活着到达生图 API"：
 * CJK 字符会被 enforceNoTextInPrompt 剥离，因此按剥离后的剩余量判定——
 * 中文描述、近空串（"A wide cinematic scene depicting:."）均会被判无效。
 * 同一判据也被 generateImagesForSegment 的「守卫终检」复用于所有非 preset 场景。
 */
export function isValidEnPrompt(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  const cleaned = raw.replace(CJK_CHARS_RE, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length < MIN_VALID_ENPROMPT_CHARS) return false;
  const words = cleaned.split(' ').filter(w => /[a-zA-Z]/.test(w));
  return words.length >= MIN_VALID_ENPROMPT_WORDS;
}

/** 守卫第 ② 层：整组重试时追加的强化指令 */
const GUARD_RETRY_SUFFIX = `

【系统校验未通过 · 请完整重新输出】上一次的输出不合格：部分或全部镜头缺少完整、有效的英文 enPrompt（缺失 / 过短 / 混入中文）。请严格按格式完整重新输出 JSON 数组，每个镜头必须包含一条完整的英文 enPrompt（80-140 词：主体 / 动作 / 环境 / 光线 / 镜头景别 / 构图 / 氛围齐全），不得省略、不得截断。`;

/**
 * 守卫第 ③ 层：把单条中文镜头描述兜底重写为英文 diffusion prompt。
 * 输出经清洗与 isValidEnPrompt 复核；不合格返回 null（调用方丢弃该镜头，绝不回退近空 prompt）。
 */
async function rewritePromptFromDescription(
  description: string,
  type: SceneDescription['type'],
  callAIFn: (prompt: string) => Promise<string>,
): Promise<string | null> {
  const typeHint: Record<SceneDescription['type'], string> = {
    scene: 'wide cinematic scene',
    character: 'character-focused shot',
    object: 'close-up detail shot',
  };
  const prompt = `你是 diffusion 模型 prompt 工程师。把下面这条中文镜头描述改写为一条完整的英文图片生成 prompt（80-140 词），必须包含：主体与动作、环境、光线、镜头景别（wide shot / medium / close-up）、构图、氛围。不要出现任何中文字符；不要描写人物外貌细节（发型 / 须式 / 服装 / 五官）。只输出英文 prompt 本体，不要引号、不要解释。

镜头类型：${typeHint[type] || 'wide cinematic scene'}
镜头描述：${description.slice(0, 200)}`;

  try {
    const raw = await callAIFn(prompt);
    const cleaned = (raw || '')
      .replace(CJK_CHARS_RE, ' ')
      .replace(/["'“”「」『』]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!isValidEnPrompt(cleaned)) {
      console.warn(
        `[image-generator][守卫] 兜底重写结果未通过有效性校验（长度 ${cleaned.length}），该镜头将被弃用`,
      );
      return null;
    }
    return cleaned;
  } catch (e) {
    console.warn('[image-generator][守卫] 兜底重写调用失败:', e);
    return null;
  }
}

/**
 * 使用 AI 提取更精准的场景描述，并直接翻译为信息密度高的英文 diffusion prompt。
 * 失败时回退到启发式 extractSceneDescriptions。
 *
 * 「enPrompt 有效性守卫」（提取 LLM 与生图 API 之间的质检关卡）：
 *   ① 逐条校验 enPrompt（CJK 剥离后须达到最小体量，见 isValidEnPrompt）；
 *   ② 0 条有效 → 追加强化指令整组重试一次（采样抖动通常可恢复）；
 *   ③ 重试后仍缺的镜头按 description 兜底重写；description 也没有 → 弃用该镜头；
 *   ④ 全部不可用 → 回退启发式提取。
 * 任何近空 prompt（如 "A wide cinematic scene depicting:."）都无法流进生图 API。
 */
export async function extractSceneDescriptionsWithAI(
  segment: string,
  callAIFn: (prompt: string) => Promise<string>,
  ctx?: {
    genre?: string;
    storyDescription?: string;
    characters?: CharacterVisualHint[];
    contextSummary?: string;
    sceneStateEn?: string;
    referenceImages?: ReferenceImageHint[];
  },
): Promise<SceneDescription[]> {
  const genreHint = ctx?.genre ? `故事类型：${ctx.genre}` : '';
  const descHint = ctx?.storyDescription ? `故事简介：${ctx.storyDescription.slice(0, 200)}` : '';
  const summaryHint = ctx?.contextSummary ? `近 N 段故事摘要（用于上下文衔接，不要原样复制，只用于理解画面走向）：\n${ctx.contextSummary.slice(0, 1200)}` : '';
  const sceneStateHint = ctx?.sceneStateEn ? `已知场景状态（English, 必须保留进 enPrompt 的环境描述里以保证跨段一致）：${ctx.sceneStateEn}` : '';

  // D2: 同人 IP 参考图视觉锚点
  let referenceBlock = '';
  if (ctx?.referenceImages && ctx.referenceImages.length > 0) {
    const imageList = ctx.referenceImages
      .map((img, i) => `[${i + 1}] ${img.characterName ? `角色: ${img.characterName}` : '群像'} → ${img.localPath}`)
      .join('\n');
    referenceBlock = `
【IP 参考图】（以下图片是该同人 IP 的官方/经典角色设定图，整幅画面的视觉风格必须严格遵循这些参考图；角色造型与之一致）：
${imageList}
约束：角色外貌以系统统一追加的固定"角色锚点"为准（两者应互相吻合）；不得凭空创造新设计。
`;
  }

  // 构建角色名单（只给名字与定位）：外貌由系统统一追加的"角色锚点"块保证一致，
  // 此处故意不展示 appearance，避免 LLM 把外观改写进 enPrompt 造成跨图漂移
  let characterBlock = '';
  const chars = (ctx?.characters || []).filter(c => c && c.name);
  if (chars.length > 0) {
    const lines = chars.map(c => {
      const parts = [`- ${c.name}`];
      if (c.canonicalName) parts.push(`英文名：${c.canonicalName}`);
      if (c.role) parts.push(`定位：${c.role}`);
      return parts.join(' | ');
    });
    characterBlock = `\n已登记角色（镜头中出现时用这些名字指代人物；禁止描写其外貌细节——发型/须式/服装/五官等由系统统一追加的固定"角色锚点"保证跨图一致；禁止用 "a boy / a man / a woman" 泛称）：\n${lines.join('\n')}\n`;
  }

  // 长段落头+尾采样（C4-②）：只截头部会漏掉后半的关键画面（常为高潮/转折）→ 图文不符
  const segmentForExtraction = sampleSegmentText(segment, 1500);

  const prompt = `你是一位电影分镜与 diffusion 模型 prompt 工程师。
分析下面这段中文故事（"当前段落"），提取 1-3 个最具视觉画面感的镜头，并为每个镜头同时给出：
- description：中文一句话镜头说明（10-40字，给人看）
- enPrompt：英文图片生成 prompt（给 diffusion 模型看），80-140 词，包含：**主体（用角色名指代）、动作、环境、光线、镜头景别（wide shot / medium / close-up）、构图、氛围**。
- type：scene | character | object
- characters：该镜头中出现的"已登记角色"的中文名数组（必须来自下方角色列表），没有则为 []

【关键约束】
1. 镜头必须**只来自"当前段落"**。"近 N 段摘要"和"场景状态"仅用于理解世界观和画面连贯，不得把摘要中的历史事件当镜头。
2. enPrompt 必须是纯英文，不得出现任何中文字符、假名、朝鲜字；不得原样抄写段落里的中文句子。
3. 若镜头里出现"已登记角色"，必须用其名字指代（有英文名时用英文名，如 "Obito Uchiha"）——但**绝对禁止在 enPrompt 里描写任何外貌细节**（发型、发色、眼睛、胡须/须式、服装、年龄、标志性特征一律不写），角色外貌由系统统一追加的固定"角色锚点"保证跨图一致（同人/动漫 IP 会用原作经典造型）；也禁止用 "a boy / a man / a woman" 泛称。
4. 每个镜头必须输出 characters 字段，列出该镜头登场的已登记角色（中文名）；遗漏会导致该镜头缺少角色外观锚点。
5. 若给出了"已知场景状态"，enPrompt 里的环境/光线/时间描述必须与之一致（例如 scene state 说 dusk rainy，就不能写 sunny morning）。
6. 在 enPrompt 结尾追加固定短语：", no text, no captions, no subtitles, no speech bubbles, no calligraphy, no watermark"。
7. 严格输出 JSON 数组，不要 markdown、不要额外文字。

格式：
[{"description":"...","enPrompt":"...","type":"scene","characters":["角色中文名"]}]

${genreHint}
${descHint}
${summaryHint}
${sceneStateHint}
${characterBlock}
${referenceBlock}
【当前段落】（镜头必须从这里取）：
${segmentForExtraction}`;

  try {
    /** 单次提取：调用 + 解析为原始条目列表（非数组或全无条目时返回 null 由守卫处理） */
    const requestExtraction = async (suffix = ''): Promise<RawSceneItem[] | null> => {
      const text = await callAIFn(prompt + suffix);
      // ── 健壮 JSON 解析：兼容推理模型思考文本、markdown 包裹、截断响应等 ──
      const parsed = extractJsonFromAI<unknown>(text);
      if (!Array.isArray(parsed)) {
        console.warn(`[image-generator][守卫] AI 返回内容无法解析为 JSON 数组，前200字: ${String(text).slice(0, 200)}`);
        return null;
      }
      return parsed.filter(isRawSceneItem).slice(0, 3);
    };

    const countValid = (list: RawSceneItem[] | null) =>
      (list || []).filter(it => isValidEnPrompt(it.enPrompt)).length;

    let retried = false; // 整组重试是否触发（供最终日志与验证复核）
    let rewriteOk = 0; // 兜底重写成功条数

    // ── 第 1 次提取（调用异常视同"0 条有效"，交给守卫②统一重试一次） ──
    let items: RawSceneItem[] | null = null;
    try {
      items = await requestExtraction();
    } catch (e) {
      console.warn('[image-generator][守卫] 首次提取调用失败（将由守卫②重试一次）:', e);
    }

    // ── 守卫②：一条有效 enPrompt 都没有（含解析失败 / 调用异常）→ 追加强化指令重试一次 ──
    if (countValid(items) === 0) {
      console.warn('[image-generator][守卫] 首次提取无有效 enPrompt（缺失 / 近空 / 混入中文），强化指令重试一次');
      retried = true;
      const retryItems = await requestExtraction(GUARD_RETRY_SUFFIX).catch(e => {
        console.warn('[image-generator][守卫] 重试调用失败:', e);
        return null;
      });
      if (retryItems && (countValid(retryItems) > 0 || !items || items.length === 0)) {
        items = retryItems;
      }
    }

    if (!items || items.length === 0) {
      throw new Error('提取失败：重试后仍无任何镜头条目');
    }

    // ── 守卫①③：逐条校验；无效条目按 description 兜底重写，重写失败才丢弃 ──
    const scenes: SceneDescription[] = [];
    const dropped: string[] = [];

    for (const item of items) {
      const rawType = typeof item.type === 'string' ? item.type : 'scene';
      const type: SceneDescription['type'] =
        rawType === 'character' || rawType === 'object' ? rawType : 'scene';
      const description = typeof item.description === 'string' ? item.description.trim() : '';

      const isValid = isValidEnPrompt(item.enPrompt);
      let finalPrompt = isValid ? (item.enPrompt as string).replace(/\s+/g, ' ').trim() : '';

      if (!finalPrompt) {
        // 守卫③：仅当 description 存在时兜底重写为英文 prompt；description 也没有 →
        // 弃用该镜头。不拿"残存 enPrompt"当重写素材——它大概率就是空 / 近空 / 以中文
        // 为主的退化产物，从无内容素材重写会产出"看着像样但无文本依据"的幻觉画面，
        // 与近空 prompt 同样有害（宁可弃用，让启发式通道从段落正文重建）。
        if (description) {
          const rewritten = await rewritePromptFromDescription(description, type, callAIFn);
          if (rewritten) {
            finalPrompt = rewritten;
            rewriteOk++;
          }
        }
      }

      if (!finalPrompt) {
        dropped.push(description || '(无描述)');
        continue;
      }

      // C3: 该镜头登场的已登记角色名 —— 用于在最终 prompt 中附加冻结的外观锚点；
      // 缺失时 resolveSceneAnchorLines 会退化为按镜头文本包含匹配
      const characterNames = Array.isArray(item.characters)
        ? (item.characters as unknown[])
            .filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
            .map(n => n.trim())
        : undefined;

      scenes.push({
        description: description || finalPrompt.slice(0, 40),
        type,
        prompt: finalPrompt,
        characterNames,
      });
    }

    if (dropped.length > 0) {
      console.warn(`[image-generator][守卫] 丢弃 ${dropped.length} 个无法重写的无效镜头: ${dropped.join(' / ')}`);
    }

    if (scenes.length === 0) {
      throw new Error('提取失败：所有镜头均未通过有效性校验（重试与兜底重写后）');
    }

    // 守卫活动汇总（正常路径零额外调用；此行为一次性日志，便于真实运行复核）
    console.log(
      `[image-generator][守卫] 提取完成：采用 ${scenes.length} 个镜头` +
        `${retried ? '（触发整组重试）' : ''}` +
        `${rewriteOk > 0 ? `（兜底重写 ${rewriteOk} 条）` : ''}` +
        `${dropped.length > 0 ? `（弃用 ${dropped.length} 条）` : ''}`,
    );

    return scenes;
  } catch (error) {
    console.warn(`[image-generator] AI 场景提取失败，回退到启发式方法: ${error}`);
    return extractSceneDescriptions(segment);
  }
}
