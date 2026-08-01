import type {
  Chapter,
  NovelMeta,
  SettingDoc,
  StoryMemoryEntry,
  StoryMemoryStore,
  Volume,
} from './types'

export interface OrderedChapter {
  chapter: Chapter
  volume: Volume
  index: number
}

/** Return a stable narrative order independent of the source array order. */
export function orderedChapters(novel: NovelMeta): OrderedChapter[] {
  const out: OrderedChapter[] = []
  for (const volume of [...novel.volumes].sort((a, b) => a.order - b.order)) {
    for (const chapter of [...volume.chapters].sort((a, b) => a.order - b.order)) {
      out.push({ chapter, volume, index: out.length })
    }
  }
  return out
}

/** Lightweight deterministic fingerprint for source-change detection, not security. */
export function storyMemoryFingerprint(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

export function isStoryMemoryStale(
  entry: StoryMemoryEntry,
  sourceText: string | undefined,
): boolean {
  return sourceText === undefined || storyMemoryFingerprint(sourceText) !== entry.source.fingerprint
}

export interface StoryMemorySelectionInput {
  store: StoryMemoryStore
  novel: NovelMeta
  activeChapterId: string
  sourceTexts: Map<string, string>
  signalText: string
  settingDocs: SettingDoc[]
  limit?: number
}

/** Choose valid, relevant, confirmed memories for a drafting request. */
export function selectStoryMemories(input: StoryMemorySelectionInput): StoryMemoryEntry[] {
  const chapters = orderedChapters(input.novel)
  const positions = new Map(chapters.map((item) => [item.chapter.id, item.index]))
  const activeIndex = positions.get(input.activeChapterId)
  if (activeIndex === undefined) return []

  const titles = new Map(input.settingDocs.map((doc) => [doc.id, doc.title]))
  const signal = input.signalText.toLocaleLowerCase()
  const limit = input.limit ?? 12

  const eligible = input.store.entries.filter((entry) => {
    const position = positions.get(entry.source.chapterId)
    return (
      entry.status === 'confirmed' &&
      position !== undefined &&
      position <= activeIndex &&
      !isStoryMemoryStale(entry, input.sourceTexts.get(entry.source.chapterId))
    )
  })

  const isRelevant = (entry: StoryMemoryEntry): boolean =>
    entry.entityRefIds.some((id) => {
      const title = titles.get(id)
      return title ? signal.includes(title.toLocaleLowerCase()) : false
    })

  const newestFirst = (a: StoryMemoryEntry, b: StoryMemoryEntry): number =>
    (positions.get(b.source.chapterId) ?? -1) - (positions.get(a.source.chapterId) ?? -1)

  const matched = eligible.filter(isRelevant).sort(newestFirst).slice(0, limit)
  // A small recency fallback preserves broad changes without allowing
  // unrelated memories to dominate the prompt.
  const fallbackLimit = Math.min(3, Math.max(0, limit - matched.length))
  const fallback = eligible
    .filter((entry) => !isRelevant(entry))
    .sort(newestFirst)
    .slice(0, fallbackLimit)
  return [...matched, ...fallback]
}
