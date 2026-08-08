import { describe, expect, it } from 'vitest'
import {
  buildWritingSystemPrompt,
  countGramHits,
  extractSignalGrams,
} from '../../src/renderer/src/writingStyle'
import type { VoiceProfile } from '../../src/shared/types'

describe('extractSignalGrams', () => {
  it('extracts Chinese bigrams from a CJK run', () => {
    const grams = extractSignalGrams('魔法体系与龙族战争')
    expect(grams).toContain('魔法')
    expect(grams).toContain('法体')
    expect(grams).toContain('体系')
    expect(grams).toContain('龙族')
  })

  it('extracts English words lowercased and deduped', () => {
    expect(extractSignalGrams('Magic magic system')).toEqual(['magic', 'system'])
  })

  it('never emits common stop words', () => {
    const grams = extractSignalGrams('我们然后他们')
    expect(grams.filter((g) => ['我们', '然后', '他们'].includes(g))).toEqual([])
  })

  it('respects the maxGrams cap', () => {
    const grams = extractSignalGrams('一二三四五六七八九十'.repeat(50), 10)
    expect(grams.length).toBeLessThanOrEqual(10)
  })
})

describe('countGramHits', () => {
  it('matches case-insensitively', () => {
    expect(countGramHits('The MAGIC system', ['magic'])).toBe(1)
  })

  it('caps at 3 hits so the caller can bail early', () => {
    expect(countGramHits('甲乙丙丁', ['甲乙', '乙丙', '丙丁', '甲乙'])).toBe(3)
  })
})

describe('buildWritingSystemPrompt', () => {
  const voice: VoiceProfile = {
    generatedAt: 0,
    sampleChapterIds: [],
    traits: {
      sentenceLength: '12–25 words',
      verbStyle: 'concrete verbs',
      narrativeDistance: 'third-person limited',
      dialogueStyle: 'terse',
      rhetoricalPatterns: 'sparse metaphor',
      proseNotes: 'note',
    },
  }

  it('returns the base prompt unchanged when nothing is injected', () => {
    const out = buildWritingSystemPrompt('base', {
      voiceProfile: null,
      genre: '',
      exemplars: [],
    })
    expect(out).toBe('base')
  })

  it('injects the genre string into the anchor', () => {
    const out = buildWritingSystemPrompt('base', {
      voiceProfile: null,
      genre: '西幻',
      exemplars: [],
    })
    expect(out.startsWith('base')).toBe(true)
    expect(out).toContain('西幻')
  })

  it('numbers and embeds exemplars', () => {
    const out = buildWritingSystemPrompt('base', {
      voiceProfile: null,
      genre: '',
      exemplars: ['Sample A', 'Sample B'],
    })
    expect(out).toContain('1. Sample A')
    expect(out).toContain('2. Sample B')
  })

  it('appends the voice profile traits', () => {
    const out = buildWritingSystemPrompt('base', {
      voiceProfile: voice,
      genre: '',
      exemplars: [],
    })
    expect(out).toContain(voice.traits.sentenceLength)
  })
})
