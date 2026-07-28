import { useMemo } from 'react'
import { ArrowRight, Check, X } from 'lucide-react'

/** A single diff segment: unchanged, removed, or added. */
interface DiffSegment {
  text: string
  type: 'same' | 'removed' | 'added'
}

/**
 * Simple token-level diff for English + CJK text.
 * Splits on word boundaries for Latin scripts, character-by-character for CJK.
 * Uses a basic LCS-based approach — not Myers, but good enough for prose polish diffs.
 */
function tokenize(text: string): string[] {
  // Split on word boundaries for Latin, keep CJK chars individual
  const tokens: string[] = []
  let buf = ''
  const pushBuf = (): void => {
    if (buf) {
      tokens.push(buf)
      buf = ''
    }
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    // CJK Unified, Compatibility, Supplement ranges
    const isCJK = /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/.test(ch)
    const isPunct = /[，。！？；：""''（）【】《》\s,\.!\?;:'"()\[\]{}]/.test(ch)
    if (isCJK || isPunct) {
      pushBuf()
      tokens.push(ch)
    } else {
      if (/\s/.test(ch)) {
        pushBuf()
        tokens.push(ch)
      } else {
        buf += ch
      }
    }
  }
  pushBuf()
  return tokens
}

/** Compute the Longest Common Subsequence length table. */
function lcsTable(a: string[], b: string[]): number[][] {
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }
  return dp
}

/** Backtrack to produce diff segments. */
function backtrack(a: string[], b: string[], dp: number[][]): DiffSegment[] {
  const result: DiffSegment[] = []
  let i = a.length,
    j = b.length
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      result.unshift({ text: a[i - 1], type: 'same' })
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ text: b[j - 1], type: 'added' })
      j--
    } else {
      result.unshift({ text: a[i - 1], type: 'removed' })
      i--
    }
  }
  return result
}

/** Merge adjacent segments of the same type for cleaner display. */
function mergeSegments(segments: DiffSegment[]): DiffSegment[] {
  const merged: DiffSegment[] = []
  for (const seg of segments) {
    const last = merged[merged.length - 1]
    if (last && last.type === seg.type) {
      last.text += seg.text
    } else {
      merged.push({ ...seg })
    }
  }
  return merged
}

export function computeDiff(original: string, revised: string): DiffSegment[] {
  const a = tokenize(original)
  const b = tokenize(revised)
  const dp = lcsTable(a, b)
  const raw = backtrack(a, b, dp)
  return mergeSegments(raw)
}

/** Estimate the change ratio (0–1) between original and revised. */
export function changeRatio(original: string, revised: string): number {
  const segments = computeDiff(original, revised)
  let changed = 0
  let total = 0
  for (const seg of segments) {
    total += seg.text.length
    if (seg.type !== 'same') changed += seg.text.length
  }
  return total > 0 ? changed / total : 0
}

interface DiffViewProps {
  original: string
  revised: string
  onAccept: () => void
  onReject: () => void
}

export default function DiffView({
  original,
  revised,
  onAccept,
  onReject,
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
        <div className="flex gap-1.5">
          <button onClick={onReject} className="btn btn-sm btn-secondary">
            <X size={13} /> Discard
          </button>
          <button onClick={onAccept} className="btn btn-sm btn-primary">
            <Check size={13} /> Apply
          </button>
        </div>
      </div>

      {showFullReplace ? (
        <div className="space-y-2">
          <div className="p-3 bg-ink-850 rounded border border-ink-800 text-sm text-ink-muted whitespace-pre-wrap leading-relaxed">
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
