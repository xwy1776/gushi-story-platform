# Gushi 项目论文阅读总结（肖文宇）

> 2026-08-16 整理 | 用于 Memory-Enhancement Module 设计与 Method 章节

---

## 一、核心对标论文（已精读）

### 1. SCORE: Story Coherence and Retrieval Enhancement for AI Narratives (2025.03)

- **链接**: https://arxiv.org/abs/2503.23512 | 本地 PDF: `d:/项目/SCORE_2503.23512.pdf`
- **一句话**: 叙事一致性的 RAG 框架——不要把所有历史文本塞给 LLM，用"结构化状态表 + 分层摘要 + 混合检索"替。
- **三个组件**:
  1. **动态状态追踪 (Dynamic State Tracking)**: 生成过程中持续追踪关键对象（角色/地点/物品）的状态变化，符号化记录（如"张骞—所在地：漠北，身份：匈奴俘虏"）。不只追角色，追所有叙事关键对象。
  2. **分层摘要生成 (Hierarchical Summarization)**: 对每段生成多粒度摘要——粗粒度（一章梗概）做大纲规划用，细粒度（带情感/动机细节）做角色一致性校验用。
  3. **混合检索 (Hybrid Retrieval)**: 符号化状态查询（查硬矛盾，如地点冲突）+ 向量化摘要检索（查软矛盾，如情感基调）结合。
- **指标**: 定义 NCI-2.0 叙事一致性指标（角色稳定/事件因果/时间线连续/情感连贯 子维度合成）；EASM 情感弧线评分。
- **与 Gushi 关系**: Gushi 已有 context-summarizer（对应组件2）、consistency-checker（对应组件3的硬规则部分）。**缺组件1动态状态追踪** → 已补 narrative-state-tracker.ts。

### 2. DOME: Generating Long-form Story Using Dynamic Hierarchical Outlining with Memory-Enhancement (2024.12)

- **链接**: https://arxiv.org/abs/2412.13575 | 本地 PDF: `d:/项目/DOME_2412.13575.pdf`
- **一句话**: 跟 Gushi 契合度最高的论文——知识图谱增强 + 动态大纲，冲突减少 87.6%。
- **两个核心机制**:
  1. **DHO (Dynamic Hierarchical Outline)**: 边规划边写、边写边调。把"章节-段落-场景"三层结构嵌进大纲，融合规划和写作阶段——既保宏观方向，又留即兴空间。
  2. **MEM (Memory-Enhancement Module)**: 时序知识图谱。节点=角色/事件/地点，边=参与/触发/位于/时间先后。需要时按节点和关系查，不是原始文本检索。
- **Temporal Conflict Analyzer**: 基于知识图谱的时序冲突检测，论文报 87.6% 冲突减少。
- **与 Gushi 关系**: Gushi 的 Character Agent（角色图）+ Timeline Engine（时间校验）+ lorebook（扁平字典）= DOME 知识图谱的**碎片版**。→ 已补 knowledge-graph.ts 统一为图结构。
- **Gushi 增量创新点**: DOME 图谱是单线程的，Gushi 有多分支叙事——**同一角色在不同分支状态不同**，图谱带 branchId 维度。这是 DOME 没有的，可写进论文 Contribution。

---

## 二、补充推荐论文（下载链接 + 摘要）

### 3. Guiding Generative Storytelling with Knowledge Graphs (arXiv 2025.05)

- **链接**: https://arxiv.org/abs/2505.24803 | **本地 PDF**: `d:/项目/Guiding_KG_2505.24803.pdf`
- **一句话**: 用外部知识图谱引导 LLM 做故事生成——把生成的故事"锚定"到已知的知识图谱结构上。
- **核心方法**: 将故事生成与知识图谱嵌入结合，图谱提供情节元素和关系的约束，生成时参考图谱中相关的子图，提高连贯性和知识准确性。
- **为什么相关**: 直接指导 Gushi 的 knowledge-graph.ts 设计——特别是"图谱子图如何注入生成"这一步（Gushi 现在用 BFS 邻域查询，这篇论文的注入方式可参考）。
- **阅读重点**: 图谱子图的选择策略、注入方式、与纯 LLM 基线的对比实验设计。

### 4. Narrative-of-Thought: Improving Temporal Reasoning of Large Language Models via Recounted Narratives (Findings of EMNLP 2024)

- **链接**: https://aclanthology.org/2024.findings-emnlp.963/ | **本地 PDF**: `d:/项目/NarrativeOfThought_NoT.pdf`
- **一句话**: 用"重述叙事"的方式提升 LLM 的时间推理能力——把时间信息组织成故事化的叙述再推理。
- **核心方法**: 把时间线信息重述成叙事文本（而不是直接给结构化时间戳），让 LLM 对时间关系（先后/间隔/同时）的判断更准。
- **为什么相关**: Gushi 的 timeline-engine 只做时间单调性硬校验。这篇的"叙事化时间推理"思路可以用于——让 LLM 判断两个事件是否时间矛盾时，先把时间信息叙述化。
- **阅读重点**: 时间关系重述的 prompt 设计、时间推理的评测基准。

### 5. LLM-as-a-Judge (Zheng et al., 2023/2024)

- **链接**: https://arxiv.org/abs/2306.05685 | **本地 PDF**: `d:/项目/LLM-as-Judge_2306.05685.pdf`
- **一句话**: 让 GPT-4 当评估法官，评估质量接近人类标注——LLM 打分的开山之作。
- **核心方法**: 用 LLM 对生成内容按多个维度打分，研究了位置偏差、冗长偏差等问题及缓解方法（交换位置、参考基准等）。
- **为什么相关**: Gushi 的双打分机制（人工+AI）依据之一。黄夏薇的 LLM-as-Judge Prompt 模板应参考这篇的位置偏差处理——让 AI 对 A/B 两组分别打分而不是放一起比较。
- **阅读重点**: 评估 prompt 设计、偏差缓解（position bias 处理）、与人类标注的一致性（Cohen's Kappa）。

---

## 三、论文 → Gushi 代码映射表

| 论文组件 | Gushi 现有/新增代码 | 状态 |
|----------|--------------------|------|
| SCORE 动态状态追踪 | `src/lib/narrative-state-tracker.ts`（新增） | ✅ 已写已接入 |
| SCORE 分层摘要 | `src/lib/context-summarizer.ts` | ✅ 已有 |
| SCORE 混合检索（硬规则） | `src/lib/consistency-checker.ts` | ✅ 已有 |
| DOME 知识图谱 MEM | `src/lib/knowledge-graph.ts`（新增） | ✅ 已写已接入 |
| DOME 时序冲突分析 | `timeline-engine.ts` + `consistency-checker.ts` | ✅ 已有 |
| DOME 动态大纲 DHO | `branch-memory.ts` + `director-manager.ts` | 🟡 部分实现 |
| KG引导生成注入 | `prompt-builder.ts`（新增图谱上下文注入） | ✅ 已接入 |
| 时间推理增强 | 待研究（Narrative-of-Thought 思路） | ⏳ 未来方向 |
| LLM-as-Judge | `prompt-builder` 之外的评估脚本（黄夏薇） | 🟡 落地中 |

---

## 四、创新点包装候选（导师说方法偏老套，需要差异化）

1. **跨分支维度知识图谱**：DOME 图谱单线程；Gushi 同角色多分支状态可追溯可对比 → "首次在交互叙事中将时序知识图谱扩展到多分支场景"
2. **符号化状态表 + 分层摘要的混合检索**：SCORE 动态追踪是自然语言状态；Gushi 升级为 key-value 符号化属性，O(1) 精确查表 → "符号化叙事状态追踪"
3. **人工+AI 双打分评估框架**：结合 NCI-2.0 维度和 LLM-as-Judge，输出中文叙事一致性评估体系
