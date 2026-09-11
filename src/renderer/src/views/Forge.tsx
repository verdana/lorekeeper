import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { parseAiError, toastError, toastSuccess } from '../toast'
import { DEFAULT_FORGE_BRIEF, forgeProgress } from '@shared/forge'
import type { ForgeBrief, ForgeDirective, ForgeRun } from '@shared/types'
import { Flame, Loader2 } from 'lucide-react'
import clsx from 'clsx'
import { BriefForm } from './forge/BriefForm'
import { RunMonitor } from './forge/RunMonitor'
import { ActivityCard, BriefRecap, ConceptCard, DirectionCard } from './forge/panels'
import { statusStyle } from './forge/constants'

/** Example themes offered as one-click starting points. */
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
