/**
 * @vitest-environment jsdom
 *
 * Render tests for the Review Queue.
 *
 * The queue is the only place an AI finding becomes durable, author-owned work:
 * an issue is imported from a saved report, tracked through open → verified →
 * resolved, and every move is written back to the world's queue file. These
 * tests pin the transitions and the import, because a wrong transition is
 * silently accepted by the UI and only shows up as lost work later.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type {
  AppConfig,
  ConsistencyReport,
  NovelMeta,
  ReviewQueueItem,
  ReviewQueueStore,
  SettingDoc,
} from '../../src/shared/types'

const api = vi.hoisted(() => ({
  readReviewQueue: vi.fn(),
  writeReviewQueue: vi.fn(),
  listConsistencyReports: vi.fn(),
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

const docs: SettingDoc[] = [
  { id: 'character/ari.md', title: 'Ari', category: '11-character', updatedAt: 1 },
]

const item = (over: Partial<ReviewQueueItem> & Pick<ReviewQueueItem, 'id'>): ReviewQueueItem => ({
  reportId: null,
  reportLabel: '',
  severity: 'moderate',
  text: 'Something is inconsistent.',
  relatedDocIds: [],
  status: 'open',
  fixedIn: null,
  note: '',
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

const critical = item({
  id: 'r1',
  severity: 'critical',
  text: 'Ari is a captain here and a lieutenant in Chapter 3.',
  relatedDocIds: ['character/ari.md'],
  reportId: 'rep1',
  reportLabel: '05-01 10:00',
  createdAt: 2,
})
const resolved = item({
  id: 'r2',
  severity: 'unsure',
  text: 'The map may contradict Chapter 2.',
  status: 'resolved',
  // A document that has since been deleted can only be named by its id.
  relatedDocIds: ['character/unknown.md'],
  createdAt: 1,
})

const queue = (...items: ReviewQueueItem[]): ReviewQueueStore => ({ version: 1, items })

const report: ConsistencyReport = {
  id: 'rep1',
  createdAt: 1,
  scope: { docs: ['Ari'], chapters: [] },
  content: [
    '# Consistency report',
    '',
    "- 🔴 Ari's rank contradicts Chapter 3. (docs: character/ari.md)",
    '- 🟡 The guild is founded twice.',
    'Everything else holds together.',
  ].join('\n'),
  wordCount: 120,
  status: 'open',
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(globalThis as unknown as { window: Window }).window.api = api as never
  api.readReviewQueue.mockResolvedValue(queue(critical, resolved))
  api.writeReviewQueue.mockResolvedValue(undefined)
  api.listConsistencyReports.mockResolvedValue([])
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

async function mount(): Promise<void> {
  const { useStore } = await import('../../src/renderer/src/store')
  useStore.setState({
    novel,
    config,
    settingDocs: docs,
    currentWorldId: 'w1',
  } as never)
  const mod = await import('../../src/renderer/src/views/ReviewQueue')
  render(<mod.default />)
  await screen.findByText('Ari is a captain here and a lieutenant in Chapter 3.')
}

const written = () => api.writeReviewQueue.mock.calls.at(-1)![0] as ReviewQueueStore
const byId = (id: string): ReviewQueueItem => written().items.find((i) => i.id === id)!

describe('the review queue', () => {
  it('lists items worst-first and resolves a related codex document by title', async () => {
    await mount()

    expect(screen.getByText('1 open · 2 total')).toBeTruthy()
    expect(screen.getByText('Critical')).toBeTruthy()
    expect(screen.getByText('Unsure')).toBeTruthy()
    // The issue points at a codex document; the list shows its title, and falls
    // back to the raw id for a document that no longer exists.
    expect(screen.getByText(/· Ari/)).toBeTruthy()
    expect(screen.getByText(/· character\/unknown\.md/)).toBeTruthy()
    // An imported item names the report it came from, a manual one says so.
    expect(screen.getByText(/report 05-01 10:00/)).toBeTruthy()
    expect(screen.getByText('manual')).toBeTruthy()

    // Worst severity first, before the item's own age (the unsure one is older).
    const texts = screen.getAllByText(/captain here|may contradict/).map((n) => n.textContent)
    expect(texts[0]).toMatch(/captain here/)
  })

  it('filters by status and counts each status', async () => {
    await mount()

    fireEvent.click(screen.getByRole('button', { name: /open\s*1/i }))
    expect(screen.getByText(/captain here/)).toBeTruthy()
    expect(screen.queryByText(/The map may contradict/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /fixing\s*0/i }))
    expect(screen.getByText('No fixing items')).toBeTruthy()
  })

  it('verifies an item and writes the queue back', async () => {
    await mount()

    fireEvent.click(screen.getByRole('button', { name: /verify/i }))
    await waitFor(() => expect(api.writeReviewQueue).toHaveBeenCalled())

    expect(byId('r1').status).toBe('verified')
    expect(byId('r2').status).toBe('resolved')
  })

  it('resolves an open item', async () => {
    await mount()

    // Only the open item offers Resolve; the resolved one offers Reopen instead.
    fireEvent.click(screen.getByRole('button', { name: /^resolve$/i }))
    await waitFor(() => expect(byId('r1').status).toBe('resolved'))
    expect(byId('r2').status).toBe('resolved')
  })

  it('reopens a resolved item', async () => {
    await mount()

    // Exactly one item is resolved to begin with, so one Reopen is on screen.
    fireEvent.click(screen.getByRole('button', { name: /^reopen$/i }))
    await waitFor(() => expect(byId('r2').status).toBe('open'))
    expect(byId('r1').status).toBe('open')
  })

  it('deletes an item without touching the others', async () => {
    await mount()

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete item' })[0])
    await waitFor(() => expect(api.writeReviewQueue).toHaveBeenCalled())

    expect(written().items.map((i) => i.id)).toEqual(['r2'])
  })

  it('adds a manual item from the prompt, ahead of the existing ones', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('Ari owns two different swords.')
    await mount()

    fireEvent.click(screen.getByRole('button', { name: /add item/i }))
    await waitFor(() => expect(api.writeReviewQueue).toHaveBeenCalled())

    const [added] = written().items
    expect(added.text).toBe('Ari owns two different swords.')
    expect(added.reportId).toBeNull()
    expect(written().items).toHaveLength(3)
  })

  it('imports only the severity-marked issues of a saved report', async () => {
    api.listConsistencyReports.mockResolvedValue([report])
    await mount()

    const open = screen.getByRole('button', { name: /import from report/i })
    expect(open).toBeEnabled()
    fireEvent.click(open)

    // The report's two marked lines become editable drafts; the unmarked
    // sentence ("Everything else holds together.") is not an issue.
    expect(await screen.findByDisplayValue(/rank contradicts Chapter 3/)).toBeTruthy()
    expect(screen.getByDisplayValue(/guild is founded twice/)).toBeTruthy()
    expect(screen.queryByDisplayValue(/Everything else holds together/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /add 2 items/i }))
    await waitFor(() => expect(api.writeReviewQueue).toHaveBeenCalled())

    const imported = written().items.slice(2)
    expect(imported).toHaveLength(2)
    expect(imported[0]).toMatchObject({
      severity: 'critical',
      text: "Ari's rank contradicts Chapter 3.",
      relatedDocIds: ['character/ari.md'],
      reportId: 'rep1',
      status: 'open',
    })
    expect(imported[1].severity).toBe('moderate')
    expect(imported[1].relatedDocIds).toEqual([])
    expect(imported[1].reportLabel).toBeTruthy()
  })

  it('gates the import on having saved a report first', async () => {
    await mount()

    const open = screen.getByRole('button', { name: /import from report/i })
    expect(open).toBeDisabled()
    expect(open).toHaveAttribute('title', 'Run a consistency check and save it first')
  })

  it('says so when the queue is empty', async () => {
    api.readReviewQueue.mockResolvedValue(queue())
    const { useStore } = await import('../../src/renderer/src/store')
    useStore.setState({ novel, config, settingDocs: docs, currentWorldId: 'w1' } as never)
    const mod = await import('../../src/renderer/src/views/ReviewQueue')
    render(<mod.default />)

    expect(await screen.findByText('Queue is empty')).toBeTruthy()
    expect(screen.getByText('0 open · 0 total')).toBeTruthy()
  })
})
