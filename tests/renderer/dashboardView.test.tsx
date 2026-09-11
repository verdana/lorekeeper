/**
 * @vitest-environment jsdom
 *
 * Render tests for the Overview.
 *
 * The Overview is where a world's identity is set, and the genre chosen
 * here is injected into every AI writing prompt as the register anchor, so
 * it is not a cosmetic field: it has to reach `tags[0]` and the world's own
 * metadata, and it has to survive the save path. The style exemplars travel
 * with it, and the statistics are the writer's only progress readout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PROMPTS } from '../../src/shared/prompts'
import type { AppConfig, NovelMeta, SettingDoc, WorldMeta } from '../../src/shared/types'

const api = vi.hoisted(() => ({
  getProjectPath: vi.fn(),
  saveNovelMeta: vi.fn(),
  updateWorldMeta: vi.fn(),
  writeExemplars: vi.fn(),
  chat: vi.fn(),
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
  title: 'The Ash Ledger',
  author: 'V.',
  synopsis: 'A debt comes due.',
  tags: ['Western Fantasy', 'noir'],
  volumes: [
    {
      id: 'v1',
      title: 'Volume One',
      order: 0,
      chapters: [
        {
          id: 'c1',
          volumeId: 'v1',
          title: 'Chapter 1',
          order: 0,
          file: 'c1.md',
          wordCount: 2600,
          status: 'done',
          updatedAt: 1,
        },
        {
          id: 'c2',
          volumeId: 'v1',
          title: 'Chapter 2',
          order: 1,
          file: 'c2.md',
          wordCount: 1400,
          status: 'draft',
          updatedAt: 1,
        },
      ],
    },
  ],
}

const world: WorldMeta = {
  id: 'w1',
  title: 'The Ash Ledger',
  genre: 'Western Fantasy',
  coverColor: '#B8642E',
  createdAt: 1,
  lastOpenedAt: 1,
}

const docs: SettingDoc[] = [
  { id: 'character/ari.md', title: 'Ari', category: '11-character', updatedAt: 1 },
  { id: '01-worldview/rules.md', title: 'Rules', category: '01-worldview', updatedAt: 1 },
]

beforeEach(() => {
  vi.clearAllMocks()
  ;(globalThis as unknown as { window: Window }).window.api = api as never
  api.getProjectPath.mockResolvedValue('D:/data/worlds/w1')
  api.saveNovelMeta.mockResolvedValue(undefined)
  api.updateWorldMeta.mockResolvedValue(world)
  api.writeExemplars.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
})

async function mount(exemplars: string[] = []): Promise<void> {
  const { useStore } = await import('../../src/renderer/src/store')
  useStore.setState({
    novel,
    config,
    settingDocs: docs,
    worlds: [world],
    currentWorldId: 'w1',
    exemplars: { version: 1, texts: exemplars },
  } as never)
  const mod = await import('../../src/renderer/src/views/Dashboard')
  render(<mod.default />)
  await screen.findByText('Overview')
}

describe('the overview', () => {
  it('counts the world and shows where it lives', async () => {
    await mount()

    expect(screen.getByText('Volumes').previousSibling).toHaveTextContent('1')
    expect(screen.getByText('Chapters').previousSibling).toHaveTextContent('2')
    expect(screen.getByText('1 finalized')).toBeTruthy()
    expect(screen.getByText('Words').previousSibling).toHaveTextContent('4,000')
    // The codex overview counts documents per category.
    expect(screen.getByText('Characters').nextSibling).toHaveTextContent('1')
    expect(screen.getByText('Worldview & Cosmic Laws').nextSibling).toHaveTextContent('1')
    expect(await screen.findByText(/D:\/data\/worlds\/w1/)).toBeTruthy()
  })

  it('saves the genre as the prompt anchor alongside the rest of the metadata', async () => {
    await mount()

    // Nothing to save until something changes.
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()

    fireEvent.change(screen.getByDisplayValue('The Ash Ledger'), {
      target: { value: 'The Ledger' },
    })
    expect(screen.getByText('● Unsaved')).toBeTruthy()

    // Switching genre is what every later prompt reads for register. The preset
    // list comes from the active prompt pack, so it is read, not hardcoded.
    const preset = PROMPTS.assist.genreOptions[1]
    fireEvent.click(screen.getByLabelText(preset))
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(api.saveNovelMeta).toHaveBeenCalled())
    const [meta] = api.saveNovelMeta.mock.calls.at(-1)!
    expect(meta.title).toBe('The Ledger')
    expect(meta.tags).toEqual([preset, 'noir'])
    // The world's own genre is kept in step, so the gate and the overview agree.
    expect(api.updateWorldMeta).toHaveBeenCalledWith('w1', {
      title: 'The Ledger',
      genre: preset,
      coverColor: '#B8642E',
    })
  })

  it('stores the style exemplars, which are injected into the writing prompts', async () => {
    await mount(['A first passage.'])

    expect(screen.getByDisplayValue('A first passage.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /add exemplar/i }))

    const fields = screen.getAllByPlaceholderText(/Paste a passage of human-written fiction/)
    fireEvent.change(fields[1], { target: { value: '  A second passage.  ' } })

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(api.writeExemplars).toHaveBeenCalled())

    // Blank padding is trimmed before the exemplars are stored.
    expect(api.writeExemplars.mock.calls.at(-1)![0]).toEqual({
      version: 1,
      texts: ['A first passage.', 'A second passage.'],
    })
  })

  it('drops an exemplar the author removes', async () => {
    await mount(['Keep me.', 'Drop me.'])
    expect(screen.getByText('Exemplar 2')).toBeTruthy()

    fireEvent.click(screen.getAllByTitle('Remove exemplar')[1])
    expect(screen.queryByText('Exemplar 2')).toBeNull()
    expect(screen.queryByDisplayValue('Drop me.')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(api.writeExemplars).toHaveBeenCalled())
    expect(api.writeExemplars.mock.calls.at(-1)![0].texts).toEqual(['Keep me.'])
  })

  it('offers the export menu with all three formats', async () => {
    await mount()

    const exportButton = screen.getByRole('button', { name: /export/i })
    expect(exportButton).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(exportButton)

    expect(exportButton).toHaveAttribute('aria-expanded', 'true')
    const items = screen.getAllByRole('menuitem').map((i) => i.textContent?.trim())
    expect(items).toEqual(['Export book', 'Export wiki', 'Export epub'])
  })
})
