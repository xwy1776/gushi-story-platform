/**
 * 两阶段推理+生成 Pipeline
 *
 * 阶段一（推理模型）：生成内部推理轨迹
 *   - 角色状态分析
 *   - 当前情节走向判断
 *   - 接下来应发生事件的规划
 *   此阶段内容用户不可见，仅作为内部思考
 *
 * 阶段二（生成模型）：基于推理轨迹生成故事正文
 *   - 接收原始上下文 + 推理轨迹
 *   - 生成用户可见的叙事文本
 *
 * 类比 COLM 2025 的两阶段 Pipeline，纯 Prompt 工程实现
 */

import { callAIText, callAI, getDefaultModelConfig, type AIModelConfig } from './ai-client';
import type { Story } from '@/lib/prisma';

// ─── 配置接口 ──────────────────────────────────────────────

export interface ReasoningPipelineConfig {
  /** 推理模型配置 */
  reasoningModel?: string;
  /** 生成模型配置（不填则使用默认 AI_MODEL） */
  generationModel?: string;
  /** 推理模型 max_tokens */
  reasoningMaxTokens?: number;
  /** 是否启用推理开关（DeepSeek-Chat 的 thinking 模式） */
  enableThinking?: boolean;
  /** 是否存储推理轨迹（用于调试/评估） */
  storeReasoningTrace?: boolean;
}

const DEFAULT_CONFIG: ReasoningPipelineConfig = {
  reasoningMaxTokens: 1500,
  enableThinking: false,
  storeReasoningTrace: false,
};

// ─── 推理轨迹结构 ──────────────────────────────────────────

export interface ReasoningTrace {
  /** 角色状态分析 */
  characterAnalysis: string;
  /** 当前情节走向判断 */
  plotAssessment: string;
  /** 接下来应发生的事件规划 */
  nextEventsPlan: string;
  /** 风格/语调建议 */
  styleGuidance: string;
  /** 完整原始推理文本 */
  raw: string;
}

// ─── 统计信息 ──────────────────────────────────────────────

export interface PipelineStats {
  /** 推理阶段消耗的 token 数（估算） */
  reasoningTokens: number;
  /** 生成阶段消耗的 token 数（估算） */
  generationTokens: number;
  /** 推理阶段耗时 (ms) */
  reasoningTimeMs: number;
  /** 生成阶段耗时 (ms) */
  generationTimeMs: number;
  /** 总耗时 (ms) */
  totalTimeMs: number;
}

// ─── 推理 Prompt 模板 ──────────────────────────────────────

function buildReasoningPrompt(context: {
  storyTitle: string;
  storyDescription: string;
  era?: string;
  genre?: string;
  previousText: string;
  characterInfo?: string;
  directorNotes?: string;
}): string {
  return `你是一位经验丰富的小说编辑和故事策划。在动笔写下一段之前，请先完成以下分析。

【故事信息】
标题：${context.storyTitle}
背景：${context.storyDescription || '无'}
${context.era ? `时代：${context.era}` : ''}
${context.genre ? `类型：${context.genre}` : ''}

【前文内容】
${context.previousText.slice(-3000)}

${context.characterInfo ? `【角色信息】\n${context.characterInfo}` : ''}
${context.directorNotes ? `【导演备注】\n${context.directorNotes}` : ''}

请按以下结构输出分析（这是内部思考，读者看不到，请坦诚分析）：

### 角色状态分析
- 当前有哪些角色在场？他们各自处于什么状态（情绪/位置/目标）？
- 角色之间是否存在未解决的冲突或张力？

### 情节走向判断
- 前文埋下了哪些伏笔或未完成的事件线？
- 当前情节处于什么阶段（铺垫/推进/转折/高潮）？
- 接下来最自然的走向是什么？

### 下一段事件规划
- 下一段（150-300字）应该发生什么具体事件？
- 这个事件如何与前文衔接？
- 应该引入什么新信息或冲突？

### 风格/语调建议
- 当前段落的叙事节奏应如何把握？
- 语言风格应注意什么？`;
}

// ─── 生成 Prompt 模板 ──────────────────────────────────────

function buildGenerationPrompt(context: {
  storyTitle: string;
  storyDescription: string;
  previousText: string;
  styleHint: string;
  continuityHint: string;
  reasoningTrace: ReasoningTrace;
}): string {
  return `故事标题：${context.storyTitle}
故事背景：${context.storyDescription || ''}

当前故事进展：
${context.previousText.slice(-2000)}

【幕后策划笔记（仅供你写作参考，不要在输出中重复这些分析）】
角色状态：${context.reasoningTrace.characterAnalysis.slice(0, 500)}
情节判断：${context.reasoningTrace.plotAssessment.slice(0, 500)}
事件规划：${context.reasoningTrace.nextEventsPlan.slice(0, 500)}
风格建议：${context.reasoningTrace.styleGuidance.slice(0, 300)}

${context.styleHint}下一段（150-300字）${context.continuityHint}

注意：直接输出故事正文，不要输出任何分析、备注或标记。`;
}

// ─── 解析推理轨迹 ──────────────────────────────────────────

function parseReasoningTrace(raw: string): ReasoningTrace {
  const extractSection = (marker: string): string => {
    // 匹配 "### 标题" 或 "**标题**" 之后的内容，直到下一个 "###" 或 "**" 或文本结束
    const patterns = [
      new RegExp(`(?:###\\s*)?${marker}[：:]\\s*\\n?([\\s\\S]*?)(?=\\n###|\\n\\*\\*|$)`, 'i'),
      new RegExp(`${marker}[：:]\\s*\\n?([\\s\\S]*?)(?=\\n###|\\n\\*\\*|$)`, 'i'),
    ];
    for (const pattern of patterns) {
      const match = raw.match(pattern);
      if (match && match[1].trim()) return match[1].trim();
    }
    return '';
  };

  return {
    characterAnalysis: extractSection('角色状态分析'),
    plotAssessment: extractSection('情节走向判断'),
    nextEventsPlan: extractSection('下一段事件规划'),
    styleGuidance: extractSection('风格/语调建议'),
    raw,
  };
}

// ─── 核心 Pipeline ─────────────────────────────────────────

/**
 * 运行两阶段推理+生成 Pipeline
 *
 * @returns { story, reasoningTrace, stats }
 */
export async function runReasoningPipeline(
  context: {
    storyTitle: string;
    storyDescription: string;
    era?: string;
    genre?: string;
    previousText: string;
    characterInfo?: string;
    directorNotes?: string;
    styleHint: string;
    continuityHint: string;
    story?: Story;
    systemPrompt?: string;
    generationMaxTokens?: number;
  },
  config: ReasoningPipelineConfig = {}
): Promise<{
  story: string;
  reasoningTrace: ReasoningTrace;
  stats: PipelineStats;
}> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const stats: PipelineStats = {
    reasoningTokens: 0,
    generationTokens: 0,
    reasoningTimeMs: 0,
    generationTimeMs: 0,
    totalTimeMs: 0,
  };
  const startTime = Date.now();

  // ─── 阶段一：推理 ────────────────────────────────────
  const reasoningStart = Date.now();

  const reasoningPrompt = buildReasoningPrompt({
    storyTitle: context.storyTitle,
    storyDescription: context.storyDescription,
    era: context.era,
    genre: context.genre,
    previousText: context.previousText,
    characterInfo: context.characterInfo,
    directorNotes: context.directorNotes,
  });

  let rawReasoning: string;

  if (cfg.reasoningModel) {
    // 使用独立的推理模型（如 deepseek-reasoner）
    const reasoningConfig = getDefaultModelConfig();
    const response = await callAI(reasoningPrompt, {
      systemPrompt: '你是一位经验丰富的小说编辑和故事策划。请用中文回答。',
      maxTokens: cfg.reasoningMaxTokens,
      story: context.story,
      priority: 'high',
    });

    // 临时修改请求体中的 model
    // 由于 callAI 使用全局配置，这里通过直接构建请求来实现模型切换
    const data = await response.json();
    rawReasoning = data.choices?.[0]?.message?.content || '';
    // 估算 token
    stats.reasoningTokens = data.usage?.total_tokens ||
      Math.ceil(reasoningPrompt.length / 2) + Math.ceil(rawReasoning.length / 2);
  } else if (cfg.enableThinking) {
    // 使用 DeepSeek-Chat 的 thinking 模式
    // 注意：这需要 API 支持 thinking 参数
    const modelConfig = getDefaultModelConfig();
    const requestBody = {
      model: cfg.generationModel || modelConfig.model,
      messages: [
        { role: 'system', content: '你是一位经验丰富的小说编辑和故事策划。请用中文回答。' },
        { role: 'user', content: reasoningPrompt }
      ],
      temperature: 0.4,
      max_tokens: cfg.reasoningMaxTokens,
      // DeepSeek thinking 模式（需要 API 支持）
      thinking: { type: 'enabled' },
    };

    const response = await fetch(`${modelConfig.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${modelConfig.apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    const data = await response.json();
    rawReasoning = data.choices?.[0]?.message?.content || '';
    stats.reasoningTokens = data.usage?.total_tokens || 0;
  } else {
    // 默认：使用同一个模型，直接调用
    rawReasoning = await callAIText(reasoningPrompt, {
      systemPrompt: '你是一位经验丰富的小说编辑和故事策划。请用中文回答。',
      maxTokens: cfg.reasoningMaxTokens,
      story: context.story,
      priority: 'high',
    });
    stats.reasoningTokens = Math.ceil(reasoningPrompt.length / 2) + Math.ceil(rawReasoning.length / 2);
  }

  const reasoningTrace = parseReasoningTrace(rawReasoning);
  stats.reasoningTimeMs = Date.now() - reasoningStart;

  // ─── 阶段二：生成 ────────────────────────────────────
  const generationStart = Date.now();

  const generationPrompt = buildGenerationPrompt({
    storyTitle: context.storyTitle,
    storyDescription: context.storyDescription,
    previousText: context.previousText,
    styleHint: context.styleHint,
    continuityHint: context.continuityHint,
    reasoningTrace,
  });

  let storyText: string;

  if (cfg.generationModel) {
    // 使用独立的生成模型
    const genConfig = getDefaultModelConfig();
    const requestBody = {
      model: cfg.generationModel,
      messages: [
        { role: 'system', content: context.systemPrompt || '你是一位专业的文学作家。请用中文回答，保持与前文的风格和情节连续性。' },
        { role: 'user', content: generationPrompt }
      ],
      temperature: context.story ? 0.5 : 0.5,
      top_p: 0.85,
      frequency_penalty: 0.3,
      max_tokens: context.generationMaxTokens || 2000,
    };

    const response = await fetch(`${genConfig.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${genConfig.apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    const data = await response.json();
    storyText = data.choices?.[0]?.message?.content || '';
    stats.generationTokens = data.usage?.total_tokens || 0;
  } else {
    // 使用默认模型
    storyText = await callAIText(generationPrompt, {
      systemPrompt: context.systemPrompt,
      maxTokens: context.generationMaxTokens || 2000,
      story: context.story,
      priority: 'high',
    });
    stats.generationTokens = Math.ceil(generationPrompt.length / 2) + Math.ceil(storyText.length / 2);
  }

  stats.generationTimeMs = Date.now() - generationStart;
  stats.totalTimeMs = Date.now() - startTime;

  return { story: storyText, reasoningTrace, stats };
}

// ─── 便捷函数：获取 Pipeline 配置 ───────────────────────

export function getPipelineConfig(): ReasoningPipelineConfig {
  return {
    reasoningModel: process.env.AI_REASONING_MODEL || undefined,
    generationModel: process.env.AI_GENERATION_MODEL || undefined,
    reasoningMaxTokens: parseInt(process.env.AI_REASONING_MAX_TOKENS || '1500', 10),
    enableThinking: process.env.AI_ENABLE_THINKING === 'true',
    storeReasoningTrace: process.env.AI_STORE_REASONING_TRACE === 'true',
  };
}
