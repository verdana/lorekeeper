import { useCallback, useEffect, useState } from 'react'
import { useStore } from '../store'
import { toastError, toastSuccess } from '../toast'
import { uid } from '../lib'
import type { TimelineEvent } from '@shared/types'
import { Plus, Trash2, Pencil, X, Check, Clock } from 'lucide-react'
import clsx from 'clsx'

export default function Timeline(): JSX.Element {
  const settingDocs = useStore((s) => s.settingDocs)
  const currentWorldId = useStore((s) => s.currentWorldId)
  const timelineFocusId = useStore((s) => s.timelineFocusId)
  const clearTimelineFocus = useStore((s) => s.clearTimelineFocus)

  const [events, setEvents] = useState<TimelineEvent[]>([])
  const [loaded, setLoaded] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState({
    title: '',
    dateLabel: '',
    dateOrder: 0,
    description: '',
    docRefs: '',
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
    setEditForm({ title: '', dateLabel: '', dateOrder: 0, description: '', docRefs: '' })

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
      docRefs: editForm.docRefs
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
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
      docRefs: evt.docRefs.join(', '),
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
            docRefs: editForm.docRefs
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
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
              <input
                className="input text-sm"
                placeholder="Related codex doc IDs (comma-separated, optional)"
                value={editForm.docRefs}
                onChange={(e) => setEditForm((f) => ({ ...f, docRefs: e.target.value }))}
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
                    <input
                      className="input text-sm"
                      placeholder="Related doc IDs (comma-separated)"
                      value={editForm.docRefs}
                      onChange={(e) => setEditForm((f) => ({ ...f, docRefs: e.target.value }))}
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
                      <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
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
                        {evt.docRefs.map((ref) => (
                          <span
                            key={ref}
                            className="text-[10px] text-star-accent bg-star-accent/5 rounded-full px-2 py-0.5"
                          >
                            {resolveDocTitle(ref)}
                          </span>
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
