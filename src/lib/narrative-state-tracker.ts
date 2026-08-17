/**
 * Narrative State Tracker（叙事状态追踪器）
 *
 * 对应 SCORE (2025.03) 论文的核心组件"Dynamic State Tracking"。
 *
 * 核心思路：
 * - SCORE 发现：一致性不应该只在出错时才检查，而应该在生成过程中持续追踪
 *   每个"叙事关键对象"的状态变化，形成一张符号化的状态表。
 * - 不是只追角色——追所有对故事一致性有影响的对象：
 *   character / location / faction / item / relationship / event。
 * - 每个对象的状态用 key-value 结构记录（如 { location: "漠北", status: "俘虏" }），
 *   这样查询是精确匹配，避免了纯语义检索的模糊性问题。
 * - 这种"符号化状态表 + 分层摘要混合检索"的做法，
 *   恰恰对应 SCORE 的 Hybrid Retrieval 设计。
 *
 * 与现有模块的关系：
 * - character-engine.ts：追角色的"自然语言状态描述"，NST 追的是"符号化属性"
 * - director-manager.ts：追 scene-level 状态（地点/天气/氛围），NST 追 object-level 状态
 * - consistency-checker.ts：硬规则检测基于正则匹配，NST 提供符号化查表替代方案
 * - timeline-engine.ts：追时间单调性，NST 追"时间→对象状态"的映射
 *
 * 使用方式：
 *   每写完一个段落 → LLM 增量更新状态表 → 下次续写时把状态表注入 Prompt
 */

import prisma from '@/lib/prisma';
import { callAIText, extractJsonFromAI } from './ai-client';

// ============================================================================
// 类型定义
// ============================================================================

/** 叙事对象类型 */
export type NarrativeObjectType =
  | 'character'    // 角色
  | 'location'     // 地点
  | 'faction'      // 势力/组织
  | 'item'         // 关键物品
  | 'relationship' // 人物关系
  | 'event';       // 关键事件

/** 单个状态属性 */
export type StateProperty = {
  key: string;        // 属性名，如 "location", "isAlive", "mood"
  value: string;       // 属性值，如 "长安", "true", "愤怒"
  updatedAt: string;   // 最后更新该属性的段落ID
};

/** 叙事对象的状态快照 */
export type NarrativeObjectState = {
  id: string;                              // 唯一标识 ns_char_xxx / ns_loc_xxx
  type: NarrativeObjectType;
  name: string;                             // 对象名（中文）
  branchId: string;                         // 所属分支（跨分支隔离！）
  properties: Record<string, string>;       // 当前属性集合 key→value
  history: Array<{                          // 属性变更历史
    segmentId: string;
    changedProperties: Record<string, string>;  // 本次变更的属性
    previousValues: Record<string, string>;     // 变更前的值
  }>;
  lastSeenSegmentId: string;                // 最后一次出现的段落
  createdAt: string;
  updatedAt: string;
};

/** AI 返回的增量更新 */
type StateUpdateFromAI = {
  newObjects: Array<{
    type: NarrativeObjectType;
    name: string;
    properties: Record<string, string>;
  }>;
  updatedObjects: Array<{
    name: string;
    changedProperties: Record<string, string>;
  }>;
  removedObjects: Array<{
    name: string;
    reason: string;
  }>;
};

/** 构建 Prompt 用的状态摘要 */
export type StateTableSummary = {
  totalObjects: number;
  byType: Record<NarrativeObjectType, number>;
  activeObjects: NarrativeObjectState[];     // 最近活跃的对象
  conflictWarnings: string[];               // 潜在冲突预警
};

// ============================================================================
// NarrativeStateTracker 类
// ============================================================================

class NarrativeStateTracker {
  /**
   * 生成唯一 ID
   */
  private genId(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * 获取故事某分支下所有状态对象
   */
  async getAllStates(storyId: string, branchId: string): Promise<NarrativeObjectState[]> {
    // 从 DirectorState.worldVariables.narrative_states 读取
    // 这是持久化方案——挂在现有的 DirectorState 基础设施上
    try {
      const ds = await prisma.directorState.findUnique({ where: { storyId } });
      if (!ds) return [];
      const wv = (ds.worldVariables as Record<string, any>) || {};
      const states = wv[`narrative_states_${branchId}`] as NarrativeObjectState[] | undefined;
      return Array.isArray(states) ? states : [];
    } catch (e) {
      console.warn('[narrative-state-tracker] 读取状态表失败:', e);
      return [];
    }
  }

  /**
   * 持久化状态表
   */
  private async saveStates(storyId: string, branchId: string, states: NarrativeObjectState[]): Promise<void> {
    try {
      const ds = await prisma.directorState.findUnique({ where: { storyId } });
      if (!ds) return;
      const wv = (ds.worldVariables as Record<string, any>) || {};
      wv[`narrative_states_${branchId}`] = states;

      await prisma.directorState.update({
        where: { storyId },
        data: { worldVariables: wv, updatedAt: new Date() },
      });
    } catch (e) {
      console.warn('[narrative-state-tracker] 保存状态表失败:', e);
    }
  }

  /**
   * 测试用：直接覆盖状态表（不依赖 AI 增量更新，保证 A/B 对比可复现）
   */
  async forceSetStates(storyId: string, branchId: string, states: NarrativeObjectState[]): Promise<void> {
    const now = new Date().toISOString();
    const normalized = states.map(s => ({
      ...s,
      history: s.history || [],
      createdAt: s.createdAt || now,
      updatedAt: s.updatedAt || now,
    }));

    // 确保 DirectorState 存在
    let ds = await prisma.directorState.findUnique({ where: { storyId } });
    if (!ds) {
      ds = await prisma.directorState.create({
        data: {
          id: `dir_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          storyId,
          characterStates: {},
          worldVariables: {},
          activeConstraints: [],
        },
      });
    }

    const wv = (ds.worldVariables as Record<string, any>) || {};
    wv[`narrative_states_${branchId}`] = normalized;
    await prisma.directorState.update({
      where: { storyId },
      data: { worldVariables: wv, updatedAt: new Date() },
    });
  }

  // ==========================================================================
  // 核心方法：用 AI 从段落增量更新状态表
  // ==========================================================================

  /**
   * 给定最新段落，让 LLM 增量更新叙事状态表。
   *
   * 思路跟 director-manager.updateSceneState 一致：
   *   "上一状态表 + 最新段落 → AI提取增量变更 → 合并出新状态表"
   *
   * 设计考量：
   * - 增量更新而不是每次全量重建——效率更高、状态延续性好
   * - AI 只负责"提取变更"，合并逻辑在代码里做——可控、可回滚
   */
  async updateFromSegment(
    storyId: string,
    branchId: string,
    segmentId: string,
    segmentContent: string,
  ): Promise<NarrativeObjectState[]> {
    const existing = await this.getAllStates(storyId, branchId);

    // 构建已有状态表的摘要给 AI
    const existingSummary = existing.map(obj => ({
      name: obj.name,
      type: obj.type,
      currentProperties: obj.properties,
    }));

    // AI prompt：从段落提取状态变更
    const prompt = `你是一个故事状态追踪助手。请根据"最新段落内容"，增量更新叙事对象的状态表。

## 已有对象状态表
${JSON.stringify(existingSummary, null, 2)}

## 最新段落内容
${segmentContent.slice(0, 3000)}

## 任务
从段落中提取三类变更，输出严格JSON（不要markdown、不要解释）：
{
  "newObjects": [
    {
      "type": "character|location|faction|item|relationship|event",
      "name": "对象名（中文，如'张骞'、'长安城'、'匈奴骑兵'）",
      "properties": { "属性名": "属性值", ... }
    }
  ],
  "updatedObjects": [
    {
      "name": "已有对象名（必须跟上面的name完全一致）",
      "changedProperties": { "属性名": "新值", ... }
    }
  ],
  "removedObjects": [
    { "name": "已死亡/离开/销毁的对象名", "reason": "简短原因" }
  ]
}

## 属性填写指南
- character: { "isAlive": "true|false", "location": "当前所在地", "status": "身份/状态",
  "mood": "情绪", "faction": "所属势力", "goal": "当前目标" }
- location: { "status": "正常|被毁|被占", "controller": "控制方",
  "population": "人口状态", "description": "当前描述" }
- faction: { "status": "活跃|衰落|覆灭", "leader": "首领", "members": "成员数",
  "territory": "控制区域", "goal": "当前目标" }
- item: { "owner": "持有者", "location": "所在地", "status": "完好|损坏|遗失" }
- relationship: { "between": "关系双方（如'张骞-汉武帝'）", "type": "君臣|父子|盟友|仇敌|...",
  "status": "正常|破裂|紧张", "strength": "0-100" }
- event: { "status": "进行中|已完成|失败", "participants": "参与者名（逗号分隔）",
  "result": "事件结果" }

只返回JSON。`;

    try {
      const raw = await callAIText(prompt, {
        systemPrompt: '你是一个精确的故事状态追踪助手。只输出JSON，不要解释。',
        maxTokens: 2000,
        priority: 'low',
      });

      const update = extractJsonFromAI<StateUpdateFromAI>(raw);
      if (!update) {
        console.warn('[narrative-state-tracker] AI 返回解析失败，返回旧状态');
        return existing;
      }

      // 合并变更
      const nameToExisting = new Map(existing.map(o => [o.name, o]));

      // 1. 处理删除
      if (update.removedObjects) {
        for (const rm of update.removedObjects) {
          const obj = nameToExisting.get(rm.name);
          if (obj) {
            obj.properties['isAlive'] = 'false';
            obj.properties['status'] = rm.reason;
            obj.lastSeenSegmentId = segmentId;
            obj.updatedAt = new Date().toISOString();
          }
        }
      }

      // 2. 处理更新
      if (update.updatedObjects) {
        for (const up of update.updatedObjects) {
          const obj = nameToExisting.get(up.name);
          if (obj && up.changedProperties) {
            const previousValues: Record<string, string> = {};
            for (const [key, newVal] of Object.entries(up.changedProperties)) {
              previousValues[key] = obj.properties[key] || '(空)';
              obj.properties[key] = newVal;
            }
            obj.history.push({
              segmentId,
              changedProperties: up.changedProperties,
              previousValues,
            });
            obj.lastSeenSegmentId = segmentId;
            obj.updatedAt = new Date().toISOString();
          }
        }
      }

      // 3. 处理新增
      if (update.newObjects) {
        for (const no of update.newObjects) {
          if (nameToExisting.has(no.name)) continue; // 跳过重名
          const typePrefix = no.type.slice(0, 4);
          const newObj: NarrativeObjectState = {
            id: this.genId(`ns_${typePrefix}`),
            type: no.type,
            name: no.name,
            branchId,
            properties: no.properties || {},
            history: [{
              segmentId,
              changedProperties: no.properties || {},
              previousValues: {},
            }],
            lastSeenSegmentId: segmentId,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          existing.push(newObj);
        }
      }

      // 持久化
      await this.saveStates(storyId, branchId, existing);
      return existing;

    } catch (e) {
      console.warn('[narrative-state-tracker] 状态更新失败:', e);
      return existing;
    }
  }

  // ==========================================================================
  // 查询方法
  // ==========================================================================

  /**
   * 按名称查找对象
   */
  async findByName(storyId: string, branchId: string, name: string): Promise<NarrativeObjectState | undefined> {
    const states = await this.getAllStates(storyId, branchId);
    return states.find(s => s.name === name);
  }

  /**
   * 按类型过滤
   */
  async findByType(storyId: string, branchId: string, type: NarrativeObjectType): Promise<NarrativeObjectState[]> {
    const states = await this.getAllStates(storyId, branchId);
    return states.filter(s => s.type === type);
  }

  /**
   * 检查硬性属性矛盾（符号化精确匹配）
   *
   * 这就是 SCORE 混合检索里"符号化查表"的部分。
   * 因为属性是 key-value 精确存储的，所以查询是 O(1) 的，不会有语义检索的模糊性。
   *
   * 返回矛盾列表，空数组表示无矛盾。
   */
  checkPropertyConflicts(
    states: NarrativeObjectState[],
    newSegmentContent: string
  ): Array<{ objectName: string; property: string; expected: string; found: string; severity: 'error' | 'warning' }> {
    const conflicts: Array<{
      objectName: string;
      property: string;
      expected: string;
      found: string;
      severity: 'error' | 'warning';
    }> = [];

    for (const obj of states) {
      // 死亡角色重新活跃 → 硬错误
      if (obj.type === 'character' && obj.properties['isAlive'] === 'false') {
        if (newSegmentContent.includes(obj.name)) {
          // 检查是否只是回忆/提及
          const mentionContext = this.extractMentionContext(newSegmentContent, obj.name);
          const activeKeywords = ['说', '笑', '走', '来', '答', '道', '问', '看', '站', '坐', '挥', '喊'];
          const isActiveMention = activeKeywords.some(kw => mentionContext.includes(kw));
          if (isActiveMention) {
            conflicts.push({
              objectName: obj.name,
              property: 'isAlive',
              expected: 'false (已死亡)',
              found: '活跃行为',
              severity: 'error',
            });
          }
        }
      }

      // 地点归属矛盾
      if (obj.type === 'location' && obj.properties['controller']) {
        const controller = obj.properties['controller'];
        const oppositeKeywords: Record<string, string[]> = {
          '汉': ['匈奴', '胡人'],
          '匈奴': ['汉军', '汉朝'],
          '魏': ['蜀', '吴'],
          '蜀': ['魏', '曹'],
          '吴': ['魏', '曹'],
        };
        const opposites = oppositeKeywords[controller];
        if (opposites && !obj.properties['status']?.includes('被占')) {
          const mentionContext = this.extractMentionContext(newSegmentContent, obj.name);
          if (opposites.some(kw => mentionContext.includes(kw))) {
            conflicts.push({
              objectName: obj.name,
              property: 'controller',
              expected: controller,
              found: `出现敌方势力: ${opposites.find(kw => mentionContext.includes(kw))}`,
              severity: 'warning',
            });
          }
        }
      }

      // 关系矛盾
      if (obj.type === 'relationship' && obj.properties['status'] === '破裂') {
        const partners = obj.properties['between']?.split('-') || [];
        if (partners.length === 2) {
          const bothMentioned = partners.every(p => newSegmentContent.includes(p.trim()));
          if (bothMentioned) {
            const context = this.extractMentionContext(newSegmentContent, partners[0].trim());
            const friendlyKeywords = ['携手', '并肩', '盟', '友好', '合作', '共'];
            if (friendlyKeywords.some(kw => context.includes(kw))) {
              conflicts.push({
                objectName: obj.name,
                property: 'status',
                expected: '破裂',
                found: '友好互动行为',
                severity: 'warning',
              });
            }
          }
        }
      }
    }

    return conflicts;
  }

  /**
   * 提取某个名字在文本中的上下文（前后各20字）
   */
  private extractMentionContext(text: string, name: string): string {
    const idx = text.indexOf(name);
    if (idx < 0) return '';
    const start = Math.max(0, idx - 20);
    const end = Math.min(text.length, idx + name.length + 20);
    return text.slice(start, end);
  }

  // ==========================================================================
  // Prompt 构建方法
  // ==========================================================================

  /**
   * 构建注入 Prompt 的状态表区块
   *
   * 设计要点：
   * - 只输出最近活跃的对象（lastSeenSegmentId 在最近5段内的）
   * - 按类型分组，清晰可读
   * - 包含潜在冲突预警
   */
  async buildPromptContext(
    storyId: string,
    branchId: string,
    currentSegmentId: string,
    activeObjectLimit: number = 30,
  ): Promise<string> {
    const states = await this.getAllStates(storyId, branchId);
    if (states.length === 0) return '';

    // 按最后出现时间排序，取最近活跃的
    const sorted = [...states].sort((a, b) =>
      b.lastSeenSegmentId.localeCompare(a.lastSeenSegmentId)
    );
    const active = sorted.slice(0, activeObjectLimit);

    const lines: string[] = [];
    lines.push('## 叙事状态表（自动追踪）');
    lines.push('以下为当前故事的关键对象状态，续写时请确保状态一致：');
    lines.push('');

    // 按类型分组
    const typeLabels: Record<NarrativeObjectType, string> = {
      character: '👤 角色状态',
      location: '📍 地点状态',
      faction: '🏛️ 势力状态',
      item: '🔑 关键物品',
      relationship: '🤝 人物关系',
      event: '⚡ 关键事件',
    };

    const byType = new Map<NarrativeObjectType, NarrativeObjectState[]>();
    for (const obj of active) {
      const list = byType.get(obj.type) || [];
      list.push(obj);
      byType.set(obj.type, list);
    }

    // 指定输出顺序
    const typeOrder: NarrativeObjectType[] = ['character', 'relationship', 'location', 'faction', 'event', 'item'];

    for (const type of typeOrder) {
      const items = byType.get(type);
      if (!items || items.length === 0) continue;
      lines.push(`### ${typeLabels[type]}`);
      for (const item of items) {
        const props = Object.entries(item.properties)
          .filter(([_, v]) => v && v.trim().length > 0)
          .map(([k, v]) => `${k}: ${v}`)
          .join(' | ');
        lines.push(`- **${item.name}** → ${props || '(暂无属性)'}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * 构建状态表摘要（用于调试/报告）
   */
  async summarize(storyId: string, branchId: string): Promise<StateTableSummary> {
    const states = await this.getAllStates(storyId, branchId);
    const byType: Record<NarrativeObjectType, number> = {
      character: 0, location: 0, faction: 0, item: 0, relationship: 0, event: 0,
    };
    for (const s of states) {
      byType[s.type] = (byType[s.type] || 0) + 1;
    }

    const active = states.filter(s => s.lastSeenSegmentId && s.lastSeenSegmentId.length > 0).slice(0, 20);
    const conflicts = this.checkPropertyConflicts(states, '');

    return {
      totalObjects: states.length,
      byType,
      activeObjects: active,
      conflictWarnings: conflicts.map(c => `${c.objectName}: ${c.expected} → ${c.found}`),
    };
  }
}

// ============================================================================
// 导出单例
// ============================================================================

export const narrativeStateTracker = new NarrativeStateTracker();
export type { StateUpdateFromAI, NarrativeObjectState as NarrativeStateEntry };
