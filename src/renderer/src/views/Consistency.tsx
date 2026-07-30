import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { chatStream } from '../api'
import { toastError, parseAiError } from '../toast'
import type { Chapter, ChatMessage, ConsistencyConfig } from '@shared/types'
import {
  ShieldCheck,
  Play,
  Square,
  Loader2,
  BookText,
  FileText,
  Check,
  Copy,
  AlertTriangle,
  RotateCcw,
  Clock,
  FileWarning,
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkCjkFriendly from 'remark-cjk-friendly'
import clsx from 'clsx'
import EmptyState from '../components/EmptyState'

// Context budget: rough limit to avoid overflowing model context.
const MAX_CHAPTERS = 12
const CONTEXT_BUDGET = 60000 // 参考资料总字数软上限，超出仅提示、不强拦

// 提示词与巡检维度均可在「设置 · 巡检」里编辑，此处只按配置组装消息。
// userTemplate 用 {{material}} 占位选中的材料；模板漏写占位符时把材料追加到末尾兜底。
function buildMessages(cfg: ConsistencyConfig, context: string): ChatMessage[] {
  const body = cfg.userTemplate.includes('{{material}}')
    ? cfg.userTemplate.replace('{{material}}', () => context)
    : `${cfg.userTemplate}\n\n${context}`
  return [
    { role: 'system', content: cfg.systemPrompt },
    { role: 'user', content: body },
  ]
}

export default function Consistency(): JSX.Element {
  const config = useStore((s) => s.config)!
  const settingDocs = useStore((s) => s.settingDocs)
  const novel = useStore((s) => s.novel)
  const currentWorldId = useStore((s) => s.currentWorldId)
  const allChapters: Chapter[] = useMemo(
    () => (novel?.volumes ?? []).flatMap((v) => v.chapters),
    [novel],
  )

  // 上次巡检结果按世界持久化到 localStorage,让刷新/切页不丢结果。
  // 只存报告文本本身;错误信息、进行中状态等瞬时态不持久化。
  const reportKey = currentWorldId ? `lorekeeper:consistency:report:${currentWorldId}` : null

  // 设定默认全选（人名/能力多在设定里），章节默认不选（长、按需加）
  const [selectedDocs, setSelectedDocs] = useState<Set<string>>(
    () => new Set(settingDocs.map((d) => d.id)),
  )
  const [selectedChapters, setSelectedChapters] = useState<Set<string>>(new Set())
  const [running, setRunning] = useState(false)
  // 懒初始化:挂载时同步从 localStorage 读回上次报告,天然回避 effect 时序 race。
  // 用 useState 的初始化回调而不是 effect,是因为 effect 先跑再 setState 会经历一次「空 report」中间态,
  // 与写 effect 撞车导致刚读到的数据被反向删掉。
  const [report, setReport] = useState<string>(() => {
    if (!currentWorldId) return ''
    try {
      return localStorage.getItem(`lorekeeper:consistency:report:${currentWorldId}`) ?? ''
    } catch {
      return ''
    }
  })
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [finishedAt, setFinishedAt] = useState<number | null>(null)
  const abortRef = useRef<AbortController>(undefined)

  const hasKey = config.ai.providers.some((p) => p.apiKey)

  // 卸载时中止仍在进行的流式请求，避免离开视图后后台空跑、白耗 AI 额度
  useEffect(() => () => abortRef.current?.abort(), [])

  // 用户在本视图挂载状态下切换世界时,重新从 localStorage 读回新世界的报告。
  // 挂载首次的读取已经交给 useState 懒初始化,这里只处理「后续 worldId 变化」。
  const initialWorldRef = useRef(currentWorldId)
  useEffect(() => {
    if (currentWorldId === initialWorldRef.current) return
    if (!reportKey) {
      setReport('')
      return
    }
    try {
      setReport(localStorage.getItem(reportKey) ?? '')
    } catch {
      setReport('')
    }
  }, [currentWorldId, reportKey])

  // 已选章节的正文字数（设定字数未在元数据里，按选中份数估个下限即可）
  // memo 化：流式Render.时 setReport 频繁触发重Render.，避免每帧重跑 filter+reduce
  const chapterWords = useMemo(
    () =>
      allChapters.filter((c) => selectedChapters.has(c.id)).reduce((n, c) => n + c.wordCount, 0),
    [allChapters, selectedChapters],
  )
  const overBudget = chapterWords > CONTEXT_BUDGET

  const toggleDoc = (id: string): void =>
    setSelectedDocs((s) => {
      const n = new Set(s)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })

  const toggleChapter = (id: string): void =>
    setSelectedChapters((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else if (n.size < MAX_CHAPTERS) n.add(id)
      return n
    })

  // 拉取选中材料，拼成排查上下文
  const buildContext = async (): Promise<string> => {
    // 各份材料相互独立，并行读取，避免选中十余份时逐个 RPC 往返串行卡顿
    const docParts = Promise.all(
      settingDocs
        .filter((d) => selectedDocs.has(d.id))
        .map(async (d) => `# Codex: ${d.title}\n\n${(await window.api.readSetting(d.id)).content}`),
    )
    const chapterParts = Promise.all(
      allChapters
        .filter((c) => selectedChapters.has(c.id))
        .map(async (c) => `# Chapter: ${c.title}\n\n${await window.api.readChapter(c.file)}`),
    )
    return [...(await docParts), ...(await chapterParts)].join('\n\n---\n\n')
  }

  const run = async (): Promise<void> => {
    if (running || (selectedDocs.size === 0 && selectedChapters.size === 0)) return
    setRunning(true)
    setError('')
    setReport('')
    setStartedAt(Date.now())
    setFinishedAt(null)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const context = await buildContext()
      // 巡检专属 provider，未指定则传 undefined，由服务端回落到 active provider
      const { content, reasoning } = await chatStream(
        buildMessages(config.consistency, context),
        config.consistency.providerId ?? undefined,
        (type, text) => {
          if (type === 'content') setReport((r) => r + text)
        },
        controller.signal,
      )
      // 推理模型可能把整个 token 预算耗在思考上、未产出正文（finish_reason=length）。
      // 此时不报错、report 又为空，用户会看到「什么都没发生」，需给出可操作的提示。
      if (!controller.signal.aborted && !content.trim()) {
        const msg = reasoning.trim()
          ? 'The selected model spent its whole budget on "thinking" and did not output the report. Switch to a non-reasoning model, or narrow the scope (fewer chapters) and retry.'
          : 'The AI returned nothing. Please retry, or switch to another provider.'
        setError(msg)
        toastError(msg)
      }
      // 只有拿到非空报告、未中止时才落盘。Stop / 中途出错都不动存量,让上次的结果继续保留。
      if (!controller.signal.aborted && content.trim() && reportKey) {
        try {
          localStorage.setItem(reportKey, content)
        } catch {
          // 存不下就算了,当前会话内报告仍在
        }
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        setError((e as Error).message)
        toastError(parseAiError(e))
      }
    } finally {
      setRunning(false)
      setFinishedAt(Date.now())
    }
  }

  const stop = (): void => {
    abortRef.current?.abort()
    setRunning(false)
  }

  const wordCount = report.trim() ? report.replace(/\s/g, '').length : 0
  const reportDuration =
    startedAt && finishedAt ? Math.round((finishedAt - startedAt) / 1000) : null
  const formattedTime = finishedAt
    ? new Date(finishedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null

  const copyReport = async (): Promise<void> => {
    await navigator.clipboard.writeText(report)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="h-full flex">
      {/* 配置面板 */}
      <aside className="w-72 shrink-0 border-r border-ink-800 bg-ink-900/80 flex flex-col overflow-y-auto">
        <div className="px-4 py-3.5 border-b border-ink-800">
          <h2 className="text-sm font-semibold text-ink-body flex items-center gap-2">
            <ShieldCheck size={16} /> Consistency Check
          </h2>
        </div>

        <div className="p-4 space-y-4">
          <p className="text-[11px] text-ink-500 leading-relaxed">
            Have the AI read the selected codex and chapters to catch contradictions in names,
            abilities, timeline, and more, with a severity-ranked list. The more focused the
            material, the more accurate the result.
          </p>

          {/* 设定文档 */}
          <div>
            <label className="text-[13px] font-medium text-ink-muted mb-2 flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <BookText size={13} /> Codex ({selectedDocs.size})
              </span>
              {settingDocs.length > 0 && (
                <button
                  onClick={() =>
                    setSelectedDocs((s) =>
                      s.size === settingDocs.length
                        ? new Set()
                        : new Set(settingDocs.map((d) => d.id)),
                    )
                  }
                  className="text-star-info hover:text-star-accent rounded-sm px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-star-accent/40"
                >
                  {selectedDocs.size === settingDocs.length ? 'Clear' : 'Select all'}
                </button>
              )}
            </label>
            {settingDocs.length === 0 ? (
              <p className="text-[11px] text-ink-500">No codex documents yet.</p>
            ) : (
              <div className="space-y-0.5 max-h-52 overflow-y-auto">
                {settingDocs.map((d) => (
                  <button
                    key={d.id}
                    disabled={running}
                    onClick={() => toggleDoc(d.id)}
                    className={clsx(
                      'w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left text-[13px] transition-all duration-200',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-star-accent/40 focus-visible:ring-inset',
                      selectedDocs.has(d.id)
                        ? 'bg-ink-700 border border-ink-600/60 text-ink-body'
                        : 'bg-ink-850/60 hover:bg-ink-800 border border-transparent text-ink-muted',
                    )}
                  >
                    <div
                      className={clsx(
                        'w-4 h-4 rounded flex items-center justify-center shrink-0 transition-colors duration-200',
                        selectedDocs.has(d.id)
                          ? 'bg-star-accent/15 text-star-accent'
                          : 'border border-ink-700 text-transparent',
                      )}
                    >
                      {selectedDocs.has(d.id) && <Check size={11} />}
                    </div>
                    <span className="flex-1 min-w-0 truncate text-ink-muted">{d.title}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 章节正文 */}
          <div>
            <label className="text-[13px] font-medium text-ink-muted mb-2 flex items-center gap-1.5">
              <FileText size={13} /> Chapters ({selectedChapters.size}/{MAX_CHAPTERS})
            </label>
            {allChapters.length === 0 ? (
              <p className="text-[11px] text-ink-500">No chapters yet.</p>
            ) : (
              <div className="space-y-0.5 max-h-52 overflow-y-auto">
                {allChapters.map((c) => {
                  const on = selectedChapters.has(c.id)
                  const full = !on && selectedChapters.size >= MAX_CHAPTERS
                  return (
                    <button
                      key={c.id}
                      disabled={running || full}
                      onClick={() => toggleChapter(c.id)}
                      className={clsx(
                        'w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left text-[13px] transition-all duration-200',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-star-accent/40 focus-visible:ring-inset',
                        on
                          ? 'bg-ink-700 border border-ink-600/60 text-ink-body'
                          : 'bg-ink-850/60 hover:bg-ink-800 border border-transparent text-ink-muted',
                        full && 'opacity-40 cursor-not-allowed',
                      )}
                    >
                      <div
                        className={clsx(
                          'w-4 h-4 rounded flex items-center justify-center shrink-0 transition-colors duration-200',
                          on
                            ? 'bg-star-accent/15 text-star-accent'
                            : 'border border-ink-700 text-transparent',
                          full && 'opacity-40',
                        )}
                      >
                        {on && <Check size={11} />}
                      </div>
                      <span className="flex-1 min-w-0 truncate text-ink-muted">{c.title}</span>
                    </button>
                  )
                })}
              </div>
            )}
            {overBudget && (
              <p className="text-[11px] text-star-accent mt-1.5">
                Selected chapters total ~{chapterWords.toLocaleString()} words; too much may exceed
                the model context and reduce accuracy. Consider checking in batches.
              </p>
            )}
          </div>

          {!hasKey && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-star-danger/8 border border-star-danger/20">
              <AlertTriangle size={14} className="text-star-danger shrink-0 mt-0.5" />
              <p className="text-[12px] text-star-danger leading-relaxed">
                No AI provider configured yet. Add an API key under Settings first.
              </p>
            </div>
          )}

          {running ? (
            <button onClick={stop} className="w-full btn btn-danger">
              <Square size={15} /> Stop
            </button>
          ) : (
            <button
              onClick={run}
              disabled={!hasKey || (selectedDocs.size === 0 && selectedChapters.size === 0)}
              className="w-full btn btn-primary"
            >
              <Play size={15} /> Run check
            </button>
          )}
        </div>
      </aside>

      {/* 报告区 */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* 结果摘要头：报告存在时固定在顶部，提供元信息与操作 */}
        {report && (
          <div className="shrink-0 bg-ink-900/80 backdrop-blur-sm border-b border-ink-800 px-6 py-3.5">
            <div className="max-w-4xl mx-auto flex items-center justify-between gap-4">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-9 h-9 rounded-lg bg-star-success/10 border border-star-success/20 flex items-center justify-center shrink-0">
                  <ShieldCheck size={18} className="text-star-success" />
                </div>
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-ink-body truncate">
                    Consistency Report
                  </h3>
                  <div className="flex items-center gap-3 text-[11px] text-ink-500 mt-0.5">
                    {formattedTime && (
                      <span className="flex items-center gap-1">
                        <Clock size={11} />
                        {formattedTime}
                      </span>
                    )}
                    {reportDuration !== null && <span>{reportDuration}s</span>}
                    <span>{wordCount.toLocaleString()} chars</span>
                    <span>
                      {selectedDocs.size} codex, {selectedChapters.size} chapters
                    </span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button onClick={run} disabled={running} className="btn btn-sm btn-secondary">
                  <RotateCcw size={14} />
                  Run again
                </button>
                <button onClick={copyReport} className="btn btn-sm btn-primary">
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-6 py-6">
          <div className="max-w-4xl mx-auto">
            {!report && !running && !error && (
              <EmptyState
                icon={ShieldCheck}
                title="Ready to review"
                description="Select codex and chapters to review, and let the AI catch contradictions and worldbuilding errors."
              />
            )}
            {report && (
              <div className="markdown-body text-sm">
                <ReactMarkdown remarkPlugins={[remarkGfm, remarkCjkFriendly]}>
                  {report}
                </ReactMarkdown>
                {running && (
                  <span className="inline-block w-1.5 h-4 bg-star-accent/60 animate-pulse align-middle ml-0.5" />
                )}
              </div>
            )}
            {running && !report && (
              <div className="flex flex-col items-center gap-4 pt-24">
                <div className="w-12 h-12 rounded-full bg-ink-850 border border-ink-800 flex items-center justify-center">
                  <Loader2 size={22} className="animate-spin text-star-accent" />
                </div>
                <div className="text-center">
                  <p className="text-sm font-medium text-ink-body">Scanning for inconsistencies</p>
                  <p className="text-[12px] text-ink-500 mt-1 max-w-xs">
                    Reading {selectedDocs.size} codex document{selectedDocs.size !== 1 ? 's' : ''}
                    {selectedChapters.size > 0 &&
                      ` and ${selectedChapters.size} chapter${selectedChapters.size !== 1 ? 's' : ''}`}
                    …
                  </p>
                </div>
              </div>
            )}
            {error && (
              <div className="flex items-start gap-3 p-4 rounded-xl bg-star-danger/6 border border-star-danger/15">
                <div className="w-9 h-9 rounded-lg bg-star-danger/10 border border-star-danger/20 flex items-center justify-center shrink-0">
                  <FileWarning size={18} className="text-star-danger" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-star-danger">Check failed</p>
                  <p className="text-[13px] text-star-danger/80 mt-0.5 leading-relaxed">{error}</p>
                  <button
                    onClick={run}
                    disabled={running}
                    className="mt-3 btn btn-sm btn-secondary"
                  >
                    <RotateCcw size={13} />
                    Retry
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
