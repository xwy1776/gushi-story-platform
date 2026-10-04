/**
 * 角色间外观区分度（C5-②：防撞脸巡检）
 *
 * 用途：同一故事内，不同角色的外观描述不允许高度雷同（否则生图会"撞脸"）。
 * 本模块提供纯函数：
 *   - appearanceTokens：从外观文本提取"有区分度"的视觉词元（长度 ≥5、去停用词）；
 *   - appearanceSimilarity：两段外观的 Jaccard 相似度（0–1）；
 *   - findSimilarCharacterPairs：按故事分组，找出相似度 ≥ 阈值的角色对
 *     （也能暴露"同一人的别名重复"这类脏数据——两份档案外观天然相似）。
 *
 * 使用方：`npm run enrich:appearance` 结尾的自动体检；未来可接入注册期告警。
 * 注意：这是**近似指标**——词元重合 ≠ 视觉撞脸，仅用于巡检提示，最终以图为准。
 */

/** 无区分度的常见词（长度过滤后仍剔除） */
const TOKEN_STOPWORDS = new Set([
  'early', 'young', 'short', 'upper', 'lower', 'which', 'their', 'about',
  'slightly', 'overall', 'appears', 'looks', 'styled', 'shaped',
]);

export function appearanceTokens(text: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (typeof text !== 'string' || !text) return out;
  for (const t of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length >= 5 && !TOKEN_STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

/** 两段外观文本的 Jaccard 相似度（0–1；任一侧无有效词元时为 0） */
export function appearanceSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const ta = appearanceTokens(a);
  const tb = appearanceTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) {
    if (tb.has(t)) inter++;
  }
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

export interface SimilarCharacterPair<T> {
  a: T;
  b: T;
  similarity: number;
}

/**
 * 找出同一故事内的"撞脸风险"角色对（相似度 ≥ threshold，按相似度降序）。
 * - 只比较同 storyId 的角色（跨故事无意义）；
 * - 跳过无外观的角色。
 */
export function findSimilarCharacterPairs<
  T extends { id: string; name: string; storyId: string; appearance?: string | null },
>(chars: T[], threshold = 0.5): Array<SimilarCharacterPair<T>> {
  const byStory = new Map<string, T[]>();
  for (const c of chars) {
    if (!c.appearance || !c.appearance.trim()) continue;
    const list = byStory.get(c.storyId);
    if (list) list.push(c);
    else byStory.set(c.storyId, [c]);
  }

  const pairs: Array<SimilarCharacterPair<T>> = [];
  for (const list of byStory.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const similarity = appearanceSimilarity(list[i].appearance, list[j].appearance);
        if (similarity >= threshold) {
          pairs.push({ a: list[i], b: list[j], similarity });
        }
      }
    }
  }
  pairs.sort((x, y) => y.similarity - x.similarity);
  return pairs;
}
