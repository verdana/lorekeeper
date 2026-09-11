/**
 * @vitest-environment jsdom
 *
 * Render tests for the Outline view and the Continuity workspace.
 *
 * These two are the largest views left, and both are edited in place — a volume
 * status, a chapter's beats, a confirmed story fact. A split of either fails
 * silently, so the behaviours a writer depends on are pinned first: the outline
 * shows its structure and cycles a volume's status through the store, and
 * Continuity shows the derived state and the author-confirmed facts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { storyMemoryFingerprint } from '../../src/shared/storyMemory'
import type {
  AppConfig,
  ChapterSummary,
  NovelMeta,
  OutlineStore,
  StoryMemoryStore,
  StoryState,
} from '../../src/shared/types'

const api = vi.hoisted(() => ({
  readOutlineStore: vi.fn(),
  writeOutlineStore: vi.fn(),
  readOutline: vi.fn(),
  readStoryMemory: vi.fn(),
  writeStoryMemory: vi.fn(),
  mergeStoryMemory: vi.fn(),
  listStoryMemoryBackups: vi.fn(),
  restoreStoryMemoryBackup: vi.fn(),
  listTimelineEvents: vi.fn(),
  saveTimelineEvents: vi.fn(),
  listChapterSummaries: vi.fn(),
  readStoryState: vi.fn(),
  writeStoryState: vi.fn(),
  writeChapterSummary: vi.fn(),
  deleteChapterSummary: vi.fn(),
  readChapter: vi.fn(),
  getNovelMeta: vi.fn(),
  listSettings: vi.fn(),
}))

vi.mock('../../src/renderer/src/api', () => ({ installApi: () => {} }))

const config: AppConfig = {
  ai: { providers: [], activeProviderId: null },
  personas: [],
  consistency: { providerId: null, systemPrompt: '', userTemplate: '{{material}}' },
  writing: {
    providerId: null,
    outlineSystemPrompt: '',
    rewriteSystemPrompt: '',
    temperature: 0.8,
    topP: 0.9,
  },
}

const novel: NovelMeta = {
  title: 'T',
  author: '',
  synopsis: '',
  tags: [],
  volumes: [
    {
      id: 'v1',
      title: 'Volume One',
      order: 0,
      chapters: [
        {
          id: 'c1',
          volumeId: 'v1',
          title: 'Chapter 1: Ash',
          order: 0,
          file: 'c1.md',
          wordCount: 0,
          status: 'draft',
          updatedAt: 1,
        },
      ],
    },
  ],
}

const outline = (status: OutlineStore['volumes'][number]['status']): OutlineStore => ({
  version: 1,
  updatedAt: 1,
  overview: 'The book in one paragraph.',
  notes: '',
  volumes: [
    {
      id: 'v1',
      title: 'Volume One',
      summary: 'The debt comes due.',
      config: '',
      status,
      chapters: [
        {
          id: 'c1',
          title: 'Chapter 1: Ash',
          status: 'planned',
          beats: [{ title: 'Arrival', summary: 'She arrives in the city.' }],
        },
      ],
    },
  ],
})

const CHAPTER_TEXT = '# Chapter 1: Ash\n\nThe rain fell for a week.'

const storyMemory = (status: StoryMemoryStore['entries'][number]['status']): StoryMemoryStore => ({
  version: 1,
  entries: [
    {
      id: 'e1',
      kind: 'character-state',
      statement: 'Ilyra has sold every memory of her own past.',
      entityRefIds: [],
      source: {
        chapterId: 'c1',
        chapterFile: 'c1.md',
        chapterTitle: 'Chapter 1: Ash',
        volumeId: 'v1',
        volumeOrder: 0,
        chapterOrder: 0,
        // Matches the chapter body the test serves, so the fact is not stale.
        fingerprint: storyMemoryFingerprint(CHAPTER_TEXT),
        evidence: 'She counted the coins.',
      },
      timelineEventId: null,
      storyDateLabel: '',
      confidence: 0.9,
      status,
      origin: 'ai',
      createdAt: 1,
      updatedAt: 1,
      confirmedAt: status === 'confirmed' ? 2 : null,
    },
  ],
})

const summary: ChapterSummary = {
  chapterId: 'c1',
  chapterTitle: 'Chapter 1: Ash',
  sourceFingerprint: 'fp',
  generatedAt: 1,
  summary: 'She learns the ledger is real.',
  endState: 'Night, the archive, alone.',
  stateChanges: [],
  plantedThreads: ['the missing page'],
  resolvedThreads: [],
}

const storyState: StoryState = {
  version: 1,
  upToChapterId: 'c1',
  updatedAt: 1,
  characters: [
    {
      name: 'Ilyra',
      location: 'The archive',
      condition: '',
      possessions: '',
      goals: '',
      relations: '',
      knows: 'Learned the ledger is forged.',
    },
  ],
  worldState: ['The guild is split.'],
  openThreads: ['the missing page'],
  currentEndState: 'Night, the archive, alone.',
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(globalThis as unknown as { window: Window }).window.api = api as never
  api.readOutlineStore.mockResolvedValue(outline('planning'))
  api.writeOutlineStore.mockImplementation(async (next: OutlineStore) => {
    api.readOutlineStore.mockResolvedValue(next)
    return novel
  })
  api.getNovelMeta.mockResolvedValue(novel)
  api.listSettings.mockResolvedValue([])
  api.readStoryMemory.mockResolvedValue(storyMemory('suggested'))
  api.writeStoryMemory.mockResolvedValue(undefined)
  api.listStoryMemoryBackups.mockResolvedValue([])
  api.listTimelineEvents.mockResolvedValue([])
  api.listChapterSummaries.mockResolvedValue([summary])
  api.readStoryState.mockResolvedValue(storyState)
  api.readChapter.mockResolvedValue('# Chapter 1: Ash\n\nThe rain fell for a week.')
})

afterEach(() => {
  cleanup()
})

async function mount(view: 'Outline' | 'StoryMemory' | 'ChapterMemory'): Promise<void> {
  const { useStore } = await import('../../src/renderer/src/store')
  useStore.setState({ novel, config, settingDocs: [], currentWorldId: 'w1' } as never)
  const mod = await import(`../../src/renderer/src/views/${view}`)
  render(<mod.default />)
}

describe('the outline', () => {
  it('shows the planned structure from the store, expanding a volume', async () => {
    await mount('Outline')

    expect(await screen.findByText(/Volume One/)).toBeTruthy()
    expect(screen.getByText('The debt comes due.')).toBeTruthy()
    expect(api.readOutlineStore).toHaveBeenCalled()

    // Chapters live inside a collapsed volume; the chevron expands it.
    expect(screen.queryByText(/Chapter 1: Ash/)).toBeNull()
    fireEvent.click(screen.getByTitle('Expand'))
    expect(await screen.findByText(/Chapter 1: Ash/)).toBeTruthy()
  })

  it('persists a structure change through the outline store', async () => {
    await mount('Outline')
    await screen.findByText(/Volume One/)

    // Cycling the volume's status is an edit, and edits go through the store
    // endpoint rather than staying in local state.
    fireEvent.click(screen.getByText(/planning/i))
    await waitFor(() => expect(api.writeOutlineStore).toHaveBeenCalled())

    const [written] = api.writeOutlineStore.mock.calls.at(-1)!
    expect(written.volumes[0].status).toBe('confirmed')
    expect(written.volumes[0].chapters[0].beats[0]).toMatchObject({ title: 'Arrival' })
  })
})

describe('continuity', () => {
  it('lists the derived chapter summaries and the accumulated state', async () => {
    await mount('ChapterMemory')

    expect(await screen.findByText(/She learns the ledger is real/)).toBeTruthy()
    expect(screen.getByText(/Ilyra/)).toBeTruthy()
    expect(screen.getByText(/Learned the ledger is forged/)).toBeTruthy()
    // The hook appears in the summary and again as an unresolved thread.
    expect(screen.getAllByText(/the missing page/).length).toBeGreaterThan(1)
  })

  it('shows a suggested fact with its evidence and source chapter', async () => {
    await mount('StoryMemory')

    // The statement is an editable field, so it is queried by value.
    expect(await screen.findByDisplayValue(/sold every memory of her own past/)).toBeTruthy()
    expect(screen.getAllByText(/Chapter 1: Ash/).length).toBeGreaterThan(0)
  })

  it('confirms a suggested fact through the store endpoint', async () => {
    await mount('StoryMemory')
    await screen.findByDisplayValue(/sold every memory of her own past/)

    fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }))
    await waitFor(() => expect(api.writeStoryMemory).toHaveBeenCalled())

    const [written] = api.writeStoryMemory.mock.calls.at(-1)!
    expect(written.entries[0].status).toBe('confirmed')
  })
})
