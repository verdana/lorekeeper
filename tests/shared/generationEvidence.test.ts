import { describe, expect, it } from 'vitest'
import {
  calculateRetentionRatio,
  estimateChatUsage,
  estimateTokenCount,
} from '../../src/shared/generationEvidence'

describe('generation evidence metrics', () => {
  it('estimates CJK-heavy text more densely than Latin text', () => {
    expect(estimateTokenCount('甲乙丙丁')).toBe(4)
    expect(estimateTokenCount('abcdefgh')).toBe(2)
  })

  it('separately estimates chat input and output usage', () => {
    const usage = estimateChatUsage([{ role: 'user', content: '甲乙' }], '丙丁')
    expect(usage).toMatchObject({ source: 'estimated', outputTokens: 2 })
    expect(usage.totalTokens).toBe((usage.inputTokens ?? 0) + 2)
  })

  it('measures selected-token retention without penalizing surrounding author text', () => {
    expect(calculateRetentionRatio('甲乙丙丁', '# 标题\n\n甲乙丙丁\n尾声')).toBe(1)
    expect(calculateRetentionRatio('甲乙丙丁', '甲乙丁')).toBe(0.75)
    expect(calculateRetentionRatio('', '任意文本')).toBe(0)
  })
})
