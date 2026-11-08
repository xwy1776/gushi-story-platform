/**
 * 故事设定 fixture —— 供 LLM-as-Judge 评测器构造评分上下文
 *
 * ── 为什么单独放一个文件 ──────────────────────────────────────────
 * 这些设定原本内联在 `tests/ab_ablation.ts` 的 `ALL_STORY_DEFS` 里，但那个文件
 * 末尾是裸的 `main()` 调用（没有 main-guard），`import` 它会直接触发整个消融实验
 * 并连接数据库。所以评测器不能复用它，只能把 Judge 真正需要的字段抄一份到此处。
 *
 * Judge 需要的只有 4 项：故事梗概、角色性格基准、起始段（当前文用）。
 * 图谱边（graphEdges）与状态表（states）是消融实验的自变量，与打分无关，不抄。
 *
 * ⚠️ 同步义务：若 `ab_ablation.ts` 的故事设定有改动，这里的 title / opener /
 * characters 需一并更新。`llm_judge.ts --check-fixtures` 会做一致性校验。
 */

/** Judge 眼中的单个角色 */
export interface JudgeCharacter {
  name: string;
  /** 中文角色标签，直接喂给 Judge，比 protagonist/antagonist 更易理解 */
  role: string;
  /** 性格特质 —— Judge 判断「角色稳定」的核心依据 */
  traits: string[];
}

/** Judge 眼中的单个故事 */
export interface JudgeStory {
  title: string;
  genre: string;
  description: string;
  /** 起始段，作为「前文」提供给 Judge */
  opener: string;
  characters: JudgeCharacter[];
}

const ROLE_ZH: Record<string, string> = {
  protagonist: '主角',
  supporting: '配角',
  antagonist: '反派',
};

/** 把 ab_ablation.ts 的 role 英文枚举转成中文标签 */
export function roleLabel(role: string): string {
  return ROLE_ZH[role] ?? role;
}

export const JUDGE_STORIES: JudgeStory[] = [
  {
    title: '桃园结义',
    genre: '三国',
    description: '东汉末年，刘备、关羽、张飞在桃园结为兄弟，共谋兴复汉室。董卓祸乱朝纲，洛阳危在旦夕。',
    opener:
      '东汉末年，天下大乱。刘备、关羽、张飞三人志向相投，于桃园中歃血为盟，结为异姓兄弟，誓同生死，共图兴复汉室。而此时洛阳城中，董卓把持朝政，横行无忌。',
    characters: [
      { name: '刘备', role: 'protagonist', traits: ['仁义', '沉稳', '坚韧'] },
      { name: '关羽', role: 'protagonist', traits: ['忠义', '勇猛', '高傲'] },
      { name: '张飞', role: 'supporting', traits: ['勇猛', '急躁', '忠诚'] },
      { name: '董卓', role: 'antagonist', traits: ['残暴', '贪婪', '专横'] },
    ],
  },
  {
    title: '张骞出使西域',
    genre: '历史',
    description: '西汉建元三年，汉武帝派张骞出使西域，联络大月氏共同夹击匈奴。张骞率百余人出陇西，途中被匈奴扣留。',
    opener:
      '建元三年，汉武帝下诏，命张骞为使臣，率百余人出陇西，西行联络大月氏，相约夹击匈奴。张骞领命辞行，武帝亲自送于未央宫前，嘱其"通西域，断匈奴右臂"。张骞奉节仗节，决然西行。',
    characters: [
      { name: '张骞', role: 'protagonist', traits: ['坚毅', '忠诚', '勇敢'] },
      { name: '汉武帝', role: 'protagonist', traits: ['雄才大略', '威严', '多疑'] },
      { name: '匈奴单于', role: 'antagonist', traits: ['残暴', '狡诈', '强横'] },
    ],
  },
  {
    title: '荆轲刺秦',
    genre: '历史',
    description: '战国末期，燕国太子丹派遣荆轲刺杀秦王嬴政。荆轲携樊於期首级与督亢地图入秦，图穷匕见。',
    opener:
      '战国末年，秦军压境，燕国危如累卵。燕太子丹谋刺秦王，得荆轲为使者。荆轲携樊於期首级与督亢地图，与秦舞阳一同西入咸阳。易水送别，高渐离击筑，荆轲和而歌："风萧萧兮易水寒，壮士一去兮不复还。"',
    characters: [
      { name: '荆轲', role: 'protagonist', traits: ['勇敢', '侠义', '深沉', '重诺轻死'] },
      { name: '秦王嬴政', role: 'antagonist', traits: ['雄才大略', '多疑', '威严', '冷酷'] },
      { name: '燕太子丹', role: 'supporting', traits: ['忧国忧民', '重情义', '急躁'] },
    ],
  },
  {
    title: '赤壁之战',
    genre: '三国',
    description: '东汉建安十三年，曹操南下荆州，孙刘联军于赤壁以火攻大破曹军，奠定三国鼎立之势。',
    opener:
      '建安十三年秋，曹操率大军南下，荆州刘琮望风而降。刘备败走夏口，与孙权结盟。周瑜、程普为左右都督，率水军三万，与曹军隔江对峙于赤壁。江上大雾弥漫，一场决定天下大势的决战即将展开。',
    characters: [
      { name: '周瑜', role: 'protagonist', traits: ['儒雅', '果决', '善谋'] },
      { name: '曹操', role: 'antagonist', traits: ['雄才大略', '多疑', '骄矜'] },
      { name: '诸葛亮', role: 'supporting', traits: ['睿智', '沉稳', '善辩'] },
      { name: '黄盖', role: 'supporting', traits: ['忠勇', '老练'] },
    ],
  },
  {
    title: '郭子仪单骑退敌',
    genre: '历史',
    description: '唐代宗年间，回纥、吐蕃联兵入寇，郭子仪单骑赴回纥营，以威信劝退联军，解长安之危。',
    opener:
      '唐代宗永泰元年，吐蕃与回纥合兵数十万入寇，直逼长安。郭子仪奉命御敌，时兵力寡弱。回纥人素闻郭令公威名，郭子仪乃免胄释甲，单骑赴回纥营中，晓以利害。回纥诸酋大惊，下马罗拜。',
    characters: [
      { name: '郭子仪', role: 'protagonist', traits: ['沉稳', '胆略过人', '威望素著'] },
      { name: '回纥可汗', role: 'supporting', traits: ['骁勇', '重信义', '务实'] },
      { name: '吐蕃赞普', role: 'antagonist', traits: ['贪婪', '强横', '善变'] },
    ],
  },
];

/** 按标题查故事设定 */
export function findStory(title: string): JudgeStory | undefined {
  return JUDGE_STORIES.find((s) => s.title === title);
}

/** 故事标题列表（用于 --stories 参数的默认值提示） */
export function storyTitles(): string[] {
  return JUDGE_STORIES.map((s) => s.title);
}
