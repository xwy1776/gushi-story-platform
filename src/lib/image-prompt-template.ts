/**
 * 生图 Prompt 模板：角色外观锚点（跨段落 / 跨图一致性）
 *
 * 问题：场景提取 LLM 每次都会用自己的措辞重新描写角色外貌
 * （"brown hair" vs "dark brown hair" vs 漏掉服饰），措辞漂移直接导致
 * 同一角色在不同段落/不同图片里长得不一样。
 *
 * 方案：把角色的外观描述"冻结"成一段**逐字不变**的锚点文本
 * （frozen character anchor），由本模块确定性生成：
 *
 *   - 锚点行只依赖 Character 的结构化字段（appearance / canonicalName，B2 已落地），
 *     生成过程是纯函数 —— 同一角色在任何段落、任何批次生成的锚点行完全相同；
 *   - 场景提取 LLM 被要求**不描写外貌**、只按名字指代人物，并在每个镜头里
 *     输出登场角色名单；最终 prompt 由 `composeConsistentScenePrompt` 在
 *     场景描述之后、风格模板之前，把该镜头的角色锚点原样拼入；
 *   - 中文外观（用户手填）会批量翻译为英文后使用，翻译结果按原文缓存
 *     （进程内），保证同一进程生命周期内跨段落译文稳定；
 *   - diffusion 模型对同一段文字的反应高度一致，因此"同一文字 + 同一角色
 *     集合的 seed 派生"共同保证了跨图外观稳定（构图多样性由 seed 的
 *     段落盐保证，见 images/generate 路由"方案 B"）。
 *
 * 本模块为纯函数 + 一个模块级翻译缓存，无服务端依赖，便于单测。
 */
import { extractJsonFromAI } from './ai-client';

/** 锚点块标题（英文，避免被 enforceNoTextInPrompt 的中文剥离误伤） */
export const CHARACTER_ANCHOR_HEADER =
  'Fixed character design — must stay identical in every image of this story (same face shape, same facial features, same facial hair, same body build, same hair, same outfit):';

/** C5-②：多角色同框时的"角色互不串脸"约束（≥2 个锚点行时自动附加） */
export const CHARACTER_ANCHOR_DISTINCT_NOTE =
  'Keep the listed characters clearly distinct from one another — different face shapes, facial hair, builds and outfits; never blend or share features between characters.';

/** 单条外观描述的最大长度（超出截断；C5 起结构化五官+体态描述放宽到 480） */
export const APPEARANCE_MAX_LENGTH = 480;

export interface CharacterAnchorSource {
  name: string;
  canonicalName?: string | null;
  appearance?: string | null;
}

export interface CharacterAnchor {
  /** 可用于匹配该角色的键：中文名 + 规范英文名 */
  matchKeys: string[];
  /** 冻结的锚点行，例如 "Jing Ke: male, ancient chinese assassin robe, ..." */
  line: string;
}

const CJK_RE = /[㐀-䶿一-鿿豈-﫿]/;

/**
 * 确定性归一化外观文本：压缩空白、清理分隔符写法（去逗号前空格、合并连续分隔符）、
 * 截断超长。同一输入必得同一输出（锚点跨段稳定的基础）。
 */
export function normalizeAppearance(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/\s+/g, ' ')
    .replace(/\s+([,，、])/g, '$1')
    .replace(/(?:[,，、]\s*){2,}/g, ', ')
    .trim()
    .slice(0, APPEARANCE_MAX_LENGTH);
}

/**
 * 从角色列表构建锚点集合。
 * - 没有 appearance 的角色不生成锚点（不注入空描述）
 * - 锚点行按内容排序 —— 与输入顺序无关，同一角色集合永远得到同一组行
 * - 相同锚点行去重（同角色重复传入时不产生重复行）
 */
export function buildCharacterAnchors(sources: CharacterAnchorSource[] | undefined): CharacterAnchor[] {
  const anchors: CharacterAnchor[] = [];
  const seenLines = new Set<string>();

  for (const c of sources || []) {
    if (!c || typeof c.name !== 'string') continue;
    const name = c.name.trim();
    if (!name) continue;

    const appearance = normalizeAppearance(c.appearance);
    if (!appearance) continue;

    const canonicalName = typeof c.canonicalName === 'string' ? c.canonicalName.trim() : '';
    const line = `${canonicalName || name}: ${appearance}`;
    if (seenLines.has(line)) continue;
    seenLines.add(line);

    const matchKeys = Array.from(new Set([name, canonicalName].filter(Boolean)));
    anchors.push({ matchKeys, line });
  }

  anchors.sort((a, b) => (a.line < b.line ? -1 : a.line > b.line ? 1 : 0));
  return anchors;
}

/** 匹配键 → 锚点行 的索引（中文名、规范英文名都可命中；同键冲突取先构建者） */
export function buildAnchorIndex(anchors: CharacterAnchor[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const a of anchors) {
    for (const key of a.matchKeys) {
      if (!index.has(key)) index.set(key, a.line);
    }
  }
  return index;
}

/**
 * 解析某个镜头（scene）应附加的锚点行：
 * 1. 优先用场景提取 LLM 输出的 characterNames（精确查索引）；
 * 2. 若一个都没命中（LLM 漏字段/旧格式输出），回退为在镜头文本里做
 *    包含匹配（仅用 ≥2 字符的名字，避免单字误命中）。
 * 返回按行排序、去重的锚点行数组。
 */
export function resolveSceneAnchorLines(
  scene: { characterNames?: string[]; description?: string; prompt?: string } | undefined,
  index: Map<string, string>,
): string[] {
  if (!scene || index.size === 0) return [];
  const lines = new Set<string>();

  const names = Array.isArray(scene.characterNames) ? scene.characterNames : [];
  for (const n of names) {
    const key = typeof n === 'string' ? n.trim() : '';
    if (!key) continue;
    const line = index.get(key);
    if (line) lines.add(line);
  }

  if (lines.size === 0) {
    const text = `${scene.description || ''} ${scene.prompt || ''}`;
    for (const [key, line] of index) {
      if (key.length >= 2 && text.includes(key)) lines.add(line);
    }
  }

  return Array.from(lines).sort();
}

/**
 * 固定顺序拼装最终场景 prompt：
 *   场景描述 → 角色锚点块（逐字不变）→（后续由 applyStylePrompt 追加风格）
 * 无锚点时原样返回场景描述。
 * ≥2 个角色时在标题行后附加"角色互不串脸"约束（C5-②，防多角色糊成同一张脸）。
 */
export function composeConsistentScenePrompt(opts: {
  scenePrompt: string;
  anchorLines?: string[];
}): string {
  const scenePrompt = (opts.scenePrompt || '').trim();
  const lines = (opts.anchorLines || []).filter(l => typeof l === 'string' && l.trim().length > 0);
  if (lines.length === 0) return scenePrompt;
  const header = lines.length >= 2
    ? `${CHARACTER_ANCHOR_HEADER}\n${CHARACTER_ANCHOR_DISTINCT_NOTE}`
    : CHARACTER_ANCHOR_HEADER;
  return `${scenePrompt}\n\n${header}\n${lines.join('\n')}`;
}

// ── 中文外观翻译（批量 + 进程内缓存） ──────────────────────────────
// 缓存键是锚点原文：同一进程内同一段外观文本只会被翻译一次，
// 因此跨段落生成的译文保持逐字一致；进程重启后（或换服务实例）
// 可能产生措辞略异的译文 —— AI 自动登记的角色外观本就直接是英文，
// 不受此影响。

const anchorTranslationCache = new Map<string, string>();

/** 仅供测试：清空翻译缓存 */
export function clearAnchorTranslationCache(): void {
  anchorTranslationCache.clear();
}

/**
 * 把锚点行中的中文批量翻译为英文（单次 AI 调用）。
 * - 全英文输入直接返回，不产生 AI 调用；
 * - 翻译失败时保留原文（后续 enforceNoTextInPrompt 会剥离中文，
 *   但英文部分与锚点结构仍在）。
 */
export async function translateAnchorsToEnglish(
  lines: string[],
  callAIFn?: (prompt: string) => Promise<string>,
): Promise<string[]> {
  const out = lines.map(l => (typeof l === 'string' ? l : ''));

  const pending = Array.from(
    new Set(out.filter(l => CJK_RE.test(l) && !anchorTranslationCache.has(l))),
  );

  if (callAIFn && pending.length > 0) {
    try {
      const prompt = `You are a translation engine for diffusion image prompts. Translate each character-appearance entry below into concise English. Rules: keep the character name at the start of each entry unchanged (transliterate to pinyin if it is a proper noun); keep the "Name: description" format; translate hair / facial hair / eyes / clothing / age / signature features precisely. Output ONLY a JSON array of strings, same order, no markdown, no explanation.

${pending.map((l, i) => `${i + 1}. ${l}`).join('\n')}`;

      const text = await callAIFn(prompt);
      const parsed = extractJsonFromAI<string[]>(text);
      if (Array.isArray(parsed)) {
        pending.forEach((raw, i) => {
          const t = parsed[i];
          if (typeof t === 'string' && t.trim()) {
            anchorTranslationCache.set(raw, t.trim());
          }
        });
      }
    } catch (e) {
      console.warn('[image-prompt-template] 角色锚点翻译失败，保留原文:', e);
    }
  }

  return out.map(l => anchorTranslationCache.get(l) ?? l);
}
