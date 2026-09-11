/**
 * @vitest-environment jsdom
 *
 * Render tests for the Codex Graph and the in-character chat.
 *
 * The Graph is a second reading of the codex: it claims the documents and the
 * [[wikilinks]] between them *are* the map, so what it hands the renderer has
 * to be exactly what the documents say — one node per document (linked or not)
 * and one edge per resolvable, non-self, undirected link. The canvas library is
 * mocked, because the data is what matters, not the pixels.
 *
 * CharacterChat is where a codex entry becomes a voice: the character's own
 * document is the bible handed to the model, the reply joins the transcript and
 * is persisted, and a provider that fails must not cost the author the turn
 * they already typed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CATEGORY_COLORS } from '../../src/renderer/src/lib'
import { PROMPTS } from '../../src/shared/prompts'
import type {
  AppConfig,
  CharacterChatSession,
  ChatMessage,
  NovelMeta,
  SettingDoc,
} from '../../src/shared/types'

const api = vi.hoisted(() => ({
  readSetting: vi.fn(),
  listCharacterChats: vi.fn(),
  saveCharacterChat: vi.fn(),
  deleteCharacterChat: vi.fn(),
  chat: vi.fn(),
  writeSetting: vi.fn(),
}))

vi.mock('../../src/renderer/src/api', () => ({ installApi: () => {}, chatStream: vi.fn() }))

/** The parts of a vis-network node / edge these tests assert on. */
interface GraphNode {
  id: string
  label: string
  color: { background: string; border: string }
  group: string
}
interface GraphEdge {
  from: string
  to: string
}

/**
 * jsdom has no canvas, so the real vis-network cannot start. This stand-in
 * records the container, the data sets and the options the view builds, and
 * lets a test drive the event handlers the view registers.
 */
const vis = vi.hoisted(() => {
  // Deliberately loose: the view registers narrower callbacks (doubleClick).
  type Handler = (params: Record<string, unknown>) => void

  class FakeNetwork {
    static readonly instances: FakeNetwork[] = []

    readonly container: HTMLElement
    readonly data: {
      nodes: { get: () => GraphNode[] }
      edges: { get: () => GraphEdge[] }
    }
    readonly options: unknown
    readonly optionUpdates: unknown[] = []
    destroyed = false

    private readonly handlers = new Map<string, Handler[]>()

    constructor(container: HTMLElement, data: FakeNetwork['data'], options: unknown) {
      this.container = container
      this.data = data
      this.options = options
      FakeNetwork.instances.push(this)
    }

    on(event: string, handler: Handler): void {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
    }

    once(event: string, handler: Handler): void {
      this.on(event, handler)
    }

    setOptions(options: unknown): void {
      this.optionUpdates.push(options)
    }

    destroy(): void {
      this.destroyed = true
    }

    /** Test-only: fire an event the view registered a handler for. */
    emit(event: string, params: Record<string, unknown>): void {
      for (const handler of this.handlers.get(event) ?? []) handler(params)
    }
  }

  return { FakeNetwork, networks: FakeNetwork.instances }
})

vi.mock('vis-network', () => ({ Network: vis.FakeNetwork }))

beforeEach(async () => {
  vi.clearAllMocks()
  ;(globalThis as unknown as { window: Window }).window.api = api as never
  vis.networks.length = 0
  api.listCharacterChats.mockResolvedValue([])
  api.saveCharacterChat.mockResolvedValue(undefined)
  api.deleteCharacterChat.mockResolvedValue(undefined)
  api.writeSetting.mockResolvedValue(undefined)

  const { useStore } = await import('../../src/renderer/src/store')
  useStore.setState({
    novel: null,
    config: null,
    settingDocs: [],
    currentWorldId: null,
    view: 'dashboard',
  } as never)
  const { useToastStore } = await import('../../src/renderer/src/toast')
  useToastStore.setState({ toasts: [] })
})

afterEach(() => {
  cleanup()
})

/* ------------------------------------------------------------------ codex */

const codexDocs: SettingDoc[] = [
  { id: 'character/ari.md', title: 'Ari', category: '11-character', updatedAt: 1 },
  {
    id: '01-worldview/ash-ledger.md',
    title: 'Ash Ledger',
    category: '01-worldview',
    updatedAt: 1,
  },
  { id: '99-misc/notes.md', title: 'Notes', category: '99-misc', updatedAt: 1 },
]

const codexBodies: Record<string, string> = {
  'character/ari.md': 'Keeper of the [[Ash Ledger]].',
  '01-worldview/ash-ledger.md': 'A debt older than the city.',
  '99-misc/notes.md': 'Loose ends.',
}

/** Serve the codex, with any document body a test wants to change. */
function serveCodex(overrides: Record<string, string> = {}, broken: string[] = []): void {
  const bodies = { ...codexBodies, ...overrides }
  api.readSetting.mockImplementation(async (id: string) => {
    if (broken.includes(id)) throw new Error(`Cannot read ${id}`)
    const doc = codexDocs.find((d) => d.id === id)
    if (!doc) throw new Error(`Unknown document: ${id}`)
    return { ...doc, content: bodies[id] ?? '' }
  })
}

async function mountGraph(docs: SettingDoc[] = codexDocs): Promise<void> {
  const { useStore } = await import('../../src/renderer/src/store')
  useStore.setState({ settingDocs: docs, view: 'graph' } as never)
  const { default: Graph } = await import('../../src/renderer/src/views/Graph')
  render(<Graph />)
}

async function waitForNetwork(): Promise<(typeof vis.networks)[number]> {
  await waitFor(() => expect(vis.networks).toHaveLength(1))
  return vis.networks[0]
}

describe('the codex graph', () => {
  it('shows the empty state instead of a map when the codex is empty', async () => {
    await mountGraph([])

    expect(await screen.findByText('No codex documents yet')).toBeTruthy()
    expect(screen.getByText(/0 nodes . Double-click a node to open/)).toBeTruthy()
    // Nothing to read and nothing to draw: no document is fetched, no network built.
    expect(api.readSetting).not.toHaveBeenCalled()
    expect(vis.networks).toHaveLength(0)
  })

  it('gives every document a node, including one that links to nothing', async () => {
    serveCodex()
    await mountGraph()
    const network = await waitForNetwork()

    expect(screen.getByText(/3 nodes . Double-click a node to open/)).toBeTruthy()
    expect(network.data.nodes.get().map((n) => [n.id, n.label, n.group])).toEqual([
      ['character/ari.md', 'Ari', '11-character'],
      ['01-worldview/ash-ledger.md', 'Ash Ledger', '01-worldview'],
      ['99-misc/notes.md', 'Notes', '99-misc'],
    ])
    // The colour is the category's, so the map reads at a glance.
    expect(network.data.nodes.get().map((n) => n.color.background)).toEqual([
      CATEGORY_COLORS['11-character'],
      CATEGORY_COLORS['01-worldview'],
      CATEGORY_COLORS['99-misc'],
    ])
  })

  it('draws an edge only where a document really links to another one', async () => {
    serveCodex({
      'character/ari.md':
        'Keeper of the [[Ash Ledger]], and again the [[Ash Ledger]], and [[Ari]].',
      '01-worldview/ash-ledger.md': 'The debt outlived the city, as [[Ari]] knows.',
      '99-misc/notes.md': 'A [[Ghost Town]] no document describes, plus [[Notes]].',
    })
    await mountGraph()
    const network = await waitForNetwork()

    // One undirected edge per linked pair: the repeated link, the reverse link
    // and the self-links collapse, and an unresolvable link makes no edge.
    expect(network.data.edges.get().map((e) => [e.from, e.to])).toEqual([
      ['character/ari.md', '01-worldview/ash-ledger.md'],
    ])
  })

  it('keeps a document whose body cannot be read as a node', async () => {
    serveCodex({}, ['01-worldview/ash-ledger.md'])
    await mountGraph()
    const network = await waitForNetwork()

    // Every document is read; the unreadable one loses its outgoing links only,
    // and the links other documents point at it still hold.
    expect(api.readSetting).toHaveBeenCalledTimes(3)
    expect(network.data.nodes.get().map((n) => n.id)).toEqual([
      'character/ari.md',
      '01-worldview/ash-ledger.md',
      '99-misc/notes.md',
    ])
    expect(network.data.edges.get().map((e) => [e.from, e.to])).toEqual([
      ['character/ari.md', '01-worldview/ash-ledger.md'],
    ])
  })

  it('opens the document behind a double-clicked node', async () => {
    serveCodex()
    await mountGraph()
    const network = await waitForNetwork()

    const opened: string[] = []
    const onNavigate = (e: Event): void => {
      opened.push((e as CustomEvent).detail.docId)
    }
    window.addEventListener('codex-navigate', onNavigate)

    // Empty space is not a document, so it navigates nowhere.
    network.emit('doubleClick', { nodes: [] })
    expect(opened).toEqual([])

    network.emit('doubleClick', { nodes: ['01-worldview/ash-ledger.md'] })
    const { useStore } = await import('../../src/renderer/src/store')
    expect(useStore.getState().view).toBe('settings-docs')
    expect(opened).toEqual(['01-worldview/ash-ledger.md'])

    window.removeEventListener('codex-navigate', onNavigate)
  })
})

/* ------------------------------------------------------------------- chat */

const ARI_ID = 'character/ari.md'
const ARI_BODY = 'Ari keeps the ledger. She trusts nobody, least of all her brother.'

const chatDocs: SettingDoc[] = [
  { id: ARI_ID, title: 'Ari', category: '11-character', updatedAt: 1 },
  { id: 'character/corvin.md', title: 'Corvin', category: '11-character', updatedAt: 1 },
]

const chatBodies: Record<string, string> = {
  [ARI_ID]: ARI_BODY,
  'character/corvin.md': 'Corvin wants the ledger back.',
}

const novel: NovelMeta = {
  title: 'The Ash Ledger',
  author: '',
  synopsis: '',
  tags: [],
  volumes: [],
}

const config = (apiKey: string | null = 'sk-test'): AppConfig => ({
  ai: {
    providers: apiKey
      ? [{ id: 'p1', name: 'Provider', baseUrl: 'http://x', apiKey, model: 'm' }]
      : [],
    activeProviderId: apiKey ? 'p1' : null,
  },
  personas: [],
  consistency: { providerId: null, systemPrompt: '', userTemplate: '{{material}}' },
  writing: {
    providerId: null,
    outlineSystemPrompt: '',
    rewriteSystemPrompt: '',
    temperature: 0.8,
    topP: 0.9,
  },
})

const savedSession: CharacterChatSession = {
  id: 'cc_1',
  characterId: ARI_ID,
  characterTitle: 'Ari',
  messages: [
    { id: 'm1', role: 'user', content: 'Who holds the ledger?', ts: 1 },
    { id: 'm2', role: 'character', content: 'I hold the ledger.', ts: 2 },
  ],
  createdAt: 1,
  updatedAt: 2,
}

function serveCharacterDocs(docs: SettingDoc[] = chatDocs): void {
  api.readSetting.mockImplementation(async (id: string) => {
    const doc = docs.find((d) => d.id === id)
    if (!doc) throw new Error(`Unknown character: ${id}`)
    return { ...doc, content: chatBodies[id] ?? 'No body.' }
  })
}

async function mountChat(docs: SettingDoc[] = chatDocs, cfg: AppConfig = config()): Promise<void> {
  serveCharacterDocs(docs)
  const { useStore } = await import('../../src/renderer/src/store')
  useStore.setState({
    novel,
    config: cfg,
    settingDocs: docs,
    currentWorldId: 'w1',
    view: 'character-chat',
  } as never)
  const { default: CharacterChat } = await import('../../src/renderer/src/views/CharacterChat')
  render(<CharacterChat />)
}

/** The message list of the nth request the view handed the model. */
function request(n: number): { messages: ChatMessage[]; providerId: string | undefined } {
  const [messages, providerId] = api.chat.mock.calls[n] as [ChatMessage[], string | undefined]
  return { messages, providerId }
}

/** Pick a character and wait until its codex entry has been loaded. */
async function selectCharacter(name: string): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name }))
  const box = await screen.findByPlaceholderText(/say something to this character/i)
  await waitFor(() => expect(box).not.toBeDisabled())
}

async function sendMessage(text: string): Promise<void> {
  fireEvent.change(screen.getByPlaceholderText(/say something to this character/i), {
    target: { value: text },
  })
  const send = screen.getByRole('button', { name: /^send$/i })
  await waitFor(() => expect(send).not.toBeDisabled())
  fireEvent.click(send)
}

/** Select a character when no composer is expected (no provider configured). */
async function selectCharacterWithoutComposer(name: string): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name }))
  await screen.findByText(/No AI provider configured yet/)
}

describe('the in-character chat', () => {
  it('tells the author to create a character when the codex has none', async () => {
    await mountChat([
      {
        id: '01-worldview/ash-ledger.md',
        title: 'Ash Ledger',
        category: '01-worldview',
        updatedAt: 1,
      },
    ])

    expect(await screen.findByText('No characters yet')).toBeTruthy()
    expect(screen.queryByPlaceholderText(/say something to this character/i)).toBeNull()
  })

  it('withholds the composer until a provider is configured', async () => {
    await mountChat(chatDocs, config(null))
    await selectCharacterWithoutComposer('Ari')

    // Without a key there is nothing to send with, so the chat area explains
    // that instead of offering an input that could only fail.
    expect(await screen.findByText(/No AI provider configured yet/)).toBeTruthy()
    expect(screen.queryByPlaceholderText(/say something to this character/i)).toBeNull()
  })

  it("briefs the model with the character's own codex document", async () => {
    api.chat.mockResolvedValue('The ledger is mine.')
    await mountChat()

    await selectCharacter('Ari')
    await sendMessage('Who holds the ledger?')

    await waitFor(() => expect(api.chat).toHaveBeenCalledTimes(1))
    const { messages, providerId } = request(0)
    // The character bible is the document itself, under the pack's instructions
    // for that character by name — a different document must change this prompt.
    expect(messages[0]).toEqual({
      role: 'system',
      content: PROMPTS.characterChat.systemPrompt({ name: 'Ari', content: ARI_BODY }),
    })
    expect(messages[1]).toEqual({ role: 'user', content: 'Who holds the ledger?' })
    expect(providerId).toBe('p1')
  })

  it('appends the reply, saves it under the character, and carries it forward', async () => {
    api.chat.mockResolvedValue('  The ledger is mine.  ')
    await mountChat()
    await selectCharacter('Ari')
    await sendMessage('Who holds the ledger?')

    // Padding from the model is trimmed before the reply reaches the transcript.
    expect(await screen.findByText('The ledger is mine.')).toBeTruthy()
    expect(screen.queryByText(/is thinking/)).toBeNull()

    await waitFor(() => expect(api.saveCharacterChat).toHaveBeenCalled())
    const saved = api.saveCharacterChat.mock.calls.at(-1)![0] as CharacterChatSession
    expect(saved.characterId).toBe(ARI_ID)
    expect(saved.characterTitle).toBe('Ari')
    expect(saved.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Who holds the ledger?'],
      ['character', 'The ledger is mine.'],
    ])

    // The next turn carries the whole exchange, so the character keeps context.
    await sendMessage('And the interest?')
    await waitFor(() => expect(api.chat).toHaveBeenCalledTimes(2))
    expect(request(1).messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(request(1).messages.at(-2)).toEqual({
      role: 'assistant',
      content: 'The ledger is mine.',
    })
  })

  it('reports a failed request, keeps the turn, and still accepts a retry', async () => {
    api.chat.mockRejectedValueOnce(new Error('The provider is overloaded'))
    await mountChat()
    await selectCharacter('Ari')
    await sendMessage('Who holds the ledger?')

    // The failure is surfaced, not swallowed, and the typed turn is preserved
    // rather than thrown away with the request.
    const { useToastStore } = await import('../../src/renderer/src/toast')
    await waitFor(() =>
      expect(useToastStore.getState().toasts.at(-1)?.message).toBe('The provider is overloaded'),
    )
    expect(await screen.findByText('Who holds the ledger?')).toBeTruthy()
    // The conversation is usable again: the composer is re-enabled, nothing is
    // stuck in flight, and the failed turn alone was persisted.
    await waitFor(() =>
      expect(screen.getByPlaceholderText(/say something to this character/i)).not.toBeDisabled(),
    )
    const failed = api.saveCharacterChat.mock.calls.at(-1)![0] as CharacterChatSession
    expect(failed.messages.map((m) => m.role)).toEqual(['user'])

    api.chat.mockResolvedValue('I hold it.')
    await sendMessage('Answer me, then.')
    expect(await screen.findByText('I hold it.')).toBeTruthy()
    expect(request(1).messages.at(-1)).toEqual({ role: 'user', content: 'Answer me, then.' })
    expect(request(1).messages.at(-2)).toEqual({
      role: 'user',
      content: 'Who holds the ledger?',
    })
  })

  it('reopens a saved transcript and clears it on reset', async () => {
    api.listCharacterChats.mockResolvedValue([savedSession])
    await mountChat()
    // Wait for the archived list, then pick the character it belongs to.
    expect(await screen.findByText('Saved chats (1)')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Ari' }))

    expect(await screen.findByText('I hold the ledger.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /^reset$/i }))
    await waitFor(() => expect(api.deleteCharacterChat).toHaveBeenCalledWith(ARI_ID))
    // Reset empties the panel and the archive together.
    expect(screen.queryByText('I hold the ledger.')).toBeNull()
    expect(screen.getByText('Start a conversation with this character.')).toBeTruthy()
    await waitFor(() => expect(screen.getByText('Saved chats (0)')).toBeTruthy())
  })

  it('appends the conversation to the character document on promote', async () => {
    api.chat.mockResolvedValue('I hold the ledger.')
    await mountChat()
    await selectCharacter('Ari')
    await sendMessage('Who holds the ledger?')
    await screen.findByText('I hold the ledger.')

    fireEvent.click(screen.getByRole('button', { name: /^promote$/i }))
    fireEvent.click(
      await screen.findByRole('button', {
        name: /append conversation to the character document/i,
      }),
    )

    await waitFor(() => expect(api.writeSetting).toHaveBeenCalled())
    const [id, content] = api.writeSetting.mock.calls.at(-1) as [string, string]
    expect(id).toBe(ARI_ID)
    // The document keeps its own body; the exchange is appended under a heading.
    expect(content.startsWith(ARI_BODY)).toBe(true)
    expect(content).toContain('**You:** Who holds the ledger?')
    expect(content).toContain('**Ari:** I hold the ledger.')
    // The dialog closes only once the material is durable.
    await waitFor(() => expect(screen.queryByText('Promote conversation')).toBeNull())
  })
})
