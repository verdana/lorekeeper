import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Loader2, Wand2, AlertTriangle } from 'lucide-react'
import { chatStream } from '../api'
import { toastError, toastSuccess, parseAiError } from '../toast'
import { useStore, isBatchWriteLocked } from '../store'
import DiffView from './DiffView'
import type { Chapter, ChatMessage, SettingDoc } from '@shared/types'
import clsx from 'clsx'

const APPLY_FIX_SYSTEM_PROMPT =
  'You are a continuity editor for long-form fiction. A consistency issue with a suggested fix has been identified in a document. ' +
  "Apply only the suggested fix to the document. Preserve all other content, structure, headings, and the author's voice. " +
  'Return ONLY the corrected document text, with no explanation, no markdown code fences, and no surrounding quotes.'

type ApplyTarget =
  { kind: 'doc'; id: string; title: string } | { kind: 'chapter'; file: string; title: string }

interface ApplyFixModalProps {
  issue: string
  docs: SettingDoc[]
  chapters: Chapter[]
  providerId: string | null
  onDone: () => void
  /** Fired after the fix is written, with the applied target. Used by the
   *  review queue to backfill the fixed document. */
  onApplied?: (target: { kind: 'doc' | 'chapter'; id: string; title: string }) => void
  /** Pre-resolved target from the caller (e.g. a queue item's related docs). */
  suggestedTarget?: { kind: 'doc' | 'chapter'; id: string; title: string } | null
}

type Phase =
  | { status: 'pick' }
  | { status: 'loading' }
  | { status: 'preview' }
  | { status: 'saving' }
  | { status: 'error'; message: string }

function detectTarget(issue: string, docs: SettingDoc[], chapters: Chapter[]): ApplyTarget | null {
  const candidates: ApplyTarget[] = [
    ...docs.map((d) => ({ kind: 'doc' as const, id: d.id, title: d.title })),
    ...chapters.map((c) => ({ kind: 'chapter' as const, file: c.file, title: c.title })),
  ]
  let best: ApplyTarget | null = null
  let bestScore = 0
  for (const c of candidates) {
    if (!c.title || !issue.includes(c.title)) continue
    // Prefer longer/more specific title matches to avoid false positives on short names.
    const score = c.title.length
    if (score > bestScore) {
      bestScore = score
      best = c
    }
  }
  return best
}

export default function ApplyFixModal({
  issue,
  docs,
  chapters,
  providerId,
  onDone,
  onApplied,
  suggestedTarget,
}: ApplyFixModalProps): JSX.Element {
  const [target, setTarget] = useState<ApplyTarget | null>(() => {
    if (suggestedTarget) {
      return suggestedTarget.kind === 'doc'
        ? { kind: 'doc', id: suggestedTarget.id, title: suggestedTarget.title }
        : { kind: 'chapter', file: suggestedTarget.id, title: suggestedTarget.title }
    }
    return detectTarget(issue, docs, chapters)
  })
  const [phase, setPhase] = useState<Phase>({ status: 'pick' })
  const [original, setOriginal] = useState('')
  const [revised, setRevised] = useState('')
  const abortRef = useRef<AbortController | undefined>(undefined)

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDone()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDone])

  // Abort any in-flight AI request when the modal closes.
  useEffect(() => () => abortRef.current?.abort(), [])

  // 目标文档下拉(全量列表)。
  const targetOptions = useMemo(
    () => [
      {
        label: 'Codex documents',
        items: docs.map((d) => ({ kind: 'doc' as const, id: d.id, title: d.title })),
      },
      {
        label: 'Chapters',
        items: chapters.map((c) => ({ kind: 'chapter' as const, file: c.file, title: c.title })),
      },
    ],
    [docs, chapters],
  )

  const selectedValue = target
    ? `${target.kind}:${target.kind === 'doc' ? target.id : target.file}`
    : ''

  const generateFix = async (): Promise<void> => {
    if (!target) return
    setPhase({ status: 'loading' })
    setOriginal('')
    setRevised('')
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const content =
        target.kind === 'doc'
          ? (await window.api.readSetting(target.id!)).content
          : await window.api.readChapter(target.file!)
      setOriginal(content)
      const messages: ChatMessage[] = [
        { role: 'system', content: APPLY_FIX_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Issue and suggested fix:\n${issue}\n\nOriginal document "${target.title}":\n${content}\n\nApply the fix and return the corrected document text only.`,
        },
      ]
      const { content: result } = await chatStream(
        messages,
        providerId ?? undefined,
        () => {},
        controller.signal,
      )
      if (!result.trim()) {
        throw new Error('The AI returned an empty fix. Please retry or switch to another provider.')
      }
      setRevised(result)
      setPhase({ status: 'preview' })
    } catch (e) {
      if (!controller.signal.aborted) {
        setPhase({ status: 'error', message: (e as Error).message })
        toastError(parseAiError(e))
      }
    }
  }

  const applyFix = async (): Promise<void> => {
    if (!target || !revised.trim()) return
    // Batch write owns chapter writes while active; codex docs stay editable.
    if (target.kind === 'chapter' && isBatchWriteLocked(useStore.getState())) return
    setPhase({ status: 'saving' })
    try {
      if (target.kind === 'doc') {
        await window.api.writeSetting(target.id!, revised)
      } else {
        await window.api.writeChapter(target.file!, revised)
      }
      toastSuccess(`Applied fix to "${target.title}".`)
      onApplied?.(
        target.kind === 'doc'
          ? { kind: 'doc', id: target.id, title: target.title }
          : { kind: 'chapter', id: target.file, title: target.title },
      )
      onDone()
    } catch (e) {
      setPhase({ status: 'error', message: (e as Error).message })
      toastError('Failed to write the corrected document.')
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-deep/40 p-6"
      onClick={(e) => {
        if (e.target === e.currentTarget) onDone()
      }}
    >
      <div className="w-full max-w-3xl max-h-[85vh] flex flex-col bg-ink-900 border border-ink-800 rounded-[14px] shadow-warm-lg">
        <div className="flex items-center justify-between px-5 py-4 border-b border-ink-800">
          <div className="flex items-center gap-2 text-sm font-semibold text-ink-body">
            <Wand2 size={16} className="text-star-accent" />
            Apply suggested fix
          </div>
          <button onClick={onDone} className="icon-btn" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div className="card-muted">
            <p className="text-[11px] font-medium text-ink-500 uppercase tracking-wide mb-1">
              Issue
            </p>
            <p className="text-[13px] text-ink-body leading-relaxed whitespace-pre-wrap">{issue}</p>
          </div>

          <div className="space-y-1.5">
            <label className="text-[12px] font-medium text-ink-muted">Target document</label>
            <select
              value={selectedValue}
              onChange={(e) => {
                const [kind, ...rest] = e.target.value.split(':')
                const value = rest.join(':')
                const found =
                  kind === 'doc'
                    ? docs.find((d) => d.id === value)
                    : chapters.find((c) => c.file === value)
                if (found) {
                  setTarget(
                    kind === 'doc'
                      ? { kind: 'doc', id: found.id, title: found.title }
                      : { kind: 'chapter', file: (found as Chapter).file, title: found.title },
                  )
                  setPhase({ status: 'pick' })
                  setOriginal('')
                  setRevised('')
                } else {
                  setTarget(null)
                }
              }}
              className="input text-sm"
            >
              <option value="">Select a document…</option>
              {targetOptions.map(
                (group) =>
                  group.items.length > 0 && (
                    <optgroup key={group.label} label={group.label}>
                      {group.items.map((item: any) => (
                        <option
                          key={`${item.kind}:${item.id ?? item.file}`}
                          value={`${item.kind}:${item.id ?? item.file}`}
                        >
                          {item.title}
                        </option>
                      ))}
                    </optgroup>
                  ),
              )}
            </select>
            {!target && (
              <p className="text-[11px] text-star-danger">
                Please select the document to fix — or pick one from the list above.
              </p>
            )}
          </div>

          {phase.status === 'loading' && (
            <div className="flex items-center gap-2 text-[12px] text-ink-500">
              <Loader2 size={13} className="animate-spin" />
              Generating fix for “{target?.title}”… this may take a while depending on the model.
            </div>
          )}

          {phase.status === 'error' && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-star-danger/8 border border-star-danger/20">
              <AlertTriangle size={14} className="text-star-danger shrink-0 mt-0.5" />
              <p className="text-[12px] text-star-danger leading-relaxed">{phase.message}</p>
            </div>
          )}

          {phase.status === 'preview' && (
            <div className="space-y-2">
              <p className="text-[12px] font-medium text-ink-muted">Proposed change</p>
              <DiffView
                original={original}
                revised={revised}
                onAccept={applyFix}
                onReject={() => {
                  setPhase({ status: 'pick' })
                  setRevised('')
                }}
              />
            </div>
          )}
        </div>

        <div className="shrink-0 flex items-center justify-end gap-2 px-5 py-4 border-t border-ink-800">
          <button
            onClick={onDone}
            className="btn btn-sm btn-secondary"
            disabled={phase.status === 'saving'}
          >
            <X size={13} /> Cancel
          </button>
          {phase.status === 'preview' || phase.status === 'saving' ? null : ( // DiffView 上方的 Discard / Apply 已承担确认,底部不再重复。
            <button
              onClick={generateFix}
              disabled={!target || phase.status === 'loading'}
              className="btn btn-sm btn-primary"
            >
              {phase.status === 'loading' ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Wand2 size={13} />
              )}
              {phase.status === 'loading' ? 'Generating…' : 'Generate fix'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
