import type { SlopFlag } from '../types'

/** First two content chars of a sentence, mirroring the analyzer's head logic. */
export function sentenceHead(text: string): string {
  return text.replace(/^["'“”‘’(（]+/, '').slice(0, 2)
}

/** One rewrite unit sent to the model. */
export interface RewriteGroup {
  /** Text sent to the model (a span of the original prose). */
  original: string
  /** Char offset of the group's first span in the original text. */
  start: number
  /** Char offset just past the group's last span in the original text. */
  end: number
  /** Number of sentences/flags this group covers (1 for single sentences). */
  size: number
  /** Optional instruction shown to the model when the group shares a problem. */
  groupNote?: string
}

/**
 * Build rewrite units from eligible flags.
 *
 * Sentence-head-repetition flags that share the same two-char head AND sit next
 * to each other in the source text (nothing but whitespace between their spans)
 * are merged into one group, so the model rewrites them together and later
 * sentences reference earlier edits — per-sentence rewrites can't coordinate
 * the shared opening. Everything else stays a single-sentence group.
 */
export function groupRewriteFlags(flags: SlopFlag[], fullText: string): RewriteGroup[] {
  const ordered = [...flags].sort((a, b) => a.start - b.start)
  const groups: RewriteGroup[] = []
  let i = 0
  while (i < ordered.length) {
    const f = ordered[i]
    // Merge consecutive head-repetition flags with the same head and no prose
    // between their spans.
    if (f.reasons.includes('sentenceHeadRepetition')) {
      const head = sentenceHead(f.text)
      let j = i + 1
      while (
        j < ordered.length &&
        ordered[j].reasons.includes('sentenceHeadRepetition') &&
        sentenceHead(ordered[j].text) === head &&
        fullText.slice(ordered[j - 1].end, ordered[j].start).trim() === ''
      ) {
        j++
      }
      const span = { start: f.start, end: ordered[j - 1].end }
      const original = fullText.slice(span.start, span.end)
      if (j - i >= 2) {
        groups.push({
          original,
          start: span.start,
          end: span.end,
          size: j - i,
          groupNote: `以下 ${j - i} 句以「${head}」开头，构成句首重复。请把它们当作一组一起改写，使各句开头各不相同、互相协调。保留原有的换行。`,
        })
      } else {
        groups.push({ original, start: span.start, end: span.end, size: 1 })
      }
      i = j
      continue
    }
    groups.push({ original: f.text, start: f.start, end: f.end, size: 1 })
    i++
  }
  return groups
}
