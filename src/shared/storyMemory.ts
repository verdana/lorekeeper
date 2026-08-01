import type {
  Chapter,
  NovelMeta,
  SettingDoc,
  StoryMemoryEntry,
  StoryMemoryKind,
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

export interface StoryMemoryCandidate {
  kind: StoryMemoryKind
  statement: string
  entityRefIds: string[]
  evidence: string
  timelineEventId: string | null
  storyDateLabel: string
  confidence: number | null
}

export type StoryMemoryStalenessFilter = 'all' | 'fresh' | 'stale'

export type StoryMemorySort = 'narrative' | 'updated' | 'status'

export interface StoryMemoryBrowseInput {
  entries: StoryMemoryEntry[]
  settingDocs: SettingDoc[]
  sourceTexts: Map<string, string>
  chapterId?: string
  query?: string
  status?: StoryMemoryEntry['status'] | 'all'
  kind?: StoryMemoryKind | 'all'
  staleness?: StoryMemoryStalenessFilter
  sort?: StoryMemorySort
}

const STORY_MEMORY_KINDS = new Set<StoryMemoryKind>([
  'character-state',
  'relationship',
  'knowledge',
  'location',
  'object',
  'world-state',
  'open-thread',
])

/** Parse AI output and retain only candidates grounded in the source chapter. */
export function parseStoryMemoryCandidates(
  raw: string,
  source: string,
  entityIds: Set<string>,
  timelineIds: Set<string>,
): StoryMemoryCandidate[] {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  const value = JSON.parse(fenced ?? raw) as { memories?: unknown }
  if (!Array.isArray(value.memories)) throw new Error('The AI did not return a memories array.')

  return value.memories.slice(0, 12).flatMap((candidate): StoryMemoryCandidate[] => {
    if (!candidate || typeof candidate !== 'object') return []
    const item = candidate as Record<string, unknown>
    if (!STORY_MEMORY_KINDS.has(item.kind as StoryMemoryKind)) return []
    const statement = typeof item.statement === 'string' ? item.statement.trim() : ''
    const evidence = typeof item.evidence === 'string' ? item.evidence.trim() : ''
    if (!statement || !evidence || !source.includes(evidence)) return []

    const confidence =
      typeof item.confidence === 'number' ? Math.max(0, Math.min(1, item.confidence)) : null
    return [
      {
        kind: item.kind as StoryMemoryKind,
        statement: statement.slice(0, 600),
        entityRefIds: Array.isArray(item.entityRefIds)
          ? item.entityRefIds.filter(
              (id): id is string => typeof id === 'string' && entityIds.has(id),
            )
          : [],
        evidence: evidence.slice(0, 400),
        timelineEventId:
          typeof item.timelineEventId === 'string' && timelineIds.has(item.timelineEventId)
            ? item.timelineEventId
            : null,
        storyDateLabel:
          typeof item.storyDateLabel === 'string' ? item.storyDateLabel.slice(0, 120) : '',
        confidence,
      },
    ]
  })
}

/** Filter and order memories for the author-facing management view. */
export function browseStoryMemories(input: StoryMemoryBrowseInput): StoryMemoryEntry[] {
  const query = input.query?.trim().toLocaleLowerCase() ?? ''
  const status = input.status ?? 'all'
  const kind = input.kind ?? 'all'
  const staleness = input.staleness ?? 'all'
  const sort = input.sort ?? 'narrative'
  const entityTitles = new Map(input.settingDocs.map((doc) => [doc.id, doc.title]))

  const matches = input.entries.filter((entry) => {
    if (input.chapterId && entry.source.chapterId !== input.chapterId) return false
    if (status !== 'all' && entry.status !== status) return false
    if (kind !== 'all' && entry.kind !== kind) return false

    const sourceText = input.sourceTexts.get(entry.source.chapterId)
    const stale = sourceText === undefined ? null : isStoryMemoryStale(entry, sourceText)
    if (staleness === 'stale' && stale !== true) return false
    if (staleness === 'fresh' && stale !== false) return false

    if (!query) return true
    const entityNames = entry.entityRefIds.map((id) => entityTitles.get(id) ?? id)
    return [entry.statement, entry.source.evidence, entry.source.chapterTitle, ...entityNames]
      .join('\n')
      .toLocaleLowerCase()
      .includes(query)
  })

  const statusOrder: Record<StoryMemoryEntry['status'], number> = {
    confirmed: 0,
    suggested: 1,
    rejected: 2,
  }
  return matches.sort((a, b) => {
    if (sort === 'updated') return b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)
    if (sort === 'status') {
      return statusOrder[a.status] - statusOrder[b.status] || b.updatedAt - a.updatedAt
    }
    return (
      a.source.volumeOrder - b.source.volumeOrder ||
      a.source.chapterOrder - b.source.chapterOrder ||
      a.createdAt - b.createdAt ||
      a.id.localeCompare(b.id)
    )
  })
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
