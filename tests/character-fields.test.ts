/**
 * B2: 角色结构化字段工具单元测试
 *
 * 覆盖 character-fields.ts：
 *  - splitLegacyTraitFields：旧前缀抽取 / traits 清洗 / 异常输入 / 幂等
 *  - resolveCharacterFields：结构化字段优先 + 旧前缀回退
 *
 * 运行：npx vitest run tests/character-fields.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
  splitLegacyTraitFields,
  resolveCharacterFields,
  LEGACY_TRAIT_PREFIXES,
} from '@/lib/character-fields';

describe('splitLegacyTraitFields', () => {
  it('抽取全部三种旧前缀并从 traits 中剔除', () => {
    const r = splitLegacyTraitFields([
      '勇敢',
      'appearance:brown hair, red armor',
      '侠义',
      'canonical:Kane',
      'fandom:某作品',
    ]);
    expect(r.hadLegacyEntries).toBe(true);
    expect(r.legacyAppearance).toBe('brown hair, red armor');
    expect(r.legacyCanonicalName).toBe('Kane');
    expect(r.legacyFandom).toBe('某作品');
    expect(r.cleanTraits).toEqual(['勇敢', '侠义']);
  });

  it('多个同前缀条目取第一个非空值，全部剔除', () => {
    const r = splitLegacyTraitFields([
      'appearance:first look',
      'appearance:second look',
      'canonical:NameA',
      'canonical:NameB',
    ]);
    expect(r.legacyAppearance).toBe('first look');
    expect(r.legacyCanonicalName).toBe('NameA');
    expect(r.cleanTraits).toEqual([]);
  });

  it('空值前缀条目（如 "appearance:"）只剔除、不抽取', () => {
    const r = splitLegacyTraitFields(['appearance:', 'canonical:   ', '沉稳']);
    expect(r.hadLegacyEntries).toBe(true);
    expect(r.legacyAppearance).toBeUndefined();
    expect(r.legacyCanonicalName).toBeUndefined();
    expect(r.cleanTraits).toEqual(['沉稳']);
  });

  it('对前缀值做 trim', () => {
    const r = splitLegacyTraitFields(['appearance:  tall, scar on left eye  ']);
    expect(r.legacyAppearance).toBe('tall, scar on left eye');
  });

  it('非前缀字符串原样保留', () => {
    const r = splitLegacyTraitFields(['勇敢', 'appearance', 'apperance:typo', ' my appearance:not-prefixed']);
    expect(r.hadLegacyEntries).toBe(false);
    expect(r.cleanTraits).toEqual(['勇敢', 'appearance', 'apperance:typo', ' my appearance:not-prefixed']);
  });

  it('非字符串条目原样保留', () => {
    const r = splitLegacyTraitFields(['勇敢', 42, { note: 'x' }, 'appearance:ok']);
    expect(r.hadLegacyEntries).toBe(true);
    expect(r.legacyAppearance).toBe('ok');
    // 非字符串条目不被破坏
    expect(r.cleanTraits).toEqual(['勇敢', 42, { note: 'x' }]);
  });

  it('非数组输入安全降级为空结果', () => {
    for (const input of [undefined, null, 'appearance:x', 123, { 0: 'a' }]) {
      const r = splitLegacyTraitFields(input);
      expect(r.hadLegacyEntries).toBe(false);
      expect(r.cleanTraits).toEqual([]);
    }
  });

  it('幂等：清洗结果再次输入，不发生任何变化', () => {
    const first = splitLegacyTraitFields(['勇敢', 'appearance:x', 'canonical:y', 'fandom:z']);
    const second = splitLegacyTraitFields(first.cleanTraits);
    expect(second.hadLegacyEntries).toBe(false);
    expect(second.cleanTraits).toEqual(first.cleanTraits);
  });

  it('前缀常量与文档保持一致', () => {
    expect(LEGACY_TRAIT_PREFIXES).toEqual({
      appearance: 'appearance:',
      canonical: 'canonical:',
      fandom: 'fandom:',
    });
  });
});

describe('resolveCharacterFields', () => {
  it('结构化字段齐全时优先返回结构化字段（不依赖 traits）', () => {
    const r = resolveCharacterFields({
      appearance: 'silver hair, blue cloak',
      canonicalName: 'Arthas',
      traits: ['appearance:legacy look', 'canonical:LegacyName', '勇敢'],
    });
    expect(r.appearance).toBe('silver hair, blue cloak');
    expect(r.canonicalName).toBe('Arthas');
  });

  it('结构化字段为空时回退解析旧前缀', () => {
    const r = resolveCharacterFields({
      appearance: '',
      canonicalName: null,
      traits: ['appearance:legacy look', 'canonical:LegacyName'],
    });
    expect(r.appearance).toBe('legacy look');
    expect(r.canonicalName).toBe('LegacyName');
  });

  it('结构化与旧前缀混用时逐字段回退', () => {
    const r = resolveCharacterFields({
      appearance: 'new look',
      canonicalName: '',
      traits: ['appearance:old look', 'canonical:FromTraits'],
    });
    expect(r.appearance).toBe('new look');
    expect(r.canonicalName).toBe('FromTraits');
  });

  it('全部缺失时返回空字符串', () => {
    const r = resolveCharacterFields({ traits: ['勇敢'] });
    expect(r.appearance).toBe('');
    expect(r.canonicalName).toBe('');
  });

  it('对结构化字段做 trim，纯空白视为缺失', () => {
    const r = resolveCharacterFields({
      appearance: '   ',
      canonicalName: '  ',
      traits: ['appearance:from legacy'],
    });
    expect(r.appearance).toBe('from legacy');
    expect(r.canonicalName).toBe('');
  });
});
