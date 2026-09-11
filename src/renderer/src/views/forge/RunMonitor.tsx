/**
 * The run console: progress, controls, the chapter list and what the review
 * found.
 *
 * This is the only place a run is driven from, so every control that changes a
 * run's course (pause, resume, stop, continue, plan more, re-draft a chapter,
 * act on a finding) lives here next to the state it acts on.
 */

import { useMemo, useState } from 'react'
import type { ForgeChapterState, ForgeRun } from '@shared/types'
import { forgeCanRetry, forgeProgress } from '@shared/forge'
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  Circle,
  Compass,
  LayoutList,
  Library,
  Loader2,
  Pause,
  PenLine,
  Play,
  Plus,
  RotateCcw,
  ShieldCheck,
  X,
} from 'lucide-react'
import clsx from 'clsx'
import { formatDuration, nf } from './constants'

// ---- Run monitor ----

export function RunMonitor({
  run,
  progress,
  busy,
  onPause,
  onResume,
  onCancel,
  onDiscard,
  onRedraft,
  onDraftMore,
  onExtendPlan,
  onOpenChapter,
  onOpenView,
}: {
  run: ForgeRun
  progress: ReturnType<typeof forgeProgress> | null
  busy: string
  onPause: () => void | Promise<void>
  onResume: () => void | Promise<void>
  onCancel: () => void | Promise<void>
  onDiscard: () => void | Promise<void>
  onRedraft: (chapterId: string, instruction: string) => void | Promise<void>
  onDraftMore: (count: number) => void | Promise<void>
  onExtendPlan: (count: number) => void | Promise<void>
  onOpenChapter: (chapterId: string) => void
  onOpenView: (view: 'outline' | 'settings-docs' | 'chapters' | 'review-queue') => void
}): JSX.Element {
  const [planCount, setPlanCount] = useState(5)
  const active = run.status === 'running'
  // A completed run stays resumable while chapters still need retrying.
  const canResume =
    run.status === 'paused' ||
    run.status === 'cancelled' ||
    run.status === 'failed' ||
    (run.status === 'completed' && forgeCanRetry(run))
  const elapsed =
    run.status === 'running' || run.status === 'paused'
      ? Date.now() - run.createdAt
      : run.totals.durationMs || (run.finishedAt ?? run.updatedAt) - run.createdAt

  const failedSteps = run.steps.filter((step) => step.status === 'failed')
  const planned = run.chapters.length
  const drafted = run.chapters.filter((chapter) => chapter.prose === 'drafted').length
  const remaining = planned - Math.max(drafted, run.brief.draftCount)

  return (
    <div className="space-y-5">
      <section className="card">
        <div className="flex items-start justify-between gap-4 mb-3">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-ink-500 font-mono">
              {progress?.label ?? run.phase}
            </div>
            <div className="text-2xl font-semibold text-ink-deep tabular-nums mt-0.5">
              {progress?.percent ?? 0}%
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            {active && (
              <button className="btn btn-secondary btn-sm" onClick={onPause} disabled={!!busy}>
                <Pause size={14} />
                Pause
              </button>
            )}
            {canResume && (
              <button className="btn btn-primary btn-sm" onClick={onResume} disabled={!!busy}>
                <Play size={14} />
                Resume
              </button>
            )}
            {(active || run.status === 'paused') && (
              <button className="btn btn-ghost btn-sm" onClick={onCancel} disabled={!!busy}>
                <X size={14} />
                Stop
              </button>
            )}
            {!active && (
              <button className="btn btn-ghost btn-sm" onClick={onDiscard} disabled={!!busy}>
                <RotateCcw size={14} />
                New run
              </button>
            )}
          </div>
        </div>

        <div className="h-2 rounded-full bg-ink-850 overflow-hidden">
          <div
            className={clsx(
              'h-full transition-[width] duration-500',
              run.status === 'failed'
                ? 'bg-star-danger'
                : run.status === 'completed'
                  ? 'bg-star-success'
                  : 'bg-star-accent',
            )}
            style={{ width: `${progress?.percent ?? 0}%` }}
          />
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
          <Stat
            label="Chapters"
            value={`${progress?.draftedChapters ?? 0}/${progress?.plannedChapters ?? run.brief.chapters}`}
          />
          <Stat label="Words" value={nf(progress?.totalWords ?? 0)} />
          <Stat label="Model calls" value={nf(run.totals.modelCalls)} />
          <Stat label="Elapsed" value={formatDuration(elapsed)} />
        </div>

        <p className="text-[11px] text-ink-500 mt-3 leading-relaxed">
          {run.status === 'running'
            ? 'The pipeline runs in the background — you can edit other views meanwhile. Switching worlds or closing the app pauses it; press Resume to continue from the last completed step.'
            : run.status === 'paused'
              ? 'Paused between steps. Resume continues from the last completed step; nothing already written is repeated.'
              : 'Everything was written to this world as plain Markdown and JSON — review it in the Outline, Codex and Manuscript views.'}
        </p>

        {run.error && (
          <div className="mt-4 text-[13px] text-star-danger bg-star-danger/10 rounded-sm px-3 py-2 whitespace-pre-wrap">
            {run.error}
          </div>
        )}

        <div className="flex flex-wrap gap-1.5 mt-4">
          <button className="tab-pill text-[11px]" onClick={() => onOpenView('outline')}>
            <LayoutList size={12} />
            Outline
          </button>
          <button className="tab-pill text-[11px]" onClick={() => onOpenView('settings-docs')}>
            <Library size={12} />
            Codex
          </button>
          <button className="tab-pill text-[11px]" onClick={() => onOpenView('chapters')}>
            <BookOpen size={12} />
            Manuscript
          </button>
          <button className="tab-pill text-[11px]" onClick={() => onOpenView('review-queue')}>
            <ShieldCheck size={12} />
            Review Queue
          </button>
        </div>
      </section>

      <section className="card">
        <div className="text-sm font-semibold text-ink-deep mb-3 flex items-center gap-2">
          Chapters
          {run.status === 'running' && <Loader2 className="animate-spin text-ink-500" size={13} />}
        </div>
        {run.chapters.length === 0 ? (
          <p className="text-[13px] text-ink-500">
            The outline has not been written yet — chapters appear here once it is planned.
          </p>
        ) : (
          <div className="space-y-1 max-h-[420px] overflow-y-auto pr-1">
            {run.chapters.map((chapter, index) => (
              <ChapterRow
                key={chapter.chapterId}
                chapter={chapter}
                index={index}
                busy={!!busy || run.status === 'running'}
                onOpen={() => onOpenChapter(chapter.chapterId)}
                onRedraft={(instruction) => onRedraft(chapter.chapterId, instruction)}
              />
            ))}
          </div>
        )}

        {/* Continue: draft chapters that are planned but were left out. */}
        {run.chapters.length > 0 && run.status !== 'running' && (
          <div className="mt-4 pt-3 border-t border-ink-800 flex items-center gap-3 flex-wrap">
            {remaining > 0 ? (
              <>
                <span className="text-[11px] text-ink-500">
                  {remaining} planned chapter{remaining === 1 ? '' : 's'} not drafted yet.
                </span>
                <button
                  className="btn btn-secondary btn-sm"
                  disabled={!!busy}
                  onClick={() => onDraftMore(remaining)}
                >
                  <Plus size={14} />
                  Draft {remaining === 1 ? 'it' : `all ${remaining}`}
                </button>
                {remaining > 1 && (
                  <button
                    className="btn btn-ghost btn-sm"
                    disabled={!!busy}
                    onClick={() => onDraftMore(1)}
                  >
                    <Plus size={14} />
                    Just the next one
                  </button>
                )}
              </>
            ) : (
              <span className="text-[11px] text-ink-500">
                Every planned chapter is drafted. Plan the next arc to keep going, or write more in
                the{' '}
                <button
                  className="text-star-accent hover:underline"
                  onClick={() => onOpenView('outline')}
                >
                  Outline
                </button>{' '}
                yourself.
              </span>
            )}
            <span className="flex items-center gap-2 ml-auto">
              <input
                className="input w-16 py-1.5 text-center"
                type="number"
                min={1}
                max={40}
                value={planCount}
                disabled={!!busy}
                onChange={(e) => setPlanCount(Math.max(1, Number(e.target.value) || 1))}
              />
              <button
                className="btn btn-secondary btn-sm"
                disabled={!!busy}
                onClick={() => onExtendPlan(planCount)}
                title="Plan this many further chapters from what has actually happened"
              >
                <Compass size={14} />
                Plan more chapters
              </button>
            </span>
          </div>
        )}
      </section>

      {(failedSteps.length > 0 || run.log.length > 0) && (
        <section className="card">
          <div className="text-sm font-semibold text-ink-deep mb-3">Activity</div>
          <ActivityLog run={run} />
        </section>
      )}

      {run.findings.length > 0 && (
        <FindingsCard run={run} busy={!!busy} onRedraft={onRedraft} onOpenView={onOpenView} />
      )}
    </div>
  )
}

/**
 * What the continuity review found, next to the action that resolves it.
 *
 * Findings also reach the Review Queue, but a finding is only useful where the
 * prose is: acting on one means writing the chapter it names again, which is the
 * re-draft path with the finding text as that chapter's instruction.
 */
function FindingsCard({
  run,
  busy,
  onRedraft,
  onOpenView,
}: {
  run: ForgeRun
  busy: boolean
  onRedraft: (chapterId: string, instruction: string) => void | Promise<void>
  onOpenView: (view: 'outline' | 'settings-docs' | 'chapters' | 'review-queue') => void
}): JSX.Element {
  const [confirming, setConfirming] = useState<number | null>(null)

  /** The finding names a chapter by title; match it to a drafted chapter. */
  const chapterFor = (chapterTitle: string): ForgeChapterState | null => {
    const wanted = chapterTitle.trim().toLowerCase()
    if (!wanted) return null
    return (
      run.chapters.find((chapter) => chapter.title.trim().toLowerCase() === wanted) ??
      run.chapters.find((chapter) => chapter.title.toLowerCase().includes(wanted)) ??
      null
    )
  }

  return (
    <section className="card">
      <div className="flex items-center justify-between gap-3 mb-1">
        <div className="text-sm font-semibold text-ink-deep flex items-center gap-2">
          <AlertTriangle size={15} className="text-star-accent" />
          Continuity review
          <span className="tag text-[10px]">{run.findings.length}</span>
        </div>
        <button className="tab-pill text-[11px]" onClick={() => onOpenView('review-queue')}>
          <ShieldCheck size={12} />
          Also queued for review
        </button>
      </div>
      <p className="text-[11px] text-ink-500 mb-3 leading-relaxed">
        Reported by the reviewer, not applied. Acting on one writes that chapter again, with the
        finding as its instruction — its prose and summary are replaced.
      </p>
      <div className="space-y-2">
        {run.findings.map((finding, index) => {
          const chapter = chapterFor(finding.chapterTitle)
          return (
            <div
              key={`${index}-${finding.text.slice(0, 24)}`}
              className="rounded-md bg-ink-850/60 px-2.5 py-2"
            >
              <div className="flex items-start gap-2">
                <span
                  className={clsx(
                    'tag text-[10px] shrink-0 mt-0.5',
                    finding.severity === 'critical'
                      ? 'text-star-danger border-star-danger/30'
                      : finding.severity === 'moderate'
                        ? 'text-star-accent border-star-accent/30'
                        : '',
                  )}
                >
                  {finding.severity}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-[10px] text-ink-500">
                    {finding.chapterTitle || 'Whole draft'}
                    {finding.relatedDocTitles.length > 0 &&
                      ` · ${finding.relatedDocTitles.join(', ')}`}
                  </div>
                  <div className="text-[12px] text-ink-muted leading-relaxed mt-0.5">
                    {finding.text}
                  </div>
                </div>
              </div>

              {confirming === index ? (
                <div className="mt-2 flex items-center gap-2 flex-wrap">
                  <span className="text-[11px] text-ink-500 flex-1">
                    {chapter
                      ? `“${chapter.title}” will be written again under this instruction.`
                      : 'No drafted chapter matches that title — fix this one by hand.'}
                  </span>
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={busy || !chapter}
                    onClick={() => {
                      setConfirming(null)
                      if (chapter) void onRedraft(chapter.chapterId, finding.text)
                    }}
                  >
                    <RotateCcw size={14} />
                    Write it again
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setConfirming(null)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="mt-2 flex justify-end">
                  <button
                    className="tab-pill text-[11px]"
                    disabled={busy || !chapter}
                    title={
                      chapter
                        ? `Write ${chapter.title} again under this instruction`
                        : 'No drafted chapter matches this title'
                    }
                    onClick={() => setConfirming(index)}
                  >
                    <PenLine size={12} />
                    Act on this
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="card-muted">
      <div className="text-[11px] uppercase tracking-wider text-ink-500">{label}</div>
      <div className="text-base font-semibold text-ink-deep tabular-nums mt-0.5">{value}</div>
    </div>
  )
}

function ChapterRow({
  chapter,
  index,
  busy,
  onOpen,
  onRedraft,
}: {
  chapter: ForgeChapterState
  index: number
  busy: boolean
  onOpen: () => void
  onRedraft: (instruction: string) => void | Promise<void>
}): JSX.Element {
  const [revising, setRevising] = useState(false)
  const [instruction, setInstruction] = useState('')
  const status =
    chapter.prose === 'drafted'
      ? { Icon: CheckCircle2, className: 'text-star-success', label: 'Drafted' }
      : chapter.prose === 'failed'
        ? { Icon: AlertTriangle, className: 'text-star-danger', label: chapter.error ?? 'Failed' }
        : { Icon: Circle, className: 'text-ink-600', label: 'Pending' }

  const submit = (): void => {
    setRevising(false)
    void onRedraft(instruction.trim())
    setInstruction('')
  }

  return (
    <div className="rounded-md hover:bg-ink-850/60 transition-colors">
      <div className="flex items-center gap-3 px-2.5 py-2 group">
        <span className="text-[11px] text-ink-500 tabular-nums w-7 shrink-0 text-right">
          {index + 1}
        </span>
        <status.Icon size={14} className={clsx(status.className, 'shrink-0')} />
        <div className="flex-1 min-w-0">
          <div className="text-[13px] text-ink-body truncate" title={status.label}>
            {chapter.title}
          </div>
          {chapter.volumeTitle && (
            <div className="text-[10px] text-ink-500 truncate">{chapter.volumeTitle}</div>
          )}
        </div>
        {chapter.memory === 'done' && (
          <span className="tag text-[10px] shrink-0" title="Continuity memory updated">
            memory
          </span>
        )}
        <span className="text-[11px] text-ink-500 tabular-nums shrink-0 w-16 text-right">
          {chapter.words > 0 ? nf(chapter.words) : '—'}
        </span>
        {chapter.prose !== 'pending' && (
          <button
            className="icon-btn opacity-0 group-hover:opacity-100 text-ink-500 hover:text-star-accent shrink-0"
            title="Write this chapter again (optionally with an instruction)"
            disabled={busy}
            onClick={() => setRevising(!revising)}
          >
            <PenLine size={13} />
          </button>
        )}
        {chapter.prose === 'drafted' && (
          <button
            className="icon-btn opacity-0 group-hover:opacity-100 text-ink-500 hover:text-star-accent shrink-0"
            title="Open in Manuscript"
            onClick={onOpen}
          >
            <BookOpen size={13} />
          </button>
        )}
      </div>

      {revising && (
        <div className="px-2.5 pb-3 pl-12 space-y-2">
          <textarea
            className="textarea min-h-[64px] text-[13px]"
            autoFocus
            placeholder="Optional: what should this chapter do differently? e.g. 'too slow — start in the middle of the argument, keep the beats'"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <button className="btn btn-primary btn-sm" onClick={submit} disabled={busy}>
              <RotateCcw size={14} />
              Write it again
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setRevising(false)}>
              Cancel
            </button>
            <span className="text-[11px] text-ink-500">
              Replaces this chapter's prose and summary; later chapters keep the old version.
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

function ActivityLog({ run }: { run: ForgeRun }): JSX.Element {
  const entries = useMemo(() => {
    const log = run.log.slice(-120).reverse()
    const steps = run.steps
      .filter((step) => step.status === 'failed')
      .slice(-10)
      .reverse()
    return { log, steps }
  }, [run])

  return (
    <div className="space-y-3">
      {entries.steps.length > 0 && (
        <div className="space-y-1.5">
          {entries.steps.map((step) => (
            <div
              key={step.id}
              className="text-[11px] text-star-danger bg-star-danger/5 rounded-sm px-2.5 py-1.5 font-mono"
            >
              <span className="font-semibold">{step.label}</span>
              {step.providerName ? ` · ${step.providerName}` : ''} — {step.error}
            </div>
          ))}
        </div>
      )}
      <div className="max-h-[280px] overflow-y-auto space-y-0.5 font-mono text-[11px] leading-relaxed">
        {entries.log.map((entry, i) => (
          <div key={`${entry.ts}-${i}`} className="flex gap-2">
            <span className="text-ink-600 shrink-0 tabular-nums">
              {new Date(entry.ts).toLocaleTimeString('en-GB', { hour12: false })}
            </span>
            <span
              className={clsx(
                'break-words',
                entry.level === 'error'
                  ? 'text-star-danger'
                  : entry.level === 'warn'
                    ? 'text-star-accent'
                    : 'text-ink-muted',
              )}
            >
              {entry.message}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
