import { describe, expect, it } from 'vitest'
import { createGlobalSearchResults, searchGlobalResults } from '../../src/shared/globalSearch'
import type { NovelMeta } from '../../src/shared/types'

const novel: NovelMeta = {
  title: 'The Brass Key',
  author: '',
  synopsis: '',
  tags: [],
  volumes: [
    {
      id: 'volume-1',
      title: 'Book One',
      order: 0,
      chapters: [
        {
          id: 'chapter-1',
          volumeId: 'volume-1',
          title: 'The Locked Door',
          order: 0,
          file: 'chapter-1.md',
          wordCount: 0,
          status: 'draft',
          updatedAt: 1,
        },
      ],
    },
  ],
}

const records = createGlobalSearchResults({
  novel,
  settings: [{ id: 'character/ari.md', title: 'Ari Vale', category: '11-character', updatedAt: 1 }],
  timeline: [
    {
      id: 'event-1',
      title: 'The Brass Key Is Found',
      dateLabel: 'Year 1240',
      dateOrder: 1,
      description: 'Ari discovers the key beneath the hearth.',
      docRefs: [],
    },
  ],
  discussions: [
    {
      id: 'discussion-1',
      topic: 'What opens the locked door?',
      personaIds: [],
      rounds: 0,
      messages: [],
      conclusion: 'The brass key should open it.',
      createdAt: 1,
    },
  ],
  snapshots: [
    {
      id: 'snapshot-1',
      sourcePath: 'chapters/chapter-1.md',
      label: 'The Locked Door',
      kind: 'chapter',
      ts: 1,
      size: 1,
    },
  ],
})

describe('global search', () => {
  it('creates records for every supported project item type', () => {
    expect(records.map((record) => record.kind)).toEqual([
      'chapter',
      'setting',
      'timeline',
      'discussion',
      'snapshot',
    ])
  })

  it('matches query tokens against local metadata', () => {
    expect(searchGlobalResults(records, 'brass key').map((record) => record.kind)).toEqual([
      'timeline',
    ])
  })

  it('ranks an exact title match ahead of a secondary metadata match', () => {
    const result = searchGlobalResults(records, 'the locked door')

    expect(result.slice(0, 2).map((record) => record.kind)).toEqual(['chapter', 'snapshot'])
  })

  it('returns no records until the writer starts a search', () => {
    expect(searchGlobalResults(records, '')).toEqual([])
  })
})
