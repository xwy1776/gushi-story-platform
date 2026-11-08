/**
 * C2 / C5: 生图 seed 派生的单元测试
 *
 * - diverse 策略（C2 原行为）：确定性 / 段落盐 / 顺序无关 / 集合敏感 / 重 roll / 无角色回退
 * - identity 策略（C5 默认）：同故事共享身份 seed（跨段、跨角色组合同脸）；无角色保留段落盐
 *
 * 运行：npx vitest run tests/image-seed.test.ts
 */
import { describe, it, expect } from 'vitest';
import { deriveImageSeed } from '@/lib/image-seed';

const JINGKE = { name: '荆轲', canonicalName: 'Jing Ke' };
const QINWANG = { name: '秦王嬴政', canonicalName: 'King Zheng of Qin' };

const diverseOpts = {
  characters: [JINGKE, QINWANG],
  storyId: 'story_1',
  segmentId: 'seg_A',
  strategy: 'diverse' as const,
};

describe('diverse 策略（C2 原行为）', () => {
  it('确定性：同参数多次调用结果相同', () => {
    expect(deriveImageSeed(diverseOpts)).toBe(deriveImageSeed(diverseOpts));
  });

  it('段落盐：同一角色集合在不同段落得到不同 seed', () => {
    const a = deriveImageSeed({ ...diverseOpts, segmentId: 'seg_A' });
    const b = deriveImageSeed({ ...diverseOpts, segmentId: 'seg_B' });
    const c = deriveImageSeed({ ...diverseOpts, segmentId: 'seg_C' });
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(a).not.toBe(c);
  });

  it('角色顺序无关：输入顺序不同，seed 相同', () => {
    const a = deriveImageSeed({ ...diverseOpts, characters: [JINGKE, QINWANG] });
    const b = deriveImageSeed({ ...diverseOpts, characters: [QINWANG, JINGKE] });
    expect(a).toBe(b);
  });

  it('角色集合不同 → seed 不同', () => {
    const both = deriveImageSeed({ ...diverseOpts, characters: [JINGKE, QINWANG] });
    const only = deriveImageSeed({ ...diverseOpts, characters: [JINGKE] });
    expect(both).not.toBe(only);
  });

  it('canonicalName 优先于中文名参与派生', () => {
    const withCanonical = deriveImageSeed({ ...diverseOpts, characters: [{ name: '荆轲', canonicalName: 'Jing Ke' }] });
    const directEnglish = deriveImageSeed({ ...diverseOpts, characters: [{ name: 'Jing Ke' }] });
    expect(withCanonical).toBe(directEnglish);
  });

  it('重 roll 变体：variant 不同 → seed 不同；variant 相同 → seed 稳定', () => {
    const first = deriveImageSeed(diverseOpts);
    const reroll1 = deriveImageSeed({ ...diverseOpts, variant: 'abc123' });
    const reroll2 = deriveImageSeed({ ...diverseOpts, variant: 'def456' });
    const reroll1Again = deriveImageSeed({ ...diverseOpts, variant: 'abc123' });

    expect(reroll1).not.toBe(first);
    expect(reroll1).not.toBe(reroll2);
    expect(reroll1Again).toBe(reroll1);
  });

  it('无角色回退：纯风景镜头段级稳定（同段相同、跨段不同）', () => {
    const a1 = deriveImageSeed({ characters: [], storyId: 'story_1', segmentId: 'seg_A', strategy: 'diverse' });
    const a2 = deriveImageSeed({ characters: [], storyId: 'story_1', segmentId: 'seg_A', strategy: 'diverse' });
    const b = deriveImageSeed({ characters: [], storyId: 'story_1', segmentId: 'seg_B', strategy: 'diverse' });
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });

  it('无角色回退：不同故事的同一段落 ID 也不相同', () => {
    const s1 = deriveImageSeed({ characters: [], storyId: 'story_1', segmentId: 'seg_A', strategy: 'diverse' });
    const s2 = deriveImageSeed({ characters: [], storyId: 'story_2', segmentId: 'seg_A', strategy: 'diverse' });
    expect(s1).not.toBe(s2);
  });

  it('过滤无效角色条目（无名字/空白）后不影响结果', () => {
    const withJunk = deriveImageSeed({
      ...diverseOpts,
      characters: [JINGKE, { name: '   ' }, QINWANG],
    });
    expect(withJunk).toBe(deriveImageSeed(diverseOpts));
  });
});

describe('identity 策略（C5 默认——锁脸/体态）', () => {
  it('默认策略即 identity：不传 strategy 与显式 identity 一致', () => {
    const implicit = deriveImageSeed({ characters: [JINGKE], storyId: 'story_1', segmentId: 'seg_A' });
    const explicit = deriveImageSeed({ characters: [JINGKE], storyId: 'story_1', segmentId: 'seg_A', strategy: 'identity' });
    expect(implicit).toBe(explicit);
  });

  it('跨段落共享身份 seed（同一角色在任意段落同一张脸）', () => {
    const a = deriveImageSeed({ characters: [JINGKE], storyId: 'story_1', segmentId: 'seg_A', strategy: 'identity' });
    const b = deriveImageSeed({ characters: [JINGKE], storyId: 'story_1', segmentId: 'seg_B', strategy: 'identity' });
    const c = deriveImageSeed({ characters: [JINGKE], storyId: 'story_1', segmentId: 'seg_C', strategy: 'identity' });
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('同框角色组合变化不换 seed（配角进出同脸）', () => {
    const alone = deriveImageSeed({ characters: [JINGKE], storyId: 'story_1', segmentId: 'seg_A', strategy: 'identity' });
    const withKing = deriveImageSeed({ characters: [JINGKE, QINWANG], storyId: 'story_1', segmentId: 'seg_B', strategy: 'identity' });
    expect(alone).toBe(withKing);
  });

  it('不同故事的身份 seed 不同（身份键含故事 ID）', () => {
    const s1 = deriveImageSeed({ characters: [JINGKE], storyId: 'story_1', segmentId: 'seg_A', strategy: 'identity' });
    const s2 = deriveImageSeed({ characters: [JINGKE], storyId: 'story_2', segmentId: 'seg_A', strategy: 'identity' });
    expect(s1).not.toBe(s2);
  });

  it('重 roll 变体仍可换 seed（显式操作，允许换脸）', () => {
    const first = deriveImageSeed({ characters: [JINGKE], storyId: 'story_1', segmentId: 'seg_A', strategy: 'identity' });
    const reroll = deriveImageSeed({ characters: [JINGKE], storyId: 'story_1', segmentId: 'seg_A', strategy: 'identity', variant: 'abc123' });
    expect(reroll).not.toBe(first);
  });

  it('无角色段落保留段落盐（无脸可锁，优先多样性）', () => {
    const a = deriveImageSeed({ characters: [], storyId: 'story_1', segmentId: 'seg_A', strategy: 'identity' });
    const b = deriveImageSeed({ characters: [], storyId: 'story_1', segmentId: 'seg_B', strategy: 'identity' });
    expect(a).not.toBe(b);
  });

  it('storyId 缺失时退化为按角色集合锁身份（保持可用）', () => {
    const a = deriveImageSeed({ characters: [JINGKE], storyId: '', segmentId: 'seg_A', strategy: 'identity' });
    const b = deriveImageSeed({ characters: [JINGKE], storyId: '', segmentId: 'seg_B', strategy: 'identity' });
    expect(a).toBe(b);
  });
});

describe('通用', () => {
  it('返回值始终是 [0, 2^31-2] 的整数（两策略 × 多种输入）', () => {
    const inputs = [
      diverseOpts,
      { ...diverseOpts, segmentId: 'seg/with:wëird 字符' },
      { characters: [JINGKE], storyId: 'story_1', segmentId: 'seg_A', strategy: 'identity' as const },
      { characters: [], storyId: 'story_1', segmentId: 'seg_A' },
    ];
    for (const opts of inputs) {
      const seed = deriveImageSeed(opts);
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThanOrEqual(2147483646);
    }
  });
});
