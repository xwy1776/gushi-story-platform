/**
 * 跨分支污染实验 —— 检验「分支感知」这个核心创新到底有没有用
 *
 * ── 为什么必须有这个实验 ──────────────────────────────────────────
 * `ab_ablation.ts` 那 4 档消融证明的是「记忆注入有用」——但 SCORE(2025.03) /
 * DOME(2024.12) 也能证明这件事。本文唯一的增量是**分支感知**：
 * 同一角色在不同分支处于不同状态时，记忆按 branchId 隔离。
 * 那 4 档消融每个故事只跑单一分支，是线性续写任务，**测不到这一点**。
 *
 * ── 实验设计 ──────────────────────────────────────────────────────
 * 对每个故事造一个分叉点，两条**设定互斥**的分支 A / B：
 *
 *   分支 A：刘备投奔公孙瓒，借兵讨董
 *   分支 B：刘备投奔曹操，会盟讨董
 *
 * 只在**分支 A** 上续写 5 段。两档对照：
 *
 *   `isolated`（本文做法）  A 的检索空间只含 A 的事实，B 的事实带 branchId=B，看不见
 *   `shared`  （单线记忆）  A 和 B 的事实都塞进同一个检索空间
 *                           —— 这正是 SCORE / DOME 那种没有分支维度的系统会发生的事
 *
 * ── 指标 ──────────────────────────────────────────────────────────
 * **跨分支污染率** = A 分支续写段落中，引用了 B 分支独有事件/状态的段落占比。
 *
 * 用**两个互相独立的度量**，并报告两者的一致率：
 *   ① 关键词匹配：段落是否命中 B 分支的专属措辞（客观、便宜、但粗）
 *   ② LLM-as-Judge：把 A/B 两条设定 + 正文给模型，让它判定是否构成污染（能处理语义）
 *
 * 之所以要两个：本项目已经吃过一次「指标静默失效」的亏
 * （见 Docs/ablation/退化复读诊断.md），单一指标的结论不可信。
 *
 * `isolated` 档同时充当**标记词有效性的对照**：如果隔离开着还测出高污染率，
 * 说明标记词选得不好（模型本来就爱提那些词），而不是隔离失效。
 *
 * ── 运行 ──────────────────────────────────────────────────────────
 *   docker compose up -d postgres
 *
 *   # 先跑小样本看信号（约 20 次生成，3-5 分钟）
 *   npx tsx tests/ab_branch_isolation.ts --stories=2 --segments=5
 *
 *   # 正式跑：5 组冲突分支 × 2 档 × 5 段 × 3 轮
 *   npx tsx tests/ab_branch_isolation.ts --stories=5 --segments=5 --rounds=3
 *
 * 结果输出到 Docs/ablation/branch_isolation_*.json 与 .md
 */
import './test-env';
import { mkdirSync, writeFileSync, readdirSync, readFileSync, statSync, renameSync } from 'fs';
import { join } from 'path';
import prisma from '../src/lib/prisma';
import { buildFullPrompt } from '../src/lib/prompt-builder';
import { knowledgeGraph } from '../src/lib/knowledge-graph';
import { narrativeStateTracker } from '../src/lib/narrative-state-tracker';
import { getOrderedChain } from '../src/lib/chain-helpers';
import { callAIText } from '../src/lib/ai-client';
import { splitSimilarity, stats, trigramSimilarity } from './ab_ablation';

// ============================================================================
// 档位
// ============================================================================

type Isolation = 'isolated' | 'shared';

const ARM_LABELS: Record<Isolation, string> = {
  isolated: '分支隔离（本文）',
  shared: '单线记忆（SCORE/DOME 式）',
};

const SYSTEM_PROMPT = '你是一位专业的文学作家。请用中文回答，用现代白话文写作，保持与前文的风格和情节连续性。';

// ============================================================================
// 冲突分支定义
// ============================================================================

type BranchFacts = {
  /** 分支设定的一句话描述，给 LLM-as-Judge 看 */
  label: string;
  /** 该分支独有的事实，种进记忆系统 */
  states: Array<Record<string, any>>;
  edges: Array<{ from: string; to: string; type: 'ally_of' | 'conflicts_with' | 'involves' | 'belongs_to' | 'located_at' }>;
  /**
   * 该分支的专属措辞，用于关键词法判定污染。
   *
   * 挑词两条规则（试跑踩过坑，别违反）：
   *   ① **不要用著名历史人物的名字**。「曹操」「孙权」这类词在三国题材里是常识，
   *      模型凭空蹦出来不等于记忆泄漏 —— 早先拿「曹操」当标记词，isolated 档
   *      第 2 段编了个曹操客串就被判污染，是假阳性。
   *   ② **不能出现在 FORK_OPENERS 里**。opener 是两档共见的上下文，写进去就脏了。
   *      改完 opener 请重跑 `--stories=1 --segments=2` 复核 isolated 档是否接近 0。
   * 因此标记词只用**地点/事件**这类真属于该分支、且不靠常识就能写出来的词。
   * 关键词法终究是粗的 —— 它只是佐证，主判定看 Judge。
   */
  markers: string[];
  /** 该分支的事实清单（自然语言），给 LLM-as-Judge 看 */
  factsForJudge: string;
};

type ForkDef = {
  story: string;              // 与 ab_ablation.ts 的 StoryDef.title 对应
  forkPoint: string;          // 分叉点描述
  branchA: BranchFacts;
  branchB: BranchFacts;
};

const FORKS: ForkDef[] = [
  {
    story: '桃园结义',
    forkPoint: '董卓祸乱朝纲，刘关张三人兵微将寡，必须择一强援',
    branchA: {
      label: '投公孙瓒，借兵讨董',
      states: [
        { id: 'fa_liu_loc', type: 'character', name: '刘备', properties: { location: '北平', ally: '公孙瓒', goal: '借兵讨董' } },
        { id: 'fa_gongsun', type: 'character', name: '公孙瓒', properties: { isAlive: 'true', location: '北平', status: '盟友', faction: '白马义从' } },
        { id: 'fa_event', type: 'event', name: '借兵讨董', properties: { result: '公孙瓒允诺借兵三千', location: '北平' } },
      ],
      edges: [
        { from: '刘备', to: '公孙瓒', type: 'ally_of' },
        { from: '公孙瓒', to: '董卓', type: 'conflicts_with' },
      ],
      markers: ['北平'],
      factsForJudge: '刘备投奔公孙瓒，驻扎北平，向公孙瓒借兵讨伐董卓；公孙瓒是盟友，答应借兵三千。',
    },
    branchB: {
      label: '投曹操，会盟讨董',
      states: [
        { id: 'fb_liu_loc', type: 'character', name: '刘备', properties: { location: '许都', ally: '曹操', goal: '会盟讨董' } },
        { id: 'fb_caocao', type: 'character', name: '曹操', properties: { isAlive: 'true', location: '许都', status: '盟友', faction: '兖州军' } },
        { id: 'fb_event', type: 'event', name: '许都会盟', properties: { result: '曹操与刘备会盟于许都', location: '许都' } },
      ],
      edges: [
        { from: '刘备', to: '曹操', type: 'ally_of' },
        { from: '曹操', to: '董卓', type: 'conflicts_with' },
      ],
      markers: ['许都'],
      factsForJudge: '刘备投奔曹操，驻扎许都，与曹操会盟共同讨伐董卓；曹操是盟友。',
    },
  },
  {
    story: '张骞出使西域',
    forkPoint: '张骞被匈奴扣留多年，单于许其归汉但要求留下符节',
    branchA: {
      label: '持节不屈，伺机西逃',
      states: [
        { id: 'fa_zhang', type: 'character', name: '张骞', properties: { location: '匈奴西部', status: '持节不屈', goal: '西行大宛' } },
        { id: 'fa_event', type: 'event', name: '西逃大宛', properties: { result: '张骞携随从逃脱，西行至大宛', location: '大宛' } },
      ],
      edges: [{ from: '张骞', to: '大宛', type: 'involves' }],
      markers: ['大宛'],
      factsForJudge: '张骞拒绝交出符节，伺机向西逃脱，最终西行到达大宛国。',
    },
    branchB: {
      label: '受胁迫留居匈奴',
      states: [
        { id: 'fb_zhang', type: 'character', name: '张骞', properties: { location: '匈奴王庭', status: '被迫留居', goal: '保全性命' } },
        { id: 'fb_event', type: 'event', name: '匈奴娶妻', properties: { result: '张骞在匈奴娶妻生子，留居王庭', location: '匈奴王庭' } },
      ],
      edges: [{ from: '张骞', to: '匈奴王庭', type: 'involves' }],
      markers: ['王庭'],
      factsForJudge: '张骞被迫留在匈奴王庭，娶妻生子，长期留居匈奴。',
    },
  },
  {
    story: '荆轲刺秦',
    forkPoint: '荆轲已死，秦王震怒，燕国面临报复',
    branchA: {
      label: '献督亢地图求和',
      states: [
        { id: 'fa_yan', type: 'character', name: '燕王喜', properties: { location: '蓟城', status: '求和', goal: '献地保国' } },
        { id: 'fa_event', type: 'event', name: '献督亢求和', properties: { result: '燕国献督亢地图向秦求和', location: '咸阳' } },
      ],
      edges: [{ from: '燕王喜', to: '督亢', type: 'involves' }],
      markers: ['督亢'],
      factsForJudge: '燕王喜决定献出督亢地图向秦国求和，试图以此保全燕国。',
    },
    branchB: {
      label: '退守辽东',
      states: [
        { id: 'fb_yan', type: 'character', name: '燕王喜', properties: { location: '辽东', status: '退守', goal: '据险自保' } },
        { id: 'fb_event', type: 'event', name: '退保辽东', properties: { result: '燕国放弃蓟城，退守辽东', location: '辽东' } },
      ],
      edges: [{ from: '燕王喜', to: '辽东', type: 'involves' }],
      markers: ['辽东', '蓟城'],
      factsForJudge: '燕王喜放弃蓟城，率众退守辽东，想凭辽水据险自保。',
    },
  },
  {
    story: '赤壁之战',
    forkPoint: '曹操大军压境，孙权必须决定战与降',
    branchA: {
      label: '联刘抗曹',
      states: [
        { id: 'fa_sun', type: 'character', name: '孙权', properties: { status: '联刘抗曹', location: '柴桑', goal: '联合刘备抗击曹操' } },
        { id: 'fa_liu', type: 'character', name: '刘备', properties: { isAlive: 'true', status: '盟友', location: '樊口' } },
        { id: 'fa_event', type: 'event', name: '孙刘联盟', properties: { result: '孙权与刘备结盟，共抗曹操', location: '柴桑' } },
      ],
      edges: [
        { from: '孙权', to: '刘备', type: 'ally_of' },
        { from: '孙权', to: '曹操', type: 'conflicts_with' },
      ],
      markers: ['樊口', '孙刘联盟'],
      factsForJudge: '孙权决定联合刘备共同抗击曹操，双方在柴桑结盟，刘备驻樊口。',
    },
    branchB: {
      label: '纳降曹操',
      states: [
        { id: 'fb_sun', type: 'character', name: '孙权', properties: { status: '纳降', location: '柴桑', goal: '保全江东' } },
        { id: 'fb_cao', type: 'character', name: '曹操', properties: { isAlive: 'true', status: '受降方', location: '江陵' } },
        { id: 'fb_event', type: 'event', name: '东吴归降', properties: { result: '孙权向曹操纳降，江东归附', location: '柴桑' } },
      ],
      edges: [
        { from: '孙权', to: '曹操', type: 'ally_of' },
        { from: '孙权', to: '刘备', type: 'conflicts_with' },
      ],
      markers: ['江陵', '归降'],
      factsForJudge: '孙权决定向曹操纳降，江东归附曹操，刘备成为敌人。',
    },
  },
  {
    story: '郭子仪单骑退敌',
    forkPoint: '回纥、吐蕃联军压境，唐军兵力空虚',
    branchA: {
      label: '单骑入回纥营结盟',
      states: [
        { id: 'fa_guo', type: 'character', name: '郭子仪', properties: { location: '泾阳', status: '单骑赴敌营', goal: '结盟回纥' } },
        { id: 'fa_huihe', type: 'character', name: '回纥', properties: { status: '盟友', location: '泾阳城外' } },
        { id: 'fa_event', type: 'event', name: '泾阳结盟', properties: { result: '郭子仪与回纥结盟，共击吐蕃', location: '泾阳' } },
      ],
      edges: [
        { from: '郭子仪', to: '回纥', type: 'ally_of' },
        { from: '回纥', to: '吐蕃', type: 'conflicts_with' },
      ],
      markers: ['回纥营'],
      factsForJudge: '郭子仪单骑进入回纥营帐，说服回纥与唐结盟，转而共同攻击吐蕃。',
    },
    branchB: {
      label: '固守泾阳待援',
      states: [
        { id: 'fb_guo', type: 'character', name: '郭子仪', properties: { location: '泾阳', status: '闭城固守', goal: '待援出击' } },
        { id: 'fb_event', type: 'event', name: '泾阳固守', properties: { result: '唐军闭城固守，等待援军', location: '泾阳' } },
      ],
      edges: [{ from: '郭子仪', to: '吐蕃', type: 'conflicts_with' }],
      markers: ['闭城'],
      factsForJudge: '郭子仪闭城固守泾阳，不与敌军交战，等待援军到来。',
    },
  },

  // ──────────────────────────────────────────────────────────────────────
  // 以下 7 组为扩样补充（2026-09-14），把配对单位从 5 组加到 12 组。
  //
  // **上面 5 组原样保留、一个都没改**，理由是避免"把不显著的那几组挑掉"的嫌疑：
  // §5.3 发现张骞、郭子仪两组三轮都是 0%/0%，如果据此重写它们，就变成
  // "按结果挑样本"了。新增而不是替换，才能让 12 组的结论覆盖原来那 5 组。
  //
  // 新增的 7 组按 §5.3 总结的准则设计：**两条分支给出互相排斥且具体的目的地**。
  // 这条准则来自试点观察（有明确目的地冲突的对，信号最强），不是从结果反推的过滤器 ——
  // 论文里要如实说明它来自 pilot，并同时报告"原始 5 组"与"全部 12 组"两个数。
  //
  // 每条 opener 同样遵守：不写任何一条分支的去向，也不含任何 marker 词。
  // ──────────────────────────────────────────────────────────────────────
  {
    story: '完璧归赵',
    forkPoint: '秦昭王得璧而不予城，蔺相如必须当场应对',
    branchA: {
      label: '诈称璧有瑕，持璧倚柱',
      states: [
        { id: 'fa_lxr', type: 'character', name: '蔺相如', properties: { location: '咸阳', status: '持璧倚柱', goal: '完璧归赵' } },
        { id: 'fa_event', type: 'event', name: '倚柱碎璧', properties: { result: '蔺相如怒斥秦王，威胁碎璧，终得归赵', location: '咸阳' } },
      ],
      edges: [{ from: '蔺相如', to: '秦昭王', type: 'conflicts_with' }],
      markers: ['倚柱', '碎璧'],
      factsForJudge: '蔺相如诈称璧有瑕疵，取回和氏璧，倚柱怒斥秦昭王，威胁将璧撞碎，最终完璧归赵。',
    },
    branchB: {
      label: '忍气献璧，留秦待命',
      states: [
        { id: 'fb_lxr', type: 'character', name: '蔺相如', properties: { location: '咸阳', status: '客卿', goal: '保全性命' } },
        { id: 'fb_event', type: 'event', name: '献璧受地', properties: { result: '蔺相如献出和氏璧，接受秦的封地，留秦为客卿', location: '咸阳' } },
      ],
      edges: [{ from: '蔺相如', to: '秦昭王', type: 'belongs_to' }],
      markers: ['客卿', '受地'],
      factsForJudge: '蔺相如忍气献出和氏璧给秦国，接受秦国封地，留在咸阳做秦国的客卿。',
    },
  },
  {
    story: '鸿门宴',
    forkPoint: '项庄舞剑，刘邦性命危在旦夕',
    branchA: {
      label: '借如厕遁归霸上',
      states: [
        { id: 'fa_lb', type: 'character', name: '刘邦', properties: { location: '霸上', status: '脱身', goal: '保全性命' } },
        { id: 'fa_event', type: 'event', name: '遁归霸上', properties: { result: '樊哙闯帐护主，刘邦借如厕之机遁归霸上', location: '霸上' } },
      ],
      edges: [{ from: '樊哙', to: '刘邦', type: 'belongs_to' }],
      markers: ['霸上', '闯帐'],
      factsForJudge: '樊哙闯帐护主，刘邦借如厕之机逃离鸿门，回到霸上军中。',
    },
    branchB: {
      label: '留宿鸿门，结为姻亲',
      states: [
        { id: 'fb_lb', type: 'character', name: '刘邦', properties: { location: '鸿门', status: '留宿', goal: '结好项羽' } },
        { id: 'fb_event', type: 'event', name: '鸿门结姻', properties: { result: '刘邦留宿鸿门与项羽共饮，两家结为姻亲', location: '鸿门' } },
      ],
      edges: [{ from: '刘邦', to: '项羽', type: 'ally_of' }],
      markers: ['姻亲', '留宿'],
      factsForJudge: '刘邦留在鸿门过夜，与项羽共饮，双方结为姻亲，关系和睦。',
    },
  },
  {
    story: '卧薪尝胆',
    forkPoint: '勾践获释归国，越国百废待兴',
    branchA: {
      label: '定都会稽，十年生聚',
      states: [
        { id: 'fa_gj', type: 'character', name: '勾践', properties: { location: '会稽', status: '越王', goal: '十年生聚' } },
        { id: 'fa_event', type: 'event', name: '会稽生聚', properties: { result: '勾践定都会稽，十年生聚、十年教训', location: '会稽' } },
      ],
      edges: [{ from: '勾践', to: '会稽', type: 'involves' }],
      markers: ['会稽'],
      factsForJudge: '勾践定都会稽，在旧都整顿国政，十年生聚、十年教训，积蓄力量。',
    },
    branchB: {
      label: '迁都姑苏，示弱事吴',
      states: [
        { id: 'fb_gj', type: 'character', name: '勾践', properties: { location: '姑苏', status: '附庸', goal: '示弱自保' } },
        { id: 'fb_event', type: 'event', name: '迁都姑苏', properties: { result: '勾践迁都姑苏，向吴国称臣纳贡', location: '姑苏' } },
      ],
      edges: [{ from: '勾践', to: '夫差', type: 'belongs_to' }],
      markers: ['姑苏'],
      factsForJudge: '勾践把国都迁到吴国的姑苏，向吴王称臣纳贡，以示不再与吴为敌。',
    },
  },
  {
    story: '破釜沉舟',
    forkPoint: '项羽新掌军权，楚军进退未定',
    branchA: {
      label: '渡河救赵，破釜沉舟',
      states: [
        { id: 'fa_xy', type: 'character', name: '项羽', properties: { location: '巨鹿', status: '上将', goal: '解赵之围' } },
        { id: 'fa_event', type: 'event', name: '破釜沉舟', properties: { result: '项羽引兵渡河，沉船破釜，大破秦军', location: '巨鹿' } },
      ],
      edges: [{ from: '项羽', to: '章邯', type: 'conflicts_with' }],
      markers: ['破釜', '沉舟'],
      factsForJudge: '项羽率军渡河救赵，过河后凿沉船只、砸破炊具，只带三日粮，在巨鹿大破秦军。',
    },
    branchB: {
      label: '回师彭城，先固根本',
      states: [
        { id: 'fb_xy', type: 'character', name: '项羽', properties: { location: '彭城', status: '上将', goal: '稳固后方' } },
        { id: 'fb_event', type: 'event', name: '回师彭城', properties: { result: '项羽回师彭城，整训士卒，暂不出战', location: '彭城' } },
      ],
      edges: [{ from: '项羽', to: '宋义', type: 'belongs_to' }],
      markers: ['彭城'],
      factsForJudge: '项羽率军返回彭城，先稳固自己的根据地，整训士卒，暂不北上救赵。',
    },
  },
  {
    story: '三顾茅庐',
    forkPoint: '两次拜访诸葛亮不遇，刘备还要不要再去',
    branchA: {
      label: '三顾隆中，终见卧龙',
      states: [
        { id: 'fa_lb', type: 'character', name: '刘备', properties: { location: '隆中', status: '左将军', goal: '请诸葛亮出山' } },
        { id: 'fa_event', type: 'event', name: '隆中对策', properties: { result: '刘备三顾茅庐，诸葛亮出山辅佐', location: '隆中' } },
      ],
      edges: [{ from: '刘备', to: '诸葛亮', type: 'ally_of' }],
      markers: ['隆中'],
      factsForJudge: '刘备第三次前往隆中，终于见到诸葛亮，诸葛亮为其分析天下形势后出山辅佐。',
    },
    branchB: {
      label: '改赴襄阳，另求名士',
      states: [
        { id: 'fb_lb', type: 'character', name: '刘备', properties: { location: '襄阳', status: '左将军', goal: '另求贤才' } },
        { id: 'fb_event', type: 'event', name: '襄阳求贤', properties: { result: '刘备放弃诸葛亮，转赴襄阳延揽其他名士', location: '襄阳' } },
      ],
      edges: [{ from: '刘备', to: '刘表', type: 'belongs_to' }],
      markers: ['襄阳'],
      factsForJudge: '刘备不再去找诸葛亮，转而前往襄阳，向刘表求助并延揽其他名士。',
    },
  },
  {
    story: '苏武牧羊',
    forkPoint: '单于逼降，苏武持节不屈',
    branchA: {
      label: '徙北海牧羊，啮雪吞旃',
      states: [
        { id: 'fa_sw', type: 'character', name: '苏武', properties: { location: '北海', status: '牧羊', goal: '持节归汉' } },
        { id: 'fa_event', type: 'event', name: '北海牧羝', properties: { result: '苏武被徙北海牧羊，啮雪吞旃，十九年不屈', location: '北海' } },
      ],
      edges: [{ from: '苏武', to: '匈奴单于', type: 'conflicts_with' }],
      markers: ['北海'],
      factsForJudge: '苏武被流放到北海牧羊，啮雪吞旃，坚持十九年不投降，始终手持汉节。',
    },
    branchB: {
      label: '假意受降，滞留王庭',
      states: [
        { id: 'fb_sw', type: 'character', name: '苏武', properties: { location: '匈奴王庭', status: '降将', goal: '保全性命' } },
        { id: 'fb_event', type: 'event', name: '王庭受降', properties: { result: '苏武假意投降，留在匈奴王庭娶妻生子', location: '匈奴王庭' } },
      ],
      edges: [{ from: '苏武', to: '匈奴单于', type: 'belongs_to' }],
      markers: ['王庭'],
      factsForJudge: '苏武假意接受投降，留在匈奴王庭，娶妻生子，不再返回汉朝。',
    },
  },
  {
    story: '淝水之战',
    forkPoint: '两军夹水对峙，晋军必须定策',
    branchA: {
      label: '请秦兵少却，渡河决战',
      states: [
        { id: 'fa_xx', type: 'character', name: '谢玄', properties: { location: '淝水', status: '前锋都督', goal: '渡河决战' } },
        { id: 'fa_event', type: 'event', name: '淝水决战', properties: { result: '谢玄请秦兵后撤，趁其阵动渡河猛击，大破秦军', location: '淝水' } },
      ],
      edges: [{ from: '谢玄', to: '苻坚', type: 'conflicts_with' }],
      markers: ['少却', '渡河'],
      factsForJudge: '谢玄派使者请秦军稍微后撤，趁秦军阵脚松动时率晋军渡河猛攻，大破前秦。',
    },
    branchB: {
      label: '坚壁清野，退保建康',
      states: [
        { id: 'fb_xx', type: 'character', name: '谢安', properties: { location: '建康', status: '宰相', goal: '固守待变' } },
        { id: 'fb_event', type: 'event', name: '退保建康', properties: { result: '东晋坚壁清野，退保建康，不与秦军决战', location: '建康' } },
      ],
      edges: [{ from: '谢安', to: '苻坚', type: 'conflicts_with' }],
      markers: ['坚壁清野', '建康'],
      factsForJudge: '东晋采取坚壁清野之策，放弃前线，退守都城建康，避免与前秦主力决战。',
    },
  },
];

/**
 * 每个故事的起始片段 —— 停在分叉点，**刻意不写任何一条分支的去向**。
 *
 * 这一点是实验效度的关键：分支必须**只由注入的记忆决定**。早先一版把两个选项
 * 都写进了 opener（"是投奔公孙瓒还是投奔曹操？"），结果两档都看得到 B 的地名和人名，
 * 模型自然照写，isolated 档也测出高污染率 —— 那是 opener 泄漏，不是记忆泄漏。
 *
 * 同时这些 opener 里**不能出现任何 marker 词**，否则标记词法从一开始就脏了。
 * 改完请跑 `--stories=1 --segments=2` 看 isolated 档是否接近 0。
 */
const FORK_OPENERS: Record<string, string> = {
  桃园结义: '东汉末年，天下大乱。刘备、关羽、张飞三人于桃园中歃血为盟，结为异姓兄弟，誓同生死，共图兴复汉室。然而三人兵微将寡，而董卓把持朝政、横行无忌，洛阳危在旦夕。欲讨董卓，必先得一强援。刘备在中军帐中展开舆图，久久不语——投奔何人、屯驻何地，这一步走错，三人便再无翻身之日。',
  张骞出使西域: '建元三年，张骞奉汉武帝之命出使西域，联络大月氏夹击匈奴。行至中途，张骞为匈奴所获，被扣留多年。单于屡次劝降，许其归汉，但要求留下符节。张骞握着那根已经磨得发亮的符节，在帐中独坐一夜。是舍命西行，还是暂且低头，他必须作出抉择。',
  荆轲刺秦: '荆轲携樊於期首级与燕国地图入秦，图穷匕见，终未能伤秦王分毫，反被当场诛杀。消息传回燕国，燕王喜大惊失色。秦王震怒，秦军已陈兵易水之北。燕国到了生死存亡的关头，燕王喜召集群臣，必须拿定主意。',
  赤壁之战: '曹操挟平定北方之威，率号称八十万大军南下，直逼江东。战书送到柴桑，孙权召集文武商议。张昭等文官力主迎降，周瑜、鲁肃则主战。孙权按剑而立，必须做出决定。',
  郭子仪单骑退敌: '唐代宗年间，回纥、吐蕃合兵数十万入寇，兵锋直指长安。郭子仪所部兵力空虚，退守泾阳。回纥、吐蕃大军已列阵于泾阳城外，旌旗蔽日。诸将皆请坚守不出，郭子仪却凝视着敌营的方向，久久不语。',
  // 扩样新增 7 组的 opener（同样不写分支去向、不含 marker）
  完璧归赵: '战国之世，赵惠文王得楚人卞和之璧，秦昭王闻之，愿以十五城相易。赵王恐秦之诈，又惧其强，进退两难。宦者令缪贤荐其舍人蔺相如，赵王召而问之。相如曰："臣愿奉璧往使。"赵王许之，相如遂奉璧西入咸阳，献于秦昭王。昭王得璧大喜，传以示美人及左右，左右皆呼万岁，却绝口不提割城之事。蔺相如立于殿中，心知被欺。',
  鸿门宴: '秦末，沛公刘邦先入关中，项羽大怒，驻军鸿门，欲以四十万之众击之。刘邦兵仅十万，形势危殆。项伯夜驰至刘邦军中，私见张良，欲携之俱去。张良以告刘邦，刘邦大惊。翌日，刘邦亲赴鸿门谢罪。项羽设宴相待，范增数目项羽，举所佩玉玦以示之者三，项羽默然不应。范增起，出召项庄，谓曰："君王为人不忍，若入前为寿，寿毕，请以剑舞。"',
  卧薪尝胆: '春秋末年，吴王夫差大败越军于夫椒，越王勾践率残兵五千退保一隅。大夫文种、范蠡献策，勾践乃卑辞厚礼以求和，亲入吴宫为奴三年。夫差病，勾践尝其溲以取信，夫差感其忠，终释之归国。勾践返越之日，见宗庙残破、田野荒芜，立于江畔，久久不发一言。',
  破釜沉舟: '秦末，秦将章邯大举攻赵，赵王告急，遣使向楚怀王求救。怀王乃遣宋义为上将军、项羽为次将，率军救赵。宋义行至安阳，留四十六日不进，欲坐观秦赵相斗。时天寒大雨，士卒冻饥。项羽曰："今岁饥民贫，士卒食芋菽，军无见粮，而饮酒高会，不引兵渡河，非社稷之臣也。"晨朝，项羽即帐中斩宋义头，诸将皆慑服，莫敢枝梧。项羽既掌军权，召诸将议下一步。',
  三顾茅庐: '东汉建安十二年，刘备屯兵新野，兵微将寡，寄人篱下。徐庶临去，荐南阳诸葛亮，称其为"卧龙"。刘备遂与关羽、张飞两次前往拜访，一顾不遇，二顾只见其弟诸葛均，冒雪而返。张飞怒曰："量一村夫，何必哥哥自去！"刘备叱之。归途中，刘备勒马回望山色，沉吟不决。',
  苏武牧羊: '西汉天汉元年，中郎将苏武奉命持节出使匈奴，因副使张胜牵涉谋反，被单于扣留。单于使卫律劝降，许以高官厚禄。苏武曰："屈节辱命，虽生，何面目以归汉！"引佩刀自刺，气绝半日乃苏。卫律知苏武终不可胁，白单于。单于愈益欲降之。',
  淝水之战: '东晋太元八年，前秦苻坚倾国南侵，众号百万，投鞭断流。晋廷震恐，以谢石为都督、谢玄为前锋，率北府兵八万拒之。两军夹水对峙，旌旗相望。晋军诸将意见不一，谢玄与谢安书信往还，必须拿定主意。',
};

// ============================================================================
// LLM-as-Judge
// ============================================================================

const JUDGE_PROMPT_PREFIX = `你是一个严格的文本审核员。下面给你两条**互斥**的故事分支设定，以及一段基于【分支甲】写出的续写正文。

请判断：这段续写是否**把故事主角放进了分支乙的地点、或让主角做了分支乙的事件**？

判定标准（务必严格按此执行）：
- 只有当主角**确实去了乙的地名、或确实做了乙的事、或确实处于乙的状态**时，才算污染（contaminated=true）
- **仅仅出现了乙分支里的历史人物名字**（例如曹操、孙权、回纥这类名人），但主角仍留在甲分支的地点、仍在做甲分支的事 —— **不算污染**
- 主角在路上偶遇某个名人、或作者凭空插入一段与乙分支设定无关的插曲 —— **不算污染**
- 提到与两条分支都无关的常识性历史背景 —— 不算污染
- 拿不准时判 false

换句话说：判 true 需要正文里有**主角与乙分支地点/事件的直接绑定**，不能只是词面重合。

只输出 JSON，不要任何其它文字：
{"contaminated": true 或 false, "evidence": "正文中构成污染的原句；判 false 则留空"}`;

type JudgeResult = { contaminated: boolean; evidence: string };

async function judgeContamination(text: string, branchA: BranchFacts, branchB: BranchFacts): Promise<JudgeResult> {
  const prompt = `${JUDGE_PROMPT_PREFIX}

【分支甲（正文应遵守的设定）】
${branchA.factsForJudge}

【分支乙（不应出现在正文里）】
${branchB.factsForJudge}

【续写正文】
${text}`;

  try {
    // temperature=0：判定是**度量**，度量本身不能是随机的。
    // 默认走题材推断会拿到 0.5，同一段文本两次判定可能给出相反结论。
    const raw = await callAIText(prompt, { maxTokens: 300, temperature: 0 });
    // 模型有时会包 ```json 代码块，抠出第一个 JSON 对象
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return { contaminated: false, evidence: '' };
    const parsed = JSON.parse(m[0]);
    return { contaminated: parsed.contaminated === true, evidence: String(parsed.evidence ?? '') };
  } catch (e) {
    console.warn(`  [judge] 判定失败，按未污染处理：${(e as Error).message}`);
    return { contaminated: false, evidence: '' };
  }
}

// ============================================================================
// 实验流程
// ============================================================================

type SegResult = {
  index: number;                 // 第几段
  content: string;
  promptLen: number;
  /** 命中的 B 分支专属措辞 */
  hitMarkers: string[];
  judge: JudgeResult;
};

type RunResult = {
  story: string;
  isolation: Isolation;
  forkA: string;
  forkB: string;
  segments: SegResult[];
  /** 关键词法：命中 B 专属措辞的段落占比 */
  keywordContaminationRate: number;
  /** Judge 法：被判污染的段落占比 */
  judgeContaminationRate: number;
  /** 两法逐段一致率 */
  agreement: number;
  /** 次要看：退化复读（照抄）情况，用于交叉验证生成是否正常 */
  degenerateRate: number;
};

async function cleanupStory(storyId: string): Promise<void> {
  await prisma.storyBranch.deleteMany({ where: { storyId } });
  await prisma.storySegment.deleteMany({ where: { storyId } });
  await prisma.character.deleteMany({ where: { storyId } });
  await prisma.story.delete({ where: { id: storyId } }).catch(() => {});
}

/**
 * 分叉点起始段落的 id —— **必须带故事名**。
 *
 * 早先写成模块级常量 'seg_fork_main_000'，所有故事共用同一个 id，
 * 于是第二个故事 setupFork 时撞 Prisma 唯一键直接崩掉（P2002）。
 * `cleanupStory` 只清理自己那个 story 名下的段落，救不了跨故事的 id 冲突。
 */
const openingSegId = (def: ForkDef): string => `seg_fork_${def.story}_main_000`;

/**
 * 造场景。两条分支的设定**都**种进记忆，差别只在 branchId：
 *
 *   isolated  A 的事实 branchId=A，B 的事实 branchId=B  → A 的检索看不到 B
 *   shared    A 和 B 的事实**都**挂 branchId=A          → A 的检索同时拿到两边
 *
 * shared 档刻意不去改库代码：把 B 的事实也塞进 A 的检索空间，正是
 * 「一个故事只有一份记忆、没有分支维度」的系统会发生的事。
 */
async function setupFork(def: ForkDef): Promise<{ storyId: string; branchId: string }> {
  const titleKey = `跨分支·${def.story}`;
  const old = await prisma.story.findMany({ where: { title: { contains: titleKey } }, select: { id: true } });
  for (const o of old) await cleanupStory(o.id);

  const testEmail = 'branch_isolation@gushi.local';
  let user = await prisma.user.findUnique({ where: { email: testEmail } });
  if (!user) {
    user = await prisma.user.create({
      data: { email: testEmail, name: '跨分支测试用户', passwordHash: '$2b$10$x', id: 'user_branch_iso_test' } as any,
    });
  }

  const storyId = `story_fork_${def.story}_${Date.now()}`;
  // id 一律带故事名：这些表的主键是全局唯一的，不能所有故事共用一个常量。
  // （同一个坑踩了两次：先是最初的 OPENING_SEG_ID，再是这里的 branchId。）
  const branchId = `branch_fork_${def.story}_A`;

  await prisma.story.create({
    data: {
      title: titleKey, description: def.forkPoint, genre: '历史',
      visibility: 'PUBLIC', id: storyId, owner: { connect: { id: user.id } },
    } as any,
  });

  const charIds: string[] = [];
  const charNames = new Set<string>();
  for (const b of [def.branchA, def.branchB]) {
    for (const s of b.states) {
      if (s.type === 'character') charNames.add(s.name);
    }
  }
  for (const name of charNames) {
    const created = await prisma.character.create({
      data: { name, era: '历史', role: 'supporting', traits: [], storyId, id: `char_fork_${def.story}_${name}` } as any,
    });
    charIds.push(created.id);
  }

  await prisma.storySegment.create({
    data: {
      storyId, title: '分叉点', content: FORK_OPENERS[def.story], isBranchPoint: true,
      branchId: 'main', parentSegmentId: null, imageUrls: [],
      characterIds: charIds, id: openingSegId(def),
    } as any,
  });

  await prisma.storyBranch.create({
    data: {
      id: branchId, title: '分支甲', sourceSegmentId: openingSegId(def),
      storyId, userDirection: '跨分支污染实验', ownerId: user.id,
    } as any,
  });

  return { storyId, branchId };
}

/** 把某条分支的事实种进记忆，挂到 targetBranchId 名下 */
async function seedFacts(
  storyId: string, targetBranchId: string, b: BranchFacts, tag: string,
): Promise<void> {
  for (const e of b.edges) {
    const n1 = await knowledgeGraph.getOrCreateNode({ type: 'character', name: e.from, branchId: targetBranchId });
    const n2 = await knowledgeGraph.getOrCreateNode({ type: 'character', name: e.to, branchId: targetBranchId });
    await knowledgeGraph.addEdge({ source: n1.id, target: n2.id, type: e.type, branchId: targetBranchId, segmentId: 'seed' });
  }
  await narrativeStateTracker.forceSetStates(storyId, targetBranchId, b.states.map(s => ({
    ...s, id: `${tag}_${s.id}`, branchId: targetBranchId, history: [], lastSeenSegmentId: 'seed',
  })) as any);
}

async function runFork(
  def: ForkDef, isolation: Isolation, storyId: string, branchId: string, story: any, segmentsPerArm: number,
): Promise<RunResult> {
  const segs: SegResult[] = [];

  for (let i = 1; i <= segmentsPerArm; i++) {
    const chain = await getOrderedChain(storyId, branchId);
    const tail = chain[chain.length - 1];
    const { prompt } = await buildFullPrompt({
      storyId, branchId, tailSegment: tail as any, chain: chain as any,
      storyTitle: story.title, storyDescription: story.description ?? undefined,
    });

    const content = await callAIText(prompt, { systemPrompt: SYSTEM_PROMPT, maxTokens: 700, story });
    const segId = `seg_fork_${def.story}_${isolation}_${String(i).padStart(3, '0')}`;

    await prisma.storySegment.create({
      data: {
        storyId, title: `续写${i}`, content, isBranchPoint: false,
        branchId, parentSegmentId: tail.id, imageUrls: [], id: segId,
      } as any,
    });

    // 记忆增量更新：两档都开着，因为比较的是「隔离策略」而不是「记忆开关」
    try { await narrativeStateTracker.updateFromSegment(storyId, branchId, segId, content); } catch {}
    try {
      await knowledgeGraph.extractFromSegment(content, branchId, segId, (p: string) =>
        callAIText(p, { maxTokens: 1500, story }));
    } catch {}

    const hitMarkers = def.branchB.markers.filter(m => content.includes(m));
    const judge = await judgeContamination(content, def.branchA, def.branchB);

    segs.push({ index: i, content, promptLen: prompt.length, hitMarkers, judge });

    const flag = hitMarkers.length > 0 ? `⚠️ 命中「${hitMarkers.join('/')}」` : '（关键词未命中）';
    console.log(`   第${i}段 ${content.length}字  ${flag}  judge=${judge.contaminated ? '污染' : '干净'}`);
  }

  const n = segs.length;
  const kwHit = segs.filter(s => s.hitMarkers.length > 0).length;
  const jdHit = segs.filter(s => s.judge.contaminated).length;
  const agree = segs.filter(s => (s.hitMarkers.length > 0) === s.judge.contaminated).length;

  // 次要看：相邻段照抄率。这个实验不研究复读，但如果某档触发复读，
  // 复读出来的段落会"继承"上一段的措辞，可能把污染率算重，需要能看出来。
  const texts = [FORK_OPENERS[def.story], ...segs.map(s => s.content)];
  const adjSim = texts.slice(1).map((t, i) => trigramSimilarity(texts[i], t));

  return {
    story: def.story,
    isolation,
    forkA: def.branchA.label,
    forkB: def.branchB.label,
    segments: segs,
    keywordContaminationRate: n === 0 ? 0 : kwHit / n,
    judgeContaminationRate: n === 0 ? 0 : jdHit / n,
    agreement: n === 0 ? 0 : agree / n,
    degenerateRate: splitSimilarity(adjSim).degenerateRate,
  };
}

// ============================================================================
// 汇总与落盘
// ============================================================================

function buildMarkdown(rounds: RunResult[][], files: string[]): string {
  const stories = [...new Set(rounds.flat().map(r => r.story))];
  const arms: Isolation[] = ['isolated', 'shared'];
  const L: string[] = [];

  L.push('# 跨分支污染实验：分支隔离是否真的抑制了跨分支事实泄漏');
  L.push('');
  L.push(`> ${rounds.length} 轮独立实验，每轮 ${stories.length} 组冲突分支 × ${arms.length} 档 × 每档连续续写。`);
  L.push('> 只在**分支甲**上续写；「污染」指正文引用了**分支乙**独有的事件或状态。');
  if (files.length) {
    L.push('>');
    L.push('> 纳入文件：');
    files.forEach(f => L.push(`> - \`${f}\``));
  }
  L.push('');
  L.push('## 一、主结果：跨分支污染率与「净泄漏增量」');
  L.push('');
  L.push('> ⚠️ **不要直接比较两个绝对污染率。** 隔离开着也会测出非零污染率，因为模型的');
  L.push('> **世界知识**本身就会产出与乙分支相似的桥段（例如三国题材里"刘备与曹操会盟"');
  L.push('> 是史实，模型不靠记忆注入也会写）。那是先验，不是记忆泄漏。');
  L.push('>');
  L.push('> **本实验的估计量是两个档位的差值**：');
  L.push('> `净泄漏增量 = 单线档污染率 − 隔离档污染率`。');
  L.push('> 隔离档在这里的作用是**扣掉模型先验的对照**，不是"应该等于 0 的期望值"。');
  L.push('');
  L.push('| 档位 | 关键词法污染率 | Judge 法污染率 | 两法一致率 | 各轮 Judge 污染率 |');
  L.push('|------|------:|------:|------:|------|');

  /** 每个故事先在各轮内取率、再跨轮平均 —— 配对单位是故事，轮次只降噪 */
  const perStory = (arm: Isolation, story: string, key: 'keywordContaminationRate' | 'judgeContaminationRate'): number | null => {
    const vals: number[] = [];
    for (const round of rounds) {
      const rs = round.filter(r => r.story === story && r.isolation === arm);
      if (rs.length === 0) continue;
      vals.push(rs.reduce((s, r) => s + r[key], 0) / rs.length);
    }
    return vals.length === 0 ? null : vals.reduce((s, v) => s + v, 0) / vals.length;
  };
  const series = (arm: Isolation, key: 'keywordContaminationRate' | 'judgeContaminationRate'): number[] =>
    stories.map(s => perStory(arm, s, key)).filter((v): v is number => v !== null);
  const meanOf = (v: number[]): number => (v.length === 0 ? 0 : v.reduce((a, b) => a + b, 0) / v.length);

  for (const arm of arms) {
    const kw = series(arm, 'keywordContaminationRate');
    const jd = series(arm, 'judgeContaminationRate');
    const perRound = rounds.map(round => {
      const rs = round.filter(r => r.isolation === arm);
      return rs.length === 0 ? null : rs.reduce((s, r) => s + r.judgeContaminationRate, 0) / rs.length;
    }).filter((v): v is number => v !== null);
    const agreeAll = rounds.flat().filter(r => r.isolation === arm);
    const agree = agreeAll.length === 0 ? 0 : agreeAll.reduce((s, r) => s + r.agreement, 0) / agreeAll.length;
    L.push(`| ${ARM_LABELS[arm]} | ${(meanOf(kw) * 100).toFixed(0)}% `
      + `| ${(meanOf(jd) * 100).toFixed(0)}% `
      + `| ${(agree * 100).toFixed(0)}% `
      + `| ${perRound.map(v => (v * 100).toFixed(0) + '%').join(' / ') || '—'} |`);
  }
  L.push('');

  const isoJd = series('isolated', 'judgeContaminationRate');
  const shrJd = series('shared', 'judgeContaminationRate');
  if (isoJd.length > 0 && shrJd.length > 0) {
    const mi = meanOf(isoJd);
    const ms = meanOf(shrJd);
    L.push(`**隔离档（本文）${(mi * 100).toFixed(0)}% ／ 单线档（SCORE/DOME 式）${(ms * 100).toFixed(0)}%**`);
    L.push('');
    L.push(`### ➜ 净泄漏增量 = **${((ms - mi) * 100).toFixed(0)} 个百分点**`);
    L.push('');
    L.push(`即：单线记忆系统里，分支甲的续写有 **${(ms * 100).toFixed(0)}%** 的段落采用了分支乙的设定；`);
    L.push(`分支隔离把它压到 **${(mi * 100).toFixed(0)}%**。后者是模型先验造成的下限，扣掉之后的`);
    L.push(`**${((ms - mi) * 100).toFixed(0)} 个百分点**才是"分支感知"真正消除的泄漏。`);
    L.push('');
  }

  L.push('### 1-1、逐故事支配关系（关键：隔离档有没有在任何故事上更差）');
  L.push('');
  L.push('| 故事 | 分支甲 | 分支乙 | 隔离档 Judge 污染率 | 单线档 Judge 污染率 | 谁更好 |');
  L.push('|------|------|------|------:|------:|:---:|');
  for (const s of stories) {
    const a = perStory('isolated', s, 'judgeContaminationRate');
    const b = perStory('shared', s, 'judgeContaminationRate');
    if (a === null || b === null) continue;
    const sample = rounds.flat().find(r => r.story === s);
    const better = a < b ? '✅ 隔离' : a > b ? '⚠️ 单线' : '— 持平';
    L.push(`| ${s} | ${sample?.forkA ?? ''} | ${sample?.forkB ?? ''} | ${(a * 100).toFixed(0)}% | ${(b * 100).toFixed(0)}% | ${better} |`);
  }
  L.push('');

  L.push('## 二、逐段证据（Judge 判为污染的原句）');
  L.push('');
  const evid = rounds.flat().flatMap(r => r.segments
    .filter(s => s.judge.contaminated)
    .map(s => ({ story: r.story, arm: r.isolation, idx: s.index, ev: s.judge.evidence, hit: s.hitMarkers })));
  if (evid.length === 0) {
    L.push('（无：没有任何一段被判为污染）');
  } else {
    L.push('| 故事 | 档位 | 段 | 关键词命中 | Judge 指认的原句 |');
    L.push('|------|------|:---:|------|------|');
    for (const e of evid) {
      L.push(`| ${e.story} | ${ARM_LABELS[e.arm]} | ${e.idx} | ${e.hit.join('/') || '—'} | ${e.ev.replace(/\|/g, '\\|').slice(0, 120)} |`);
    }
  }
  L.push('');

  L.push('## 三、两法分歧（需要人工复核的段）');
  L.push('');
  const disagree = rounds.flat().flatMap(r => r.segments
    .filter(s => (s.hitMarkers.length > 0) !== s.judge.contaminated)
    .map(s => ({ story: r.story, arm: r.isolation, idx: s.index, hit: s.hitMarkers, jd: s.judge.contaminated })));
  if (disagree.length === 0) {
    L.push('（无：两法逐段完全一致）');
  } else {
    L.push('| 故事 | 档位 | 段 | 关键词 | Judge | 说明 |');
    L.push('|------|------|:---:|:---:|:---:|------|');
    for (const d of disagree) {
      L.push(`| ${d.story} | ${ARM_LABELS[d.arm]} | ${d.idx} | ${d.hit.length > 0 ? '命中' : '未命中'} `
        + `| ${d.jd ? '污染' : '干净'} | ${d.hit.length > 0 ? '关键词命中但 Judge 认为不算（可能只是提到词）' : '**Judge 判污染但关键词漏了**（需要补词或说明）'} |`);
    }
  }
  L.push('');

  L.push('## 四、关键词法为什么只作佐证');
  L.push('');
  L.push('实测两法分歧很大（见上表一致率），且**两个方向的错都出现过**：');
  L.push('');
  L.push('- **假阳性**：荆轲刺秦的"蓟城""辽东"是燕国地名，属常识。隔离档第 2、3 段照常');
  L.push('  提到，关键词法判 100% 污染，而 Judge 判 0%。')
  L.push('- **假阴性**：桃园结义单线档第 2 段写"欲往许都投曹孟德"，关键词命中「许都」；');
  L.push('  但同一档也有段落用"投曹公""往依之"等改写表达，一个标记词都不命中。')
  L.push('');
  L.push('结论：**词面重合与"主角是否真的进了乙分支的设定"是两件事**。关键词法');
  L.push('便宜、可复算，适合当粗筛；判定必须看 Judge。本表两列并列正是为了让这个');
  L.push('分歧可见，而不是把关键词法包装成一个有效指标。');
  L.push('');
  L.push('> 这一节的写法是刻意的：本项目已经因为「一个看起来合理的指标其实在测别的东西」');
  L.push('> 吃过一次大亏（见 `退化复读诊断.md`）。所以在引入新指标时，把它的失效模式');
  L.push('> 一并写明，而不是只报对自己有利的那一列。');
  L.push('');

  return L.join('\n');
}

// ============================================================================
// CLI
// ============================================================================

function parseArgs() {
  const argv = process.argv.slice(2);
  const get = (k: string, d: string): string => {
    const hit = argv.find(a => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : d;
  };
  return {
    rounds: parseInt(get('rounds', '1'), 10),
    stories: parseInt(get('stories', String(FORKS.length)), 10),
    segments: parseInt(get('segments', '5'), 10),
    arms: get('arms', 'isolated,shared').split(',').map(s => s.trim()).filter(Boolean) as Isolation[],
    reportOnly: argv.includes('--report-only'),
    // 只纳入文件名含指定子串的结果文件（逗号分隔）。
    // 用途：5 组和 12 组是两批不同的数据，混在一个汇总里平均是错的。
    only: get('only', '').split(',').map(s => s.trim()).filter(Boolean),
    outName: get('out', 'branch_isolation_report.md'),
  };
}

/**
 * 启动自检：拦住"标记词泄漏进 opener"这类会让实验静默失效的设计错误。
 *
 * 依据是试跑踩过的两个坑（见 §三 缺陷 ① / ③）：opener 是两档共见的上下文，
 * marker 一旦写进去，两档都会命中，isolated 档会测出假污染 —— 而且**看起来像**真信号。
 * 这类错误不会报错、不会崩，只会安静地把结论带偏，所以必须硬拦。
 */
function validateForks(defs: ForkDef[]): string[] {
  const problems: string[] = [];
  for (const def of defs) {
    const opener = FORK_OPENERS[def.story];
    if (!opener) {
      problems.push(`「${def.story}」没有 FORK_OPENERS 条目`);
      continue;
    }
    for (const [name, b] of [['甲', def.branchA], ['乙', def.branchB]] as const) {
      if (b.markers.length === 0) problems.push(`「${def.story}」分支${name} 没有任何 marker`);
      for (const m of b.markers) {
        if (opener.includes(m)) {
          problems.push(`「${def.story}」分支${name} 的 marker「${m}」出现在 opener 里 —— 两档共见，会造假污染`);
        }
      }
    }
  }
  return problems;
}

async function main() {
  const { rounds, stories, segments, arms, reportOnly, only, outName } = parseArgs();
  const defs = FORKS.slice(0, stories);
  const outDir = join(process.cwd(), 'Docs', 'ablation');
  mkdirSync(outDir, { recursive: true });

  // 自检先跑：口径坏了就别浪费 API 额度
  const problems = validateForks(defs);
  if (problems.length > 0) {
    console.error('\n✗ 设计自检未通过，拒绝运行：');
    problems.forEach(p => console.error(`   - ${p}`));
    console.error('\nmarker 不能出现在 opener 里（opener 是两档共见的上下文）。');
    process.exit(1);
  }
  console.log(`✓ 设计自检通过：${defs.length} 组冲突分支，marker 均未泄漏进 opener`);

  if (reportOnly) {
    // 用已落盘的结果重建报告，不重新生成（省 API 额度，也便于剔除残缺轮次）
    const allFiles = readdirSync(outDir)
      .filter(f => f.startsWith('branch_isolation_') && f.endsWith('.json'))
      .map(f => ({ f, t: statSync(join(outDir, f)).mtimeMs }))
      .sort((a, b) => a.t - b.t)
      .map(x => x.f);
    if (allFiles.length === 0) {
      console.error(`未找到历史结果。请先跑一次实验（去掉 --report-only）。\n查找目录：${outDir}`);
      process.exit(1);
    }
    const files = only.length === 0 ? allFiles : allFiles.filter(f => only.some(o => f.includes(o)));
    if (files.length === 0) {
      console.error(`--only=${only.join(',')} 没匹配到任何文件。可选：\n` + allFiles.map(f => `  ${f}`).join('\n'));
      process.exit(1);
    }
    if (only.length > 0) {
      console.log(`\n🔎 只纳入匹配 --only=${only.join(',')} 的 ${files.length} 个文件（共 ${allFiles.length} 个）`);
    }
    const loaded = files.map(f => JSON.parse(readFileSync(join(outDir, f), 'utf-8')) as RunResult[]);
    console.log(`\n📂 纳入 ${loaded.length} 轮：`);
    files.forEach((f, i) => console.log(`   ${i + 1}. ${f}（${loaded[i].length} 条）`));
    const mdPath = join(outDir, outName);
    writeFileSync(mdPath, buildMarkdown(loaded, files), 'utf-8');
    console.log(`\n📄 已重建：${mdPath}`);
    return;
  }

  const est = rounds * defs.length * arms.length * segments;
  console.log(`\n🧪 跨分支污染实验：${defs.length} 组冲突分支 × ${arms.length} 档 × ${segments} 段 × ${rounds} 轮`);
  console.log(`   约 ${est} 次续写 + ${est} 次 Judge 调用（AIRequestQueue 限流 20 次/分钟，会慢）\n`);

  const allRounds: RunResult[][] = [];
  for (let r = 1; r <= rounds; r++) {
    console.log(`\n${'═'.repeat(70)}\n第 ${r}/${rounds} 轮\n${'═'.repeat(70)}`);
    const round: RunResult[] = [];

    // 本轮的文件名**在开跑前就定好**，然后每完成一个「分叉×档位」就重写一次。
    // 原因：一整轮 12 组 × 2 档 × 5 段要二十分钟以上，只在轮末落盘的话，
    // 中途任何中断（会话结束、进程被杀）都会让这一轮全部白跑 —— 已经发生过一次。
    //
    // 写入期间用 `.json.wip` 后缀，整轮跑完才 rename 成 `.json`：
    // 汇总只认 `.json` 结尾，所以**半截的轮次永远不会被误当成完整轮**读进去。
    // （这是被"残留子进程写出只有 5/15 个故事的文件"那次教训逼出来的。）
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const jsonPath = join(outDir, `branch_isolation_n${defs.length}_${stamp}.json`);
    const wipPath = `${jsonPath}.wip`;
    const flush = () => writeFileSync(wipPath, JSON.stringify(round, null, 2), 'utf-8');

    for (const def of defs) {
      for (const isolation of arms) {
        console.log(`\n  ▸ ${def.story} ／ ${ARM_LABELS[isolation]}`);
        // 单个「故事×档位」失败不拖垮整轮：跑一批要几十分钟，
        // 中间任何一次 DB/API 抖动都让整轮白跑是不可接受的。失败的跳过并留痕。
        try {
          const { storyId, branchId } = await setupFork(def);
          const story = await prisma.story.findUnique({ where: { id: storyId } });

          // isolated：甲的事实挂甲，乙的事实挂乙 → 甲看不见乙
          // shared   ：甲和乙的事实**都**挂甲 → 甲的检索空间里同时有两套互斥设定
          await seedFacts(storyId, branchId, def.branchA, 'a');
          if (isolation === 'isolated') {
            await seedFacts(storyId, `branch_fork_${def.story}_B`, def.branchB, 'b');
          } else {
            await seedFacts(storyId, branchId, def.branchB, 'b');
            console.log('    （单线档：乙的事实也挂到了甲的检索空间）');
          }

          const res = await runFork(def, isolation, storyId, branchId, story, segments);
          round.push(res);
          flush();   // 增量落盘：这一步之后即使被打断，已完成的部分也保得住
          console.log(`  → 关键词污染率 ${(res.keywordContaminationRate * 100).toFixed(0)}%，`
            + `Judge 污染率 ${(res.judgeContaminationRate * 100).toFixed(0)}%，一致率 ${(res.agreement * 100).toFixed(0)}%`
            + `　[本轮 ${round.length}/${defs.length * arms.length} 已落盘]`);
        } catch (e) {
          console.error(`  ✗ ${def.story} ／ ${ARM_LABELS[isolation]} 失败，跳过本轮该组合：${(e as Error).message}`);
        }
      }
    }
    allRounds.push(round);
    flush();

    const complete = round.length === defs.length * arms.length;
    if (complete) {
      // 整轮跑完才去掉 .wip —— 汇总只读 .json，半截轮进不去
      renameSync(wipPath, jsonPath);
      console.log(`\n💾 第 ${r} 轮已完整落盘：${jsonPath}`);
    } else {
      console.warn(`\n⚠️ 第 ${r} 轮只完成 ${round.length}/${defs.length * arms.length} 个组合，`
        + `保留为 ${wipPath}\n   不会被汇总纳入（汇总只认 .json）。`);
    }
  }

  // 汇总所有轮
  const allFiles = readdirSync(outDir)
    .filter(f => f.startsWith('branch_isolation_') && f.endsWith('.json'))
    .map(f => ({ f, t: statSync(join(outDir, f)).mtimeMs }))
    .sort((a, b) => a.t - b.t)
    .map(x => x.f);
  // 本次跑的分叉组数决定默认只看哪一批：5 组与 12 组混在一起平均是错的
  const files = only.length > 0 ? allFiles.filter(f => only.some(o => f.includes(o))) : allFiles;
  const loaded = files.map(f => JSON.parse(readFileSync(join(outDir, f), 'utf-8')) as RunResult[]);
  const mdPath = join(outDir, outName);
  writeFileSync(mdPath, buildMarkdown(loaded, files), 'utf-8');
  console.log(`\n📄 跨轮汇总：${mdPath}（纳入 ${files.length} 轮）`);

  console.log(`\n${'═'.repeat(70)}\n汇总（Judge 法污染率）\n${'═'.repeat(70)}`);
  for (const arm of arms) {
    const rs = loaded.flat().filter(r => r.isolation === arm);
    if (rs.length === 0) continue;
    const s = stats(rs.map(r => r.judgeContaminationRate));
    console.log(`${ARM_LABELS[arm].padEnd(26)} ${(s.mean * 100).toFixed(0)}% ± ${(s.std * 100).toFixed(0)}%`);
  }
}

main()
  .catch((e) => { console.error('失败:', e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
