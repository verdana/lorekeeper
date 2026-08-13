/**
 * Split a long draft into chunks of at most `cap` characters, preferring
 * paragraph boundaries (blank-line separated) so a downstream pass that reads
 * the text back in — e.g. the de-AI calibration rewrite — never silently
 * drops the chapter tail.
 *
 * Rejoining the chunks in order reconstructs the original text losslessly:
 * paragraph separators stay attached to the preceding paragraph, and an
 * oversized single paragraph is hard-split at the cap.
 */
export function chunkText(text: string, cap: number): string[] {
  if (cap <= 0 || !text) return text ? [text] : []
  if (text.length <= cap) return [text]

  // Keep the blank-line separators so chunks rejoin without losing them.
  const parts = text.split(/(\n{2,})/)
  const chunks: string[] = []
  let current = ''

  for (const part of parts) {
    if (!part) continue
    if (current.length + part.length <= cap) {
      current += part
      continue
    }
    if (current) {
      chunks.push(current)
    }
    // A paragraph longer than the cap alone: hard-split it, keeping any
    // remainder as the start of the next chunk.
    if (part.length > cap) {
      let rest = part
      while (rest.length > cap) {
        chunks.push(rest.slice(0, cap))
        rest = rest.slice(cap)
      }
      current = rest
    } else {
      current = part
    }
  }
  if (current) chunks.push(current)
  return chunks
}
