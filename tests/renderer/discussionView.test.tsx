/**
 * @vitest-environment jsdom
 *
 * Render tests for the Writers' Room.
 *
 * The orchestration itself is covered by tests/renderer/discussion.test.ts; what
 * is pinned here is the view: the setup form, the saved-session list, loading a
 * session back, and the diverge/converge switch. Those are the parts a split of
 * this 1900-line file can quietly break.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AgentPersona, AppConfig, DiscussionSession, NovelMeta } from '../../src/shared/types'

const api = vi.hoisted(() => ({
  listDiscussions: vi.fn(),
  saveDiscussion: vi.fn(),
  deleteDiscussion: vi.fn(),
  readOutline: vi.fn(),
  readOutlineStore: vi.fn(),
  listSettings: vi.fn(),
  readSetting: vi.fn(),
  readChapter: vi.fn(),
  listTimelineEvents: vi.fn(),
  saveTimelineEvents: vi.fn(),
  readStoryMemory: vi.fn(),
  writeStoryMemory: vi.fn(),
  writeSetting: vi.fn(),
}))

vi.mock('../../src/renderer/src/api', () => ({ installApi: () => {} }))

const persona = (id: string, name: string): AgentPersona => ({
  id,
  name,
  role: 'editor',
  systemPrompt: `you are ${name}`,
  color: '#B8642E',
})

const config: AppConfig = {
  ai: {
    providers: [{ id: 'p1', name: 'Provider', baseUrl: 'http://x', apiKey: 'sk-test', model: 'm' }],
    activeProviderId: 'p1',
  },
  personas: [persona('a', 'Vera · Editor'), persona('b', 'Sam · Reader')],
  consistency: { providerId: null, systemPrompt: '', userTemplate: '{{material}}' },
  writing: {
    providerId: null,
    outlineSystemPrompt: '',
    rewriteSystemPrompt: '',
    temperature: 0.8,
    topP: 0.9,
  },
}

const novel: NovelMeta = { title: 'T', author: '', synopsis: '', tags: [], volumes: [] }

const session = (over: Partial<DiscussionSession> = {}): DiscussionSession => ({
  id: 'd1',
  topic: 'The ledger is forged',
  personaIds: ['a', 'b'],
  rounds: 1,
  messages: [
    {
      id: 'm1',
      personaId: 'a',
      personaName: 'Vera · Editor',
      content: 'Cut the prologue.',
      round: 1,
      ts: 1,
    },
    {
      id: 'm2',
      personaId: 'b',
      personaName: 'Sam · Reader',
      content: 'I liked it.',
      round: 1,
      ts: 2,
    },
  ],
  conclusion: null,
  createdAt: 1,
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  ;(globalThis as unknown as { window: Window }).window.api = api as never
  api.listDiscussions.mockResolvedValue([])
  api.listSettings.mockResolvedValue([])
  api.listTimelineEvents.mockResolvedValue([])
  api.readStoryMemory.mockResolvedValue({ version: 1, entries: [] })
})

afterEach(() => {
  cleanup()
  localStorage.clear()
})

async function renderDiscussion(): Promise<void> {
  const { default: Discussion } = await import('../../src/renderer/src/views/Discussion')
  const { useStore } = await import('../../src/renderer/src/store')
  useStore.setState({
    novel,
    config,
    settingDocs: [],
    currentWorldId: 'w1',
    view: 'discussion',
  } as never)
  render(<Discussion />)
}

describe('setting up a discussion', () => {
  it('lists every persona and gates the start action on a topic', async () => {
    await renderDiscussion()

    expect(await screen.findByText(/Vera · Editor/)).toBeTruthy()
    expect(screen.getByText(/Sam · Reader/)).toBeTruthy()

    const topic = screen.getByPlaceholderText(/describe what you want the personas to discuss/i)
    const start = screen.getByRole('button', { name: /start/i })
    expect(start).toBeDisabled()

    fireEvent.change(topic, { target: { value: 'Is the ledger twist earned?' } })
    expect(start).not.toBeDisabled()
  })

  it('keeps the start action disabled when every persona is deselected', async () => {
    await renderDiscussion()

    fireEvent.change(screen.getByPlaceholderText(/describe what you want/i), {
      target: { value: 'A topic' },
    })
    // Each persona row is a toggle; turning both off leaves nobody to speak.
    fireEvent.click(await screen.findByText(/Vera · Editor/))
    fireEvent.click(screen.getByText(/Sam · Reader/))
    await waitFor(() => expect(screen.getByRole('button', { name: /start/i })).toBeDisabled())
  })

  it('switches between diverging and converging', async () => {
    await renderDiscussion()

    // The active mode is styled differently, so its class list is the signal.
    const converge = await screen.findByRole('button', { name: /converge/i })
    const diverge = screen.getByRole('button', { name: /diverge/i })
    expect(diverge.className).toMatch(/border-star-accent/)
    expect(converge.className).not.toMatch(/border-star-accent/)

    fireEvent.click(converge)
    await waitFor(() => expect(converge.className).toMatch(/border-star-accent/))
    expect(diverge.className).not.toMatch(/border-star-accent/)

    fireEvent.click(diverge)
    await waitFor(() => expect(diverge.className).toMatch(/border-star-accent/))
  })
})

describe('saved sessions', () => {
  it('lists what was archived and loads one back', async () => {
    api.listDiscussions.mockResolvedValue([session()])
    await renderDiscussion()

    // The archived topic is offered in the sidebar.
    const entry = await screen.findAllByText(/The ledger is forged/)
    expect(entry.length).toBeGreaterThan(0)

    fireEvent.click(entry[0])
    expect(await screen.findByText('Cut the prologue.')).toBeTruthy()
    expect(screen.getByText('I liked it.')).toBeTruthy()
  })
})
