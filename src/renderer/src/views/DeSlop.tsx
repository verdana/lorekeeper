import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { chatStream } from '../api'
import { toastError, toastSuccess, parseAiError } from '../toast'
import { PROMPTS } from '@shared/prompts'
import type { Chapter, ChatMessage, SlopReport, SlopFlag, VoiceTraits } from '@shared/types'
import type { SlopCalibration, SlopCalibrationSample, SlopDimId, SlopWeights } from '@shared/types'
import { analyzeSlop, detectLang, DEFAULT_SLOP_WEIGHTS } from '@shared/slop/analyze'
import { calibrateWeights, calibrationError } from '@shared/slop/calibrate'
import {
  scanChapter,
  rankByRisk,
  buildZhuqueChecklist,
  type SlopBatchRow,
} from '@shared/slop/batch'
import { isRulesPackOutdated } from '@shared/slop/analyze'
import { t, uiLang } from '../i18n'
import {
  Sparkles,
  FileText,
  Info,
  Loader2,
  RefreshCw,
  Wand2,
  Square,
  ClipboardCopy,
  Trash2,
  SlidersHorizontal,
  ChevronDown,
  ChevronRight,
  Table,
  Download,
} from 'lucide-react'
import clsx from 'clsx'
import DiffView from '../components/DiffView'
import EmptyState from '../components/EmptyState'
import { wordCount, uid } from '../lib'

const BAND_COLOR: Record<SlopReport['band'], string> = {
  green: 'text-star-success',
  yellow: 'text-star-accent',
  red: 'text-star-danger',
}
// Only flags at or above this per-sentence risk are eligible for rewrite.
// 0.33 is the analyzer's lowest meaningful risk (any flagged sentence starts
// here), so any sentence the local engine calls suspicious can be rewritten.
// This matches the user's mental model of "9 suspicious sentences -> I can
// rewrite them" even when the chapter's overall score is low.
const REWRITE_RISK_THRESHOLD = 0.33
// Hard cap on how many sentences are sent to the model in one batch.
const MAX_REWRITE_FLAGS = 12
// Per-request total prose char cap so a long chapter can't blow the budget.
const MAX_REWRITE_CHARS = 4000

interface RewriteJob {
  original: string
  start: number
  end: number
  revised: string | null
  accepted: boolean
}
interface RewriteState {
  jobs: RewriteJob[]
  active: number | null
  streaming: boolean
  error: string
}
const IDLE_REWRITE: RewriteState = { jobs: [], active: null, streaming: false, error: '' }

function highlightSegments(
  text: string,
  flags: SlopFlag[],
): { text: string; risk: number | null }[] {
  if (flags.length === 0) return [{ text, risk: null }]
  const ordered = [...flags].sort((a, b) => a.start - b.start)
  const segs: { text: string; risk: number | null }[] = []
  let cursor = 0
  for (const f of ordered) {
    if (f.start > cursor) segs.push({ text: text.slice(cursor, f.start), risk: null })
    segs.push({ text: text.slice(f.start, f.end), risk: f.risk })
    cursor = f.end
  }
  if (cursor < text.length) segs.push({ text: text.slice(cursor), risk: null })
  return segs
}
function riskClass(risk: number): string {
  if (risk >= 0.66) return 'bg-star-danger/15 border-b border-star-danger/50'
  if (risk >= 0.33) return 'bg-star-accent/15 border-b border-star-accent/40'
  return 'bg-star-accent/8 border-b border-star-accent/25'
}
function voiceProfileText(traits: VoiceTraits | undefined): string {
  if (!traits) return ''
  return [
    `${t('voice.sentenceLength')}: ${traits.sentenceLength}`,
    `${t('voice.verbStyle')}: ${traits.verbStyle}`,
    `${t('voice.narrativeDistance')}: ${traits.narrativeDistance}`,
    `${t('voice.dialogueStyle')}: ${traits.dialogueStyle}`,
    `${t('voice.rhetoricalPatterns')}: ${traits.rhetoricalPatterns}`,
    traits.proseNotes ? `${t('voice.notes')}: ${traits.proseNotes}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}
const EMPTY_CALIBRATION: SlopCalibration = { samples: [], calibratedWeights: null, updatedAt: 0 }
function calibrationKey(worldId: string | null): string | null {
  return worldId ? `lorekeeper:slop:calibration:${worldId}` : null
}
function loadCalibration(worldId: string | null): SlopCalibration {
  const key = calibrationKey(worldId)
  if (!key) return EMPTY_CALIBRATION
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as SlopCalibration) : EMPTY_CALIBRATION
  } catch {
    return EMPTY_CALIBRATION
  }
}
function persistCalibration(worldId: string | null, cal: SlopCalibration): void {
  const key = calibrationKey(worldId)
  if (!key) return
  try {
    localStorage.setItem(key, JSON.stringify({ ...cal, updatedAt: Date.now() }))
  } catch {
    // Storage full / unavailable; keep state in memory only.
  }
}
export default function DeSlop(): JSX.Element {
  const novel = useStore((s) => s.novel)
  const config = useStore((s) => s.config)
  const voiceProfile = useStore((s) => s.voiceProfile)
  const saveNovel = useStore((s) => s.saveNovel)
  const saveConfig = useStore((s) => s.saveConfig)
  const currentWorldId = useStore((s) => s.currentWorldId)
  const allChapters: Chapter[] = useMemo(
    () => (novel?.volumes ?? []).flatMap((v) => v.chapters),
    [novel],
  )
  const [selectedId, setSelectedId] = useState<string>('')
  const [selectedChapter, setSelectedChapter] = useState<Chapter | null>(null)
  const [text, setText] = useState<string>('')
  const [report, setReport] = useState<SlopReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [rerunning, setRerunning] = useState(false)
  const [rewrite, setRewrite] = useState<RewriteState>(IDLE_REWRITE)
  const [calibration, setCalibration] = useState<SlopCalibration>({
    samples: [],
    calibratedWeights: null,
    updatedAt: 0,
  })
  const [showCalibration, setShowCalibration] = useState(false)
  const [batchRows, setBatchRows] = useState<SlopBatchRow[] | null>(null)
  const [batchScanning, setBatchScanning] = useState(false)
  const [showBatch, setShowBatch] = useState(false)
  const weights = config?.slop?.weights
  const runRef = useRef(0)
  const abortRef = useRef<AbortController | undefined>(undefined)
  const MIN_SPIN_MS = 350
  const hasKey = config?.ai.providers.some((p) => p.apiKey) ?? false
  useEffect(() => () => abortRef.current?.abort(), [])
  // Load calibration samples when the world changes (or on first mount).
  useEffect(() => {
    setCalibration(loadCalibration(currentWorldId))
  }, [currentWorldId])
  const runAnalysis = useCallback(
    (content: string) => {
      const tick = ++runRef.current
      const startedAt = Date.now()
      setRerunning(true)
      setTimeout(() => {
        if (tick !== runRef.current) return
        const r = analyzeSlop(content, { weights, lang: detectLang(content), uiLang })
        const elapsed = Date.now() - startedAt
        const finish = (): void => {
          if (tick !== runRef.current) return
          setReport(r)
          setRerunning(false)
          setLoading(false)
        }
        if (elapsed >= MIN_SPIN_MS) finish()
        else setTimeout(finish, MIN_SPIN_MS - elapsed)
      }, 0)
    },
    [weights],
  )
  const loadChapter = async (chapter: Chapter): Promise<void> => {
    abortRef.current?.abort()
    setSelectedId(chapter.id)
    setSelectedChapter(chapter)
    setLoading(true)
    setReport(null)
    setRewrite(IDLE_REWRITE)
    try {
      const content = await window.api.readChapter(chapter.file)
      setText(content)
      runAnalysis(content)
    } catch {
      setLoading(false)
      setRerunning(false)
    }
  }
  const rerun = (): void => {
    if (!text) return
    setReport(null)
    setRewrite(IDLE_REWRITE)
    runAnalysis(text)
  }
  const segments = useMemo(
    () => (report ? highlightSegments(text, report.flags) : []),
    [report, text],
  )
  const rewriteableFlags = useMemo<SlopFlag[]>(() => {
    if (!report) return []
    const picked = report.flags.filter((f) => f.risk >= REWRITE_RISK_THRESHOLD)
    const limited = picked.slice(0, MAX_REWRITE_FLAGS)
    let total = 0
    const out: SlopFlag[] = []
    for (const f of limited) {
      if (total + f.text.length > MAX_REWRITE_CHARS) break
      total += f.text.length
      out.push(f)
    }
    return out
  }, [report])
  const slopCfg = config?.slop
  const rewriteProviderId = slopCfg?.rewriteProviderId ?? undefined
  const rewriteSystemPrompt = slopCfg?.rewriteSystemPrompt?.trim() || PROMPTS.deslop.systemPrompt
  const startRewrite = async (): Promise<void> => {
    if (rewrite.streaming || rewriteableFlags.length === 0 || !selectedChapter) return
    if (!hasKey) {
      setRewrite((r) => ({ ...r, error: t('rewrite.noKey') }))
      return
    }
    const jobs: RewriteJob[] = rewriteableFlags.map((f) => ({
      original: f.text,
      start: f.start,
      end: f.end,
      revised: null,
      accepted: false,
    }))
    setRewrite({ jobs, active: 0, streaming: true, error: '' })
    const controller = new AbortController()
    abortRef.current = controller
    const voice = voiceProfileText(voiceProfile?.traits)
    const packUser = PROMPTS.deslop.userTemplate
    // Rewrite one flagged sentence at a time so each diff stays reviewable.
    // Offsets are applied last-to-first at write-back, staying valid against
    // the original text even though revisions differ in length.
    for (let i = 0; i < jobs.length; i++) {
      if (controller.signal.aborted) break
      const messages: ChatMessage[] = [
        { role: 'system', content: rewriteSystemPrompt },
        { role: 'user', content: packUser({ sample: jobs[i].original, voice }) },
      ]
      try {
        const { content } = await chatStream(
          messages,
          rewriteProviderId,
          (type, chunk) => {
            if (type !== 'content' || controller.signal.aborted) return
            setRewrite((r) => {
              if (r.active !== i) return r
              const next = [...r.jobs]
              next[i] = { ...next[i], revised: (next[i].revised ?? '') + chunk }
              return { ...r, jobs: next }
            })
          },
          controller.signal,
        )
        if (controller.signal.aborted) break
        const final = content.trim()
        if (!final) throw new Error(t('rewrite.noResult'))
        setRewrite((r) => {
          const next = [...r.jobs]
          next[i] = { ...next[i], revised: final }
          return { ...r, jobs: next }
        })
      } catch (e) {
        if (controller.signal.aborted) break
        setRewrite((r) => ({ ...r, streaming: false, error: parseAiError(e) }))
        toastError(parseAiError(e))
        return
      }
    }
    if (!controller.signal.aborted) {
      setRewrite((r) => ({ ...r, streaming: false }))
      toastSuccess(t('toast.rewriteDone'))
    }
  }
  const stopRewrite = (): void => {
    abortRef.current?.abort()
    setRewrite((r) => ({ ...r, streaming: false }))
  }
  const decideJob = (accepted: boolean): void => {
    setRewrite((r) => {
      if (r.active === null) return r
      const next = [...r.jobs]
      next[r.active] = { ...next[r.active], accepted }
      const adv = r.active + 1
      return { ...r, jobs: next, active: adv >= next.length ? null : adv }
    })
  }
  // Apply accepted revisions (last-to-first), write back via writeChapter
  // (which snapshots the old version first), then re-run the local analysis.
  const writeBack = async (): Promise<void> => {
    if (!selectedChapter || !novel) return
    const accepted = rewrite.jobs
      .filter((j) => j.accepted && j.revised)
      .sort((a, b) => b.start - a.start)
    let nextText = text
    for (const job of accepted) {
      nextText = nextText.slice(0, job.start) + job.revised! + nextText.slice(job.end)
    }
    try {
      await window.api.writeChapter(selectedChapter.file, nextText)
      await saveNovel({
        ...novel,
        volumes: novel.volumes.map((v) => ({
          ...v,
          chapters: v.chapters.map((c) =>
            c.id === selectedChapter.id
              ? { ...c, wordCount: wordCount(nextText), updatedAt: Date.now() }
              : c,
          ),
        })),
      })
      setText(nextText)
      toastSuccess(t('toast.writtenBack', { title: selectedChapter.title }))
      setRewrite(IDLE_REWRITE)
      runAnalysis(nextText)
    } catch (e) {
      toastError(t('toast.writeBackFailed', { err: parseAiError(e) }))
    }
  }
  // ---- Calibration (M3): record a sample, backfill Zhuque score, refit weights. ----
  const recordSample = (): void => {
    if (!report || !selectedChapter) return
    const features = {} as Record<SlopDimId, number>
    for (const d of report.dimensions) features[d.id] = d.score
    const sample: SlopCalibrationSample = {
      id: uid('slop_'),
      ts: Date.now(),
      chapterTitle: selectedChapter.title,
      features,
      localScore: report.score,
      zhuqueScore: null,
      snippet: text.slice(0, 60).replace(/\n/g, ' '),
    }
    const next = { ...calibration, samples: [sample, ...calibration.samples] }
    setCalibration(next)
    persistCalibration(currentWorldId, next)
    toastSuccess(t('toast.sampleRecorded'))
  }
  const setZhuqueScore = (id: string, score: number | null): void => {
    const next = {
      ...calibration,
      samples: calibration.samples.map((s) => (s.id === id ? { ...s, zhuqueScore: score } : s)),
    }
    setCalibration(next)
    persistCalibration(currentWorldId, next)
  }
  const deleteSample = (id: string): void => {
    const next = { ...calibration, samples: calibration.samples.filter((s) => s.id !== id) }
    setCalibration(next)
    persistCalibration(currentWorldId, next)
  }
  const recompute = (): void => {
    const fitted = calibrateWeights(calibration.samples, weights ?? DEFAULT_SLOP_WEIGHTS)
    const next = { ...calibration, calibratedWeights: fitted }
    setCalibration(next)
    persistCalibration(currentWorldId, next)
    if (fitted) toastSuccess(t('toast.weightsFit'))
    else toastError(t('toast.needSamples'))
  }
  const applyWeights = async (w: SlopWeights): Promise<void> => {
    if (!config) return
    await saveConfig({ ...config, slop: { ...config.slop!, weights: w } })
    toastSuccess(t('toast.weightsApplied'))
    if (text) runAnalysis(text)
  }
  const resetWeights = async (): Promise<void> => {
    if (!config) return
    await saveConfig({ ...config, slop: { ...config.slop!, weights: DEFAULT_SLOP_WEIGHTS } })
    toastSuccess(t('toast.weightsReset'))
    if (text) runAnalysis(text)
  }
  const copyForZhuque = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      toastSuccess(t('toast.copiedForZhuque'))
    } catch {
      toastError(t('toast.copyFailed'))
    }
  }
  // ---- Batch scan (M4): all-chapter overview + Zhuque checklist export. ----
  const runBatchScan = async (): Promise<void> => {
    if (batchScanning || allChapters.length === 0) return
    setBatchScanning(true)
    setBatchRows(null)
    try {
      const rows: SlopBatchRow[] = []
      for (const ch of allChapters) {
        const content = await window.api.readChapter(ch.file)
        rows.push(scanChapter(ch.id, ch.title, ch.wordCount, content, weights, uiLang))
      }
      setBatchRows(rankByRisk(rows))
      toastSuccess(t('toast.scanned', { n: rows.length }))
    } catch (e) {
      toastError(t('toast.batchFailed', { err: parseAiError(e) }))
    } finally {
      setBatchScanning(false)
    }
  }
  const exportChecklist = async (): Promise<void> => {
    const rows = batchRows
    if (!rows || rows.length === 0) return
    const md = buildZhuqueChecklist(rows, novel?.title, uiLang)
    try {
      await navigator.clipboard.writeText(md)
      toastSuccess(t('toast.checklistCopied'))
    } catch {
      toastError(t('toast.copyFailed2'))
    }
  }
  const isBusy = loading || rerunning || rewrite.streaming
  const activeJob = rewrite.active !== null ? rewrite.jobs[rewrite.active] : null
  const acceptedCount = rewrite.jobs.filter((j) => j.accepted).length
  const allDecided = rewrite.jobs.length > 0 && rewrite.active === null && !rewrite.streaming
  const hasAccepted = rewrite.jobs.some((j) => j.accepted)
  const scoredSamples = calibration.samples.filter((s) => s.zhuqueScore != null)
  const canRecompute = scoredSamples.length >= 2
  const maeDefault = calibrationError(calibration.samples, weights ?? DEFAULT_SLOP_WEIGHTS)
  const maeCalibrated = calibration.calibratedWeights
    ? calibrationError(calibration.samples, calibration.calibratedWeights)
    : null
  const weightsApplied =
    calibration.calibratedWeights != null &&
    weights != null &&
    (Object.keys(calibration.calibratedWeights) as SlopDimId[]).every(
      (d) => Math.abs((weights as SlopWeights)[d] - calibration.calibratedWeights![d]) < 1e-6,
    )
  const rulesOutdated = isRulesPackOutdated(config?.slop?.rulesPackVersion, detectLang(text))
  return (
    <div className="h-full flex">
      <aside className="w-64 shrink-0 border-r border-ink-800 bg-ink-900 flex flex-col">
        <div className="px-4 py-3 border-b border-ink-800 flex items-center gap-2">
          <Sparkles size={16} className="text-star-accent" />
          <span className="text-sm font-medium text-ink-deep">{t('title')}</span>
        </div>
        <div className="px-3 py-2 text-xs text-ink-500 flex items-center gap-1.5">
          <FileText size={13} /> {t('selectChapterHint')}
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-3 space-y-1">
          {allChapters.length === 0 ? (
            <p className="text-[11px] text-ink-500 px-2">{t('noChapters')}</p>
          ) : (
            allChapters.map((c) => (
              <button
                key={c.id}
                disabled={isBusy}
                onClick={() => loadChapter(c)}
                className={clsx(
                  'w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left text-sm transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-star-accent/40 focus-visible:ring-inset',
                  isBusy && 'opacity-50 cursor-not-allowed',
                  selectedId === c.id
                    ? 'bg-ink-700 text-ink-deep'
                    : 'bg-ink-850 hover:bg-ink-800 text-ink-muted',
                )}
              >
                <span className="flex-1 min-w-0 truncate">{c.title}</span>
              </button>
            ))
          )}
        </div>
      </aside>
      <div className="flex-1 min-w-0 flex flex-col">
        {!report && !isBusy && (
          <div className="flex-1 flex items-center justify-center">
            <EmptyState
              icon={Sparkles}
              title={t('emptyTitle')}
              description={t('emptyDescription')}
            />
          </div>
        )}
        {isBusy && !report && (
          <div className="flex-1 flex items-center justify-center gap-3 text-ink-500 text-sm">
            <Loader2 size={20} className="animate-spin text-star-accent" />
            {t('analyzing')}
          </div>
        )}
        {report && (
          <div className="flex-1 overflow-y-auto px-6 py-5">
            <div className="max-w-4xl mx-auto space-y-5">
              {/* Rules-pack version warning (M4) */}
              {rulesOutdated && (
                <div className="text-xs text-star-accent bg-star-accent/10 border border-star-accent/30 rounded px-3 py-2">
                  {t('rulesOutdated', { cur: config?.slop?.rulesPackVersion ?? t('unknown') })}
                </div>
              )}
              {/* Batch scan (M4) */}
              <div className="border border-ink-800 rounded-lg overflow-hidden">
                <button
                  onClick={() => setShowBatch((v) => !v)}
                  className="flex items-center gap-1.5 w-full px-3 py-2 text-xs text-ink-500 hover:text-ink-muted transition-colors"
                >
                  {showBatch ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  <Table size={13} /> {t('batch.title')}
                  <span className="ml-auto text-[11px]">
                    {batchRows
                      ? t('batch.scanned', { n: batchRows.length })
                      : t('batch.notScanned')}
                  </span>
                </button>
                {showBatch && (
                  <div className="px-3 pb-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={runBatchScan}
                        disabled={batchScanning || isBusy}
                        className="btn btn-sm btn-secondary"
                      >
                        {batchScanning ? (
                          <Loader2 size={13} className="animate-spin" />
                        ) : (
                          <RefreshCw size={13} />
                        )}
                        {t('batch.scanAll')}
                      </button>
                      {batchRows && batchRows.length > 0 && (
                        <button onClick={exportChecklist} className="btn btn-sm btn-secondary">
                          <Download size={13} /> {t('batch.exportChecklist')}
                        </button>
                      )}
                    </div>
                    {batchScanning && (
                      <div className="text-[11px] text-ink-500 flex items-center gap-1.5">
                        <Loader2 size={11} className="animate-spin" /> {t('batch.scanning')}
                      </div>
                    )}
                    {batchRows && batchRows.length > 0 && (
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-ink-500 border-b border-ink-800">
                              <th className="text-left font-normal py-1.5 pr-2">
                                {t('batch.col.chapter')}
                              </th>
                              <th className="text-right font-normal px-2">
                                {t('batch.col.score')}
                              </th>
                              <th className="text-right font-normal px-2">
                                {t('batch.col.flags')}
                              </th>
                              <th className="text-right font-normal px-2">
                                {t('batch.col.words')}
                              </th>
                              <th className="text-right font-normal pl-2">
                                {t('batch.col.action')}
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {batchRows.map((r) => (
                              <tr key={r.chapterId} className="border-b border-ink-800/50">
                                <td className="py-1.5 pr-2 text-ink-muted truncate max-w-[220px]">
                                  {r.title}
                                </td>
                                <td
                                  className={clsx(
                                    'text-right px-2 tabular-nums font-medium',
                                    BAND_COLOR[r.band],
                                  )}
                                >
                                  {r.score}
                                </td>
                                <td className="text-right px-2 tabular-nums text-ink-500">
                                  {r.flagCount}
                                </td>
                                <td className="text-right px-2 tabular-nums text-ink-500">
                                  {r.wordCount}
                                </td>
                                <td className="text-right pl-2">
                                  <button
                                    onClick={() => {
                                      const ch = allChapters.find((c) => c.id === r.chapterId)
                                      if (ch) loadChapter(ch)
                                    }}
                                    className="text-star-info hover:underline"
                                  >
                                    {t('batch.view')}
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div className="flex items-end gap-4">
                <div>
                  <div className={clsx('text-5xl font-bold tabular-nums', BAND_COLOR[report.band])}>
                    {report.score}
                  </div>
                  <div className="text-xs text-ink-500 mt-1">{t('scoreCaption')}</div>
                </div>
                <div className={clsx('text-sm font-medium pb-1', BAND_COLOR[report.band])}>
                  {t(`band.${report.band}`)}
                </div>
                <div className="flex-1" />
                <button onClick={rerun} disabled={isBusy} className="btn btn-sm btn-secondary">
                  <RefreshCw size={13} className={clsx(rerunning && 'animate-spin')} />
                  {t('rerun')}
                </button>
              </div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-2.5">
                {report.dimensions.map((d) => (
                  <div key={d.id} className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-ink-muted">{d.label}</span>
                      <span className="text-ink-500 tabular-nums">{Math.round(d.score * 100)}</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-ink-800 overflow-hidden">
                      <div
                        className={clsx(
                          'h-full rounded-full transition-all duration-300',
                          d.score >= 0.66
                            ? 'bg-star-danger'
                            : d.score >= 0.33
                              ? 'bg-star-accent'
                              : 'bg-star-success',
                        )}
                        style={{ width: `${Math.round(d.score * 100)}%` }}
                      />
                    </div>
                    <div className="text-[10px] text-ink-500">{d.detail}</div>
                  </div>
                ))}
              </div>
              <div>
                <div className="flex items-center gap-1.5 text-xs text-ink-500 mb-2">
                  <Info size={13} /> {t('highlightHint')}
                </div>
                <div className="p-4 bg-ink-850 rounded-lg border border-ink-800 text-sm leading-loose whitespace-pre-wrap text-ink-body">
                  {segments.map((seg, i) =>
                    seg.risk === null ? (
                      <span key={i}>{seg.text}</span>
                    ) : (
                      <span key={i} className={clsx('rounded-sm', riskClass(seg.risk))}>
                        {seg.text}
                      </span>
                    ),
                  )}
                </div>
              </div>
              {rewriteableFlags.length > 0 && !allDecided && (
                <div className="flex items-center gap-2 pt-1">
                  {rewrite.streaming ? (
                    <button onClick={stopRewrite} className="btn btn-sm btn-danger">
                      <Square size={13} /> {t('stopRewrite')}
                    </button>
                  ) : (
                    <button
                      onClick={startRewrite}
                      disabled={isBusy}
                      className="btn btn-sm btn-primary"
                    >
                      <Wand2 size={13} /> {t('rewrite', { n: rewriteableFlags.length })}
                    </button>
                  )}
                  {rewrite.streaming && (
                    <span className="text-xs text-ink-500 flex items-center gap-1.5">
                      <Loader2 size={12} className="animate-spin" />{' '}
                      {t('rewriting', { i: (rewrite.active ?? 0) + 1, n: rewrite.jobs.length })}
                    </span>
                  )}
                  {rewrite.error && (
                    <span className="text-xs text-star-danger">{rewrite.error}</span>
                  )}
                </div>
              )}
              {rewriteableFlags.length === 0 && report.flags.length > 0 && !rewrite.jobs.length && (
                <div className="text-xs text-ink-500 pt-1">{t('rewrite.lowSlop')}</div>
              )}
              {activeJob && activeJob.revised !== null && !rewrite.streaming && (
                <div className="space-y-2 p-3 bg-ink-900 rounded-lg border border-star-accent/30">
                  <div className="text-xs text-ink-500">
                    {t('reviewHeader', {
                      i: (rewrite.active ?? 0) + 1,
                      n: rewrite.jobs.length,
                      accepted: acceptedCount,
                    })}
                  </div>
                  <DiffView
                    original={activeJob.original}
                    revised={activeJob.revised}
                    onAccept={() => decideJob(true)}
                    onReject={() => decideJob(false)}
                  />
                </div>
              )}
              {activeJob && activeJob.revised !== null && rewrite.streaming && (
                <div className="space-y-2 p-3 bg-ink-900 rounded-lg border border-star-accent/30">
                  <div className="text-xs text-ink-500 flex items-center gap-1.5">
                    <Loader2 size={12} className="animate-spin" /> {t('generatingRewrite')}
                  </div>
                  <div className="p-3 bg-ink-850 rounded border border-ink-800 text-sm text-ink-muted whitespace-pre-wrap leading-relaxed">
                    {activeJob.revised}
                  </div>
                </div>
              )}
              {allDecided && (
                <div className="flex items-center gap-2 pt-1">
                  <span className="text-xs text-ink-500">
                    {t('reviewDone', { accepted: acceptedCount, n: rewrite.jobs.length })}
                  </span>
                  <div className="flex-1" />
                  {hasAccepted ? (
                    <button onClick={writeBack} className="btn btn-sm btn-primary">
                      {t('writeBack')}
                    </button>
                  ) : (
                    <button
                      onClick={() => setRewrite(IDLE_REWRITE)}
                      className="btn btn-sm btn-secondary"
                    >
                      {t('close')}
                    </button>
                  )}
                </div>
              )}
              {report.flags.length > 0 && !rewrite.jobs.length && (
                <div>
                  <div className="text-xs text-ink-500 mb-2">
                    {t('flagsSummary', { n: report.flags.length })}
                  </div>
                  <div className="space-y-2">
                    {report.flags.slice(0, 30).map((f, i) => (
                      <div
                        key={i}
                        className="p-2.5 bg-ink-850 rounded border border-ink-800 text-sm"
                      >
                        <div className="text-ink-muted">{f.text}</div>
                        <div className="mt-1 text-[11px] text-star-accent">
                          {t('flagReason', { note: f.note })}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {/* Calibration panel (M3) */}
              <div className="pt-2 border-t border-ink-800">
                <button
                  onClick={() => setShowCalibration((v) => !v)}
                  className="flex items-center gap-1.5 w-full text-xs text-ink-500 hover:text-ink-muted transition-colors py-1"
                >
                  {showCalibration ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  <SlidersHorizontal size={13} /> {t('calibration.title')}
                  <span className="ml-auto text-[11px]">
                    {t('calibration.summary', {
                      n: calibration.samples.length,
                      m: scoredSamples.length,
                    })}
                  </span>
                </button>
                {showCalibration && (
                  <div className="space-y-3 pt-2">
                    <p className="text-[11px] text-ink-500 leading-relaxed">
                      {t('calibration.desc')}
                    </p>
                    {report && (
                      <div className="flex items-center gap-2">
                        <button onClick={recordSample} className="btn btn-sm btn-secondary">
                          <FileText size={13} /> {t('calibration.recordSample')}
                        </button>
                        <button onClick={copyForZhuque} className="btn btn-sm btn-secondary">
                          <ClipboardCopy size={13} /> {t('calibration.copyForZhuque')}
                        </button>
                      </div>
                    )}
                    {calibration.samples.length > 0 ? (
                      <div className="space-y-1.5">
                        {calibration.samples.map((s) => (
                          <div
                            key={s.id}
                            className="flex items-center gap-2 p-2 bg-ink-850 rounded border border-ink-800 text-xs"
                          >
                            <span className="flex-1 min-w-0 truncate text-ink-muted">
                              {s.chapterTitle}
                            </span>
                            <span className="text-ink-500 tabular-nums shrink-0">
                              {t('localScore', { n: s.localScore })}
                            </span>
                            <input
                              type="number"
                              min={0}
                              max={100}
                              placeholder={t('zhuquePlaceholder')}
                              value={s.zhuqueScore ?? ''}
                              onChange={(e) => {
                                const v = e.target.value
                                setZhuqueScore(s.id, v === '' ? null : Number(v))
                              }}
                              className="w-16 bg-ink-900 border border-ink-800 rounded px-1.5 py-0.5 text-ink-body tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-star-accent/40"
                            />
                            <button
                              onClick={() => deleteSample(s.id)}
                              className="text-ink-500 hover:text-star-danger shrink-0"
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-[11px] text-ink-500">{t('calibration.noSamples')}</p>
                    )}
                    {canRecompute && (
                      <div className="flex items-center gap-2 flex-wrap">
                        <button onClick={recompute} className="btn btn-sm btn-secondary">
                          <RefreshCw size={13} /> {t('calibration.recompute')}
                        </button>
                        {maeDefault != null && (
                          <span className="text-[11px] text-ink-500">
                            {t('calibration.maeDefault', { x: maeDefault })}
                          </span>
                        )}
                        {maeCalibrated != null && (
                          <span className="text-[11px] text-star-success">
                            {t('calibration.maeCalibrated', { x: maeCalibrated })}
                          </span>
                        )}
                      </div>
                    )}
                    {calibration.calibratedWeights && (
                      <div className="space-y-2 p-3 bg-ink-900 rounded-lg border border-ink-800">
                        <div className="text-xs text-ink-500">
                          {t('calibration.weightsCompare')}
                        </div>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                          {report.dimensions.map((d) => {
                            const cw = calibration.calibratedWeights![d.id]
                            const cur = (weights ?? DEFAULT_SLOP_WEIGHTS)[d.id]
                            const diff = cw - cur
                            return (
                              <div
                                key={d.id}
                                className="flex items-center justify-between text-[11px]"
                              >
                                <span className="text-ink-muted truncate">{d.label}</span>
                                <span
                                  className={clsx(
                                    'tabular-nums',
                                    Math.abs(diff) < 0.005
                                      ? 'text-ink-500'
                                      : diff > 0
                                        ? 'text-star-accent'
                                        : 'text-star-success',
                                  )}
                                >
                                  {cur.toFixed(2)} {'->'} {cw.toFixed(2)}
                                </span>
                              </div>
                            )
                          })}
                        </div>
                        <div className="flex items-center gap-2 pt-1">
                          {weightsApplied ? (
                            <span className="text-[11px] text-star-success">
                              {t('calibration.weightsApplied')}
                            </span>
                          ) : (
                            <button
                              onClick={() => applyWeights(calibration.calibratedWeights!)}
                              className="btn btn-sm btn-primary"
                            >
                              {t('calibration.applyWeights')}
                            </button>
                          )}
                          <button onClick={resetWeights} className="btn btn-sm btn-secondary">
                            {t('calibration.resetWeights')}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
