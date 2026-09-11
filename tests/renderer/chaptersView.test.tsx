/**
 * @vitest-environment jsdom
 *
 * Render tests for the chapter editor — the surface the whole tool exists for.
 *
 * The editor is where the only irreplaceable artefact (the prose) leaves the
 * renderer, so the write path is pinned here rather than trusted: a chapter is
 * loaded from its file, an edit marks the chapter unsaved, Save writes the text
 * to disk and refreshes the structure from disk instead of writing back its own
 * in-memory copy, and the store's reviewed state follows the same path. The
 * CodeMirror view is driven through its own API, not by faking DOM input, so an
 * editor upgrade that breaks the change listener fails here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { countWords } from '../../src/shared/text'
import type { AppConfig, Chapter, NovelMeta } from '../../src/shared/types'

const api = vi.hoisted(() => ({
  readChapter: vi.fn(),
  writeChapter: vi.fn(),
  getNovelMeta: vi.fn(),
  saveNovelMeta: vi.fn(),
  listGenerationRuns: vi.fn(),
  readGenerationRun: vi.fn(),
  saveGenerationAuthorResult: vi.fn(),
  listSettings: vi.fn(),
}))

vi.mock('../../src/renderer/src/api', () => ({ installApi: () => {}, chatStream: vi.fn() }))

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

const CHAPTER_TEXT = '# Chapter 1: Ash\n\nThe rain fell for a week.'

const chapter = (over: Partial<Chapter> & Pick<Chapter, 'id' | 'title' | 'file'>): Chapter => ({
  volumeId: 'v1',
  order: 0,
  wordCount: 0,
  status: 'draft',
  updatedAt: 1,
  ...over,
})

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
        chapter({ id: 'c1', title: 'Chapter 1: Ash', file: 'c1.md' }),
        chapter({ id: 'c2', title: 'Chapter 2: Ember', file: 'c2.md', order: 1, wordCount: 120 }),
      ],
    },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(globalThis as unknown as { window: Window }).window.api = api as never
  api.readChapter.mockResolvedValue(CHAPTER_TEXT)
  api.writeChapter.mockResolvedValue(undefined)
  api.getNovelMeta.mockResolvedValue(novel)
  api.saveNovelMeta.mockResolvedValue(undefined)
  api.listGenerationRuns.mockResolvedValue([])
  api.listSettings.mockResolvedValue([])
  localStorage.clear()
})

afterEach(() => {
  cleanup()
})

async function mount(meta: NovelMeta = novel): Promise<void> {
  const { useStore } = await import('../../src/renderer/src/store')
  useStore.setState({
    novel: meta,
    config,
    settingDocs: [],
    currentWorldId: 'w1',
    view: 'chapters',
    chapterFocusId: null,
    storyMemoryFocusChapterId: null,
  } as never)
  const mod = await import('../../src/renderer/src/views/Chapters')
  render(<mod.default />)
}

/** Append to the chapter through CodeMirror's own API, as typing would. */
async function write(insert: string): Promise<void> {
  const dom = document.querySelector('.cm-content')
  if (!dom) throw new Error('the editor did not render')
  const view = EditorView.findFromDOM(dom as HTMLElement)
  if (!view) throw new Error('the editor has no CodeMirror view attached')
  await act(async () => {
    view.dispatch({ changes: { from: view.state.doc.length, insert } })
  })
}

async function openFirstChapter(): Promise<void> {
  fireEvent.click(await screen.findByText('Chapter 1: Ash'))
  await waitFor(() => expect(api.readChapter).toHaveBeenCalledWith('c1.md'))
}

describe('the chapter editor', () => {
  it('lists the structure and opens a chapter from its file', async () => {
    await mount()

    expect(await screen.findByText('Chapter 2: Ember')).toBeTruthy()
    // Nothing is open until a chapter is chosen.
    expect(screen.getByText('No chapter open')).toBeTruthy()

    await openFirstChapter()

    expect(await screen.findByText(`This chapter ${countWords(CHAPTER_TEXT)} words`)).toBeTruthy()
    // The tree's own count for the untouched chapter is the persisted one.
    expect(screen.getByText('0.1k')).toBeTruthy()
  })

  it('writes the edited text to disk and refreshes the structure from disk', async () => {
    await mount()
    await openFirstChapter()
    await screen.findByText(`This chapter ${countWords(CHAPTER_TEXT)} words`)

    const edited = CHAPTER_TEXT + ' Then the ledger arrived.'
    await write(' Then the ledger arrived.')
    expect(await screen.findByText('● Unsaved')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writeChapter).toHaveBeenCalledWith('c1.md', edited))

    // The structure is re-read before it is written back, so the saved copy is
    // the one on disk rather than the one this view happens to hold.
    expect(api.getNovelMeta).toHaveBeenCalled()
    const [meta] = api.saveNovelMeta.mock.calls.at(-1)!
    expect(meta.volumes[0].chapters[0].wordCount).toBe(countWords(edited))
    expect(meta.volumes[0].chapters[1].wordCount).toBe(120)
  })

  it('never resurrects a chapter the author deleted while writing', async () => {
    // Outline removed chapter 2 and rewrote novel.json after this view mounted.
    api.getNovelMeta.mockResolvedValue({
      ...novel,
      volumes: [{ ...novel.volumes[0], chapters: [novel.volumes[0].chapters[0]] }],
    })
    await mount()
    await openFirstChapter()

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.saveNovelMeta).toHaveBeenCalled())

    const [meta] = api.saveNovelMeta.mock.calls.at(-1)!
    expect(meta.volumes[0].chapters.map((c: Chapter) => c.id)).toEqual(['c1'])
  })

  it('holds back the Story Memory review until the chapter is saved', async () => {
    await mount()
    await openFirstChapter()
    await screen.findByText(`This chapter ${countWords(CHAPTER_TEXT)} words`)

    // Reviewing unsaved prose would extract facts from a chapter that is not on
    // disk, so the entry point is disabled while the chapter is dirty.
    expect(screen.getByRole('button', { name: /story memory/i })).toBeEnabled()
    await write(' More.')
    expect(await screen.findByText('● Unsaved')).toBeTruthy()
    expect(screen.getByRole('button', { name: /story memory/i })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /story memory/i })).toBeEnabled())

    fireEvent.click(screen.getByRole('button', { name: /story memory/i }))
    const { useStore } = await import('../../src/renderer/src/store')
    expect(useStore.getState().view).toBe('story-memory')
    expect(useStore.getState().storyMemoryFocusChapterId).toBe('c1')
  })

  it('marks a chapter final and persists the status', async () => {
    await mount()
    await openFirstChapter()

    fireEvent.click(screen.getByRole('button', { name: 'Draft' }))
    await waitFor(() => expect(api.saveNovelMeta).toHaveBeenCalled())

    const [meta] = api.saveNovelMeta.mock.calls.at(-1)!
    expect(meta.volumes[0].chapters[0].status).toBe('done')
    expect(await screen.findByRole('button', { name: 'Final' })).toBeTruthy()
  })

  it('opens a clean full-screen editor in zen mode and leaves it on Escape', async () => {
    await mount()
    await openFirstChapter()

    fireEvent.click(screen.getByRole('button', { name: /zen/i }))

    expect(screen.queryByText('Contents')).toBeNull()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(await screen.findByText('Contents')).toBeTruthy()
  })

  it('points at the outline when there is nothing to write yet', async () => {
    await mount({ ...novel, volumes: [] })

    expect(
      await screen.findByText('No volumes yet. Plan volumes and chapters in the Outline view.'),
    ).toBeTruthy()
  })
})
