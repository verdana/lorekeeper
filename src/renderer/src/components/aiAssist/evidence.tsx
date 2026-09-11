/**
 * The generation-evidence drawer: what past runs of this chapter actually sent
 * and received, and the controls to inspect or reproduce one.
 */

import { useEffect, useRef, useState, type TextareaHTMLAttributes } from 'react'
import type { GenerationRun, GenerationRunSummary, GenerationStage } from '@shared/types'

import { X, Loader2, RefreshCw, Database } from 'lucide-react'

import { formatTime } from '../../lib'

/** Strip blank lines between paragraphs in LLM output so it matches original style. */
export function stripBlankLines(text: string): string {
  return text.replace(/\n{2,}/g, '\n').trim()
}

/**
 * Prompt input that grows with its content, capped at `max-h-*` via CSS so the
 * panel never balloons. Resets to the min height when the value shrinks.
 */
export function AutoResizeTextarea(
  props: TextareaHTMLAttributes<HTMLTextAreaElement>,
): JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${el.scrollHeight}px`
  }, [props.value])
  return <textarea ref={ref} {...props} />
}

export const generationRunSummary = (run: GenerationRun): GenerationRunSummary => ({
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

export function GenerationEvidencePanel({
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
