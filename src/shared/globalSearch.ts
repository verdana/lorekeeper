import type {
  DiscussionSession,
  NovelMeta,
  SettingDoc,
  SnapshotEntry,
  TimelineEvent,
} from './types'

export type GlobalSearchResultKind = 'chapter' | 'setting' | 'timeline' | 'discussion' | 'snapshot'

export interface GlobalSearchResult {
  id: string
  kind: GlobalSearchResultKind
  title: string
  subtitle: string
  searchText: string
}

export interface GlobalSearchSource {
  novel: NovelMeta
  settings: SettingDoc[]
  timeline: TimelineEvent[]
  discussions: DiscussionSession[]
  snapshots: SnapshotEntry[]
}

const normalize = (value: string): string => value.normalize('NFKC').toLocaleLowerCase().trim()

/** Build lightweight, local-only search records from already available project metadata. */
export function createGlobalSearchResults(source: GlobalSearchSource): GlobalSearchResult[] {
  const chapters = source.novel.volumes.flatMap((volume) =>
    volume.chapters.map((chapter) => ({
      id: chapter.id,
      kind: 'chapter' as const,
      title: chapter.title,
      subtitle: `${volume.title} · ${chapter.status === 'done' ? 'Final' : 'Draft'}`,
      searchText: `${chapter.title} ${volume.title} ${chapter.status}`,
    })),
  )
  const settings = source.settings.map((doc) => ({
    id: doc.id,
    kind: 'setting' as const,
    title: doc.title,
    subtitle: `Codex · ${doc.category}`,
    searchText: `${doc.title} ${doc.category} ${doc.id}`,
  }))
  const timeline = source.timeline.map((event) => ({
    id: event.id,
    kind: 'timeline' as const,
    title: event.title,
    subtitle: event.dateLabel ? `Timeline · ${event.dateLabel}` : 'Timeline event',
    searchText: `${event.title} ${event.dateLabel}`,
  }))
  const discussions = source.discussions.map((session) => ({
    id: session.id,
    kind: 'discussion' as const,
    title: session.topic,
    subtitle: `Writers Room · ${new Date(session.createdAt).toLocaleDateString()}`,
    searchText: session.topic,
  }))
  const snapshots = source.snapshots.map((snapshot) => ({
    id: snapshot.id,
    kind: 'snapshot' as const,
    title: snapshot.label,
    subtitle: `History · ${snapshot.kind} · ${new Date(snapshot.ts).toLocaleDateString()}`,
    searchText: `${snapshot.label} ${snapshot.sourcePath} ${snapshot.kind}`,
  }))
  return [...chapters, ...settings, ...timeline, ...discussions, ...snapshots]
}

/** Match every query token and rank title matches ahead of secondary metadata matches. */
export function searchGlobalResults(
  records: GlobalSearchResult[],
  query: string,
  limit = 50,
): GlobalSearchResult[] {
  const normalizedQuery = normalize(query)
  if (!normalizedQuery) return []
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean)
  return records
    .filter((record) => {
      const text = normalize(record.searchText)
      return tokens.every((token) => text.includes(token))
    })
    .sort((left, right) => {
      const leftTitle = normalize(left.title)
      const rightTitle = normalize(right.title)
      const leftScore =
        leftTitle === normalizedQuery ? 0 : leftTitle.startsWith(normalizedQuery) ? 1 : 2
      const rightScore =
        rightTitle === normalizedQuery ? 0 : rightTitle.startsWith(normalizedQuery) ? 1 : 2
      return (
        leftScore - rightScore ||
        left.title.localeCompare(right.title) ||
        left.id.localeCompare(right.id)
      )
    })
    .slice(0, limit)
}
