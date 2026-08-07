import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { BookMarked, Clock, History, Library, Search, ScrollText, Users } from 'lucide-react'
import clsx from 'clsx'
import {
  createGlobalSearchResults,
  searchGlobalResults,
  type GlobalSearchResult,
} from '@shared/globalSearch'
import type { DiscussionSession, SnapshotEntry, TimelineEvent } from '@shared/types'
import { useStore, type ViewKey } from '../store'

interface NavigationCommand {
  id: string
  title: string
  subtitle: string
  view: ViewKey
}

type PaletteItem =
  { type: 'command'; command: NavigationCommand } | { type: 'result'; result: GlobalSearchResult }

const NAVIGATION_COMMANDS: NavigationCommand[] = [
  { id: 'dashboard', title: 'Open Overview', subtitle: 'Navigate', view: 'dashboard' },
  { id: 'codex', title: 'Open Codex', subtitle: 'Navigate', view: 'settings-docs' },
  { id: 'graph', title: 'Open Graph', subtitle: 'Navigate', view: 'graph' },
  { id: 'timeline', title: 'Open Timeline', subtitle: 'Navigate', view: 'timeline' },
  { id: 'story-memory', title: 'Open Story Memory', subtitle: 'Navigate', view: 'story-memory' },
  { id: 'outline', title: 'Open Outline', subtitle: 'Navigate', view: 'outline' },
  { id: 'manuscript', title: 'Open Manuscript', subtitle: 'Navigate', view: 'chapters' },
  { id: 'consistency', title: 'Open Consistency', subtitle: 'Navigate', view: 'consistency' },
  { id: 'review-queue', title: 'Open Review Queue', subtitle: 'Navigate', view: 'review-queue' },
  { id: 'discussion', title: 'Open Writers Room', subtitle: 'Navigate', view: 'discussion' },
  { id: 'history', title: 'Open History', subtitle: 'Navigate', view: 'history' },
  { id: 'voice', title: 'Open Voice Profile', subtitle: 'Navigate', view: 'voice-profile' },
  { id: 'characters', title: 'Open Characters', subtitle: 'Navigate', view: 'character-chat' },
  { id: 'preferences', title: 'Open Settings', subtitle: 'Navigate', view: 'preferences' },
]

const resultIcon = (kind: GlobalSearchResult['kind']): JSX.Element => {
  const props = { size: 15, className: 'shrink-0 text-ink-500' }
  if (kind === 'chapter') return <ScrollText {...props} />
  if (kind === 'setting') return <Library {...props} />
  if (kind === 'timeline') return <Clock {...props} />
  if (kind === 'discussion') return <Users {...props} />
  return <History {...props} />
}

export default function CommandPalette(): JSX.Element | null {
  const novel = useStore((state) => state.novel)
  const settings = useStore((state) => state.settingDocs)
  const currentWorldId = useStore((state) => state.currentWorldId)
  const setView = useStore((state) => state.setView)
  const openChapter = useStore((state) => state.openChapter)
  const openSetting = useStore((state) => state.openSetting)
  const openTimelineEvent = useStore((state) => state.openTimelineEvent)
  const openDiscussion = useStore((state) => state.openDiscussion)
  const openSnapshot = useStore((state) => state.openSnapshot)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [timeline, setTimeline] = useState<TimelineEvent[]>([])
  const [discussions, setDiscussions] = useState<DiscussionSession[]>([])
  const [snapshots, setSnapshots] = useState<SnapshotEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault()
        setOpen(true)
      }
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    if (!open || !currentWorldId) return
    let cancelled = false
    setLoading(true)
    Promise.all([
      window.api.listTimelineEvents().catch(() => [] as TimelineEvent[]),
      window.api.listDiscussions().catch(() => [] as DiscussionSession[]),
      window.api.listSnapshots().catch(() => [] as SnapshotEntry[]),
    ]).then(([nextTimeline, nextDiscussions, nextSnapshots]) => {
      if (cancelled) return
      setTimeline(nextTimeline)
      setDiscussions(nextDiscussions)
      setSnapshots(nextSnapshots)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [currentWorldId, open])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActiveIndex(0)
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  const records = useMemo(
    () =>
      novel ? createGlobalSearchResults({ novel, settings, timeline, discussions, snapshots }) : [],
    [discussions, novel, settings, snapshots, timeline],
  )
  const items = useMemo<PaletteItem[]>(() => {
    const normalized = query.trim().toLocaleLowerCase()
    const commands = NAVIGATION_COMMANDS.filter((command) =>
      `${command.title} ${command.subtitle}`.toLocaleLowerCase().includes(normalized),
    ).map((command) => ({ type: 'command' as const, command }))
    return [
      ...commands,
      ...searchGlobalResults(records, query).map((result) => ({ type: 'result' as const, result })),
    ]
  }, [query, records])

  useEffect(() => setActiveIndex(0), [items.length, query])

  const select = (item: PaletteItem): void => {
    setOpen(false)
    if (item.type === 'command') {
      setView(item.command.view)
      return
    }
    const { kind, id } = item.result
    if (kind === 'chapter') openChapter(id)
    else if (kind === 'setting') openSetting(id)
    else if (kind === 'timeline') openTimelineEvent(id)
    else if (kind === 'discussion') openDiscussion(id)
    else openSnapshot(id)
  }

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => Math.min(index + 1, Math.max(items.length - 1, 0)))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) => Math.max(index - 1, 0))
    } else if (event.key === 'Enter' && items[activeIndex]) {
      event.preventDefault()
      select(items[activeIndex])
    }
  }

  if (!open || !novel) return null

  return (
    <div className="fixed inset-0 z-100 flex items-start justify-center pt-[12vh] px-4">
      <button
        aria-label="Close command palette"
        className="absolute inset-0 bg-ink-950/70 backdrop-blur-sm"
        onClick={() => setOpen(false)}
      />
      <section className="relative w-full max-w-2xl overflow-hidden rounded-[14px] border border-ink-700 bg-ink-900 shadow-warm-lg">
        <div className="flex items-center gap-3 border-b border-ink-800 px-4">
          <Search size={18} className="text-star-accent" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Search your world or run a command…"
            className="h-13 flex-1 bg-transparent text-sm text-ink-body outline-none placeholder:text-ink-500"
          />
          <kbd className="rounded border border-ink-700 px-1.5 py-0.5 text-[10px] text-ink-500">
            Esc
          </kbd>
        </div>
        <div className="max-h-[58vh] overflow-y-auto p-2">
          {items.length === 0 ? (
            <div className="px-3 py-10 text-center text-sm text-ink-500">
              {loading
                ? 'Loading searchable project data…'
                : 'No matching commands or project items.'}
            </div>
          ) : (
            items.map((item, index) => {
              const command = item.type === 'command' ? item.command : null
              const result = item.type === 'result' ? item.result : null
              return (
                <button
                  key={command ? `command-${command.id}` : `${result!.kind}-${result!.id}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => select(item)}
                  className={clsx(
                    'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors',
                    activeIndex === index ? 'bg-ink-700' : 'hover:bg-ink-850',
                  )}
                >
                  {command ? (
                    <BookMarked size={15} className="shrink-0 text-star-accent" />
                  ) : (
                    resultIcon(result!.kind)
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink-body">
                      {command?.title ?? result!.title}
                    </span>
                    <span className="block truncate text-[11px] text-ink-500">
                      {command?.subtitle ?? result!.subtitle}
                    </span>
                  </span>
                </button>
              )
            })
          )}
        </div>
        <div className="flex items-center justify-between border-t border-ink-800 px-4 py-2 text-[10px] text-ink-500">
          <span>Searches local titles and metadata only</span>
          <span>↑↓ Navigate · ↵ Open</span>
        </div>
      </section>
    </div>
  )
}
