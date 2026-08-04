import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  initPaths,
  ensureWorldSkeleton,
  setCurrentWorldId,
  currentWorldDir,
  novelFile,
} from '../../src/server/paths'
import {
  commitBatchChapter,
  forceSnapshot,
  getNovelMeta,
  listSnapshots,
  readChapter,
  readSnapshot,
  removeBatchChapter,
  saveNovelMeta,
  writeChapter,
} from '../../src/server/store'
import { DEFAULT_NOVEL_META } from '../../src/server/defaults'
import type { NovelMeta, Volume } from '../../src/shared/types'

let dataRoot = ''
const worldId = 'w_batch'

const volume = (chapters: Volume['chapters']): Volume => ({
  id: 'v1',
  title: 'Volume 1',
  order: 0,
  chapters,
})

const meta = (): NovelMeta => ({
  ...DEFAULT_NOVEL_META,
  title: 'Batch Test',
  volumes: [
    volume([
      {
        id: 'c1',
        volumeId: 'v1',
        title: 'Chapter 1',
        order: 0,
        file: 'v1_a.md',
        wordCount: 12,
        status: 'draft',
        updatedAt: 100,
      },
      {
        id: 'c2',
        volumeId: 'v1',
        title: 'Chapter 2',
        order: 1,
        file: 'v1_b.md',
        wordCount: 34,
        status: 'draft',
        updatedAt: 200,
      },
    ]),
  ],
})

beforeAll(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'lorekeeper-batch-'))
  process.env.ORBIT_DATA_DIR = dataRoot
  initPaths()
  ensureWorldSkeleton(worldId)
  setCurrentWorldId(worldId)
})

afterAll(() => {
  vi.useRealTimers()
  rmSync(dataRoot, { recursive: true, force: true })
})

beforeEach(() => {
  vi.useRealTimers()
  // Fresh world state per test.
  saveNovelMeta(meta())
  writeChapter('v1_a.md', '# Chapter 1\n\nold body a')
  writeChapter('v1_b.md', '# Chapter 2\n\nold body b')
})

describe('forceSnapshot', () => {
  it('snapshots novel.json and returns a readable snapshot entry', () => {
    const entry = forceSnapshot('novel.json')
    expect(entry.sourcePath).toBe('novel.json')
    expect(entry.kind).toBe('novel')
    expect(readSnapshot(entry.id)).toContain('Batch Test')
  })

  it('snapshots a chapter body', () => {
    const entry = forceSnapshot('chapters/v1_a.md')
    expect(entry.kind).toBe('chapter')
    expect(readSnapshot(entry.id)).toContain('old body a')
  })

  it('rejects unsupported or escaping paths', () => {
    expect(() => forceSnapshot('settings/01.md')).toThrow()
    expect(() => forceSnapshot('novel.json/../novel.json')).toThrow()
    expect(() => forceSnapshot('chapters/..%2Fnovel.json')).toThrow()
    expect(() => forceSnapshot('chapters/x')).toThrow()
  })

  it('throws when the source file is missing', () => {
    expect(() => forceSnapshot('chapters/ghost.md')).toThrow(/missing/)
  })

  it('bypasses the 3-minute throttle (no dedup between two calls)', () => {
    const a = forceSnapshot('novel.json')
    const b = forceSnapshot('novel.json')
    expect(a.id).not.toBe(b.id)
    expect(
      listSnapshots().filter((s) => s.sourcePath === 'novel.json').length,
    ).toBeGreaterThanOrEqual(2)
  })

  it('still enforces the rolling retention cap (keeps only the newest 15)', () => {
    for (let i = 0; i < 20; i++) forceSnapshot('chapters/v1_a.md')
    const snaps = listSnapshots().filter((s) => s.sourcePath === 'chapters/v1_a.md')
    expect(snaps.length).toBe(15)
    // The newest snapshot is retained.
    expect(snaps[0].ts).toBeGreaterThan(snaps[snaps.length - 1].ts)
  })
})

describe('commitBatchChapter', () => {
  it('applies body + minimal patch and returns the next meta', () => {
    const next = commitBatchChapter({
      worldId,
      chapterId: 'c1',
      file: 'v1_a.md',
      content: '# Chapter 1\n\nbrand new body',
      patch: { wordCount: 15, updatedAt: 999, status: 'draft' },
    })
    expect(readChapter('v1_a.md')).toBe('# Chapter 1\n\nbrand new body')
    const c1 = next.volumes[0].chapters.find((c) => c.id === 'c1')!
    expect(c1.wordCount).toBe(15)
    expect(c1.updatedAt).toBe(999)
    expect(c1.status).toBe('draft')
    // Untouched chapter and volume stay intact.
    const c2 = next.volumes[0].chapters.find((c) => c.id === 'c2')!
    expect(c2.wordCount).toBe(34)
    expect(c2.title).toBe('Chapter 2')
    expect(next.title).toBe('Batch Test')
  })

  it('rejects a world mismatch', () => {
    expect(() =>
      commitBatchChapter({
        worldId: 'w_other',
        chapterId: 'c1',
        file: 'v1_a.md',
        content: 'x',
        patch: { wordCount: 1, updatedAt: 1, status: 'draft' },
      }),
    ).toThrow(/world mismatch/)
  })

  it('rejects unknown chapters and file mismatches', () => {
    expect(() =>
      commitBatchChapter({
        worldId,
        chapterId: 'nope',
        file: 'v1_a.md',
        content: 'x',
        patch: { wordCount: 1, updatedAt: 1, status: 'draft' },
      }),
    ).toThrow(/not found/)
    expect(() =>
      commitBatchChapter({
        worldId,
        chapterId: 'c1',
        file: 'v1_b.md',
        content: 'x',
        patch: { wordCount: 1, updatedAt: 1, status: 'draft' },
      }),
    ).toThrow(/mismatch/)
  })

  it('rolls the body back when the novel.json write fails', () => {
    // Replace novel.json with a directory so atomicWrite's rename fails.
    const nf = novelFile()
    rmSync(nf)
    mkdirSync(nf)
    expect(() =>
      commitBatchChapter({
        worldId,
        chapterId: 'c1',
        file: 'v1_a.md',
        content: '# Chapter 1\n\nshould not survive',
        patch: { wordCount: 50, updatedAt: 500, status: 'draft' },
      }),
    ).toThrow()
    // Body rolled back to the previous content.
    expect(readChapter('v1_a.md')).toBe('# Chapter 1\n\nold body a')
    // Cleanup for later tests.
    rmSync(nf, { recursive: true, force: true })
    saveNovelMeta(meta())
  })

  it('deletes the new file on rollback when no previous body existed', () => {
    // Chapter with no body file yet (pre-created metadata only).
    const withEmpty = {
      ...meta(),
      volumes: [
        volume([
          ...meta().volumes[0].chapters,
          {
            id: 'c3',
            volumeId: 'v1',
            title: 'Chapter 3',
            order: 2,
            file: 'v1_c.md',
            wordCount: 0,
            status: 'draft',
            updatedAt: 1,
          },
        ]),
      ],
    }
    saveNovelMeta(withEmpty)
    const nf = novelFile()
    rmSync(nf)
    mkdirSync(nf)
    expect(() =>
      commitBatchChapter({
        worldId,
        chapterId: 'c3',
        file: 'v1_c.md',
        content: '# Chapter 3\n\ntext',
        patch: { wordCount: 5, updatedAt: 1, status: 'draft' },
      }),
    ).toThrow()
    expect(existsSync(join(currentWorldDir(), 'chapters', 'v1_c.md'))).toBe(false)
    rmSync(nf, { recursive: true, force: true })
    saveNovelMeta(withEmpty)
  })
})

describe('removeBatchChapter', () => {
  it('rejects world mismatches and unknown chapters', () => {
    expect(() => removeBatchChapter('w_other', 'c1')).toThrow(/world mismatch/)
    expect(() => removeBatchChapter(worldId, 'nope')).toThrow(/not found/)
  })

  it('rejects non-empty chapters', () => {
    expect(() => removeBatchChapter(worldId, 'c1')).toThrow(/empty/)
  })

  it('removes a pre-created empty chapter and its body file', () => {
    const withEmpty = {
      ...meta(),
      volumes: [
        volume([
          ...meta().volumes[0].chapters,
          {
            id: 'c3',
            volumeId: 'v1',
            title: 'Chapter 3',
            order: 2,
            file: 'v1_c.md',
            wordCount: 0,
            status: 'draft',
            updatedAt: 1,
          },
        ]),
      ],
    }
    saveNovelMeta(withEmpty)
    writeChapter('v1_c.md', '') // empty body
    const next = removeBatchChapter(worldId, 'c3')
    expect(next.volumes[0].chapters.map((c) => c.id)).toEqual(['c1', 'c2'])
    expect(getNovelMeta().volumes[0].chapters.map((c) => c.id)).toEqual(['c1', 'c2'])
    expect(existsSync(join(currentWorldDir(), 'chapters', 'v1_c.md'))).toBe(false)
  })

  it('refuses to delete a chapter whose body file is non-empty even with wordCount 0', () => {
    const withEmpty = {
      ...meta(),
      volumes: [
        volume([
          ...meta().volumes[0].chapters,
          {
            id: 'c3',
            volumeId: 'v1',
            title: 'Chapter 3',
            order: 2,
            file: 'v1_c.md',
            wordCount: 0,
            status: 'draft',
            updatedAt: 1,
          },
        ]),
      ],
    }
    saveNovelMeta(withEmpty)
    writeChapter('v1_c.md', '# Chapter 3\n\nsome prose')
    expect(() => removeBatchChapter(worldId, 'c3')).toThrow(/not empty/)
  })
})
