import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { parseAiError, toastError, toastSuccess } from '../toast'
import {
  DEFAULT_FORGE_BRIEF,
  FORGE_LIMITS,
  forgeCanRetry,
  forgeNextOrdinal,
  forgeProgress,
} from '@shared/forge'
import { uid } from '../lib'
import type {
  ForgeBrief,
  ForgeDirective,
  ForgeRun,
  ForgeStep,
  ForgeChapterState,
} from '@shared/types'
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Compass,
  Flame,
  LayoutList,
  Library,
  Loader2,
  Pause,
  PenLine,
  Play,
  Plus,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import clsx from 'clsx'

/** Example themes offered as one-click starting points. */
const THEME_IDEAS: { label: string; theme: string; genre: string }[] = [
  {
    label: 'Memory market',
    genre: 'Science fiction',
    theme:
      'A city where memories are bought and sold. A broker who has sold every memory of her own past must recover one she never sold — because someone else is living it.',
  },
  {
    label: 'Letters that come true',
    genre: 'Historical fantasy',
    theme:
      'The boy who writes other people’s last letters discovers that every letter he finishes comes true within the week — and the army has just hired him.',
  },
  {
    label: 'Dying magic',
    genre: 'Western fantasy',
    theme:
      'Magic is dying because the gods who granted it are being murdered one by one. The last living god wants the killer found before the killer reaches him.',
  },
  {
    label: 'Debt of the dead',
    genre: 'Mystery',
    theme:
      'Debts are inherited in this town, along with the dead. A clerk who catalogues inheritances finds her own name in a ledger dated thirty years before she was born.',
  },
  {
    label: 'The quiet invasion',
    genre: 'Literary science fiction',
    theme:
      'The invasion did not arrive with ships. It arrived as a convenience everyone chose, and the only person who remembers what the city was like before is a night-shift archivist.',
  },
  {
    label: 'Cultivation without a sect',
    genre: 'Xianxia',
    theme:
      'A cook in a cultivator’s inn learns the art by watching guests eat — until a dying swordsman leaves her a debt that the whole mountain wants paid in blood.',
  },
  {
    label: 'Weather witch',
    genre: 'Folk fantasy',
    theme:
      'Every storm over the valley is the temper of the woman who lives in the lighthouse. When she falls in love, the valley has to decide whether it can survive twelve months of calm.',
  },
  {
    label: 'The last translator',
    genre: 'Dying-earth',
    theme:
      'Language is failing globally, one grammar at a time. A translator who still dreams in two tongues is the last person able to negotiate with whatever is doing it.',
  },
]

const GENRE_PRESETS = [
  'Fantasy',
  'Science fiction',
  'Mystery',
  'Romance',
  'Historical',
  'Wuxia / Xianxia',
  'Horror',
  'Literary',
]

const TONE_PRESETS = [
  'Dark and literary',
  'Hopeful',
  'Melancholy',
  'Epic and sweeping',
  'Wry and comic',
  'Bleak and clinical',
]

const statusStyle: Record<ForgeRun['status'], { label: string; className: string }> = {
  running: { label: 'Running', className: 'bg-star-info/10 text-star-info border-star-info/30' },
  paused: {
    label: 'Paused',
    className: 'bg-star-accent/10 text-star-accent border-star-accent/30',
  },
  completed: {
    label: 'Complete',
    className: 'bg-star-success/10 text-star-success border-star-success/30',
  },
  failed: {
    label: 'Failed',
    className: 'bg-star-danger/10 text-star-danger border-star-danger/30',
  },
  cancelled: { label: 'Cancelled', className: 'bg-ink-850 text-ink-500 border-ink-700' },
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`
  return `${s}s`
}

const nf = (n: number): string => n.toLocaleString('en-US')

export default function Forge(): JSX.Element {
  const config = useStore((s) => s.config)
  const novel = useStore((s) => s.novel)
  const refreshNovel = useStore((s) => s.refreshNovel)
  const refreshSettings = useStore((s) => s.refreshSettings)
  const forgeThemeDraft = useStore((s) => s.forgeThemeDraft)
  const clearForgeThemeDraft = useStore((s) => s.clearForgeThemeDraft)
  const openChapter = useStore((s) => s.openChapter)
  const setView = useStore((s) => s.setView)

  const [run, setRun] = useState<ForgeRun | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [brief, setBrief] = useState<ForgeBrief>(() => ({
    ...DEFAULT_FORGE_BRIEF,
    providerId: null,
  }))
  const [advanced, setAdvanced] = useState(false)
  const seeded = useRef(false)
  // Signature of the run's visible content, so app state refreshes only when the
  // pipeline actually produced something new.
  const lastSignature = useRef('')

  const load = useCallback(async (): Promise<ForgeRun | null> => {
    try {
      const current = await window.api.readForgeRun()
      setRun(current)
      return current
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return null
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Pre-fill the theme when the view was opened from another entry point.
  useEffect(() => {
    if (seeded.current) return
    if (forgeThemeDraft) {
      setBrief((current) => ({ ...current, theme: forgeThemeDraft }))
      seeded.current = true
    }
  }, [forgeThemeDraft])

  // Poll while the pipeline runs; it lives on the server, so leaving the view
  // (or switching to another world view) does not stop it.
  useEffect(() => {
    if (!run || run.status !== 'running') return
    const timer = setInterval(() => {
      void load()
    }, 1500)
    return () => clearInterval(timer)
  }, [run, load])

  const progress = useMemo(() => (run ? forgeProgress(run) : null), [run])

  // Pull the generated content into the rest of the app as it lands.
  useEffect(() => {
    if (!run) return
    const signature = `${run.status}:${run.phase}:${progress?.draftedChapters ?? 0}:${run.steps.length}`
    if (signature === lastSignature.current) return
    const first = lastSignature.current === ''
    lastSignature.current = signature
    if (first && run.status !== 'running') return
    void refreshNovel()
    void refreshSettings()
  }, [run, progress, refreshNovel, refreshSettings])

  const existingProse = useMemo(() => {
    if (!novel) return 0
    return novel.volumes.reduce(
      (sum, volume) => sum + volume.chapters.filter((chapter) => chapter.wordCount > 0).length,
      0,
    )
  }, [novel])

  const start = async (): Promise<void> => {
    if (!brief.theme.trim()) {
      setError('Enter a theme first — one or two sentences is enough.')
      return
    }
    setBusy('Starting the forge…')
    setError('')
    try {
      const started = await window.api.startForgeRun({ ...brief, theme: brief.theme.trim() })
      setRun(started)
      lastSignature.current = ''
      clearForgeThemeDraft()
      toastSuccess('Forge started. It keeps running while you work elsewhere.')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      toastError(parseAiError(e))
    } finally {
      setBusy('')
    }
  }

  const pause = async (): Promise<void> => {
    setBusy('Pausing…')
    try {
      setRun(await window.api.pauseForgeRun())
      toastSuccess('Pausing after the current step finishes.')
    } catch (e) {
      toastError(parseAiError(e))
    } finally {
      setBusy('')
    }
  }

  const resume = async (): Promise<void> => {
    setBusy('Resuming…')
    setError('')
    try {
      setRun(await window.api.resumeForgeRun())
      toastSuccess('Forge resumed.')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      toastError(parseAiError(e))
    } finally {
      setBusy('')
    }
  }

  const cancel = async (): Promise<void> => {
    if (!confirm('Stop this forge run? Everything already written stays.')) return
    setBusy('Stopping…')
    try {
      setRun(await window.api.cancelForgeRun())
    } catch (e) {
      toastError(parseAiError(e))
    } finally {
      setBusy('')
    }
  }

  const discard = async (): Promise<void> => {
    if (
      !confirm(
        'Discard this run record and return to the theme form? The codex, outline and chapters it produced stay in the world.',
      )
    ) {
      return
    }
    setBusy('Discarding…')
    try {
      await window.api.discardForgeRun()
      lastSignature.current = ''
      setRun(null)
      setError('')
    } catch (e) {
      toastError(parseAiError(e))
    } finally {
      setBusy('')
    }
  }

  /** Add, re-scope or delete an author direction. */
  const saveDirection = async (directives: ForgeDirective[]): Promise<void> => {
    try {
      setRun(await window.api.writeForgeDirectives(directives))
    } catch (e) {
      toastError(parseAiError(e))
    }
  }

  /** Write one chapter again, optionally under a new instruction. */
  const redraft = async (chapterId: string, instruction: string): Promise<void> => {
    setBusy('Re-drafting…')
    try {
      const updated = await window.api.redraftForgeChapter({ chapterId, instruction })
      setRun(updated)
      toastSuccess('Re-drafting that chapter. Later chapters keep the previous version.')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      toastError(parseAiError(e))
    } finally {
      setBusy('')
    }
  }

  /** Raise the draft limit and keep going. */
  const draftMore = async (count: number): Promise<void> => {
    setBusy('Continuing…')
    try {
      setRun(await window.api.forgeMoreChapters(count))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      toastError(parseAiError(e))
    } finally {
      setBusy('')
    }
  }

  /** Plan the next arc, then draft it. */
  const extendPlan = async (count: number): Promise<void> => {
    setBusy('Planning the next arc…')
    try {
      setRun(await window.api.forgeExtendPlan(count))
      toastSuccess(`Planning ${count} more chapters from what has happened so far.`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      toastError(parseAiError(e))
    } finally {
      setBusy('')
    }
  }

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-ink-500">
        <Loader2 className="animate-spin mr-2" size={18} /> Loading forge state…
      </div>
    )
  }

  const estimatedCalls =
    3 +
    (brief.scope === 'draft'
      ? (brief.draftCount > 0 ? brief.draftCount : brief.chapters) * 2 + 1
      : 0)

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto px-8 py-8">
        <header className="flex items-start gap-4 mb-6">
          <div className="shrink-0 w-11 h-11 rounded-md flex items-center justify-center bg-star-accent/10 border border-star-accent/20">
            <Flame className="text-star-accent" size={22} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h1 className="text-xl font-mono font-bold uppercase tracking-wider text-ink-deep">
                Novel Forge
              </h1>
              {run && (
                <span
                  className={clsx(
                    'tag border text-[11px] font-medium',
                    statusStyle[run.status].className,
                  )}
                >
                  {run.status === 'running' && <Loader2 className="animate-spin mr-1" size={11} />}
                  {statusStyle[run.status].label}
                </span>
              )}
            </div>
            <p className="text-sm text-ink-500 mt-1 text-balance">
              Give it a theme. It designs the story, writes the bible and the outline, drafts the
              chapters, and keeps continuity state as it goes — one step at a time, all on your
              disk.
            </p>
          </div>
        </header>

        {error && (
          <div className="mb-5 text-sm text-star-danger bg-star-danger/10 rounded-sm px-4 py-2.5 border-l-4 border-l-star-danger whitespace-pre-wrap">
            {error}
          </div>
        )}

        {run ? (
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)] gap-5 items-start">
            <RunMonitor
              run={run}
              progress={progress}
              busy={busy}
              onPause={pause}
              onResume={resume}
              onCancel={cancel}
              onDiscard={discard}
              onRedraft={redraft}
              onDraftMore={draftMore}
              onExtendPlan={extendPlan}
              onOpenChapter={(chapterId) => openChapter(chapterId)}
              onOpenView={setView}
            />
            <div className="space-y-5">
              <DirectionCard run={run} busy={busy} onSave={saveDirection} />
              <BriefRecap brief={run.brief} />
              {run.concept && <ConceptCard run={run} />}
              <ActivityCard run={run} />
            </div>
          </div>
        ) : (
          <BriefForm
            brief={brief}
            setBrief={setBrief}
            advanced={advanced}
            setAdvanced={setAdvanced}
            providers={(config?.ai.providers ?? []).map((p) => ({
              id: p.id,
              name: p.name,
              model: p.model,
            }))}
            existingProse={existingProse}
            estimatedCalls={estimatedCalls}
            busy={busy}
            onStart={start}
          />
        )}
      </div>
    </div>
  )
}

// ---- Brief form ----

function BriefForm({
  brief,
  setBrief,
  advanced,
  setAdvanced,
  providers,
  existingProse,
  estimatedCalls,
  busy,
  onStart,
}: {
  brief: ForgeBrief
  setBrief: (update: (current: ForgeBrief) => ForgeBrief) => void
  advanced: boolean
  setAdvanced: (value: boolean) => void
  providers: { id: string; name: string; model: string }[]
  existingProse: number
  estimatedCalls: number
  busy: string
  onStart: () => void | Promise<void>
}): JSX.Element {
  const patch = (changes: Partial<ForgeBrief>): void =>
    setBrief((current) => ({ ...current, ...changes }))

  return (
    <div className="space-y-5 max-w-3xl">
      <section className="card">
        <label className="block text-sm font-semibold text-ink-deep mb-2">Theme</label>
        <textarea
          className="textarea min-h-[104px]"
          placeholder="One or two sentences. A premise, an image, a question — whatever the book should grow from."
          value={brief.theme}
          disabled={!!busy}
          autoFocus
          onChange={(e) => patch({ theme: e.target.value })}
        />
        <div className="flex flex-wrap gap-1.5 mt-3">
          <span className="text-[11px] text-ink-500 self-center mr-1">
            <Sparkles size={11} className="inline -mt-0.5 mr-1" />
            Need a spark?
          </span>
          {THEME_IDEAS.map((idea) => (
            <button
              key={idea.label}
              type="button"
              className="tab-pill text-[11px]"
              disabled={!!busy}
              onClick={() => patch({ theme: idea.theme, genre: idea.genre })}
            >
              {idea.label}
            </button>
          ))}
        </div>
      </section>

      <section className="card space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Field label="Genre" hint="Empty = the model picks one">
            <input
              className="input"
              list="forge-genres"
              placeholder="Fantasy…"
              value={brief.genre}
              disabled={!!busy}
              onChange={(e) => patch({ genre: e.target.value })}
            />
            <datalist id="forge-genres">
              {GENRE_PRESETS.map((genre) => (
                <option key={genre} value={genre} />
              ))}
            </datalist>
          </Field>
          <Field label="Tone" hint="Two or three words">
            <input
              className="input"
              list="forge-tones"
              placeholder="Dark and literary…"
              value={brief.tone}
              disabled={!!busy}
              onChange={(e) => patch({ tone: e.target.value })}
            />
            <datalist id="forge-tones">
              {TONE_PRESETS.map((tone) => (
                <option key={tone} value={tone} />
              ))}
            </datalist>
          </Field>
          <Field label="Prose language">
            <select
              className="input"
              value={brief.language}
              disabled={!!busy}
              onChange={(e) => patch({ language: e.target.value as ForgeBrief['language'] })}
            >
              <option value="auto">Follow the app language</option>
              <option value="zh">简体中文</option>
              <option value="en">English</option>
            </select>
          </Field>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Field label="Chapters" hint={`${FORGE_LIMITS.minChapters}–${FORGE_LIMITS.maxChapters}`}>
            <input
              className="input"
              type="number"
              min={FORGE_LIMITS.minChapters}
              max={FORGE_LIMITS.maxChapters}
              value={brief.chapters}
              disabled={!!busy}
              onChange={(e) => patch({ chapters: Number(e.target.value) })}
            />
          </Field>
          <Field label="Words per chapter" hint="CJK characters count as one">
            <input
              className="input"
              type="number"
              min={FORGE_LIMITS.minWordsPerChapter}
              max={FORGE_LIMITS.maxWordsPerChapter}
              step={100}
              value={brief.wordsPerChapter}
              disabled={!!busy}
              onChange={(e) => patch({ wordsPerChapter: Number(e.target.value) })}
            />
          </Field>
          <Field label="Viewpoint" hint="Empty = the model decides">
            <input
              className="input"
              placeholder="Third-person limited…"
              value={brief.pov}
              disabled={!!busy}
              onChange={(e) => patch({ pov: e.target.value })}
            />
          </Field>
        </div>

        <Field label="Author constraints" hint="Binding rules every chapter must respect">
          <textarea
            className="textarea min-h-[64px]"
            placeholder="Single POV. No romance. Every chapter must end on a decision, not a cliffhanger."
            value={brief.constraints}
            disabled={!!busy}
            onChange={(e) => patch({ constraints: e.target.value })}
          />
        </Field>
      </section>

      <section className="card">
        <div className="text-sm font-semibold text-ink-deep mb-3">How far should it go?</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <ScopeCard
            active={brief.scope === 'plan'}
            disabled={!!busy}
            title="Plan only"
            desc="Concept, story bible and chapter outline. You write the prose yourself."
            onClick={() => patch({ scope: 'plan' })}
          />
          <ScopeCard
            active={brief.scope === 'draft'}
            disabled={!!busy}
            title="Plan + draft prose"
            desc="Also writes each chapter, and updates the continuity memory after every one."
            onClick={() => patch({ scope: 'draft' })}
          />
        </div>

        {brief.scope === 'draft' && (
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Chapters to draft" hint="Drafting is resumable — you can continue later">
              <select
                className="input"
                value={brief.draftCount === 0 ? 'all' : 'some'}
                disabled={!!busy}
                onChange={(e) =>
                  patch({ draftCount: e.target.value === 'all' ? 0 : Math.min(3, brief.chapters) })
                }
              >
                <option value="all">All planned chapters</option>
                <option value="some">Only the first…</option>
              </select>
            </Field>
            {brief.draftCount > 0 && (
              <Field label="First N chapters">
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={brief.chapters}
                  value={brief.draftCount}
                  disabled={!!busy}
                  onChange={(e) => patch({ draftCount: Number(e.target.value) })}
                />
              </Field>
            )}
          </div>
        )}
      </section>

      <section className="card space-y-4">
        <button
          type="button"
          className="flex items-center gap-1.5 text-sm font-semibold text-ink-deep"
          onClick={() => setAdvanced(!advanced)}
        >
          {advanced ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          Advanced
        </button>

        {advanced && (
          <div className="space-y-4">
            <Field label="Provider" hint="Defaults to the writing provider, then the active one">
              <select
                className="input"
                value={brief.providerId ?? ''}
                disabled={!!busy}
                onChange={(e) => patch({ providerId: e.target.value || null })}
              >
                <option value="">Use the default provider</option>
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name} · {provider.model}
                  </option>
                ))}
              </select>
            </Field>

            <label className="flex items-start gap-2.5 text-sm text-ink-muted">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={brief.replaceExisting}
                disabled={!!busy}
                onChange={(e) => patch({ replaceExisting: e.target.checked })}
              />
              <span>
                Replace the existing outline
                <span className="block text-[11px] text-ink-500">
                  Required when the world already has chapters with prose. Version snapshots keep
                  the old text recoverable from History.
                </span>
              </span>
            </label>
          </div>
        )}

        {existingProse > 0 && !brief.replaceExisting && (
          <div className="flex items-start gap-2 text-[13px] text-star-accent bg-star-accent/10 rounded-sm px-3 py-2">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>
              This world already has {existingProse} chapter{existingProse === 1 ? '' : 's'} with
              prose. Forging rewrites the outline, so turn on “Replace the existing outline” or
              start from a blank world.
            </span>
          </div>
        )}
      </section>

      <div className="flex items-center gap-4">
        <button
          className="btn btn-primary"
          onClick={onStart}
          disabled={!!busy || !brief.theme.trim()}
        >
          {busy ? <Loader2 className="animate-spin" size={16} /> : <Flame size={16} />}
          {busy || 'Forge the novel'}
        </button>
        <span className="text-[11px] text-ink-500">
          About {estimatedCalls} model calls. Runs in the background — you can leave this view.
        </span>
      </div>
    </div>
  )
}

function ScopeCard({
  active,
  disabled,
  title,
  desc,
  onClick,
}: {
  active: boolean
  disabled: boolean
  title: string
  desc: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        'text-left rounded-md border px-4 py-3 transition-colors disabled:opacity-60',
        active
          ? 'border-star-accent bg-star-accent/5'
          : 'border-ink-800 hover:border-ink-700 bg-ink-900',
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={clsx(
            'w-3.5 h-3.5 rounded-full border-2 shrink-0',
            active ? 'border-star-accent bg-star-accent' : 'border-ink-600',
          )}
        />
        <span className="text-sm font-semibold text-ink-deep">{title}</span>
      </div>
      <div className="text-[11px] text-ink-500 mt-1.5 leading-relaxed">{desc}</div>
    </button>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <label className="block">
      <span className="flex items-baseline gap-2 mb-1.5">
        <span className="text-[13px] font-medium text-ink-muted">{label}</span>
        {hint && <span className="text-[11px] text-ink-500">{hint}</span>}
      </span>
      {children}
    </label>
  )
}

// ---- Run monitor ----

function RunMonitor({
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
    </div>
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

// ---- Read-only summaries ----

/**
 * Author direction: standing instructions the pipeline applies while it keeps
 * writing. This is the only way to change the book's course mid-run, so it is
 * deliberately a first-class panel rather than a per-chapter field.
 */
function DirectionCard({
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

function BriefRecap({ brief }: { brief: ForgeBrief }): JSX.Element {
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

function ConceptCard({ run }: { run: ForgeRun }): JSX.Element {
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

function ActivityCard({ run }: { run: ForgeRun }): JSX.Element {
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
