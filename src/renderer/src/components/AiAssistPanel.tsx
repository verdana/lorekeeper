import { useEffect, useRef, useState } from 'react'
import type {
  GenerationContextLayer,
  GenerationProviderSnapshot,
  GenerationRun,
  GenerationRunSummary,
  GenerationStage,
} from '@shared/types'

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
} from 'lucide-react'
import { useStore } from '../store'
import { chatStream } from '../api'
import { toastError, parseAiError } from '../toast'
import { PROMPTS } from '@shared/prompts'
import DiffView from './DiffView'

import {
  uid,
  applyParagraphIndent,
  extractBodyFromAnswer,
  planRewriteSource,
  planPolishSource,
  REWRITE_SOURCE_LIMIT,
  POLISH_SOURCE_LIMIT,
} from '../lib'
import { buildWritingSystemPrompt } from '../writingStyle'
import {
  SETTING_ASSIST,
  clearCustomPrompt,
  getConfigPrompt,
  loadCustomPrompt,
  polishTooLongMessage,
  rewriteTooLongMessage,
  saveCustomPrompt,
} from './aiAssist/prompts'
import { useOutlineContext } from './aiAssist/context'
import {
  AutoResizeTextarea,
  GenerationEvidencePanel,
  generationRunSummary,
  stripBlankLines,
} from './aiAssist/evidence'
import type { GenerationInsertEvidence, Props } from './aiAssist/types'

// The panel's public surface stays here: its consumers import the component,
// the codex preset and the built-in prompt templates from this module.
export { SETTING_ASSIST, BUILTIN_OUTLINE_PROMPT, BUILTIN_REWRITE_PROMPT } from './aiAssist/prompts'
export type { AssistPreset } from './aiAssist/prompts'
export type { GenerationInsertEvidence } from './aiAssist/types'

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
  // is active), capped for the token budget. The answer is applied in place of
  // that source, so an over-long source is refused rather than truncated —
  // see `planRewriteSource`.
  const rewritePlan =
    mode === 'rewrite'
      ? planRewriteSource(selectedText || content)
      : { target: '', truncated: false }
  const rewriteTarget = rewritePlan.target
  const rewriteSourceTruncated = rewritePlan.truncated
  // Polish has the same rule as rewrite: a pass revises the text it was given,
  // so an over-long source is refused rather than revised in part.
  const polishPlan =
    mode === 'polish' ? planPolishSource(selectedText || content) : { target: '', truncated: false }
  const polishSourceTruncated = polishPlan.truncated

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
      const target = selectedText || content
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
    // Refuse before spending a request: the answer could never be applied.
    if (rewriteSourceTruncated) {
      const message = rewriteTooLongMessage(selectedText ? 'selection' : 'chapter')
      setError(message)
      toastError(message)
      return
    }
    if (polishSourceTruncated) {
      const message = polishTooLongMessage(selectedText ? 'selection' : 'document')
      setError(message)
      toastError(message)
      return
    }
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
          promptVersion: 'source-outline-draft-v3',
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
    // Backstop for a source that grew past the cap while the panel was open:
    // the answer only covers what was sent, so it must not replace the source.
    if (rewriteSourceTruncated) {
      const message = rewriteTooLongMessage(selectedText ? 'selection' : 'chapter')
      setError(message)
      toastError(message)
      return
    }
    // Keep the manuscript's paragraph-indent convention: rewritten text replaces
    // indented paragraphs and appended text joins an indented chapter, so the
    // result must carry the same leading indentation as the text it touches.
    const indentSource = mode === 'rewrite' ? selectedText || content : content
    const text = applyParagraphIndent(indentSource, stripBlankLines(extractBodyFromAnswer(answer)))
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
  const polishOriginal = polishPlan.target
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
                      // Backstop for a document that grew past the cap while the
                      // panel was open: the revision only covers what was sent.
                      if (polishSourceTruncated) {
                        const message = polishTooLongMessage(
                          selectedText ? 'selection' : 'document',
                        )
                        setError(message)
                        toastError(message)
                        return
                      }
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
                  {rewriteSourceTruncated && (
                    <li className="text-star-danger">
                      ⚠ {selectedText ? 'Selected passage' : 'Chapter'} exceeds{' '}
                      {REWRITE_SOURCE_LIMIT} chars — only the first {REWRITE_SOURCE_LIMIT} would
                      reach the model, so the rewrite is blocked. Select a passage instead.
                    </li>
                  )}
                  {polishSourceTruncated && (
                    <li className="text-star-danger">
                      ⚠ {selectedText ? 'Selected passage' : 'Document'} exceeds{' '}
                      {POLISH_SOURCE_LIMIT} chars — only the first {POLISH_SOURCE_LIMIT} would reach
                      the model, so the polish pass is blocked. Select a passage instead.
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
