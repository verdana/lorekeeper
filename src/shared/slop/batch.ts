import type { SlopWeights, SlopReport } from '../types'
import { analyzeSlop, detectLang } from './analyze'

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
): SlopBatchRow {
  const r = analyzeSlop(content, { weights, lang: detectLang(content) })
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
export function buildZhuqueChecklist(rows: SlopBatchRow[], worldTitle?: string): string {
  const header = worldTitle ? `朱雀自测清单 · ${worldTitle}` : '朱雀自测清单'
  const lines = [
    header,
    '='.repeat(header.length * 2),
    '说明：将每章正文复制到 zhuque.tencent.com 检测，把「AI 疑似度 %」填回下表。',
    '回填后在「去 AI 味 · 校准」面板逐条录入，即可校准本地权重。',
    '',
    '章节 | 本地机器味 | 朱雀疑似度 %',
    '--- | --- | ---',
  ]
  for (const r of rankByRisk(rows)) {
    lines.push(`${r.title} | ${r.score} | __`)
  }
  lines.push('')
  lines.push(`生成于 ${new Date().toLocaleString()}，共 ${rows.length} 章`)
  return lines.join('\n')
}
