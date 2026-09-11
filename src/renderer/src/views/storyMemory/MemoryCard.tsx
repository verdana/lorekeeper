/**
 * One durable fact under review: its wording, the evidence it was extracted
 * from, the codex entities it references, and the actions that move it from
 * suggested to confirmed or rejected.
 *
 * The statement is editable and the evidence is not: the author owns the canon,
 * the chapter owns the quotation.
 */

import { Check, ChevronRight, FileText, RotateCcw, Trash2, X } from 'lucide-react'
import { useStore } from '../../store'
import type { StoryMemoryEntry, StoryMemoryKind, TimelineEvent } from '@shared/types'
import clsx from 'clsx'
import { KINDS } from './kinds'

export function MemoryCard({
  entry,
  settingDocs,
  events,
  selected,
  stale,
  saving,
  onUpdate,
  onSave,
  onStatus,
  onToggleSelect,
  onReconfirm,
  onDelete,
  onOpenSource,
}: {
  entry: StoryMemoryEntry
  settingDocs: ReturnType<typeof useStore.getState>['settingDocs']
  events: TimelineEvent[]
  selected: boolean
  stale: boolean
  saving: boolean
  onUpdate: (id: string, update: Partial<StoryMemoryEntry>) => void
  onSave: (id: string) => Promise<void>
  onStatus: (id: string, status: StoryMemoryEntry['status']) => Promise<void>
  onToggleSelect: () => void
  onReconfirm: (entry: StoryMemoryEntry) => Promise<void>
  onDelete: (entry: StoryMemoryEntry) => Promise<void>
  onOpenSource: () => void
}): JSX.Element {
  return (
    <section
      className={clsx(
        'card p-5',
        entry.status === 'rejected' && 'opacity-60',
        stale && 'border-star-accent',
      )}
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={selected}
              onChange={onToggleSelect}
              className="shrink-0 accent-star-accent"
              aria-label={`Select ${entry.statement}`}
            />
            <span className="text-[10px] uppercase tracking-wider font-semibold text-star-accent">
              {entry.status}
            </span>
            {stale && <span className="text-[10px] text-star-danger">source changed</span>}
          </div>
          <p className="text-[10px] text-ink-500 mt-0.5">
            From {entry.source.chapterTitle || 'author note'}
          </p>
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
        <button
          onClick={() => void onDelete(entry)}
          disabled={saving}
          className="btn btn-sm btn-ghost hover:text-star-danger"
          title="Delete this memory"
        >
          <Trash2 size={13} /> Delete
        </button>
        {entry.confidence !== null && (
          <span className="ml-auto text-[11px] text-ink-500">
            Model confidence {Math.round(entry.confidence * 100)}%
          </span>
        )}
      </div>
    </section>
  )
}
