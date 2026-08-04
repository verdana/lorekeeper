import { describe, expect, it } from 'vitest'
import { analyzeSlop, getRulesPack, isRulesPackOutdated } from '../../src/shared/slop/analyze'
import { validateRulesPack } from '../../src/shared/slop/rules.types'
import { zh } from '../../src/shared/prompts/zh'
import { en } from '../../src/shared/prompts/en'

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
