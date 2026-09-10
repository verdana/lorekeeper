import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  ensureWorldSkeleton,
  initPaths,
  setCurrentWorldId,
  storyMemoryBackupsDir,
  storyMemoryFile,
} from '../../src/server/paths'
import {
  listStoryMemoryBackups,
  mergeStoryMemory,
  readStoryMemory,
  restoreStoryMemoryBackup,
  writeStoryMemory,
} from '../../src/server/store'
import type { StoryMemoryEntry, StoryMemoryStore } from '../../src/shared/types'

let dataRoot = ''

const entry = (): StoryMemoryEntry => ({
  id: 'memory-1',
  kind: 'character-state',
  statement: 'Ari carries the brass key.',
  entityRefIds: ['character/ari.md'],
  source: {
    chapterId: 'chapter-1',
    chapterFile: 'chapter-1.md',
    chapterTitle: 'Chapter 1',
    volumeId: 'volume-1',
    volumeOrder: 0,
    chapterOrder: 0,
    fingerprint: 'fnv1a-12345678',
    evidence: 'Ari put the brass key into her coat pocket.',
  },
  timelineEventId: null,
  storyDateLabel: '',
  confidence: 0.8,
  status: 'confirmed',
  origin: 'author',
  createdAt: 1,
  updatedAt: 1,
  confirmedAt: 1,
})

const store = (): StoryMemoryStore => ({ version: 1, entries: [entry()] })

beforeAll(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'lorekeeper-story-memory-'))
  process.env.ORBIT_DATA_DIR = dataRoot
  initPaths()
  ensureWorldSkeleton('test-world')
  setCurrentWorldId('test-world')
})

beforeEach(() => {
  const file = storyMemoryFile()
  if (existsSync(file)) unlinkSync(file)
  const backups = storyMemoryBackupsDir()
  if (existsSync(backups)) rmSync(backups, { recursive: true, force: true })
})

afterAll(() => {
  setCurrentWorldId(null)
  delete process.env.ORBIT_DATA_DIR
  rmSync(dataRoot, { recursive: true, force: true })
})

describe('Story Memory store', () => {
  it('returns an empty store when no file exists', () => {
    expect(readStoryMemory()).toEqual({ version: 1, entries: [] })
  })

  it('persists and validates a complete memory store', () => {
    writeStoryMemory(store())

    expect(readStoryMemory()).toEqual(store())
  })

  it('rejects malformed renderer payloads before creating a file', () => {
    const invalid: StoryMemoryStore = {
      version: 1,
      entries: [{ ...entry(), confidence: 1.1 }],
    }

    expect(() => writeStoryMemory(invalid)).toThrow('Invalid Story Memory confidence.')
    expect(existsSync(storyMemoryFile())).toBe(false)
  })

  // Character Chat and the Writers' Room promote a conclusion to canon with an
  // empty source (origin "author"), which is what the UI labels an author note.
  // Validation used to require a chapter id for every entry, so "Save this
  // conclusion to Story Memory" failed 100% of the time.
  describe('author notes without chapter provenance', () => {
    const authorNote = (): StoryMemoryEntry => ({
      ...entry(),
      id: 'memory-author-note',
      statement: 'Valeria is lying about the ledger.',
      entityRefIds: [],
      source: {
        chapterId: '',
        chapterFile: '',
        chapterTitle: '',
        volumeId: '',
        volumeOrder: -1,
        chapterOrder: -1,
        fingerprint: '',
        evidence: '',
      },
      confidence: null,
      status: 'confirmed',
      origin: 'author',
    })

    it('accepts and preserves an author note', () => {
      const withNote: StoryMemoryStore = { version: 1, entries: [authorNote()] }
      writeStoryMemory(withNote)

      expect(readStoryMemory()).toEqual(withNote)
    })

    it('accepts an author note alongside chapter-derived memories', () => {
      const mixed: StoryMemoryStore = { version: 1, entries: [authorNote(), entry()] }
      writeStoryMemory(mixed)

      expect(readStoryMemory().entries.map((item) => item.id)).toEqual([
        'memory-author-note',
        'memory-1',
      ])
    })

    it('normalises a half-filled source instead of trusting it', () => {
      const half = {
        ...authorNote(),
        source: { ...authorNote().source, chapterTitle: 'Chapter 9', volumeOrder: 3 },
      }
      writeStoryMemory({ version: 1, entries: [half] })

      expect(readStoryMemory().entries[0]?.source).toEqual({
        chapterId: '',
        chapterFile: '',
        chapterTitle: '',
        volumeId: '',
        volumeOrder: -1,
        chapterOrder: -1,
        fingerprint: '',
        evidence: '',
      })
    })

    it('still requires a chapter source for AI-extracted memories', () => {
      const aiEntry: StoryMemoryEntry = { ...authorNote(), id: 'memory-ai', origin: 'ai' }

      expect(() => writeStoryMemory({ version: 1, entries: [aiEntry] })).toThrow(
        'Invalid Story Memory source chapter id.',
      )
      expect(existsSync(storyMemoryFile())).toBe(false)
    })

    it('imports an author note through the merge path', () => {
      expect(mergeStoryMemory({ version: 1, entries: [authorNote()] })).toEqual({
        added: 1,
        skipped: 0,
      })
      expect(readStoryMemory().entries[0]?.source.chapterId).toBe('')
    })
  })

  it('preserves malformed local data instead of overwriting it', () => {
    const corrupt = '{"version":1,"entries":['
    writeFileSync(storyMemoryFile(), corrupt)

    expect(() => readStoryMemory()).toThrow('Unable to read Story Memory without risking overwrite')
    expect(() => writeStoryMemory(store())).toThrow(
      'Unable to read Story Memory without risking overwrite',
    )
    expect(readFileSync(storyMemoryFile(), 'utf-8')).toBe(corrupt)
  })

  it('merges valid imports without replacing existing or duplicate entries', () => {
    writeStoryMemory(store())
    const second = { ...entry(), id: 'memory-2', statement: 'Bea has the silver key.' }
    const imported = {
      version: 1 as const,
      entries: [entry(), second, second],
    }

    expect(mergeStoryMemory(imported)).toEqual({ added: 1, skipped: 2 })
    expect(readStoryMemory().entries.map((item) => item.id)).toEqual(['memory-1', 'memory-2'])
  })

  it('rejects invalid imports without changing existing data', () => {
    writeStoryMemory(store())
    const invalid = { version: 1, entries: [{ ...entry(), confidence: 2 }] } as StoryMemoryStore

    expect(() => mergeStoryMemory(invalid)).toThrow('Invalid Story Memory confidence.')
    expect(readStoryMemory()).toEqual(store())
  })

  it('keeps the previous valid store as a restorable backup', () => {
    const first = store()
    const second = {
      version: 1 as const,
      entries: [...first.entries, { ...entry(), id: 'memory-2' }],
    }
    writeStoryMemory(first)
    writeStoryMemory(second)

    const [backup] = listStoryMemoryBackups()
    expect(backup).toMatchObject({ entryCount: 1 })

    restoreStoryMemoryBackup(backup.id)

    expect(readStoryMemory()).toEqual(first)
    expect(listStoryMemoryBackups()).toHaveLength(2)
  })

  it('preserves a corrupt current file before recovery', () => {
    const first = store()
    const second = {
      version: 1 as const,
      entries: [...first.entries, { ...entry(), id: 'memory-2' }],
    }
    writeStoryMemory(first)
    writeStoryMemory(second)
    const [backup] = listStoryMemoryBackups()
    writeFileSync(storyMemoryFile(), '{"version":1,"entries":[')

    restoreStoryMemoryBackup(backup.id)

    expect(readStoryMemory()).toEqual(first)
    expect(readdirSync(storyMemoryBackupsDir()).some((file) => file.startsWith('corrupt-'))).toBe(
      true,
    )
  })

  it('keeps only the ten most recent valid backups', () => {
    for (let index = 0; index <= 10; index++) {
      writeStoryMemory({
        version: 1,
        entries: [{ ...entry(), id: `memory-${index}` }],
      })
    }

    expect(listStoryMemoryBackups()).toHaveLength(10)
    expect(readStoryMemory().entries[0]?.id).toBe('memory-10')
  })
})
