import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Brain,
  Check,
  ChevronRight,
  FileText,
  Loader2,
  RotateCcw,
  Search,
  Send,
  Square,
  X,
} from 'lucide-react'
import { chatStream } from '../api'
import { useStore } from '../store'
import { toastError, toastSuccess, parseAiError } from '../toast'
import { uid } from '../lib'
import { PROMPTS } from '@shared/prompts'
import {
  browseStoryMemories,
  isStoryMemoryStale,
  orderedChapters,
  parseStoryMemoryCandidates,
  storyMemoryFingerprint,
  type StoryMemorySort,
  type StoryMemoryStalenessFilter,
} from '@shared/storyMemory'
import type {
  StoryMemoryEntry,
  StoryMemoryKind,
  StoryMemoryStore,
  TimelineEvent,
} from '@shared/types'
import clsx from 'clsx'

const KINDS: Array<{ id: StoryMemoryKind; label: string }> = [
  { id: 'character-state', label: 'Character state' },
  { id: 'relationship', label: 'Relationship' },
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'location', label: 'Location' },
  { id: 'object', label: 'Object' },
  { id: 'world-state', label: 'World state' },
  { id: 'open-thread', label: 'Open thread' },
]

export default function StoryMemory(): JSX.Element {
  const novel = useStore((s) => s.novel)!
  const config = useStore((s) => s.config)
  const settingDocs = useStore((s) => s.settingDocs)
  const focusChapterId = useStore((s) => s.storyMemoryFocusChapterId)
  const openChapter = useStore((s) => s.openChapter)
  const currentWorldId = useStore((s) => s.currentWorldId)

  const chapters = useMemo(() => orderedChapters(novel), [novel])
  const [memory, setMemory] = useState<StoryMemoryStore>({ version: 1, entries: [] })
  const [events, setEvents] = useState<TimelineEvent[]>([])
  const [selectedChapterId, setSelectedChapterId] = useState('')
  const [sourceText, setSourceText] = useState('')
  const [memorySourceTexts, setMemorySourceTexts] = useState<Map<string, string>>(new Map())
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StoryMemoryEntry['status'] | 'all'>('all')
  const [kindFilter, setKindFilter] = useState<StoryMemoryKind | 'all'>('all')
  const [stalenessFilter, setStalenessFilter] = useState<StoryMemoryStalenessFilter>('all')
  const [sort, setSort] = useState<StoryMemorySort>('narrative')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [extracting, setExtracting] = useState(false)
  const [saving, setSaving] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const selected = chapters.find((item) => item.chapter.id === selectedChapterId) ?? null
  const hasKey = Boolean(config?.ai.providers.some((provider) => provider.apiKey))
  const selectedEntries = memory.entries.filter(
    (entry) => entry.source.chapterId === selectedChapterId,
  )
  const scopedEntries = selectedChapterId ? selectedEntries : memory.entries
  const visibleEntries = useMemo(
    () =>
      browseStoryMemories({
        entries: memory.entries,
        settingDocs,
        sourceTexts: memorySourceTexts,
        chapterId: selectedChapterId || undefined,
        query,
        status: statusFilter,
        kind: kindFilter,
        staleness: stalenessFilter,
        sort,
      }),
    [
      kindFilter,
      memory.entries,
      memorySourceTexts,
      query,
      selectedChapterId,
      settingDocs,
      sort,
      stalenessFilter,
      statusFilter,
    ],
  )
  const hasActiveFilters =
    Boolean(query) || statusFilter !== 'all' || kindFilter !== 'all' || stalenessFilter !== 'all'

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError('')
    Promise.all([window.api.readStoryMemory(), window.api.listTimelineEvents()])
      .then(([store, timeline]) => {
        if (cancelled) return
        setMemory(store)
        setEvents(timeline)
        setSelectedChapterId((current) => {
          if (chapters.some((item) => item.chapter.id === current)) return current
          if (focusChapterId && chapters.some((item) => item.chapter.id === focusChapterId)) {
            return focusChapterId
          }
          return chapters[0]?.chapter.id || ''
        })
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError((error as Error).message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [currentWorldId, focusChapterId, chapters])

  useEffect(() => {
    let cancelled = false
    if (!selected) {
      setSourceText('')
      return
    }
    setSourceText('')
    window.api
      .readChapter(selected.chapter.file)
      .then((text: string) => {
        if (!cancelled) {
          setSourceText(text)
          setMemorySourceTexts((current) => {
            const next = new Map(current)
            next.set(selected.chapter.id, text)
            return next
          })
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) toastError('Failed to read chapter: ' + (error as Error).message)
      })
    return () => {
      cancelled = true
    }
  }, [selected?.chapter.id])

  useEffect(() => {
    let cancelled = false
    const sources = Array.from(
      new Map(memory.entries.map((entry) => [entry.source.chapterId, entry.source.chapterFile])),
    )
    if (sources.length === 0) {
      setMemorySourceTexts(new Map())
      return
    }
    Promise.all(
      sources.map(async ([chapterId, chapterFile]) => {
        try {
          return [chapterId, await window.api.readChapter(chapterFile)] as const
        } catch {
          return null
        }
      }),
    ).then((items) => {
      if (cancelled) return
      setMemorySourceTexts(
        new Map(items.filter((item): item is readonly [string, string] => item !== null)),
      )
    })
    return () => {
      cancelled = true
    }
  }, [currentWorldId, memory.entries])

  useEffect(() => () => abortRef.current?.abort(), [])

  const persist = async (next: StoryMemoryStore): Promise<void> => {
    setSaving(true)
    try {
      await window.api.writeStoryMemory(next)
      setMemory(next)
    } catch (error) {
      toastError('Failed to save Story Memory: ' + (error as Error).message)
      throw error
    } finally {
      setSaving(false)
    }
  }

  const updateLocal = (id: string, update: Partial<StoryMemoryEntry>): void => {
    setMemory((current) => ({
      ...current,
      entries: current.entries.map((entry) =>
        entry.id === id ? { ...entry, ...update, updatedAt: Date.now() } : entry,
      ),
    }))
  }

  const saveEntry = async (id: string): Promise<void> => {
    const entry = memory.entries.find((item) => item.id === id)
    if (!entry?.statement.trim()) {
      toastError('A memory needs a statement before it can be saved.')
      return
    }
    await persist({
      ...memory,
      entries: memory.entries.map((item) => (item.id === id ? entry : item)),
    })
    toastSuccess('Story Memory saved.')
  }

  const setStatus = async (id: string, status: StoryMemoryEntry['status']): Promise<void> => {
    const next = {
      ...memory,
      entries: memory.entries.map((entry) =>
        entry.id === id
          ? {
              ...entry,
              status,
              confirmedAt: status === 'confirmed' ? Date.now() : entry.confirmedAt,
              updatedAt: Date.now(),
            }
          : entry,
      ),
    }
    await persist(next)
    toastSuccess(
      status === 'confirmed'
        ? 'Memory confirmed.'
        : status === 'rejected'
          ? 'Memory rejected.'
          : 'Memory restored.',
    )
  }

  const reconfirm = async (entry: StoryMemoryEntry): Promise<void> => {
    const entrySourceText = memorySourceTexts.get(entry.source.chapterId)
    if (!entrySourceText?.includes(entry.source.evidence)) {
      toastError(
        'The saved evidence no longer appears in this chapter. Extract a new candidate instead.',
      )
      return
    }
    const now = Date.now()
    await persist({
      ...memory,
      entries: memory.entries.map((item) =>
        item.id === entry.id
          ? {
              ...item,
              source: { ...item.source, fingerprint: storyMemoryFingerprint(entrySourceText) },
              status: 'confirmed',
              confirmedAt: now,
              updatedAt: now,
            }
          : item,
      ),
    })
    toastSuccess('Memory reconfirmed against the saved chapter.')
  }

  const extract = async (): Promise<void> => {
    if (!selected || !sourceText.trim() || extracting || !hasKey) return
    if (
      selectedEntries.some((entry) => entry.status !== 'rejected') &&
      !confirm(
        'Extract another set of candidates? Existing confirmed memories will not be changed.',
      )
    ) {
      return
    }
    setExtracting(true)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const entities = settingDocs.map((doc) => `- ${doc.id} | ${doc.title}`).join('\n')
      const timeline = events
        .map((event) => `- ${event.id} | ${event.dateLabel || 'Undated'} | ${event.title}`)
        .join('\n')
      const { content } = await chatStream(
        [
          { role: 'system', content: PROMPTS.storyMemory.systemPrompt },
          {
            role: 'user',
            content: PROMPTS.storyMemory.userTemplate({
              chapterTitle: selected.chapter.title,
              prose: sourceText,
              entities,
              timeline,
            }),
          },
        ],
        config?.writing.providerId ?? config?.ai.activeProviderId ?? undefined,
        () => {},
        controller.signal,
        config?.writing.temperature,
        config?.writing.topP,
      )
      if (controller.signal.aborted) return
      const candidates = parseStoryMemoryCandidates(
        content,
        sourceText,
        new Set(settingDocs.map((doc) => doc.id)),
        new Set(events.map((event) => event.id)),
      )
      if (candidates.length === 0) {
        toastError(
          'No verifiable memory candidates were returned. Try again with a more complete chapter.',
        )
        return
      }
      const now = Date.now()
      const entries: StoryMemoryEntry[] = candidates.map((candidate) => ({
        id: uid('mem_'),
        ...candidate,
        source: {
          chapterId: selected.chapter.id,
          chapterFile: selected.chapter.file,
          chapterTitle: selected.chapter.title,
          volumeId: selected.volume.id,
          volumeOrder: selected.volume.order,
          chapterOrder: selected.chapter.order,
          fingerprint: storyMemoryFingerprint(sourceText),
          evidence: candidate.evidence,
        },
        status: 'suggested',
        origin: 'ai',
        createdAt: now,
        updatedAt: now,
        confirmedAt: null,
      }))
      await persist({ ...memory, entries: [...memory.entries, ...entries] })
      toastSuccess(
        `${entries.length} memory candidate${entries.length === 1 ? '' : 's'} ready for review.`,
      )
    } catch (error) {
      if (!controller.signal.aborted) toastError(parseAiError(error))
    } finally {
      if (abortRef.current === controller) abortRef.current = null
      setExtracting(false)
    }
  }

  const stopExtraction = (): void => {
    abortRef.current?.abort()
  }

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-ink-500">
        Loading Story Memory…
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="h-full flex items-center justify-center p-8">
        <div className="max-w-lg card p-6">
          <h1 className="text-lg font-semibold text-star-danger">
            Story Memory could not be loaded
          </h1>
          <p className="text-sm text-ink-muted mt-3 leading-relaxed">{loadError}</p>
          <p className="text-xs text-ink-500 mt-3">
            No changes were made. Fix or restore the local story-memory.json file before continuing.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex min-w-0">
      <aside className="w-72 shrink-0 border-r border-ink-800 bg-ink-900/80 flex flex-col">
        <div className="px-4 py-3.5 border-b border-ink-800">
          <h2 className="text-sm font-semibold text-ink-body flex items-center gap-2">
            <Brain size={16} /> Story Memory
          </h2>
          <p className="text-[11px] text-ink-500 mt-1.5 leading-relaxed">
            Review durable changes before they become continuity context.
          </p>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          <button
            onClick={() => setSelectedChapterId('')}
            className={clsx(
              'w-full text-left rounded-md px-3 py-2.5 transition-colors',
              selectedChapterId === ''
                ? 'bg-ink-700 text-ink-body'
                : 'text-ink-muted hover:bg-ink-850',
            )}
          >
            <div className="text-sm truncate">All memories</div>
            <div className="text-[10px] text-ink-500 mt-0.5">{memory.entries.length} total</div>
          </button>
          {chapters.map(({ chapter }) => {
            const count = memory.entries.filter(
              (entry) => entry.source.chapterId === chapter.id && entry.status === 'confirmed',
            ).length
            return (
              <button
                key={chapter.id}
                onClick={() => setSelectedChapterId(chapter.id)}
                className={clsx(
                  'w-full text-left rounded-md px-3 py-2.5 transition-colors',
                  selectedChapterId === chapter.id
                    ? 'bg-ink-700 text-ink-body'
                    : 'text-ink-muted hover:bg-ink-850',
                )}
              >
                <div className="text-sm truncate">{chapter.title}</div>
                <div className="text-[10px] text-ink-500 mt-0.5">{count} confirmed</div>
              </button>
            )
          })}
        </div>
      </aside>

      <main className="flex-1 min-w-0 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-8 py-8">
          {chapters.length === 0 ? (
            <div className="text-center py-24 text-ink-500">
              Create a chapter before building Story Memory.
            </div>
          ) : (
            <>
              <div className="flex items-start justify-between gap-4 mb-8">
                <div>
                  <h1 className="text-xl font-semibold text-ink-deep">
                    {selected ? selected.chapter.title : 'All memories'}
                  </h1>
                  <p className="text-sm text-ink-500 mt-1">
                    {selected
                      ? 'Extract only after the chapter is saved. Nothing runs automatically.'
                      : 'Search and review continuity facts across every chapter.'}
                  </p>
                </div>
                {selected && (
                  <button
                    onClick={extracting ? stopExtraction : extract}
                    disabled={!extracting && (!hasKey || !sourceText.trim())}
                    className={clsx('btn shrink-0', extracting ? 'btn-danger' : 'btn-primary')}
                  >
                    {extracting ? <Square size={15} /> : <Send size={15} />}
                    {extracting ? 'Stop extraction' : 'Extract candidates'}
                  </button>
                )}
              </div>
              {selected && !hasKey && (
                <p className="text-sm text-star-danger mb-6">
                  Configure an AI provider before extracting candidates.
                </p>
              )}
              {selected && !sourceText.trim() && (
                <p className="text-sm text-star-danger mb-6">This saved chapter is empty.</p>
              )}
              <section className="rounded-lg border border-ink-800 bg-ink-900/40 p-3 mb-6">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_140px_150px_140px_150px] gap-2">
                  <label className="relative">
                    <Search
                      size={15}
                      className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-500"
                    />
                    <input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      className="input w-full pl-9 text-sm"
                      placeholder="Search facts, evidence, entities…"
                    />
                  </label>
                  <select
                    className="input text-sm"
                    value={statusFilter}
                    onChange={(event) =>
                      setStatusFilter(event.target.value as StoryMemoryEntry['status'] | 'all')
                    }
                  >
                    <option value="all">All statuses</option>
                    <option value="confirmed">Confirmed</option>
                    <option value="suggested">Suggested</option>
                    <option value="rejected">Rejected</option>
                  </select>
                  <select
                    className="input text-sm"
                    value={kindFilter}
                    onChange={(event) =>
                      setKindFilter(event.target.value as StoryMemoryKind | 'all')
                    }
                  >
                    <option value="all">All types</option>
                    {KINDS.map((kind) => (
                      <option key={kind.id} value={kind.id}>
                        {kind.label}
                      </option>
                    ))}
                  </select>
                  <select
                    className="input text-sm"
                    value={stalenessFilter}
                    onChange={(event) =>
                      setStalenessFilter(event.target.value as StoryMemoryStalenessFilter)
                    }
                  >
                    <option value="all">Any source</option>
                    <option value="fresh">Current source</option>
                    <option value="stale">Source changed</option>
                  </select>
                  <select
                    className="input text-sm"
                    value={sort}
                    onChange={(event) => setSort(event.target.value as StoryMemorySort)}
                  >
                    <option value="narrative">Narrative order</option>
                    <option value="updated">Last updated</option>
                    <option value="status">Review status</option>
                  </select>
                </div>
                <div className="mt-2 flex items-center justify-between gap-3 text-xs text-ink-500">
                  <span>
                    {visibleEntries.length} of {scopedEntries.length} memories
                  </span>
                  {hasActiveFilters && (
                    <button
                      onClick={() => {
                        setQuery('')
                        setStatusFilter('all')
                        setKindFilter('all')
                        setStalenessFilter('all')
                      }}
                      className="text-star-info hover:text-star-accent"
                    >
                      Clear filters
                    </button>
                  )}
                </div>
              </section>
              {visibleEntries.length === 0 ? (
                <div className="rounded-lg border border-dashed border-ink-700 p-10 text-center text-ink-500">
                  {scopedEntries.length === 0
                    ? selected
                      ? 'No memories from this chapter yet. Extraction creates suggestions only; you decide what becomes canon.'
                      : 'No memories have been extracted yet.'
                    : 'No memories match the current filters.'}
                </div>
              ) : (
                <div className="space-y-4">
                  {visibleEntries.map((entry) => (
                    <MemoryCard
                      key={entry.id}
                      entry={entry}
                      settingDocs={settingDocs}
                      events={events}
                      stale={
                        memorySourceTexts.has(entry.source.chapterId) &&
                        isStoryMemoryStale(entry, memorySourceTexts.get(entry.source.chapterId))
                      }
                      saving={saving}
                      onUpdate={updateLocal}
                      onSave={saveEntry}
                      onStatus={setStatus}
                      onReconfirm={reconfirm}
                      onOpenSource={() => openChapter(entry.source.chapterId)}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  )
}

function MemoryCard({
  entry,
  settingDocs,
  events,
  stale,
  saving,
  onUpdate,
  onSave,
  onStatus,
  onReconfirm,
  onOpenSource,
}: {
  entry: StoryMemoryEntry
  settingDocs: ReturnType<typeof useStore.getState>['settingDocs']
  events: TimelineEvent[]
  stale: boolean
  saving: boolean
  onUpdate: (id: string, update: Partial<StoryMemoryEntry>) => void
  onSave: (id: string) => Promise<void>
  onStatus: (id: string, status: StoryMemoryEntry['status']) => Promise<void>
  onReconfirm: (entry: StoryMemoryEntry) => Promise<void>
  onOpenSource: () => void
}): JSX.Element {
  const label = KINDS.find((kind) => kind.id === entry.kind)?.label ?? entry.kind
  return (
    <section
      className={clsx(
        'card p-5',
        entry.status === 'rejected' && 'opacity-60',
        stale && 'border-star-accent',
      )}
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <div>
            <span className="text-[10px] uppercase tracking-wider font-semibold text-star-accent">
              {entry.status}
            </span>
            <p className="text-[10px] text-ink-500 mt-0.5">From {entry.source.chapterTitle}</p>
          </div>
          {stale && <span className="text-[10px] text-star-danger">source changed</span>}
        </div>
        <button
          onClick={onOpenSource}
          className="text-xs text-star-info hover:text-star-accent flex items-center gap-1"
        >
          <FileText size={12} /> Source <ChevronRight size={12} />
        </button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-[150px_1fr] gap-3">
        <select
          className="input text-sm"
          value={entry.kind}
          onChange={(e) => onUpdate(entry.id, { kind: e.target.value as StoryMemoryKind })}
        >
          {KINDS.map((kind) => (
            <option key={kind.id} value={kind.id}>
              {kind.label}
            </option>
          ))}
        </select>
        <input
          className="input text-sm"
          value={entry.statement}
          onChange={(e) => onUpdate(entry.id, { statement: e.target.value })}
          placeholder="Durable story fact"
        />
      </div>
      <blockquote className="mt-3 border-l-2 border-ink-700 pl-3 text-xs text-ink-500 italic">
        “{entry.source.evidence}”
      </blockquote>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
        <select
          className="input text-sm"
          value={entry.timelineEventId ?? ''}
          onChange={(e) => onUpdate(entry.id, { timelineEventId: e.target.value || null })}
        >
          <option value="">No timeline event</option>
          {events.map((event) => (
            <option key={event.id} value={event.id}>
              {event.dateLabel ? `${event.dateLabel} · ` : ''}
              {event.title}
            </option>
          ))}
        </select>
        <input
          className="input text-sm"
          value={entry.storyDateLabel}
          onChange={(e) => onUpdate(entry.id, { storyDateLabel: e.target.value })}
          placeholder="Optional story date"
        />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {settingDocs.map((doc) => {
          const selected = entry.entityRefIds.includes(doc.id)
          return (
            <button
              key={doc.id}
              onClick={() =>
                onUpdate(entry.id, {
                  entityRefIds: selected
                    ? entry.entityRefIds.filter((id) => id !== doc.id)
                    : [...entry.entityRefIds, doc.id],
                })
              }
              className={clsx(
                'text-[11px] px-2 py-1 rounded-full border transition-colors',
                selected
                  ? 'border-star-accent text-star-accent bg-star-accent/10'
                  : 'border-ink-700 text-ink-500 hover:text-ink-muted',
              )}
            >
              {doc.title}
            </button>
          )
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2 mt-4">
        <button
          onClick={() => onSave(entry.id)}
          disabled={saving}
          className="btn btn-sm btn-secondary"
        >
          Save edits
        </button>
        {entry.status !== 'confirmed' && (
          <button
            onClick={() => onStatus(entry.id, 'confirmed')}
            disabled={saving || stale || !entry.statement.trim()}
            className="btn btn-sm btn-primary"
          >
            <Check size={13} /> Confirm
          </button>
        )}
        {entry.status !== 'rejected' ? (
          <button
            onClick={() => onStatus(entry.id, 'rejected')}
            disabled={saving}
            className="btn btn-sm btn-ghost"
          >
            <X size={13} /> Reject
          </button>
        ) : (
          <button
            onClick={() => onStatus(entry.id, 'suggested')}
            disabled={saving}
            className="btn btn-sm btn-ghost"
          >
            <RotateCcw size={13} /> Restore
          </button>
        )}
        {stale && (
          <button
            onClick={() => onReconfirm(entry)}
            disabled={saving}
            className="btn btn-sm btn-ghost"
          >
            Reconfirm source
          </button>
        )}
        {entry.confidence !== null && (
          <span className="ml-auto text-[11px] text-ink-500">
            Model confidence {Math.round(entry.confidence * 100)}%
          </span>
        )}
      </div>
    </section>
  )
}
