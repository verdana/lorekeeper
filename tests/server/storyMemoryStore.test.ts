import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  ensureWorldSkeleton,
  initPaths,
  setCurrentWorldId,
  storyMemoryFile,
} from '../../src/server/paths'
import { readStoryMemory, writeStoryMemory } from '../../src/server/store'
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

  it('preserves malformed local data instead of overwriting it', () => {
    const corrupt = '{"version":1,"entries":['
    writeFileSync(storyMemoryFile(), corrupt)

    expect(() => readStoryMemory()).toThrow('Unable to read Story Memory without risking overwrite')
    expect(() => writeStoryMemory(store())).toThrow(
      'Unable to read Story Memory without risking overwrite',
    )
    expect(readFileSync(storyMemoryFile(), 'utf-8')).toBe(corrupt)
  })
})
