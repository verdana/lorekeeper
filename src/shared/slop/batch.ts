import type { SlopWeights, SlopReport } from '../types'
import { analyzeSlop, detectLang } from './analyze'
import { checklistText, type SlopUiLang } from './labels'

/**
 * Batch scan summary for one chapter (used by the all-chapter overview in M4).
 * Lightweight: only the numbers the table needs, not the full per-sentence
 * flags. Keeping it separate from SlopReport avoids serializing large flag
 * arrays for every chapter when scanning a whole manuscript.
 */
export interface SlopBatchRow {
  chapterId: string
  title: string
  wordCount: number
  score: number
  band: SlopReport['band']
  flagCount: number
  /** Highest single-sentence risk in the chapter, 0 if none flagged. */
  maxRisk: number
}

/** Analyze a single chapter's text into a compact batch row. */
export function scanChapter(
  chapterId: string,
  title: string,
  wordCount: number,
  content: string,
  weights?: SlopWeights,
  uiLang?: SlopUiLang,
): SlopBatchRow {
  const r = analyzeSlop(content, { weights, lang: detectLang(content), uiLang })
  const maxRisk = r.flags.reduce((m, f) => (f.risk > m ? f.risk : m), 0)
  return {
    chapterId,
    title,
    wordCount,
    score: r.score,
    band: r.band,
    flagCount: r.flags.length,
    maxRisk,
  }
}

/** Sort batch rows worst-first: red band, then higher score, then more flags. */
export function rankByRisk(rows: SlopBatchRow[]): SlopBatchRow[] {
  const bandRank: Record<SlopReport['band'], number> = { red: 0, yellow: 1, green: 2 }
  return [...rows].sort(
    (a, b) => bandRank[a.band] - bandRank[b.band] || b.score - a.score || b.flagCount - a.flagCount,
  )
}

/**
 * Build a "Zhuque self-test checklist": a plain-text manifest the author can
 * copy when taking chapters to zhuque.tencent.com manually. Lists each chapter
 * with its local score and a blank column for the backfilled Zhuque score, so
 * the human-in-the-loop calibration (M3) has a structured worksheet to fill in.
 */
export function buildZhuqueChecklist(
  rows: SlopBatchRow[],
  worldTitle?: string,
  uiLang?: SlopUiLang,
): string {
  const loc = checklistText(uiLang ?? 'zh')
  const ctx = { worldTitle, date: new Date().toLocaleString(), count: rows.length }
  const header = loc.title(ctx)
  const lines = [
    header,
    '='.repeat(header.length * 2),
    loc.rule1,
    loc.rule2,
    '',
    loc.header,
    '--- | --- | ---',
  ]
  for (const r of rankByRisk(rows)) {
    lines.push(`${r.title} | ${r.score} | __`)
  }
  lines.push('')
  lines.push(loc.footer(ctx))
  return lines.join('\n')
}
