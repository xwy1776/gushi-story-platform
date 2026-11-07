/**
 * C3: 生图角色外观锚点模板单元测试
 *
 * 覆盖 image-prompt-template.ts：
 *  - normalizeAppearance：确定性归一化（空白 / 分隔符 / 截断）
 *  - buildCharacterAnchors：冻结锚点 —— 输入顺序无关、跨"段落"逐字一致、去重
 *  - resolveSceneAnchorLines：按名字命中 + 文本回退
 *  - composeConsistentScenePrompt：固定拼装顺序（场景在前、锚点块在后）
 *  - translateAnchorsToEnglish：批量翻译 + 进程内缓存 + 失败降级
 *
 * 运行：npx vitest run tests/image-prompt-template.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  APPEARANCE_MAX_LENGTH,
  CHARACTER_ANCHOR_DISTINCT_NOTE,
  CHARACTER_ANCHOR_HEADER,
  buildAnchorIndex,
  buildCharacterAnchors,
  clearAnchorTranslationCache,
  composeConsistentScenePrompt,
  normalizeAppearance,
  resolveSceneAnchorLines,
  translateAnchorsToEnglish,
} from '@/lib/image-prompt-template';

const JINGKE = {
  name: '荆轲',
  canonicalName: 'Jing Ke',
  appearance: 'male, ancient chinese assassin robe, dagger, determined eyes',
};
const QINWANG = {
  name: '秦王嬴政',
  canonicalName: 'King Zheng of Qin',
  appearance: 'male, black imperial robe, gold crown, stern face',
};

describe('normalizeAppearance', () => {
  it('压缩空白、去逗号前空格、合并连续分隔符', () => {
    expect(normalizeAppearance('  male,   short  black\n hair ,, dark cloak ')).toBe(
      'male, short black hair, dark cloak',
    );
  });

  it('确定性：同一输入多次调用结果完全相同', () => {
    const raw = 'male,  short black hair, dark cloak';
    expect(normalizeAppearance(raw)).toBe(normalizeAppearance(raw));
  });

  it('截断超长输入', () => {
    const raw = 'a'.repeat(APPEARANCE_MAX_LENGTH + 50);
    expect(normalizeAppearance(raw).length).toBe(APPEARANCE_MAX_LENGTH);
  });

  it('非字符串 / 空白输入返回空串', () => {
    expect(normalizeAppearance(null)).toBe('');
    expect(normalizeAppearance(undefined)).toBe('');
    expect(normalizeAppearance(42)).toBe('');
    expect(normalizeAppearance('   ')).toBe('');
  });
});

describe('buildCharacterAnchors', () => {
  it('生成 "规范名: 外观" 冻结行；无规范名时用中文名', () => {
    const anchors = buildCharacterAnchors([
      JINGKE,
      { name: '无名路人', appearance: 'male, plain gray robe' },
    ]);
    const lines = anchors.map(a => a.line);
    expect(lines).toContain(`${JINGKE.canonicalName}: ${JINGKE.appearance}`);
    expect(lines).toContain('无名路人: male, plain gray robe');
  });

  it('输入顺序无关：同一角色集合永远得到同一组锚点行（确定性）', () => {
    const a = buildCharacterAnchors([JINGKE, QINWANG]);
    const b = buildCharacterAnchors([QINWANG, JINGKE]);
    expect(a).toEqual(b);
  });

  it('跨段落稳定：同一角色在不同批次独立构建，锚点行逐字一致', () => {
    // 模拟段落 A / 段落 B 两轮生图各自构建锚点 —— 行内容必须完全相同，
    // 这是"同一角色跨段跨图外观稳定"的根基
    const lineA = buildCharacterAnchors([JINGKE])[0].line;
    const lineB = buildCharacterAnchors([{ ...JINGKE }])[0].line;
    expect(lineA).toBe(lineB);

    const promptA = composeConsistentScenePrompt({ scenePrompt: 'scene A', anchorLines: [lineA] });
    const promptB = composeConsistentScenePrompt({ scenePrompt: 'scene B', anchorLines: [lineB] });
    expect(promptA).toContain(lineA);
    expect(promptB).toContain(lineB);
  });

  it('跳过无外观 / 无名字的条目，不注入空描述', () => {
    const anchors = buildCharacterAnchors([
      { name: '甲', appearance: '' },
      { name: '   ', appearance: 'male, x' },
      JINGKE,
    ]);
    expect(anchors).toHaveLength(1);
    expect(anchors[0].line).toContain(JINGKE.canonicalName);
  });

  it('相同锚点行去重', () => {
    const anchors = buildCharacterAnchors([JINGKE, { ...JINGKE }]);
    expect(anchors).toHaveLength(1);
  });

  it('undefined / 空数组安全返回', () => {
    expect(buildCharacterAnchors(undefined)).toEqual([]);
    expect(buildCharacterAnchors([])).toEqual([]);
  });
});

describe('resolveSceneAnchorLines', () => {
  const index = buildAnchorIndex(buildCharacterAnchors([JINGKE, QINWANG]));
  const jingkeLine = buildCharacterAnchors([JINGKE])[0].line;
  const qinwangLine = buildCharacterAnchors([QINWANG])[0].line;

  it('按中文名精确命中', () => {
    expect(resolveSceneAnchorLines({ characterNames: ['荆轲'] }, index)).toEqual([jingkeLine]);
  });

  it('按规范英文名命中', () => {
    expect(resolveSceneAnchorLines({ characterNames: ['Jing Ke'] }, index)).toEqual([jingkeLine]);
  });

  it('多角色去重并排序输出', () => {
    const lines = resolveSceneAnchorLines({ characterNames: ['荆轲', '秦王嬴政', '荆轲'] }, index);
    expect(lines).toEqual([jingkeLine, qinwangLine].sort());
  });

  it('名单里有未登记名字时不误加其他角色', () => {
    expect(resolveSceneAnchorLines({ characterNames: ['某某甲'] }, index)).toEqual([]);
  });

  it('characterNames 缺失时回退为镜头文本包含匹配', () => {
    const lines = resolveSceneAnchorLines(
      { description: '荆轲握紧匕首，望向殿上的秦王嬴政', prompt: 'Jing Ke facing the king' },
      index,
    );
    expect(lines).toEqual([jingkeLine, qinwangLine].sort());
  });

  it('文本回退忽略单字名字键（防误命中）', () => {
    const single = buildAnchorIndex(buildCharacterAnchors([{ name: '丹', appearance: 'young prince' }]));
    expect(resolveSceneAnchorLines({ description: '太子丹出现了' }, single)).toEqual([]);
  });

  it('空索引 / 空场景返回空数组', () => {
    expect(resolveSceneAnchorLines({ characterNames: ['荆轲'] }, new Map())).toEqual([]);
    expect(resolveSceneAnchorLines(undefined, index)).toEqual([]);
  });
});

describe('composeConsistentScenePrompt', () => {
  it('无锚点时原样返回（trim 后）', () => {
    expect(composeConsistentScenePrompt({ scenePrompt: '  a wide battle scene  ' })).toBe(
      'a wide battle scene',
    );
    expect(composeConsistentScenePrompt({ scenePrompt: 'a scene', anchorLines: ['  '] })).toBe(
      'a scene',
    );
  });

  it('固定顺序：场景描述在前，锚点标题与行在后，行内容逐字保留', () => {
    const line = `${JINGKE.canonicalName}: ${JINGKE.appearance}`;
    const out = composeConsistentScenePrompt({
      scenePrompt: 'wide shot of an assassination attempt in a palace',
      anchorLines: [line],
    });
    expect(out.startsWith('wide shot of an assassination attempt in a palace')).toBe(true);
    expect(out).toContain(CHARACTER_ANCHOR_HEADER);
    expect(out.endsWith(line)).toBe(true);
  });

  it('多角色（≥2 行）自动附加"角色互不串脸"约束行（C5-②）', () => {
    const out = composeConsistentScenePrompt({
      scenePrompt: 'two warriors facing each other',
      anchorLines: ['Jing Ke: male, lean', 'King Zheng of Qin: male, imposing'],
    });
    expect(out).toContain(CHARACTER_ANCHOR_HEADER);
    expect(out).toContain(CHARACTER_ANCHOR_DISTINCT_NOTE);
    expect(out.endsWith('King Zheng of Qin: male, imposing')).toBe(true);
  });

  it('单角色不附加互异约束行（保持既有 prompt 结构）', () => {
    const out = composeConsistentScenePrompt({ scenePrompt: 'a scene', anchorLines: ['Jing Ke: male'] });
    expect(out).not.toContain(CHARACTER_ANCHOR_DISTINCT_NOTE);
  });
});

describe('translateAnchorsToEnglish', () => {
  beforeEach(() => {
    clearAnchorTranslationCache();
  });

  it('全英文输入不产生 AI 调用', async () => {
    const fn = vi.fn(async () => '[]');
    const out = await translateAnchorsToEnglish(['Jing Ke: male, assassin robe'], fn);
    expect(out).toEqual(['Jing Ke: male, assassin robe']);
    expect(fn).not.toHaveBeenCalled();
  });

  it('中文外观批量翻译一次，并按原文缓存 —— 跨段落译文逐字稳定', async () => {
    const translated = 'Jing Ke: male, ancient chinese assassin robe, dagger';
    const fn = vi.fn(async () => JSON.stringify([translated]));

    // 段落 A 的生图批次
    const first = await translateAnchorsToEnglish(['荆轲: 男性，古代刺客长袍，匕首'], fn);
    expect(first).toEqual([translated]);
    expect(fn).toHaveBeenCalledTimes(1);

    // 段落 B 的生图批次（同一角色）—— 命中缓存，不再调用 AI，译文完全一致
    const second = await translateAnchorsToEnglish(['荆轲: 男性，古代刺客长袍，匕首'], fn);
    expect(second).toEqual([translated]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('翻译失败时保留原文且不缓存（下次仍会重试）', async () => {
    const fn = vi.fn(async () => '抱歉，我无法翻译');
    const out = await translateAnchorsToEnglish(['荆轲: 男性'], fn);
    expect(out).toEqual(['荆轲: 男性']);

    await translateAnchorsToEnglish(['荆轲: 男性'], fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('未提供 AI 函数时原样返回', async () => {
    const out = await translateAnchorsToEnglish(['荆轲: 男性'], undefined);
    expect(out).toEqual(['荆轲: 男性']);
  });
});
