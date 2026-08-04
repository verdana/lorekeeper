import { useMemo } from 'react'
import { Check, X } from 'lucide-react'
import { changeRatio, computeDiff } from '../diff'

interface DiffViewProps {
  original: string
  revised: string
  onAccept: () => void
  onReject: () => void
  /** 只读模式：只展示红绿 diff，不渲染 Accept/Discard 按钮（如 History 对比）。 */
  readOnly?: boolean
}

export default function DiffView({
  original,
  revised,
  onAccept,
  onReject,
  readOnly = false,
}: DiffViewProps): JSX.Element {
  const segments = useMemo(() => computeDiff(original, revised), [original, revised])
  const ratio = useMemo(() => changeRatio(original, revised), [original, revised])

  const showFullReplace = ratio > 0.7 && original.length > 200

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-ink-500">
          {showFullReplace ? 'Complete rewrite' : `~${Math.round(ratio * 100)}% changed`}
        </span>
        {!readOnly && (
          <div className="flex gap-1.5">
            <button onClick={onReject} className="btn btn-sm btn-secondary">
              <X size={13} /> Discard
            </button>
            <button onClick={onAccept} className="btn btn-sm btn-primary">
              <Check size={13} /> Apply
            </button>
          </div>
        )}
      </div>

      {showFullReplace ? (
        <div className="space-y-2">
          <div className="p-3 bg-ink-850 rounded border border-ink-800 text-sm text-ink-500 whitespace-pre-wrap leading-relaxed font-mono">
            {revised}
          </div>
        </div>
      ) : (
        <div className="p-3 bg-ink-850 rounded border border-ink-800 text-sm leading-relaxed whitespace-pre-wrap font-mono">
          {segments.map((seg, i) => {
            if (seg.type === 'same')
              return (
                <span key={i} className="text-ink-500">
                  {seg.text}
                </span>
              )
            if (seg.type === 'added')
              return (
                <span key={i} className="text-star-success bg-star-success/10">
                  {seg.text}
                </span>
              )
            return (
              <span key={i} className="text-star-danger bg-star-danger/10 line-through">
                {seg.text}
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}
