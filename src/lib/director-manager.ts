/**
 * 5.7 DirectorState 持久化 + 滚动场景状态（Scene State）
 */

import prisma from '@/lib/prisma';
import { getOrderedChain } from '@/lib/chain-helpers';
import { sampleSegmentText } from './text-window';

/** 滚动场景状态：描述故事当前的"视觉世界快照"，每段增量更新 */
export interface SceneState {
  /** 当前所在地点（中文简短，如 "忍者学校教室"） */
  location?: string;
  /** 时间段（day / dusk / night / dawn） */
  timeOfDay?: string;
  /** 天气（sunny / rainy / snowy / stormy / clear / foggy） */
  weather?: string;
  /** 季节（spring / summer / autumn / winter） */
  season?: string;
  /** 当前在场角色（中文名列表） */
  presentCharacters?: string[];
  /** 氛围（tense / peaceful / somber / joyful / ominous / ...） */
  mood?: string;
  /** 服装/外形备注（如 "带土佩戴新的护目镜，红色" —— 跨段保持一致） */
  clothingNotes?: string;
  /** 更新时间戳 */
  updatedAt?: string;
  /** C1: 该状态由哪个段落更新而来（新鲜度标记；生图端据此等待追平，写入时勿遗漏） */
  lastSegmentId?: string;
}

/**
 * C1: 判断场景状态对目标段落是否足够新鲜（生图端"等待追平"的判据）。
 * - fresh: 状态由目标段或更靠后的段落更新而来（可直接使用）
 * - stale: 状态落后于目标段（应等待写入追平）
 * - unknown: 缺标记 / 任一段不在链中（无法比较，按需等待或直接使用）
 */
export function isSceneStateFreshFor(
  lastSegmentId: string | undefined,
  targetSegmentId: string,
  orderedChain: { id: string }[],
): 'fresh' | 'stale' | 'unknown' {
  if (!lastSegmentId) return 'unknown';
  if (lastSegmentId === targetSegmentId) return 'fresh';
  const targetIdx = orderedChain.findIndex(s => s.id === targetSegmentId);
  const stateIdx = orderedChain.findIndex(s => s.id === lastSegmentId);
  if (targetIdx < 0 || stateIdx < 0) return 'unknown';
  return stateIdx >= targetIdx ? 'fresh' : 'stale';
}

export class DirectorManager {
  /**
   * 获取故事的导演状态
   */
  async getState(storyId: string) {
    return prisma.directorState.findUnique({ where: { storyId } });
  }

  /**
   * 获取或创建导演状态
   */
  async getOrCreate(storyId: string) {
    const existing = await this.getState(storyId);
    if (existing) return existing;

    return prisma.directorState.create({
      data: {
        id: `dir_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        storyId,
        characterStates: {},
        worldVariables: {},
        activeConstraints: [],
      },
    });
  }

  /**
   * 更新导演状态
   */
  async updateState(storyId: string, updates: any) {
    const existing = await prisma.directorState.findUnique({ where: { storyId } });
    if (!existing) return null;

    const data: any = { updatedAt: new Date() };
    if (updates.characterStates) {
      data.characterStates = { ...(existing.characterStates as any), ...updates.characterStates };
    }
    if (updates.worldVariables) {
      data.worldVariables = { ...(existing.worldVariables as any), ...updates.worldVariables };
    }
    if (updates.activeConstraints) {
      data.activeConstraints = updates.activeConstraints;
    }

    return prisma.directorState.update({
      where: { storyId },
      data,
    });
  }

  /**
   * 读取滚动场景状态（存在 worldVariables.scene_state 里）
   */
  async getSceneState(storyId: string): Promise<SceneState | null> {
    const state = await this.getState(storyId);
    if (!state) return null;
    const wv = (state.worldVariables as any) || {};
    const s = wv.scene_state as SceneState | undefined;
    return s || null;
  }

  /**
   * 用 AI 从最新段落增量更新滚动场景状态（location / time / weather / 在场角色 / 氛围 / 服装）
   */
  async updateSceneState(
    storyId: string,
    segmentContent: string,
    callAIFn: (prompt: string) => Promise<string>,
    segmentId?: string,
  ): Promise<SceneState | null> {
    const existing = await this.getOrCreate(storyId);
    const wv = (existing.worldVariables as any) || {};
    const prev: SceneState = (wv.scene_state as SceneState) || {};

    const prevJson = JSON.stringify(prev, null, 2);
    // 长段落头+尾采样（C4-②）：只截头部会丢掉段尾的关键场景变化（换地点/入夜等），
    // 场景状态滞后于正文 → 生图环境与正文不符
    const contentForState = sampleSegmentText(segmentContent, 2000);
    const prompt = `你是故事世界的场景记录员。根据"上一场景状态"和"最新段落内容"，增量更新场景状态。

上一场景状态（JSON）：
${prevJson}

最新段落：
${contentForState}

请输出严格 JSON（不要 markdown），字段：
{
  "location": "当前所在地点（中文简短）",
  "timeOfDay": "day|dusk|night|dawn",
  "weather": "sunny|rainy|snowy|stormy|clear|foggy",
  "season": "spring|summer|autumn|winter",
  "presentCharacters": ["在场角色中文名"],
  "mood": "tense|peaceful|somber|joyful|ominous|...",
  "clothingNotes": "本段出现的服装/外形变化备注（无则空串）"
}

规则：
- 如果本段未提到某字段，保留上一状态的值（不要凭空修改）。
- presentCharacters 只保留本段明确出现在当前场景中的角色。
- clothingNotes 重要变化（如带新面具、换装、受伤）必须记录，跨段保持一致。
- 只输出 JSON，不要解释。`;

    let next: SceneState = { ...prev };
    try {
      const raw = await callAIFn(prompt);
      const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/```$/g, '').trim();
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) {
        const parsed = JSON.parse(m[0]);
        next = {
          location: parsed.location || prev.location,
          timeOfDay: parsed.timeOfDay || prev.timeOfDay,
          weather: parsed.weather || prev.weather,
          season: parsed.season || prev.season,
          presentCharacters: Array.isArray(parsed.presentCharacters) ? parsed.presentCharacters : prev.presentCharacters,
          mood: parsed.mood || prev.mood,
          clothingNotes: parsed.clothingNotes || prev.clothingNotes,
          updatedAt: new Date().toISOString(),
        };
      }
    } catch (e) {
      console.warn('[director] updateSceneState AI 解析失败（降级保留上一状态）:', e);
    }

    // C1: 无论成功还是降级，都推进 lastSegmentId（语义："本段已处理"）。
    // 失败若不推进标记，生图端 waitForSceneStateFresh 会等满超时也等不到追平。
    next = {
      ...next,
      updatedAt: new Date().toISOString(),
      lastSegmentId: segmentId || prev.lastSegmentId,
    };

    await prisma.directorState.update({
      where: { storyId },
      data: {
        worldVariables: { ...wv, scene_state: next },
        updatedAt: new Date(),
      },
    });
    return next;
  }

  /**
   * C1: 等待场景状态追平到 forSegmentId（或更新的段落），供生图端读取前调用。
   * - 仅当 forSegmentId 是分支末段（最新）时才等待：为历史段落生图时状态必然
   *   已更新到更后面，不存在竞态；
   * - 非竞态时零额外延迟；落后时按 intervalMs 轮询，超过 timeoutMs 降级返回；
   * - 轮询是数据库只读，多实例部署安全（不依赖进程内内存）。
   */
  async waitForSceneStateFresh(
    storyId: string,
    branchId: string,
    forSegmentId: string,
    options: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<SceneState | null> {
    const { timeoutMs = 12000, intervalMs = 1500 } = options;
    try {
      const chain = await getOrderedChain(storyId, branchId);
      const targetIdx = chain.findIndex(s => s.id === forSegmentId);
      if (targetIdx < 0 || targetIdx !== chain.length - 1) {
        // 历史段落 / 未知段落：不等待
        return this.getSceneState(storyId);
      }

      const deadline = Date.now() + timeoutMs;
      let state = await this.getSceneState(storyId);
      while (true) {
        const verdict = isSceneStateFreshFor(state?.lastSegmentId, forSegmentId, chain);
        if (verdict === 'fresh') return state;
        if (Date.now() >= deadline) break;
        await new Promise(resolve => setTimeout(resolve, intervalMs));
        state = await this.getSceneState(storyId);
      }

      console.warn(
        `[director] 场景状态等待超时（${timeoutMs}ms）未追平段落 ${forSegmentId}，降级使用当前状态`,
      );
      return state;
    } catch (e) {
      console.warn('[director] waitForSceneStateFresh 失败（降级直接读取）:', e);
      return this.getSceneState(storyId).catch(() => null);
    }
  }

  /**
   * 把滚动场景状态格式化成英文描述，注入扩散模型 prompt
   */
  async getSceneStatePromptEnglish(storyId: string): Promise<string> {
    const s = await this.getSceneState(storyId);
    if (!s) return '';

    const timeMap: Record<string, string> = {
      day: 'daytime', dusk: 'dusk golden hour', night: 'night', dawn: 'early dawn',
    };
    const weatherMap: Record<string, string> = {
      sunny: 'sunny', rainy: 'rainy', snowy: 'snowy', stormy: 'stormy', clear: 'clear sky', foggy: 'foggy',
    };
    const seasonMap: Record<string, string> = {
      spring: 'spring', summer: 'summer', autumn: 'autumn', winter: 'winter',
    };

    const parts: string[] = [];
    if (s.location) parts.push(`setting: ${s.location}`);
    if (s.timeOfDay) parts.push(timeMap[s.timeOfDay] || s.timeOfDay);
    if (s.weather) parts.push(weatherMap[s.weather] || s.weather);
    if (s.season) parts.push(seasonMap[s.season] || s.season);
    if (s.mood) parts.push(`${s.mood} mood`);
    if (s.presentCharacters && s.presentCharacters.length > 0) {
      parts.push(`present characters: ${s.presentCharacters.join(', ')}`);
    }
    if (s.clothingNotes) parts.push(`clothing/appearance: ${s.clothingNotes}`);

    return parts.join('; ');
  }

  /**
   * 构建导演覆盖 prompt 片段
   */
  async buildDirectorPrompt(storyId: string): Promise<string> {
    const state = await this.getState(storyId);
    if (!state) return '';

    const parts: string[] = [];
    const charStates = state.characterStates as Record<string, string> || {};

    if (Object.keys(charStates).length > 0) {
      parts.push('【导演指定角色状态】');
      for (const [charId, charState] of Object.entries(charStates)) {
        parts.push(`- 角色 ${charId}：${charState}`);
      }
    }

    const worldVars = state.worldVariables as Record<string, string> || {};
    const filteredWorldVars = Object.fromEntries(
      Object.entries(worldVars).filter(([key]) =>
        // 跳过内部管理用的 key（状态表/场景状态等），避免泄漏进导演 Prompt
        !key.startsWith('narrative_states_') && key !== 'scene_state'
      )
    );
    if (Object.keys(filteredWorldVars).length > 0) {
      parts.push('【导演指定世界变量】');
      for (const [key, value] of Object.entries(filteredWorldVars)) {
        parts.push(`- ${key}：${value}`);
      }
    }

    const constraints = state.activeConstraints as string[] || [];
    if (constraints.length > 0) {
      parts.push('【创作约束】');
      for (const constraint of constraints) {
        parts.push(`- ${constraint}`);
      }
    }

    return parts.join('\n');
  }
}

export const directorManager = new DirectorManager();
