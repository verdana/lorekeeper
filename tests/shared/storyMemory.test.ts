import { describe, expect, it } from 'vitest'
import {
  applyStoryMemoryBatchStatus,
  browseStoryMemories,
  findStoryMemoryDuplicateGroups,
  isStoryMemoryStale,
  orderedChapters,
  parseStoryMemoryCandidates,
  selectStoryMemories,
  storyMemoryFingerprint,
} from '../../src/shared/storyMemory'
import type {
  Chapter,
  NovelMeta,
  StoryMemoryEntry,
  StoryMemoryStore,
  Volume,
} from '../../src/shared/types'

const chapter = (id: string, order: number): Chapter => ({
  id,
  volumeId: 'volume-1',
  title: `Chapter ${order + 1}`,
  order,
  file: `${id}.md`,
  wordCount: 0,
  status: 'draft',
  updatedAt: 1,
})

const novel = (volumes: Volume[]): NovelMeta => ({
  title: 'Test Novel',
  author: '',
  synopsis: '',
  tags: [],
  volumes,
})

const memory = (
  id: string,
  chapterId: string,
  fingerprint: string,
  overrides: Partial<StoryMemoryEntry> = {},
): StoryMemoryEntry => ({
  id,
  kind: 'character-state',
  statement: `${id} statement`,
  entityRefIds: [],
  source: {
    chapterId,
    chapterFile: `${chapterId}.md`,
    chapterTitle: chapterId,
    volumeId: 'volume-1',
    volumeOrder: 0,
    chapterOrder: 0,
    fingerprint,
    evidence: 'Evidence from the source chapter.',
  },
  timelineEventId: null,
  storyDateLabel: '',
  confidence: 0.8,
  status: 'confirmed',
  origin: 'author',
  createdAt: 1,
  updatedAt: 1,
  confirmedAt: 1,
  ...overrides,
})

describe('Story Memory utilities', () => {
  it('orders volumes and chapters by their narrative order', () => {
    const result = orderedChapters(
      novel([
        { id: 'volume-2', title: 'Volume 2', order: 1, chapters: [chapter('chapter-3', 0)] },
        {
          id: 'volume-1',
          title: 'Volume 1',
          order: 0,
          chapters: [chapter('chapter-2', 1), chapter('chapter-1', 0)],
        },
      ]),
    )

    expect(result.map((item) => item.chapter.id)).toEqual(['chapter-1', 'chapter-2', 'chapter-3'])
  })

  it('creates stable fingerprints and detects changed or missing source prose', () => {
    const entry = memory('memory-1', 'chapter-1', storyMemoryFingerprint('Original prose'))

    expect(storyMemoryFingerprint('Original prose')).toBe(storyMemoryFingerprint('Original prose'))
    expect(storyMemoryFingerprint('Original prose')).not.toBe(
      storyMemoryFingerprint('Revised prose'),
    )
    expect(isStoryMemoryStale(entry, 'Original prose')).toBe(false)
    expect(isStoryMemoryStale(entry, 'Revised prose')).toBe(true)
    expect(isStoryMemoryStale(entry, undefined)).toBe(true)
  })

  it('selects fresh confirmed memories, prioritizes relevant entities, and limits fallback', () => {
    const chapters = [chapter('chapter-1', 0), chapter('chapter-2', 1), chapter('chapter-3', 2)]
    const sourceTexts = new Map([
      ['chapter-1', 'One'],
      ['chapter-2', 'Two'],
      ['chapter-3', 'Three'],
    ])
    const store: StoryMemoryStore = {
      version: 1,
      entries: [
        memory('relevant-past', 'chapter-1', storyMemoryFingerprint('One'), {
          entityRefIds: ['character/ari.md'],
        }),
        memory('relevant-current', 'chapter-3', storyMemoryFingerprint('Three'), {
          entityRefIds: ['character/ari.md'],
        }),
        memory('fallback-1', 'chapter-1', storyMemoryFingerprint('One')),
        memory('fallback-2', 'chapter-2', storyMemoryFingerprint('Two')),
        memory('fallback-3', 'chapter-3', storyMemoryFingerprint('Three')),
        memory('fallback-4', 'chapter-3', storyMemoryFingerprint('Three')),
        memory('stale', 'chapter-2', storyMemoryFingerprint('Old version')),
        memory('suggested', 'chapter-3', storyMemoryFingerprint('Three'), { status: 'suggested' }),
      ],
    }

    const result = selectStoryMemories({
      store,
      novel: novel([{ id: 'volume-1', title: 'Volume 1', order: 0, chapters }]),
      activeChapterId: 'chapter-3',
      sourceTexts,
      signalText: 'Ari enters the observatory.',
      settingDocs: [{ id: 'character/ari.md', title: 'Ari', category: 'character', updatedAt: 1 }],
    })

    expect(result.map((entry) => entry.id)).toEqual([
      'relevant-current',
      'relevant-past',
      'fallback-3',
      'fallback-4',
      'fallback-2',
    ])
  })

  it('parses fenced AI JSON and keeps only valid linked metadata', () => {
    const result = parseStoryMemoryCandidates(
      '```json\n{"memories":[{"kind":"character-state","statement":"  Ari keeps the key.  ","entityRefIds":["character/ari.md","character/missing.md"],"evidence":"Ari keeps the key.","timelineEventId":"event-1","storyDateLabel":"Night 1","confidence":2}]}\n```',
      'Ari keeps the key. She leaves the archive.',
      new Set(['character/ari.md']),
      new Set(['event-1']),
    )

    expect(result).toEqual([
      {
        kind: 'character-state',
        statement: 'Ari keeps the key.',
        entityRefIds: ['character/ari.md'],
        evidence: 'Ari keeps the key.',
        timelineEventId: 'event-1',
        storyDateLabel: 'Night 1',
        confidence: 1,
      },
    ])
  })

  it('rejects unverifiable candidates and invalid response shapes', () => {
    const source = 'Ari keeps the key.'
    const invalidCandidates = JSON.stringify({
      memories: [
        { kind: 'unknown', statement: 'Invalid kind', evidence: source },
        { kind: 'knowledge', statement: 'Unsupported evidence', evidence: 'Not in this chapter.' },
        { kind: 'object', statement: '', evidence: source },
      ],
    })

    expect(parseStoryMemoryCandidates(invalidCandidates, source, new Set(), new Set())).toEqual([])
    expect(() => parseStoryMemoryCandidates('{"items":[]}', source, new Set(), new Set())).toThrow(
      'The AI did not return a memories array.',
    )
    expect(() => parseStoryMemoryCandidates('not JSON', source, new Set(), new Set())).toThrow()
  })

  it('filters and orders memories for management without treating unavailable sources as fresh', () => {
    const fresh = memory('fresh', 'chapter-1', storyMemoryFingerprint('One'), {
      statement: 'Ari keeps the key.',
      entityRefIds: ['character/ari.md'],
      updatedAt: 10,
      source: {
        ...memory('source', 'chapter-1', storyMemoryFingerprint('One')).source,
        chapterOrder: 0,
      },
    })
    const stale = memory('stale', 'chapter-2', storyMemoryFingerprint('Old chapter'), {
      statement: 'The archive burns.',
      status: 'suggested',
      updatedAt: 30,
      source: {
        ...memory('source', 'chapter-2', storyMemoryFingerprint('Old chapter')).source,
        chapterOrder: 1,
      },
    })
    const rejected = memory('rejected', 'chapter-3', storyMemoryFingerprint('Three'), {
      statement: 'Bea leaves the city.',
      status: 'rejected',
      updatedAt: 20,
      source: {
        ...memory('source', 'chapter-3', storyMemoryFingerprint('Three')).source,
        chapterOrder: 2,
      },
    })
    const input = {
      entries: [rejected, stale, fresh],
      settingDocs: [
        { id: 'character/ari.md', title: 'Ari', category: 'character' as const, updatedAt: 1 },
      ],
      sourceTexts: new Map([
        ['chapter-1', 'One'],
        ['chapter-2', 'New chapter'],
      ]),
    }

    expect(browseStoryMemories({ ...input, query: 'ari' }).map((entry) => entry.id)).toEqual([
      'fresh',
    ])
    expect(
      browseStoryMemories({ ...input, staleness: 'stale', sort: 'updated' }).map(
        (entry) => entry.id,
      ),
    ).toEqual(['stale'])
    expect(
      browseStoryMemories({ ...input, status: 'all', sort: 'status' }).map((entry) => entry.id),
    ).toEqual(['fresh', 'stale', 'rejected'])
    expect(browseStoryMemories({ ...input, staleness: 'fresh' }).map((entry) => entry.id)).toEqual([
      'fresh',
    ])
  })

  it('protects stale or incomplete memories during batch confirmation', () => {
    const fresh = memory('fresh', 'chapter-1', storyMemoryFingerprint('One'), {
      status: 'suggested',
    })
    const stale = memory('stale', 'chapter-2', storyMemoryFingerprint('Old'), {
      status: 'suggested',
    })
    const blank = memory('blank', 'chapter-1', storyMemoryFingerprint('One'), {
      statement: ' ',
      status: 'suggested',
    })
    const result = applyStoryMemoryBatchStatus(
      { version: 1, entries: [fresh, stale, blank] },
      new Set(['fresh', 'stale', 'blank']),
      'confirmed',
      new Map([
        ['chapter-1', 'One'],
        ['chapter-2', 'New'],
      ]),
      100,
    )

    expect(result.changed).toBe(1)
    expect(result.skipped).toBe(2)
    expect(result.store.entries.map((entry) => entry.status)).toEqual([
      'confirmed',
      'suggested',
      'suggested',
    ])
    expect(result.store.entries[0].confirmedAt).toBe(100)
    expect(result.store.entries[1].updatedAt).toBe(stale.updatedAt)

    const rejected = applyStoryMemoryBatchStatus(
      result.store,
      new Set(['fresh', 'stale', 'blank']),
      'rejected',
      new Map(),
      200,
    )
    expect(rejected.changed).toBe(3)
    expect(rejected.store.entries.every((entry) => entry.status === 'rejected')).toBe(true)

    const restored = applyStoryMemoryBatchStatus(
      rejected.store,
      new Set(['fresh', 'stale', 'blank']),
      'suggested',
      new Map(),
      300,
    )
    expect(restored.changed).toBe(3)
    expect(restored.store.entries.every((entry) => entry.status === 'suggested')).toBe(true)
  })

  it('suggests conservative duplicate groups without including rejected entries', () => {
    const first = memory('first', 'chapter-1', storyMemoryFingerprint('One'), {
      statement: 'Ari keeps the brass key.',
      updatedAt: 10,
    })
    const second = memory('second', 'chapter-1', storyMemoryFingerprint('One'), {
      statement: 'Ari keeps the brass key!',
      updatedAt: 20,
    })
    const rejected = memory('rejected-duplicate', 'chapter-1', storyMemoryFingerprint('One'), {
      statement: 'Ari keeps the brass key.',
      status: 'rejected',
      updatedAt: 30,
    })
    const evidenceMatch = memory('evidence-match', 'chapter-1', storyMemoryFingerprint('One'), {
      statement: 'The key remains with Ari.',
      source: {
        ...first.source,
        evidence: first.source.evidence,
      },
      updatedAt: 40,
    })

    const groups = findStoryMemoryDuplicateGroups([first, second, rejected, evidenceMatch])

    expect(groups).toHaveLength(1)
    expect(groups[0].reason).toBe('same-statement')
    expect(groups[0].entries.map((entry) => entry.id)).toEqual([
      'first',
      'second',
      'evidence-match',
    ])
    expect(groups[0].entries.some((entry) => entry.id === 'rejected-duplicate')).toBe(false)
  })
})
