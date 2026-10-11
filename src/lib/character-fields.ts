/**
 * 角色结构化字段工具（Blueprint B2）
 *
 * 背景：
 * 早期版本把角色外观 / 规范名 / 所属同人作品以字符串前缀的形式混存在
 * `traits`（性格特征）数组里，例如：
 *   traits = ["勇敢", "appearance:brown hair, red armor", "canonical:Kane", "fandom:某作品"]
 * 读取时依赖 startsWith / slice 字符串匹配 —— 脆弱（任意前缀变体或不规范写法都会失配），
 * 且会污染性格展示与 AI prompt。
 *
 * 现已落地结构化字段：`Character.appearance` 与 `Character.canonicalName`（Prisma 列）。
 * 本模块是整个代码库中唯一允许理解旧前缀格式的地方：
 *
 *   写入路径 —— 用 `splitLegacyTraitFields()` 归一化传入数据：把前缀条目抽成
 *              独立字段、traits 只保留真正的性格特征，从源头杜绝再写入前缀；
 *   读取路径 —— 用 `resolveCharacterFields()` 统一解析：结构化字段优先，
 *              仅当为空时才回退解析旧前缀（兼容尚未跑迁移脚本的历史数据）。
 *
 * 纯函数、零依赖，可同时被 Next.js 运行时代码与 tsx 脚本（迁移/导入）复用。
 */

/** 旧版 traits 前缀（唯一权威定义） */
export const LEGACY_TRAIT_PREFIXES = {
  appearance: 'appearance:',
  canonical: 'canonical:',
  fandom: 'fandom:',
} as const;

export type LegacyTraitPrefixKey = keyof typeof LEGACY_TRAIT_PREFIXES;

export interface SplitLegacyTraitFieldsResult {
  /** 清洗后的 traits：已剔除全部前缀条目，只保留性格/特征描述 */
  cleanTraits: unknown[];
  /** 从 "appearance:" 前缀中提取的外观描述（未命中为空） */
  legacyAppearance?: string;
  /** 从 "canonical:" 前缀中提取的规范名（未命中为空） */
  legacyCanonicalName?: string;
  /** 从 "fandom:" 前缀中提取的同人作品名（未命中为空） */
  legacyFandom?: string;
  /** 是否命中过任意前缀条目（迁移脚本据此判断是否需要写库） */
  hadLegacyEntries: boolean;
}

/**
 * 将（可能是）JSON 值的 traits 归一化为：
 *   - cleanTraits：剔除 "appearance:" / "canonical:" / "fandom:" 前缀条目后的数组
 *   - 各遗留字段（多个同前缀条目时取第一个非空值）
 *
 * 幂等：对已清洗过的数据再调用不会产生任何变化。
 * 对非数组输入按空数组处理；对非字符串条目原样保留。
 */
export function splitLegacyTraitFields(traits: unknown): SplitLegacyTraitFieldsResult {
  const result: SplitLegacyTraitFieldsResult = {
    cleanTraits: [],
    hadLegacyEntries: false,
  };

  if (!Array.isArray(traits)) return result;

  for (const entry of traits) {
    if (typeof entry !== 'string') {
      result.cleanTraits.push(entry);
      continue;
    }

    const matchedKey = (Object.keys(LEGACY_TRAIT_PREFIXES) as LegacyTraitPrefixKey[])
      .find(key => entry.startsWith(LEGACY_TRAIT_PREFIXES[key]));

    if (!matchedKey) {
      result.cleanTraits.push(entry);
      continue;
    }

    result.hadLegacyEntries = true;
    const value = entry.slice(LEGACY_TRAIT_PREFIXES[matchedKey].length).trim();
    if (!value) continue;

    if (matchedKey === 'appearance' && !result.legacyAppearance) {
      result.legacyAppearance = value;
    } else if (matchedKey === 'canonical' && !result.legacyCanonicalName) {
      result.legacyCanonicalName = value;
    } else if (matchedKey === 'fandom' && !result.legacyFandom) {
      result.legacyFandom = value;
    }
  }

  return result;
}

export interface ResolvedCharacterFields {
  /** 外观描述（结构化字段优先，旧前缀回退；未命中为 ''） */
  appearance: string;
  /** 规范英文名 / 罗马音（结构化字段优先，旧前缀回退；未命中为 ''） */
  canonicalName: string;
}

/**
 * 读取路径的统一解析入口。
 * 结构化字段（Character.appearance / Character.canonicalName）优先；
 * 为空时才回退解析 traits 旧前缀（兼容迁移前的历史数据）。
 */
export function resolveCharacterFields(c: {
  appearance?: string | null;
  canonicalName?: string | null;
  traits?: unknown;
}): ResolvedCharacterFields {
  const structuredAppearance = typeof c.appearance === 'string' ? c.appearance.trim() : '';
  const structuredCanonical = typeof c.canonicalName === 'string' ? c.canonicalName.trim() : '';

  // 快速路径：结构化字段齐全（迁移完成后的常态），无需触碰 traits
  if (structuredAppearance && structuredCanonical) {
    return { appearance: structuredAppearance, canonicalName: structuredCanonical };
  }

  const legacy = splitLegacyTraitFields(c.traits);
  return {
    appearance: structuredAppearance || legacy.legacyAppearance || '',
    canonicalName: structuredCanonical || legacy.legacyCanonicalName || '',
  };
}
