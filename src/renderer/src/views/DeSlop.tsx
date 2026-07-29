import { useCallback, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import type { Chapter, SlopReport, SlopFlag } from '@shared/types'
import { analyzeSlop, detectLang } from '@shared/slop/analyze'
import { Sparkles, FileText, Play, Info, Loader2, RefreshCw } from 'lucide-react'
import clsx from 'clsx'
import EmptyState from '../components/EmptyState'

const BAND_COLOR: Record<SlopReport['band'], string> = {
  green: 'text-star-success',
  yellow: 'text-star-accent',
  red: 'text-star-danger',
}
const BAND_LABEL: Record<SlopReport['band'], string> = {
  green: '接近人类写作',
  yellow: '有一定机器味',
  red: '机器味明显',
}

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

export default function DeSlop(): JSX.Element {
  const novel = useStore((s) => s.novel)
  const config = useStore((s) => s.config)
  const allChapters: Chapter[] = useMemo(
    () => (novel?.volumes ?? []).flatMap((v) => v.chapters),
    [novel],
  )

  const [selectedId, setSelectedId] = useState<string>('')
  const [text, setText] = useState<string>('')
  const [report, setReport] = useState<SlopReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [rerunning, setRerunning] = useState(false)

  const weights = config?.slop?.weights
  const runRef = useRef(0)

  /** Minimum time the spinner stays visible so the animation is perceptible. */
  const MIN_SPIN_MS = 350

  /**
   * Run analysis with a visible loading state.
   *
   * analyzeSlop is synchronous and fast (tens of ms), so a microtask would
   * finish before the browser ever paints the spinner. We defer with a
   * macrotask (setTimeout) so the loading state is painted first, and enforce
   * a minimum spinner duration so the "reset -> analyzing -> result" feedback
   * is always perceptible.
   */
  const runAnalysis = useCallback(
    (content: string) => {
      const tick = ++runRef.current
      const startedAt = Date.now()
      setRerunning(true)
      setTimeout(() => {
        if (tick !== runRef.current) return // superseded by a newer run
        const r = analyzeSlop(content, { weights, lang: detectLang(content) })
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
    setSelectedId(chapter.id)
    setLoading(true)
    setReport(null)
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
    runAnalysis(text)
  }
  const segments = useMemo(
    () => (report ? highlightSegments(text, report.flags) : []),
    [report, text],
  )

  const isBusy = loading || rerunning

  return (
    <div className="h-full flex">
      {/* Left: chapter picker */}
      <aside className="w-64 shrink-0 border-r border-ink-800 bg-ink-900 flex flex-col">
        <div className="px-4 py-3 border-b border-ink-800 flex items-center gap-2">
          <Sparkles size={16} className="text-star-accent" />
          <span className="text-sm font-medium text-ink-deep">去 AI 味</span>
        </div>
        <div className="px-3 py-2 text-xs text-ink-500 flex items-center gap-1.5">
          <FileText size={13} /> 选择章节（本地分析，不耗 API）
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-3 space-y-1">
          {allChapters.length === 0 ? (
            <p className="text-[11px] text-ink-500 px-2">No chapters yet.</p>
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

      {/* Right: report */}
      <div className="flex-1 min-w-0 flex flex-col">
        {!report && !isBusy && (
          <div className="flex-1 flex items-center justify-center">
            <EmptyState
              icon={Sparkles}
              title="检测机器味"
              description="选择一个章节，本地统计引擎会给出「机器味」评分，并逐句标出像 AI 的地方与原因。"
            />
          </div>
        )}

        {isBusy && (
          <div className="flex-1 flex items-center justify-center gap-3 text-ink-500 text-sm">
            <Loader2 size={20} className="animate-spin text-star-accent" />
            分析中…
          </div>
        )}

        {report && !isBusy && (
          <div className="flex-1 overflow-y-auto px-6 py-5">
            <div className="max-w-4xl mx-auto space-y-5">
              {/* Score header */}
              <div className="flex items-end gap-4">
                <div>
                  <div className={clsx('text-5xl font-bold tabular-nums', BAND_COLOR[report.band])}>
                    {report.score}
                  </div>
                  <div className="text-xs text-ink-500 mt-1">机器味评分 (0–100，越低越像人)</div>
                </div>
                <div className={clsx('text-sm font-medium pb-1', BAND_COLOR[report.band])}>
                  {BAND_LABEL[report.band]}
                </div>
                <div className="flex-1" />
                <button onClick={rerun} disabled={isBusy} className="btn btn-sm btn-secondary">
                  <RefreshCw size={13} className={clsx(isBusy && 'animate-spin')} />
                  重新分析
                </button>
              </div>
              {/* Dimension bars */}
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

              {/* Highlighted prose */}
              <div>
                <div className="flex items-center gap-1.5 text-xs text-ink-500 mb-2">
                  <Info size={13} /> 高亮句子为风险段落，颜色越深越像 AI
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

              {/* Flag list with reasons */}
              {report.flags.length > 0 && (
                <div>
                  <div className="text-xs text-ink-500 mb-2">
                    共 {report.flags.length} 处可疑句（按风险排序）
                  </div>
                  <div className="space-y-2">
                    {report.flags.slice(0, 30).map((f, i) => (
                      <div
                        key={i}
                        className="p-2.5 bg-ink-850 rounded border border-ink-800 text-sm"
                      >
                        <div className="text-ink-muted">{f.text}</div>
                        <div className="mt-1 text-[11px] text-star-accent">因为：{f.note}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
