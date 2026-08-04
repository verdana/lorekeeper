// Token-level diff for English + CJK text, shared by DiffView and tests.
// Pure functions only — no JSX, so tests can import this without a jsx tsconfig.

/** A single diff segment: unchanged, removed, or added. */
export interface DiffSegment {
  text: string
  type: 'same' | 'removed' | 'added'
}

/**
 * Split on word boundaries for Latin scripts, character-by-character for CJK.
 * Keeps punctuation and whitespace as individual tokens.
 */
export function tokenize(text: string): string[] {
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

/**
 * LCS 表是 O(m×n) 内存/时间。token 乘积超限时降级为「整段删除 + 整段新增」，
 * 不做逐字对齐，避免长文本（如完整讨论会话的 JSON）在浏览器里爆内存崩溃。
 * 降级后 changeRatio 接近 1，UI 走 showFullReplace 分支直接展示新版全文。
 */
const MAX_LCS_CELLS = 1_000_000 // ≈ 1000×1000 token

export function computeDiff(original: string, revised: string): DiffSegment[] {
  const a = tokenize(original)
  const b = tokenize(revised)
  if (a.length * b.length > MAX_LCS_CELLS) {
    return mergeSegments([
      { text: original, type: 'removed' },
      { text: revised, type: 'added' },
    ])
  }
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
