/**
 * @vitest-environment jsdom
 *
 * Render tests for the Consistency Check view.
 *
 * The view is the front door of the review loop: it assembles the material,
 * streams a report, and only then decides whether that report becomes durable.
 * These tests pin the scope that is assembled (codex and chapters, opt-in per
 * chapter), the unsaved→saved handoff, and the codex reference in a report that
 * opens the document it names — the parts a refactor of this view can break
 * without any other view noticing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AppConfig, ConsistencyReport, NovelMeta, SettingDoc } from '../../src/shared/types'

const api = vi.hoisted(() => ({
  listConsistencyReports: vi.fn(),
  saveConsistencyReport: vi.fn(),
  deleteConsistencyReport: vi.fn(),
  readOutline: vi.fn(),
  readSetting: vi.fn(),
  readChapter: vi.fn(),
}))

const chatStream = vi.hoisted(() => vi.fn())

vi.mock('../../src/renderer/src/api', () => ({
  installApi: () => {},
  chatStream: (...args: unknown[]) => chatStream(...args),
}))

const baseConfig: AppConfig = {
  ai: { providers: [], activeProviderId: null },
  personas: [],
  consistency: { providerId: null, systemPrompt: 'You are a continuity editor.', userTemplate: '' },
  writing: {
    providerId: null,
    outlineSystemPrompt: '',
    rewriteSystemPrompt: '',
    temperature: 0.8,
    topP: 0.9,
  },
}

const keyedConfig: AppConfig = {
  ...baseConfig,
  ai: {
    providers: [
      { id: 'p1', name: 'Local', baseUrl: 'http://localhost', apiKey: 'sk-test', model: 'm' },
    ],
    activeProviderId: 'p1',
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
          wordCount: 40,
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

const REPORT = [
  '# Consistency report',
  '',
  "- 🔴 Ari's rank contradicts Chapter 3 (docs: character/ari.md)",
  '- 🟢 Everything else holds together.',
].join('\n')

const savedReport: ConsistencyReport = {
  id: 'rep1',
  createdAt: 1_700_000_000_000,
  scope: { docs: ['Ari'], chapters: [] },
  content: '# Older report\n\nNothing to report.',
  wordCount: 24,
  status: 'open',
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(globalThis as unknown as { window: Window }).window.api = api as never
  api.listConsistencyReports.mockResolvedValue([])
  api.readOutline.mockResolvedValue('# Plot Outline\n\nShe arrives, then leaves.')
  api.readSetting.mockResolvedValue({
    id: 'character/ari.md',
    title: 'Ari',
    content: 'Ari is a captain.',
  })
  api.readChapter.mockResolvedValue('# Chapter 1: Ash\n\nShe arrives.')
  api.deleteConsistencyReport.mockResolvedValue(undefined)
  api.saveConsistencyReport.mockImplementation(async (input: { content: string }) => ({
    ...savedReport,
    content: input.content,
  }))
  chatStream.mockImplementation(
    async (
      _messages: unknown,
      _providerId: unknown,
      onChunk: (type: string, text: string) => void,
    ) => {
      onChunk('content', REPORT)
      return { content: REPORT, reasoning: '' }
    },
  )
  localStorage.clear()
})

afterEach(() => {
  cleanup()
})

async function mount(config: AppConfig = baseConfig, settingDocs: SettingDoc[] = docs) {
  const { useStore } = await import('../../src/renderer/src/store')
  useStore.setState({
    novel,
    config,
    settingDocs,
    currentWorldId: 'w1',
    view: 'consistency',
    settingFocusId: null,
  } as never)
  const mod = await import('../../src/renderer/src/views/Consistency')
  render(<mod.default />)
  await screen.findByText(/Consistency Check/)
}

describe('the consistency check', () => {
  it('waits for material and for a provider before it will run', async () => {
    await mount()

    expect(screen.getByText('Ready to review')).toBeTruthy()
    expect(
      screen.getByText('No AI provider configured yet. Add an API key under Settings first.'),
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: /run check/i })).toBeDisabled()
    expect(screen.getByText('Saved reports (0)')).toBeTruthy()
  })

  it('preselects the codex, opts chapters in by hand, and enables the run', async () => {
    await mount(keyedConfig)

    // Codex documents are selected by default; chapter prose is not.
    expect(screen.getByText('Codex (1)')).toBeTruthy()
    expect(screen.getByText('Chapters (0/12)')).toBeTruthy()
    expect(screen.getByRole('button', { name: /run check/i })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: /Chapter 1: Ash/ }))
    expect(screen.getByText('Chapters (1/12)')).toBeTruthy()

    // Clearing the codex leaves the chapter selected, so the run stays possible.
    fireEvent.click(screen.getByText('Clear'))
    expect(screen.getByText('Codex (0)')).toBeTruthy()
    expect(screen.getByText('Select all')).toBeTruthy()
    expect(screen.getByRole('button', { name: /run check/i })).toBeEnabled()
  })

  it('sends the outline, the selected codex and the selected chapters to the model', async () => {
    await mount(keyedConfig)
    fireEvent.click(screen.getByRole('button', { name: /Chapter 1: Ash/ }))
    fireEvent.click(screen.getByRole('button', { name: /run check/i }))

    await waitFor(() => expect(chatStream).toHaveBeenCalled())
    const messages = chatStream.mock.calls[0][0] as { role: string; content: string }[]
    expect(messages[0]).toMatchObject({ role: 'system', content: 'You are a continuity editor.' })
    const material = messages[1].content
    expect(material).toContain('# Plot Outline')
    expect(material).toContain('She arrives, then leaves.')
    expect(material).toContain('# Codex: Ari')
    expect(material).toContain('Ari is a captain.')
    expect(material).toContain('# Chapter: Chapter 1: Ash')
  })

  it('streams the report, marks it unsaved, and saves it with the scope it ran over', async () => {
    await mount(keyedConfig)
    await screen.findByText('Ready to review')

    fireEvent.click(screen.getByRole('button', { name: /run check/i }))

    expect(await screen.findByText(/rank contradicts Chapter 3/)).toBeTruthy()
    expect(screen.getByText('· unsaved')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /save report/i }))
    await waitFor(() => expect(api.saveConsistencyReport).toHaveBeenCalled())

    const [input] = api.saveConsistencyReport.mock.calls.at(-1)!
    expect(input.content).toBe(REPORT)
    // The scope is the snapshot of what was checked, by title.
    expect(input.scope).toEqual({ docs: ['Ari'], chapters: [] })

    expect(await screen.findByRole('button', { name: /^saved$/i })).toBeTruthy()
    expect(screen.queryByText('· unsaved')).toBeNull()
    expect(screen.getByText('Saved reports (1)')).toBeTruthy()
  })

  it('reopens a saved report and deletes it', async () => {
    api.listConsistencyReports.mockResolvedValue([savedReport])
    await mount(keyedConfig)

    expect(screen.getByText('Saved reports (1)')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /chars$/ }))

    expect(await screen.findByText(/Nothing to report/)).toBeTruthy()
    // A report read back from disk is already saved, not something to save again.
    expect(screen.queryByText('· unsaved')).toBeNull()
    expect(screen.getByText('1 codex, 0 chapters')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Delete report' }))
    await waitFor(() => expect(api.deleteConsistencyReport).toHaveBeenCalledWith('rep1'))
    expect(await screen.findByText('Saved reports (0)')).toBeTruthy()
    expect(screen.queryByText(/Nothing to report/)).toBeNull()
  })

  it('opens the codex document named by a link in the report', async () => {
    await mount(keyedConfig)
    fireEvent.click(screen.getByRole('button', { name: /run check/i }))
    await screen.findByText(/rank contradicts Chapter 3/)

    // "(docs: character/ari.md)" is rendered as the document's title, linked to
    // the document it names.
    const link = document.querySelector('a.wikilink')
    expect(link?.textContent).toBe('Ari')
    fireEvent.click(link!)

    const { useStore } = await import('../../src/renderer/src/store')
    expect(useStore.getState().view).toBe('settings-docs')
    expect(useStore.getState().settingFocusId).toBe('character/ari.md')
  })

  it('says so when there is no codex to check against', async () => {
    await mount(keyedConfig, [])

    expect(await screen.findByText('No codex documents yet.')).toBeTruthy()
    expect(screen.getByText('Codex (0)')).toBeTruthy()
    // With nothing selected at all, the run is blocked.
    expect(screen.getByRole('button', { name: /run check/i })).toBeDisabled()
  })
})
