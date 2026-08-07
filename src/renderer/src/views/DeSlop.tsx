import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { useStore, isBatchWriteLocked } from '../store'
import { chatStream } from '../api'
import { toastError, toastSuccess, parseAiError } from '../toast'
import { PROMPTS } from '@shared/prompts'
import type {
  Chapter,
  ChatMessage,
  SlopReport,
  SlopFlag,
  VoiceTraits,
  RewriteIntensity,
} from '@shared/types'
import type { SlopConfig } from '@shared/types'
import { analyzeSlop, detectLang, getRulesPack, isRulesPackOutdated } from '@shared/slop/analyze'
import { validateRulesPack, type RulesPack } from '@shared/slop/rules.types'

import { scanChapter, rankByRisk, type SlopBatchRow } from '@shared/slop/batch'
import { groupRewriteFlags } from '@shared/slop/group'
import { t, uiLang } from '../i18n'
import {
  Sparkles,
  FileText,
  Info,
  Loader2,
  RefreshCw,
  Wand2,
  Square,
  Check,
  ChevronDown,
  ChevronRight,
  Table,
  Package,
  Upload,
  X,
} from 'lucide-react'
import clsx from 'clsx'
import EmptyState from '../components/EmptyState'
import { wordCount } from '../lib'

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
  /** Set when this job rewrites a group of related sentences together. */
  groupNote?: string
  /** Number of sentences in this job (1 for single-sentence jobs). */
  size: number
  revised: string | null
}
interface RewriteState {
  jobs: RewriteJob[]
  /** Job currently being streamed. */
  generating: number | null
  streaming: boolean
  error: string
}
const IDLE_REWRITE: RewriteState = {
  jobs: [],
  generating: null,
  streaming: false,
  error: '',
}

function highlightSegments(
  text: string,
  flags: SlopFlag[],
): { text: string; risk: number | null; hard: boolean }[] {
  if (flags.length === 0) return [{ text, risk: null, hard: false }]
  const ordered = [...flags].sort((a, b) => a.start - b.start)
  const segs: { text: string; risk: number | null; hard: boolean }[] = []
  let cursor = 0
  for (const f of ordered) {
    if (f.start > cursor) segs.push({ text: text.slice(cursor, f.start), risk: null, hard: false })
    segs.push({ text: text.slice(f.start, f.end), risk: f.risk, hard: f.severity === 'hard' })
    cursor = f.end
  }
  if (cursor < text.length) segs.push({ text: text.slice(cursor), risk: null, hard: false })
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
  const [batchRows, setBatchRows] = useState<SlopBatchRow[] | null>(null)
  const [batchScanning, setBatchScanning] = useState(false)
  const [showBatch, setShowBatch] = useState(false)
  // 规则包导入（M4 打磨）
  const [showRules, setShowRules] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [importDraft, setImportDraft] = useState<RulesPack | null>(null)
  const [importError, setImportError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const runRef = useRef(0)
  const abortRef = useRef<AbortController | undefined>(undefined)
  const MIN_SPIN_MS = 350
  const hasKey = config?.ai.providers.some((p) => p.apiKey) ?? false
  useEffect(() => () => abortRef.current?.abort(), [])
  const runAnalysis = useCallback(
    (content: string, packOverride?: RulesPack | null) => {
      const tick = ++runRef.current
      const startedAt = Date.now()
      setRerunning(true)
      setTimeout(() => {
        if (tick !== runRef.current) return
        const lang = detectLang(content)
        const r = analyzeSlop(content, {
          lang,
          uiLang,
          rulesPack:
            packOverride !== undefined
              ? packOverride
              : (config?.slop?.customRulesPacks?.[lang] ?? null),
        })
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
    [config?.slop?.customRulesPacks],
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
  // Stream one job; returns the revised text, or null when aborted or on error
  // (state already reset). The returned text is what the caller stages — the
  // jobs array passed in here is the local copy, so state-only updates would
  // never reach writeBack (the original "rewrite vanished after streaming" bug).
  const generateOne = async (job: RewriteJob, index: number): Promise<string | null> => {
    const controller = new AbortController()
    abortRef.current = controller
    const voice = voiceProfileText(voiceProfile?.traits)
    const intensity: RewriteIntensity = config?.slop?.rewriteIntensity ?? 'balanced'
    const packUser = PROMPTS.deslop.userTemplate
    setRewrite((r) => ({ ...r, generating: index, streaming: true, error: '' }))
    const messages: ChatMessage[] = [
      { role: 'system', content: rewriteSystemPrompt },
      {
        role: 'user',
        content: packUser({
          sample: job.original,
          voice,
          intensity,
          ...(job.groupNote ? { groupNote: job.groupNote } : {}),
        }),
      },
    ]
    try {
      const { content } = await chatStream(
        messages,
        rewriteProviderId,
        (type, chunk) => {
          if (type !== 'content' || controller.signal.aborted) return
          setRewrite((r) => {
            if (r.generating !== index) return r
            const next = [...r.jobs]
            next[index] = { ...next[index], revised: (next[index].revised ?? '') + chunk }
            return { ...r, jobs: next }
          })
        },
        controller.signal,
        undefined,
        undefined,
        true,
      )
      if (controller.signal.aborted) return null
      const final = content.trim()
      if (!final) throw new Error(t('rewrite.noResult'))
      setRewrite((r) => {
        const next = [...r.jobs]
        next[index] = { ...next[index], revised: final }
        return { ...r, jobs: next }
      })
      return final
    } catch (e) {
      if (controller.signal.aborted) return null
      setRewrite((r) => ({ ...IDLE_REWRITE, error: parseAiError(e) }))
      toastError(parseAiError(e))
      return null
    }
  }
  // Generate every job in sequence. The finished pass is NOT written back
  // automatically — revisions are staged in state so the user can review each
  // change and explicitly confirm before writeChapter touches the file.
  const runRewrite = async (jobs: RewriteJob[]): Promise<void> => {
    const staged: RewriteJob[] = []
    for (let i = 0; i < jobs.length; i++) {
      const revised = await generateOne(jobs[i], i)
      if (revised === null) return
      staged.push({ ...jobs[i], revised })
    }
    setRewrite({ jobs: staged, generating: null, streaming: false, error: '' })
    toastSuccess(t('toast.rewriteDone'))
  }
  const startRewrite = (): void => {
    if (rewrite.streaming || rewriteableFlags.length === 0 || !selectedChapter) return
    if (!hasKey) {
      setRewrite((r) => ({ ...r, error: t('rewrite.noKey') }))
      return
    }
    // Generate and apply the whole pass in one flow. Consecutive sentences that
    // share a repeated head are merged into one group so the model rewrites them
    // together (later sentences reference earlier edits).
    const groups = groupRewriteFlags(rewriteableFlags, text)
    const jobs: RewriteJob[] = groups.map((g) => ({
      original: g.original,
      start: g.start,
      end: g.end,
      size: g.size,
      ...(g.groupNote ? { groupNote: g.groupNote } : {}),
      revised: null,
    }))
    setRewrite({ jobs, generating: null, streaming: true, error: '' })
    void runRewrite(jobs)
  }
  const stopRewrite = (): void => {
    abortRef.current?.abort()
    setRewrite(IDLE_REWRITE)
  }
  // Apply every staged revision (last-to-first) and write the chapter back via
  // writeChapter (which snapshots the old version first), then re-run the local
  // analysis. Called only after the user confirms the staged review.
  const writeBack = async (jobs: RewriteJob[]): Promise<void> => {
    if (!selectedChapter || !novel) return
    if (isBatchWriteLocked(useStore.getState())) {
      setRewrite(IDLE_REWRITE)
      return // batch owns this world's chapters
    }
    setRewrite((r) => ({ ...r, generating: null, streaming: true }))
    const applied = jobs.filter((j) => j.revised).sort((a, b) => b.start - a.start)
    let nextText = text
    for (const job of applied) {
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
      setRewrite(IDLE_REWRITE)
    }
  }

  // ---- Batch scan (M4): all-chapter overview. ----
  const runBatchScan = async (): Promise<void> => {
    if (batchScanning || allChapters.length === 0) return
    setBatchScanning(true)
    setBatchRows(null)
    try {
      const rows: SlopBatchRow[] = []
      for (const ch of allChapters) {
        const content = await window.api.readChapter(ch.file)
        rows.push(scanChapter(ch.id, ch.title, ch.wordCount, content, undefined, uiLang))
      }
      setBatchRows(rankByRisk(rows))
      toastSuccess(t('toast.scanned', { n: rows.length }))
    } catch (e) {
      toastError(t('toast.batchFailed', { err: parseAiError(e) }))
    } finally {
      setBatchScanning(false)
    }
  }

  const isBusy = loading || rerunning || rewrite.streaming
  // A finished rewrite pass is staged for review (awaiting confirm/cancel).
  // While staged, navigation/rerun that would silently discard the pass is
  // disabled — the user must explicitly write back or cancel first.
  const hasStagedRewrites = !rewrite.streaming && rewrite.jobs.length > 0
  const generatingJob = rewrite.generating !== null ? rewrite.jobs[rewrite.generating] : null
  const rulesOutdated = isRulesPackOutdated(
    config?.slop?.rulesPackVersion,
    detectLang(text),
    config?.slop?.customRulesPacks?.[detectLang(text)] ?? null,
  )

  // ---- Rewrite intensity (M4 polish): persist the selected intensity. ----
  const intensity: RewriteIntensity = config?.slop?.rewriteIntensity ?? 'balanced'
  const setIntensity = async (v: RewriteIntensity): Promise<void> => {
    if (!config || v === intensity) return
    await saveConfig({ ...config, slop: { ...config.slop!, rewriteIntensity: v } })
  }

  // ---- Rules pack import / restore (M4 polish). ----
  const packLang = (): 'zh' | 'en' => detectLang(text || '')
  const customPack = config?.slop?.customRulesPacks?.[packLang()] ?? null
  const activePack = getRulesPack(packLang(), customPack)
  const isCustomPack = customPack != null
  const onRulesFilePicked = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0]
    e.target.value = '' // 允许连续导入同一文件
    if (!file) return
    try {
      const pack = validateRulesPack(JSON.parse(await file.text()))
      setImportDraft(pack)
      setImportError('')
      setImportOpen(true)
    } catch (err) {
      setImportDraft(null)
      const msg = (err as Error).message
      setImportError(msg)
      toastError(t('rules.invalid', { err: msg }))
    }
  }
  const confirmImport = async (): Promise<void> => {
    if (!importDraft || !config) return
    const lang = importDraft.lang
    const nextSlop: SlopConfig = {
      ...config.slop!,
      customRulesPacks: { ...config.slop!.customRulesPacks, [lang]: importDraft },
      rulesPackVersion: importDraft.version,
    }
    await saveConfig({ ...config, slop: nextSlop })
    toastSuccess(t('rules.imported', { version: importDraft.version }))
    setImportOpen(false)
    setImportDraft(null)
    // 显式传参覆盖闭包中的旧 config，立即按新包重跑分析
    if (text) runAnalysis(text, importDraft)
  }
  const restoreBuiltinPack = async (): Promise<void> => {
    if (!config) return
    const custom = { ...config.slop!.customRulesPacks }
    delete custom[packLang()]
    const builtin = getRulesPack(packLang())
    await saveConfig({
      ...config,
      slop: {
        ...config.slop!,
        customRulesPacks: custom,
        rulesPackVersion: builtin.version,
      },
    })
    toastSuccess(t('rules.restored'))
    // 显式传 null（内置包）重跑分析，避免闭包读到刚恢复前的旧 config
    if (text) runAnalysis(text, null)
  }
  return (
    <div className="h-full flex">
      <aside className="w-64 shrink-0 border-r border-ink-800 bg-ink-900 flex flex-col">
        <div className="px-4 py-3 border-b border-ink-800 flex items-center gap-2">
          <Sparkles size={16} className="text-star-accent" />
          <span className="text-sm font-medium text-ink-deep">{t('title')}</span>
        </div>
        <div className="px-3 py-2 text-xs text-ink-500 flex items-start gap-1.5">
          <FileText size={13} className="mt-0.5 shrink-0" />
          <span className="leading-relaxed">
            {uiLang === 'en' ? (
              <>
                {t('selectChapterHint')}
                <br />
                {t('selectChapterHintSub')}
              </>
            ) : (
              t('selectChapterHint')
            )}
          </span>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-3 space-y-1">
          {allChapters.length === 0 ? (
            <p className="text-[11px] text-ink-500 px-2">{t('noChapters')}</p>
          ) : (
            allChapters.map((c) => (
              <button
                key={c.id}
                disabled={isBusy || hasStagedRewrites}
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
                                    disabled={hasStagedRewrites}
                                    className="text-star-info hover:underline disabled:opacity-40 disabled:cursor-not-allowed"
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
                <button
                  onClick={rerun}
                  disabled={isBusy || hasStagedRewrites}
                  className="btn btn-sm btn-secondary"
                >
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
                      <span
                        key={i}
                        className={clsx(
                          'rounded-sm',
                          riskClass(seg.risk),
                          seg.hard && 'ring-1 ring-star-danger/70 font-medium',
                        )}
                        title={seg.hard ? t('flagHard') : undefined}
                      >
                        {seg.text}
                      </span>
                    ),
                  )}
                </div>
              </div>
              {rewriteableFlags.length > 0 && (
                <div className="space-y-1.5 pt-1">
                  {/* 控件行：强度选择器 + 主按钮 + 错误信息 */}
                  <div className="flex flex-wrap items-center gap-2">
                    <div
                      className="flex items-stretch overflow-hidden rounded-md bg-ink-850 border border-ink-800 gap-px h-9 mr-1"
                      title={t('intensity.title')}
                    >
                      {(['light', 'balanced', 'strong'] as const).map((v) => (
                        <button
                          key={v}
                          onClick={() => void setIntensity(v)}
                          disabled={rewrite.streaming}
                          className={clsx(
                            'flex items-center justify-center px-3 text-[11px] transition-colors',
                            intensity === v
                              ? 'bg-ink-body text-white'
                              : 'text-ink-muted hover:bg-ink-800 hover:text-ink-body',
                          )}
                        >
                          {t(`intensity.${v}`)}
                        </button>
                      ))}
                    </div>
                    {rewrite.streaming && rewrite.generating !== null ? (
                      <button onClick={stopRewrite} className="btn btn-sm btn-danger">
                        <Square size={13} /> {t('stopRewrite')}
                      </button>
                    ) : !rewrite.streaming && rewrite.jobs.length === 0 ? (
                      <button
                        onClick={startRewrite}
                        disabled={isBusy}
                        className="btn btn-sm btn-primary"
                      >
                        <Wand2 size={13} /> {t('rewrite', { n: rewriteableFlags.length })}
                      </button>
                    ) : !rewrite.streaming && rewrite.generating === null ? (
                      <>
                        <button
                          onClick={() => setRewrite(IDLE_REWRITE)}
                          disabled={isBusy}
                          className="btn btn-sm btn-secondary"
                        >
                          <X size={13} /> {t('cancel')}
                        </button>
                        <button
                          onClick={() => void writeBack(rewrite.jobs)}
                          disabled={isBusy}
                          className="btn btn-sm btn-primary"
                        >
                          <Check size={13} /> {t('writeBack')}
                        </button>
                      </>
                    ) : null}
                    {rewrite.error && (
                      <span className="text-xs text-star-danger">{rewrite.error}</span>
                    )}
                  </div>
                  {/* 状态行：正在改写的句子摘要，超宽截断而不挤压控件 */}
                  {rewrite.streaming && (
                    <div className="flex items-center gap-1.5 text-xs text-ink-500 min-w-0">
                      <Loader2 size={12} className="animate-spin shrink-0" />
                      {rewrite.generating !== null ? (
                        <>
                          <span className="shrink-0">
                            {t('rewriting', {
                              i: rewrite.generating + 1,
                              n: rewrite.jobs.length,
                            })}
                          </span>
                          {generatingJob && (
                            <span
                              className="truncate flex-1 min-w-0"
                              title={generatingJob.original}
                            >
                              {generatingJob.original}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="shrink-0">{t('rewrite.applying')}</span>
                      )}
                    </div>
                  )}
                </div>
              )}
              {rewriteableFlags.length === 0 && report.flags.length > 0 && !rewrite.jobs.length && (
                <div className="text-xs text-ink-500 pt-1">{t('rewrite.lowSlop')}</div>
              )}
              {generatingJob && generatingJob.revised !== null && rewrite.streaming && (
                <div className="space-y-2 p-3 bg-ink-900 rounded-lg border border-star-accent/30">
                  <div className="text-xs text-ink-500">{t('generatingRewrite')}</div>
                  <div className="p-3 bg-ink-850 rounded border border-ink-800 text-sm text-ink-muted whitespace-pre-wrap leading-relaxed">
                    {generatingJob.revised}
                  </div>
                </div>
              )}
              {!rewrite.streaming && rewrite.jobs.length > 0 && (
                <div className="space-y-2">
                  <div className="text-xs text-ink-500">{t('rewrite.review')}</div>
                  {rewrite.jobs.map((job, i) => (
                    <div
                      key={i}
                      className="p-3 bg-ink-850 rounded-lg border border-ink-800 text-sm space-y-1.5"
                    >
                      <div className="flex items-center gap-2 text-[11px] text-ink-500">
                        <span className="tabular-nums">
                          {i + 1}/{rewrite.jobs.length}
                        </span>
                        {job.size > 1 && (
                          <span className="rounded bg-star-accent/15 px-1.5 py-0.5 text-[10px] text-star-accent">
                            {t('rewrite.groupBadge', { n: job.size })}
                          </span>
                        )}
                      </div>
                      <div className="text-ink-500 line-through">{job.original}</div>
                      <div className="text-star-success">{job.revised}</div>
                    </div>
                  ))}
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
                          {f.severity === 'hard' && (
                            <span className="mr-1.5 rounded bg-star-danger/15 px-1.5 py-0.5 text-[10px] text-star-danger">
                              {t('flagHard')}
                            </span>
                          )}
                          {t('flagReason', { note: f.note })}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {/* Rules pack (M4 polish): import / restore custom packs */}
              <div className="pt-2 border-t border-ink-800">
                <button
                  onClick={() => setShowRules((v) => !v)}
                  className="flex items-center gap-1.5 w-full text-xs text-ink-500 hover:text-ink-muted transition-colors py-1"
                >
                  {showRules ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  <Package size={13} /> {t('rules.title')}
                  <span className="ml-auto text-[11px]">
                    {activePack.version} · {isCustomPack ? t('rules.custom') : t('rules.builtin')}
                  </span>
                </button>
                {showRules && (
                  <div className="space-y-3 pt-2">
                    <p className="text-[11px] text-ink-500 leading-relaxed">{t('rules.desc')}</p>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => fileInputRef.current?.click()}
                        className="btn btn-sm btn-secondary"
                      >
                        <Upload size={13} /> {t('rules.import')}
                      </button>
                      {isCustomPack && (
                        <button
                          onClick={() => void restoreBuiltinPack()}
                          className="btn btn-sm btn-ghost"
                        >
                          <RefreshCw size={13} /> {t('rules.restore')}
                        </button>
                      )}
                    </div>
                    <div className="text-[11px] text-ink-500">
                      {t('rules.active', {
                        source: isCustomPack ? t('rules.custom') : t('rules.builtin'),
                        version: activePack.version,
                        count: activePack.rules.length,
                        lang: activePack.lang === 'zh' ? '中文' : 'English',
                      })}
                    </div>
                    {importError && (
                      <div className="text-xs text-star-danger">
                        {t('rules.invalid', { err: importError })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
      {/* 规则包文件选择（M4 打磨） */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(e) => void onRulesFilePicked(e)}
      />
      {/* 规则包导入预览对话框 */}
      {importOpen && importDraft && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-deep/60 p-6">
          <div className="w-full max-w-md bg-ink-850 border border-ink-700 rounded-[14px] shadow-warm-lg">
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-ink-800">
              <h3 className="text-sm font-semibold text-ink-body flex items-center gap-2">
                <Package size={15} /> {t('rules.previewTitle')}
              </h3>
              <button
                onClick={() => setImportOpen(false)}
                className="icon-btn text-ink-500 hover:text-ink-body"
                aria-label="Close"
              >
                <X size={15} />
              </button>
            </div>
            <div className="p-5 space-y-3">
              <div className="text-xs text-ink-500 space-y-1">
                <div>
                  {t('rules.lang', { lang: importDraft.lang === 'zh' ? '中文' : 'English' })}
                </div>
                <div>{t('rules.version', { version: importDraft.version })}</div>
                <div>{t('rules.count', { count: importDraft.rules.length })}</div>
                <div className="pt-1">
                  {t('rules.compare', {
                    current: activePack.version,
                    incoming: importDraft.version,
                  })}
                </div>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-ink-800">
              <button onClick={() => setImportOpen(false)} className="btn btn-sm btn-ghost">
                {t('cancel')}
              </button>
              <button onClick={() => void confirmImport()} className="btn btn-sm btn-primary">
                <Upload size={13} /> {t('rules.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
