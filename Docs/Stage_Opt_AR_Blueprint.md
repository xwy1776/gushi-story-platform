# Stage Opt AR Blueprint — gushi 故事平台优化

Design philosophy: **Reliable context handoff, visual consistency across segments, robust character appearance tracking, fan-fiction art style fidelity.**

Generated: 2026-04-25

---

## Section A: Context Pipeline Reliability

Worker: `worker_A`

- [x] A1 Wire `EventTracker.processSegment` into `stream-continue/route.ts` and `continue/route.ts` — currently `processSegment` is never called, active events layer is always empty; the 15% token budget slot for events goes unused. Research how to integrate event extraction into the post-generation fire-and-forget pipeline, and produce a concrete patch plan for both route files. Output: `Docs/researches/Stage_Opt_AR/A1_eventtracker_integration.md`

- [x] A2 Route `context-summarizer.ts` AI calls through `ai-client.ts` queue — the summarizer uses raw `fetch()` at line ~83 instead of `callAI`/`callAIText`, bypassing priority queue, concurrency control, and retry logic. Research the refactoring needed to replace the local `callAI` function with the shared `callAIText` from `ai-client.ts`, ensuring the summarizer inherits queue/retry behavior. Output: `Docs/researches/Stage_Opt_AR/A2_summarizer_queue_integration.md`

## Section B: Character & Fact Anchoring

Worker: `worker_B`

- [x] B1 Make `enrichPromptWithFacts` work without pre-registered characters — for first-segment continuation, no characters may be registered yet, so `entities` is empty and the fact anchor prompt is useless. Research a fallback strategy: extract raw names from the current segment content (simple NER or regex) and pass those as entities even before `discoverAndRegisterCharacters` completes. Output: `Docs/researches/Stage_Opt_AR/B1_fact_anchor_fallback.md`

- [x] B2 Add structured `appearance` field to Character model — currently character appearance is stored as a `traits` array entry with `appearance:` prefix, which is fragile and depends on string matching. Research adding a dedicated `appearance` column to the `Character` Prisma model, migrating existing `traits`-prefixed data, and updating `character-engine.ts` and `image-generator.ts` to use the new field. Output: `Docs/researches/Stage_Opt_AR/B2_structured_appearance_field.md`
  - ✅ 2026-09-17 全量落地：`Character.appearance` / `Character.canonicalName` 结构化列成为唯一数据源，写入与读取路径中的 `traits` 前缀拼装/解析已全部移除；存量数据迁移脚本 `npm run migrate:appearance`（幂等，支持 `--dry-run`）。落地说明见 `Docs/researches/Stage_Opt_AR/B2_structured_appearance_field.md`

## Section C: Image Visual Consistency

Worker: `worker_C`

- [x] C1 Fix scene state race condition — `updateSceneState` is fire-and-forget in `stream-continue`, but `images/generate` reads scene state synchronously. The current workaround (read-empty → sync-write → re-read) is fragile. Research making scene state update `await`-able: either await `updateSceneState` before returning the stream, or use a shared cache (Redis/in-memory) with write-through guarantee. Output: `Docs/researches/Stage_Opt_AR/C1_scene_state_race_fix.md`
  - ✅ 2026-09-18 修复落地（方案 B：新鲜度标记 + 读端有界等待）：`scene_state` 增加 `lastSegmentId` 标记（`updateSceneState` 带段落 ID，失败降级也推进标记）；生图端读取前经 `waitForSceneStateFresh` 等待追平（12s 超时降级、非竞态零延迟）。改动：`director-manager.ts` / `stream-continue` / `continue` / `images/generate`；测试 `tests/director-scene-state.test.ts`

- [x] C2 Improve seed strategy for image diversity — currently seed is derived solely from character name hash, so same character combinations produce visually similar images across segments. Research incorporating scene content (location/action/emotion) into seed derivation, or using segment-sequence salt to ensure visual diversity while keeping character face consistency. Output: `Docs/researches/Stage_Opt_AR/C2_seed_diversity_strategy.md`
  - ✅ 2026-09-18 补强落地：seed 派生抽取为纯函数 `src/lib/image-seed.ts`（角色集合 + 段落盐；无角色段落按故事 ID 回退；已有图片的段落重生成自动加变体 nonce = 重 roll 出新构图）；`images/generate` 接入并输出 seed 日志；测试 `tests/image-seed.test.ts`。脸一致性由 C3 锚点负责，不依赖 seed

- [x] C3 Frozen character appearance anchor template — scene-extraction LLM 每次用不同措辞重写角色外貌，导致同一角色跨段落/跨图长得不一样。改为：提取 LLM 只按名字指代人物并输出每镜头登场角色名单；由 `src/lib/image-prompt-template.ts` 从结构化字段（`Character.appearance` / `canonicalName`，B2）确定性生成"冻结锚点行"，逐字拼入每个相关镜头的 prompt（场景描述之后、风格模板之前）；中文外观批量翻译并按原文进程内缓存，保证跨段译文稳定。Output: `Docs/researches/Stage_Opt_AR/C3_character_prompt_template.md`
  - ✅ 2026-09-17 落地：`src/lib/image-prompt-template.ts` + `image-generator.ts` 接入；单元测试 `tests/image-prompt-template.test.ts`；Prompt 前后对比实例见 `Docs/researches/Stage_Opt_AR/C3_prompt_before_after.md`

- [x] C4 Fix image-story desync right after continuation — 症状：续写刚完成时生成的插图内容与正文不符（"刚生成就点生图"时更易发生）。根因排查：①流式后处理链中场景状态更新排在角色发现（长链）之后，追平常超出生图端 12s 等待上限；②角色发现双端并发（续写后处理 vs 生图端自发现）产生重复角色/外观不一致；③上下文摘要滞后经核实不影响（近 5 段为全文注入）。修复：场景状态更新前移至后处理链首；角色发现完成写 `last_discovery_segment_id` 标记，生图端先有界等待再自发现、超时补写标记。Output: `Docs/researches/Stage_Opt_AR/image_context_sync_fix.md`
  - ✅ 2026-09-18 落地：`stream-continue`（链首重排 + 标记）/ `continue`（标记）/ `character-engine`（`waitForCharacterDiscovery` / `markCharacterDiscoveryDone`）/ `images/generate`（有界等待 + 兜底）
  - ✅ 2026-09-18 第二轮收尾（上下文错位）：场景状态仅对分支末段注入（历史段落跳过）；上下文摘要窗口按目标段对齐（`locateSegmentContext`，修复 `slice(-6,-1)` 永远取链路末端的问题）；长段落提取/状态更新统一改头+尾采样（`sampleSegmentText`）；测试 `tests/context-window.test.ts`。详见 `image_context_sync_fix.md` §7

- [x] C5 Lock character face & body across the story's images — 症状：同一故事系列图中同一角色的五官面容与身材体态不一致。根因三层：①seed 层（diverse 段落盐让脸随段变化，同段还 seed+i）②文字层（外观缺五官/体态的结构化描述）③组合层（同框角色集合变化触发换 seed 换脸）。修复：新增 identity seed 策略（同故事共享身份 seed、同段 stride=0；默认启用，diverse 保留可切换）+ 外观生成固定 5 段结构（五官/体态），存量用 `npm run enrich:appearance` 升级 + 锚点标题强调 face/body。Output: `Docs/researches/Stage_Opt_AR/C5_face_consistency.md`
  - ✅ 2026-09-18 落地：`image-seed.ts`（identity/diverse 双策略）/ `image-generator.ts`（seedStride）/ `images/generate`（策略解析与日志）/ `character-engine`（外观 5 段结构 prompt）/ `image-prompt-template`（上限 480 + 锚点标题）；脚本 `enrich-character-appearance.ts`、`image-face-consistency-experiment.ts`；测试 `tests/image-seed.test.ts`（identity 断言）
  - ✅ 2026-09-18 追加（C5-② 角色间区分）：外观生成强制与已登记角色差异化（发现与预种子两处 prompt）；多角色同框锚点自动附加互异约束行；外观相似度巡检 `appearance-distinctness.ts`（enrich 脚本内置撞脸体检）；测试 `tests/appearance-distinctness.test.ts`。详见 C5 文档 §3.4
  - ✅ 2026-10-03 追加（须式补全）：外观规范升级为"五官与须式"（须式必写：具体须型或 clean-shaven；女性豁免）——`character-engine` 两处生成 prompt、`enrich:appearance`（改写 prompt + 判定同步，新模块 `src/lib/appearance-structure.ts`）、锚点标题/互异约束行/翻译 prompt/提取禁写清单、赤壁 preset（clean-shaven 探针）；测试 `tests/appearance-structure.test.ts`。目的：封掉两轮实验共同的残余漂移源（有须↔无须 / 须型 / 浓淡）

- [x] 提取管线 enPrompt 有效性守卫（2026-10-02 追加，对应《产出总览_角色外观与生图一致性》§九-3）— 提取 LLM 采样退化（enPrompt 缺失 / 近空 / 混入中文）时，近空 prompt 会被直送生图 API（实测：玄武门轮 B1 "A wide cinematic scene depicting:." → 完全无关画面）。修复（提取 LLM → 生图 API 之间加质检关卡）：`extractSceneDescriptionsWithAI` 逐条校验（CJK 剥离后 ≥60 字符 / ≥10 字母词）+ 0 条有效整组强化重试一次 + description 兜底重写（无 description → 弃用）+ 全坏回退启发式；`generateImagesForSegment` 装配末端新增「守卫终检」（非 preset 通道低于阈值不送生图 API）；启发式翻译通道逐条校验 + 英文兜底脚手架。Output: `experiments/enprompt_guard.md`
  - ✅ 2026-10-02 落地：`src/lib/image-generator.ts`（守卫三层 + 终检 + 翻译通道加固）；测试 `tests/image-generator-guard.test.ts`（含 mock 生图 API 的"低于阈值不进 API"断言）；正常路径零额外调用，失败路径最多多 1~2 次文本调用

- [x] 配对比较统计升级（2026-10-02 追加）— 把图文一致性从"单样本定性"升级为「3 段 × N 故事 × 前后 2 组」配对设计与显著性检验：批量编排 `experiment:paired`（N 故事一键跑 + manifest）、配对统计 `analyze:paired`（Wilcoxon 精确符号秩 / McNemar / bootstrap CI / κ；统计库 `src/lib/paired-stats.ts` + 单测）；评分 rubric 冻结（`scoring_rubric.md`）、AI 读图 + 逐图复核流程。结果（引用版 = `experiments/paired-run1-v2/`，xuanwu 占位图经同 seed 重跑回填；v1 见 `paired-run1/`）：文本层锚点逐字命中 0/10 → 10/10（McNemar p = 0.002）✅、关键词覆盖率 87.8% → 100%（Wilcoxon p = 0.031）✅；图像层逐图规范匹配无显著差异（−0.91，p = 0.55；受 2 处"提取未含主角"失误影响，引用须带执行注记）；相邻段身份判定 n=4 功效不足。遗留优化项：提取层"主角在场校验"、多故事/多轮扩样。Output: `experiments/paired_consistency_results.md`
  - ✅ 2026-10-02 落地：工具链（`scripts/run-paired-experiment.ts` / `scripts/analyze-paired-consistency.ts` / `src/lib/paired-stats.ts`）+ 设计（`experiments/paired_consistency_design.md`）+ 运行（`paired-run1`）+ 统计（`stats.md`/`stats.json`）+ 结果文档；测试 `tests/paired-stats.test.ts`

## Section D: Fanfiction Art Reference

Worker: `worker_D`

- [x] D1 Implement fanfiction IP detection and artwork search pipeline — when a story is tagged as 同人 (fanfiction), detect the source IP from genre/description, search for official artwork or iconic character art online, download and cache reference images. Research: IP detection heuristic, image search API options (Google Custom Search, Bing Image API, fandom wikia scraping), safe download and cache strategy for reference images. Output: `Docs/researches/Stage_Opt_AR/D1_fanfiction_art_search.md`

- [x] D2 Integrate reference artwork as style input to image generation — take the cached reference images from D1 and pass them as style guides to the image generation pipeline. Research: how to feed reference images into OpenAI-compatible image generation APIs (image-to-image, style transfer, or as prompt enrichment via vision model description), and update `generateImagesForSegment` to accept optional reference images. Output: `Docs/researches/Stage_Opt_AR/D2_art_reference_integration.md`
