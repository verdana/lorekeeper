import { useEffect, useRef, useState, type TextareaHTMLAttributes } from 'react'
import type {
  ChapterSummary,
  GenerationContextLayer,
  GenerationProviderSnapshot,
  GenerationRun,
  GenerationRunSummary,
  GenerationStage,
  StoryMemoryStore,
  StoryState,
  TimelineEvent,
} from '@shared/types'
import { buildStoryMemoryContext, orderedChapters, selectStoryMemories } from '@shared/storyMemory'
import { buildMemoryLayers, type MemoryLayerLabels } from '@shared/chapterMemory'
import {
  X,
  Send,
  Loader2,
  CornerDownLeft,
  Square,
  BookOpen,
  RefreshCw,
  Settings2,
  RotateCcw,
  Brain,
  Database,
} from 'lucide-react'
import { useStore } from '../store'
import { chatStream } from '../api'
import { toastError, parseAiError } from '../toast'
import { PROMPTS, PROMPT_LANG } from '@shared/prompts'
import DiffView from './DiffView'
import { CONTEXT_BUDGET, createContextAllocator } from '../contextBudget'
import { extractChapterOutline } from '../outlineBeats'
import { formatTime, uid, applyParagraphIndent } from '../lib'
import { buildWritingSystemPrompt, countGramHits, extractSignalGrams } from '../writingStyle'

/** AI assistant presets: same panel reused for settings and prose, swapping title and prompts. */
export interface AssistPreset {
  title: string
  systemPrompt: string
  contextLabel: string // 上下文在 prompt 里的标签，如「当前设定文档」
  quickPrompts: string[]
}

/** Codex scene: polish / expand / find gaps / suggest hooks. */
export const SETTING_ASSIST: AssistPreset = PROMPTS.assist.setting

// ---- Default system prompts (also exported to Preferences as templates). ----

export const BUILTIN_OUTLINE_PROMPT = PROMPTS.assist.outlinePrompt

export const BUILTIN_REWRITE_PROMPT = PROMPTS.assist.rewritePrompt

// ---- Custom prompts persisted to localStorage. ----
//
// Keyed by prompt language so a Chinese custom prompt never shadows the
// English one (and vice versa). The legacy language-less key is still read as
// a fallback so pre-slot custom prompts are not lost on upgrade.

function loadCustomPrompt(mode: string): string | null {
  try {
    return (
      localStorage.getItem(`ai-prompt:${mode}:${PROMPT_LANG}`) ??
      localStorage.getItem(`ai-prompt:${mode}`)
    )
  } catch {
    return null
  }
}

function saveCustomPrompt(mode: string, prompt: string): void {
  try {
    localStorage.setItem(`ai-prompt:${mode}:${PROMPT_LANG}`, prompt)
  } catch {
    // Fail silently.
  }
}

/** Remove the current locale's custom prompt (plus the legacy language-less key). */
function clearCustomPrompt(mode: string): void {
  try {
    localStorage.removeItem(`ai-prompt:${mode}:${PROMPT_LANG}`)
    localStorage.removeItem(`ai-prompt:${mode}`)
  } catch {
    // Fail silently.
  }
}

function getDefaultPrompt(mode: string): string {
  if (mode === 'outline-write') return BUILTIN_OUTLINE_PROMPT
  if (mode === 'rewrite') return BUILTIN_REWRITE_PROMPT
  return ''
}

/** Read custom prompts from config if set, otherwise use hardcoded defaults. */
function getConfigPrompt(
  mode: string,
  config: {
    writing?: {
      outlineSystemPrompt?: string
      rewriteSystemPrompt?: string
    }
  } | null,
): string {
  if (!config?.writing) return getDefaultPrompt(mode)
  if (mode === 'outline-write' && config.writing.outlineSystemPrompt?.trim())
    return config.writing.outlineSystemPrompt
  if (mode === 'rewrite' && config.writing.rewriteSystemPrompt?.trim())
    return config.writing.rewriteSystemPrompt
  return getDefaultPrompt(mode)
}

// ---- Context loading hook. ----

interface OutlineContext {
  settings: string
  outline: string
  /** Author-written beats for the chapter being drafted (may be empty). */
  chapterBeats: string
  timeline: string
  memories: string
  memoryCount: number
  memory: string
  prevChapters: string
  loading: boolean
  truncated: boolean
}

/** Character budget for the legacy confirmed Story Memory context injection. */
const MEMORY_CONTEXT_BUDGET = Math.floor(CONTEXT_BUDGET * 0.1)

// ---- Setting-doc relevance matching (see writingStyle.ts for the n-gram helpers). ----

// Legacy panel shares: outline is the primary input for outline-write, so it
// gets the largest share; prev keeps the remainder. The layered-memory block
// (story state + chapter summaries) gets 25% so buildMemoryLayers' default
// 7500-char budget survives the allocator untouched.
const legacyAllocator = createContextAllocator({
  settings: 0.14,
  outline: 0.28,
  timeline: 0.07,
  memories: 0.08,
  memory: 0.25,
})

function applyBudget(
  settings: string,
  outline: string,
  timeline: string,
  memories: string,
  memory: string,
  prevChapters: string,
): {
  settings: string
  outline: string
  timeline: string
  memories: string
  memory: string
  prevChapters: string
  truncated: boolean
} {
  const budgeted = legacyAllocator({
    settings,
    outline,
    timeline,
    memories,
    memory,
    prevChapters,
  })
  return {
    settings: budgeted.settings,
    outline: budgeted.outline,
    timeline: budgeted.timeline,
    memories: budgeted.memories,
    memory: budgeted.memory,
    prevChapters: budgeted.prevChapters,
    truncated: budgeted.truncated,
  }
}

function useOutlineContext(
  chapterId: string,
  chapterTitle: string,
  content: string,
  active: boolean,
): OutlineContext {
  const novel = useStore((s) => s.novel)!
  const settingDocs = useStore((s) => s.settingDocs)
  const [settings, setSettings] = useState('')
  const [outline, setOutline] = useState('')
  const [chapterBeats, setChapterBeats] = useState('')
  const [timeline, setTimeline] = useState('')
  const [memories, setMemories] = useState('')
  const [memoryCount, setMemoryCount] = useState(0)
  const [memory, setMemory] = useState('')
  const [prevChapters, setPrevChapters] = useState('')
  const [loading, setLoading] = useState(true)
  const [truncated, setTruncated] = useState(false)

  // Refs for scene-filter signal: updated every render but excluded from
  // deps so typing in the editor doesn't trigger a full context reload.
  const chapterTitleRef = useRef(chapterTitle)
  const contentRef = useRef(content)
  chapterTitleRef.current = chapterTitle
  contentRef.current = content

  useEffect(() => {
    if (!active) return
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        // 1) Outline (loaded early; also serves as scene-filter signal).
        const outlineText = await window.api.readOutline()
        // The long outline is truncated by the context budget, which hid the
        // author's per-chapter beats (usually deep inside the 50-chapter
        // outline) from the drafter. Extract them up front as their own layer
        // so the source draft actually receives the chapter's plot nodes.
        const beats = extractChapterOutline(outlineText, chapterTitleRef.current)

        // 2) Codex settings filtered by relevance.
        //    Signal = chapter title + current prose + outline. worldview and
        //    character docs are always included (global rules; OOC is the most
        //    common continuity failure). Other docs match when the doc title
        //    appears in the signal OR ≥3 signal n-grams appear in the doc
        //    body — title-only matching silently dropped docs whose titles the
        //    outline never mentions verbatim, which read as "the AI ignored
        //    the setting".
        const relevant = new Set<string>()
        const signalText = `${chapterTitleRef.current}\n${contentRef.current}\n${outlineText}`
        const hasSignal = signalText.trim().length > 0
        for (const doc of settingDocs) {
          if (doc.category === '01-worldview' || doc.category === '11-character') {
            relevant.add(doc.id)
          } else if (hasSignal && doc.title && signalText.includes(doc.title)) {
            relevant.add(doc.id)
          }
        }
        // Body-level pass: read the remaining docs once (cached), and keep any
        // whose content shares ≥3 signal n-grams with the current scene.
        const contentCache = new Map<string, string>()
        if (hasSignal) {
          const grams = extractSignalGrams(signalText)
          if (grams.length > 0) {
            await Promise.all(
              settingDocs
                .filter((d) => !relevant.has(d.id))
                .map(async (doc) => {
                  try {
                    const { content } = await window.api.readSetting(doc.id)
                    contentCache.set(doc.id, content)
                    if (content.trim() && countGramHits(content, grams) >= 3) {
                      relevant.add(doc.id)
                    }
                  } catch {
                    // Unreadable docs must not block context loading.
                  }
                }),
            )
          }
        }
        const settingTexts: string[] = []
        for (const doc of settingDocs) {
          if (!relevant.has(doc.id)) continue
          const content = contentCache.get(doc.id) ?? (await window.api.readSetting(doc.id)).content
          if (content.trim()) settingTexts.push(`## ${doc.title}\n\n${content}`)
        }

        // 3) Timeline events and confirmed Story Memory entries.
        // Story Memory is optional context: an unreadable local memory file
        // must never block the existing drafting workflow.
        const events: TimelineEvent[] = await window.api.listTimelineEvents()
        let memoryStore: StoryMemoryStore = { version: 1, entries: [] }
        try {
          memoryStore = await window.api.readStoryMemory()
        } catch (e) {
          console.warn('[story-memory] skipped unreadable memory file:', e)
        }
        const timelineText = events
          .slice()
          .sort((a, b) => a.dateOrder - b.dateOrder)
          .map(
            (e) =>
              `- ${e.dateLabel ? `**${e.dateLabel}** ` : ''}${e.title}${e.description ? `: ${e.description}` : ''}`,
          )
          .join('\n')

        const ordered = orderedChapters(novel)
        const currentIndex = ordered.findIndex((item) => item.chapter.id === chapterId)
        const textCache = new Map<string, string>()
        const readSavedChapter = async (id: string): Promise<string> => {
          const cached = textCache.get(id)
          if (cached !== undefined) return cached
          // The active chapter may have unsaved editor changes. Use the live
          // prose for its fingerprint so outdated memories cannot leak into
          // a drafting request before the debounce save completes.
          if (id === chapterId) {
            const text = contentRef.current
            textCache.set(id, text)
            return text
          }
          const item = ordered.find((candidate) => candidate.chapter.id === id)
          if (!item) return ''
          const text = await window.api.readChapter(item.chapter.file)
          textCache.set(id, text)
          return text
        }
        const sourceIds = [...new Set(memoryStore.entries.map((entry) => entry.source.chapterId))]
        await Promise.all(sourceIds.map((id) => readSavedChapter(id)))
        const selectedMemories = selectStoryMemories({
          store: memoryStore,
          novel,
          activeChapterId: chapterId,
          sourceTexts: textCache,
          signalText,
          settingDocs,
        })
        const memoryContext = buildStoryMemoryContext(
          selectedMemories,
          events,
          MEMORY_CONTEXT_BUDGET,
        )

        // 4) Previous chapters before the active chapter in flattened reading order.
        // Keep each chapter's ENDING (the state the next chapter continues from),
        // not its opening; the allocator's tail-first truncation then preserves
        // the closest chapters' closing scenes.
        const chapterSnippets: string[] = []
        for (const item of ordered.slice(0, Math.max(0, currentIndex))) {
          const text = await readSavedChapter(item.chapter.id)
          if (text.trim()) {
            chapterSnippets.push(
              `### ${item.chapter.title}\n\n${text.length > 800 ? '…' : ''}${text.slice(-800)}`,
            )
          }
        }

        // 5) Layered memory: current story state (hard constraints) + chapter
        //    summaries (recent full, distant condensed). Like Story Memory,
        //    this is optional context — unreadable files must not block the
        //    existing drafting workflow.
        const memoryLabels = PROMPTS.assist.memory as MemoryLayerLabels
        let summaryList: ChapterSummary[] = []
        let storyState: StoryState = {
          version: 1,
          upToChapterId: null,
          updatedAt: 0,
          characters: [],
          worldState: [],
          openThreads: [],
          currentEndState: '',
        }
        try {
          summaryList = await window.api.listChapterSummaries()
          storyState = await window.api.readStoryState()
        } catch (e) {
          console.warn('[chapter-memory] skipped unreadable memory data:', e)
        }
        // Fingerprint cache: summaries whose source prose changed count as stale.
        const summarySourceIds = summaryList.map((s) => s.chapterId)
        await Promise.all(summarySourceIds.map((id) => readSavedChapter(id)))
        const layers = buildMemoryLayers(summaryList, storyState, novel, chapterId, memoryLabels, {
          sourceTexts: textCache,
        })
        const rawMemory = [
          layers.stateText ? memoryLabels.stateHint : '',
          layers.stateText,
          layers.recentText,
          layers.distantText,
        ]
          .filter(Boolean)
          .join('\n\n')

        if (!cancelled) {
          const rawSettings = settingTexts.join('\n\n---\n\n')
          const rawOutline = outlineText
          const rawTimeline = timelineText
          const rawMemories = memoryContext.text
          const rawPrev = chapterSnippets.join('\n\n')
          const trimmed = applyBudget(
            rawSettings,
            rawOutline,
            rawTimeline,
            rawMemories,
            rawMemory,
            rawPrev,
          )
          setSettings(trimmed.settings)
          setOutline(trimmed.outline)
          setChapterBeats(beats)
          setTimeline(trimmed.timeline)
          setMemories(trimmed.memories)
          setMemoryCount(memoryContext.count)
          setMemory(trimmed.memory)
          setPrevChapters(trimmed.prevChapters)
          setTruncated(trimmed.truncated || memoryContext.truncated || layers.truncated)
        }
      } catch {
        // Loading failure does not block the panel.
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [active, chapterId, novel, settingDocs])

  return {
    settings,
    outline,
    chapterBeats,
    timeline,
    memories,
    memoryCount,
    memory,
    prevChapters,
    loading,
    truncated,
  }
}

// ---- Main panel. ----

type AiMode = 'polish' | 'outline-write' | 'rewrite'

interface Props {
  mode: AiMode
  content: string
  /** User’s text selection; when set, polish only the selection. */
  selectedText?: string
  chapterId: string
  chapterTitle: string
  /** Optionally override the preset in polish mode; defaults to SETTING_ASSIST. */
  polishPreset?: AssistPreset
  onInsert: (text: string, evidence?: GenerationInsertEvidence) => void
  onClose: () => void
}

export interface GenerationInsertEvidence {
  runId: string
  editingStartedAt: number
}

/** Strip blank lines between paragraphs in LLM output so it matches original style. */
function stripBlankLines(text: string): string {
  return text.replace(/\n{2,}/g, '\n').trim()
}

/**
 * Prompt input that grows with its content, capped at `max-h-*` via CSS so the
 * panel never balloons. Resets to the min height when the value shrinks.
 */
function AutoResizeTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>): JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${el.scrollHeight}px`
  }, [props.value])
  return <textarea ref={ref} {...props} />
}

const generationRunSummary = (run: GenerationRun): GenerationRunSummary => ({
  id: run.id,
  chapterId: run.chapterId,
  chapterTitle: run.chapterTitle,
  createdAt: run.createdAt,
  updatedAt: run.updatedAt,
  stageCount: run.stages.length,
  status: run.stages.at(-1)?.status ?? 'empty',
  selectedResultKind: run.selectedResult?.kind ?? null,
  hasAuthorResult: Boolean(run.authorResult),
  retentionRatio: run.authorResult?.retentionRatio ?? null,
  isBaseline: Boolean(run.baseline),
  reproductionOf: run.reproductionOf ?? null,
})

function GenerationEvidencePanel({
  runs,
  selectedRun,
  currentRunId,
  loading,
  reproducingRunId,
  onSelect,
  onReproduce,
  onStopReproduction,
}: {
  runs: GenerationRunSummary[]
  selectedRun: GenerationRun | null
  currentRunId: string | null
  loading: boolean
  reproducingRunId: string | null
  onSelect: (id: string) => void
  onReproduce: (run: GenerationRun) => void
  onStopReproduction: () => void
}): JSX.Element {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [open])

  const usageLabel = (stage: GenerationStage): string => {
    if (stage.usage.source === 'unavailable') return 'Token usage unavailable'
    return `${stage.usage.inputTokens ?? '?'} in / ${stage.usage.outputTokens ?? '?'} out (${stage.usage.source})`
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-1.5 border-t border-ink-800 px-4 py-2 text-xs text-ink-500 hover:text-ink-muted"
      >
        <Database size={12} />
        Generation evidence
        {runs.length > 0 && <span className="text-[10px]">({runs.length})</span>}
        <span className="ml-auto text-[10px]">Open workspace</span>
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink-deep/60 p-6"
          onClick={(event) => {
            if (event.target === event.currentTarget) setOpen(false)
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="generation-evidence-title"
            className="flex max-h-[90vh] w-full max-w-5xl flex-col rounded-[14px] border border-ink-800 bg-ink-900 shadow-warm-lg"
          >
            <div className="flex items-center justify-between border-b border-ink-800 px-5 py-4">
              <div
                id="generation-evidence-title"
                className="flex items-center gap-2 text-sm font-semibold text-ink-body"
              >
                <Database size={15} className="text-star-info" />
                Generation evidence
                {runs.length > 0 && <span className="text-xs text-ink-500">({runs.length})</span>}
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="icon-btn"
                aria-label="Close generation evidence"
              >
                <X size={16} />
              </button>
            </div>
            <div className="flex-1 space-y-3 overflow-y-auto p-5">
              {reproducingRunId && (
                <div className="flex items-center justify-between gap-2 rounded border border-star-info/30 bg-star-info/5 px-2.5 py-2 text-[11px] text-star-info">
                  <span className="flex items-center gap-1.5">
                    <Loader2 size={11} className="animate-spin" /> Reproducing saved run…
                  </span>
                  <button
                    onClick={onStopReproduction}
                    className="text-star-danger hover:brightness-90"
                  >
                    Stop
                  </button>
                </div>
              )}
              {loading ? (
                <div className="flex items-center gap-2 text-xs text-ink-500">
                  <Loader2 size={12} className="animate-spin" /> Loading run history…
                </div>
              ) : runs.length === 0 ? (
                <p className="text-xs text-ink-500">No recorded outline-writing runs yet.</p>
              ) : (
                <>
                  <select
                    className="input h-8 py-1 text-xs"
                    value={selectedRun?.id ?? ''}
                    onChange={(event) => onSelect(event.target.value)}
                  >
                    {runs.map((run) => (
                      <option key={run.id} value={run.id}>
                        {formatTime(run.createdAt)} · {run.status}
                        {run.id === currentRunId ? ' · current' : ''}
                      </option>
                    ))}
                  </select>
                  {selectedRun && (
                    <div className="space-y-2 text-[11px] text-ink-500">
                      <div className="rounded border border-ink-800 bg-ink-850 px-2.5 py-2">
                        <div className="text-ink-muted">{selectedRun.chapterTitle}</div>
                        <div className="mt-1 font-mono text-[10px]">{selectedRun.id}</div>
                        <div className="mt-1 text-[10px]">
                          {selectedRun.baseline && (
                            <span className="text-star-info">Captured baseline · </span>
                          )}
                          {selectedRun.reproductionOf && (
                            <span>Reproduction of {selectedRun.reproductionOf} · </span>
                          )}
                          {selectedRun.authorResult && (
                            <span className="text-star-success">
                              Author save {formatTime(selectedRun.authorResult.savedAt)} · retention{' '}
                              {(selectedRun.authorResult.retentionRatio * 100).toFixed(1)}% ·
                              removed{' '}
                              {((1 - selectedRun.authorResult.retentionRatio) * 100).toFixed(1)}% ·
                              elapsed edit{' '}
                              {Math.round(selectedRun.authorResult.editingDurationMs / 60000)} min
                            </span>
                          )}
                        </div>
                        <button
                          onClick={() => onReproduce(selectedRun)}
                          disabled={
                            reproducingRunId !== null ||
                            !selectedRun.stages.some(
                              (stage) => stage.kind === 'draft' && stage.status === 'completed',
                            )
                          }
                          className="btn btn-sm btn-ghost mt-2 disabled:opacity-40"
                          title="Replay the exact saved messages and parameters with the unchanged provider configuration"
                        >
                          {reproducingRunId === selectedRun.id ? (
                            <Loader2 size={11} className="animate-spin" />
                          ) : (
                            <RefreshCw size={11} />
                          )}
                          Reproduce draft
                        </button>
                        {selectedRun.selectedResult && (
                          <details className="mt-1">
                            <summary className="cursor-pointer text-star-success">
                              Applied {selectedRun.selectedResult.kind} result at{' '}
                              {formatTime(selectedRun.selectedResult.selectedAt)}
                            </summary>
                            <div className="mt-1 text-[10px] text-ink-500">
                              Sources: {selectedRun.selectedResult.stageIds.join(', ')}
                            </div>
                            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-ink-900 p-2 font-mono text-[10px] text-ink-muted">
                              {selectedRun.selectedResult.text}
                            </pre>
                          </details>
                        )}
                        {selectedRun.authorResult && (
                          <details className="mt-1">
                            <summary className="cursor-pointer text-star-success">
                              Latest linked author text
                            </summary>
                            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-ink-900 p-2 font-mono text-[10px] text-ink-muted">
                              {selectedRun.authorResult.text || '(empty)'}
                            </pre>
                          </details>
                        )}
                      </div>
                      {selectedRun.stages.map((stage) => (
                        <details
                          key={stage.id}
                          className="rounded border border-ink-800 bg-ink-850"
                        >
                          <summary className="cursor-pointer list-none px-2.5 py-2 text-ink-muted">
                            <span className="font-medium">
                              {stage.kind === 'draft'
                                ? 'Draft'
                                : `Legacy calibration ${stage.partIndex}/${stage.partTotal}`}
                            </span>
                            <span className="ml-1.5 text-[10px] text-ink-500">{stage.status}</span>
                          </summary>
                          <div className="space-y-2 border-t border-ink-800 px-2.5 py-2">
                            <div>
                              {stage.provider.name} · {stage.provider.model}
                            </div>
                            <div>
                              temperature {stage.parameters.temperature ?? 'default'} · top_p{' '}
                              {stage.parameters.topP ?? 'default'} · max tokens{' '}
                              {stage.parameters.maxTokens ?? 'default'}
                            </div>
                            <div>
                              {stage.durationMs == null ? 'Running' : `${stage.durationMs} ms`} ·{' '}
                              {usageLabel(stage)}
                            </div>
                            <div className="break-all font-mono text-[10px]">
                              Prompt {stage.promptVersion} · {stage.promptHash}
                            </div>
                            <details>
                              <summary className="cursor-pointer text-star-info">
                                Effective messages
                              </summary>
                              <div className="mt-1 space-y-1.5">
                                {stage.messages.map((message, index) => (
                                  <div key={`${message.role}-${index}`}>
                                    <div className="uppercase text-[9px] text-ink-500">
                                      {message.role}
                                    </div>
                                    <pre className="mt-0.5 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-ink-900 p-2 font-mono text-[10px] text-ink-muted">
                                      {message.content}
                                    </pre>
                                  </div>
                                ))}
                              </div>
                            </details>
                            <details>
                              <summary className="cursor-pointer text-star-info">
                                Context layers
                              </summary>
                              <div className="mt-1 space-y-1.5">
                                {stage.contextLayers.map((layer) => (
                                  <details key={layer.key}>
                                    <summary className="cursor-pointer">
                                      {layer.label} · {layer.content.length.toLocaleString()} chars
                                    </summary>
                                    <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-ink-900 p-2 font-mono text-[10px] text-ink-muted">
                                      {layer.content || '(empty)'}
                                    </pre>
                                  </details>
                                ))}
                              </div>
                            </details>
                            <details>
                              <summary className="cursor-pointer text-star-info">
                                Raw output · {stage.output.length.toLocaleString()} chars
                              </summary>
                              <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap rounded bg-ink-900 p-2 font-mono text-[10px] text-ink-muted">
                                {stage.output || '(empty)'}
                              </pre>
                            </details>
                            {stage.error && <div className="text-star-danger">{stage.error}</div>}
                          </div>
                        </details>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export default function AiAssistPanel({
  mode,
  content,
  selectedText,
  chapterId,
  chapterTitle,
  polishPreset,
  onInsert,
  onClose,
}: Props): JSX.Element {
  const polish = polishPreset ?? SETTING_ASSIST
  const config = useStore((s) => s.config)
  const voiceProfile = useStore((s) => s.voiceProfile)
  // 题材与文风范例：优先用 world meta 的 genre——WorldGate 改题材后立即生效，
  // novel.tags[0] 可能仍是旧值（server 保存时同步，但内存 store 未刷新）。
  const novel = useStore((s) => s.novel)
  const worlds = useStore((s) => s.worlds)
  const currentWorldId = useStore((s) => s.currentWorldId)
  const exemplarTexts = useStore((s) => s.exemplars.texts)
  const genre = worlds.find((w) => w.id === currentWorldId)?.genre ?? novel?.tags?.[0] ?? ''
  // Shared system-prompt context for all writing modes.
  const writingStyle = { voiceProfile, genre, exemplars: exemplarTexts }
  const [prompt, setPrompt] = useState('')
  const [answer, setAnswer] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const abortRef = useRef<AbortController>(undefined)
  // Prevent concurrent generation and reproduction requests.
  const runningRef = useRef(false)
  const [runHistory, setRunHistory] = useState<GenerationRunSummary[]>([])
  const [runHistoryLoading, setRunHistoryLoading] = useState(false)
  const [currentRun, setCurrentRun] = useState<GenerationRun | null>(null)
  const [inspectedRun, setInspectedRun] = useState<GenerationRun | null>(null)
  const [selectionSaving, setSelectionSaving] = useState(false)
  const [reproducingRunId, setReproducingRunId] = useState<string | null>(null)

  // Outline.编写 / 改写模式需要加载设定 + Outline. + 前文章节
  const outlineCtx = useOutlineContext(
    chapterId,
    chapterTitle,
    content,
    mode === 'outline-write' || mode === 'rewrite',
  )
  // Rewrite mode injects the current chapter body (or the selection when one
  // is active), capped for the token budget.
  const rewriteTarget = mode === 'rewrite' ? (selectedText || content).slice(0, 8000) : ''

  // ---- Editable system prompts. ----
  const canEditPrompt = mode === 'outline-write' || mode === 'rewrite'
  const [showSysPrompt, setShowSysPrompt] = useState(false)

  // Prompt priority: localStorage > config.writing > hardcoded defaults.
  const [sysPrompt, setSysPrompt] = useState(() => {
    if (!canEditPrompt) return ''
    return loadCustomPrompt(mode) ?? getConfigPrompt(mode, config)
  })

  // Reload when switching mode.
  useEffect(() => {
    if (!canEditPrompt) return
    setSysPrompt(loadCustomPrompt(mode) ?? getConfigPrompt(mode, config))
    setShowSysPrompt(false)
  }, [mode, canEditPrompt, config])

  const isCustomized =
    canEditPrompt &&
    loadCustomPrompt(mode) !== null &&
    loadCustomPrompt(mode) !== getConfigPrompt(mode, config)

  // Refresh on config update (only when no localStorage override).
  useEffect(() => {
    if (!canEditPrompt) return
    if (loadCustomPrompt(mode) !== null) return
    setSysPrompt(getConfigPrompt(mode, config))
  }, [config, canEditPrompt, mode])

  const resetSysPrompt = (): void => {
    const def = getConfigPrompt(mode, config)
    setSysPrompt(def)
    clearCustomPrompt(mode)
  }

  useEffect(() => () => abortRef.current?.abort(), [])

  useEffect(() => {
    if (mode !== 'outline-write') return
    let cancelled = false
    setCurrentRun(null)
    setInspectedRun(null)
    setRunHistory([])
    setRunHistoryLoading(true)
    window.api
      .listGenerationRuns(chapterId)
      .then(async (runs: GenerationRunSummary[]) => {
        if (cancelled) return
        setRunHistory(runs)
        const first = runs[0]
        if (!first) {
          setInspectedRun(null)
          return
        }
        const run = await window.api.readGenerationRun(first.id)
        if (!cancelled) setInspectedRun(run)
      })
      .catch((loadError: unknown) => {
        if (!cancelled) console.warn('[generation-evidence] failed to load history:', loadError)
      })
      .finally(() => {
        if (!cancelled) setRunHistoryLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [chapterId, currentWorldId, mode])

  const rememberGenerationRun = (run: GenerationRun, current = true): void => {
    if (current) setCurrentRun(run)
    setInspectedRun(run)
    const summary = generationRunSummary(run)
    setRunHistory((history) => [summary, ...history.filter((item) => item.id !== run.id)])
  }

  const inspectGenerationRun = (id: string): void => {
    setRunHistoryLoading(true)
    window.api
      .readGenerationRun(id)
      .then((run: GenerationRun | null) => setInspectedRun(run))
      .catch((loadError: unknown) => {
        setError((loadError as Error).message)
        toastError('Failed to load generation evidence: ' + (loadError as Error).message)
      })
      .finally(() => setRunHistoryLoading(false))
  }

  const hasKey = config?.ai.providers.some((p) => p.apiKey)

  // ---- Build messages. ----

  const buildMessages = (q: string): { role: 'system' | 'user'; content: string }[] => {
    const ctx = PROMPTS.assist.context
    if (mode === 'polish') {
      const target = selectedText || content.slice(0, 6000)
      const label = selectedText ? ctx.selectedLabel : polish.contextLabel
      // Setting docs are reference text, not prose — inject genre + exemplars
      // but drop the author's fiction voice profile there.
      const style = { ...writingStyle, voiceProfile: null }
      return [
        {
          role: 'system',
          content: buildWritingSystemPrompt(polish.systemPrompt, style),
        },
        { role: 'user', content: `[${label}]\n${target}\n\n[My request]\n${q}` },
      ]
    }
    if (mode === 'outline-write') {
      const o = ctx.outline
      return [
        { role: 'system', content: buildWritingSystemPrompt(sysPrompt, writingStyle) },
        {
          role: 'user',
          content: [
            `## ${o.codex}`,
            outlineCtx.settings || ctx.empty,
            '',
            `## ${o.timeline}`,
            outlineCtx.timeline || ctx.empty,
            '',
            `## ${o.memories}`,
            outlineCtx.memories || ctx.empty,
            '',
            `## ${PROMPTS.assist.memory.state}`,
            outlineCtx.memory || ctx.empty,
            '',
            `## ${o.chapterBeats}`,
            outlineCtx.chapterBeats || ctx.empty,
            '',
            `## ${o.outline}`,
            outlineCtx.outline || ctx.empty,
            '',
            `## ${o.prevChapters}`,
            outlineCtx.prevChapters || ctx.empty,
            '',
            `## ${o.chapter}`,
            `${o.chapterTitlePrefix}${chapterTitle}`,
            '',
            `## ${o.instructions}`,
            q || o.defaultInstruction,
          ].join('\n'),
        },
      ]
    }
    // rewrite
    const o = ctx.outline
    const r = ctx.rewrite
    return [
      { role: 'system', content: buildWritingSystemPrompt(sysPrompt, writingStyle) },
      {
        role: 'user',
        content: [
          `## ${selectedText ? r.selectedChapter : r.chapter}`,
          rewriteTarget || ctx.empty,
          '',
          `## ${o.codex}`,
          outlineCtx.settings || ctx.empty,
          '',
          `## ${o.timeline}`,
          outlineCtx.timeline || ctx.empty,
          '',
          `## ${o.memories}`,
          outlineCtx.memories || ctx.empty,
          '',
          `## ${PROMPTS.assist.memory.state}`,
          outlineCtx.memory || ctx.empty,
          '',
          `## ${o.outline}`,
          outlineCtx.outline || ctx.empty,
          '',
          `## ${o.prevChapters}`,
          outlineCtx.prevChapters || ctx.empty,
          '',
          `## ${r.instructions}`,
          q || r.defaultInstruction,
        ].join('\n'),
      },
    ]
  }

  const sharedEvidenceLayers = (basePrompt: string): GenerationContextLayer[] => [
    { key: 'base-system-prompt', label: 'Base system prompt', content: basePrompt },
    { key: 'genre', label: 'Genre', content: genre },
    { key: 'exemplars', label: 'Style exemplars', content: exemplarTexts.join('\n\n---\n\n') },
    {
      key: 'voice-profile',
      label: 'Voice profile',
      content: voiceProfile ? JSON.stringify(voiceProfile, null, 2) : '',
    },
    { key: 'codex', label: 'Codex', content: outlineCtx.settings },
    { key: 'timeline', label: 'Timeline', content: outlineCtx.timeline },
    { key: 'story-memory', label: 'Story Memory', content: outlineCtx.memories },
    { key: 'chapter-memory', label: 'Chapter Memory', content: outlineCtx.memory },
    {
      key: 'chapter-beats',
      label: 'Chapter outline beats',
      content: outlineCtx.chapterBeats,
    },
    { key: 'outline', label: 'Outline', content: outlineCtx.outline },
    {
      key: 'previous-chapters',
      label: 'Previous chapters',
      content: outlineCtx.prevChapters,
    },
  ]

  const resolveProviderSnapshot = (providerId: string | undefined): GenerationProviderSnapshot => {
    const providers = config?.ai.providers ?? []
    const provider = providers.find((item) => item.id === providerId) ?? providers[0]
    if (!provider) throw new Error('No AI provider configured. Add one under Settings first.')
    return {
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      model: provider.model,
    }
  }

  const reproduceGenerationRun = async (source: GenerationRun): Promise<void> => {
    if (runningRef.current || reproducingRunId) return
    const original = source.stages.find(
      (stage) => stage.kind === 'draft' && stage.status === 'completed',
    )
    if (!original) {
      setError('Only a run with a completed source draft can be reproduced.')
      return
    }
    const provider = config?.ai.providers.find((item) => item.id === original.provider.id)
    if (
      !provider ||
      provider.baseUrl !== original.provider.baseUrl ||
      provider.model !== original.provider.model ||
      (provider.maxTokens ?? null) !== original.parameters.maxTokens
    ) {
      setError(
        `Cannot reproduce ${original.id}: its provider, model, base URL, or max-token setting has changed.`,
      )
      return
    }
    runningRef.current = true
    setReproducingRunId(source.id)
    setError('')
    const controller = new AbortController()
    abortRef.current = controller
    let replayId: string | null = null
    let activeStage: GenerationStage | null = null
    let replayOutput = ''
    try {
      const created = await window.api.createGenerationRun({
        id: uid('gr_'),
        chapterId: source.chapterId,
        chapterTitle: source.chapterTitle,
        reproductionOf: source.id,
      })
      replayId = created.id
      rememberGenerationRun(created, false)
      replayOutput = ''
      activeStage = {
        ...original,
        status: 'running',
        promptHash: '',
        startedAt: Date.now(),
        durationMs: null,
        finishReason: null,
        usage: {
          source: 'unavailable',
          inputTokens: null,
          outputTokens: null,
          totalTokens: null,
        },
        output: '',
        error: null,
      }
      const running = await window.api.saveGenerationStage(replayId, activeStage)
      rememberGenerationRun(running, false)
      const result = await chatStream(
        original.messages,
        original.provider.id,
        (type, text) => {
          if (type === 'content') replayOutput += text
        },
        controller.signal,
        original.parameters.temperature ?? undefined,
        original.parameters.topP ?? undefined,
        original.parameters.disableThinking,
      )
      const completed = await window.api.saveGenerationStage(replayId, {
        ...activeStage,
        status: result.completed ? 'completed' : 'incomplete',
        durationMs: Date.now() - activeStage.startedAt,
        finishReason: result.finishReason,
        usage: result.usage,
        output: result.content,
        error: result.completed ? null : 'The reproduced request did not complete.',
      })
      rememberGenerationRun(completed, false)
      activeStage = null
      if (!result.completed) throw new Error('The reproduced draft did not complete.')
    } catch (reproductionError) {
      if (replayId && activeStage) {
        try {
          const failed = await window.api.saveGenerationStage(replayId, {
            ...activeStage,
            status: controller.signal.aborted ? 'aborted' : 'failed',
            durationMs: Date.now() - activeStage.startedAt,
            output: replayOutput,
            error: controller.signal.aborted
              ? 'Aborted by the author.'
              : (reproductionError as Error).message,
          })
          rememberGenerationRun(failed, false)
        } catch (recordError) {
          console.warn('[generation-evidence] failed to persist reproduction failure:', recordError)
        }
      }
      if (!controller.signal.aborted) {
        setError('Run reproduction failed: ' + (reproductionError as Error).message)
      }
    } finally {
      runningRef.current = false
      setReproducingRunId(null)
    }
  }

  // ---- Send. ----

  const run = async (q: string): Promise<void> => {
    if (!q.trim()) return
    if (loading || runningRef.current) return
    runningRef.current = true

    // Save current system prompt to localStorage.
    if (canEditPrompt && sysPrompt !== getConfigPrompt(mode, config)) {
      saveCustomPrompt(mode, sysPrompt)
    }

    setLoading(true)
    setError('')
    setAnswer('')
    const controller = new AbortController()
    abortRef.current = controller
    const baseProvider =
      (mode !== 'polish' ? config?.writing?.providerId : null) ??
      config?.ai.activeProviderId ??
      undefined
    const draftProvider = baseProvider
    // Writing mode passes temperature/topP; polish uses upstream defaults.
    const temperature = mode !== 'polish' ? config?.writing?.temperature : undefined
    const topP = mode !== 'polish' ? config?.writing?.topP : undefined
    let generationRunId: string | null = null
    const stageState: { current: GenerationStage | null; output: string } = {
      current: null,
      output: '',
    }
    const onChunk = (type: 'reasoning' | 'content', text: string): void => {
      if (type === 'content') {
        stageState.output += text
        setAnswer((a) => a + text)
      }
    }
    const beginStage = async (stage: GenerationStage): Promise<void> => {
      if (!generationRunId) return
      stageState.current = stage
      stageState.output = ''
      const saved = await window.api.saveGenerationStage(generationRunId, stage)
      rememberGenerationRun(saved)
    }
    const finishStage = async (
      patch: Pick<GenerationStage, 'status' | 'durationMs' | 'finishReason' | 'usage' | 'error'>,
    ): Promise<void> => {
      if (!generationRunId || !stageState.current) return
      const saved = { ...stageState.current, ...patch, output: stageState.output }
      const run = await window.api.saveGenerationStage(generationRunId, saved)
      rememberGenerationRun(run)
      stageState.current = null
      stageState.output = ''
    }
    try {
      const draftMessages = buildMessages(q)
      if (mode === 'outline-write') {
        generationRunId = uid('gr_')
        const created = await window.api.createGenerationRun({
          id: generationRunId,
          chapterId,
          chapterTitle,
        })
        rememberGenerationRun(created)
        const provider = resolveProviderSnapshot(draftProvider)
        await beginStage({
          id: 'draft',
          kind: 'draft',
          partIndex: 1,
          partTotal: 1,
          status: 'running',
          promptVersion: 'source-outline-draft-v2',
          promptHash: '',
          messages: draftMessages,
          contextLayers: [
            ...sharedEvidenceLayers(sysPrompt),
            { key: 'chapter-title', label: 'Chapter title', content: chapterTitle },
            {
              key: 'author-instructions',
              label: 'Author instructions',
              content: q || PROMPTS.assist.context.outline.defaultInstruction,
            },
          ],
          provider,
          parameters: {
            temperature: temperature ?? null,
            topP: topP ?? null,
            maxTokens:
              config?.ai.providers.find((item) => item.id === provider.id)?.maxTokens ?? null,
            disableThinking: true,
          },
          startedAt: Date.now(),
          durationMs: null,
          finishReason: null,
          usage: {
            source: 'unavailable',
            inputTokens: null,
            outputTokens: null,
            totalTokens: null,
          },
          output: '',
          error: null,
        })
      }
      // The source draft owns plot, character behavior, and prose quality.
      const draftResult = await chatStream(
        draftMessages,
        draftProvider,
        onChunk,
        controller.signal,
        temperature,
        topP,
        true,
      )
      if (mode === 'outline-write' && stageState.current) {
        await finishStage({
          status: draftResult.completed ? 'completed' : 'incomplete',
          durationMs: Date.now() - stageState.current.startedAt,
          finishReason: draftResult.finishReason,
          usage: draftResult.usage,
          error: null,
        })
      }
      // Non-outline modes are single-pass: nothing more to do.
      if (mode !== 'outline-write') return
      if (!draftResult.completed) {
        setError(
          'Draft generation was cut off (likely truncated by the model). Review the partial draft before inserting it.',
        )
      }
    } catch (e) {
      if (generationRunId && stageState.current) {
        const failedStage = stageState.current
        try {
          const saved = await window.api.saveGenerationStage(generationRunId, {
            ...failedStage,
            status: controller.signal.aborted ? 'aborted' : 'failed',
            durationMs: Date.now() - failedStage.startedAt,
            output: stageState.output,
            error: controller.signal.aborted ? 'Aborted by the author.' : (e as Error).message,
          })
          rememberGenerationRun(saved)
        } catch (recordError) {
          console.warn('[generation-evidence] failed to persist stage failure:', recordError)
        }
        stageState.current = null
      }
      if (!controller.signal.aborted) {
        setError((e as Error).message)
        toastError(parseAiError(e))
      }
    } finally {
      runningRef.current = false
      setLoading(false)
    }
  }

  const stop = (): void => {
    abortRef.current?.abort()
    setLoading(false)
  }

  const applyGeneratedText = async (): Promise<void> => {
    // Keep the manuscript's paragraph-indent convention: rewritten text replaces
    // indented paragraphs and appended text joins an indented chapter, so the
    // result must carry the same leading indentation as the text it touches.
    const indentSource = mode === 'rewrite' ? selectedText || content : content
    const text = applyParagraphIndent(indentSource, stripBlankLines(answer))
    let evidence: GenerationInsertEvidence | undefined
    if (mode === 'outline-write') {
      if (!currentRun) {
        setError('The generation record is unavailable, so this result was not applied.')
        return
      }
      const stageIds = currentRun.stages
        .filter((stage) => stage.kind === 'draft')
        .map((stage) => stage.id)
      setSelectionSaving(true)
      try {
        const saved = await window.api.selectGenerationResult(currentRun.id, {
          kind: 'draft',
          stageIds,
          text,
        })
        rememberGenerationRun(saved)
        evidence = {
          runId: saved.id,
          editingStartedAt: saved.selectedResult?.selectedAt ?? Date.now(),
        }
      } catch (selectionError) {
        const message = (selectionError as Error).message
        setError(message)
        toastError('Failed to record the selected generation result: ' + message)
        return
      } finally {
        setSelectionSaving(false)
      }
    }
    onInsert(text, evidence)
    setAnswer('')
  }

  // ---- Title & icon. ----

  const header = (() => {
    switch (mode) {
      case 'outline-write':
        return { title: 'Write from Outline', Icon: BookOpen }
      case 'rewrite':
        return {
          title: selectedText
            ? `Rewrite Chapter${PROMPTS.assist.context.selectedTitleSuffix}`
            : 'Rewrite Chapter',
          Icon: RefreshCw,
        }
      case 'polish':
        return {
          title: selectedText
            ? `${polish.title}${PROMPTS.assist.context.selectedTitleSuffix}`
            : polish.title,
          Icon: null,
        }
    }
  })()

  // Polish applies the paragraph-indent convention to the result up front, so
  // both the diff preview and the inserted text match the manuscript (an
  // indented selection stays indented after the rewrite).
  const polishOriginal = selectedText || content.slice(0, 6000)
  const polishResult =
    mode === 'polish' ? applyParagraphIndent(polishOriginal, stripBlankLines(answer)) : ''

  // ---- Render. ----

  return (
    <div className="w-80 shrink-0 border-l border-ink-800 bg-ink-900 flex flex-col">
      {/* 头部 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-ink-800">
        <span className="text-sm font-medium text-star-info flex items-center gap-2">
          {header.Icon && <header.Icon size={15} />}
          {header.title}
        </span>
        <button onClick={onClose} className="icon-btn hover:text-ink-body" title="Close AI panel">
          <X size={16} />
        </button>
      </div>

      {!hasKey ? (
        <div className="p-4 text-xs text-ink-500 leading-relaxed">
          No AI provider configured yet. Add an API key under Settings first.
        </div>
      ) : mode === 'polish' ? (
        /* ---- Polish mode (keeps existing UI). ---- */
        <>
          <div className="p-3 space-y-1.5 border-b border-ink-800">
            {polish.quickPrompts.map((p) => (
              <button
                key={p}
                onClick={() => {
                  setPrompt(p)
                  run(p)
                }}
                className="btn btn-sm btn-ghost w-full justify-start text-left text-xs font-normal"
              >
                {p}
              </button>
            ))}
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto p-4">
            {loading && !answer && (
              <div className="flex items-center gap-2 text-ink-500 text-sm">
                <Loader2 size={15} className="animate-spin" /> Thinking…
              </div>
            )}
            {error && <div className="text-xs text-star-danger leading-relaxed">{error}</div>}
            {answer && (
              <div className="space-y-3">
                {!loading ? (
                  <DiffView
                    original={polishOriginal}
                    revised={polishResult}
                    onAccept={() => {
                      onInsert(polishResult)
                      // Drop the consumed result so it cannot be re-applied as a
                      // full-chapter overwrite after a selection was replaced.
                      setAnswer('')
                    }}
                    onReject={() => setAnswer('')}
                  />
                ) : (
                  <div className="text-sm text-ink-muted whitespace-pre-wrap leading-relaxed">
                    {answer}
                    <span className="inline-block w-1.5 h-4 bg-star-info/60 animate-pulse align-middle ml-0.5" />
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="p-3 border-t border-ink-800">
            <div className="relative">
              <AutoResizeTextarea
                className="textarea min-h-24 max-h-48 resize-none overflow-y-auto pr-10 text-sm"
                placeholder="Ask the AI, press Enter to send…"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    run(prompt)
                  }
                }}
              />
              {loading ? (
                <button
                  onClick={stop}
                  className="icon-btn absolute right-2 bottom-2 text-star-danger hover:brightness-90"
                  title="Stop generating"
                >
                  <Square size={16} />
                </button>
              ) : (
                <button
                  onClick={() => run(prompt)}
                  className="icon-btn absolute right-2 bottom-2 text-star-info hover:text-star-accent"
                  title="Send prompt"
                >
                  <Send size={16} />
                </button>
              )}
            </div>
          </div>
        </>
      ) : (
        /* ---- Outline.编写 / 改写（共用结构） ---- */
        <>
          {/* 上下文区域 */}
          <div className="p-3 border-b border-ink-800 text-xs text-ink-500 leading-relaxed space-y-1">
            {mode === 'outline-write' && (
              <div className="border border-ink-800 rounded-md px-2.5 py-2 space-y-1 mb-2">
                <div className="text-star-info font-medium">Source draft</div>
                <div>
                  One complete pass owns plot fidelity, believable character action, natural prose,
                  rhythm, and the chapter-end hook.
                </div>
              </div>
            )}
            {mode === 'rewrite' && (
              <div className="border border-ink-800 rounded-md px-2.5 py-2 space-y-1 mb-2">
                {selectedText ? (
                  <>
                    <div className="text-star-info font-medium">Selection mode</div>
                    <div>
                      Only the selected passage is sent and replaced — the rest of the chapter stays
                      untouched.
                    </div>
                  </>
                ) : (
                  <>
                    <div className="text-star-info font-medium">Full-chapter mode</div>
                    <div>
                      No text selected — the rewritten text replaces the entire chapter. Select text
                      in the editor first to rewrite only part of it.
                    </div>
                  </>
                )}
              </div>
            )}
            {outlineCtx.loading ? (
              <span className="flex items-center gap-2">
                <Loader2 size={13} className="animate-spin" /> Loading context…
              </span>
            ) : (
              <>
                <div>Context ready:</div>
                <ul className="list-disc list-inside space-y-0.5">
                  <li>{outlineCtx.settings ? 'Codex settings loaded' : 'No codex settings'}</li>
                  <li>Outline loaded ({outlineCtx.outline.length.toLocaleString()} chars)</li>
                  <li>
                    {outlineCtx.memoryCount > 0 ? (
                      <span className="inline-flex items-center gap-1 text-star-info">
                        <Brain size={12} /> {outlineCtx.memoryCount} confirmed story memor
                        {outlineCtx.memoryCount === 1 ? 'y' : 'ies'} included
                      </span>
                    ) : (
                      'No confirmed story memories'
                    )}
                  </li>
                  <li>
                    {outlineCtx.prevChapters ? 'Previous chapters loaded' : 'No previous chapters'}
                  </li>
                  {mode === 'rewrite' &&
                    (selectedText ? selectedText.length : content.length) > 8000 && (
                      <li className="text-star-accent">
                        ⚠ {selectedText ? 'Selected passage' : 'Chapter'} exceeds 8000 chars — only
                        the first 8000 are sent to the model.
                      </li>
                    )}
                  {outlineCtx.truncated && (
                    <li className="text-star-accent">
                      ⚠ Context truncated — budget exceeded. Earlier chapters / settings omitted.
                    </li>
                  )}
                </ul>
              </>
            )}
          </div>

          {/* Editable system prompts. */}
          <div className="border-b border-ink-800">
            <button
              onClick={() => setShowSysPrompt((v) => !v)}
              className="flex items-center gap-1.5 w-full px-4 py-2 text-xs text-ink-500 hover:text-ink-muted transition-colors"
            >
              <Settings2 size={12} />
              System Prompt
              {isCustomized && <span className="w-1.5 h-1.5 rounded-full bg-star-accent" />}
              <span className="ml-auto text-[11px]">{showSysPrompt ? '▲' : '▼'}</span>
            </button>
            {showSysPrompt && (
              <div className="px-4 pb-3 space-y-2">
                <textarea
                  className="textarea min-h-24 resize-y text-[11px] leading-relaxed font-mono"
                  value={sysPrompt}
                  onChange={(e) => setSysPrompt(e.target.value)}
                  onBlur={() => {
                    const base = getConfigPrompt(mode, config)
                    if (sysPrompt !== base) {
                      saveCustomPrompt(mode, sysPrompt)
                    } else {
                      clearCustomPrompt(mode)
                    }
                  }}
                />
                <button
                  onClick={resetSysPrompt}
                  className="flex items-center gap-1 text-[11px] text-ink-500 hover:text-star-accent transition-colors"
                >
                  <RotateCcw size={10} /> Reset to default
                </button>
              </div>
            )}
          </div>

          {/* 输出区 */}
          <div className="flex-1 min-h-0 overflow-y-auto p-4">
            {loading && !answer && (
              <div className="flex items-center gap-2 text-ink-500 text-sm">
                <Loader2 size={15} className="animate-spin" />
                Writing…
              </div>
            )}
            {error && <div className="text-xs text-star-danger leading-relaxed">{error}</div>}
            {answer && (
              <div className="space-y-3">
                <div className="text-sm text-ink-muted whitespace-pre-wrap leading-relaxed">
                  {answer}
                  {loading && (
                    <span className="inline-block w-1.5 h-4 bg-star-info/60 animate-pulse align-middle ml-0.5" />
                  )}
                </div>
                {!loading && (
                  <button
                    onClick={() => void applyGeneratedText()}
                    disabled={selectionSaving}
                    className="btn btn-sm btn-secondary"
                  >
                    {selectionSaving ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <CornerDownLeft size={13} />
                    )}{' '}
                    {mode === 'rewrite'
                      ? selectedText
                        ? 'Replace selection'
                        : 'Replace chapter'
                      : 'Append to document'}
                  </button>
                )}
              </div>
            )}
          </div>

          {mode === 'outline-write' && (
            <GenerationEvidencePanel
              runs={runHistory}
              selectedRun={inspectedRun}
              currentRunId={currentRun?.id ?? null}
              loading={runHistoryLoading}
              reproducingRunId={reproducingRunId}
              onSelect={inspectGenerationRun}
              onReproduce={(run) => void reproduceGenerationRun(run)}
              onStopReproduction={() => abortRef.current?.abort()}
            />
          )}

          {/* 输入区 */}
          <div className="p-3 border-t border-ink-800">
            <div className="relative">
              <AutoResizeTextarea
                className="textarea min-h-24 max-h-48 resize-none overflow-y-auto pr-10 text-sm"
                placeholder={
                  mode === 'rewrite'
                    ? 'Describe what to add, cut, or change, then press Enter…'
                    : 'Describe what to write, then press Enter…'
                }
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    run(prompt)
                  }
                }}
              />
              {loading ? (
                <button
                  onClick={stop}
                  className="icon-btn absolute right-2 bottom-2 text-star-danger hover:brightness-90"
                  title="Stop generating"
                >
                  <Square size={16} />
                </button>
              ) : (
                <button
                  onClick={() => run(prompt)}
                  className="icon-btn absolute right-2 bottom-2 text-star-info hover:text-star-accent"
                  title="Send prompt"
                >
                  <Send size={16} />
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
