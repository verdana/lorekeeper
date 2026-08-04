import { describe, expect, it } from 'vitest'
import { changeRatio, computeDiff } from '../../src/renderer/src/diff'

describe('computeDiff', () => {
  it('detects same / added / removed segments for short prose', () => {
    // '好' 被 '新' 替换：same(你) + removed(好) + added(新) + same(世界)
    const segments = computeDiff('你好世界', '你新世界')
    expect(segments.some((s) => s.type === 'same')).toBe(true)
    expect(segments.some((s) => s.type === 'added')).toBe(true)
    expect(segments.some((s) => s.type === 'removed')).toBe(true)
  })

  it('returns identical text as a single same segment', () => {
    const segments = computeDiff('abc def', 'abc def')
    expect(segments).toHaveLength(1)
    expect(segments[0].type).toBe('same')
    expect(segments[0].text).toBe('abc def')
  })

  it('degrades to full remove+add instead of O(m*n) blow-up for huge inputs', () => {
    // 1001×1001 > MAX_LCS_CELLS（100 万）；全 CJK 逐字 token
    const original = '测'.repeat(1001)
    const revised = '试'.repeat(1001)
    const start = Date.now()
    const segments = computeDiff(original, revised)
    expect(Date.now() - start).toBeLessThan(500)
    expect(segments).toHaveLength(2)
    expect(segments[0].type).toBe('removed')
    expect(segments[1].type).toBe('added')
    expect(changeRatio(original, revised)).toBeGreaterThan(0.99)
  })

  it('still aligns segments for inputs within the LCS budget', () => {
    const original = '测'.repeat(100)
    const revised = '测'.repeat(50) + '试' + '测'.repeat(49)
    const segments = computeDiff(original, revised)
    expect(segments.some((s) => s.type === 'added')).toBe(true)
    expect(segments.some((s) => s.type === 'removed')).toBe(true)
  })
})
