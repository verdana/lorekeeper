import { describe, expect, it } from 'vitest'
import {
  analyzeSlop,
  getRulesPack,
  isRulesPackOutdated,
  DEFAULT_SLOP_WEIGHTS,
} from '../../src/shared/slop/analyze'

import { validateRulesPack } from '../../src/shared/slop/rules.types'
import { groupRewriteFlags } from '../../src/shared/slop/group'
import type { SlopFlag } from '../../src/shared/types'
import { zh } from '../../src/shared/prompts/zh'
import { en } from '../../src/shared/prompts/en'

function flagAt(start: number, text: string, reasons: SlopFlag['reasons']): SlopFlag {
  return { start, end: start + text.length, text, risk: 0.5, reasons, severity: 'soft', note: '' }
}

describe('pivot sentence detection', () => {
  it('does not hard-flag natural human prose', () => {
    const prose =
      '他把行李收拾好，天亮前离开了这座城。半年后收到一封信，说他平安到了成都，还找了一份修车的工作。'
    const r = analyzeSlop(prose, { lang: 'zh' })
    expect(r.flags.every((f) => f.severity === 'soft')).toBe(true)
  })

  it('flags a literal pivot shell as a hard flag and scores the pivot dimension', () => {
    const prose = '他不是不想留下，而是已经没有退路。夜里他把行李收拾好，天亮前离开了这座城。'
    const r = analyzeSlop(prose, { lang: 'zh' })
    const pivotDim = r.dimensions.find((d) => d.id === 'pivot')!
    expect(pivotDim.score).toBeGreaterThan(0)
    const flag = r.flags.find((f) => f.reasons.includes('pivot'))
    expect(flag).toBeDefined()
    expect(flag!.severity).toBe('hard')
    expect(flag!.risk).toBeGreaterThanOrEqual(0.7)
  })

  it('detects a pivot shell that spans sentence boundaries', () => {
    const prose = '他不是不想留下。而是已经没有退路，天亮前他离开了这座城。'
    const r = analyzeSlop(prose, { lang: 'zh' })
    const flag = r.flags.find((f) => f.reasons.includes('pivot'))
    expect(flag).toBeDefined()
    expect(flag!.severity).toBe('hard')
  })

  it('flags disguised pivots as soft (they may be real self-corrections)', () => {
    const prose = '我一直以为他会来，后来才发现他早就买了去南方的票。'
    const r = analyzeSlop(prose, { lang: 'zh' })
    const flag = r.flags.find((f) => f.reasons.includes('pivot'))
    expect(flag).toBeDefined()
    expect(flag!.severity).toBe('soft')
  })

  it('does not flag plain declarative prose', () => {
    const prose = '他把行李收拾好，天亮前离开了这座城。半年后收到一封信，说他平安到了成都。'
    const r = analyzeSlop(prose, { lang: 'zh' })
    expect(r.flags.some((f) => f.reasons.includes('pivot'))).toBe(false)
  })

  it('keeps the english analyzer at zero pivot score (no en pivot rules)', () => {
    const r = analyzeSlop('He left the city at dawn. Nobody knew where he went.', { lang: 'en' })
    const pivotDim = r.dimensions.find((d) => d.id === 'pivot')!
    expect(pivotDim.score).toBe(0)
  })
})

describe('weight compatibility with older configs', () => {
  it('fills missing pivot weight from defaults instead of producing NaN', () => {
    // Simulates a config saved before the pivot dimension existed.
    const legacyWeights = {
      burstiness: 0.2,
      connectives: 0.18,
      parallelism: 0.12,
      abstractNouns: 0.12,
      sentenceHeadRepetition: 0.1,
      punctuationMonotony: 0.1,
      idiomDensity: 0.08,
      paragraphUniformity: 0.1,
    } as never
    const prose = '他不是不想留下，而是已经没有退路。'
    const r = analyzeSlop(prose, { lang: 'zh', weights: legacyWeights })
    expect(Number.isFinite(r.score)).toBe(true)
    const pivotDim = r.dimensions.find((d) => d.id === 'pivot')!
    expect(pivotDim.weight).toBe(DEFAULT_SLOP_WEIGHTS.pivot)
  })
})

describe('lyric words and nominalization', () => {
  it('scores the abstractNouns dimension and flags lyric words', () => {
    const prose =
      '山间的微光落在湖面上，一切都被温柔地安放。那份丰盈让他觉得自己终于抵达了某个地方。'
    const r = analyzeSlop(prose, { lang: 'zh' })
    const abs = r.dimensions.find((d) => d.id === 'abstractNouns')!
    expect(abs.score).toBeGreaterThan(0)
    expect(r.flags.some((f) => f.reasons.includes('abstractNouns'))).toBe(true)
  })

  it('flags nominalized verbs ("进行了…优化", "实现了…提升")', () => {
    const prose = '我们对这套流程进行了优化，并且实现了效率的提升。'
    const r = analyzeSlop(prose, { lang: 'zh' })
    const abs = r.dimensions.find((d) => d.id === 'abstractNouns')!
    expect(abs.score).toBeGreaterThan(0)
    expect(r.flags.some((f) => f.reasons.includes('abstractNouns'))).toBe(true)
  })
})

describe('left branching and heavy-的 heads', () => {
  it('scores leftBranch and flags a long leading clause', () => {
    const prose = '在经历了长达数年的反复尝试和无数次失败之后，他终于放弃了原来的方向。'
    const r = analyzeSlop(prose, { lang: 'zh' })
    const lb = r.dimensions.find((d) => d.id === 'leftBranch')!
    expect(lb.score).toBeGreaterThan(0)
    expect(r.flags.some((f) => f.reasons.includes('leftBranch'))).toBe(true)
  })

  it('flags a sentence whose head is buried under four-plus 的', () => {
    const prose =
      '那条被雨水打湿的、铺满落叶的、通向山谷深处的小路，是他每天清晨冒着雾气都要走过的那条路。'
    const r = analyzeSlop(prose, { lang: 'zh' })
    expect(r.flags.some((f) => f.reasons.includes('leftBranch'))).toBe(true)
  })

  it('keeps the english analyzer at zero leftBranch score', () => {
    const r = analyzeSlop('He left the city at dawn after years of trying.', { lang: 'en' })
    const lb = r.dimensions.find((d) => d.id === 'leftBranch')!
    expect(lb.score).toBe(0)
  })
})

describe('metaphor cluster', () => {
  it('boosts idiomDensity when 3+ borrowed fields mix in a short window', () => {
    const prose =
      '整个市场正在降温，竞争对手感到了寒意。仓库里的库存还在积压，每月的租金压得人喘不过气。公司站在十字路口，赛道上的对手却越跑越快。'
    const r = analyzeSlop(prose, { lang: 'zh' })
    const idiom = r.dimensions.find((d) => d.id === 'idiomDensity')!
    expect(idiom.score).toBeGreaterThanOrEqual(0.6)
    expect(r.flags.some((f) => f.reasons.includes('idiomDensity'))).toBe(true)
  })

  it('does not flag a single metaphor field used in its literal sense', () => {
    const prose = '他把仓库的货搬到库房，清点了库存，又核对了一遍租金单据。'
    const r = analyzeSlop(prose, { lang: 'zh' })
    // One field used literally must not trigger the cluster: no idiomDensity flag.
    expect(r.flags.some((f) => f.reasons.includes('idiomDensity'))).toBe(false)
  })
})

describe('repeated sentence heads', () => {
  it('flags adjacent sentences whose first two chars repeat', () => {
    const prose = '他走了三站路，才找到那家店。他走了以后，店里冷清了许多。他走了，留下一封信。'
    const r = analyzeSlop(prose, { lang: 'zh' })
    const headFlags = r.flags.filter((f) => f.reasons.includes('sentenceHeadRepetition'))
    expect(headFlags.length).toBeGreaterThanOrEqual(3)
    expect(headFlags.every((f) => f.severity === 'soft')).toBe(true)
  })

  it('flags just two adjacent sentences sharing a head', () => {
    const prose = '他说要走了。他说不用送了。她没说话。'
    const r = analyzeSlop(prose, { lang: 'zh' })
    const headFlags = r.flags.filter((f) => f.reasons.includes('sentenceHeadRepetition'))
    expect(headFlags.length).toBe(2)
  })

  it('ignores scattered repeats (same head, not adjacent)', () => {
    const prose = '他说要走。她没说话。外面下着雨。他说不用送了。'
    const r = analyzeSlop(prose, { lang: 'zh' })
    expect(r.flags.some((f) => f.reasons.includes('sentenceHeadRepetition'))).toBe(false)
    const dim = r.dimensions.find((d) => d.id === 'sentenceHeadRepetition')!
    expect(dim.score).toBe(0)
  })

  it('does not flag sentences with different heads', () => {
    const prose = '他走了三站路，才找到那家店。她随后也走了，去了南方。'
    const r = analyzeSlop(prose, { lang: 'zh' })
    expect(r.flags.some((f) => f.reasons.includes('sentenceHeadRepetition'))).toBe(false)
  })

  it('drops to zero once the adjacent repeat is edited away', () => {
    const before = '他说要走了。他说不用送了。她没说话。'
    const after = '他说要走了。阿蛮摆摆手，不用送了。她没说话。'
    const a = analyzeSlop(before, { lang: 'zh' })
    const b = analyzeSlop(after, { lang: 'zh' })
    const dim = (r: ReturnType<typeof analyzeSlop>) =>
      r.dimensions.find((d) => d.id === 'sentenceHeadRepetition')!.score
    expect(dim(a)).toBeGreaterThan(dim(b))
    expect(dim(b)).toBeLessThanOrEqual(0.2)
  })
})

describe('idiom density', () => {
  it('scores plain prose near zero (no raw 4-char-block miscount)', () => {
    const prose =
      '他把行李收拾好，天亮前离开了这座城。半年后收到一封信，说他平安到了成都，还找了一份修车的工作。'
    const r = analyzeSlop(prose, { lang: 'zh' })
    const idiom = r.dimensions.find((d) => d.id === 'idiomDensity')!
    expect(idiom.score).toBeLessThan(0.3)
    expect(r.flags.some((f) => f.reasons.includes('idiomDensity'))).toBe(false)
  })

  it('flags prose stacked with model-favored idioms', () => {
    const prose =
      '那一刻他心潮澎湃，往事历历在目。多年坚持终于水到渠成，其中的酸甜苦辣刻骨铭心，如诗如画的岁月扑面而来。'
    const r = analyzeSlop(prose, { lang: 'zh' })
    const idiom = r.dimensions.find((d) => d.id === 'idiomDensity')!
    expect(idiom.score).toBeGreaterThan(0.5)
    expect(r.flags.some((f) => f.reasons.includes('idiomDensity'))).toBe(true)
  })
})

describe('validateRulesPack', () => {
  it('accepts a valid pack and clamps out-of-range weights', () => {
    const pack = validateRulesPack({
      version: 'zh-v2',
      lang: 'zh',
      rules: [
        { pattern: '然而', category: 'connective', weight: 0.5, note: 'test' },
        { pattern: '氛围', category: 'abstractNoun', weight: 1.2 }, // 越界 → clamp 到 1
        { pattern: '总之', category: 'connective', weight: -0.3 }, // 越界 → clamp 到 0
      ],
    })
    expect(pack.version).toBe('zh-v2')
    expect(pack.lang).toBe('zh')
    expect(pack.rules).toHaveLength(3)
    expect(pack.rules[0]).toEqual({
      pattern: '然而',
      category: 'connective',
      weight: 0.5,
      note: 'test',
    })
    expect(pack.rules[1].weight).toBe(1)
    expect(pack.rules[2].weight).toBe(0)
  })

  it('rejects non-object, missing version, bad lang, and missing rules', () => {
    expect(() => validateRulesPack(null)).toThrow()
    expect(() => validateRulesPack('pack')).toThrow()
    expect(() => validateRulesPack({ lang: 'zh', rules: [] })).toThrow(/version/)
    expect(() => validateRulesPack({ version: 'v1', lang: 'xx', rules: [] })).toThrow(/lang/)
    expect(() => validateRulesPack({ version: 'v1', lang: 'zh' })).toThrow(/rules/)
  })

  it('rejects malformed rules', () => {
    const base = { version: 'v1', lang: 'zh' }
    expect(() =>
      validateRulesPack({ ...base, rules: [{ pattern: 'x', category: 'nope', weight: 1 }] }),
    ).toThrow(/category/)
    expect(() =>
      validateRulesPack({ ...base, rules: [{ pattern: '  ', category: 'connective', weight: 1 }] }),
    ).toThrow(/pattern/)
    expect(() =>
      validateRulesPack({
        ...base,
        rules: [{ pattern: 'x', category: 'connective', weight: '1' }],
      }),
    ).toThrow(/weight/)
    expect(() =>
      validateRulesPack({
        ...base,
        rules: [{ pattern: 'x', category: 'connective', weight: 1, note: 5 }],
      }),
    ).toThrow(/note/)
  })

  it('rejects non-compilable regex patterns', () => {
    expect(() =>
      validateRulesPack({
        ...{ version: 'v1', lang: 'zh' },
        rules: [{ pattern: '(unclosed', category: 'connective', weight: 1 }],
      }),
    ).toThrow(/pattern/)
    expect(() =>
      validateRulesPack({
        ...{ version: 'v1', lang: 'en' },
        rules: [{ pattern: '[a-', category: 'connective', weight: 1 }],
      }),
    ).toThrow(/pattern/)
  })
})

describe('custom rules pack in analysis', () => {
  // 长文本使单条命中不顶格；'居然' 不在内置 zh 连接词规则中
  const prose =
    '他居然在最后一刻改变了主意，然后默默收拾好行装，沿着昏暗的小巷走向车站，消失在清晨的薄雾之中。'

  it('uses a custom pack to change the connective score', () => {
    const base = analyzeSlop(prose, { lang: 'zh' })
    const custom = validateRulesPack({
      version: 'zh-v9',
      lang: 'zh',
      rules: [{ pattern: '居然', category: 'connective', weight: 1 }],
    })
    const withCustom = analyzeSlop(prose, { lang: 'zh', rulesPack: custom })
    const baseScore = base.dimensions.find((d) => d.id === 'connectives')!.score
    const customScore = withCustom.dimensions.find((d) => d.id === 'connectives')!.score
    expect(baseScore).toBeLessThan(customScore)
  })

  it('falls back to the built-in pack when rulesPack is null/undefined', () => {
    const a = analyzeSlop(prose, { lang: 'zh', rulesPack: null })
    const b = analyzeSlop(prose, { lang: 'zh' })
    expect(a.score).toBe(b.score)
  })
})

describe('getRulesPack and isRulesPackOutdated', () => {
  const custom = validateRulesPack({ version: 'en-v9', lang: 'en', rules: [] })

  it('getRulesPack prefers the custom pack', () => {
    expect(getRulesPack('en', custom).version).toBe('en-v9')
    expect(getRulesPack('en').version).toBe('en-v1') // built-in
  })

  it('isRulesPackOutdated compares against the active pack', () => {
    // 自定义 v9 生效：stored v1 < v9 → outdated
    expect(isRulesPackOutdated('en-v1', 'en', custom)).toBe(true)
    // stored v9 与自定义 v9 相同 → 不 outdated
    expect(isRulesPackOutdated('en-v9', 'en', custom)).toBe(false)
    // 无自定义包：stored v1 与内置 v1 相同 → 不 outdated
    expect(isRulesPackOutdated('en-v1', 'en')).toBe(false)
    // 存储标签语言前缀与当前语言不一致 → 视为无记录，不 outdated
    expect(isRulesPackOutdated('zh-v9', 'en')).toBe(false)
    expect(isRulesPackOutdated('en-v9', 'zh')).toBe(false)
  })
})

describe('groupRewriteFlags', () => {
  it('merges adjacent sentences sharing a repeated head into one group', () => {
    const fullText = '他走了三站路，才找到那家店。他走了以后，店里冷清了许多。她转身回了屋。'
    const s1 = '他走了三站路，才找到那家店。'
    const s2 = '他走了以后，店里冷清了许多。'
    const s3 = '她转身回了屋。'
    const flags = [
      flagAt(fullText.indexOf(s1), s1, ['sentenceHeadRepetition']),
      flagAt(fullText.indexOf(s2), s2, ['sentenceHeadRepetition']),
      flagAt(fullText.indexOf(s3), s3, []),
    ]
    const groups = groupRewriteFlags(flags, fullText)
    expect(groups).toHaveLength(2)
    expect(groups[0].size).toBe(2)
    expect(groups[0].groupNote).toBeDefined()
    expect(groups[0].original).toContain(s1)
    expect(groups[0].original).toContain(s2)
    expect(groups[1].size).toBe(1)
    expect(groups[1].groupNote).toBeUndefined()
  })

  it('keeps same-head sentences apart when other prose sits between them', () => {
    const fullText = '他走了三站路。她转身回了屋。他走了以后，店里冷清了许多。'
    const s1 = '他走了三站路。'
    const s3 = '他走了以后，店里冷清了许多。'
    const flags = [
      flagAt(fullText.indexOf(s1), s1, ['sentenceHeadRepetition']),
      flagAt(fullText.indexOf(s3), s3, ['sentenceHeadRepetition']),
    ]
    const groups = groupRewriteFlags(flags, fullText)
    expect(groups).toHaveLength(2)
    expect(groups.every((g) => g.size === 1)).toBe(true)
  })

  it('does not merge adjacent flags with different heads', () => {
    const fullText = '他走了三站路。她随后也走了。'
    const s1 = '他走了三站路。'
    const s2 = '她随后也走了。'
    const flags = [
      flagAt(0, s1, ['sentenceHeadRepetition']),
      flagAt(fullText.indexOf(s2), s2, ['sentenceHeadRepetition']),
    ]
    const groups = groupRewriteFlags(flags, fullText)
    expect(groups).toHaveLength(2)
    expect(groups.every((g) => g.size === 1)).toBe(true)
  })
})

describe('rewrite intensity prompt', () => {
  it('zh template renders distinct guidance per intensity', () => {
    const light = zh.deslop.userTemplate({ sample: 's', voice: '', intensity: 'light' })
    const balanced = zh.deslop.userTemplate({ sample: 's', voice: '', intensity: 'balanced' })
    const strong = zh.deslop.userTemplate({ sample: 's', voice: '', intensity: 'strong' })
    expect(light).toContain('轻度')
    expect(balanced).toContain('平衡')
    expect(strong).toContain('强烈')
    expect(light).not.toBe(balanced)
    expect(balanced).not.toBe(strong)
    expect(light).toContain('不要重组句子')
    expect(strong).toContain('重组句子')
  })

  it('zh template renders a group note only when provided', () => {
    const grouped = zh.deslop.userTemplate({
      sample: 'a\nb',
      voice: '',
      intensity: 'light',
      groupNote: '以下 2 句以「他走」开头',
    })
    expect(grouped).toContain('本组说明')
    expect(grouped).toContain('整段当作一组')
    const single = zh.deslop.userTemplate({ sample: 'a', voice: '', intensity: 'light' })
    expect(single).not.toContain('本组说明')
    expect(single).toContain('只输出改写后的段落')
  })

  it('en template renders distinct guidance per intensity', () => {
    const light = en.deslop.userTemplate({ sample: 's', voice: '', intensity: 'light' })
    const strong = en.deslop.userTemplate({ sample: 's', voice: '', intensity: 'strong' })
    expect(light).toContain('Light touch')
    expect(strong).toContain('Bold')
    expect(light).not.toBe(strong)
    expect(light).toContain('Do not restructure sentences')
    expect(strong).toContain('restructure sentences')
  })
})
describe('scene-tell templates and long-sentence gap', () => {
  it('flags the body-reaction template and scores the abstractNouns dimension', () => {
    const prose = '身体在看到那座建筑的瞬间做出了反应——胃部收紧，呼吸变浅，脚趾在靴子里蜷起来。'
    const r = analyzeSlop(prose, { lang: 'zh' })
    const dim = r.dimensions.find((d) => d.id === 'abstractNouns')!
    expect(dim.score).toBeGreaterThan(0.5)
    const flag = r.flags.find((f) => f.reasons.includes('abstractNouns'))
    expect(flag).toBeDefined()
    expect(flag!.text).toContain('身体')
  })

  it('flags the emotion-surge template (X从…涌上来)', () => {
    const prose = '恐惧从脊柱底端骤然窜上来，他站在原地没有动。'
    const r = analyzeSlop(prose, { lang: 'zh' })
    const flag = r.flags.find((f) => f.reasons.includes('abstractNouns'))
    expect(flag).toBeDefined()
    expect(flag!.text).toContain('恐惧')
  })

  it('flags vague 某种/一种X references without condemning a single occurrence', () => {
    const one = analyzeSlop(
      '他推开窗，空气里多了一种味道，像是雨后的泥土。他站了一会儿，把灯关上，回到屋里继续收拾行李。天色将暗，远处传来钟声。',
      { lang: 'zh' },
    )
    const absDim = one.dimensions.find((d) => d.id === 'abstractNouns')!
    expect(absDim.score).toBeLessThan(0.4)
    const many = analyzeSlop('空气里多了一种味道。像某种耐心等他靠近的东西。那声音像一种低语。', {
      lang: 'zh',
    })
    const dim2 = many.dimensions.find((d) => d.id === 'abstractNouns')!
    expect(dim2.score).toBeGreaterThan(0.4)
  })

  it('detects a physiological three-item list as parallelism', () => {
    const prose = '胃部收紧，呼吸变浅，脚趾在靴子里蜷起来。'
    const r = analyzeSlop(prose, { lang: 'zh' })
    const flag = r.flags.find((f) => f.reasons.includes('parallelism'))
    expect(flag).toBeDefined()
  })

  it('flags flat rhythm when the longest sentence is short', () => {
    const flat = '他走了。树很高。天很暗。风停了。路很远。她没说话。影子很长。雾散了。'
    const r = analyzeSlop(flat, { lang: 'zh' })
    const dim = r.dimensions.find((d) => d.id === 'burstiness')!
    expect(dim.score).toBeGreaterThan(0.3)
  })

  it('does not flag rhythm when a real long sentence is present', () => {
    const prose =
      '那是一座被雨水浸泡了整整一个夏天的老宅，木头在潮气里发胀，墙皮一块块剥落，露出底下深褐色的旧砖，连空气里都浸着那种挥之不去的霉味。他站在门口。'
    const r = analyzeSlop(prose, { lang: 'zh' })
    const dim = r.dimensions.find((d) => d.id === 'burstiness')!
    expect(dim.score).toBeLessThan(0.3)
  })
})
