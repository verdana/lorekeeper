/**
 * The AI planning wizard: it proposes a chapter list with beats for a volume and
 * shows the draft for review. Nothing is written until the author applies it, so
 * a bad proposal costs one call and no plan.
 */

import { useMemo, useState } from 'react'
import { chatStream } from '../../api'
import { PROMPTS } from '@shared/prompts'
import type { OutlineStore, OutlineVolumeData } from '@shared/types'
import { serializeChapterBeats } from '@shared/outlineStore'
import { Check, Loader2, Sparkles, X } from 'lucide-react'
import { parseGeneratedChapters, type GeneratedChapter } from './plan'

// ---- AI 生成向导 ----

export function GenerateModal({
  volume,
  store,
  onApply,
  onClose,
}: {
  volume: OutlineVolumeData
  store: OutlineStore
  onApply: (chapters: GeneratedChapter[], confirmed: boolean) => void
  onClose: () => void
}): JSX.Element {
  const [count, setCount] = useState(10)
  const [instructions, setInstructions] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [phase, setPhase] = useState<'config' | 'generating' | 'preview'>('config')
  const [result, setResult] = useState<GeneratedChapter[]>([])
  const [error, setError] = useState('')

  const confirmedContext = useMemo(() => {
    const parts: string[] = []
    for (const v of store.volumes) {
      for (const c of v.chapters) {
        if (c.status !== 'confirmed' || c.beats.length === 0) continue
        parts.push(`### ${c.title}\n${serializeChapterBeats(c)}`)
      }
    }
    return parts.join('\n\n')
  }, [store])

  const run = async (): Promise<void> => {
    setPhase('generating')
    setError('')
    const messages: { role: 'system' | 'user'; content: string }[] = [
      { role: 'system', content: PROMPTS.outline.system },
      {
        role: 'user',
        content: PROMPTS.outline.generateChapters({
          volumeTitle: volume.title,
          summary: volume.summary,
          config: volume.config,
          confirmedContext,
          instructions,
          count,
        }),
      },
    ]
    const ctrl = new AbortController()
    let acc = ''
    try {
      const res = await chatStream(
        messages,
        undefined,
        (type, text) => {
          if (type === 'content') acc += text
        },
        ctrl.signal,
      )
      if (!res.completed && !acc.trim()) throw new Error('The AI returned no content.')
      setResult(parseGeneratedChapters(acc))
      setPhase('preview')
    } catch (e) {
      setError((e as Error).message)
      setPhase('config')
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-deep/60 p-6"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="AI generate chapters"
        className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-[14px] border border-ink-800 bg-ink-900 shadow-warm-lg"
      >
        <div className="flex items-center justify-between border-b border-ink-800 px-5 py-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-ink-body">
            <Sparkles size={15} className="text-star-warm" /> AI generate chapters
            <span className="text-xs font-normal text-ink-500">({volume.title})</span>
          </div>
          <button onClick={onClose} className="icon-btn" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        {phase === 'config' && (
          <div className="space-y-3 p-5">
            <div className="flex items-center gap-3">
              <label className="text-xs text-ink-500">Chapters</label>
              <input
                type="number"
                min={1}
                max={50}
                className="input w-24 py-1"
                value={count}
                onChange={(e) => setCount(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
              />
              <label className="flex items-center gap-2 text-sm text-ink-muted">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                Mark as confirmed
              </label>
            </div>
            <div>
              <label className="mb-1 block text-xs text-ink-500">Instructions (optional)</label>
              <textarea
                className="textarea h-24 text-sm"
                placeholder="e.g. escalate the antagonist's pressure; end the volume on a cliffhanger…"
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
              />
            </div>
            {error && <div className="text-sm text-star-danger">{error}</div>}
            <div className="text-xs text-ink-500 leading-relaxed">
              The AI proposes chapter titles and beats as a draft. Review and edit before applying —
              nothing is written without confirmation.
            </div>
          </div>
        )}

        {phase === 'generating' && (
          <div className="flex items-center gap-2 p-6 text-sm text-ink-muted">
            <Loader2 size={15} className="animate-spin" /> Generating chapter plan…
          </div>
        )}

        {phase === 'preview' && (
          <div className="flex-1 space-y-3 overflow-y-auto p-5">
            {result.length === 0 && (
              <p className="text-sm text-ink-500">The AI returned an empty plan.</p>
            )}
            {result.map((ch, i) => (
              <div key={i} className="rounded-lg border border-ink-700 bg-ink-850/50 p-3">
                <div className="font-medium text-sm text-ink-body">{ch.title}</div>
                <ul className="mt-1.5 space-y-1">
                  {ch.beats.map((b, bi) => (
                    <li key={bi} className="text-xs text-ink-muted">
                      <span className="font-medium text-ink-500">
                        {b.title ? `${b.title}：` : ''}
                      </span>
                      {b.summary}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-ink-800 px-5 py-4">
          <button onClick={onClose} className="btn btn-sm btn-ghost">
            Cancel
          </button>
          {phase === 'config' && (
            <button onClick={run} className="btn btn-sm btn-primary">
              <Sparkles size={14} /> Generate
            </button>
          )}
          {phase === 'preview' && (
            <>
              <button onClick={() => setPhase('config')} className="btn btn-sm btn-ghost">
                Regenerate
              </button>
              <button onClick={() => onApply(result, confirmed)} className="btn btn-sm btn-primary">
                <Check size={14} /> Apply chapters
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
