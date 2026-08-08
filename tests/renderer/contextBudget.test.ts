import { describe, expect, it } from 'vitest'
import { CONTEXT_BUDGET, createContextAllocator } from '../../src/renderer/src/contextBudget'

describe('createContextAllocator', () => {
  const long = 'x'.repeat(CONTEXT_BUDGET + 1000)

  it('returns everything unchanged within budget', () => {
    const a = createContextAllocator({ settings: 0.3, outline: 0.1, timeline: 0.1, memories: 0.25 })
    const out = a({ settings: 's', outline: 'o', timeline: 't', memories: 'm', prevChapters: 'p' })
    expect(out).toMatchObject({
      settings: 's',
      outline: 'o',
      timeline: 't',
      memories: 'm',
      prevChapters: 'p',
      truncated: false,
    })
  })

  it('truncates each input to its share and gives prev the remainder (tail-first)', () => {
    const a = createContextAllocator({ settings: 0.3, outline: 0.1, timeline: 0.1, memories: 0.25 })
    const out = a({
      settings: long,
      outline: long,
      timeline: long,
      memories: long,
      prevChapters: long,
    })
    expect(out.truncated).toBe(true)
    expect(out.settings.length).toBe(Math.floor(CONTEXT_BUDGET * 0.3))
    expect(out.outline.length).toBe(Math.floor(CONTEXT_BUDGET * 0.1))
    expect(out.timeline.length).toBe(Math.floor(CONTEXT_BUDGET * 0.1))
    expect(out.memories.length).toBe(Math.floor(CONTEXT_BUDGET * 0.25))
    // prev gets the remainder, taken from the end (most recent first).
    const used =
      Math.floor(CONTEXT_BUDGET * 0.3) +
      Math.floor(CONTEXT_BUDGET * 0.1) +
      Math.floor(CONTEXT_BUDGET * 0.1) +
      Math.floor(CONTEXT_BUDGET * 0.25)
    expect(out.prevChapters).toBe(long.slice(-(CONTEXT_BUDGET - used)))
  })
})
