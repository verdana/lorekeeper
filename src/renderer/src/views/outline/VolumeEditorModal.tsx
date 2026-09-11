/**
 * Volume config editor: the plan for one volume — its goal, its reading rhythm,
 * and whether it counts as planned, planning or confirmed.
 */

import { useState } from 'react'
import type { OutlineVolumeData, OutlineVolumeStatus } from '@shared/types'
import { deriveVolumeStatus } from '@shared/outlineStore'
import { Save, Settings2, X } from 'lucide-react'
import clsx from 'clsx'
import { STATUS_LABEL, STATUS_STYLE } from './plan'

// ---- 卷配置编辑弹窗 ----

export function VolumeEditorModal({
  volume,
  onSave,
  onClose,
}: {
  volume: OutlineVolumeData
  onSave: (volume: OutlineVolumeData) => void
  onClose: () => void
}): JSX.Element {
  const [title, setTitle] = useState(volume.title)
  const [summary, setSummary] = useState(volume.summary)
  const [config, setConfig] = useState(volume.config)
  const [status, setStatus] = useState<OutlineVolumeStatus>(deriveVolumeStatus(volume))

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-deep/60 p-6"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Volume configuration"
        className="w-full max-w-lg rounded-[14px] border border-ink-800 bg-ink-900 shadow-warm-lg"
      >
        <div className="flex items-center justify-between border-b border-ink-800 px-5 py-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-ink-body">
            <Settings2 size={15} className="text-star-accent" /> Set volume config
          </div>
          <button onClick={onClose} className="icon-btn" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="space-y-3 p-5">
          <div>
            <label className="mb-1 block text-xs text-ink-500">Title</label>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-xs text-ink-500">Volume summary</label>
            <textarea
              className="textarea h-28 text-sm"
              placeholder="What happens in this volume, in a few lines."
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-ink-500">Volume goals / reading rhythm</label>
            <textarea
              className="textarea h-24 text-sm"
              placeholder="Payoff points, pacing, tone, reader hooks…"
              value={config}
              onChange={(e) => setConfig(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-2 text-sm text-ink-muted">
            <span>Status</span>
            {(['planned', 'planning', 'confirmed'] as OutlineVolumeStatus[]).map((s) => (
              <button
                key={s}
                onClick={() => setStatus(s)}
                className={clsx(
                  'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                  status === s
                    ? STATUS_STYLE[s].badge +
                        ' ' +
                        (s === 'confirmed'
                          ? 'border-star-success/40'
                          : s === 'planning'
                            ? 'border-star-warm/60'
                            : 'border-ink-400')
                    : 'border-ink-300 text-ink-500 hover:bg-ink-850',
                )}
              >
                {STATUS_LABEL[s]}
              </button>
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
                ...volume,
                title: title.trim() || volume.title,
                summary,
                config,
                status,
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
