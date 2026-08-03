import { useCallback, useEffect, useState } from 'react'
import { useStore } from '../store'
import { toastError, toastSuccess } from '../toast'
import { uid } from '../lib'
import type { SettingDoc, TimelineEvent } from '@shared/types'
import { Plus, Trash2, Pencil, X, Check, Clock } from 'lucide-react'
import clsx from 'clsx'

interface TimelineForm {
  title: string
  dateLabel: string
  dateOrder: number
  description: string
  docRefs: string[]
}

interface CodexReferencePickerProps {
  docs: SettingDoc[]
  selectedIds: string[]
  onChange: (ids: string[]) => void
}

function CodexReferencePicker({
  docs,
  selectedIds,
  onChange,
}: CodexReferencePickerProps): JSX.Element {
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const matchingDocs = docs.filter((doc) =>
    `${doc.title} ${doc.category}`.toLocaleLowerCase().includes(normalizedQuery),
  )
  const selectedDocs = selectedIds.map((id) => docs.find((doc) => doc.id === id))

  const toggle = (id: string): void => {
    onChange(
      selectedIds.includes(id) ? selectedIds.filter((ref) => ref !== id) : [...selectedIds, id],
    )
  }

  return (
    <div className="space-y-2">
      <div className="text-[11px] text-ink-500">Related codex documents</div>
      {selectedIds.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectedIds.map((id, index) => (
            <button
              key={id}
              type="button"
              onClick={() => toggle(id)}
              className="rounded-full bg-star-accent/10 px-2 py-0.5 text-[10px] text-star-accent hover:bg-star-accent/20"
              title="Remove linked document"
            >
              {selectedDocs[index]?.title ?? id} <span aria-hidden="true">×</span>
            </button>
          ))}
        </div>
      )}
      <input
        className="input text-sm"
        placeholder="Search codex documents…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {docs.length > 0 && (
        <div className="max-h-28 overflow-y-auto rounded border border-ink-800 bg-ink-900/60 p-1">
          {matchingDocs.map((doc) => {
            const selected = selectedIds.includes(doc.id)
            return (
              <button
                key={doc.id}
                type="button"
                aria-pressed={selected}
                onClick={() => toggle(doc.id)}
                className={clsx(
                  'flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs',
                  selected
                    ? 'bg-star-accent/10 text-star-accent'
                    : 'text-ink-muted hover:bg-ink-800 hover:text-ink-body',
                )}
              >
                <span>{doc.title}</span>
                <span className="text-[10px] text-ink-500">{doc.category}</span>
              </button>
            )
          })}
          {matchingDocs.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-ink-500">No matching codex documents.</div>
          )}
        </div>
      )}
      {docs.length === 0 && <div className="text-xs text-ink-500">No codex documents yet.</div>}
    </div>
  )
}

export default function Timeline(): JSX.Element {
  const settingDocs = useStore((s) => s.settingDocs)
  const novel = useStore((s) => s.novel)!
  const openChapter = useStore((s) => s.openChapter)
  const openSetting = useStore((s) => s.openSetting)
  const currentWorldId = useStore((s) => s.currentWorldId)
  const timelineFocusId = useStore((s) => s.timelineFocusId)
  const clearTimelineFocus = useStore((s) => s.clearTimelineFocus)

  const [events, setEvents] = useState<TimelineEvent[]>([])
  const [loaded, setLoaded] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<TimelineForm>({
    title: '',
    dateLabel: '',
    dateOrder: 0,
    description: '',
    docRefs: [],
  })
  const [showCreate, setShowCreate] = useState(false)
  const [highlightedEventId, setHighlightedEventId] = useState<string | null>(null)

  useEffect(() => {
    window.api.listTimelineEvents().then((evts: TimelineEvent[]) => {
      setEvents(evts.sort((a, b) => a.dateOrder - b.dateOrder))
      setLoaded(true)
    })
  }, [currentWorldId])

  useEffect(() => {
    if (!timelineFocusId || !loaded) return
    setHighlightedEventId(timelineFocusId)
    requestAnimationFrame(() => {
      document.getElementById(`timeline-event-${timelineFocusId}`)?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      })
    })
    clearTimelineFocus()
  }, [clearTimelineFocus, loaded, timelineFocusId])

  const persist = useCallback(async (evts: TimelineEvent[]) => {
    try {
      await window.api.saveTimelineEvents(evts)
    } catch (e) {
      toastError('Failed to save timeline: ' + (e as Error).message)
    }
  }, [])

  const resetForm = () =>
    setEditForm({ title: '', dateLabel: '', dateOrder: 0, description: '', docRefs: [] })

  const startCreate = () => {
    setEditingId('__new__')
    resetForm()
    setShowCreate(true)
  }

  const cancelCreate = () => {
    setEditingId(null)
    setShowCreate(false)
  }

  const saveNew = async () => {
    if (!editForm.title.trim()) return
    const newEvent: TimelineEvent = {
      id: uid('evt_'),
      title: editForm.title.trim(),
      dateLabel: editForm.dateLabel.trim(),
      dateOrder: editForm.dateOrder,
      description: editForm.description.trim(),
      docRefs: [...new Set(editForm.docRefs)],
    }
    const updated = [...events, newEvent].sort((a, b) => a.dateOrder - b.dateOrder)
    setEvents(updated)
    await persist(updated)
    setEditingId(null)
    setShowCreate(false)
    toastSuccess(`"${newEvent.title}" added.`)
  }

  const startEdit = (evt: TimelineEvent) => {
    setEditingId(evt.id)
    setEditForm({
      title: evt.title,
      dateLabel: evt.dateLabel,
      dateOrder: evt.dateOrder,
      description: evt.description,
      docRefs: evt.docRefs,
    })
  }

  const saveEdit = async () => {
    if (!editingId || editingId === '__new__') return
    const updated = events.map((e) =>
      e.id === editingId
        ? {
            ...e,
            title: editForm.title.trim() || e.title,
            dateLabel: editForm.dateLabel.trim(),
            dateOrder: editForm.dateOrder,
            description: editForm.description.trim(),
            docRefs: [...new Set(editForm.docRefs)],
          }
        : e,
    )
    setEvents(updated)
    await persist(updated)
    setEditingId(null)
    toastSuccess('Event updated.')
  }

  const doDelete = async (evt: TimelineEvent) => {
    if (!confirm(`Delete "${evt.title}"?`)) return
    const updated = events.filter((e) => e.id !== evt.id)
    setEvents(updated)
    await persist(updated)
    toastSuccess(`"${evt.title}" deleted.`)
  }

  const resolveDocTitle = (docId: string): string => {
    const doc = settingDocs.find((d) => d.id === docId)
    return doc?.title ?? docId
  }

  const linkedChapters = (eventId: string) =>
    novel.volumes
      .slice()
      .sort((a, b) => a.order - b.order)
      .flatMap((volume) =>
        volume.chapters
          .slice()
          .sort((a, b) => a.order - b.order)
          .filter((chapter) => chapter.scene?.timelineEventId === eventId),
      )

  if (!loaded)
    return (
      <div className="h-full flex items-center justify-center text-ink-500">Loading timeline…</div>
    )

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-8 py-8">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-xl font-semibold text-ink-deep flex items-center gap-2">
            <Clock size={20} /> Timeline
          </h1>
          <button onClick={startCreate} className="btn btn-sm btn-primary">
            <Plus size={15} /> Add event
          </button>
        </div>

        {/* Create form */}
        {showCreate && (
          <div className="card p-5 mb-6 border-star-accent">
            <div className="space-y-3">
              <input
                className="input text-sm"
                placeholder="Event title"
                value={editForm.title}
                autoFocus
                onChange={(e) => setEditForm((f) => ({ ...f, title: e.target.value }))}
              />
              <div className="grid grid-cols-2 gap-3">
                <input
                  className="input text-sm"
                  placeholder='Date label, e.g. "Year 1240"'
                  value={editForm.dateLabel}
                  onChange={(e) => setEditForm((f) => ({ ...f, dateLabel: e.target.value }))}
                />
                <input
                  type="number"
                  className="input text-sm"
                  placeholder="Sort order (larger = later)"
                  value={editForm.dateOrder || ''}
                  onChange={(e) =>
                    setEditForm((f) => ({ ...f, dateOrder: parseInt(e.target.value) || 0 }))
                  }
                />
              </div>
              <textarea
                className="textarea text-sm min-h-20"
                placeholder="Description (Markdown supported)"
                value={editForm.description}
                onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))}
              />
              <CodexReferencePicker
                docs={settingDocs}
                selectedIds={editForm.docRefs}
                onChange={(docRefs) => setEditForm((form) => ({ ...form, docRefs }))}
              />
              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={saveNew}
                  disabled={!editForm.title.trim()}
                  className="btn btn-primary btn-sm flex-1"
                >
                  <Check size={14} /> Add
                </button>
                <button onClick={cancelCreate} className="btn btn-secondary btn-sm">
                  <X size={14} /> Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {events.length === 0 && !showCreate && (
          <div className="text-center py-16">
            <Clock size={40} className="mx-auto text-ink-600 mb-3" />
            <p className="text-sm text-ink-500">
              No timeline events yet. Add your first event to start building the world's history.
            </p>
          </div>
        )}

        {/* Timeline entries */}
        {events.length > 0 && (
          <div className="relative pl-8 before:absolute before:left-[11px] before:top-2 before:bottom-2 before:w-0.5 before:bg-ink-800">
            {events.map((evt) => (
              <div key={evt.id} id={`timeline-event-${evt.id}`} className="relative mb-6 group">
                {/* Timeline dot */}
                <div
                  className="absolute -left-[23px] top-1.5 w-3.5 h-3.5 rounded-full border-2 border-ink-800 bg-ink-950"
                  style={{
                    borderColor: evt.color || '#B8642E',
                    backgroundColor: evt.color || '#B8642E',
                  }}
                />

                {editingId === evt.id ? (
                  <div className="card p-4 space-y-3">
                    <input
                      className="input text-sm"
                      value={editForm.title}
                      onChange={(e) => setEditForm((f) => ({ ...f, title: e.target.value }))}
                      autoFocus
                    />
                    <div className="grid grid-cols-2 gap-3">
                      <input
                        className="input text-sm"
                        value={editForm.dateLabel}
                        onChange={(e) => setEditForm((f) => ({ ...f, dateLabel: e.target.value }))}
                      />
                      <input
                        type="number"
                        className="input text-sm"
                        value={editForm.dateOrder}
                        onChange={(e) =>
                          setEditForm((f) => ({ ...f, dateOrder: parseInt(e.target.value) || 0 }))
                        }
                      />
                    </div>
                    <textarea
                      className="textarea text-sm min-h-20"
                      value={editForm.description}
                      onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))}
                    />
                    <CodexReferencePicker
                      docs={settingDocs}
                      selectedIds={editForm.docRefs}
                      onChange={(docRefs) => setEditForm((form) => ({ ...form, docRefs }))}
                    />
                    <div className="flex items-center gap-2 pt-1">
                      <button onClick={saveEdit} className="btn btn-primary btn-sm flex-1">
                        <Check size={14} /> Save
                      </button>
                      <button
                        onClick={() => setEditingId(null)}
                        className="btn btn-secondary btn-sm"
                      >
                        <X size={14} /> Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div
                    className={clsx(
                      'card p-4 transition-colors',
                      highlightedEventId === evt.id
                        ? 'border-star-accent ring-1 ring-star-accent/30'
                        : 'hover:border-ink-700',
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold text-ink-deep">{evt.title}</div>
                        {evt.dateLabel && (
                          <div className="text-[11px] text-star-accent mt-0.5">{evt.dateLabel}</div>
                        )}
                      </div>
                      <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                        <button
                          onClick={() => startEdit(evt)}
                          className="icon-btn hover:text-star-accent"
                          title="Edit event"
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          onClick={() => doDelete(evt)}
                          className="icon-btn hover:text-star-danger"
                          title="Delete event"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                    {evt.description && (
                      <div className="text-xs text-ink-muted mt-2 whitespace-pre-wrap line-clamp-3">
                        {evt.description}
                      </div>
                    )}
                    {evt.docRefs.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {evt.docRefs.map((ref) => {
                          const isKnownDoc = settingDocs.some((doc) => doc.id === ref)
                          return isKnownDoc ? (
                            <button
                              key={ref}
                              onClick={() => openSetting(ref)}
                              className="rounded-full bg-star-accent/5 px-2 py-0.5 text-[10px] text-star-accent hover:bg-star-accent/15"
                              title="Open codex document"
                            >
                              {resolveDocTitle(ref)}
                            </button>
                          ) : (
                            <span
                              key={ref}
                              className="rounded-full bg-star-accent/5 px-2 py-0.5 text-[10px] text-star-accent"
                            >
                              {resolveDocTitle(ref)}
                            </span>
                          )
                        })}
                      </div>
                    )}
                    {linkedChapters(evt.id).length > 0 && (
                      <div className="mt-3 flex flex-wrap items-center gap-1.5">
                        <span className="text-[10px] text-ink-500">Linked chapters</span>
                        {linkedChapters(evt.id).map((chapter) => (
                          <button
                            key={chapter.id}
                            onClick={() => openChapter(chapter.id)}
                            className="rounded-full bg-star-info/10 px-2 py-0.5 text-[10px] text-star-info hover:bg-star-info/20"
                          >
                            {chapter.title}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
