/**
 * 生图提取管线「enPrompt 有效性守卫」构造性测试
 *
 * 背景：提取 LLM 偶发采样退化（enPrompt 缺失 / 近空 / 混入中文）时，旧逻辑会把
 * "A wide cinematic scene depicting:." 这类近空 prompt 直送生图 API（玄武门轮 B1）。
 * 守卫在提取 LLM 与生图 API 之间设质检关卡：逐条校验 → 整组强化重试 → 按
 * description 兜底重写 → 全坏回退启发式；装配末端还有「守卫终检」兜底。
 *
 * 覆盖范围：
 *  - isValidEnPrompt：近空 / 纯中文 / 长度与词数边界 / 少量中文混入
 *  - extractSceneDescriptionsWithAI 守卫链：正常路径零额外调用、空 enPrompt 触发
 *    重试、重试后仍缺走重写、description 也没有则弃用、全坏回退启发式（含
 *    解析失败与调用异常），断言"校验→重试→重写→启发式"走完整条链
 *  - generateImagesForSegment 守卫终检：mock 生图 API（全局 fetch），断言任何
 *    低于长度阈值的 prompt 都不会被送进生图 API
 *
 * 运行：npx vitest run tests/image-generator-guard.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  extractSceneDescriptionsWithAI,
  generateImagesForSegment,
  isValidEnPrompt,
  MIN_VALID_ENPROMPT_CHARS,
  MIN_VALID_ENPROMPT_WORDS,
} from '@/lib/image-generator';

// 生图缓存写盘用 mock 拦截：测试不落任何文件
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    writeFile: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined),
  };
});

// ─── 测试素材 ─────────────────────────────────────────────────────────

/** 满足有效性判据的英文 enPrompt（主体/动作/环境/光线/景别/氛围齐全） */
const EN_VALID =
  'Wide cinematic shot of armored cavalry charging through the palace gate at dawn, dust swirling under hooves, war banners snapping in the cold wind, dramatic golden backlight, tense and chaotic atmosphere, highly detailed cinematic composition';
const EN_VALID_2 =
  'Close-up of a young prince drawing a longbow from the watchtower, arrows glinting in the morning light, shallow depth of field, focused expression, dramatic rim lighting, richly detailed historical armor';
/** 兜底重写通道的成功产物 */
const EN_REWRITE =
  'Medium shot of a prince on horseback outside a massive palace gate at dawn, cold blue morning light, distant banners and drifting dust, tense atmosphere, historical costume drama cinematography, wide angle with deep perspective, richly detailed composition';
/** 玄武门 B1 实测的近空退化串 */
const NEAR_EMPTY = 'A wide cinematic scene depicting: .';

/** 中文段落（启发式回退通道的输入；含 3 个可成镜头的句子） */
const SEGMENT =
  '武德九年六月，秦王李世民率兵入宫。玄武门外刀光四起，李建成骑马而来。尉迟恭张弓搭箭，晨光中杀声震天。';

const REWRITE_MARKER = '把下面这条中文镜头描述改写';
const RETRY_MARKER = '系统校验未通过';
const TRANSLATE_MARKER = 'Translate the Chinese scene descriptions below';

// ─── 全局：静音日志 + 清理 ────────────────────────────────────────────

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ─── 判据单元 ─────────────────────────────────────────────────────────

describe('isValidEnPrompt（逐条有效性判据）', () => {
  it('近空退化串（玄武门 B1 案例）→ 无效', () => {
    expect(isValidEnPrompt(NEAR_EMPTY)).toBe(false);
    expect(isValidEnPrompt('')).toBe(false);
    expect(isValidEnPrompt('   ')).toBe(false);
  });

  it('纯中文 / 中文为主（CJK 会被剥离）→ 无效', () => {
    expect(isValidEnPrompt('秦王李世民率兵入宫，玄武门外刀光四起')).toBe(false);
  });

  it('足量英文 → 有效', () => {
    expect(isValidEnPrompt(EN_VALID)).toBe(true);
    expect(isValidEnPrompt(EN_VALID_2)).toBe(true);
  });

  it('少量中文混入但剥离后英文仍足量 → 有效', () => {
    expect(isValidEnPrompt(`${EN_VALID} 玄武门 `)).toBe(true);
  });

  it('边界：词数够但总长不足 → 无效', () => {
    const manyShortWords = Array.from({ length: MIN_VALID_ENPROMPT_WORDS + 2 }, () => 'a').join(' ');
    expect(manyShortWords.split(' ').length).toBeGreaterThanOrEqual(MIN_VALID_ENPROMPT_WORDS);
    expect(manyShortWords.length).toBeLessThan(MIN_VALID_ENPROMPT_CHARS);
    expect(isValidEnPrompt(manyShortWords)).toBe(false);
  });

  it('边界：总长够但没有足够"字母词" → 无效', () => {
    const oneLongWord = 'x'.repeat(MIN_VALID_ENPROMPT_CHARS + 10);
    expect(isValidEnPrompt(oneLongWord)).toBe(false);
  });

  it('非字符串输入 → 无效', () => {
    expect(isValidEnPrompt(null)).toBe(false);
    expect(isValidEnPrompt(undefined)).toBe(false);
    expect(isValidEnPrompt(42)).toBe(false);
    expect(isValidEnPrompt({ enPrompt: EN_VALID })).toBe(false);
  });
});

// ─── 提取守卫链 ───────────────────────────────────────────────────────

describe('extractSceneDescriptionsWithAI 守卫链（校验→重试→重写→启发式）', () => {
  it('正常路径：首次提取全部有效 → 恰好 1 次调用，零重试零重写', async () => {
    const fn = vi.fn(async (_p: string) =>
      JSON.stringify([
        { description: '李世民率兵入宫', enPrompt: EN_VALID, type: 'scene', characters: ['李世民'] },
        { description: '李建成纵马而来', enPrompt: EN_VALID_2, type: 'character', characters: ['李建成'] },
      ]),
    );

    const scenes = await extractSceneDescriptionsWithAI(SEGMENT, fn);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(scenes).toHaveLength(2);
    expect(scenes.every(s => isValidEnPrompt(s.prompt))).toBe(true);
    expect(scenes[0].prompt).toBe(EN_VALID);
    expect(scenes[0].characterNames).toEqual(['李世民']);
    expect(scenes[1].characterNames).toEqual(['李建成']);
  });

  it('空 enPrompt + 有 description：整组强化重试仍坏 → 按 description 兜底重写（重试→重写）', async () => {
    const bad = JSON.stringify([
      { description: '李世民率兵入宫', enPrompt: '', type: 'scene', characters: [] },
    ]);
    const fn = vi.fn(async (p: string) => {
      if (p.includes(REWRITE_MARKER)) return EN_REWRITE; // 兜底重写调用
      return bad; // 提取与强化重试都退化
    });

    const scenes = await extractSceneDescriptionsWithAI(SEGMENT, fn);

    expect(fn).toHaveBeenCalledTimes(3);
    const calls = fn.mock.calls.map(c => c[0] as string);
    expect(calls[0]).not.toContain(RETRY_MARKER);
    expect(calls[1]).toContain(RETRY_MARKER); // 第 2 次是强化指令整组重试
    expect(calls[2]).toContain(REWRITE_MARKER); // 第 3 次是兜底重写
    expect(calls[2]).toContain('李世民率兵入宫'); // 重写素材来自 description
    expect(scenes).toHaveLength(1);
    expect(scenes[0].prompt).toBe(EN_REWRITE);
    expect(scenes[0].description).toBe('李世民率兵入宫');
  });

  it('enPrompt / description 皆空：重试 →（无法重写）→ 全坏回退启发式；不再发重写调用', async () => {
    const bad = JSON.stringify([
      { description: '', enPrompt: NEAR_EMPTY, type: 'scene', characters: [] },
    ]);
    const fn = vi.fn(async (_p: string) => bad);

    const scenes = await extractSceneDescriptionsWithAI(SEGMENT, fn);

    // 提取 + 强化重试恰好 2 次（失败路径最多多 1 次调用）；无重写调用
    expect(fn).toHaveBeenCalledTimes(2);
    const calls = fn.mock.calls.map(c => c[0] as string);
    expect(calls[1]).toContain(RETRY_MARKER);
    expect(calls.every(c => !c.includes(REWRITE_MARKER))).toBe(true);
    // 启发式结果（中文，后续由 generateImagesForSegment 的翻译通道英文化）
    expect(scenes.length).toBeGreaterThan(0);
    expect(scenes.some(s => /[一-鿿]/.test(s.prompt))).toBe(true);
  });

  it('兜底重写结果仍不合格 → 弃用该镜头 → 回退启发式（重试→重写→启发式 全链）', async () => {
    const bad = JSON.stringify([
      { description: '李世民率兵入宫', enPrompt: '', type: 'scene', characters: [] },
    ]);
    const fn = vi.fn(async (p: string) => {
      if (p.includes(REWRITE_MARKER)) return 'too short'; // 重写结果低于阈值 → 弃用
      return bad;
    });

    const scenes = await extractSceneDescriptionsWithAI(SEGMENT, fn);

    expect(fn).toHaveBeenCalledTimes(3); // 提取 + 重试 + 重写（失败）
    expect(scenes.some(s => /[一-鿿]/.test(s.prompt))).toBe(true); // 兜底到启发式
  });

  it('解析失败（非 JSON 返回）：强化重试一次仍失败 → 回退启发式', async () => {
    const fn = vi.fn(async (_p: string) => '抱歉，我暂时无法完成该任务。');

    const scenes = await extractSceneDescriptionsWithAI(SEGMENT, fn);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(scenes.length).toBeGreaterThan(0);
    expect(scenes.some(s => /[一-鿿]/.test(s.prompt))).toBe(true);
  });

  it('首次提取调用异常：同样触发守卫重试，第二次成功即采用', async () => {
    let call = 0;
    const fn = vi.fn(async (_p: string): Promise<string> => {
      call++;
      if (call === 1) throw new Error('fetch failed');
      return JSON.stringify([
        { description: '李世民率兵入宫', enPrompt: EN_VALID, type: 'scene', characters: [] },
      ]);
    });

    const scenes = await extractSceneDescriptionsWithAI(SEGMENT, fn);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(scenes).toHaveLength(1);
    expect(scenes[0].prompt).toBe(EN_VALID);
  });

  it('两次调用均异常 → 回退启发式（最多多 1 次调用，不无限重试）', async () => {
    const fn = vi.fn(async (_p: string): Promise<string> => {
      throw new Error('upstream down');
    });

    const scenes = await extractSceneDescriptionsWithAI(SEGMENT, fn);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(scenes.length).toBeGreaterThan(0);
  });

  it('部分无效（非全坏）：不整组重试，只对缺条走 description 重写', async () => {
    const payload = JSON.stringify([
      { description: '李世民率兵入宫', enPrompt: EN_VALID, type: 'scene', characters: [] },
      { description: '李建成纵马而来', enPrompt: '', type: 'character', characters: [] },
    ]);
    const fn = vi.fn(async (p: string) => {
      if (p.includes(REWRITE_MARKER)) return EN_VALID_2;
      return payload;
    });

    const scenes = await extractSceneDescriptionsWithAI(SEGMENT, fn);

    expect(fn).toHaveBeenCalledTimes(2);
    const calls = fn.mock.calls.map(c => c[0] as string);
    expect(calls[1]).toContain(REWRITE_MARKER); // 第 2 次直接是重写，不是整组重试
    expect(calls[1]).not.toContain(RETRY_MARKER);
    expect(scenes).toHaveLength(2);
    expect(scenes[0].prompt).toBe(EN_VALID);
    expect(scenes[1].prompt).toBe(EN_VALID_2);
  });

  it('重试后部分恢复：有效条目采用，仍缺的镜头按 description 重写（"重试后还缺的镜头"）', async () => {
    const badAll = JSON.stringify([
      { description: '李世民率兵入宫', enPrompt: '', type: 'scene', characters: [] },
      { description: '李建成纵马而来', enPrompt: '', type: 'character', characters: [] },
    ]);
    const retryPartial = JSON.stringify([
      { description: '李世民率兵入宫', enPrompt: EN_VALID, type: 'scene', characters: [] },
      { description: '李建成纵马而来', enPrompt: '', type: 'character', characters: [] },
    ]);
    const fn = vi.fn(async (p: string) => {
      if (p.includes(REWRITE_MARKER)) return EN_VALID_2;
      if (p.includes(RETRY_MARKER)) return retryPartial;
      return badAll;
    });

    const scenes = await extractSceneDescriptionsWithAI(SEGMENT, fn);

    expect(fn).toHaveBeenCalledTimes(3); // 提取 + 重试 + 补缺重写
    expect(scenes).toHaveLength(2);
    expect(scenes[0].prompt).toBe(EN_VALID);
    expect(scenes[1].prompt).toBe(EN_VALID_2);
  });

  it('enPrompt 有效但 description 为空：仍保留该镜头（description 仅作兜底重写素材）', async () => {
    const fn = vi.fn(async (_p: string) =>
      JSON.stringify([{ description: '', enPrompt: EN_VALID, type: 'scene', characters: [] }]),
    );

    const scenes = await extractSceneDescriptionsWithAI(SEGMENT, fn);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(scenes).toHaveLength(1);
    expect(scenes[0].prompt).toBe(EN_VALID);
    expect(scenes[0].description).toBe(EN_VALID.slice(0, 40)); // 展示用回退
  });
});

// ─── 生成端守卫终检（生图 API 边界） ──────────────────────────────────

describe('generateImagesForSegment 守卫终检（低于阈值的 prompt 绝不进入生图 API）', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.AI_IMAGE_API_KEY = 'test-key';
    process.env.AI_IMAGE_MODEL = 'cogview-4';
    process.env.AI_IMAGE_BASE_URL = 'https://img.example.test/v1';

    fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ b64_json: Buffer.from('fake-image').toString('base64') }] }),
    }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    delete process.env.AI_IMAGE_API_KEY;
    delete process.env.AI_IMAGE_MODEL;
    delete process.env.AI_IMAGE_BASE_URL;
  });

  /** 从 fetch 调用记录中提取所有送进生图 API 的 prompt */
  const imagePrompts = (): string[] =>
    fetchMock.mock.calls
      .filter(c => String(c[0]).endsWith('/images/generations'))
      .map(c => JSON.parse(String((c[1] as RequestInit | undefined)?.body)).prompt as string);

  it('提取全退化（空 description / 近空 enPrompt）：走 重试→启发式→翻译 后正常出图，API prompt 无退化片段', async () => {
    const degraded = JSON.stringify([
      { description: '', enPrompt: NEAR_EMPTY, type: 'scene', characters: [] },
    ]);
    const fn = vi.fn(async (p: string) => {
      if (p.includes(TRANSLATE_MARKER)) {
        const n = (p.match(/\[\d+\]/g) || []).length || 1;
        return JSON.stringify(
          Array.from(
            { length: n },
            (_, i) =>
              `CINEMATIC_EN_SCENE_${i}: a dramatic dawn raid at a palace gate, armored horsemen charging through swirling dust, cold morning light, wide establishing shot, tense chaotic atmosphere, highly detailed cinematic composition`,
          ),
        );
      }
      return degraded; // 提取 + 强化重试全退化
    });

    const images = await generateImagesForSegment({
      segmentId: 'guard_seg_a',
      segmentContent: SEGMENT,
      maxImages: 2,
      callAIFn: fn,
    });

    expect(images.length).toBeGreaterThan(0);

    const prompts = imagePrompts();
    expect(prompts.length).toBe(images.length); // 每个成功镜头恰好一次生图调用
    for (const p of prompts) {
      expect(p).toContain('CINEMATIC_EN_SCENE_'); // 送出去的是翻译后的完整场景
      expect(p).not.toContain('depicting:'); // 不是近空退化串
      expect(/[一-鿿]/.test(p)).toBe(false); // enforceNoTextInPrompt 后无 CJK
    }

    // 文本调用：提取 + 强化重试 + 翻译，恰好 3 次；description 也没了 → 无重写调用
    expect(fn).toHaveBeenCalledTimes(3);
    expect(fn.mock.calls.every(c => !String(c[0]).includes(REWRITE_MARKER))).toBe(true);
  });

  it('提取退化但 description 存在：重试→重写链条的产物直送生图', async () => {
    const badWithDesc = JSON.stringify([
      { description: '李世民率兵入宫，晨光刀影', enPrompt: '', type: 'scene', characters: [] },
    ]);
    const fn = vi.fn(async (p: string) => {
      if (p.includes(REWRITE_MARKER)) return EN_REWRITE;
      return badWithDesc; // 提取 + 重试都坏
    });

    const images = await generateImagesForSegment({
      segmentId: 'guard_seg_b',
      segmentContent: SEGMENT,
      maxImages: 2,
      callAIFn: fn,
    });

    expect(images).toHaveLength(1);
    const prompts = imagePrompts();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(EN_REWRITE); // 重写产物（≥ 阈值的完整英文场景）
    expect(fn).toHaveBeenCalledTimes(3); // 提取 + 强化重试 + 兜底重写
  });

  it('所有通道均不可用（翻译假成功返回空串）：终检拦截，零生图 API 调用', async () => {
    const degraded = JSON.stringify([
      { description: '', enPrompt: NEAR_EMPTY, type: 'scene', characters: [] },
    ]);
    const fn = vi.fn(async (p: string) => {
      if (p.includes(TRANSLATE_MARKER)) {
        const n = (p.match(/\[\d+\]/g) || []).length || 1;
        return JSON.stringify(Array.from({ length: n }, () => '')); // 假成功：内容是空串
      }
      return degraded;
    });

    const images = await generateImagesForSegment({
      segmentId: 'guard_seg_c',
      segmentContent: SEGMENT,
      maxImages: 2,
      callAIFn: fn,
      // 不提供 sceneStateEn / genre / storyDescription → 英文兜底脚手架文本量不足
    });

    // 宁缺毋滥：全部镜头未通过终检 → 本段不生成图片，且一次生图 API 都没调用
    expect(images).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fn).toHaveBeenCalledTimes(3); // 提取 + 重试 + 翻译（无重写）
  });

  it('启发式翻译全失败但有 sceneStateEn：英文兜底脚手架仍高出阈值 → 正常出图', async () => {
    const degraded = JSON.stringify([
      { description: '', enPrompt: NEAR_EMPTY, type: 'scene', characters: [] },
    ]);
    const fn = vi.fn(async (p: string) => {
      if (p.includes(TRANSLATE_MARKER)) throw new Error('translate down');
      return degraded;
    });

    const images = await generateImagesForSegment({
      segmentId: 'guard_seg_d',
      segmentContent: SEGMENT,
      maxImages: 1,
      callAIFn: fn,
      sceneStateEn: 'dusk, heavy rain, tense mood, palace courtyard under torchlight',
    });

    expect(images).toHaveLength(1);
    const prompts = imagePrompts();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('environment: dusk, heavy rain, tense mood'); // 脚手架环境行
    expect(prompts[0]).not.toContain('depicting:');
  });

  it('presetScenes 复现通道不受终检过滤（保持对照实验可比性）', async () => {
    // 模拟"优化前"实验注入的镜头：旧管线产物即便退化也原样复现（含近空 prompt）
    const images = await generateImagesForSegment({
      segmentId: 'guard_seg_e',
      segmentContent: SEGMENT,
      maxImages: 1,
      presetScenes: [
        { prompt: NEAR_EMPTY, description: '旧管线退化镜头', type: 'scene' },
      ],
    });

    expect(images).toHaveLength(1); // 未被终检拦截，照常送 API（复现旧行为）
    const prompts = imagePrompts();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('depicting:'); // 退化产物逐字复现
  });
});
