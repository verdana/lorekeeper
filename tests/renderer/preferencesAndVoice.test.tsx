/** @vitest-environment jsdom */
/**
 * Render tests for the Preferences view and the Voice Profile view.
 *
 * Preferences is the only place providers, personas and writing defaults are
 * edited, and nothing re-reads config.json after a save — a dropped field stays
 * invisible until the next launch. These tests therefore pin what the save
 * actually writes to the endpoint, not what the form looks like. The API key is
 * the one secret the form handles, so it is pinned as a password field that is
 * written to config but never echoed into page text.
 *
 * VoiceProfile is where the author's own prose voice is described; the profile
 * is injected into every writing prompt, so loading it back and saving it
 * through the endpoint are the behaviours that matter, manual voice and
 * AI analysis alike.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { PROMPTS } from '../../src/shared/prompts'
import { PROVIDER_PRESETS } from '../../src/shared/providers'
import {
  BUILTIN_OUTLINE_PROMPT,
  BUILTIN_REWRITE_PROMPT,
} from '../../src/renderer/src/components/AiAssistPanel'
import { useToastStore } from '../../src/renderer/src/toast'
import type {
  AgentPersona,
  AIProvider,
  AppConfig,
  Chapter,
  NovelMeta,
  VoiceProfile,
  VoiceTraits,
} from '../../src/shared/types'

const api = vi.hoisted(() => ({
  saveConfig: vi.fn(),
  chat: vi.fn(),
  readVoiceProfile: vi.fn(),
  writeVoiceProfile: vi.fn(),
  readChapter: vi.fn(),
}))

vi.mock('../../src/renderer/src/api', () => ({ installApi: () => {}, chatStream: vi.fn() }))

// ---- Fixtures ----

const provider = (over: Partial<AIProvider> & Pick<AIProvider, 'id' | 'name'>): AIProvider => ({
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  ...over,
})

const P1 = provider({
  id: 'p1',
  name: 'DeepSeek main',
  apiKey: 'sk-live-9f3c',
  model: 'deepseek-chat',
})
const P2 = provider({
  id: 'p2',
  name: 'Local Ollama',
  baseUrl: 'http://localhost:11434/v1',
  apiKey: 'ollama',
  model: 'qwen3.6',
  maxTokens: 4096,
})

function makeConfig(
  providers: AIProvider[] = [],
  activeProviderId: string | null = null,
): AppConfig {
  return {
    ai: { providers, activeProviderId },
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
}

const chapter = (over: Partial<Chapter> & Pick<Chapter, 'id' | 'title' | 'file'>): Chapter => ({
  volumeId: 'v1',
  order: 0,
  wordCount: 0,
  status: 'draft',
  updatedAt: 1,
  ...over,
})

const novelWithChapters: NovelMeta = {
  title: 'The Ash Ledger',
  author: 'V.',
  synopsis: '',
  tags: [],
  volumes: [
    {
      id: 'v1',
      title: 'Volume One',
      order: 0,
      chapters: [
        chapter({ id: 'c1', title: 'Chapter 1: Ash', file: 'c1.md', wordCount: 2600 }),
        chapter({ id: 'c2', title: 'Chapter 2: Ember', file: 'c2.md', order: 1, wordCount: 1400 }),
      ],
    },
  ],
}

const novelWithoutChapters: NovelMeta = { ...novelWithChapters, volumes: [] }

const CHAPTER_TEXT = '# Chapter 1: Ash\n\nThe rain fell for a week before the ledger surfaced.'

const TRAITS: VoiceTraits = {
  sentenceLength: 'short declarative sentences, 8-18 words',
  verbStyle: 'concrete action verbs, adverbs rare',
  narrativeDistance: 'third-person limited, close to the POV character',
  dialogueStyle: 'terse, heavy subtext',
  rhetoricalPatterns: 'restrained metaphor',
  proseNotes: 'keeps sensory detail concrete',
}

const MANUAL_VOICE = 'Third-person limited, short declarative sentences with an ironic undertone.'

/** Long enough to be accepted as a pasted prose sample (200 characters). */
const PASTED_PROSE =
  'The rain had not stopped for a week, and the gutters ran like small brown rivers past the ' +
  'archive door. She counted the coins twice, then a third time, because the number refused to ' +
  'settle in her head, and somewhere above her the bell tower struck an hour that did not exist ' +
  'on any clock she trusted.'

const CUSTOM_OUTLINE = '  Keep the paragraphs short and end every chapter on a question.  '

function profileWith(over: Partial<VoiceProfile> = {}): VoiceProfile {
  return {
    generatedAt: Date.UTC(2024, 0, 2),
    sampleChapterIds: ['c1', 'c2'],
    traits: { ...TRAITS },
    ...over,
  }
}

// ---- Harness ----

beforeEach(() => {
  vi.clearAllMocks()
  ;(globalThis as unknown as { window: Window }).window.api = api as never
  useToastStore.setState({ toasts: [] })
  api.saveConfig.mockResolvedValue(undefined)
  api.chat.mockResolvedValue('{}')
  api.readVoiceProfile.mockResolvedValue(null)
  api.writeVoiceProfile.mockResolvedValue(undefined)
  api.readChapter.mockResolvedValue(CHAPTER_TEXT)
})

afterEach(() => {
  cleanup()
})

async function mountPreferences(config: AppConfig): Promise<void> {
  const { useStore } = await import('../../src/renderer/src/store')
  useStore.setState({ config } as never)
  const mod = await import('../../src/renderer/src/views/Preferences')
  render(<mod.default />)
  await screen.findByText('AI Providers')
}

async function mountVoice(opts: {
  novel?: NovelMeta
  config?: AppConfig
  profile?: VoiceProfile | null
}): Promise<void> {
  const profile = opts.profile ?? null
  if (profile) api.readVoiceProfile.mockResolvedValue(profile)
  const { useStore } = await import('../../src/renderer/src/store')
  useStore.setState({
    novel: opts.novel ?? novelWithChapters,
    config: opts.config ?? makeConfig([P1], 'p1'),
    voiceProfile: profile,
  } as never)
  const mod = await import('../../src/renderer/src/views/VoiceProfile')
  render(<mod.default />)
  await screen.findByText('Voice Profile')
}

/** The manual-voice editor is the only CodeMirror instance on this view. */
function manualView(): EditorView {
  const dom = document.querySelector('.cm-content')
  if (!dom) throw new Error('the manual voice editor did not render')
  const view = EditorView.findFromDOM(dom as HTMLElement)
  if (!view) throw new Error('the manual voice editor has no CodeMirror view attached')
  return view
}

/** Type into the manual-voice editor through CodeMirror, as a user would. */
async function typeManualVoice(text: string): Promise<void> {
  const view = manualView()
  await act(async () => {
    view.dispatch({ changes: { from: view.state.doc.length, insert: text } })
  })
}

function manualEditorText(): string {
  try {
    return manualView().state.doc.toString()
  } catch {
    return ''
  }
}

/** The Current Profile card; the view's own help text repeats some of its words. */
function currentProfileSection(): HTMLElement {
  const section = screen.getByText('Current Profile').closest('section') as HTMLElement | null
  if (!section) throw new Error('the current profile section is not rendered')
  return section
}

// ---- Preferences ----

describe('preferences', () => {
  it('saves the edited providers and the chosen default through the config endpoint', async () => {
    await mountPreferences(makeConfig([P1, P2], 'p1'))

    fireEvent.change(screen.getAllByLabelText('Model')[0], {
      target: { value: 'deepseek-reasoner' },
    })
    // Moving the default matters: every prompt with no explicit provider uses it.
    fireEvent.click(screen.getAllByLabelText('Default')[1])

    fireEvent.click(screen.getByRole('button', { name: /save settings/i }))
    await waitFor(() => expect(api.saveConfig).toHaveBeenCalled())

    const [written] = api.saveConfig.mock.calls.at(-1)!
    expect(written.ai.activeProviderId).toBe('p2')
    expect(written.ai.providers).toHaveLength(2)
    expect(written.ai.providers[0]).toMatchObject({
      id: 'p1',
      model: 'deepseek-reasoner',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-live-9f3c',
    })
    expect(written.ai.providers[1]).toMatchObject({
      id: 'p2',
      name: 'Local Ollama',
      maxTokens: 4096,
    })
  })

  it('never echoes the stored API key as plain text but still persists a rotated one', async () => {
    await mountPreferences(makeConfig([P1], 'p1'))

    const keyField = screen.getByLabelText('API Key')
    expect(keyField).toHaveAttribute('type', 'password')
    expect(keyField).toHaveValue('sk-live-9f3c')
    // The secret lives in an input value only — it is never rendered as page text.
    expect(screen.queryByText('sk-live-9f3c')).toBeNull()

    fireEvent.change(keyField, { target: { value: 'sk-rotated-0001' } })
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }))
    await waitFor(() => expect(api.saveConfig).toHaveBeenCalled())
    expect(api.saveConfig.mock.calls.at(-1)![0].ai.providers[0].apiKey).toBe('sk-rotated-0001')
  })

  it('persists a provider added from the preset menu and one removed with the default', async () => {
    await mountPreferences(makeConfig([P1, P2], 'p1'))
    const preset = PROVIDER_PRESETS[0]

    fireEvent.click(screen.getByRole('button', { name: /^add$/i }))
    fireEvent.click(screen.getByRole('button', { name: preset.label }))
    expect(screen.getAllByLabelText('Model')).toHaveLength(3)
    // The preset fills the new card with its own base URL and model.
    expect(screen.getByDisplayValue(preset.baseUrl)).toBeTruthy()

    // Removing the current default must hand the default to the next provider.
    fireEvent.click(screen.getAllByTitle('Remove this provider')[0])
    expect(screen.queryByDisplayValue(P1.name)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /save settings/i }))
    await waitFor(() => expect(api.saveConfig).toHaveBeenCalled())

    const [written] = api.saveConfig.mock.calls.at(-1)!
    expect(written.ai.providers).toHaveLength(2)
    expect(written.ai.providers[0].id).toBe('p2')
    expect(written.ai.providers[1]).toMatchObject({
      name: preset.name,
      baseUrl: preset.baseUrl,
      model: preset.model,
      apiKey: '',
    })
    expect(written.ai.activeProviderId).toBe('p2')
  })

  it('stores an added persona and drops a removed one', async () => {
    const existing: AgentPersona = {
      id: 'a1',
      name: 'Harsh Editor',
      role: 'Cuts what does not earn its place',
      systemPrompt: 'You are a ruthless line editor.',
      color: '#B8642E',
    }
    await mountPreferences({ ...makeConfig([P1], 'p1'), personas: [existing] })

    fireEvent.click(screen.getByRole('button', { name: 'Personas' }))
    expect(screen.getByDisplayValue('Harsh Editor')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /add persona/i }))
    fireEvent.change(screen.getByDisplayValue('New persona'), {
      target: { value: 'Continuity Keeper' },
    })
    fireEvent.change(screen.getByDisplayValue('Role description'), {
      target: { value: 'Tracks every open thread' },
    })

    fireEvent.click(screen.getAllByTitle('Remove this persona')[0])
    expect(screen.queryByDisplayValue('Harsh Editor')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /save settings/i }))
    await waitFor(() => expect(api.saveConfig).toHaveBeenCalled())

    const [written] = api.saveConfig.mock.calls.at(-1)!
    expect(written.personas).toHaveLength(1)
    expect(written.personas[0]).toMatchObject({
      name: 'Continuity Keeper',
      role: 'Tracks every open thread',
      // The palette advances with the persona count.
      color: '#6B8E4E',
    })
    expect(written.personas[0].id).toMatch(/^a_/)
  })

  it('saves the writing defaults verbatim and keeps the built-in prompts out of the file', async () => {
    await mountPreferences(makeConfig([P1], 'p1'))

    fireEvent.click(screen.getByRole('button', { name: 'Writing' }))
    const textareas = screen.getAllByRole('textbox')
    expect(textareas).toHaveLength(2)
    // An empty stored prompt materialises the built-in text so it stays editable.
    expect(textareas[0]).toHaveValue(BUILTIN_OUTLINE_PROMPT)
    expect(textareas[1]).toHaveValue(BUILTIN_REWRITE_PROMPT)
    expect(screen.getAllByText('(built-in)')).toHaveLength(2)

    fireEvent.change(textareas[0], { target: { value: CUSTOM_OUTLINE } })
    expect(screen.getByText('(custom)')).toBeTruthy()

    // Reset puts the built-in text back before anything is written.
    fireEvent.click(screen.getByTitle('Reset to default'))
    expect(screen.getAllByRole('textbox')[0]).toHaveValue(BUILTIN_OUTLINE_PROMPT)
    expect(screen.queryByText('(custom)')).toBeNull()

    fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value: CUSTOM_OUTLINE } })
    fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '1.2' } })

    fireEvent.click(screen.getByRole('button', { name: /save settings/i }))
    await waitFor(() => expect(api.saveConfig).toHaveBeenCalled())

    const { writing } = api.saveConfig.mock.calls.at(-1)![0]
    expect(writing.outlineSystemPrompt).toBe(CUSTOM_OUTLINE)
    // An untouched built-in prompt is stored as an empty string, so the runtime
    // falls back to the current prompt pack instead of a frozen copy.
    expect(writing.rewriteSystemPrompt).toBe('')
    expect(writing.temperature).toBe(1.2)
    expect(writing.topP).toBe(0.9)
  })

  it('surfaces a failed connection test without dropping the edited provider', async () => {
    await mountPreferences(makeConfig([P1], 'p1'))
    fireEvent.change(screen.getByDisplayValue(P1.name), { target: { value: 'Renamed provider' } })

    api.chat.mockRejectedValue(
      new Error('AI request failed (401): {"error":{"message":"Invalid API key"}}'),
    )
    fireEvent.click(screen.getByRole('button', { name: /test connection/i }))

    await waitFor(() => expect(api.chat).toHaveBeenCalled())
    expect(api.chat.mock.calls.at(-1)![1]).toBe('p1')
    // The probe persists the form first, so the edit survives the failure.
    expect(api.saveConfig.mock.calls.at(-1)![0].ai.providers[0].name).toBe('Renamed provider')

    await waitFor(() =>
      expect(
        useToastStore.getState().toasts.some((t) => t.message.includes('Invalid API key')),
      ).toBe(true),
    )
    expect(screen.getByDisplayValue('Renamed provider')).toBeTruthy()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /test connection/i })).toBeEnabled(),
    )
  })

  it('shows an unconfigured install as empty and falls back to the default model', async () => {
    await mountPreferences(makeConfig([], null))

    expect(screen.getByText(/Works with any OpenAI-compatible API/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /test connection/i })).toBeNull()
    expect(screen.queryByTitle('Remove this provider')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Writing' }))
    const options = within(screen.getByRole('combobox')).getAllByRole('option')
    expect(options).toHaveLength(1)
    expect(options[0]).toHaveTextContent('(use default provider)')

    fireEvent.click(screen.getByRole('button', { name: 'Personas' }))
    expect(screen.getByRole('button', { name: /add persona/i })).toBeTruthy()
    expect(screen.queryByTitle('Remove this persona')).toBeNull()
  })
})

// ---- Voice profile ----

describe('the voice profile', () => {
  it('starts from an empty state instead of inventing a profile', async () => {
    await mountVoice({ profile: null })

    expect(api.readVoiceProfile).toHaveBeenCalled()
    expect(screen.getByText(/No voice profile yet/)).toBeTruthy()
    expect(screen.queryByText('Current Profile')).toBeNull()
    expect(screen.getByRole('button', { name: /Chapter 1: Ash/ })).toBeTruthy()
    // Nothing can be analysed until samples are chosen or pasted.
    expect(screen.getByRole('button', { name: /analyse voice/i })).toBeDisabled()
  })

  it('loads the stored profile through the endpoint and renders its traits', async () => {
    await mountVoice({ profile: profileWith() })

    expect(api.readVoiceProfile).toHaveBeenCalled()
    expect(await screen.findByText('Current Profile')).toBeTruthy()
    expect(screen.getByText(/short declarative sentences, 8-18 words/)).toBeTruthy()
    expect(screen.getByText(/concrete action verbs, adverbs rare/)).toBeTruthy()
    // Blank optional traits render as a dash rather than as "undefined".
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
    expect(screen.getByText(/Generated/).textContent).toContain('from 2 chapters')
    expect(screen.queryByText(/No voice profile yet/)).toBeNull()
  })

  it('shows a stored manual voice in place of the analysis and clears it through the endpoint', async () => {
    await mountVoice({ profile: profileWith({ manualText: MANUAL_VOICE }) })

    expect(await screen.findByText('Current Profile')).toBeTruthy()
    expect(within(currentProfileSection()).getByText(/overrides the analysed profile/)).toBeTruthy()
    // The Current Profile card renders the author's words, not the trait table.
    const rendered = document.querySelector('.markdown-body')
    expect(rendered?.textContent).toContain('short declarative sentences with an ironic undertone')
    expect(within(currentProfileSection()).queryByText(/Sentence length:/)).toBeNull()
    // The stored text is loaded into the editable box as it was saved.
    expect(manualEditorText()).toBe(MANUAL_VOICE)
    expect(screen.getByRole('button', { name: /update voice/i })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /clear & restore analysis/i }))
    await waitFor(() => expect(api.writeVoiceProfile).toHaveBeenCalled())

    const [written] = api.writeVoiceProfile.mock.calls.at(-1)!
    expect(written.manualText).toBeUndefined()
    // The analysed traits stay underneath, so clearing restores them.
    expect(written.traits).toEqual(TRAITS)
    expect(written.sampleChapterIds).toEqual(['c1', 'c2'])

    expect(await within(currentProfileSection()).findByText(/Sentence length:/)).toBeTruthy()
    expect(within(currentProfileSection()).queryByText(/overrides the analysed profile/)).toBeNull()
    expect(manualEditorText()).toBe('')
  })

  it('writes a hand-written voice through the endpoint with the analysis kept underneath', async () => {
    await mountVoice({ profile: profileWith() })
    await screen.findByText('Current Profile')

    await typeManualVoice(MANUAL_VOICE)
    fireEvent.click(screen.getByRole('button', { name: /apply voice/i }))
    await waitFor(() => expect(api.writeVoiceProfile).toHaveBeenCalled())

    const [written] = api.writeVoiceProfile.mock.calls.at(-1)!
    expect(written.manualText).toBe(MANUAL_VOICE)
    expect(written.traits).toEqual(TRAITS)
    expect(written.sampleChapterIds).toEqual(['c1', 'c2'])
    expect(written.generatedAt).toBeGreaterThan(0)

    expect(within(currentProfileSection()).getByText(/overrides the analysed profile/)).toBeTruthy()
  })

  it('analyses the selected chapters with the active prompt pack and saves the traits on request', async () => {
    await mountVoice({ config: makeConfig([P1], 'p1') })
    api.chat.mockResolvedValue(JSON.stringify(TRAITS))

    fireEvent.click(screen.getByRole('button', { name: /Chapter 1: Ash/ }))
    fireEvent.click(screen.getByRole('button', { name: /Chapter 2: Ember/ }))
    fireEvent.click(screen.getByRole('button', { name: /analyse voice/i }))
    await waitFor(() => expect(api.chat).toHaveBeenCalled())

    expect(api.readChapter).toHaveBeenCalledWith('c1.md')
    expect(api.readChapter).toHaveBeenCalledWith('c2.md')
    const [messages, providerId] = api.chat.mock.calls.at(-1)!
    expect(providerId).toBe('p1')
    // The instruction comes from the active pack, never a hardcoded copy.
    expect(messages[0]).toEqual({
      role: 'system',
      content: PROMPTS.assist.voiceAnalysis.systemPrompt,
    })
    expect(messages[1].content).toContain('Chapter 1: Ash')
    expect(messages[1].content).toContain(CHAPTER_TEXT)

    // The result is a draft until the author saves it.
    expect(await screen.findByText('Analysis Result')).toBeTruthy()
    expect(api.writeVoiceProfile).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /save profile/i }))
    await waitFor(() => expect(api.writeVoiceProfile).toHaveBeenCalled())

    const [written] = api.writeVoiceProfile.mock.calls.at(-1)!
    expect(written.traits).toEqual(TRAITS)
    expect(written.sampleChapterIds).toEqual(['c1', 'c2'])
    expect(written.generatedAt).toBeGreaterThan(0)
  })

  it('keeps the pasted sample when the analysis call fails, so the run can be retried', async () => {
    await mountVoice({ config: makeConfig([P1], 'p1') })

    fireEvent.change(screen.getByPlaceholderText(/Paste human-written fiction here/), {
      target: { value: PASTED_PROSE },
    })
    api.chat.mockRejectedValue(new Error('AI request failed (500): upstream is unreachable'))
    fireEvent.click(screen.getByRole('button', { name: /analyse voice/i }))

    await waitFor(() =>
      expect(
        useToastStore.getState().toasts.some((t) => t.message.includes('upstream is unreachable')),
      ).toBe(true),
    )
    expect(screen.getByPlaceholderText(/Paste human-written fiction here/)).toHaveValue(
      PASTED_PROSE,
    )
    expect(screen.queryByText('Analysis Result')).toBeNull()
    expect(api.writeVoiceProfile).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /analyse voice/i })).toBeEnabled(),
    )
  })

  it('offers nothing to analyse when the world has no chapters yet', async () => {
    await mountVoice({ novel: novelWithoutChapters, profile: null })

    expect(screen.getByText('No chapters yet. Write some chapters first.')).toBeTruthy()
    // The "select chapters" nudge cannot be acted on here, so it is not shown.
    expect(screen.queryByText(/No voice profile yet/)).toBeNull()
    expect(screen.getByRole('button', { name: /analyse voice/i })).toBeDisabled()
  })
})
