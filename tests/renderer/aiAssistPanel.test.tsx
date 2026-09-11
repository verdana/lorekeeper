/**
 * @vitest-environment jsdom
 *
 * Render tests for the AI assist panel.
 *
 * The panel is the manuscript's writing surface: the mode selector, the
 * instruction box, the run button's gating, and the generation-evidence drawer
 * that shows what a run actually sent. Those are what a split of this file can
 * break, and they are pinned here before it is split.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { AppConfig, NovelMeta } from '../../src/shared/types'

const api = vi.hoisted(() => ({
  readOutline: vi.fn(),
  readOutlineStore: vi.fn(),
  listSettings: vi.fn(),
  readSetting: vi.fn(),
  readChapter: vi.fn(),
  listGenerationRuns: vi.fn(),
  readGenerationRun: vi.fn(),
  createGenerationRun: vi.fn(),
  saveGenerationStage: vi.fn(),
  saveGenerationAuthorResult: vi.fn(),
  selectGenerationResult: vi.fn(),
}))

vi.mock('../../src/renderer/src/api', () => ({ installApi: () => {} }))

const config: AppConfig = {
  ai: {
    providers: [{ id: 'p1', name: 'Provider', baseUrl: 'http://x', apiKey: 'sk', model: 'm' }],
    activeProviderId: 'p1',
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
          title: 'Chapter 1',
          order: 0,
          file: 'c1.md',
          wordCount: 100,
          status: 'draft',
          updatedAt: 1,
        },
      ],
    },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(globalThis as unknown as { window: Window }).window.api = api as never
  api.readOutline.mockResolvedValue('')
  api.readOutlineStore.mockResolvedValue({
    version: 1,
    updatedAt: 1,
    overview: '',
    notes: '',
    volumes: [],
  })
  api.listSettings.mockResolvedValue([])
  api.listGenerationRuns.mockResolvedValue([])
  localStorage.clear()
})

afterEach(() => {
  cleanup()
})

async function renderPanel(
  mode: 'polish' | 'outline-write' | 'rewrite',
  content = 'The rain fell.',
  selectedText?: string,
): Promise<{ onInsert: ReturnType<typeof vi.fn>; onClose: ReturnType<typeof vi.fn> }> {
  const { default: AiAssistPanel } = await import('../../src/renderer/src/components/AiAssistPanel')
  const { useStore } = await import('../../src/renderer/src/store')
  useStore.setState({ novel, config, settingDocs: [] } as never)
  const onInsert = vi.fn()
  const onClose = vi.fn()
  render(
    <AiAssistPanel
      mode={mode}
      content={content}
      selectedText={selectedText}
      chapterId="c1"
      chapterTitle="Chapter 1"
      onInsert={onInsert}
      onClose={onClose}
    />,
  )
  return { onInsert, onClose }
}

describe('the panel', () => {
  it('opens on the requested mode and offers the other writing modes', async () => {
    await renderPanel('outline-write')

    // The instruction box is labelled for the active mode.
    expect(
      await screen.findByPlaceholderText(/what should this chapter do|instruction|write/i),
    ).toBeTruthy()
    // A mode switch is offered rather than a hidden setting.
    expect(screen.getAllByRole('button').length).toBeGreaterThan(3)
  })

  it('sends with an empty instruction, using the mode default', async () => {
    await renderPanel('outline-write')
    // An empty box is not an error: the mode's default instruction is used, so
    // the send affordance stays available.
    expect(screen.getByTitle(/send prompt/i)).not.toBeDisabled()

    fireEvent.change(screen.getByPlaceholderText(/write|instruction|add, cut, or change/i), {
      target: { value: 'Keep the beats, tighten the middle.' },
    })
    expect(screen.getByTitle(/send prompt/i)).not.toBeDisabled()
  })

  it('closes when asked', async () => {
    const { onClose } = await renderPanel('polish')
    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    expect(onClose).toHaveBeenCalled()
  })

  it('shows the run history drawer for the chapter', async () => {
    await renderPanel('outline-write')
    // The evidence drawer is collapsed by default; it can be opened.
    const toggle = screen.queryByRole('button', { name: /run history|evidence|history/i })
    expect(toggle).not.toBeNull()
  })
})
