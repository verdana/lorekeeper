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

export interface StoryMemoryBatchResult {
  store: StoryMemoryStore
  changed: number
  skipped: number
}

export interface StoryMemoryDuplicateGroup {
  id: string
  reason: 'same-statement' | 'same-evidence'
  entries: StoryMemoryEntry[]
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

/** Apply a safe, single-write status change to a set of author-selected memories. */
export function applyStoryMemoryBatchStatus(
  store: StoryMemoryStore,
  selectedIds: ReadonlySet<string>,
  status: StoryMemoryEntry['status'],
  sourceTexts: Map<string, string>,
  now = Date.now(),
): StoryMemoryBatchResult {
  let changed = 0
  let skipped = 0
  const entries = store.entries.map((entry) => {
    if (!selectedIds.has(entry.id)) return entry
    if (status === 'suggested' && entry.status !== 'rejected') {
      skipped++
      return entry
    }
    if (status === 'confirmed') {
      const sourceText = sourceTexts.get(entry.source.chapterId)
      if (
        !entry.statement.trim() ||
        sourceText === undefined ||
        isStoryMemoryStale(entry, sourceText)
      ) {
        skipped++
        return entry
      }
    }
    if (entry.status === status) return entry
    changed++
    return {
      ...entry,
      status,
      confirmedAt: status === 'confirmed' ? now : entry.confirmedAt,
      updatedAt: now,
    }
  })
  return { store: { ...store, entries }, changed, skipped }
}

const normalizeDuplicateText = (value: string): string =>
  value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

/** Find conservative duplicate groups without mutating or choosing a canonical entry. */
export function findStoryMemoryDuplicateGroups(
  entries: StoryMemoryEntry[],
): StoryMemoryDuplicateGroup[] {
  const active = entries.filter((entry) => entry.status !== 'rejected')
  const parent = new Map(active.map((entry) => [entry.id, entry.id]))
  const reasons = new Map<string, Set<StoryMemoryDuplicateGroup['reason']>>()

  const find = (id: string): string => {
    const current = parent.get(id)
    if (!current || current === id) return id
    const root = find(current)
    parent.set(id, root)
    return root
  }
  const link = (left: string, right: string, reason: StoryMemoryDuplicateGroup['reason']): void => {
    const leftRoot = find(left)
    const rightRoot = find(right)
    const root = leftRoot
    if (leftRoot !== rightRoot) parent.set(rightRoot, root)
    const rootReasons = reasons.get(root) ?? new Set()
    rootReasons.add(reason)
    const otherReasons = reasons.get(rightRoot)
    if (otherReasons) for (const item of otherReasons) rootReasons.add(item)
    reasons.set(root, rootReasons)
  }

  const linkBuckets = (
    buckets: Map<string, string[]>,
    reason: StoryMemoryDuplicateGroup['reason'],
  ): void => {
    for (const ids of buckets.values()) {
      for (let index = 1; index < ids.length; index++) link(ids[0], ids[index], reason)
    }
  }

  const statementBuckets = new Map<string, string[]>()
  const evidenceBuckets = new Map<string, string[]>()
  for (const entry of active) {
    const statement = normalizeDuplicateText(entry.statement)
    if (statement.length >= 4) {
      const key = `${entry.kind}|${statement}`
      statementBuckets.set(key, [...(statementBuckets.get(key) ?? []), entry.id])
    }
    const evidence = normalizeDuplicateText(entry.source.evidence)
    if (evidence.length >= 4) {
      const key = `${entry.kind}|${entry.source.chapterId}|${evidence}`
      evidenceBuckets.set(key, [...(evidenceBuckets.get(key) ?? []), entry.id])
    }
  }
  linkBuckets(statementBuckets, 'same-statement')
  linkBuckets(evidenceBuckets, 'same-evidence')

  const grouped = new Map<string, StoryMemoryEntry[]>()
  for (const entry of active) {
    const root = find(entry.id)
    grouped.set(root, [...(grouped.get(root) ?? []), entry])
  }

  return [...grouped.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([root, group]) => {
      const reason: StoryMemoryDuplicateGroup['reason'] = reasons
        .get(find(root))
        ?.has('same-statement')
        ? 'same-statement'
        : 'same-evidence'
      return {
        id: `duplicate-${root}`,
        reason,
        entries: group.sort((a, b) => a.updatedAt - b.updatedAt),
      }
    })
    .sort((a, b) => a.entries[0].updatedAt - b.entries[0].updatedAt)
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
