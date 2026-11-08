/**
 * C5-②: 角色间外观区分度（防撞脸巡检）单元测试
 *
 * 覆盖 appearance-distinctness.ts：
 *  - appearanceTokens：长度过滤 / 停用词 / 去重 / 非字符串安全
 *  - appearanceSimilarity：相同 → 1；不同 → 低；空侧 → 0
 *  - findSimilarCharacterPairs：同故事配对、跨故事不配、阈值可调、降序、脏数据（别名重复）可检出
 *
 * 运行：npx vitest run tests/appearance-distinctness.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
  appearanceTokens,
  appearanceSimilarity,
  findSimilarCharacterPairs,
} from '@/lib/appearance-distinctness';

const JINGKE =
  'male, early 30s, lean weathered face, short black hair in a topknot, dark brown hanfu robe, leather forearm bracers, dagger at waist';
const QINWANG =
  'male, late 30s, imposing build, black and gold imperial robe, nine-bead crown, stern face, long black beard';
// 同一人的"别名重复"档案：外观文本几乎一致
const JINGKE_DUPE = JINGKE;

describe('appearanceTokens', () => {
  it('小写化并按长度 ≥5 过滤、去重', () => {
    const tokens = appearanceTokens('Black black BLACK hair male cloak');
    // black 保留一次；hair(4)/male(4) 被长度过滤
    expect([...tokens]).toEqual(['black', 'cloak']);
  });

  it('剔除无区分度的停用词', () => {
    expect([...appearanceTokens('early young short black')]).toEqual(['black']);
  });

  it('空 / 非字符串安全返回空集合', () => {
    expect(appearanceTokens('').size).toBe(0);
    expect(appearanceTokens(null).size).toBe(0);
    expect(appearanceTokens(undefined).size).toBe(0);
  });
});

describe('appearanceSimilarity', () => {
  it('完全相同文本 → 1', () => {
    expect(appearanceSimilarity(JINGKE, JINGKE_DUPE)).toBe(1);
  });

  it('不同角色（荆轲 vs 秦王）→ 明显低值', () => {
    expect(appearanceSimilarity(JINGKE, QINWANG)).toBeLessThan(0.2);
  });

  it('任一侧为空 → 0', () => {
    expect(appearanceSimilarity('', JINGKE)).toBe(0);
    expect(appearanceSimilarity(JINGKE, null)).toBe(0);
  });

  it('大小写不敏感', () => {
    expect(appearanceSimilarity(JINGKE.toUpperCase(), JINGKE)).toBe(1);
  });
});

describe('findSimilarCharacterPairs', () => {
  const chars = [
    { id: '1', name: '荆轲', storyId: 's1', appearance: JINGKE },
    { id: '2', name: '秦王嬴政', storyId: 's1', appearance: QINWANG },
    { id: '3', name: '荆轲（重复档案）', storyId: 's1', appearance: JINGKE_DUPE },
    { id: '4', name: '荆轲', storyId: 's2', appearance: JINGKE }, // 跨故事，不应与 s1 配对
    { id: '5', name: '无外观角色', storyId: 's1', appearance: '' },
  ];

  it('同故事内高相似对会被找出（别名重复脏数据可检出）', () => {
    const pairs = findSimilarCharacterPairs(chars, 0.5);
    expect(pairs).toHaveLength(1);
    expect([pairs[0].a.name, pairs[0].b.name].sort()).toEqual(['荆轲', '荆轲（重复档案）'].sort());
    expect(pairs[0].similarity).toBeGreaterThanOrEqual(0.9);
  });

  it('跨故事不配对（s2 的荆轲不与 s1 的任何角色配对）', () => {
    const pairs = findSimilarCharacterPairs(chars, 0.5);
    for (const p of pairs) {
      expect(p.a.storyId).toBe(p.b.storyId);
    }
  });

  it('阈值可调：降低阈值可纳入较低相似度的角色对', () => {
    const low = findSimilarCharacterPairs(chars, 0.05);
    expect(low.length).toBeGreaterThan(1);
    // 结果按相似度降序
    for (let i = 1; i < low.length; i++) {
      expect(low[i - 1].similarity).toBeGreaterThanOrEqual(low[i].similarity);
    }
  });

  it('提高阈值可过滤（0.95：仍命中完全相同的一对；对相似度低于阈值的角色不再命中）', () => {
    const pairs = findSimilarCharacterPairs(chars, 0.95);
    expect(pairs).toHaveLength(1);
  });

  it('空输入 / 全部无外观 → 无配对', () => {
    expect(findSimilarCharacterPairs([], 0.5)).toEqual([]);
    expect(
      findSimilarCharacterPairs([{ id: 'a', name: '甲', storyId: 's', appearance: '' }], 0.5),
    ).toEqual([]);
  });
});
