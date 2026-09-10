import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, basename } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  configFile,
  currentWorldDir,
  ensureWorldSkeleton,
  exemplarsFile,
  initPaths,
  novelFile,
  outlineJsonFile,
  reviewQueueFile,
  setCurrentWorldId,
  storyStateFile,
} from '../../src/server/paths'
import {
  readOutlineStore,
  saveConfig,
  saveNovelMeta,
  saveTimelineEvents,
  writeExemplars,
  writeOutlineStore,
  writeReviewQueue,
  writeStoryState,
} from '../../src/server/store'
import { DEFAULT_CONFIG } from '../../src/server/defaults'
import type { NovelMeta } from '../../src/shared/types'

let dataRoot = ''
const worldId = 'w_test'

const damaged = '{"broken":'

/** Local to the store, so the test builds the same path the store does. */
const timelineFile = (): string => join(currentWorldDir(), 'timeline.json')

const novel: NovelMeta = {
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
          wordCount: 1,
          status: 'draft',
          updatedAt: 1,
        },
      ],
    },
  ],
}

const damagedSidecar = (file: string): string => join(dirname(file), `.corrupt-${basename(file)}`)

beforeAll(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'lorekeeper-damaged-'))
  process.env.ORBIT_DATA_DIR = dataRoot
  initPaths()
  ensureWorldSkeleton(worldId)
  setCurrentWorldId(worldId)
})

afterAll(() => {
  setCurrentWorldId(null)
  delete process.env.ORBIT_DATA_DIR
  rmSync(dataRoot, { recursive: true, force: true })
})

beforeEach(() => {
  for (const file of [
    timelineFile(),
    reviewQueueFile(),
    storyStateFile(),
    exemplarsFile(),
    novelFile(),
    configFile(),
    outlineJsonFile(),
  ]) {
    rmSync(file, { force: true })
    rmSync(damagedSidecar(file), { force: true })
  }
})

/**
 * Every one of these files is read through `readJSON`, which turns an
 * unreadable file into its fallback. Persisting that fallback replaces the
 * author's data with an empty version, silently — the same failure that used to
 * empty novel.json from a damaged outline.json. Writes now refuse instead.
 */
describe('writes refuse to replace a damaged data file', () => {
  const cases: { label: string; file: () => string; write: () => void }[] = [
    { label: 'timeline.json', file: timelineFile, write: () => saveTimelineEvents([]) },
    {
      label: 'review-queue.json',
      file: reviewQueueFile,
      write: () => writeReviewQueue({ version: 1, items: [] }),
    },
    {
      label: 'story-state.json',
      file: storyStateFile,
      write: () =>
        writeStoryState({
          version: 1,
          upToChapterId: null,
          updatedAt: 0,
          currentEndState: '',
          characters: [],
          worldState: [],
          openThreads: [],
        }),
    },
    {
      label: 'exemplars.json',
      file: exemplarsFile,
      write: () => writeExemplars({ version: 1, texts: ['x'] }),
    },
    { label: 'novel.json', file: novelFile, write: () => saveNovelMeta(novel) },
    { label: 'config.json', file: configFile, write: () => saveConfig(DEFAULT_CONFIG) },
  ]

  for (const testCase of cases) {
    it(`refuses to overwrite a damaged ${testCase.label}`, () => {
      writeFileSync(testCase.file(), damaged)

      expect(testCase.write).toThrow(/is damaged/)

      // The damaged bytes stay on disk and are copied aside for recovery.
      expect(readFileSync(testCase.file(), 'utf-8')).toBe(damaged)
      expect(existsSync(damagedSidecar(testCase.file()))).toBe(true)
      expect(readFileSync(damagedSidecar(testCase.file()), 'utf-8')).toBe(damaged)
    })
  }

  it('names the sidecar copy in the error so the author can find it', () => {
    writeFileSync(timelineFile(), damaged)
    expect(() => saveTimelineEvents([])).toThrow(/\.corrupt-timeline\.json/)
  })

  it('still writes normally when the file is simply missing', () => {
    saveTimelineEvents([])
    expect(readFileSync(timelineFile(), 'utf-8')).toBe('[]')
  })

  it('still writes normally over a healthy file', () => {
    saveTimelineEvents([])
    saveTimelineEvents([])
    expect(JSON.parse(readFileSync(timelineFile(), 'utf-8'))).toEqual([])
  })
})

/**
 * outline.json is the one exception: its contents are fully reconstructed from
 * novel.json, so overwriting a damaged copy is a repair rather than a loss, and
 * blocking it would leave the app unable to save an outline at all.
 */
describe('outline.json may be repaired by a write', () => {
  it('rewrites a damaged outline.json from a rebuilt store', () => {
    writeFileSync(novelFile(), JSON.stringify(novel, null, 2))
    writeFileSync(outlineJsonFile(), damaged)

    const store = readOutlineStore()
    expect(store.volumes.map((v) => v.id)).toEqual(['v1'])
    // The read preserved the damaged bytes rather than trusting them.
    expect(existsSync(damagedSidecar(outlineJsonFile()))).toBe(true)

    const synced = writeOutlineStore(store)

    expect(synced.volumes.map((v) => v.id)).toEqual(['v1'])
    expect(JSON.parse(readFileSync(outlineJsonFile(), 'utf-8')).volumes).toHaveLength(1)
  })
})
