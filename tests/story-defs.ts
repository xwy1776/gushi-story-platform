/**
 * 故事设定 —— 消融实验的第二批（扩样 15 → 30）
 *
 * ── 为什么单独一个文件 ──────────────────────────────────────────
 * 故事设定要被多个实验脚本共用（`ab_ablation.ts` 消融实验、
 * `ab_branch_isolation.ts` 跨分支实验，以及后续的 RAG 基线），
 * 而它们各自都是上千行的跑批入口。数据单列在这里、由各脚本单向 import，
 * 谁都不必把别人的跑批逻辑拖进来。
 *
 * （`ab_ablation.ts` 是有 main-guard 的，import 它不会误触发实验；
 *   拆开是为了解耦，不是为了绕开副作用。）
 *
 * ── 选材约束（扩样前定的，别改） ────────────────────────────────
 * 1. **genre 只用「三国」和「历史」**，不引入新题材。
 *    实际分布：第一批 3:12（三国 3 / 历史 12），第二批 4:11，合计 7:23。
 *    （本注释早先写成"与第一批保持同一分布（4:11）"，把第一批记错了 —— 第一批是 3 个三国。
 *      三国的四个故事都确实是三国，不为凑数改标。）
 *    genre 只用于生成风格指令、不参与统计，且配对单位是故事本身（同一故事跨档自比），
 *    所以这 1 个故事的偏差是协变量、不是混淆；但**不要**在此基础上再引入第三种题材。
 * 2. **opener 必须明确停在两类位置之一**，并在下面用注释标出：
 *      【待决】停在一个尚未做出的决定上 —— 可推进
 *      【终结】停在一个已经落定的结局上 —— 容易触发复读
 *    第一批里触发率最高的荆轲刺秦恰恰是【终结】，所以这批刻意配了 5 个【终结】，
 *    否则样本仍有偏。
 * 3. **graphEdges 里出现的每一个非角色名，必须在 states 里有对应条目**
 *    （type 为 'location' 或 'event'）。`inferSeedNodeType` 是按 states 派生的，
 *    漏一个就会落进兜底分支被当成角色，注入 Prompt 时变成图谱噪声。
 *    —— 上次扩样就是栽在这里（"咸阳""巨鹿""淝水"全被当成角色）。
 */

export type StoryDef = {
  title: string;
  description: string;
  genre: string;
  opener: string;
  characters: Array<{ name: string; era: string; role: string; traits: string[] }>;
  graphEdges: Array<{ from: string; to: string; type: 'ally_of' | 'conflicts_with' | 'involves' | 'belongs_to' | 'located_at' }>;
  states: Array<Record<string, any>>;
};

export const BATCH2_STORY_DEFS: StoryDef[] = [
  {
    title: '官渡之战',
    description: '东汉建安五年，曹操与袁绍相持于官渡，曹军兵少粮尽，袁绍谋士许攸来投，献计奇袭乌巢。',
    genre: '三国',
    // 【待决】许攸尚未来投，曹操还在犹豫要不要退兵
    opener: '建安五年，袁绍率十万大军南下，曹操以两万之众扼守官渡。两军相持数月，曹军粮草将尽，士卒疲惫。曹操已有退兵之意，写信问计于荀彧。而对岸袁绍营中，谋士许攸因家人犯法被审配收押，正愤懑难平，夜不能寐。',
    characters: [
      { name: '曹操', era: '东汉末年', role: 'protagonist', traits: ['果决', '多疑', '善用人'] },
      { name: '袁绍', era: '东汉末年', role: 'antagonist', traits: ['多谋少断', '刚愎', '外宽内忌'] },
      { name: '许攸', era: '东汉末年', role: 'supporting', traits: ['贪财', '恃功', '善奇谋'] },
      { name: '荀彧', era: '东汉末年', role: 'supporting', traits: ['沉稳', '远见', '忠贞'] },
    ],
    graphEdges: [
      { from: '曹操', to: '袁绍', type: 'conflicts_with' },
      { from: '许攸', to: '袁绍', type: 'belongs_to' },
      { from: '曹操', to: '荀彧', type: 'belongs_to' },
      { from: '许攸', to: '官渡', type: 'involves' },
      { from: '官渡', to: '曹操', type: 'located_at' },
    ],
    states: [
      { id: 's_cc', type: 'character', name: '曹操', properties: { isAlive: 'true', location: '官渡', status: '司空', mood: '焦虑', faction: '曹操势力', goal: '固守待变' } },
      { id: 's_ys', type: 'character', name: '袁绍', properties: { isAlive: 'true', location: '黎阳', status: '大将军', mood: '自负', faction: '袁绍势力', goal: '南下许都' } },
      { id: 's_xy', type: 'character', name: '许攸', properties: { isAlive: 'true', location: '袁绍营', status: '谋士', mood: '愤懑', faction: '袁绍势力', goal: '自保' } },
      { id: 's_xyu', type: 'character', name: '荀彧', properties: { isAlive: 'true', location: '许都', status: '尚书令', mood: '沉着', faction: '曹操势力', goal: '稳固后方' } },
      { id: 's_guandu', type: 'location', name: '官渡', properties: { status: '战场', controller: '曹操' } },
      { id: 's_rel_cc_ys', type: 'relationship', name: '曹操-袁绍', properties: { between: '曹操-袁绍', type: '敌对', status: '对峙' } },
      { id: 's_rel_xy_ys', type: 'relationship', name: '许攸-袁绍', properties: { between: '许攸-袁绍', type: '君臣', status: '嫌隙' } },
    ],
  },
  {
    title: '白帝城托孤',
    description: '蜀汉章武三年，刘备夷陵兵败后退守白帝城，病重之际召诸葛亮托付后事，嘱其辅佐刘禅。',
    genre: '三国',
    // 【终结】托孤之言已出，结局已定
    opener: '章武三年春，刘备夷陵大败，退守白帝城，一病不起。他自知时日无多，遣使召诸葛亮自成都赶来，又召李严同受遗诏。榻前烛火摇曳，刘禅跪于外侧。诸葛亮趋步入内，伏于榻前，刘备执其手，泪下沾襟，曰："君才十倍曹丕，必能安国，终定大事。"',
    characters: [
      { name: '刘备', era: '三国', role: 'protagonist', traits: ['仁义', '坚韧', '重情'] },
      { name: '诸葛亮', era: '三国', role: 'protagonist', traits: ['谨慎', '忠诚', '睿智'] },
      { name: '李严', era: '三国', role: 'supporting', traits: ['干练', '自负', '有野心'] },
      { name: '刘禅', era: '三国', role: 'supporting', traits: ['仁厚', '暗弱', '依赖'] },
    ],
    graphEdges: [
      { from: '诸葛亮', to: '刘备', type: 'belongs_to' },
      { from: '李严', to: '刘备', type: 'belongs_to' },
      { from: '刘备', to: '白帝城', type: 'located_at' },
      { from: '刘备', to: '托孤', type: 'involves' },
      { from: '诸葛亮', to: '刘禅', type: 'belongs_to' },
    ],
    states: [
      { id: 's_lb', type: 'character', name: '刘备', properties: { isAlive: 'true', location: '白帝城', status: '皇帝', mood: '弥留', faction: '蜀汉', goal: '托付后事' } },
      { id: 's_zgl', type: 'character', name: '诸葛亮', properties: { isAlive: 'true', location: '白帝城', status: '丞相', mood: '悲恸', faction: '蜀汉', goal: '兴复汉室' } },
      { id: 's_ly', type: 'character', name: '李严', properties: { isAlive: 'true', location: '白帝城', status: '尚书令', mood: '谨慎', faction: '蜀汉', goal: '受托辅政' } },
      { id: 's_lc', type: 'character', name: '刘禅', properties: { isAlive: 'true', location: '白帝城', status: '太子', mood: '惶恐', faction: '蜀汉', goal: '承继大统' } },
      { id: 's_bdc', type: 'location', name: '白帝城', properties: { status: '行宫', controller: '刘备' } },
      { id: 's_tg', type: 'event', name: '托孤', properties: { status: '进行中', participants: '刘备-诸葛亮' } },
      { id: 's_rel_lb_zgl', type: 'relationship', name: '刘备-诸葛亮', properties: { between: '刘备-诸葛亮', type: '君臣', status: '生死相托', strength: '100' } },
    ],
  },
  {
    title: '七擒孟获',
    description: '蜀汉建兴三年，诸葛亮南征平叛，闻孟获为南中人心所服，遂定计生擒而释之，欲使其心服。',
    genre: '三国',
    // 【待决】刚擒获孟获，尚未决定放不放
    opener: '建兴三年，南中诸郡叛乱，诸葛亮亲率大军南征。首战即擒获南中首领孟获。孟获被押至帐前，昂首不服，只道是自己不慎中计，并非力不能敌。诸葛亮命人解其缚，赐以酒食，却迟迟未发落，只令暂且押下。帐下诸将不解其意，纷纷请战。',
    characters: [
      { name: '诸葛亮', era: '三国', role: 'protagonist', traits: ['睿智', '谨慎', '攻心为上'] },
      { name: '孟获', era: '三国', role: 'antagonist', traits: ['勇猛', '倔强', '重信义'] },
      { name: '马谡', era: '三国', role: 'supporting', traits: ['善谋', '自负', '好议论'] },
    ],
    graphEdges: [
      { from: '诸葛亮', to: '孟获', type: 'conflicts_with' },
      { from: '马谡', to: '诸葛亮', type: 'belongs_to' },
      { from: '诸葛亮', to: '南中', type: 'located_at' },
      { from: '诸葛亮', to: '七擒孟获', type: 'involves' },
    ],
    states: [
      { id: 's_zgl', type: 'character', name: '诸葛亮', properties: { isAlive: 'true', location: '南中', status: '丞相', mood: '从容', faction: '蜀汉', goal: '收服人心' } },
      { id: 's_mh', type: 'character', name: '孟获', properties: { isAlive: 'true', location: '南中', status: '部落首领', mood: '不服', faction: '南中', goal: '保全部众' } },
      { id: 's_ms', type: 'character', name: '马谡', properties: { isAlive: 'true', location: '南中', status: '参军', mood: '振奋', faction: '蜀汉', goal: '建功' } },
      { id: 's_nz', type: 'location', name: '南中', properties: { status: '叛乱中', controller: '蜀汉' } },
      { id: 's_qqmh', type: 'event', name: '七擒孟获', properties: { status: '进行中', participants: '诸葛亮-孟获' } },
      { id: 's_rel_zgl_mh', type: 'relationship', name: '诸葛亮-孟获', properties: { between: '诸葛亮-孟获', type: '敌对', status: '擒而未服' } },
    ],
  },
  {
    title: '败走麦城',
    description: '东汉建安二十四年，关羽北伐襄樊，吕蒙白衣渡江袭取荆州，关羽退守麦城，援兵不至。',
    genre: '三国',
    // 【终结】麦城已被围，荆州已失，结局已定
    opener: '建安二十四年冬，关羽北伐襄樊，水淹七军，威震华夏。不料吕蒙白衣渡江，袭取江陵、公安，荆州尽失，家眷皆陷。关羽回师救援不及，只得退守麦城。城中粮尽援绝，士卒散去大半，上庸刘封、孟达按兵不救。关羽立于城头，望着东南方向，久久无言。',
    characters: [
      { name: '关羽', era: '东汉末年', role: 'protagonist', traits: ['忠义', '高傲', '勇猛'] },
      { name: '吕蒙', era: '东汉末年', role: 'antagonist', traits: ['果决', '善谋', '隐忍'] },
      { name: '刘封', era: '东汉末年', role: 'supporting', traits: ['骄纵', '怯懦', '记恨'] },
    ],
    graphEdges: [
      { from: '关羽', to: '吕蒙', type: 'conflicts_with' },
      { from: '刘封', to: '关羽', type: 'conflicts_with' },
      { from: '关羽', to: '麦城', type: 'located_at' },
      { from: '吕蒙', to: '江陵', type: 'located_at' },
      { from: '关羽', to: '败走麦城', type: 'involves' },
    ],
    states: [
      { id: 's_gy', type: 'character', name: '关羽', properties: { isAlive: 'true', location: '麦城', status: '前将军', mood: '悲愤', faction: '蜀汉', goal: '突围求援' } },
      { id: 's_lm', type: 'character', name: '吕蒙', properties: { isAlive: 'true', location: '江陵', status: '都督', mood: '从容', faction: '东吴', goal: '尽取荆州' } },
      { id: 's_lf', type: 'character', name: '刘封', properties: { isAlive: 'true', location: '上庸', status: '副军将军', mood: '犹豫', faction: '蜀汉', goal: '自保' } },
      { id: 's_mc', type: 'location', name: '麦城', properties: { status: '被围', controller: '关羽' } },
      { id: 's_jl', type: 'location', name: '江陵', properties: { status: '已失陷', controller: '吕蒙' } },
      { id: 's_bzmc', type: 'event', name: '败走麦城', properties: { status: '进行中', participants: '关羽' } },
      { id: 's_rel_gy_lm', type: 'relationship', name: '关羽-吕蒙', properties: { between: '关羽-吕蒙', type: '敌对', status: '交战中' } },
    ],
  },
  {
    title: '牧野之战',
    description: '商朝末年，周武王姬发率诸侯之师东伐，与商纣王决战于牧野，商军倒戈，商朝灭亡。',
    genre: '历史',
    // 【待决】两军相遇于牧野，尚未开战
    opener: '商纣末年，纣王囚箕子、杀比干，朝政日坏，太师疵、少师强抱其乐器奔周。周武王姬发车载文王木主，率战车三百乘、虎贲三千人，会同诸侯东进伐商。大军渡河之后，直逼商都朝歌，与商军相遇于牧野。太公望立于阵前，手持黄钺，只待天明。',
    characters: [
      { name: '周武王', era: '商周之际', role: 'protagonist', traits: ['仁德', '果决', '善纳谏'] },
      { name: '姜子牙', era: '商周之际', role: 'protagonist', traits: ['老谋深算', '刚毅', '善用兵'] },
      { name: '商纣王', era: '商朝末年', role: 'antagonist', traits: ['暴虐', '刚愎', '勇力过人'] },
    ],
    graphEdges: [
      { from: '周武王', to: '商纣王', type: 'conflicts_with' },
      { from: '姜子牙', to: '周武王', type: 'belongs_to' },
      { from: '周武王', to: '牧野', type: 'located_at' },
      { from: '商纣王', to: '朝歌', type: 'located_at' },
      { from: '周武王', to: '牧野之战', type: 'involves' },
    ],
    states: [
      { id: 's_zw', type: 'character', name: '周武王', properties: { isAlive: 'true', location: '牧野', status: '西伯', mood: '决然', faction: '周军', goal: '诛暴除残' } },
      { id: 's_jzy', type: 'character', name: '姜子牙', properties: { isAlive: 'true', location: '牧野', status: '太师', mood: '沉稳', faction: '周军', goal: '一战定商' } },
      { id: 's_zsw', type: 'character', name: '商纣王', properties: { isAlive: 'true', location: '朝歌', status: '天子', mood: '骄狂', faction: '商朝', goal: '拒周师' } },
      { id: 's_my', type: 'location', name: '牧野', properties: { status: '战场', controller: '周军' } },
      { id: 's_cg', type: 'location', name: '朝歌', properties: { status: '商都', controller: '商纣王' } },
      { id: 's_myzz', type: 'event', name: '牧野之战', properties: { status: '一触即发', participants: '周武王-商纣王' } },
      { id: 's_rel_zw_zsw', type: 'relationship', name: '周武王-商纣王', properties: { between: '周武王-商纣王', type: '敌对', status: '决战' } },
    ],
  },
  {
    title: '胡服骑射',
    description: '战国时赵武灵王力排众议，推行胡服骑射，改革军制，赵国由弱转强。',
    genre: '历史',
    // 【待决】朝议未决，公子成尚未被说服
    opener: '战国中期，赵国北邻胡人，屡遭骑射侵扰，而赵军宽袍大袖，战车笨重，屡战屡败。赵武灵王决意改穿胡人短衣窄袖，习骑马射箭。此议一出，朝野哗然。公子成称病不朝，宗室贵族纷纷上书，以为弃华夏衣冠而效夷狄之俗，是自贬身份。赵武灵王召集群臣，将议此事。',
    characters: [
      { name: '赵武灵王', era: '战国', role: 'protagonist', traits: ['雄才大略', '果决', '务实效'] },
      { name: '公子成', era: '战国', role: 'supporting', traits: ['守旧', '德高望重', '固执'] },
      { name: '肥义', era: '战国', role: 'supporting', traits: ['忠贞', '通达', '善谏'] },
    ],
    graphEdges: [
      { from: '赵武灵王', to: '公子成', type: 'conflicts_with' },
      { from: '肥义', to: '赵武灵王', type: 'belongs_to' },
      { from: '赵武灵王', to: '邯郸', type: 'located_at' },
      { from: '赵武灵王', to: '胡服骑射', type: 'involves' },
    ],
    states: [
      { id: 's_zwl', type: 'character', name: '赵武灵王', properties: { isAlive: 'true', location: '邯郸', status: '赵侯', mood: '坚定', faction: '赵国', goal: '强兵图存' } },
      { id: 's_gzc', type: 'character', name: '公子成', properties: { isAlive: 'true', location: '邯郸', status: '宗室贵臣', mood: '抵触', faction: '赵国', goal: '守旧制' } },
      { id: 's_fy', type: 'character', name: '肥义', properties: { isAlive: 'true', location: '邯郸', status: '相国', mood: '支持', faction: '赵国', goal: '佐成改革' } },
      { id: 's_hd', type: 'location', name: '邯郸', properties: { status: '赵国都城', controller: '赵武灵王' } },
      { id: 's_hfsq', type: 'event', name: '胡服骑射', properties: { status: '议而未决', participants: '赵武灵王-公子成' } },
      { id: 's_rel_zwl_gzc', type: 'relationship', name: '赵武灵王-公子成', properties: { between: '赵武灵王-公子成', type: '君臣', status: '政见相左' } },
    ],
  },
  {
    title: '指鹿为马',
    description: '秦二世时，丞相赵高专权，于朝堂之上献鹿称马，以此试探群臣向背，凡言鹿者皆遭陷害。',
    genre: '历史',
    // 【待决】鹿已牵入殿中，群臣尚未表态
    opener: '秦二世三年，赵高既杀李斯，自为丞相，权倾朝野，然犹恐群臣不服。乃于朝会之日，牵一鹿入殿，指为良马献于二世。二世笑曰："丞相误邪？谓鹿为马。"赵高遂问左右群臣。殿中一时寂然——有人默然不语，有人应声附和，亦有几人直言是鹿。赵高目视众人，不置一词。',
    characters: [
      { name: '赵高', era: '秦朝', role: 'antagonist', traits: ['阴险', '专权', '善揣摩'] },
      { name: '秦二世', era: '秦朝', role: 'supporting', traits: ['昏聩', '耽乐', '懦弱'] },
      { name: '冯去疾', era: '秦朝', role: 'supporting', traits: ['忠直', '刚正', '无力回天'] },
    ],
    graphEdges: [
      { from: '赵高', to: '秦二世', type: 'belongs_to' },
      { from: '赵高', to: '冯去疾', type: 'conflicts_with' },
      { from: '赵高', to: '咸阳', type: 'located_at' },
      { from: '赵高', to: '指鹿为马', type: 'involves' },
    ],
    states: [
      { id: 's_zg', type: 'character', name: '赵高', properties: { isAlive: 'true', location: '咸阳', status: '丞相', mood: '阴鸷', faction: '秦朝', goal: '独揽大权' } },
      { id: 's_es', type: 'character', name: '秦二世', properties: { isAlive: 'true', location: '咸阳', status: '皇帝', mood: '昏惑', faction: '秦朝', goal: '耽于逸乐' } },
      { id: 's_fqq', type: 'character', name: '冯去疾', properties: { isAlive: 'true', location: '咸阳', status: '右丞相', mood: '愤懑', faction: '秦朝', goal: '匡正朝纲' } },
      { id: 's_xy', type: 'location', name: '咸阳', properties: { status: '秦都', controller: '赵高' } },
      { id: 's_zlwm', type: 'event', name: '指鹿为马', properties: { status: '进行中', participants: '赵高-群臣' } },
      { id: 's_rel_zg_es', type: 'relationship', name: '赵高-秦二世', properties: { between: '赵高-秦二世', type: '君臣', status: '蒙蔽' } },
    ],
  },
  {
    title: '大泽乡起义',
    description: '秦二世元年，陈胜、吴广率戍卒九百人赴渔阳戍边，途遇大雨失期，按律当斩，遂揭竿而起。',
    genre: '历史',
    // 【待决】已定谋，尚未举事
    opener: '秦二世元年七月，陈胜、吴广皆为屯长，奉命押送闾左贫民九百人前往渔阳戍守。行至大泽乡，连日大雨，道路不通。按秦律，戍卒失期者斩。陈胜与吴广相谋：如今逃亡是死，举大计也是死，同样是死，何不为国事而死？二人已暗中谋划，只待时机。',
    characters: [
      { name: '陈胜', era: '秦朝', role: 'protagonist', traits: ['志向远大', '果敢', '善鼓动'] },
      { name: '吴广', era: '秦朝', role: 'protagonist', traits: ['宽厚', '得人心', '果决'] },
      { name: '秦将尉', era: '秦朝', role: 'antagonist', traits: ['残暴', '酗酒', '轻慢'] },
    ],
    graphEdges: [
      { from: '陈胜', to: '吴广', type: 'ally_of' },
      { from: '陈胜', to: '秦将尉', type: 'conflicts_with' },
      { from: '陈胜', to: '大泽乡', type: 'located_at' },
      { from: '陈胜', to: '大泽乡起义', type: 'involves' },
    ],
    states: [
      { id: 's_cs', type: 'character', name: '陈胜', properties: { isAlive: 'true', location: '大泽乡', status: '屯长', mood: '决然', faction: '戍卒', goal: '举大事' } },
      { id: 's_wg', type: 'character', name: '吴广', properties: { isAlive: 'true', location: '大泽乡', status: '屯长', mood: '激昂', faction: '戍卒', goal: '助陈胜起事' } },
      { id: 's_jw', type: 'character', name: '秦将尉', properties: { isAlive: 'true', location: '大泽乡', status: '将尉', mood: '倨傲', faction: '秦朝', goal: '督送戍卒' } },
      { id: 's_dzx', type: 'location', name: '大泽乡', properties: { status: '戍卒驻地', controller: '秦朝' } },
      { id: 's_qy', type: 'event', name: '大泽乡起义', properties: { status: '一触即发', participants: '陈胜-吴广' } },
      { id: 's_rel_cs_wg', type: 'relationship', name: '陈胜-吴广', properties: { between: '陈胜-吴广', type: '同盟', status: '共谋' } },
    ],
  },
  {
    title: '背水一战',
    description: '楚汉之际，韩信率军东下井陉击赵，背水列阵诱赵军倾巢而出，再以奇兵夺其营垒，大破赵军。',
    genre: '历史',
    // 【待决】奇兵已伏，尚未出井陉口列阵
    opener: '汉三年，韩信、张耳率数万之众东下井陉击赵。赵王歇与成安君陈余聚兵二十万于井陉口，据险而守。谋士李左车请以奇兵绝汉军粮道，陈余自恃义兵不用诈谋，不听。韩信闻之，大喜，乃选轻骑二千人，人持一赤帜，夜半出发，伏于赵军壁垒之侧。天明，韩信引兵出井陉口。',
    characters: [
      { name: '韩信', era: '楚汉之际', role: 'protagonist', traits: ['善用兵', '果决', '能忍'] },
      { name: '陈余', era: '楚汉之际', role: 'antagonist', traits: ['自恃', '迂腐', '轻敌'] },
      { name: '张耳', era: '楚汉之际', role: 'supporting', traits: ['沉稳', '善抚众', '恩怨分明'] },
      { name: '李左车', era: '楚汉之际', role: 'supporting', traits: ['多谋', '明察', '忠谏'] },
    ],
    graphEdges: [
      { from: '韩信', to: '陈余', type: 'conflicts_with' },
      { from: '韩信', to: '张耳', type: 'ally_of' },
      { from: '李左车', to: '陈余', type: 'belongs_to' },
      { from: '韩信', to: '井陉', type: 'located_at' },
      { from: '韩信', to: '背水一战', type: 'involves' },
    ],
    states: [
      { id: 's_hx', type: 'character', name: '韩信', properties: { isAlive: 'true', location: '井陉', status: '将军', mood: '成竹在胸', faction: '汉军', goal: '破赵' } },
      { id: 's_cy', type: 'character', name: '陈余', properties: { isAlive: 'true', location: '井陉口', status: '成安君', mood: '轻敌', faction: '赵军', goal: '据险拒守' } },
      { id: 's_ze', type: 'character', name: '张耳', properties: { isAlive: 'true', location: '井陉', status: '将军', mood: '沉稳', faction: '汉军', goal: '复赵地' } },
      { id: 's_lzz', type: 'character', name: '李左车', properties: { isAlive: 'true', location: '井陉口', status: '谋士', mood: '忧急', faction: '赵军', goal: '断汉粮道' } },
      { id: 's_jx', type: 'location', name: '井陉', properties: { status: '隘口', controller: '赵军' } },
      { id: 's_bswz', type: 'event', name: '背水一战', properties: { status: '部署中', participants: '韩信-陈余' } },
      { id: 's_rel_hx_cy', type: 'relationship', name: '韩信-陈余', properties: { between: '韩信-陈余', type: '敌对', status: '决战' } },
    ],
  },
  {
    title: '垓下之围',
    description: '汉五年，刘邦会合诸侯围项羽于垓下，汉军夜唱楚歌，楚军士气崩溃，项羽突围至乌江自刎。',
    genre: '历史',
    // 【终结】四面楚歌已起，败局已定
    opener: '汉五年冬，刘邦会合韩信、彭越、英布诸路大军，共四十万众，围项羽于垓下。项羽兵少食尽，夜闻汉军营中四面皆唱楚歌，大惊曰："汉皆已得楚乎？是何楚人之多也！"遂起，饮于帐中。美人虞姬和之，项王悲歌慷慨，泣数行下，左右皆泣，莫能仰视。',
    characters: [
      { name: '项羽', era: '楚汉之际', role: 'protagonist', traits: ['勇武', '刚愎', '重情'] },
      { name: '虞姬', era: '楚汉之际', role: 'supporting', traits: ['忠贞', '刚烈', '善舞'] },
      { name: '刘邦', era: '楚汉之际', role: 'antagonist', traits: ['善用人', '隐忍', '权变'] },
      { name: '韩信', era: '楚汉之际', role: 'supporting', traits: ['善用兵', '果决', '功高'] },
    ],
    graphEdges: [
      { from: '项羽', to: '刘邦', type: 'conflicts_with' },
      { from: '虞姬', to: '项羽', type: 'belongs_to' },
      { from: '韩信', to: '刘邦', type: 'belongs_to' },
      { from: '项羽', to: '垓下', type: 'located_at' },
      { from: '项羽', to: '垓下之围', type: 'involves' },
    ],
    states: [
      { id: 's_xy', type: 'character', name: '项羽', properties: { isAlive: 'true', location: '垓下', status: '西楚霸王', mood: '悲慨', faction: '楚军', goal: '突围' } },
      { id: 's_yj', type: 'character', name: '虞姬', properties: { isAlive: 'true', location: '垓下', status: '美人', mood: '决绝', faction: '楚军', goal: '随王死节' } },
      { id: 's_lb', type: 'character', name: '刘邦', properties: { isAlive: 'true', location: '垓下', status: '汉王', mood: '沉稳', faction: '汉军', goal: '定天下' } },
      { id: 's_hx', type: 'character', name: '韩信', properties: { isAlive: 'true', location: '垓下', status: '齐王', mood: '从容', faction: '汉军', goal: '十面埋伏' } },
      { id: 's_gx', type: 'location', name: '垓下', properties: { status: '被围', controller: '汉军' } },
      { id: 's_gxzw', type: 'event', name: '垓下之围', properties: { status: '合围已成', participants: '项羽-刘邦' } },
      { id: 's_rel_xy_lb', type: 'relationship', name: '项羽-刘邦', properties: { between: '项羽-刘邦', type: '敌对', status: '决战' } },
    ],
  },
  {
    title: '司马迁著史记',
    description: '西汉天汉年间，司马迁因李陵之祸受宫刑，出狱后忍辱发愤，继承父志撰写《史记》。',
    genre: '历史',
    // 【终结】宫刑已受，父志已承，只能写下去
    opener: '天汉二年，李陵兵败降匈奴，司马迁为之辩护，触怒汉武帝，下狱论罪。家贫无钱自赎，又无友朋相救，终受宫刑。出狱后，司马迁被任为中书令，出入宫禁，宠幸日隆。他每想起父亲司马谈临终所托——"余死，汝必为太史；为太史，无忘吾所欲论著矣"，便觉胸中郁结难平。案上竹简堆积如山。',
    characters: [
      { name: '司马迁', era: '西汉', role: 'protagonist', traits: ['坚忍', '博学', '孤愤'] },
      { name: '汉武帝', era: '西汉', role: 'antagonist', traits: ['雄才大略', '多疑', '刚愎'] },
      { name: '东方朔', era: '西汉', role: 'supporting', traits: ['诙谐', '机敏', '善谏'] },
    ],
    graphEdges: [
      { from: '司马迁', to: '汉武帝', type: 'belongs_to' },
      { from: '东方朔', to: '汉武帝', type: 'belongs_to' },
      { from: '司马迁', to: '长安', type: 'located_at' },
      { from: '司马迁', to: '著史记', type: 'involves' },
    ],
    states: [
      { id: 's_smq', type: 'character', name: '司马迁', properties: { isAlive: 'true', location: '长安', status: '中书令', mood: '忍辱发愤', faction: '汉朝', goal: '究天人之际' } },
      { id: 's_hw', type: 'character', name: '汉武帝', properties: { isAlive: 'true', location: '长安', status: '天子', mood: '威严', faction: '汉朝', goal: '开疆拓土' } },
      { id: 's_dfs', type: 'character', name: '东方朔', properties: { isAlive: 'true', location: '长安', status: '太中大夫', mood: '诙谐', faction: '汉朝', goal: '周旋讽谏' } },
      { id: 's_ca', type: 'location', name: '长安', properties: { status: '汉都', controller: '汉武帝' } },
      { id: 's_zsj', type: 'event', name: '著史记', properties: { status: '进行中', participants: '司马迁' } },
      { id: 's_rel_smq_hw', type: 'relationship', name: '司马迁-汉武帝', properties: { between: '司马迁-汉武帝', type: '君臣', status: '有隙' } },
    ],
  },
  {
    title: '班超定西域',
    description: '东汉永平十六年，班超投笔从戎，随窦固出击匈奴，后出使鄯善，夜袭匈奴使团，威震西域。',
    genre: '历史',
    // 【待决】夜袭已定谋，尚未动手
    opener: '永平十六年，班超随奉车都尉窦固出击匈奴，有功。窦固遣其与从事郭恂出使西域，至鄯善国。鄯善王广初时礼敬甚厚，未几忽转疏怠。班超察其意变，料必有匈奴使者至，乃召侍胡诈问，果得实情。班超遂召所部三十六人共饮，酒酣，激之以危亡之势，众人皆曰："死生从司马！"事已议定，只待入夜。',
    characters: [
      { name: '班超', era: '东汉', role: 'protagonist', traits: ['果敢', '胆略过人', '坚韧'] },
      { name: '郭恂', era: '东汉', role: 'supporting', traits: ['谨慎', '怯懦', '文吏'] },
      { name: '鄯善王', era: '东汉', role: 'supporting', traits: ['首鼠两端', '畏强', '务实'] },
      { name: '匈奴使者', era: '东汉', role: 'antagonist', traits: ['骄横', '轻慢', '麻痹'] },
    ],
    graphEdges: [
      { from: '班超', to: '匈奴使者', type: 'conflicts_with' },
      { from: '郭恂', to: '班超', type: 'ally_of' },
      { from: '班超', to: '鄯善', type: 'located_at' },
      { from: '班超', to: '出使西域', type: 'involves' },
    ],
    states: [
      { id: 's_bc', type: 'character', name: '班超', properties: { isAlive: 'true', location: '鄯善', status: '假司马', mood: '决然', faction: '汉朝', goal: '定西域' } },
      { id: 's_gx', type: 'character', name: '郭恂', properties: { isAlive: 'true', location: '鄯善', status: '从事', mood: '忐忑', faction: '汉朝', goal: '全身而退' } },
      { id: 's_ssw', type: 'character', name: '鄯善王', properties: { isAlive: 'true', location: '鄯善', status: '国王', mood: '摇摆', faction: '鄯善', goal: '两不得罪' } },
      { id: 's_xnsz', type: 'character', name: '匈奴使者', properties: { isAlive: 'true', location: '鄯善', status: '使者', mood: '倨傲', faction: '匈奴', goal: '拉拢鄯善' } },
      { id: 's_ss', type: 'location', name: '鄯善', properties: { status: '西域属国', controller: '鄯善王' } },
      { id: 's_csxy', type: 'event', name: '出使西域', properties: { status: '进行中', participants: '班超' } },
      { id: 's_rel_bc_gx', type: 'relationship', name: '班超-郭恂', properties: { between: '班超-郭恂', type: '同僚', status: '共事' } },
    ],
  },
  {
    title: '玄武门之变',
    description: '唐武德九年，李世民与太子李建成、齐王李元吉争位日烈，遂伏兵玄武门，杀建成、元吉。',
    genre: '历史',
    // 【待决】伏兵已设，天色未明，尚未发动
    opener: '唐武德九年，太子李建成与齐王李元吉合谋，屡次构陷秦王李世民，又借突厥入寇之机，欲夺其兵权。李世民帐下长孙无忌、尉迟敬德等日夜劝其早作决断。六月三日，李世民密奏建成、元吉淫乱后宫，高祖许以明日鞫问。是夜，李世民率长孙无忌等入宫，伏兵于玄武门。天色将明。',
    characters: [
      { name: '李世民', era: '唐初', role: 'protagonist', traits: ['雄才大略', '果决', '善纳谏'] },
      { name: '李建成', era: '唐初', role: 'antagonist', traits: ['宽厚', '优柔', '失于防范'] },
      { name: '李元吉', era: '唐初', role: 'supporting', traits: ['勇武', '狠戾', '轻躁'] },
      { name: '李渊', era: '唐初', role: 'supporting', traits: ['开创之主', '晚年优柔', '父子两难'] },
    ],
    graphEdges: [
      { from: '李世民', to: '李建成', type: 'conflicts_with' },
      { from: '李元吉', to: '李建成', type: 'ally_of' },
      { from: '李世民', to: '玄武门', type: 'located_at' },
      { from: '李世民', to: '玄武门之变', type: 'involves' },
      { from: '李渊', to: '长安', type: 'located_at' },
    ],
    states: [
      { id: 's_lsm', type: 'character', name: '李世民', properties: { isAlive: 'true', location: '玄武门', status: '秦王', mood: '决绝', faction: '秦王府', goal: '夺嫡' } },
      { id: 's_ljc', type: 'character', name: '李建成', properties: { isAlive: 'true', location: '长安', status: '太子', mood: '未觉', faction: '东宫', goal: '固位' } },
      { id: 's_lyj', type: 'character', name: '李元吉', properties: { isAlive: 'true', location: '长安', status: '齐王', mood: '轻躁', faction: '齐王府', goal: '除秦王' } },
      { id: 's_ly', type: 'character', name: '李渊', properties: { isAlive: 'true', location: '长安', status: '皇帝', mood: '犹疑', faction: '唐朝', goal: '调和诸子' } },
      { id: 's_xwm', type: 'location', name: '玄武门', properties: { status: '宫城北门', controller: '李世民' } },
      { id: 's_ca', type: 'location', name: '长安', properties: { status: '唐都', controller: '李渊' } },
      { id: 's_xwmz', type: 'event', name: '玄武门之变', properties: { status: '伏兵已设', participants: '李世民-李建成-李元吉' } },
      { id: 's_rel_lsm_ljc', type: 'relationship', name: '李世民-李建成', properties: { between: '李世民-李建成', type: '敌对', status: '夺嫡' } },
    ],
  },
  {
    title: '马嵬坡',
    description: '唐天宝十五载，安史乱军破潼关，玄宗西逃至马嵬驿，禁军哗变，杀杨国忠，逼玄宗赐死杨贵妃。',
    genre: '历史',
    // 【终结】哗变已成，贵妃必死，玄宗已无力回天
    opener: '天宝十五载六月，潼关失守，玄宗仓皇西幸。行至马嵬驿，将士饥疲，怨气沸腾。禁军将领陈玄礼以祸由杨国忠起，遂发动哗变，杀国忠及其子，并围驿不散。玄宗亲出慰劳，将士皆不应。高力士自旁进言：国忠既诛，贵妃不宜侍侧，愿陛下割恩正法。玄宗倚杖倾首，良久无言。',
    characters: [
      { name: '唐玄宗', era: '唐朝', role: 'supporting', traits: ['早年英明', '晚年昏聩', '多情'] },
      { name: '杨贵妃', era: '唐朝', role: 'supporting', traits: ['色艺双绝', '不通政事', '身不由己'] },
      { name: '陈玄礼', era: '唐朝', role: 'antagonist', traits: ['忠直', '果决', '军心所向'] },
      { name: '高力士', era: '唐朝', role: 'supporting', traits: ['谨慎', '善揣上意', '忠心事主'] },
    ],
    graphEdges: [
      { from: '陈玄礼', to: '杨贵妃', type: 'conflicts_with' },
      { from: '高力士', to: '唐玄宗', type: 'belongs_to' },
      { from: '唐玄宗', to: '马嵬驿', type: 'located_at' },
      { from: '唐玄宗', to: '马嵬坡之变', type: 'involves' },
    ],
    states: [
      { id: 's_txz', type: 'character', name: '唐玄宗', properties: { isAlive: 'true', location: '马嵬驿', status: '皇帝', mood: '凄惶', faction: '唐朝', goal: '保全贵妃' } },
      { id: 's_ygf', type: 'character', name: '杨贵妃', properties: { isAlive: 'true', location: '马嵬驿', status: '贵妃', mood: '绝望', faction: '唐朝', goal: '求一线生机' } },
      { id: 's_cxl', type: 'character', name: '陈玄礼', properties: { isAlive: 'true', location: '马嵬驿', status: '龙武大将军', mood: '坚执', faction: '禁军', goal: '清君侧' } },
      { id: 's_gls', type: 'character', name: '高力士', properties: { isAlive: 'true', location: '马嵬驿', status: '内侍监', mood: '为难', faction: '唐朝', goal: '解上之危' } },
      { id: 's_mwy', type: 'location', name: '马嵬驿', properties: { status: '驿站', controller: '禁军' } },
      { id: 's_mwpbz', type: 'event', name: '马嵬坡之变', properties: { status: '哗变中', participants: '陈玄礼-杨国忠' } },
      { id: 's_rel_txz_cxl', type: 'relationship', name: '唐玄宗-陈玄礼', properties: { between: '唐玄宗-陈玄礼', type: '君臣', status: '相逼' } },
    ],
  },
  {
    title: '郑和下西洋',
    description: '明永乐三年，成祖遣郑和率舟师下西洋，宣示国威，通好诸番，为明代规模最大的海上远航。',
    genre: '历史',
    // 【待决】船队已集结，尚未启航
    opener: '永乐三年，明成祖朱棣以"耀兵异域，示中国富强"为念，命郑和率舟师下西洋。郑和本姓马，云南人，自幼入宫为宦，从燕王起兵有功，赐姓郑。船队集于南京龙江关，宝船六十二艘，大者长四十四丈，将士二万七千余人。帆樯如林，遮天蔽日。择日祭江已毕，只待东北季风起。',
    characters: [
      { name: '郑和', era: '明朝', role: 'protagonist', traits: ['沉稳', '机敏', '胸怀广阔'] },
      { name: '明成祖', era: '明朝', role: 'protagonist', traits: ['雄才大略', '果决', '好大喜功'] },
      { name: '王景弘', era: '明朝', role: 'supporting', traits: ['干练', '谨慎', '副使'] },
    ],
    graphEdges: [
      { from: '郑和', to: '明成祖', type: 'belongs_to' },
      { from: '王景弘', to: '郑和', type: 'ally_of' },
      { from: '郑和', to: '南京', type: 'located_at' },
      { from: '郑和', to: '下西洋', type: 'involves' },
    ],
    states: [
      { id: 's_zh', type: 'character', name: '郑和', properties: { isAlive: 'true', location: '南京', status: '正使太监', mood: '沉稳', faction: '明朝', goal: '通好诸番' } },
      { id: 's_mcz', type: 'character', name: '明成祖', properties: { isAlive: 'true', location: '北京', status: '天子', mood: '期许', faction: '明朝', goal: '宣示国威' } },
      { id: 's_wjh', type: 'character', name: '王景弘', properties: { isAlive: 'true', location: '南京', status: '副使', mood: '干练', faction: '明朝', goal: '佐理船队' } },
      { id: 's_nj', type: 'location', name: '南京', properties: { status: '明朝都城', controller: '明成祖' } },
      { id: 's_xxy', type: 'event', name: '下西洋', properties: { status: '待发', participants: '郑和' } },
      { id: 's_rel_zh_mcz', type: 'relationship', name: '郑和-明成祖', properties: { between: '郑和-明成祖', type: '君臣', status: '信任' } },
    ],
  },
];
