/**
 * Read-only panels beside the monitor: the theme recap, the derived concept,
 * the direction editor and the model-call list.
 *
 * Direction is the exception to "read-only": it is the author's way to change
 * the book's course mid-run, so it edits the run rather than displaying it.
 */

import { useEffect, useMemo, useState } from 'react'
import type { ForgeBrief, ForgeDirective, ForgeRun, ForgeStep } from '@shared/types'
import { forgeNextOrdinal } from '@shared/forge'
import { uid } from '../../lib'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Compass,
  Loader2,
  Plus,
  Trash2,
} from 'lucide-react'
import clsx from 'clsx'
import { formatDuration, nf } from './constants'

// ---- Read-only summaries ----

/**
 * Author direction: standing instructions the pipeline applies while it keeps
 * writing. This is the only way to change the book's course mid-run, so it is
 * deliberately a first-class panel rather than a per-chapter field.
 */
export function DirectionCard({
  run,
  busy,
  onSave,
}: {
  run: ForgeRun
  busy: string
  onSave: (directives: ForgeDirective[]) => void | Promise<void>
}): JSX.Element {
  const suggested = forgeNextOrdinal(run)
  const [text, setText] = useState('')
  const [fromOrder, setFromOrder] = useState<number | ''>(suggested)
  const [orderTouched, setOrderTouched] = useState(false)
  const [open, setOpen] = useState(false)

  // Follow the pipeline until the author picks a chapter themselves: otherwise
  // a run that keeps drafting would move the number under their cursor.
  useEffect(() => {
    if (!orderTouched) setFromOrder(suggested)
  }, [suggested, orderTouched])

  const add = (): void => {
    const value = text.trim()
    if (!value) return
    const order = typeof fromOrder === 'number' && fromOrder > 0 ? fromOrder : suggested
    void onSave([
      ...run.direction,
      { id: uid('d_'), text: value, fromOrder: order, onlyOrder: null, createdAt: Date.now() },
    ])
    setText('')
    setOrderTouched(false)
    setOpen(false)
  }

  const remove = (id: string): void => {
    void onSave(run.direction.filter((directive) => directive.id !== id))
  }

  const draftedCount = run.chapters.filter((chapter) => chapter.prose === 'drafted').length

  return (
    <section className="card">
      <button
        type="button"
        className="w-full flex items-center justify-between gap-2 text-sm font-semibold text-ink-deep"
        onClick={() => setOpen(!open)}
      >
        <span className="flex items-center gap-2">
          <Compass size={15} className="text-star-accent" />
          Direction
          {run.direction.length > 0 && (
            <span className="tag text-[10px]">{run.direction.length}</span>
          )}
        </span>
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
      </button>

      <p className="text-[11px] text-ink-500 mt-1.5 leading-relaxed">
        Steer the book while it is being written. A direction binds every chapter it covers — use it
        for anything the plan cannot know yet.
      </p>

      {run.direction.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {run.direction.map((directive) => (
            <div
              key={directive.id}
              className="group flex items-start gap-2 rounded-md bg-ink-850/60 px-2.5 py-2"
            >
              <span className="tag text-[10px] shrink-0 mt-0.5">
                {directive.onlyOrder !== null
                  ? `ch. ${directive.onlyOrder}`
                  : `ch. ${directive.fromOrder}+`}
              </span>
              <span className="flex-1 min-w-0 text-[12px] text-ink-muted leading-relaxed">
                {directive.text}
              </span>
              <button
                className="icon-btn opacity-0 group-hover:opacity-100 text-ink-500 hover:text-star-danger shrink-0"
                title="Remove this direction"
                disabled={!!busy}
                onClick={() => remove(directive.id)}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {open && (
        <div className="mt-3 space-y-2">
          <textarea
            className="textarea min-h-[64px] text-[13px]"
            placeholder="e.g. Stop resolving her memory loss; the sister must appear before the trial."
            value={text}
            autoFocus
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex items-center gap-3 flex-wrap">
            <label className="flex items-center gap-2 text-[11px] text-ink-500">
              From chapter
              <input
                className="input w-16 py-1.5 text-center"
                type="number"
                min={1}
                max={Math.max(1, run.chapters.length)}
                value={fromOrder}
                onChange={(e) => {
                  setOrderTouched(true)
                  setFromOrder(e.target.value === '' ? '' : Number(e.target.value))
                }}
              />
              onwards
            </label>
            <button
              className="btn btn-primary btn-sm ml-auto"
              onClick={add}
              disabled={!text.trim()}
            >
              <Plus size={14} />
              Add direction
            </button>
          </div>
          <p className="text-[11px] text-ink-500">
            {draftedCount} of {run.chapters.length} chapters written. A direction never changes
            prose that already exists — re-draft a chapter from the list to apply it backwards.
          </p>
        </div>
      )}
    </section>
  )
}

export function BriefRecap({ brief }: { brief: ForgeBrief }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <section className="card">
      <button
        type="button"
        className="w-full flex items-center justify-between gap-2 text-sm font-semibold text-ink-deep"
        onClick={() => setOpen(!open)}
      >
        <span>Theme</span>
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
      </button>
      <p
        className={clsx('text-[13px] text-ink-muted mt-2 leading-relaxed', !open && 'line-clamp-3')}
      >
        {brief.theme}
      </p>
      <div className="flex flex-wrap gap-1.5 mt-3">
        {brief.genre && <span className="tag text-[10px]">{brief.genre}</span>}
        {brief.tone && <span className="tag text-[10px]">{brief.tone}</span>}
        <span className="tag text-[10px]">
          {brief.scope === 'plan' ? 'plan only' : `${brief.chapters} chapters`}
        </span>
        <span className="tag text-[10px]">{nf(brief.wordsPerChapter)} words/chapter</span>
        {brief.language !== 'auto' && <span className="tag text-[10px]">{brief.language}</span>}
      </div>
      {brief.constraints && (
        <div className="mt-3 text-[11px] text-ink-500 whitespace-pre-wrap border-l-2 border-ink-800 pl-2.5">
          {brief.constraints}
        </div>
      )}
    </section>
  )
}

export function ConceptCard({ run }: { run: ForgeRun }): JSX.Element {
  const concept = run.concept
  const [open, setOpen] = useState(false)
  if (!concept) return <></>
  return (
    <section className="card">
      <div className="text-[11px] uppercase tracking-wider text-ink-500 font-mono">Concept</div>
      <h2 className="text-lg font-semibold text-ink-deep mt-1">{concept.title}</h2>
      {concept.logline && (
        <p className="text-[13px] text-star-accent mt-1.5 leading-relaxed">{concept.logline}</p>
      )}
      {concept.themes.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2.5">
          {concept.themes.map((theme) => (
            <span key={theme} className="tag text-[10px]">
              {theme}
            </span>
          ))}
        </div>
      )}
      {concept.synopsis && (
        <>
          <button
            type="button"
            className="mt-3 text-[11px] text-ink-500 hover:text-star-accent"
            onClick={() => setOpen(!open)}
          >
            {open ? 'Hide synopsis' : 'Show synopsis'}
          </button>
          <p
            className={clsx(
              'text-[13px] text-ink-muted leading-relaxed mt-2',
              !open && 'line-clamp-4',
            )}
          >
            {concept.synopsis}
          </p>
        </>
      )}
      {concept.cast.length > 0 && (
        <div className="mt-4 space-y-2">
          {concept.cast.slice(0, 6).map((member) => (
            <div key={member.name} className="text-[12px]">
              <span className="font-semibold text-ink-body">{member.name}</span>
              {member.role && <span className="text-ink-500"> · {member.role}</span>}
              <div className="text-ink-500 leading-relaxed">{member.description}</div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

export function ActivityCard({ run }: { run: ForgeRun }): JSX.Element {
  const steps = useMemo(() => run.steps.slice(-8).reverse(), [run])
  if (steps.length === 0) return <></>
  return (
    <section className="card">
      <div className="text-sm font-semibold text-ink-deep mb-2.5">Model calls</div>
      <div className="space-y-1.5">
        {steps.map((step) => (
          <StepRow key={step.id} step={step} />
        ))}
      </div>
    </section>
  )
}

function StepRow({ step }: { step: ForgeStep }): JSX.Element {
  const usage = step.usage
  const tokens =
    usage.inputTokens != null || usage.outputTokens != null
      ? `${nf((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0))} tok${usage.source === 'estimated' ? ' est.' : ''}`
      : '—'
  return (
    <div className="flex items-center gap-2 text-[11px]">
      {step.status === 'completed' ? (
        <CheckCircle2 size={13} className="text-star-success shrink-0" />
      ) : step.status === 'failed' ? (
        <AlertTriangle size={13} className="text-star-danger shrink-0" />
      ) : (
        <Loader2 size={13} className="text-star-info animate-spin shrink-0" />
      )}
      <span className="flex-1 min-w-0 truncate text-ink-muted" title={step.label}>
        {step.label}
      </span>
      <span className="text-ink-500 tabular-nums shrink-0">
        {step.durationMs != null ? formatDuration(step.durationMs) : '…'}
      </span>
      <span className="text-ink-500 tabular-nums shrink-0 w-20 text-right">{tokens}</span>
    </div>
  )
}
