import { describe, expect, it } from 'vitest'
import { extractBodyFromAnswer } from '../../src/renderer/src/lib'

describe('extractBodyFromAnswer', () => {
  it('returns the text after the 【正文】 marker', () => {
    const answer =
      '【节点落地清单】\n- 三条约定 → 马背谈判场景\n- 封条鉴定 → 排污道入口\n\n【正文】\n马停在山道边。'
    expect(extractBodyFromAnswer(answer)).toBe('\n马停在山道边。')
  })

  it('returns the whole text when the marker is absent (legacy outputs)', () => {
    const answer = '马停在山道边。\n瓦莱里娅没有回头。'
    expect(extractBodyFromAnswer(answer)).toBe(answer)
  })

  it('keeps content that follows the marker across multiple lines', () => {
    const answer = '【节点落地清单】\n- 节点一\n\n【正文】\n第一段。\n\n第二段。'
    expect(extractBodyFromAnswer(answer)).toContain('第一段。')
    expect(extractBodyFromAnswer(answer)).toContain('第二段。')
    expect(extractBodyFromAnswer(answer)).not.toContain('节点一')
  })

  it('handles an empty answer', () => {
    expect(extractBodyFromAnswer('')).toBe('')
  })
})
