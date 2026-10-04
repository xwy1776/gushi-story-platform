/**
 * 实验脚本共享的故事预置库（--preset 选择；无需数据库）
 *
 * 使用方：
 *   - scripts/image-consistency-experiment.ts（图文一致性实验 A/B）
 *   - scripts/image-prompt-before-after.ts（优化前后对比实验）
 *
 * 新增预置：在 PRESETS 里复制一组角色 + 3 段文本即可；角色 appearance 建议使用
 * C5 结构化 5 段格式（年龄性别→五官与须式→发型→体型体态→服装配饰），锚点约束力最强。
 */
import type { CharacterVisualHint } from '../src/lib/image-generator';

export interface ExperimentSegment {
  id: string;
  title: string;
  content: string;
}

export interface StoryPreset {
  label: string;
  storyKey: string;
  genre: string;
  description: string;
  characters: CharacterVisualHint[];
  segments: ExperimentSegment[];
}

// ── 荆轲刺秦王（默认预置） ─────────────────────────────────────────────

const JINGKE_CHARACTERS: CharacterVisualHint[] = [
  {
    name: '荆轲',
    canonicalName: 'Jing Ke',
    appearance:
      'male, early 30s, lean weathered face, short black hair in a topknot, dark brown hanfu robe, leather forearm bracers, dagger at waist',
    role: 'protagonist',
  },
];

const JINGKE_SEGMENTS: ExperimentSegment[] = [
  {
    id: 'exp_seg_1',
    title: '驿馆夜雨',
    content:
      '深夜，驿馆的油灯将残。荆轲独自坐在案前，用粗布一遍遍擦拭那把匕首，雨水顺着屋檐滴下。他想起太子丹的嘱托，眼神沉了下来，最终将匕首重新收回鞘中。',
  },
  {
    id: 'exp_seg_2',
    title: '秦殿献图',
    content:
      '咸阳宫大殿，群臣列立。荆轲手捧督亢地图，低头缓步走向阶上的秦王嬴政，衣袖纹丝不乱，只有指尖微微发紧。殿外钟声沉沉，阳光从高窗斜照进来。',
  },
  {
    id: 'exp_seg_3',
    title: '图穷匕见',
    content:
      '地图在秦王面前完全展开，寒光乍现。荆轲左手一把抓住秦王的衣袖，右手举起匕首直刺。殿中大乱，铜柱旁人影翻飞，卫士们的甲胄声由远及近。',
  },
];

// ── 玄武门之变 ────────────────────────────────────────────────────────

const XUANWU_CHARACTERS: CharacterVisualHint[] = [
  {
    name: '李世民',
    canonicalName: 'Li Shimin',
    appearance:
      'male, late 20s, square face with strong jawline, thick arched eyebrows, sharp determined dark eyes, straight nose, thin lips with a short black beard, long black hair tied in a high topknot with a gold crown pin, tall and powerfully built with broad shoulders and upright military posture, dark navy Tang dynasty prince robe with gold trims, leather shoulder armor pieces, war bow in hand',
    role: 'protagonist',
  },
];

const XUANWU_SEGMENTS: ExperimentSegment[] = [
  {
    id: 'xw_seg_1',
    title: '秦王府密议',
    content:
      '深夜，秦王府书房烛火摇曳。李世民与长孙无忌、尉迟敬德围案而坐，桌上摊着密报。太子建成步步紧逼，世民沉吟良久，指节一下下叩着案沿。',
  },
  {
    id: 'xw_seg_2',
    title: '玄武门设伏',
    content:
      '天光未明，玄武门城楼的剪影被晨雾笼罩。李世民率尉迟敬德藏身门侧，他张弓搭箭，箭尖对准宫门方向，呼吸压得极低，等待马蹄声由远及近。',
  },
  {
    id: 'xw_seg_3',
    title: '血溅宫门',
    content:
      '建成与元吉骑马入了玄武门，马蹄声在门洞中回响。李世民猛地起身引弓，一箭破空而出，鲜血溅上青石门槛，宫内惊呼四起，甲胄声大作。',
  },
];

// ── 赤壁之战 ──────────────────────────────────────────────────────────

const CHIBI_CHARACTERS: CharacterVisualHint[] = [
  {
    name: '诸葛亮',
    canonicalName: 'Zhuge Liang',
    appearance:
      'male, late 20s, refined oval face with high cheekbones, slender arched eyebrows, calm bright almond eyes, straight nose, thin lips, clean-shaven, fair skin, long black hair neatly tied under a pale blue silk headband in the classic lun-jin style, tall and slender with an elegant upright scholar posture, flowing white crane-feather cloak over a pale blue robe, white feather fan held in his right hand',
    role: 'protagonist',
  },
];

const CHIBI_SEGMENTS: ExperimentSegment[] = [
  {
    id: 'cb_seg_1',
    title: '草船借箭',
    content:
      '大雾弥漫的江面，二十艘扎满草人的小船悄然驶向曹营水寨。诸葛亮端坐船头，羽扇轻摇，与鲁肃对酌。三更时分，鼓声骤起，曹军万箭齐发，草人顷刻间插满箭矢。',
  },
  {
    id: 'cb_seg_2',
    title: '借东风',
    content:
      '七星坛上，诸葛亮登坛祈风，剑指东方。坛下旌旗低垂，江面一丝风也没有。三更时分，一阵疾风忽然自东方卷来，旌旗猎猎作响，江浪翻涌，众军齐声高呼。',
  },
  {
    id: 'cb_seg_3',
    title: '火烧赤壁',
    content:
      '东南风大起，黄盖的十艘火船顺风直冲曹军水寨。火光冲天，连环战船瞬间陷入火海，映红了半边长江。诸葛亮立于江边山头，遥望烈焰，神色平静。',
  },
];

// ── 鸿门宴 ────────────────────────────────────────────────────────────
// 同一日同一场景三幕，服装恒定；外观显式写明须式（须发维度探针——
// 回应此前实验中发现的胡子/须式漂移问题）。

const HONGMEN_CHARACTERS: CharacterVisualHint[] = [
  {
    name: '项羽',
    canonicalName: 'Xiang Yu',
    appearance:
      'male, early 30s, broad square face with heavy jaw, thick angry eyebrows, sharp narrow eyes, straight nose, thin lips, full dark beard and mustache, long black hair tied in a high warrior topknot with a bronze crown pin, tall and powerfully built with broad shoulders and an imposing commanding posture, dark bronze lamellar armor over a black battle robe, crimson cape, long sword at his waist',
    role: 'protagonist',
  },
];

const HONGMEN_SEGMENTS: ExperimentSegment[] = [
  {
    id: 'hm_seg_1',
    title: '鸿门设宴',
    content:
      '鸿门楚军大帐，酒宴排开。项羽端坐主位，按剑沉吟，神色沉毅。范增多次举起玉玦示意，他只作不见。帐中炭火正旺，烛影摇曳。',
  },
  {
    id: 'hm_seg_2',
    title: '项庄舞剑',
    content:
      '酒过三巡，项庄拔剑起舞，剑光直逼沛公座前。项伯亦起身舞剑，以身遮蔽刘邦。帐中剑影交错，寒光映着烛火，众人屏息。',
  },
  {
    id: 'hm_seg_3',
    title: '樊哙闯帐',
    content:
      '樊哙持盾撞开帐门，披帷而立，怒目直视项羽。项羽按剑而跽，赐酒肉与他。觥筹之间，刘邦借如厕离席，仓皇遁去。',
  },
];

// ── 预置索引 ─────────────────────────────────────────────────────────

export const PRESETS: Record<string, StoryPreset> = {
  jingke: {
    label: '合成场景（荆轲刺秦王）',
    storyKey: 'experiment-synthetic',
    genre: '历史',
    description: '荆轲刺秦王实验场景',
    characters: JINGKE_CHARACTERS,
    segments: JINGKE_SEGMENTS,
  },
  xuanwu: {
    label: '合成场景（玄武门之变）',
    storyKey: 'experiment-synthetic-xuanwu',
    genre: '历史',
    description: '玄武门之变实验场景',
    characters: XUANWU_CHARACTERS,
    segments: XUANWU_SEGMENTS,
  },
  chibi: {
    label: '合成场景（赤壁之战）',
    storyKey: 'experiment-synthetic-chibi',
    genre: '历史',
    description: '赤壁之战实验场景',
    characters: CHIBI_CHARACTERS,
    segments: CHIBI_SEGMENTS,
  },
  hongmen: {
    label: '合成场景（鸿门宴）',
    storyKey: 'experiment-synthetic-hongmen',
    genre: '历史',
    description: '鸿门宴实验场景',
    characters: HONGMEN_CHARACTERS,
    segments: HONGMEN_SEGMENTS,
  },
};
