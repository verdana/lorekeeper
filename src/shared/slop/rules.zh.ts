import type { RulesPack } from './rules.types'

/**
 * Chinese de-slop rules pack (v3).
 *
 * These are weighted *signals*, not a blacklist. High density of these patterns
 * correlates with machine-generated Chinese prose (over-explicit connectives,
 * abstract-noun fog, symmetric three-part structures). The analyzer combines
 * these with structural stats (sentence-length variance, punctuation variety),
 * so no single phrase alone condemns a sentence.
 */
export const zhRules: RulesPack = {
  version: 'zh-v5',
  lang: 'zh',
  rules: [
    // ---- Explicit connectives / transition scaffolding ----
    { pattern: '然而', category: 'connective', weight: 0.6, note: '显性转折词' },
    { pattern: '因此', category: 'connective', weight: 0.6 },
    { pattern: '因而', category: 'connective', weight: 0.5 },
    { pattern: '从而', category: 'connective', weight: 0.5 },
    { pattern: '于是乎?', category: 'connective', weight: 0.4 },
    { pattern: '总而言之', category: 'connective', weight: 0.8, note: '总结套话' },
    { pattern: '总的来说', category: 'connective', weight: 0.8 },
    { pattern: '综上所述', category: 'connective', weight: 0.9 },
    { pattern: '换句话说', category: 'connective', weight: 0.6 },
    {
      pattern: '值得(一提|注意|关注)的是',
      category: 'connective',
      weight: 0.85,
      note: '典型 AI 提示语',
    },
    { pattern: '不可否认', category: 'connective', weight: 0.7 },
    { pattern: '毫无疑问', category: 'connective', weight: 0.6 },
    { pattern: '与此同时', category: 'connective', weight: 0.5 },
    { pattern: '正因如此', category: 'connective', weight: 0.6 },
    { pattern: '归根结底', category: 'connective', weight: 0.6 },
    {
      pattern: '在(这个|这样(一个)?)?[^，。！？]{0,8}的(时代|背景|世界|当下|今天)',
      category: 'connective',
      weight: 0.8,
      note: '宏大开场套式',
    },

    // ---- Symmetric / parallel scaffolding ----
    {
      pattern: '不仅[^，。]{1,20}(，|、)?更',
      category: 'parallelism',
      weight: 0.7,
      note: '不仅…更 递进套式',
    },
    { pattern: '不仅仅是[^，。]{1,20}(，|、)?(而且|更|还)', category: 'parallelism', weight: 0.7 },
    { pattern: '无论是[^，。]{1,20}(，|、)?还是', category: 'parallelism', weight: 0.6 },
    { pattern: '既[^，。]{1,15}又[^，。]{1,15}', category: 'parallelism', weight: 0.4 },
    { pattern: '一方面[^。]{1,40}另一方面', category: 'parallelism', weight: 0.6 },
    {
      pattern: '(首先|其次|再次|最后|最终)[，、]',
      category: 'parallelism',
      weight: 0.5,
      note: '列点式行文',
    },

    {
      pattern:
        '(?:胃部|呼吸|脚趾|手指|指尖|声音|光线|空气|风|水|影子|脚印|脚步声)[^，。！？\\n]{1,8}，(?:[^，。！？\\n]{1,12}，){1,3}[^，。！？\\n]{1,12}[。！？]',
      category: 'parallelism',
      weight: 0.7,
      severity: 'soft',
      note: '感官三连清单（AI 表现反应时爱罗列生理细节）',
    },

    // ---- Abstract-noun fog ----
    { pattern: '氛围', category: 'abstractNoun', weight: 0.4 },
    { pattern: '气息', category: 'abstractNoun', weight: 0.35 },
    { pattern: '存在(着|感)?', category: 'abstractNoun', weight: 0.3 },
    { pattern: '力量', category: 'abstractNoun', weight: 0.3 },
    { pattern: '情绪', category: 'abstractNoun', weight: 0.3 },
    { pattern: '本质', category: 'abstractNoun', weight: 0.4 },
    { pattern: '意义', category: 'abstractNoun', weight: 0.35 },
    { pattern: '色彩', category: 'abstractNoun', weight: 0.3 },
    { pattern: '维度', category: 'abstractNoun', weight: 0.5 },
    { pattern: '层面', category: 'abstractNoun', weight: 0.5 },
    {
      pattern: '感受到[^，。]{0,10}的[^，。]{1,6}',
      category: 'abstractNoun',
      weight: 0.4,
      note: '抽象感受套语',
    },

    // ---- Scene tells (AI 场景套路：用生理反应/虚指代替具体感受) ----
    // 模型表现情绪时最爱三板斧：身体替主体“做出反应”、情绪从某处“涌上
    // 来”、“某种/一种 X”虚指。单次出现人类也写；同篇 2-3 次以上才报警。
    {
      pattern:
        '身体[^，。！？\\n]{0,16}(?:做出了?|给出了?|产生了?)[^，。！？\\n]{0,10}(?:反应|信号)',
      category: 'abstractNoun',
      weight: 0.7,
      severity: 'soft',
      note: '生理反应模板：“身体做出了反应”',
    },
    {
      pattern:
        '(?:恐惧|愤怒|悲伤|紧张|不安|兴奋|激动|寒意|酸涩|刺痛|无力感)[^。！？\\n]{0,10}(?:从|自)[^，。！？\\n]{0,12}(?:窜|涌|升|冒|爬|漫|泛)上来',
      category: 'abstractNoun',
      weight: 0.7,
      severity: 'soft',
      note: '情绪升腾模板：“X从…涌上来”',
    },
    {
      pattern: '(?:某种|一种)[^，。！？\\n]{0,10}(?:感觉|情绪|直觉|声音|气息|味道|东西|存在|氛围)',
      category: 'abstractNoun',
      weight: 0.45,
      severity: 'soft',
      note: '虚指模板：“某种/一种 X”',
    },

    {
      pattern: '仿佛[^，。]{1,20}(一般|似的)',
      category: 'idiomHint',
      weight: 0.4,
      note: '泛化比喻',
    },
    {
      pattern: '一种[^，。]{1,8}(的)?(感觉|气息|情绪|力量)',
      category: 'abstractNoun',
      weight: 0.55,
      note: '“一种…的感觉”模糊化',
    },

    // ---- Nominalization (动词名词化) ----
    // “完成了对流程的优化” → “把流程改顺了”。soft。
    {
      pattern:
        '进行(?:了|一次|一场|着)?[^。，！？\\n]{0,10}(?:调整|优化|升级|分析|讨论|沟通|梳理|复盘|迭代|探索|尝试|思考|规划|布局)',
      category: 'abstractNoun',
      weight: 0.65,
      severity: 'soft',
      note: '名词化：“进行了…”',
    },
    {
      pattern: '实现了?[^。，！？\\n]{0,14}的?[^。，！？\\n]{0,6}(?:提升|增长|突破|转变|跃升|落地)',
      category: 'abstractNoun',
      weight: 0.65,
      severity: 'soft',
      note: '名词化：“实现了…的提升”',
    },
    {
      pattern: '完成了?对[^。，！？\\n]{0,16}的',
      category: 'abstractNoun',
      weight: 0.65,
      severity: 'soft',
      note: '名词化：“完成了对…的”',
    },
    {
      pattern: '起到了?[^。，！？\\n]{0,12}的?作用',
      category: 'abstractNoun',
      weight: 0.6,
      severity: 'soft',
      note: '名词化：“起到了…的作用”',
    },
    {
      pattern: '具有[^。，！？\\n]{0,10}(?:意义|价值)',
      category: 'abstractNoun',
      weight: 0.55,
      severity: 'soft',
      note: '名词化：“具有…意义/价值”',
    },

    // ---- Pivot sentences (翻案腔：先立误解再推翻) ----
    // 禁的是“先给读者立一个他没有的误解，再推翻它抬价”这个动作本身，
    // 不是字面。字面外壳是硬失败；变形（以为体、跨句、省字、抬价体）需要
    // 人工判断，因为它们也可能来自真实经历的自我修正。
    {
      pattern: '(?:并)?不是[^。！？\\n]{0,90}而是',
      category: 'pivot',
      weight: 0.9,
      severity: 'hard',
      note: '“不是A而是B”翻案句',
    },
    {
      pattern: '并非[^。！？\\n]{0,90}而是',
      category: 'pivot',
      weight: 0.9,
      severity: 'hard',
      note: '“并非A而是B”翻案句',
    },
    {
      pattern: '不在于[^。！？\\n]{0,90}而在于',
      category: 'pivot',
      weight: 0.9,
      severity: 'hard',
      note: '“不在于A而在于B”翻案句',
    },
    {
      pattern: '与其说[^。！？\\n]{0,90}(?:不如|毋宁|倒不如)',
      category: 'pivot',
      weight: 0.85,
      severity: 'hard',
      note: '“与其说A不如说B”翻案句',
    },
    {
      pattern: '表面(?:上)?[^。！？\\n]{0,90}(?:其实|实际|实则)',
      category: 'pivot',
      weight: 0.85,
      severity: 'hard',
      note: '“表面A其实B”翻案句',
    },
    {
      pattern: '看似[^。！？\\n]{0,90}(?:其实|实际|实则)',
      category: 'pivot',
      weight: 0.85,
      severity: 'hard',
      note: '“看似A实则B”翻案句',
    },
    {
      pattern: '[。！？!?]\\s*而是',
      category: 'pivot',
      weight: 0.9,
      severity: 'hard',
      note: '跨句翻案：“不是A。而是B”',
    },
    {
      pattern: '(?:总|一直|曾|都)?以为[^！？\\n]{2,60}?(?:其实|才发现|才明白|才知道|后来才)',
      category: 'pivot',
      weight: 0.7,
      severity: 'soft',
      note: '“以为A其实B”变形翻案',
    },
    {
      pattern: '(?:总|都|一直)以为[^！？\\n]{2,60}?[。，](?:可|但|其实)',
      category: 'pivot',
      weight: 0.7,
      severity: 'soft',
      note: '“一直以为A，可B”变形翻案',
    },
    {
      pattern: '回头(?:看|一看)?才(?:发现|明白|知道)',
      category: 'pivot',
      weight: 0.7,
      severity: 'soft',
      note: '“回头才发现”变形翻案',
    },
    {
      pattern: '(?:并)?不是[^。！？\\n]{1,40}，(?:更|才)?是[^，。！？\\n]',
      category: 'pivot',
      weight: 0.65,
      severity: 'soft',
      note: '“不是A，是B”省字变形',
    },
    {
      pattern: '答案(?:是否定的|恰恰相反)|恰恰相反',
      category: 'pivot',
      weight: 0.7,
      severity: 'soft',
      note: '“答案恰恰相反”变形翻案',
    },
    {
      pattern: '[^，。！？\\n]{1,12}不重要，(?:重要|要紧)的是',
      category: 'pivot',
      weight: 0.75,
      severity: 'soft',
      note: '“A不重要，重要的是B”抬价体',
    },
    {
      pattern: '真正[^，。！？\\n]{0,16}的(?:，)?是',
      category: 'pivot',
      weight: 0.55,
      severity: 'soft',
      note: '“真正A的是B”抬价体',
    },

    // ---- Left branching (长前置成分 / 主干晚出) ----
    // 读者要先扛完一大串定语才知道谁做了什么。中文习惯先说人、再说动作。
    // soft：长句本身可以成立，问题是主干被压到太晚。
    {
      pattern:
        '(?:^|[。！？]\\s*)在[^，。！？\\n]{12,70}(?:以后|之后|之前|以前|过程中|情况下|背景下)，',
      category: 'leftBranch',
      weight: 0.6,
      severity: 'soft',
      note: '长前置：“在…之后，…”',
    },
    {
      pattern: '(?:^|[。！？]\\s*)那些[^，。！？\\n]{10,60}的[^，。！？\\n]{2,30}[，。]',
      category: 'leftBranch',
      weight: 0.55,
      severity: 'soft',
      note: '长前置：“那些…的…”',
    },
    {
      pattern: '(?:^|[。！？]\\s*)(?:真正|最终|最后)让[^，。！？\\n]{8,70}的，是',
      category: 'leftBranch',
      weight: 0.6,
      severity: 'soft',
      note: '长前置：“真正让…的，是”',
    },

    // ---- Idiom / four-char stacking (成语与模型爱用的四字表达) ----
    // 真实成语词表驱动（不再把“任意 4 字片段”当成语）。一两个成语是正常
    // 写作；同一篇里大量堆叠这些模型偏爱的四字表达才是问题。soft。
    {
      pattern:
        '风起云涌|跌宕起伏|波澜壮阔|荡气回肠|如诗如画|淋漓尽致|刻骨铭心|恍如隔世|历历在目|栩栩如生|呼之欲出|身临其境|感同身受|心潮澎湃|百感交集|五味杂陈|百转千回|感慨万千|浮想联翩|思绪万千|扑面而来|跃然纸上|娓娓道来|耐人寻味|发人深省|引人入胜|不言而喻|不约而同|毋庸置疑|显而易见|众所周知|蔚然成风|千丝万缕|错综复杂|变幻莫测|暗流涌动|若隐若现|水到渠成|顺理成章|不谋而合|恰如其分|妙不可言|叹为观止|回味无穷|意犹未尽|情真意切|字字珠玑|入木三分|意蕴悠长',
      category: 'idiomHint',
      weight: 0.35,
      severity: 'soft',
      note: '模型偏爱的成语/四字表达（正常使用不受影响，堆叠时提醒）',
    },
  ],
}
