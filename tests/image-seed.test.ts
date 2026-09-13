/**
 * 生图 seed 派生策略测试
 *
 * 运行: npx tsx tests/image-seed.test.ts
 *
 * 对应章真毓反馈的问题：「照片里只有一个人时没问题，一加路人，
 * AI 就把主角和路人搞混，或者生成路人时干扰主角外貌」。
 *
 * 验证新的 seed 派生策略满足：
 * 1. 加入未登记路人 → 主角 seed 不变（旧实现会变，这是串味根因）
 * 2. 主角外观相同 → 跨段落 seed 基数稳定
 * 3. 场景不同 → 有微扰但幅度受限（不至于把脸洗掉）
 */
import { deriveImageSeed, pickAnchorCharacter, SCENE_JITTER } from '../src/lib/image-seed';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.error(`  ❌ ${message}`);
  }
}

const ZHANG_QIAN = {
  name: '张骞',
  canonicalName: 'Zhang Qian',
  appearance: 'a tall man in his thirties, long black beard, weathered face, wearing a tattered Han dynasty official robe, holding a yak-tail banner',
  role: 'protagonist',
};
const HAN_WUDI = {
  name: '汉武帝',
  canonicalName: 'Emperor Wu of Han',
  appearance: 'a middle-aged emperor in golden dragon-embroidered robes and a twelve-tassel crown',
  role: 'protagonist',
};
const SHANYU = {
  name: '匈奴单于',
  canonicalName: 'Xiongnu Chanyu',
  appearance: 'a burly chieftain with braided hair, fur-trimmed leather armor, a scar across his left cheek',
  role: 'antagonist',
};

const SEG_A = '张骞率百余人出陇西，行至荒漠，遇匈奴游骑。';
const SEG_B = '张骞被扣匈奴十年，每晨持节望南拜。';

function main() {
  console.log('\n📦 image-seed tests\n');

  // ── 1. 主角选取优先级 ──
  console.log('pickAnchorCharacter:');
  assert(pickAnchorCharacter([ZHANG_QIAN, SHANYU])?.name === '张骞', '有 protagonist 时优先取 protagonist');
  assert(pickAnchorCharacter([SHANYU, ZHANG_QIAN])?.name === '张骞', '顺序不影响 protagonist 选取');
  assert(pickAnchorCharacter([SHANYU])?.name === '匈奴单于', '无 protagonist 时退化为第一个角色');
  assert(pickAnchorCharacter([]) === undefined, '空数组 → undefined');

  // ── 2. 核心回归：加入路人，主角 seed 不变 ──
  console.log('\n加路人后主角 seed 稳定性（核心回归）:');
  const seedAlone = deriveImageSeed([ZHANG_QIAN], SEG_A);
  const seedWithCrowd = deriveImageSeed([ZHANG_QIAN, SHANYU], SEG_A);
  assert(seedAlone !== undefined, '单主角场景能派生出 seed');
  assert(
    seedAlone === seedWithCrowd,
    `多一个角色，seed 不变（${seedAlone} === ${seedWithCrowd}）—— 路人不再影响主角`,
  );

  // 旧实现的行为作为对照：把全部角色纳入派生 → seed 会变
  const legacyKey = (chars: typeof ZHANG_QIAN[], segId: string) =>
    chars.map(c => c.canonicalName || c.name).sort().join('|') + '|' + segId;
  assert(
    legacyKey([ZHANG_QIAN], 'seg1') !== legacyKey([ZHANG_QIAN, SHANYU], 'seg1'),
    '（对照）旧实现的 key 会因路人而改变 —— 这正是被修复的 bug',
  );

  // ── 3. 跨段落：主角外观不变 → seed 基数稳定 ──
  console.log('\n跨段落 seed 稳定性:');
  const seedsAcrossSegments = [SEG_A, SEG_B, '张骞回到长安，汉武帝亲自迎接。']
    .map(s => deriveImageSeed([ZHANG_QIAN], s))
    .filter((s): s is number => typeof s === 'number');
  assert(seedsAcrossSegments.length === 3, '三个段落都成功派生 seed');
  // 微扰幅度受限：不同段落 seed 差异应 < SCENE_JITTER
  const spread = Math.max(...seedsAcrossSegments) - Math.min(...seedsAcrossSegments);
  assert(
    spread < SCENE_JITTER,
    `跨段落 seed 波动 ${spread} < ${SCENE_JITTER}（构图有别但不换脸）`,
  );

  // 完全相同输入 → 完全相同的 seed（可复现）
  assert(
    deriveImageSeed([ZHANG_QIAN], SEG_A) === deriveImageSeed([ZHANG_QIAN], SEG_A),
    '相同输入 → 相同 seed（实验可复现）',
  );

  // ── 4. 不同主角 → 不同 seed 基数 ──
  console.log('\n不同主角的 seed 区分:');
  const seedZhang = deriveImageSeed([ZHANG_QIAN], SEG_A);
  const seedHan = deriveImageSeed([HAN_WUDI], SEG_A);
  assert(seedZhang !== seedHan, '换主角 → seed 不同（不同人物不会共用一张脸）');

  // 主角 + 反派同框：锚定的仍是主角
  assert(
    deriveImageSeed([ZHANG_QIAN, SHANYU], SEG_A) === seedZhang,
    '主角+反派同框 → 仍锚定主角 seed',
  );

  // ── 5. 边界情况 ──
  console.log('\n边界情况:');
  assert(deriveImageSeed([], SEG_A) === undefined, '无角色 → 返回 undefined（不锁 seed）');
  const noAppearance = { name: '无名氏' };
  const s1 = deriveImageSeed([noAppearance], SEG_A);
  assert(typeof s1 === 'number', '角色无 appearance 时回退用名字派生，仍返回有效 seed');
  assert(
    deriveImageSeed([noAppearance], SEG_A) === s1,
    '无 appearance 角色同样可复现',
  );
  // seed 必须是非负整数且在安全范围
  assert(
    typeof seedZhang === 'number' && Number.isInteger(seedZhang) && seedZhang >= 0 && seedZhang < 2147483647,
    `seed 为非负 32 位内整数（${seedZhang}）`,
  );

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
