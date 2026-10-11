/**
 * 结构化外观的完成度判定（C5 五官+体态 → 须式补全）
 *
 * 背景：两轮图文一致性实验（荆轲/赤壁）反复发现"须式"（有须/无须、须型、浓淡）是
 * 唯一未被冻结锚点管住、仍在逐段自由漂移的外观维度——赤壁轮"无须柔美少年 ↔ 蓄须
 * 显龄男"类型级翻转即源于规范未写须式。外观规范升级为"五官与须式"后：
 *   - 生成端（character-engine 两处 prompt）要求新角色须式必写（具体须型或 clean-shaven）；
 *   - 存量升级端（enrich:appearance）据此判定"是否已满足新标准"——已结构化但缺须式的
 *     角色也要被重新改写，否则该维度永远补不上（幂等性的关键）。
 *
 * 纯函数、零依赖。
 */

/** 结构化完成度标记：命中 ≥3 个五官/体态/须式标记即视为"已结构化" */
export const STRUCTURE_MARKERS = [
  'face', 'eye', 'eyebrow', 'brow', 'nose', 'lip', 'jaw', 'cheek', 'skin',
  'build', 'height', 'posture', 'shoulder',
  'beard', 'moustache', 'mustache', 'whisker', 'goatee', 'sideburn',
];

/** 须式维度是否已明确写出（英文或中文；含 clean-shaven / 无须 等"明确无胡须"写法） */
const FACIAL_HAIR_PATTERN =
  /beard|moustache|mustache|whisker|facial hair|shaven|shaved|stubble|goatee|sideburn|胡须|胡子|短须|长须|长髯|美髯|虬髯|络腮|蓄须|无须|無鬚/i;

export function hasFacialHairSpec(appearance: string | null | undefined): boolean {
  if (typeof appearance !== 'string' || !appearance.trim()) return false;
  return FACIAL_HAIR_PATTERN.test(appearance);
}

/** 女性角色判定（女性豁免须式要求；外观描述通常以 female/女子 等开头） */
const FEMALE_PATTERN = /female|\bwoman\b|\bgirl\b|\blady\b|女子|少女|女性|女孩|女童|姑娘|夫人/i;

export function isLikelyFemale(appearance: string | null | undefined): boolean {
  if (typeof appearance !== 'string' || !appearance.trim()) return false;
  return FEMALE_PATTERN.test(appearance);
}

/** 命中 ≥3 个结构标记即视为"已结构化"（旧标准；须式维度由 hasFacialHairSpec 另判） */
export function looksStructured(appearance: string): boolean {
  const t = appearance.toLowerCase();
  return STRUCTURE_MARKERS.filter(m => t.includes(m)).length >= 3;
}

/**
 * 完成度判定（新标准）：结构标记达标 **且** 须式已明确（女性角色豁免）。
 * 即 enrich:appearance 的"跳过"条件——不满足者需要（重新）改写。
 */
export function isAppearanceComplete(appearance: string | null | undefined): boolean {
  if (typeof appearance !== 'string' || !appearance.trim()) return false;
  return looksStructured(appearance) && (hasFacialHairSpec(appearance) || isLikelyFemale(appearance));
}
