/**
 * @vitest-environment jsdom
 *
 * Render-level tests for the Forge view.
 *
 * These exist for the same reason the module tests do: the view is a large
 * stateful surface whose failures are silent. A render test pins the few
 * behaviours that must survive a refactor — the brief gates on a theme, a run
 * shows its chapters, the review findings offer an action, and the controls
 * call the API the author expects.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ForgeRun, NovelMeta } from '../../src/shared/types'

const api = vi.hoisted(() => ({
  readForgeRun: vi.fn(),
  startForgeRun: vi.fn(),
  pauseForgeRun: vi.fn(),
  resumeForgeRun: vi.fn(),
  cancelForgeRun: vi.fn(),
  discardForgeRun: vi.fn(),
  writeForgeDirectives: vi.fn(),
  redraftForgeChapter: vi.fn(),
  forgeMoreChapters: vi.fn(),
  forgeExtendPlan: vi.fn(),
  // The view feeds generated content back into the app as it lands, so the
  // store's refreshes must be answered too.
  getNovelMeta: vi.fn(),
  listSettings: vi.fn(),
}))

vi.mock('../../src/renderer/src/api', () => ({ installApi: () => {} }))

const novel: NovelMeta = { title: 'T', author: '', synopsis: '', tags: [], volumes: [] }

const run = (over: Partial<ForgeRun> = {}): ForgeRun => ({
  version: 1,
  id: 'fr_1',
  worldId: 'w1',
  worldTitle: 'T',
  brief: {
    theme: 'A city where memories are traded',
    genre: 'Fantasy',
    tone: 'dark',
    language: 'en',
    pov: '',
    chapters: 3,
    wordsPerChapter: 500,
    constraints: '',
    providerId: null,
    scope: 'draft',
    draftCount: 0,
    replaceExisting: false,
  },
  status: 'completed',
  phase: 'done',
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now(),
  finishedAt: Date.now(),
  concept: {
    title: 'Ashes of the Accord',
    genre: 'Fantasy',
    logline: 'A broker buys back her past.',
    synopsis: 'Synopsis.',
    themes: ['memory'],
    tone: 'dark',
    pov: 'third',
    styleGuide: 'Short sentences.',
    cast: [],
    worldNotes: '',
  },
  chapters: [
    {
      chapterId: 'c1',
      title: 'Chapter 1: Ash',
      volumeTitle: 'Volume One',
      order: 0,
      beats: [],
      prose: 'drafted',
      memory: 'done',
      words: 600,
      summary: '',
      endState: '',
      attempts: 1,
      memoryAttempts: 1,
      error: null,
    },
    {
      chapterId: 'c2',
      title: 'Chapter 2: Debt',
      volumeTitle: 'Volume One',
      order: 1,
      beats: [],
      prose: 'pending',
      memory: 'pending',
      words: 0,
      summary: '',
      endState: '',
      attempts: 0,
      memoryAttempts: 0,
      error: null,
    },
  ],
  direction: [],
  reviewedUpTo: 1,
  findings: [],
  planRequest: 0,
  steps: [],
  log: [{ ts: Date.now(), level: 'info', message: 'Forge complete.' }],
  totals: { modelCalls: 4, inputTokens: 10, outputTokens: 20, durationMs: 1000, words: 600 },
  error: null,
  ...over,
})

/** The view talks to the server through window.api. */
function mountApi() {
  ;(globalThis as unknown as { window: Window }).window.api = api as never
}

beforeEach(() => {
  vi.clearAllMocks()
  mountApi()
  api.readForgeRun.mockResolvedValue(null)
  api.getNovelMeta.mockResolvedValue(novel)
  api.listSettings.mockResolvedValue([])
  api.startForgeRun.mockResolvedValue(run({ status: 'running', phase: 'concept' }))
  api.writeForgeDirectives.mockResolvedValue(run())
  api.redraftForgeChapter.mockResolvedValue(run({ status: 'running', phase: 'draft' }))
  api.forgeMoreChapters.mockResolvedValue(run({ status: 'running', phase: 'draft' }))
  api.forgeExtendPlan.mockResolvedValue(run({ status: 'running', phase: 'outline' }))
})

afterEach(() => {
  cleanup()
})

/** The store supplies the world; the view reads config and the novel from it. */
async function renderForge(): Promise<void> {
  const { default: Forge } = await import('../../src/renderer/src/views/Forge')
  const { useStore } = await import('../../src/renderer/src/store')
  useStore.setState({ novel, config: null, view: 'forge' } as never)
  render(<Forge />)
}

describe('the brief', () => {
  it('gates the primary action on a theme', async () => {
    await renderForge()
    const start = await screen.findByRole('button', { name: /forge the novel/i })
    expect(start).toBeDisabled()

    fireEvent.change(screen.getByPlaceholderText(/one or two sentences/i), {
      target: { value: 'A city where memories are traded' },
    })
    expect(start).not.toBeDisabled()

    fireEvent.click(start)
    await waitFor(() => expect(api.startForgeRun).toHaveBeenCalledTimes(1))
    expect(api.startForgeRun.mock.calls[0][0]).toMatchObject({
      theme: 'A city where memories are traded',
      scope: 'draft',
    })
  })

  it('offers a theme idea as a starting point', async () => {
    await renderForge()
    fireEvent.click(await screen.findByRole('button', { name: /memory market/i }))
    const theme = screen.getByPlaceholderText(/one or two sentences/i) as HTMLTextAreaElement
    expect(theme.value).toMatch(/memories are bought and sold/i)
    // The idea also picks the genre it was written for.
    expect((screen.getByPlaceholderText(/^fantasy/i) as HTMLInputElement).value).toBe(
      'Science fiction',
    )
  })
})

describe('a run', () => {
  it('lists the chapters and the progress it reached', async () => {
    api.readForgeRun.mockResolvedValue(run())
    await renderForge()

    expect(await screen.findByText('Chapter 1: Ash')).toBeTruthy()
    expect(screen.getByText('Chapter 2: Debt')).toBeTruthy()
    expect(screen.getByText('Ashes of the Accord')).toBeTruthy()
    // One of two planned chapters is written, and the run reports its totals.
    expect(screen.getByText('1/2')).toBeTruthy()
  })

  it('continues drafting the chapters the plan still holds', async () => {
    api.readForgeRun.mockResolvedValue(run())
    await renderForge()

    fireEvent.click(await screen.findByRole('button', { name: /^draft it$/i }))
    await waitFor(() => expect(api.forgeMoreChapters).toHaveBeenCalledWith(1))
  })

  it('commissions the next arc when the plan is used up', async () => {
    api.readForgeRun.mockResolvedValue(
      run({
        chapters: [
          { ...run().chapters[0] },
          { ...run().chapters[1], prose: 'drafted', memory: 'done', words: 500 },
        ],
      }),
    )
    await renderForge()

    fireEvent.click(await screen.findByRole('button', { name: /plan more chapters/i }))
    await waitFor(() => expect(api.forgeExtendPlan).toHaveBeenCalledWith(5))
  })

  it('writes a chapter again under an instruction', async () => {
    api.readForgeRun.mockResolvedValue(run({ chapters: [run().chapters[0]] }))
    await renderForge()

    fireEvent.click(await screen.findByTitle(/write this chapter again/i))
    fireEvent.change(screen.getByPlaceholderText(/what should this chapter do differently/i), {
      target: { value: 'Too slow.' },
    })
    fireEvent.click(screen.getByRole('button', { name: /write it again/i }))

    await waitFor(() =>
      expect(api.redraftForgeChapter).toHaveBeenCalledWith({
        chapterId: 'c1',
        instruction: 'Too slow.',
      }),
    )
  })

  it('offers an action for each continuity finding', async () => {
    api.readForgeRun.mockResolvedValue(
      run({
        findings: [
          {
            severity: 'critical',
            text: 'The ledger burns twice.',
            chapterTitle: 'Chapter 1: Ash',
            relatedDocTitles: ['Ilyra'],
          },
          {
            severity: 'unsure',
            text: 'A chapter that does not exist.',
            chapterTitle: 'Chapter 9: Missing',
            relatedDocTitles: [],
          },
        ],
      }),
    )
    await renderForge()

    expect(await screen.findByText('The ledger burns twice.')).toBeTruthy()
    expect(screen.getByText(/Ilyra/)).toBeTruthy()

    const actions = screen.getAllByRole('button', { name: /act on this/i })
    expect(actions).toHaveLength(2)
    // The one naming a real chapter can be acted on; the other cannot.
    expect(actions[0]).not.toBeDisabled()
    expect(actions[1]).toBeDisabled()

    fireEvent.click(actions[0])
    fireEvent.click(await screen.findByRole('button', { name: /write it again/i }))
    await waitFor(() =>
      expect(api.redraftForgeChapter).toHaveBeenCalledWith({
        chapterId: 'c1',
        instruction: 'The ledger burns twice.',
      }),
    )
  })

  it('adds a direction from the next unwritten chapter', async () => {
    api.readForgeRun.mockResolvedValue(run())
    await renderForge()

    fireEvent.click(await screen.findByRole('button', { name: /direction/i }))
    fireEvent.change(screen.getByPlaceholderText(/stop resolving her memory loss/i), {
      target: { value: 'No romance.' },
    })
    fireEvent.click(screen.getByRole('button', { name: /add direction/i }))

    await waitFor(() => expect(api.writeForgeDirectives).toHaveBeenCalledTimes(1))
    const [directives] = api.writeForgeDirectives.mock.calls[0]
    expect(directives).toHaveLength(1)
    expect(directives[0]).toMatchObject({ text: 'No romance.', onlyOrder: null })
    // Chapter 2 is the first unwritten one, so that is where it starts.
    expect(directives[0].fromOrder).toBe(2)
  })
})
