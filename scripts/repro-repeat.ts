/**
 * 复现「退化复读」——诊断用脚本
 *
 * 背景：消融实验里 `none` / `graph` 两档在「荆轲刺秦」上反复出现相邻段
 * 相似度 1.00，即模型连续产出**逐字节完全相同**的段落。而同一 Prompt
 * 连调三次输出并不相同（采样是随机的），说明这不像是普通随机波动。
 *
 * 本脚本逐步打印每段的 Prompt 哈希与正文哈希，回答两个问题：
 *   1. 复读发生时，相邻两步的 Prompt 是否其实相同（=台架 bug）？
 *   2. 复读是「一次触发后吸收」还是「独立随机事件」？
 *
 * 运行: npx tsx scripts/repro-repeat.ts [--runs=2] [--segments=6]
 */
import '../tests/test-env';
import { createHash } from 'crypto';
import prisma from '../src/lib/prisma';
import { buildFullPrompt } from '../src/lib/prompt-builder';
import { knowledgeGraph } from '../src/lib/knowledge-graph';
import { narrativeStateTracker } from '../src/lib/narrative-state-tracker';
import { getOrderedChain } from '../src/lib/chain-helpers';
import { callAIText } from '../src/lib/ai-client';

const SYSTEM_PROMPT = '你是历史小说作家。';

const STORY = {
  title: '荆轲刺秦',
  description: '战国末期，燕国太子丹派遣荆轲刺杀秦王嬴政。荆轲携樊於期首级与督亢地图入秦，图穷匕见。',
  genre: '历史',
  opener: '战国末年，秦军压境，燕国危如累卵。燕太子丹谋刺秦王，得荆轲为使者。荆轲携樊於期首级与督亢地图，与秦舞阳一同西入咸阳。易水送别，高渐离击筑，荆轲和而歌："风萧萧兮易水寒，壮士一去兮不复还。"',
  characters: [
    { name: '荆轲', era: '战国末期', role: 'protagonist', traits: ['勇敢', '侠义', '深沉', '重诺轻死'] },
    { name: '秦王嬴政', era: '战国末期', role: 'antagonist', traits: ['雄才大略', '多疑', '威严', '冷酷'] },
    { name: '燕太子丹', era: '战国末期', role: 'supporting', traits: ['忧国忧民', '重情义', '急躁'] },
  ],
};

const argv = process.argv.slice(2);
const num = (k: string, d: number) => {
  const a = argv.find((x) => x.startsWith(`--${k}=`));
  return a ? parseInt(a.split('=')[1], 10) : d;
};
const RUNS = num('runs', 2);
const SEGMENTS = num('segments', 6);

const h = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 12);

async function setupStory(tag: string) {
  const user =
    (await prisma.user.findUnique({ where: { id: 'user_ablation_test' } })) ??
    (await prisma.user.create({
      data: { email: 'ablation@test.local', name: '消融测试用户', passwordHash: '$2b$10$x', id: 'user_ablation_test' } as any,
    }));

  const storyId = `story_repro_${tag}_${Date.now()}`;
  const branchId = `branch_repro_${tag}`;

  await prisma.story.create({
    data: {
      title: STORY.title, description: STORY.description, genre: STORY.genre,
      visibility: 'PUBLIC', id: storyId, owner: { connect: { id: user.id } },
    } as any,
  });

  const charIds: string[] = [];
  for (const c of STORY.characters) {
    const created = await prisma.character.create({
      data: { name: c.name, era: c.era, role: c.role, traits: c.traits, storyId, id: `char_repro_${tag}_${c.name}` } as any,
    });
    charIds.push(created.id);
  }

  await prisma.storySegment.create({
    data: {
      storyId, title: '起点', content: STORY.opener, isBranchPoint: false,
      branchId: 'main', parentSegmentId: null, imageUrls: [], characterIds: charIds,
      id: `seg_repro_${tag}_main_000`,
    } as any,
  });

  await prisma.storyBranch.create({
    data: {
      id: branchId, title: `复现-${tag}`, sourceSegmentId: `seg_repro_${tag}_main_000`,
      storyId, userDirection: '复现实验', ownerId: user.id,
    } as any,
  });

  return { storyId, branchId };
}

async function main() {
  // 只测 none 档：不注入任何记忆 → Prompt 里只有「前文链」，最容易看清机制
  delete process.env.MEMORY_MODULES_ENABLED;
  delete process.env.MEMORY_STATE_TABLE;
  delete process.env.MEMORY_KNOWLEDGE_GRAPH;
  process.env.MEMORY_MODULES_ENABLED = 'false';

  console.log(`\n复现「退化复读」：荆轲刺秦 × none 档 × ${SEGMENTS} 段 × ${RUNS} 轮\n`);

  for (let run = 0; run < RUNS; run++) {
    const tag = `r${run}`;
    const { storyId, branchId } = await setupStory(tag);
    const story = await prisma.story.findUnique({ where: { id: storyId } });

    console.log(`\n═══ 第 ${run + 1} 轮 ═══`);
    console.log('步骤  PromptLen  PromptHash     正文字数  正文Hash      与上段相同');
    let prev = '';
    for (let i = 0; i < SEGMENTS; i++) {
      const chain = await getOrderedChain(storyId, branchId);
      const tail = chain[chain.length - 1];
      const { prompt } = await buildFullPrompt({
        storyId, branchId, tailSegment: tail as any, chain: chain as any,
        storyTitle: story!.title, storyDescription: story!.description ?? undefined,
      });

      const content = await callAIText(prompt, { systemPrompt: SYSTEM_PROMPT, maxTokens: 700, story: story as any });
      const same = prev && content === prev;

      await prisma.storySegment.create({
        data: {
          storyId, title: `续写${chain.length}`, content, isBranchPoint: false,
          branchId, parentSegmentId: tail.id, imageUrls: [],
          id: `seg_repro_${tag}_${branchId}_${String(chain.length).padStart(3, '0')}`,
        } as any,
      });

      console.log(
        `${String(i + 1).padStart(4)}  ${String(prompt.length).padStart(9)}  ${h(prompt)}   ` +
        `${String(content.length).padStart(6)}   ${h(content)}   ${same ? '✅ 完全相同' : ''}`,
      );
      prev = content;
    }

    await prisma.story.delete({ where: { id: storyId } }).catch(() => {});
    await knowledgeGraph.resetForTest();
  }

  console.log('\n判读：若「完全相同」出现且相邻两行的 PromptHash 不同 → 是模型自身的复读吸引子，非台架 bug。');
  process.exit(0);
}

main().catch((e) => { console.error('失败:', e); process.exit(1); });
