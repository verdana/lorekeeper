/**
 * Chapter and beat editor: the chapter's status, the author's contract for it,
 * and the ordered beats that fix its events. Beats are edited here rather than
 * as prose, because the outline is the structure of record; the contract is
 * edited here because it is a decision, and the outline is where decisions live.
 */

import { useState } from 'react'
import type {
  ChapterContract,
  OutlineBeat,
  OutlineChapterData,
  OutlineVolumeData,
} from '@shared/types'
import { chapterContract, normalizeChapterContract } from '@shared/outlineStore'
import { ArrowDown, ArrowUp, Pencil, Plus, Save, Trash2, X } from 'lucide-react'

// ---- 章/要点编辑弹窗 ----

export function ChapterEditorModal({
  volume,
  chapter,
  onSave,
  onClose,
}: {
  volume: OutlineVolumeData
  chapter: OutlineChapterData
  onSave: (chapter: OutlineChapterData) => void
  onClose: () => void
}): JSX.Element {
  const [title, setTitle] = useState(chapter.title)
  const [confirmed, setConfirmed] = useState(chapter.status === 'confirmed')
  const [beats, setBeats] = useState<OutlineBeat[]>(chapter.beats.map((b) => ({ ...b })))
  const [contract, setContract] = useState<ChapterContract>(chapterContract(chapter))
  const patchContract = (patch: Partial<ChapterContract>): void =>
    setContract((prev) => ({ ...prev, ...patch }))

  const patchBeat = (i: number, patch: Partial<OutlineBeat>): void =>
    setBeats((prev) => prev.map((b, idx) => (idx === i ? { ...b, ...patch } : b)))
  const moveBeat = (i: number, dir: -1 | 1): void =>
    setBeats((prev) => {
      const next = [...prev]
      const to = i + dir
      if (to < 0 || to >= next.length) return prev
      ;[next[i], next[to]] = [next[to], next[i]]
      return next
    })

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-deep/60 p-6"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Edit chapter"
        className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-[14px] border border-ink-800 bg-ink-900 shadow-warm-lg"
      >
        <div className="flex items-center justify-between border-b border-ink-800 px-5 py-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-ink-body">
            <Pencil size={15} className="text-star-accent" /> Edit chapter
            <span className="text-xs font-normal text-ink-500">({volume.title})</span>
          </div>
          <button onClick={onClose} className="icon-btn" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto p-5">
          <div>
            <label className="mb-1 block text-xs text-ink-500">Chapter title</label>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <label className="flex items-center gap-2 text-sm text-ink-muted">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            Mark as confirmed
          </label>
          <div className="space-y-2">
            <label className="text-xs text-ink-500">Chapter contract</label>
            <p className="text-[11px] leading-relaxed text-ink-500">
              The decisions the author owns. Every prompt that drafts or revises this chapter
              carries them; a field left empty is one the model decides for itself.
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs text-ink-500">Required event</label>
                <input
                  className="input text-sm"
                  placeholder="The one thing this chapter must deliver."
                  value={contract.event}
                  onChange={(e) => patchContract({ event: e.target.value })}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-ink-500">Viewpoint goal</label>
                <input
                  className="input text-sm"
                  placeholder="What the viewpoint character wants right now."
                  value={contract.goal}
                  onChange={(e) => patchContract({ goal: e.target.value })}
                />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs text-ink-500">Entry state</label>
              <textarea
                className="textarea h-16 text-sm"
                placeholder="Where it opens: time, place, who is present, condition."
                value={contract.entryState}
                onChange={(e) => patchContract({ entryState: e.target.value })}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-ink-500">Exit state</label>
              <textarea
                className="textarea h-16 text-sm"
                placeholder="Where the story has to stand when the chapter ends."
                value={contract.exitState}
                onChange={(e) => patchContract({ exitState: e.target.value })}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-ink-500">Must not be revealed yet</label>
              <textarea
                className="textarea h-16 text-sm"
                placeholder="Facts that must not change or come out in this chapter."
                value={contract.protectedReveals}
                onChange={(e) => patchContract({ protectedReveals: e.target.value })}
              />
            </div>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs text-ink-500">Beats</label>
              <button
                onClick={() => setBeats((prev) => [...prev, { title: '', summary: '' }])}
                className="btn btn-sm btn-ghost"
              >
                <Plus size={13} /> Add beat
              </button>
            </div>
            {beats.length === 0 && (
              <p className="rounded-lg border border-dashed border-ink-400 bg-ink-850/40 px-3 py-4 text-center text-xs text-ink-500">
                No beats yet — add the chapter's plot points in order.
              </p>
            )}
            {beats.map((b, i) => (
              <div
                key={i}
                className="space-y-1.5 rounded-lg border border-ink-700 bg-ink-850/50 p-3"
              >
                <div className="flex items-center gap-1.5">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ink-300 text-xs font-semibold text-ink-600">
                    {i + 1}
                  </span>
                  <input
                    className="input flex-1 py-1 text-sm"
                    placeholder="Beat title"
                    value={b.title}
                    onChange={(e) => patchBeat(i, { title: e.target.value })}
                  />
                  <button
                    onClick={() => moveBeat(i, -1)}
                    disabled={i === 0}
                    className="icon-btn disabled:opacity-30"
                    title="Move up"
                  >
                    <ArrowUp size={13} />
                  </button>
                  <button
                    onClick={() => moveBeat(i, 1)}
                    disabled={i === beats.length - 1}
                    className="icon-btn disabled:opacity-30"
                    title="Move down"
                  >
                    <ArrowDown size={13} />
                  </button>
                  <button
                    onClick={() => setBeats((prev) => prev.filter((_, idx) => idx !== i))}
                    className="icon-btn hover:text-star-danger"
                    title="Remove beat"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
                <textarea
                  className="textarea h-20 text-sm"
                  placeholder="What happens — events, causality, result."
                  value={b.summary}
                  onChange={(e) => patchBeat(i, { summary: e.target.value })}
                />
              </div>
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-ink-800 px-5 py-4">
          <button onClick={onClose} className="btn btn-sm btn-ghost">
            Cancel
          </button>
          <button
            onClick={() =>
              onSave({
                ...chapter,
                title: title.trim() || chapter.title,
                status: confirmed ? 'confirmed' : 'planned',
                beats,
                // Letting the author clear every field drops the contract again,
                // rather than leaving five empty strings on the chapter.
                contract: normalizeChapterContract(contract),
              })
            }
            className="btn btn-sm btn-primary"
          >
            <Save size={14} /> Save
          </button>
        </div>
      </div>
    </div>
  )
}
