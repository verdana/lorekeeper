import type { RulesPack } from './rules.types'

/**
 * Chinese de-slop rules pack (v1).
 *
 * These are weighted *signals*, not a blacklist. High density of these patterns
 * correlates with machine-generated Chinese prose (over-explicit connectives,
 * abstract-noun fog, symmetric three-part structures). The analyzer combines
 * these with structural stats (sentence-length variance, punctuation variety),
 * so no single phrase alone condemns a sentence.
 */
export const zhRules: RulesPack = {
  version: 'zh-v1',
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
  ],
}
