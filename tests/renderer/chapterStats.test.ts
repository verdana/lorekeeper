import { describe, expect, it } from 'vitest'
import { withChapterStats, wordCount } from '../../src/renderer/src/lib'
import type { NovelMeta } from '../../src/shared/types'

const meta = (): NovelMeta => ({
  title: 'Untitled Manuscript',
  author: '',
  synopsis: '',
  tags: [],
  volumes: [
    {
      id: 'v1',
      title: 'Volume 1',
      order: 0,
      chapters: [
        {
          id: 'c1',
          volumeId: 'v1',
          title: 'Chapter 1',
          order: 0,
          file: 'v1_c1.md',
          wordCount: 10,
          status: 'draft',
          updatedAt: 1,
        },
        {
          id: 'c2',
          volumeId: 'v1',
          title: 'Chapter 2',
          order: 1,
          file: 'v1_c2.md',
          wordCount: 20,
          status: 'done',
          updatedAt: 2,
        },
      ],
    },
  ],
})

/**
 * A chapter save updates one chapter's stats in the structure read from disk for
 * that save. It must never re-add a chapter the author deleted elsewhere, which
 * is what writing a cached structure back did.
 */
describe('withChapterStats', () => {
  it('refreshes the saved chapter and leaves the rest untouched', () => {
    const updated = withChapterStats(meta(), 'c1', 'hello world')

    expect(updated.volumes[0].chapters[0].wordCount).toBe(wordCount('hello world'))
    expect(updated.volumes[0].chapters[0].updatedAt).toBeGreaterThan(1)
    // The other chapter keeps its stats, status, and timestamp.
    expect(updated.volumes[0].chapters[1]).toEqual(meta().volumes[0].chapters[1])
    // Top-level metadata and volume fields are preserved.
    expect(updated.title).toBe('Untitled Manuscript')
    expect(updated.volumes[0].title).toBe('Volume 1')
  })

  it('does not re-add a chapter that is no longer in the structure', () => {
    const current = meta()
    current.volumes[0].chapters = current.volumes[0].chapters.filter((c) => c.id !== 'c2')

    const updated = withChapterStats(current, 'c2', 'text for a deleted chapter')

    expect(updated.volumes[0].chapters.map((c) => c.id)).toEqual(['c1'])
  })

  it('does not mutate its input', () => {
    const current = meta()
    withChapterStats(current, 'c1', 'hello world')
    expect(current.volumes[0].chapters[0].wordCount).toBe(10)
  })

  it('is a no-op for an empty structure', () => {
    const empty: NovelMeta = { ...meta(), volumes: [] }
    expect(withChapterStats(empty, 'c1', 'text')).toEqual(empty)
  })

  it('counts CJK characters and latin words the same way the editor does', () => {
    const updated = withChapterStats(meta(), 'c1', '马停在山道边。 hello world')
    expect(updated.volumes[0].chapters[0].wordCount).toBe(wordCount('马停在山道边。 hello world'))
  })
})
