import { describe, expect, it } from 'vitest'
import {
  buildWritingSystemPrompt,
  countGramHits,
  extractSignalGrams,
  isProfileEmpty,
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
      diction: 'concrete over abstract',
      syntax: 'comma-linked coordination',
      punctuation: 'sparse exclamation',
      paragraphing: 'short paragraphs',
      characterVoices: 'per-POV fingerprints',
      emotionExternalization: 'objects and gestures',
      sensoryPalette: 'hearing-dominant',
      motifs: 'water, tickets',
      taboos: 'no direct emotion adjectives',
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
    // Newer dimensions are injected too.
    expect(out).toContain(voice.traits.diction)
    expect(out).toContain(voice.traits.taboos)
    expect(out).toContain(voice.traits.characterVoices)
  })

  it('skips absent optional traits instead of injecting "undefined"', () => {
    const legacyVoice: VoiceProfile = {
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
    const out = buildWritingSystemPrompt('base', {
      voiceProfile: legacyVoice,
      genre: '',
      exemplars: [],
    })
    expect(out).toContain('12–25 words')
    expect(out).not.toContain('undefined')
  })

  it('keeps genre + exemplars but omits the voice section when voiceProfile is null (setting-doc polish path)', () => {
    const out = buildWritingSystemPrompt('base', {
      voiceProfile: null,
      genre: '西幻',
      exemplars: ['Sample A'],
    })
    expect(out).toContain('西幻')
    expect(out).toContain('1. Sample A')
    expect(out).not.toContain('voice profile')
    expect(out).not.toContain('句长')
  })

  it('injects manualText verbatim and ignores structured traits when present', () => {
    const manual: VoiceProfile = {
      ...voice,
      manualText: '  Terse third-person prose, short sentences, dry irony.  ',
    }
    const out = buildWritingSystemPrompt('base', {
      voiceProfile: manual,
      genre: '',
      exemplars: [],
    })
    expect(out).toContain('Terse third-person prose, short sentences, dry irony.')
    // Structured traits must not leak into the prompt while a manual voice is set.
    expect(out).not.toContain(voice.traits.sentenceLength)
    expect(out).not.toContain(voice.traits.diction)
  })

  it('injects manualText even when the profile has no analysed traits', () => {
    const manualOnly: VoiceProfile = {
      generatedAt: 0,
      sampleChapterIds: [],
      manualText: 'Spare, rhythmic sentences; concrete nouns over adjectives.',
      traits: {
        sentenceLength: '',
        verbStyle: '',
        narrativeDistance: '',
        dialogueStyle: '',
        rhetoricalPatterns: '',
        proseNotes: '',
      },
    }
    const out = buildWritingSystemPrompt('base', {
      voiceProfile: manualOnly,
      genre: '',
      exemplars: [],
    })
    expect(out).toContain('Spare, rhythmic sentences; concrete nouns over adjectives.')
  })

  it('falls back to structured traits when manualText is blank or missing', () => {
    const blankManual: VoiceProfile = { ...voice, manualText: '   ' }
    const out = buildWritingSystemPrompt('base', {
      voiceProfile: blankManual,
      genre: '',
      exemplars: [],
    })
    expect(out).toContain(voice.traits.sentenceLength)
  })

  it('trims trait values on injection and skips whitespace-only traits', () => {
    const padded: VoiceProfile = {
      ...voice,
      traits: {
        ...voice.traits,
        sentenceLength: '  12–25 words  ',
        verbStyle: '   ',
      },
    }
    const out = buildWritingSystemPrompt('base', {
      voiceProfile: padded,
      genre: '',
      exemplars: [],
    })
    expect(out).toContain('- 句长: 12–25 words')
    // Whitespace-only trait must not produce a garbage bullet.
    expect(out).not.toContain('动词风格:')
  })
})

describe('isProfileEmpty', () => {
  it('treats null/undefined as empty', () => {
    expect(isProfileEmpty(null)).toBe(true)
    expect(isProfileEmpty(undefined)).toBe(true)
  })

  it('treats a manual-only profile as non-empty', () => {
    expect(
      isProfileEmpty({
        generatedAt: 0,
        sampleChapterIds: [],
        manualText: 'Terse prose.',
        traits: {
          sentenceLength: '',
          verbStyle: '',
          narrativeDistance: '',
          dialogueStyle: '',
          rhetoricalPatterns: '',
          proseNotes: '',
        },
      }),
    ).toBe(false)
  })

  it('treats a profile with only pasted samples and blank traits as empty', () => {
    // Samples are not injected by buildVoiceContext — only manualText/traits are.
    expect(
      isProfileEmpty({
        generatedAt: 0,
        sampleChapterIds: ['c1'],
        sampleTexts: ['Sample prose.'],
        traits: {
          sentenceLength: '',
          verbStyle: '',
          narrativeDistance: '',
          dialogueStyle: '',
          rhetoricalPatterns: '',
          proseNotes: '',
        },
      }),
    ).toBe(true)
  })

  it('treats a profile with any non-blank trait as non-empty', () => {
    expect(
      isProfileEmpty({
        generatedAt: 0,
        sampleChapterIds: ['c1'],
        traits: {
          sentenceLength: 'Short.',
          verbStyle: '',
          narrativeDistance: '',
          dialogueStyle: '',
          rhetoricalPatterns: '',
          proseNotes: '',
        },
      }),
    ).toBe(false)
  })

  it('treats whitespace-only traits as empty', () => {
    expect(
      isProfileEmpty({
        generatedAt: 0,
        sampleChapterIds: ['c1'],
        traits: {
          sentenceLength: '   ',
          verbStyle: '  ',
          narrativeDistance: '',
          dialogueStyle: '',
          rhetoricalPatterns: '',
          proseNotes: '',
        },
      }),
    ).toBe(true)
  })

  it('survives a profile missing the traits field', () => {
    expect(
      isProfileEmpty({
        generatedAt: 0,
        sampleChapterIds: ['c1'],
      } as unknown as VoiceProfile),
    ).toBe(true)
  })

  it('treats a profile with no injectable content as empty', () => {
    expect(
      isProfileEmpty({
        generatedAt: 0,
        sampleChapterIds: [],
        traits: {
          sentenceLength: '',
          verbStyle: '',
          narrativeDistance: '',
          dialogueStyle: '',
          rhetoricalPatterns: '',
          proseNotes: '',
        },
      }),
    ).toBe(true)
  })
})
