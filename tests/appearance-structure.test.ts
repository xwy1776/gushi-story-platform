/**
 * appearance-structure 单元测试（须式补全）
 *
 * 覆盖：须式存在性（英/中、clean-shaven、无须）、女性豁免、结构化标记判定、
 * 完成度判定（enrich:appearance 的跳过条件）——含各 preset 真实外观样例。
 *
 * 运行：npx vitest run tests/appearance-structure.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
  hasFacialHairSpec,
  isAppearanceComplete,
  isLikelyFemale,
  looksStructured,
} from '@/lib/appearance-structure';

// ── 真实样例（preset-stories.ts） ─────────────────────────────────────

/** 李世民：已写须式 */
const LI_SHIMIN =
  'male, late 20s, square face with strong jawline, thick arched eyebrows, sharp determined dark eyes, straight nose, thin lips with a short black beard, long black hair tied in a high topknot with a gold crown pin, tall and powerfully built with broad shoulders and upright military posture, dark navy Tang dynasty prince robe with gold trims, leather shoulder armor pieces, war bow in hand';

/** 诸葛亮（旧 spec）：结构化但完全未提须式 —— 必须被判"未完成"（会被 enrich 重写） */
const ZHUGE_OLD =
  'male, late 20s, refined oval face with high cheekbones, slender arched eyebrows, calm bright almond eyes, straight nose, thin lips, fair skin, long black hair neatly tied under a pale blue silk headband in the classic lun-jin style, tall and slender with an elegant upright scholar posture, flowing white crane-feather cloak over a pale blue robe, white feather fan held in his right hand';

/** 阿朱（用户手填中文旧格式） */
const A_ZHU = '年轻女子，鹅蛋脸，低髻，淡青襦裙，袖中藏信';

/** 结构化的女性英文外观（已补全） */
const FEMALE_STRUCTURED =
  'female, mid 20s, oval face, bright almond eyes, small nose, full lips, long black hair in a low bun, slender build, light cyan ruqun dress';

// ── hasFacialHairSpec ─────────────────────────────────────────────────

describe('hasFacialHairSpec（须式维度是否已明确）', () => {
  it('明确须型（英文）→ true', () => {
    expect(hasFacialHairSpec(LI_SHIMIN)).toBe(true);
    expect(hasFacialHairSpec('thin lips, full dark beard and mustache')).toBe(true);
    expect(hasFacialHairSpec('a faint stubble and sideburns')).toBe(true);
    expect(hasFacialHairSpec('a long goatee')).toBe(true);
  });

  it('明确无胡须（clean-shaven 各写法）→ true', () => {
    expect(hasFacialHairSpec('thin lips, clean-shaven, fair skin')).toBe(true);
    expect(hasFacialHairSpec('young man, clean shaven face')).toBe(true);
    expect(hasFacialHairSpec('smooth shaven cheeks')).toBe(true);
    expect(hasFacialHairSpec('no facial hair')).toBe(true);
  });

  it('中文写法 → true', () => {
    expect(hasFacialHairSpec('面白无须')).toBe(true);
    expect(hasFacialHairSpec('三绺长须，相貌堂堂')).toBe(true);
    expect(hasFacialHairSpec('虬髯客')).toBe(true);
  });

  it('完全未提及 → false', () => {
    expect(hasFacialHairSpec(ZHUGE_OLD)).toBe(false);
    expect(hasFacialHairSpec(A_ZHU)).toBe(false);
    expect(hasFacialHairSpec('male, brave warrior in red armor')).toBe(false);
  });

  it('空值与非法输入 → false', () => {
    expect(hasFacialHairSpec('')).toBe(false);
    expect(hasFacialHairSpec('   ')).toBe(false);
    expect(hasFacialHairSpec(null)).toBe(false);
    expect(hasFacialHairSpec(undefined)).toBe(false);
  });
});

// ── isLikelyFemale（女性豁免） ────────────────────────────────────────

describe('isLikelyFemale', () => {
  it('英文/中文女性写法 → true', () => {
    expect(isLikelyFemale(FEMALE_STRUCTURED)).toBe(true);
    expect(isLikelyFemale(A_ZHU)).toBe(true);
    expect(isLikelyFemale('a young woman in a cyan dress')).toBe(true);
    expect(isLikelyFemale('小女孩，双丫髻')).toBe(true);
  });

  it('男性 / 未指明 → false', () => {
    expect(isLikelyFemale(LI_SHIMIN)).toBe(false);
    expect(isLikelyFemale(ZHUGE_OLD)).toBe(false);
    expect(isLikelyFemale('')).toBe(false);
  });
});

// ── looksStructured 与 isAppearanceComplete ──────────────────────────

describe('looksStructured（结构标记旧标准）', () => {
  it('结构化外观（含旧 spec）→ true', () => {
    expect(looksStructured(LI_SHIMIN)).toBe(true);
    expect(looksStructured(ZHUGE_OLD)).toBe(true);
    expect(looksStructured(FEMALE_STRUCTURED)).toBe(true);
  });

  it('概括式 / 旧中文外观 → false', () => {
    expect(looksStructured('male, brave warrior in red robe')).toBe(false);
    expect(looksStructured(A_ZHU)).toBe(false);
  });
});

describe('isAppearanceComplete（新标准：结构 + 须式，女性豁免）', () => {
  it('已结构化且须式明确 → true（幂等跳过）', () => {
    expect(isAppearanceComplete(LI_SHIMIN)).toBe(true);
    expect(isAppearanceComplete(`${ZHUGE_OLD.replace('thin lips', 'thin lips, clean-shaven')}`)).toBe(true);
  });

  it('已结构化但缺须式的男性角色 → false（须重新改写补须式）', () => {
    expect(looksStructured(ZHUGE_OLD)).toBe(true);
    expect(hasFacialHairSpec(ZHUGE_OLD)).toBe(false);
    expect(isAppearanceComplete(ZHUGE_OLD)).toBe(false);
  });

  it('女性角色豁免须式：结构化 → true', () => {
    expect(looksStructured(FEMALE_STRUCTURED)).toBe(true);
    expect(hasFacialHairSpec(FEMALE_STRUCTURED)).toBe(false);
    expect(isAppearanceComplete(FEMALE_STRUCTURED)).toBe(true);
  });

  it('未结构化的（中文旧格式）→ false（照常改写）', () => {
    expect(isAppearanceComplete(A_ZHU)).toBe(false);
  });

  it('空值 → false', () => {
    expect(isAppearanceComplete('')).toBe(false);
    expect(isAppearanceComplete(null)).toBe(false);
    expect(isAppearanceComplete(undefined)).toBe(false);
  });
});
