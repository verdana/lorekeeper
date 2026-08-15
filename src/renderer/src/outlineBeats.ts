/**
 * Extract the author's own per-chapter outline beats for the chapter being
 * drafted. Outline docs keep one `#### 第XX章｜标题` block per chapter; the
 * block between that heading and the next act/chapter heading is the chapter
 * contract the source draft must follow.
 *
 * The long outline is truncated by the context budget, so the per-chapter
 * block (usually deep inside the 50-chapter outline) never reached the model.
 * This extraction runs on the full outline text before budgeting, so the
 * author's beats survive as their own high-priority layer.
 *
 * Returns '' when the outline has no matching block, so drafting degrades
 * gracefully to the previous behavior.
 */

const HEADING = /^#{3,4}\s/m
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function findChapterHeading(outlineText: string, chapterTitle: string): RegExpExecArray | null {
  // Prefer an exact heading match (`#### 第03章｜镜子里的人先动了`).
  const exact = new RegExp(`^####[ \t]*${escapeRegExp(chapterTitle)}[ \t]*$`, 'm')
  const hit = exact.exec(outlineText)
  if (hit) return hit
  // Fallback: match by the chapter ordinal when the heading differs slightly.
  const ordinal = chapterTitle.match(/第\s*\d+\s*章/)
  if (!ordinal) return null
  return new RegExp(`^####[ \t]*${escapeRegExp(ordinal[0])}[^\\n]*$`, 'm').exec(outlineText)
}

export function extractChapterOutline(outlineText: string, chapterTitle: string): string {
  if (!outlineText || !chapterTitle) return ''
  const heading = findChapterHeading(outlineText, chapterTitle)
  if (heading == null) return ''
  const lineEnd = outlineText.indexOf('\n', heading.index)
  const start = lineEnd === -1 ? outlineText.length : lineEnd + 1
  const rest = outlineText.slice(start)
  const next = HEADING.exec(rest)
  const end = next ? start + next.index : outlineText.length
  return outlineText.slice(start, end).trim()
}
