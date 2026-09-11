/**
 * @vitest-environment jsdom
 *
 * Render tests for the world gate — the first screen, and the only place a
 * novel begins.
 *
 * Every entry mode ends the same way: a world is created, entered, and the
 * writer lands in the app. The theme mode is the one the product is built
 * around (a theme becomes a world and hands off to the Forge), so it is pinned
 * here, together with the guards on the actions: nothing is created from an
 * empty premise, and importing a manuscript keeps the prose verbatim as
 * chapters while the same text is used to reverse-derive the codex.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AppConfig, NovelMeta, WorldMeta } from '../../src/shared/types'

const api = vi.hoisted(() => ({
  listWorlds: vi.fn(),
  switchWorld: vi.fn(),
  generateWorld: vi.fn(),
  createWorldWithData: vi.fn(),
  createBlankWorld: vi.fn(),
  updateWorldMeta: vi.fn(),
  deleteWorld: vi.fn(),
  getNovelMeta: vi.fn(),
  getConfig: vi.fn(),
  listSettings: vi.fn(),
  readVoiceProfile: vi.fn(),
  readExemplars: vi.fn(),
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
  title: 'Untitled World',
  author: '',
  synopsis: '',
  tags: [],
  volumes: [],
}

const world = (over: Partial<WorldMeta> & Pick<WorldMeta, 'id' | 'title'>): WorldMeta => ({
  genre: '',
  coverColor: '#B8642E',
  createdAt: 1,
  lastOpenedAt: 1,
  ...over,
})

const ash = world({ id: 'w1', title: 'The Ash Ledger', genre: 'Fantasy' })

beforeEach(() => {
  vi.clearAllMocks()
  ;(globalThis as unknown as { window: Window }).window.api = api as never
  api.listWorlds.mockResolvedValue([])
  api.switchWorld.mockResolvedValue(undefined)
  api.getNovelMeta.mockResolvedValue(novel)
  api.getConfig.mockResolvedValue(config)
  api.listSettings.mockResolvedValue([])
  api.readVoiceProfile.mockResolvedValue(null)
  api.readExemplars.mockResolvedValue({ version: 1, texts: [] })
  api.createBlankWorld.mockImplementation(async (title: string) => world({ id: 'new', title }))
  api.deleteWorld.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

async function mount(worlds: WorldMeta[] = []): Promise<void> {
  api.listWorlds.mockResolvedValue(worlds)
  const { useStore } = await import('../../src/renderer/src/store')
  useStore.setState({
    worlds,
    novel: null,
    config,
    settingDocs: [],
    currentWorldId: null,
    switching: false,
    atWorldGate: true,
  } as never)
  const mod = await import('../../src/renderer/src/views/WorldGate')
  render(<mod.default />)
  await screen.findByText('Choose how to begin a new world')
}

const premise = 'magic is dying because the gods who granted it are being murdered'

describe('the world gate', () => {
  it('offers the theme entry first and creates a world from it', async () => {
    await mount()

    // The theme card is the featured entry, not just another mode.
    const theme = screen.getByRole('button', { name: /from a theme/i })
    expect(theme).toHaveTextContent('New')
    fireEvent.click(theme)

    const start = screen.getByRole('button', { name: /forge a novel/i })
    // Nothing to forge yet.
    expect(start).toBeDisabled()

    fireEvent.change(screen.getByPlaceholderText(/A story about/), { target: { value: premise } })
    expect(start).toBeEnabled()
    fireEvent.click(start)

    await waitFor(() => expect(api.createBlankWorld).toHaveBeenCalled())
    // The world is named after the premise (capped at 60 characters), so the
    // gate never stops to ask for a title.
    expect(api.createBlankWorld.mock.calls.at(-1)![0]).toBe(premise.slice(0, 60))
    await waitFor(() => expect(api.switchWorld).toHaveBeenCalledWith('new'))

    const { useStore } = await import('../../src/renderer/src/store')
    await waitFor(() => expect(useStore.getState().currentWorldId).toBe('new'))
    // The Forge opens with the theme already filled in.
    expect(useStore.getState().view).toBe('forge')
    expect(useStore.getState().forgeThemeDraft).toBe(premise)
  })

  it('generates a world from a one-line prompt', async () => {
    await mount()
    api.generateWorld.mockResolvedValue({
      title: 'Steam & Ash',
      genre: 'Steampunk',
      chapters: [],
    })
    api.createWorldWithData.mockResolvedValue(world({ id: 'gen', title: 'Steam & Ash' }))

    fireEvent.change(screen.getByPlaceholderText(/Describe your world in a sentence/), {
      target: { value: 'a steampunk world where magic is dying' },
    })
    fireEvent.click(screen.getByRole('button', { name: /generate world/i }))

    await waitFor(() => expect(api.generateWorld).toHaveBeenCalled())
    expect(api.generateWorld.mock.calls.at(-1)![0]).toEqual({
      prompt: 'a steampunk world where magic is dying',
    })
    const [, data] = api.createWorldWithData.mock.calls.at(-1)!
    expect(data.title).toBe('Steam & Ash')
    await waitFor(() => expect(api.switchWorld).toHaveBeenCalledWith('gen'))
  })

  it('imports a manuscript verbatim and distils the codex from the same text', async () => {
    await mount()
    api.generateWorld.mockResolvedValue({ title: 'Imported', genre: '', chapters: [] })
    api.createWorldWithData.mockResolvedValue(world({ id: 'imp', title: 'Imported' }))

    fireEvent.click(screen.getByRole('button', { name: /import manuscript/i }))
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['# One\n\nThe rain fell.'], 'chapter-one.md', { type: 'text/markdown' })
    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() => expect(api.createWorldWithData).toHaveBeenCalled())
    const [, data] = api.createWorldWithData.mock.calls.at(-1)!
    // The prose is kept verbatim under the file's own name.
    expect(data.chapters).toEqual([{ title: 'chapter-one', content: '# One\n\nThe rain fell.' }])
    // The same prose is what the AI reverse-derives the codex from.
    expect(api.generateWorld.mock.calls.at(-1)![0].seedText).toContain('# One')
    expect(api.generateWorld.mock.calls.at(-1)![0].seedText).toContain('The rain fell.')
  })

  it('creates a blank world on demand', async () => {
    await mount()

    fireEvent.click(screen.getByRole('button', { name: /^blank/i }))
    fireEvent.click(screen.getByRole('button', { name: /create blank world/i }))

    await waitFor(() => expect(api.createBlankWorld).toHaveBeenCalled())
    expect(api.createBlankWorld.mock.calls.at(-1)![0]).toBe('Untitled World')
  })

  it('lists existing worlds, opens one, renames it and deletes it', async () => {
    await mount([ash])

    expect(screen.getByText('The Ash Ledger')).toBeTruthy()
    expect(screen.getByText('Fantasy')).toBeTruthy()

    // Renaming writes the metadata back and re-reads the list.
    fireEvent.click(screen.getByTitle('Edit world'))
    const title = screen.getByDisplayValue('The Ash Ledger')
    fireEvent.change(title, { target: { value: 'The Ledger' } })
    api.updateWorldMeta.mockResolvedValue(world({ id: 'w1', title: 'The Ledger' }))
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() =>
      expect(api.updateWorldMeta).toHaveBeenCalledWith('w1', {
        title: 'The Ledger',
        genre: 'Fantasy',
        coverColor: '#B8642E',
      }),
    )

    // Deleting asks first, and a refused confirmation deletes nothing.
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    fireEvent.click(screen.getByTitle('Delete world'))
    expect(api.deleteWorld).not.toHaveBeenCalled()
    confirmSpy.mockReturnValue(true)
    fireEvent.click(screen.getByTitle('Delete world'))
    await waitFor(() => expect(api.deleteWorld).toHaveBeenCalledWith('w1'))

    // Opening a world is what leaves the gate.
    fireEvent.click(screen.getByText('The Ash Ledger'))
    await waitFor(() => expect(api.switchWorld).toHaveBeenCalledWith('w1'))
  })

  it('says so when there is nothing to open yet', async () => {
    await mount()

    expect(screen.getByText('No worlds yet — generate one to begin')).toBeTruthy()
  })
})
