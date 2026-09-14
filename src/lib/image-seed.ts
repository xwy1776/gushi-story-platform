/**
 * 生图 seed 派生策略
 *
 * ── 要解决的问题 ────────────────────────────────────────────────────
 * 扩散模型的 seed 决定"这次生成的随机起点"。旧实现用
 *   seed = hash(所有角色名排序拼接 + segmentId)
 * 派生，导致两个致命问题：
 *
 *   1. **加入路人就换 seed**：段落里多了一个未登记的路人，charKey 变了，
 *      整张图的 seed 随之改变 → 主角的脸跟着变。这正是"人物一多就串味"的根因之一。
 *   2. **每段都换 seed**：segmentId 参与派生，所以相邻段落必然是不同的 seed，
 *      角色面部在段落之间无法保持。
 *
 * ── 新策略：主角锚定 + 场景微扰 ──────────────────────────────────────
 *   seed = hash(主角外观锚点) + hash(场景片段) % SCENE_JITTER
 *
 *   - **主角锚定**：只取第一个已登记角色（主角）的 `appearance` 文本参与派生。
 *     外观不变 → 主角 seed 基数不变 → 跨段落主角面部稳定。
 *     路人（未登记）不参与派生，所以加不加路人都不会影响主角。
 *   - **场景微扰**：用段落内容的开头做一个小幅偏移（模 SCENE_JITTER），
 *     让同一主角在不同场景下构图有别，但偏移量远小于 seed 基数，
 *     不会把主角的脸"洗掉"。
 */

/** 一个已登记角色的视觉信息（与 CharacterVisualHint 兼容的最小子集） */
export interface SeedCharacterHint {
  name: string;
  canonicalName?: string;
  appearance?: string;
  role?: string;
}

/** 场景微扰幅度：远小于 seed 基数，只影响构图/细节，不影响人物身份 */
export const SCENE_JITTER = 4096;

/** FNV-1a 32 位哈希 */
function fnv1a(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 取"主角"作为视觉锚定对象。
 *
 * 优先级：role === 'protagonist' 的第一个 → 否则第一个角色。
 * 只看主角是因为：一张图里最需要保持一致的通常是主角；
 * 若把全部角色都纳入，角色集合一变 seed 就变，等于退回旧实现的老问题。
 */
export function pickAnchorCharacter(
  characters: SeedCharacterHint[],
): SeedCharacterHint | undefined {
  if (!characters || characters.length === 0) return undefined;
  return characters.find(c => c.role === 'protagonist') ?? characters[0];
}

/**
 * 派生图片生成 seed。
 *
 * @param characters 当前段落涉及的已登记角色（未登记路人不在其中）
 * @param sceneContent 用于场景微扰的文本（通常是段落内容）
 * @returns seed；无角色时返回 undefined（交给模型自由发挥）
 */
export function deriveImageSeed(
  characters: SeedCharacterHint[],
  sceneContent: string,
): number | undefined {
  const anchor = pickAnchorCharacter(characters);
  if (!anchor) return undefined;

  // 主角视觉锚点：外观 > 英文名 > 中文名，保证同一角色始终得到同一个基数
  const anchorKey = anchor.appearance?.trim()
    || anchor.canonicalName?.trim()
    || anchor.name;

  const base = fnv1a(`gushi-anchor::${anchorKey}`);
  const jitter = fnv1a(`gushi-scene::${(sceneContent || '').slice(0, 60)}`) % SCENE_JITTER;

  return (base % (2147483647 - SCENE_JITTER)) + jitter;
}
