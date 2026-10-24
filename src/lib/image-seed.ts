/**
 * 生图 seed 派生（Blueprint C2 / C5）
 *
 * 职责边界（防止误用）：
 * - 本模块负责"身份稳定"与"构图多样"的平衡：
 *   · identity 策略（C5 默认）：同一故事内所有含角色的图片共享同一个"身份 seed"——
 *     跨段落、跨同框角色组合都保持一致，脸/体态中的随机分量被锁住；构图差异交给场景
 *     提示词（动作/环境/镜头）。无角色段落（纯风景）保留段落盐（没有脸可锁，优先多样性）。
 *   · diverse 策略（C2 原行为）：seed = 角色集合 + 段落盐，跨段必不同（构图多样性优先）。
 * - "脸不漂移"是三层共同结果：seed 层（相同噪声起点，本模块 identity）+ 文字层
 *   （逐字冻结的外观锚点 C3 + 结构化五官/体态描述 C5）；单靠任何一层都不够。
 * - 重 roll（variant）会更换 seed——identity 策略下意味着"重新选一次演员长相"，
 *   属显式操作，路由层有日志提示。
 *
 * 旧版问题（C2 背景）：seed 仅由角色名哈希派生 → 同一角色组合在任何段落拿到同一个
 * seed → 不同段落插图构图高度雷同；随后加段落盐（diverse）修构图，却让"脸"也随段改变。
 * C5 起按"有角色 → 锁身份；无角色 → 保多样"拆分处理。
 */

export type ImageSeedStrategy = 'identity' | 'diverse';

export interface ImageSeedOptions {
  /** 该段落的角色集合（diverse 下为身份基数；identity 下有角色即视为"锁身份"信号） */
  characters: { name: string; canonicalName?: string | null }[];
  /** 故事 ID（身份的归属域） */
  storyId: string;
  /** 段落 ID（diverse 的构图盐；无角色时两种策略都保留） */
  segmentId: string;
  /**
   * 重 roll 变体 nonce：仅在"对已有图片的段落再次生成"时传入。
   * 首生成不传 → 可复现；重 roll 传新值 → 换一次 seed。
   */
  variant?: string;
  /** 派生策略（默认 identity，见文件头） */
  strategy?: ImageSeedStrategy;
}

/** FNV-1a 32 位哈希（保持与原实现相同的散列算法） */
function fnv1aHash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h;
}

/**
 * 派生该次生图的 seed（0 ~ 2^31-2 的正整数）。
 *
 * key 构造：
 * - identity + 有角色：`id:{storyId}`                  （全故事共享——锁脸/体态）
 * - diverse  + 有角色：`{排序后的(规范名||中文名)}|{段}`（角色集合 + 段落盐）
 * - 无角色（两策略一致）：`{storyId}:scene|{段}`        （段落盐保留，风景图跨段多样）
 * - 可选 variant 追加 `|v<variant>`                     （重 roll 换一次）
 *
 * 注意：若生图提供商不支持 seed（如 DALL-E，请求中会删除 seed 字段），本函数返回值
 * 不影响出图，此时一致性完全依赖文字层（C3 锚点 + C5 结构化五官/体态描述）。
 */
export function deriveImageSeed(opts: ImageSeedOptions): number {
  const strategy: ImageSeedStrategy = opts.strategy ?? 'identity';

  const charKeys = (opts.characters || [])
    .filter(c => c && typeof c.name === 'string' && c.name.trim().length > 0)
    .map(c => (typeof c.canonicalName === 'string' && c.canonicalName.trim()) || c.name.trim())
    .sort();
  const hasCharacters = charKeys.length > 0;

  let key: string;
  if (strategy === 'identity' && hasCharacters) {
    key = opts.storyId && opts.storyId.length > 0 ? `id:${opts.storyId}` : `id:chars:${charKeys.join('|')}`;
  } else if (hasCharacters) {
    key = `${charKeys.join('|')}|${opts.segmentId}`;
  } else {
    key = `${opts.storyId}:scene|${opts.segmentId}`;
  }
  if (opts.variant) {
    key += `|v${opts.variant}`;
  }

  return Math.abs(fnv1aHash(key)) % 2147483647;
}
