/**
 * Word counting, shared by the server and the renderer.
 *
 * CJK characters count as one word each; runs of non-CJK characters count as
 * words. This used to exist in three copies (the store, the forge engine and the
 * renderer's lib), which is a real risk: the server persists `wordCount` into
 * novel.json while the editor shows a live count, so two implementations can
 * disagree about the same chapter.
 */
const CJK = /[\u4e00-\u9fff]/g

export function countWords(text: string): number {
  const cjk = (text.match(CJK) ?? []).length
  const words = (text.replace(CJK, ' ').match(/\b\w+\b/g) ?? []).length
  return cjk + words
}
