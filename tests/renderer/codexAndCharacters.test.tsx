/**
 * @vitest-environment jsdom
 *
 * Render tests for the Codex view and the Characters roster.
 *
 * Both views are thin shells over the same storage layer: a document is read
 * from its own file, edited in place, and written back to that same file. What a
 * writer depends on is therefore the data flow, not the chrome — the roster is
 * built from the world's settings list, the stats readout is derived from each
 * document's text, an unsaved buffer is flushed before the view navigates away
 * from it (a dropped buffer loses prose with no error anywhere), a read-only
 * external document must never expose a write path, and the backlink / copy
 * paths must talk to the endpoints they claim to. Those behaviours are pinned
 * here, against the mocked RPC surface rather than against rendered text alone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { CATEGORY_LABELS, wordCount } from '../../src/renderer/src/lib'
import type {
  AppConfig,
  ExternalMapping,
  SettingCategory,
  SettingDoc,
} from '../../src/shared/types'

const api = vi.hoisted(() => ({
  readSetting: vi.fn(),
  writeSetting: vi.fn(),
  createSetting: vi.fn(),
  deleteSetting: vi.fn(),
  listSettings: vi.fn(),
  listExternalMappings: vi.fn(),
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

// A long body keeps the codex stats total well above the "0.0k" floor, so the
// derived number is genuinely asserted instead of coincidentally matching.
const LONG_BODY = Array.from({ length: 500 }, (_, i) => `word${i}`).join(' ')

const CONTENTS: Record<string, string> = {
  '11-character/ari.md': `# Ari\n\nAri keeps the ledger. ${LONG_BODY}`,
  '11-character/brin.md': '# Brin\n\nBrin keeps the horses.',
  '01-worldview/rules.md': '# Rules\n\nTODO See [[Ari]] for the rank.',
  'external:m1/vault/ledger.md': '# Ledger\n\nThe debt is real.',
  'external:m1/chars/odin.md': '# Odin\n\nThe wolf hunts alone.',
}

const MAPPINGS: ExternalMapping[] = [
  { id: 'm1', name: 'Vault', rootPath: 'D:/vault', category: '99-misc', addedAt: 1 },
]

const externalLedger: SettingDoc = {
  id: 'external:m1/vault/ledger.md',
  title: 'Ledger',
  category: '99-misc',
  updatedAt: 1,
  external: { mappingId: 'm1', relPath: 'vault/ledger.md' },
}

const externalOdin: SettingDoc = {
  id: 'external:m1/chars/odin.md',
  title: 'Odin',
  category: '11-character',
  updatedAt: 1,
  external: { mappingId: 'm1', relPath: 'chars/odin.md' },
}

const CODEX_DOCS: SettingDoc[] = [
  { id: '11-character/ari.md', title: 'Ari', category: '11-character', updatedAt: 1 },
  { id: '01-worldview/rules.md', title: 'Rules', category: '01-worldview', updatedAt: 1 },
  externalLedger,
]

const CHARACTER_DOCS: SettingDoc[] = [
  {
    id: '11-character/ari.md',
    title: 'Ari',
    category: '11-character',
    updatedAt: new Date(2026, 0, 2, 3, 4).getTime(),
  },
  {
    id: '11-character/brin.md',
    title: 'Brin',
    category: '11-character',
    updatedAt: new Date(2026, 5, 7, 8, 9).getTime(),
  },
  { id: '01-worldview/rules.md', title: 'Rules', category: '01-worldview', updatedAt: 1 },
]

// The settings list the mocked RPC serves; tests may replace it to simulate a
// create or a delete landing on disk.
let docs: SettingDoc[] = []

beforeEach(() => {
  vi.clearAllMocks()
  docs = []
  ;(globalThis as unknown as { window: Window }).window.api = api as never
  api.listSettings.mockImplementation(async () => docs)
  api.readSetting.mockImplementation(async (id: string) => ({
    ...(docs.find((d) => d.id === id) ?? {
      id,
      title: id,
      category: '99-misc' as SettingCategory,
      updatedAt: 1,
    }),
    content: CONTENTS[id] ?? '',
  }))
  api.writeSetting.mockResolvedValue(undefined)
  api.deleteSetting.mockResolvedValue(undefined)
  api.listExternalMappings.mockResolvedValue(MAPPINGS)
})

afterEach(() => {
  cleanup()
})

/** The footer readout the Codex computes for a given roster. */
function statsLine(list: SettingDoc[]): string {
  const total = list.reduce((sum, doc) => sum + wordCount(CONTENTS[doc.id] ?? ''), 0)
  return `${list.length} docs, ${(total / 1000).toFixed(1)}k words`
}

/** Give the singleton store the roster a view reads through its selector. */
async function seed(list: SettingDoc[]): Promise<void> {
  docs = [...list]
  const { useStore } = await import('../../src/renderer/src/store')
  useStore.setState({
    config,
    settingDocs: docs,
    worlds: [],
    currentWorldId: 'w1',
    exemplars: { version: 1, texts: [] },
    voiceProfile: null,
    settingFocusId: null,
  } as never)
}

async function mountCodex(list: SettingDoc[] = CODEX_DOCS): Promise<void> {
  await seed(list)
  const mod = await import('../../src/renderer/src/views/SettingsDocs')
  render(<mod.default />)
  // The total only becomes correct once every document has been read, so
  // waiting for it also settles the background read loop.
  await screen.findByText(statsLine(list))
}

async function mountCharacters(list: SettingDoc[] = CHARACTER_DOCS): Promise<void> {
  await seed(list)
  const mod = await import('../../src/renderer/src/views/Characters')
  render(<mod.default />)
  await screen.findByText('Characters')
}

/** Type into the open document through CodeMirror's own API, as a user would. */
async function typeInto(insert: string): Promise<void> {
  fireEvent.click(screen.getByTitle('Edit mode: Markdown source'))
  await waitFor(() => expect(document.querySelector('.cm-content')).toBeTruthy())
  const dom = document.querySelector('.cm-content')
  if (!dom) throw new Error('the editor did not render')
  const view = EditorView.findFromDOM(dom as HTMLElement)
  if (!view) throw new Error('the editor has no CodeMirror view attached')
  await act(async () => {
    view.dispatch({ changes: { from: view.state.doc.length, insert } })
  })
}

/** True once the roster marks `title` as the document that is open. */
function rowIsActive(title: string): boolean {
  return screen
    .getAllByText(title)
    .some((el) => el.closest('[role="button"]')?.getAttribute('aria-current') === 'page')
}

/**
 * The list sidebar. Document titles also appear in the editor header and in a
 * rendered body (a [[wikilink]] previews as the same text), so roster clicks are
 * scoped to the sidebar rather than the whole document.
 */
function roster(heading: string): HTMLElement {
  return screen.getByText(heading).closest('aside') as HTMLElement
}

describe('the codex', () => {
  it('groups the documents by category and derives the stats from their text', async () => {
    await mountCodex()

    // The footer total is computed from what was read off disk per document.
    expect(screen.getByText(statsLine(CODEX_DOCS))).toBeTruthy()
    for (const doc of CODEX_DOCS) {
      expect(api.readSetting).toHaveBeenCalledWith(doc.id)
    }
    expect(screen.getByText(CATEGORY_LABELS['01-worldview']).nextSibling).toHaveTextContent('1')
    expect(screen.getByText(CATEGORY_LABELS['11-character']).nextSibling).toHaveTextContent('1')

    fireEvent.click(screen.getByRole('button', { name: /codex stats/i }))

    // Rules is placeholder-only and Ledger's body is four words; Ari's
    // 500-word body is not flagged, so the list is per-document, not an average.
    expect(await screen.findByText('Under-developed docs')).toBeTruthy()
    expect(await screen.findByText('placeholder')).toBeTruthy()
    expect(screen.getByText('4w')).toBeTruthy()
  })

  it('opens a document and saves the edited text back to its own file', async () => {
    await mountCodex()
    expect(screen.getByText('No document open')).toBeTruthy()

    fireEvent.click(within(roster('Codex')).getByText('Rules'))
    // The wikilink in the body renders as an inline anchor, so the paragraph's
    // own text nodes are matched rather than one exact string.
    await screen.findByText(/TODO See/)
    await typeInto(' More.')
    expect(await screen.findByText('● Unsaved')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(api.writeSetting).toHaveBeenCalledWith(
        '01-worldview/rules.md',
        '# Rules\n\nTODO See [[Ari]] for the rank. More.',
      ),
    )
    // The list is re-read from disk instead of trusting the in-memory copy.
    expect(api.listSettings).toHaveBeenCalled()
  })

  it('flushes an unsaved document when the author opens another one', async () => {
    await mountCodex()

    fireEvent.click(within(roster('Codex')).getByText('Rules'))
    await screen.findByText(/TODO See/)
    await typeInto(' More.')
    await screen.findByText('● Unsaved')

    // No Save click: switching away must not silently drop the buffer.
    fireEvent.click(within(roster('Codex')).getByText('Ari'))
    await waitFor(() =>
      expect(api.writeSetting).toHaveBeenCalledWith(
        '01-worldview/rules.md',
        '# Rules\n\nTODO See [[Ari]] for the rank. More.',
      ),
    )
    await waitFor(() => expect(rowIsActive('Ari')).toBe(true))
  })

  it('lists the documents referencing the open one and follows a backlink', async () => {
    await mountCodex()

    fireEvent.click(within(roster('Codex')).getByText('Ari'))
    await waitFor(() => expect(screen.queryByText('No document open')).toBeNull())

    // Rules mentions [[Ari]]; the scan finds it by reading the other documents.
    const header = await screen.findByText('Referenced by (1)')
    const panel = header.parentElement as HTMLElement
    fireEvent.click(within(panel).getByRole('button', { name: 'Rules' }))

    await waitFor(() => expect(rowIsActive('Rules')).toBe(true))
  })

  it('starts empty and creates a fallback-titled document when no title was typed', async () => {
    await mountCodex([])

    expect(
      screen.getByText('No codex documents yet. Click + in the top right to create one.'),
    ).toBeTruthy()
    expect(screen.getByText('No document open')).toBeTruthy()

    api.createSetting.mockImplementation(async (category: string, title: string) => {
      const created: SettingDoc = {
        id: '99-misc/untitled.md',
        title,
        category: category as SettingCategory,
        updatedAt: 2,
      }
      docs = [...docs, created]
      return created
    })

    fireEvent.click(screen.getByTitle('New document'))
    fireEvent.keyDown(screen.getByPlaceholderText(/Document title/), { key: 'Enter' })

    await waitFor(() => expect(api.createSetting).toHaveBeenCalledWith('99-misc', 'Untitled'))
    // The refreshed roster is what makes the new document visible and openable.
    await waitFor(() => expect(screen.queryByText('No document open')).toBeNull())
    expect(screen.getAllByText('Untitled').length).toBeGreaterThan(0)
    expect(api.listSettings).toHaveBeenCalled()
  })

  it('shows an external document read-only and copies it into the world', async () => {
    await mountCodex([externalLedger])

    fireEvent.click(within(roster('Codex')).getByText('Ledger'))
    await waitFor(() => expect(screen.queryByText('No document open')).toBeNull())

    // A mapped file belongs to someone else's folder: no write path is offered.
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.queryAllByTitle('Delete this document')).toHaveLength(0)
    await waitFor(() =>
      expect(screen.getByText(/Read-only/)).toHaveTextContent('Read-only · Vault'),
    )

    api.createSetting.mockResolvedValue({
      id: '99-misc/Ledger.md',
      title: 'Ledger',
      category: '99-misc',
      updatedAt: 2,
    })
    fireEvent.click(screen.getByRole('button', { name: /copy into world/i }))
    fireEvent.click(screen.getByRole('button', { name: /^copy$/i }))

    // The copy re-reads the external file and writes that text to the new doc.
    await waitFor(() =>
      expect(api.writeSetting).toHaveBeenCalledWith(
        '99-misc/Ledger.md',
        CONTENTS[externalLedger.id],
      ),
    )
    expect(api.createSetting).toHaveBeenCalledWith('99-misc', 'Ledger')
  })

  it('deletes a document only after the confirmation', async () => {
    await mountCodex()

    const confirmMock = vi.fn(() => false)
    ;(window as unknown as { confirm: (message?: string) => boolean }).confirm = confirmMock

    // Categories are rendered in codex order, so the row is addressed by name
    // rather than by the position of its delete button.
    const row = within(roster('Codex')).getByText('Rules').closest('[role="button"]') as HTMLElement
    fireEvent.click(within(row).getByTitle('Delete this document'))
    await waitFor(() => expect(confirmMock).toHaveBeenCalled())
    expect(api.deleteSetting).not.toHaveBeenCalled()

    confirmMock.mockReturnValue(true)
    fireEvent.click(within(row).getByTitle('Delete this document'))
    await waitFor(() => expect(api.deleteSetting).toHaveBeenCalledWith('01-worldview/rules.md'))
  })
})

describe('the character roster', () => {
  it('lists only the world characters with their last update', async () => {
    await mountCharacters()

    expect(screen.getByText('Ari')).toBeTruthy()
    expect(screen.getByText('Brin')).toBeTruthy()
    expect(screen.getByText('2026-01-02 03:04')).toBeTruthy()
    expect(screen.getByText('2026-06-07 08:09')).toBeTruthy()
    // A worldview document is not a character and stays out of the roster.
    expect(screen.queryByText('Rules')).toBeNull()
  })

  it('filters the roster by name and says when nothing matches', async () => {
    await mountCharacters()

    const search = screen.getByPlaceholderText(/Search characters/)
    fireEvent.change(search, { target: { value: 'ari' } })
    expect(screen.getByText('Ari')).toBeTruthy()
    expect(screen.queryByText('Brin')).toBeNull()

    fireEvent.change(search, { target: { value: 'nobody' } })
    expect(screen.getByText('No characters match your search.')).toBeTruthy()
    expect(screen.queryByText('Ari')).toBeNull()
  })

  it('says there are no characters when the world has none', async () => {
    await mountCharacters([
      { id: '01-worldview/rules.md', title: 'Rules', category: '01-worldview', updatedAt: 1 },
    ])

    expect(
      screen.getByText('No characters yet. Click + in the top right to create one.'),
    ).toBeTruthy()
    expect(screen.getByText('No character open')).toBeTruthy()
  })

  it('creates a trimmed character in the character category and opens it', async () => {
    await mountCharacters([])

    api.createSetting.mockImplementation(async (category: string, title: string) => {
      const created: SettingDoc = {
        id: '11-character/mira.md',
        title,
        category: category as SettingCategory,
        updatedAt: 2,
      }
      docs = [...docs, created]
      return created
    })

    fireEvent.click(screen.getByTitle('New character'))
    fireEvent.change(screen.getByPlaceholderText(/Character name/), {
      target: { value: '  Mira  ' },
    })
    fireEvent.keyDown(screen.getByPlaceholderText(/Character name/), { key: 'Enter' })

    // The roster is one entity per file under the character category, and the
    // typed name is trimmed before it becomes the file's title.
    await waitFor(() => expect(api.createSetting).toHaveBeenCalledWith('11-character', 'Mira'))
    await waitFor(() => expect(screen.queryByText('No character open')).toBeNull())
    expect(screen.getAllByText('Mira').length).toBeGreaterThan(0)
    expect(api.listSettings).toHaveBeenCalled()
  })

  it('saves the edited character back to its own file', async () => {
    await mountCharacters()

    fireEvent.click(within(roster('Characters')).getByText('Ari'))
    await screen.findByText(/Ari keeps the ledger/)
    await typeInto(' She pays it.')
    expect(await screen.findByText('● Unsaved')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(api.writeSetting).toHaveBeenCalledWith(
        '11-character/ari.md',
        `${CONTENTS['11-character/ari.md']} She pays it.`,
      ),
    )
    expect(api.listSettings).toHaveBeenCalled()
  })

  it('flushes the open character before switching to another one', async () => {
    await mountCharacters()

    fireEvent.click(within(roster('Characters')).getByText('Ari'))
    await screen.findByText(/Ari keeps the ledger/)
    await typeInto(' She pays it.')
    await screen.findByText('● Unsaved')

    fireEvent.click(within(roster('Characters')).getByText('Brin'))
    await waitFor(() =>
      expect(api.writeSetting).toHaveBeenCalledWith(
        '11-character/ari.md',
        `${CONTENTS['11-character/ari.md']} She pays it.`,
      ),
    )
    await waitFor(() => expect(rowIsActive('Brin')).toBe(true))
  })

  it('treats a mapped external character as read-only', async () => {
    await mountCharacters([externalOdin])

    fireEvent.click(within(roster('Characters')).getByText('Odin'))
    await waitFor(() => expect(screen.queryByText('No character open')).toBeNull())

    expect(screen.getByText('Read-only · external folder')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'AI Assist' })).toBeNull()
    // No delete action may be offered for a file the app must not write.
    expect(screen.queryByTitle('Delete this character')).toBeNull()
  })
})
