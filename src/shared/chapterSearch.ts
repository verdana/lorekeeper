/**
 * Full-text search over manuscript prose.
 *
 * The palette's metadata search can only match chapter titles and statuses, so
 * finding a line you wrote previously meant opening chapters one by one. Prose
 * search runs over the chapter files themselves and returns the matching
 * chapter with a readable snippet around each hit.
 *
 * Kept in the shared layer, and pure, so the matching rules are testable without
 * a server or a filesystem.
 */

import type { ChapterProseMatch, ChapterProseSource } from './types'

export type { ChapterProseMatch, ChapterProseSource }

/** Snippet context kept on each side of the match, in characters. */
const SNIPPET_PADDING = 40
/** Hard cap on distinct matches returned, so one common word cannot flood the UI. */
export const CHAPTER_PROSE_MATCH_LIMIT = 20

/**
 * Whether a chapter body holds prose worth searching.
 *
 * A planned chapter exists on disk as a heading and nothing else, and its
 * heading is the chapter title — already covered by the metadata search. Matching
 * those bodies would answer a prose query with the very title the author typed,
 * so only bodies with a non-heading line are searched.
 */
export function hasSearchableProse(text: string): boolean {
  return text.split('\n').some((line) => {
    const trimmed = line.trim()
    return trimmed.length > 0 && !trimmed.startsWith('#')
  })
}

/**
 * Match a query against one chapter body.
 *
 * Matching is case-insensitive and literal — no word boundaries, because CJK
 * prose has none — which is what an author expects when pasting a phrase they
 * remember writing.
 */
export function matchChapterProse(
  source: ChapterProseSource,
  query: string,
): ChapterProseMatch | null {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return null
  // Offsets are read back from the original body, so the lowered copy is only
  // used to find the position. Case folding that changes length (rare, and not
  // for CJK) would shift them, so a length change disables offset reporting.
  const lowered = source.text.toLocaleLowerCase()
  const index = lowered.indexOf(needle)
  if (index === -1) return null

  let count = 0
  for (let at = index; at !== -1; at = lowered.indexOf(needle, at + needle.length)) count++

  const offsetsAligned = lowered.length === source.text.length
  const offset = offsetsAligned ? index : -1
  const start = Math.max(0, index - SNIPPET_PADDING)
  const end = Math.min(source.text.length, index + needle.length + SNIPPET_PADDING)
  const snippet = source.text.slice(start, end).replace(/\s+/g, ' ').trim()

  return {
    chapterId: source.chapterId,
    chapterTitle: source.chapterTitle,
    line: lineAround(source.text, index),
    snippet: `${start > 0 ? '…' : ''}${snippet}${end < source.text.length ? '…' : ''}`,
    offset,
    count,
  }
}

/**
 * The whole line containing `index`, trimmed, with any markdown heading marker
 * removed — a chapter whose heading sits on the same line as its opening
 * paragraph would otherwise show raw `##` in a result title.
 */
function lineAround(text: string, index: number): string {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1
  const lineEnd = text.indexOf('\n', index)
  const line = text
    .slice(lineStart, lineEnd === -1 ? text.length : lineEnd)
    .trim()
    .replace(/^#{1,6}\s*/, '')
  return line.length > 0 ? line.slice(0, 160) : text.slice(index, index + 80).trim()
}

/**
 * Search every chapter, ordered by chapter position, keeping at most one match
 * per chapter so a single repeated phrase cannot fill the results.
 */
export function searchChapterProse(
  sources: ChapterProseSource[],
  query: string,
  limit = CHAPTER_PROSE_MATCH_LIMIT,
): ChapterProseMatch[] {
  if (!query.trim() || limit <= 0) return []
  const matches: ChapterProseMatch[] = []
  for (const source of sources) {
    if (matches.length >= limit) break
    const match = matchChapterProse(source, query)
    if (match) matches.push(match)
  }
  return matches
}
