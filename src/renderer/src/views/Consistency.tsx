import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { chatStream } from '../api'
import { toastError, parseAiError } from '../toast'
import type { Chapter, ChatMessage, ConsistencyConfig } from '@shared/types'
import { ShieldCheck, Play, Square, Loader2, BookText, FileText, Check, Copy } from 'lucide-react'
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
    { role: 'user', content: body }
  ]
}

export default function Consistency(): JSX.Element {
  const config = useStore((s) => s.config)!
  const settingDocs = useStore((s) => s.settingDocs)
  const novel = useStore((s) => s.novel)
  const currentWorldId = useStore((s) => s.currentWorldId)
  const allChapters: Chapter[] = useMemo(
    () => (novel?.volumes ?? []).flatMap((v) => v.chapters),
    [novel]
  )

  // 上次巡检结果按世界持久化到 localStorage,让刷新/切页不丢结果。
  // 只存报告文本本身;错误信息、进行中状态等瞬时态不持久化。
  const reportKey = currentWorldId ? `lorekeeper:consistency:report:${currentWorldId}` : null

  // 设定默认全选（人名/能力多在设定里），章节默认不选（长、按需加）
  const [selectedDocs, setSelectedDocs] = useState<Set<string>>(
    () => new Set(settingDocs.map((d) => d.id))
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
      allChapters
        .filter((c) => selectedChapters.has(c.id))
        .reduce((n, c) => n + c.wordCount, 0),
    [allChapters, selectedChapters]
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
        .map(async (d) => `# Codex: ${d.title}\n\n${(await window.api.readSetting(d.id)).content}`)
    )
    const chapterParts = Promise.all(
      allChapters
        .filter((c) => selectedChapters.has(c.id))
        .map(async (c) => `# Chapter: ${c.title}\n\n${await window.api.readChapter(c.file)}`)
    )
    return [...(await docParts), ...(await chapterParts)].join('\n\n---\n\n')
  }

  const run = async (): Promise<void> => {
    if (running || (selectedDocs.size === 0 && selectedChapters.size === 0)) return
    setRunning(true)
    setError('')
    setReport('')
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
        controller.signal
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
    }
  }

  const stop = (): void => {
    abortRef.current?.abort()
    setRunning(false)
  }

  const copyReport = async (): Promise<void> => {
    await navigator.clipboard.writeText(report)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="h-full flex">
      {/* 配置面板 */}
      <aside className="w-72 shrink-0 border-r border-ink-800 bg-ink-900 flex flex-col overflow-y-auto">
        <div className="px-4 py-3.5 border-b border-ink-800">
          <h2 className="text-sm font-semibold text-slate-800 flex items-center gap-2">
            <ShieldCheck size={16} /> Consistency Check
          </h2>
        </div>

        <div className="p-4 space-y-4">
          <p className="text-[11px] text-ink-500 leading-relaxed">
            Have the AI read the selected codex and chapters to catch contradictions in names, abilities, timeline, and more, with a severity-ranked list. The more focused the material, the more accurate the result.
          </p>

          {/* 设定文档 */}
          <div>
            <label className="text-xs text-ink-500 mb-1.5 flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <BookText size={13} /> Codex ({selectedDocs.size})
              </span>
              {settingDocs.length > 0 && (
                <button
                  onClick={() =>
                    setSelectedDocs((s) =>
                      s.size === settingDocs.length
                        ? new Set()
                        : new Set(settingDocs.map((d) => d.id))
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
              <div className="space-y-1 max-h-52 overflow-y-auto">
                {settingDocs.map((d) => (
                  <button
                    key={d.id}
                    disabled={running}
                    onClick={() => toggleDoc(d.id)}
                    className={clsx(
                      'w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left text-sm transition-colors',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-star-accent/40 focus-visible:ring-inset',
                      selectedDocs.has(d.id) ? 'bg-ink-700' : 'bg-ink-850 hover:bg-ink-800 opacity-70'
                    )}
                  >
                    <span className="flex-1 min-w-0 truncate text-slate-700">{d.title}</span>
                    {selectedDocs.has(d.id) && (
                      <Check size={13} className="text-star-success shrink-0" />
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 章节正文 */}
          <div>
            <label className="text-xs text-ink-500 mb-1.5 flex items-center gap-1.5">
              <FileText size={13} /> Chapters ({selectedChapters.size}/{MAX_CHAPTERS})
            </label>
            {allChapters.length === 0 ? (
              <p className="text-[11px] text-ink-500">No chapters yet.</p>
            ) : (
              <div className="space-y-1 max-h-52 overflow-y-auto">
                {allChapters.map((c) => {
                  const on = selectedChapters.has(c.id)
                  const full = !on && selectedChapters.size >= MAX_CHAPTERS
                  return (
                    <button
                      key={c.id}
                      disabled={running || full}
                      onClick={() => toggleChapter(c.id)}
                      className={clsx(
                        'w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left text-sm transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-star-accent/40 focus-visible:ring-inset',
                        on ? 'bg-ink-700' : 'bg-ink-850 hover:bg-ink-800 opacity-70',
                        full && 'opacity-40 cursor-not-allowed'
                      )}
                    >
                      <span className="flex-1 min-w-0 truncate text-slate-700">{c.title}</span>
                      {on && <Check size={13} className="text-star-success shrink-0" />}
                    </button>
                  )
                })}
              </div>
            )}
            {overBudget && (
              <p className="text-[11px] text-star-accent mt-1.5">
                Selected chapters total ~{chapterWords.toLocaleString()} words; too much may exceed the model context and reduce accuracy. Consider checking in batches.
              </p>
            )}
          </div>

          {!hasKey && (
            <p className="text-xs text-star-danger leading-relaxed">
              No AI provider configured yet. Add an API key under Settings first.
            </p>
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
        <div className="flex-1 overflow-y-auto px-6 py-6">
          <div className="max-w-3xl mx-auto">
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
                  <span className="inline-block w-1.5 h-4 bg-star-accent/60 animate-pulse align-middle" />
                )}
              </div>
            )}
            {running && !report && (
              <div className="flex items-center gap-2 text-ink-500 text-sm pt-24 justify-center">
                <Loader2 size={16} className="animate-spin" /> The agent is reading through…
              </div>
            )}
            {error && <div className="text-sm text-star-danger">{error}</div>}
          </div>
        </div>

        {report && !running && (
          <div className="shrink-0 border-t border-ink-800 bg-ink-900 px-6 py-3">
            <div className="max-w-3xl mx-auto flex justify-end">
              <button onClick={copyReport} className="btn btn-sm btn-secondary">
                {copied ? <Check size={14} className="text-star-success" /> : <Copy size={14} />}
                Copy report
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
