import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  BrainCircuit,
  CheckCircle2,
  FileText,
  Loader2,
  RefreshCw,
  RotateCcw,
  Square,
  Trash2,
} from 'lucide-react'
import { chatStream } from '../api'
import { useStore } from '../store'
import { toastError, toastSuccess, parseAiError } from '../toast'
import { PROMPTS } from '@shared/prompts'
import { orderedChapters, storyMemoryFingerprint } from '@shared/storyMemory'
import { parseChapterSummaryPayload, rebuildStoryState } from '@shared/chapterMemory'
import type { ChapterSummary, StoryState } from '@shared/types'
import clsx from 'clsx'

type ChapterItem = ReturnType<typeof orderedChapters>[number]

/**
 * Chapter Memory: per-chapter AI summaries + the accumulated story-state
 * archive that the writing panel injects as layered context. Summaries are
 * generated on demand (never automatically); each generation rewrites the
 * story-state archive purely from code, so it can never contradict the
 * summaries it was built from.
 */
export default function ChapterMemory(): JSX.Element {
  const novel = useStore((s) => s.novel)!
  const config = useStore((s) => s.config)
  const focusChapterId = useStore((s) => s.chapterMemoryFocusChapterId)
  const openChapter = useStore((s) => s.openChapter)

  const chapters = useMemo(() => orderedChapters(novel), [novel])
  const [summaries, setSummaries] = useState<ChapterSummary[]>([])
  const [storyState, setStoryState] = useState<StoryState | null>(null)
  const [sourceTexts, setSourceTexts] = useState<Map<string, string>>(new Map())
  const [selectedChapterId, setSelectedChapterId] = useState('')
  const [, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [generatingId, setGeneratingId] = useState<string | null>(null)
  const [bulkGenerating, setBulkGenerating] = useState(false)
  const [rebuilding, setRebuilding] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const hasKey = Boolean(config?.ai.providers.some((provider) => provider.apiKey))
  const selected = chapters.find((item) => item.chapter.id === selectedChapterId) ?? null
  const summaryByChapter = useMemo(
    () => new Map(summaries.map((s) => [s.chapterId, s])),
    [summaries],
  )

  const isStale = useCallback(
    (chapterId: string): boolean => {
      const summary = summaryByChapter.get(chapterId)
      if (!summary) return false
      const text = sourceTexts.get(chapterId)
      return text === undefined || storyMemoryFingerprint(text) !== summary.sourceFingerprint
    },
    [sourceTexts, summaryByChapter],
  )

  const statusOf = (chapterId: string): 'none' | 'fresh' | 'stale' => {
    if (!summaryByChapter.has(chapterId)) return 'none'
    return isStale(chapterId) ? 'stale' : 'fresh'
  }

  const selectedSummary = selected ? (summaryByChapter.get(selected.chapter.id) ?? null) : null

  const refresh = useCallback(async (): Promise<void> => {
    const list = await window.api.listChapterSummaries()
    const state: StoryState | null = await window.api.readStoryState().catch(() => null)
    setSummaries(list)
    setStoryState(state)
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError('')
    ;(async () => {
      try {
        // Load every saved chapter once so staleness can be detected cheaply.
        const texts = new Map<string, string>()
        await Promise.all(
          chapters.map(async (item) => {
            try {
              texts.set(item.chapter.id, await window.api.readChapter(item.chapter.file))
            } catch {
              texts.set(item.chapter.id, '')
            }
          }),
        )
        const list = await window.api.listChapterSummaries()
        let state: StoryState | null = null
        try {
          state = await window.api.readStoryState()
        } catch {
          state = null
        }
        if (cancelled) return
        setSourceTexts(texts)
        setSummaries(list)
        setStoryState(state)
        setSelectedChapterId((current) => {
          if (chapters.some((item) => item.chapter.id === current)) return current
          if (focusChapterId && chapters.some((item) => item.chapter.id === focusChapterId)) {
            return focusChapterId
          }
          return chapters[0]?.chapter.id || ''
        })
      } catch (error) {
        if (!cancelled) setLoadError((error as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [chapters, focusChapterId])

  const persistGenerated = async (item: ChapterItem, prose: string): Promise<void> => {
    const { content } = await chatStream(
      [
        { role: 'system', content: PROMPTS.chapterSummary.systemPrompt },
        {
          role: 'user',
          content: PROMPTS.chapterSummary.userTemplate({
            chapterTitle: item.chapter.title,
            prose,
          }),
        },
      ],
      config?.writing.providerId ?? config?.ai.activeProviderId ?? undefined,
      () => {},
      abortRef.current?.signal,
      config?.writing.temperature,
      config?.writing.topP,
    )
    if (abortRef.current?.signal.aborted) return
    const parsed = parseChapterSummaryPayload(content)
    if (!parsed.summary.trim()) {
      throw new Error('The AI returned an empty chapter summary — try again.')
    }
    const summary: ChapterSummary = {
      chapterId: item.chapter.id,
      chapterTitle: item.chapter.title,
      sourceFingerprint: storyMemoryFingerprint(prose),
      generatedAt: Date.now(),
      summary: parsed.summary,
      endState: parsed.endState,
      stateChanges: parsed.stateChanges,
      plantedThreads: parsed.plantedThreads,
      resolvedThreads: parsed.resolvedThreads,
    }
    await window.api.writeChapterSummary(summary)
    // Rebuild the archive from all summaries — code-only, so the archive
    // always matches the summaries it was accumulated from.
    const all = await window.api.listChapterSummaries()
    const rebuilt = rebuildStoryState(all)
    await window.api.writeStoryState(rebuilt)
    setSummaries(all)
    setStoryState(rebuilt)
  }

  const generate = async (item: ChapterItem): Promise<void> => {
    const existing = summaryByChapter.get(item.chapter.id)
    if (existing && !isStale(item.chapter.id)) {
      if (
        !confirm(
          `"${item.chapter.title}" already has a fresh summary. Regenerate it anyway? This calls the AI again.`,
        )
      ) {
        return
      }
    }
    const prose = sourceTexts.get(item.chapter.id) ?? ''
    if (!prose.trim()) {
      toastError('This saved chapter is empty — write and save it first.')
      return
    }
    setGeneratingId(item.chapter.id)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      await persistGenerated(item, prose)
      toastSuccess(`Summary generated for "${item.chapter.title}".`)
    } catch (error) {
      if (!controller.signal.aborted) toastError(parseAiError(error))
    } finally {
      if (abortRef.current === controller) abortRef.current = null
      setGeneratingId(null)
    }
  }

  const generateBulk = async (): Promise<void> => {
    const pending = chapters.filter((item) => statusOf(item.chapter.id) !== 'fresh')
    if (pending.length === 0) {
      toastSuccess('Every chapter already has a fresh summary.')
      return
    }
    if (
      !confirm(
        `Generate summaries for ${pending.length} chapter${pending.length === 1 ? '' : 's'} now? This calls the AI once per chapter.`,
      )
    ) {
      return
    }
    setBulkGenerating(true)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      for (const item of pending) {
        if (controller.signal.aborted) break
        const prose = sourceTexts.get(item.chapter.id) ?? ''
        if (!prose.trim()) continue
        setGeneratingId(item.chapter.id)
        await persistGenerated(item, prose)
      }
      if (!controller.signal.aborted) {
        toastSuccess('Bulk summary generation finished.')
      }
    } catch (error) {
      if (!controller.signal.aborted) toastError(parseAiError(error))
    } finally {
      if (abortRef.current === controller) abortRef.current = null
      setGeneratingId(null)
      setBulkGenerating(false)
    }
  }

  const rebuildState = async (): Promise<void> => {
    if (rebuilding) return
    setRebuilding(true)
    try {
      const all = await window.api.listChapterSummaries()
      const rebuilt = rebuildStoryState(all)
      await window.api.writeStoryState(rebuilt)
      setStoryState(rebuilt)
      toastSuccess('Story state archive rebuilt from chapter summaries.')
    } catch (error) {
      toastError('Failed to rebuild story state: ' + (error as Error).message)
    } finally {
      setRebuilding(false)
    }
  }

  const remove = async (item: ChapterItem): Promise<void> => {
    if (
      !confirm(
        `Delete the summary for "${item.chapter.title}"? The story state archive will be rebuilt without it.`,
      )
    ) {
      return
    }
    try {
      await window.api.deleteChapterSummary(item.chapter.id)
      await refresh()
      toastSuccess('Summary deleted.')
    } catch (error) {
      toastError('Failed to delete summary: ' + (error as Error).message)
    }
  }

  const stop = (): void => {
    abortRef.current?.abort()
  }

  const working = generatingId !== null || bulkGenerating
  const summaryCount = summaries.length
  const staleCount = chapters.filter((item) => statusOf(item.chapter.id) === 'stale').length
  const missingCount = chapters.filter((item) => statusOf(item.chapter.id) === 'none').length

  return (
    <div className="flex h-full min-h-0">
      <aside className="w-64 shrink-0 border-r border-ink-800 flex flex-col min-h-0 bg-ink-900">
        <div className="p-3 border-b border-ink-800">
          <div className="flex items-center gap-2 text-sm font-semibold text-ink-deep">
            <BrainCircuit size={15} /> Chapter Memory
          </div>
          <p className="text-[10px] text-ink-500 mt-1 leading-relaxed">
            {summaryCount} summarized · {missingCount} missing · {staleCount} stale
          </p>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {chapters.map((item) => {
            const status = statusOf(item.chapter.id)
            return (
              <button
                key={item.chapter.id}
                onClick={() => setSelectedChapterId(item.chapter.id)}
                className={clsx(
                  'w-full text-left rounded-md px-3 py-2.5 transition-colors',
                  selectedChapterId === item.chapter.id
                    ? 'bg-ink-700 text-ink-body'
                    : 'text-ink-muted hover:bg-ink-850',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm truncate">{item.chapter.title}</div>
                  {status === 'fresh' && (
                    <CheckCircle2 size={13} className="text-star-accent shrink-0" />
                  )}
                  {status === 'stale' && (
                    <AlertTriangle size={13} className="text-star-info shrink-0" />
                  )}
                </div>
                <div className="text-[10px] text-ink-500 mt-0.5">
                  {status === 'none' && 'No summary'}
                  {status === 'fresh' && 'Fresh'}
                  {status === 'stale' && 'Prose changed — regenerate'}
                </div>
              </button>
            )
          })}
        </div>
      </aside>

      <main className="flex-1 min-w-0 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-8 py-8">
          {chapters.length === 0 ? (
            <div className="text-center py-24 text-ink-500">
              Create a chapter before building Chapter Memory.
            </div>
          ) : (
            <>
              <div className="flex items-start justify-between gap-4 mb-8">
                <div>
                  <h1 className="text-xl font-semibold text-ink-deep">
                    {selected ? selected.chapter.title : 'Chapter Memory'}
                  </h1>
                  <p className="text-sm text-ink-500 mt-1">
                    Each chapter gets an AI summary; the story-state archive is accumulated from
                    them in code and injected into AI writing as layered context. Nothing runs
                    automatically.
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {working ? (
                    <button onClick={stop} className="btn btn-danger">
                      <Square size={15} /> Stop
                    </button>
                  ) : (
                    <>
                      <button
                        onClick={() => generateBulk()}
                        disabled={!hasKey || missingCount + staleCount === 0}
                        className="btn btn-sm btn-secondary"
                        title="Generate summaries for every missing or stale chapter"
                      >
                        <RefreshCw size={13} /> Generate missing ({missingCount + staleCount})
                      </button>
                      {selected && (
                        <button
                          onClick={() => generate(selected)}
                          disabled={!hasKey || !(sourceTexts.get(selected.chapter.id) ?? '').trim()}
                          className="btn btn-sm btn-primary"
                        >
                          {statusOf(selected.chapter.id) === 'none'
                            ? 'Generate summary'
                            : 'Regenerate'}
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>

              {!hasKey && (
                <p className="text-sm text-star-danger mb-6">
                  Configure an AI provider before generating summaries.
                </p>
              )}
              {loadError && (
                <p className="text-sm text-star-danger mb-6">
                  Failed to load chapter memory: {loadError}
                </p>
              )}

              {/* Story-state archive preview */}
              <section className="rounded-lg border border-ink-800 bg-ink-900/40 p-4 mb-8">
                <div className="flex items-center justify-between gap-3 mb-3">
                  <div>
                    <h2 className="text-sm font-semibold text-ink-deep">Story state archive</h2>
                    <p className="text-xs text-ink-500 mt-0.5">
                      Hard constraints injected into AI writing for the next chapter.
                      {storyState?.upToChapterId &&
                        ' Up to: ' +
                          (summaryByChapter.get(storyState.upToChapterId)?.chapterTitle ??
                            storyState.upToChapterId)}
                    </p>
                  </div>
                  <button
                    onClick={rebuildState}
                    disabled={rebuilding}
                    className="btn btn-sm btn-secondary"
                    title="Rebuild the archive from all summaries (no AI call)"
                  >
                    <RotateCcw size={13} />
                    {rebuilding ? 'Rebuilding…' : 'Rebuild'}
                  </button>
                </div>
                {storyState &&
                (storyState.characters.length > 0 ||
                  storyState.worldState.length > 0 ||
                  storyState.openThreads.length > 0 ||
                  storyState.currentEndState) ? (
                  <div className="space-y-2 text-sm text-ink-body">
                    {storyState.currentEndState && (
                      <p className="text-xs text-ink-500">
                        <span className="text-ink-deep font-medium">Scene:</span>{' '}
                        {storyState.currentEndState}
                      </p>
                    )}
                    {storyState.characters.map((char) => {
                      const facts = [
                        char.condition && `condition: ${char.condition}`,
                        char.location && `location: ${char.location}`,
                        char.possessions && `possessions: ${char.possessions}`,
                        char.goals && `goals: ${char.goals}`,
                        char.relations && `relations: ${char.relations}`,
                        char.knows && `knows: ${char.knows}`,
                      ].filter(Boolean)
                      return facts.length > 0 ? (
                        <p key={char.name}>
                          <span className="text-ink-deep font-medium">{char.name}:</span>{' '}
                          {facts.join(' · ')}
                        </p>
                      ) : null
                    })}
                    {storyState.worldState.map((ws, i) => (
                      <p key={i}>
                        <span className="text-ink-deep font-medium">World:</span> {ws}
                      </p>
                    ))}
                    {storyState.openThreads.length > 0 && (
                      <div className="pt-1">
                        <div className="text-xs text-ink-500 mb-1">Unresolved hooks:</div>
                        {storyState.openThreads.map((thread, i) => (
                          <p key={i} className="text-xs text-ink-muted">
                            · {thread}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-ink-500">
                    No summaries yet — generate at least one chapter summary to build the archive.
                  </p>
                )}
              </section>

              {/* Selected chapter summary detail */}
              {selected && (
                <section>
                  {generatingId === selected.chapter.id && (
                    <div className="flex items-center gap-2 text-sm text-ink-muted mb-4">
                      <Loader2 size={15} className="animate-spin" /> Summarizing chapter…
                    </div>
                  )}
                  {!selectedSummary && generatingId !== selected.chapter.id && (
                    <div className="text-center py-12 text-ink-500">
                      <FileText size={28} className="mx-auto mb-2 opacity-60" />
                      No summary for this chapter yet. Generate one after the chapter is saved.
                    </div>
                  )}
                  {selectedSummary && (
                    <div className="space-y-4">
                      <div className="rounded-lg border border-ink-800 bg-ink-900/40 p-4">
                        <div className="flex items-center justify-between gap-3 mb-2">
                          <h2 className="text-sm font-semibold text-ink-deep">Summary</h2>
                          <span className="text-[10px] text-ink-500">
                            {new Date(selectedSummary.generatedAt).toLocaleString()}
                            {isStale(selected.chapter.id) && (
                              <span className="text-star-info ml-2">· stale — regenerate</span>
                            )}
                          </span>
                        </div>
                        <p className="text-sm text-ink-body leading-relaxed">
                          {selectedSummary.summary}
                        </p>
                      </div>

                      {selectedSummary.endState && (
                        <div className="rounded-lg border border-ink-800 bg-ink-900/40 p-4">
                          <h2 className="text-sm font-semibold text-ink-deep mb-2">End state</h2>
                          <p className="text-sm text-ink-body leading-relaxed">
                            {selectedSummary.endState}
                          </p>
                        </div>
                      )}

                      {selectedSummary.stateChanges.length > 0 && (
                        <div className="rounded-lg border border-ink-800 bg-ink-900/40 p-4">
                          <h2 className="text-sm font-semibold text-ink-deep mb-2">
                            State changes ({selectedSummary.stateChanges.length})
                          </h2>
                          <ul className="space-y-1 text-sm text-ink-body">
                            {selectedSummary.stateChanges.map((change, i) => (
                              <li key={i} className="flex items-start gap-2">
                                <span
                                  className={clsx(
                                    'text-[10px] px-1.5 py-0.5 rounded shrink-0 mt-0.5',
                                    change.permanent
                                      ? 'bg-star-danger/15 text-star-danger'
                                      : 'bg-ink-800 text-ink-500',
                                  )}
                                >
                                  {change.permanent ? 'HARD' : 'soft'}
                                </span>
                                <span>
                                  <span className="text-ink-deep">{change.entity}</span>
                                  <span className="text-ink-500"> / {change.aspect}: </span>
                                  {change.change}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {(selectedSummary.plantedThreads.length > 0 ||
                        selectedSummary.resolvedThreads.length > 0) && (
                        <div className="rounded-lg border border-ink-800 bg-ink-900/40 p-4">
                          <h2 className="text-sm font-semibold text-ink-deep mb-2">Threads</h2>
                          {selectedSummary.plantedThreads.length > 0 && (
                            <div className="mb-2">
                              <div className="text-xs text-ink-500 mb-1">Planted:</div>
                              {selectedSummary.plantedThreads.map((thread, i) => (
                                <p key={i} className="text-sm text-ink-body">
                                  · {thread}
                                </p>
                              ))}
                            </div>
                          )}
                          {selectedSummary.resolvedThreads.length > 0 && (
                            <div>
                              <div className="text-xs text-ink-500 mb-1">Resolved:</div>
                              {selectedSummary.resolvedThreads.map((thread, i) => (
                                <p key={i} className="text-sm text-ink-body">
                                  · {thread}
                                </p>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      <div className="flex justify-end">
                        <button
                          onClick={() => remove(selected)}
                          disabled={working}
                          className="btn btn-sm btn-ghost text-ink-500 hover:text-star-danger"
                        >
                          <Trash2 size={13} /> Delete summary
                        </button>
                      </div>
                    </div>
                  )}
                </section>
              )}

              <div className="mt-8 pt-4 border-t border-ink-800 flex items-center justify-between">
                <p className="text-xs text-ink-500">
                  Summaries are stored in <code className="text-ink-muted">chapter-memory/</code>{' '}
                  and exported with the world.
                </p>
                {selected && (
                  <button
                    onClick={() => openChapter(selected.chapter.id)}
                    className="btn btn-sm btn-ghost"
                    title="Open the chapter in the editor"
                  >
                    Open chapter
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  )
}
