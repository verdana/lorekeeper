import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { useStore } from '../store'
import {
  runRound, summarize, mergeConclusion, proposalRound,
  regenerateSpeak, regenerateSummary, packContext, estimateTokens,
  selectRelevantDocs, type Proposal, type DocBrief
} from '../discussion'
import { formatTime, uid } from '../lib'
import { toastError, toastSuccess, parseAiError } from '../toast'
import type { Chapter, DiscussionMessage, DiscussionSession } from '@shared/types'
import { PROMPTS } from '@shared/prompts'
import {
  Play,
  Square,
  Users,
  Loader2,
  Check,
  FileText,
  Brain,
  Trash2,
  Send,
  ArrowRight,
  FileEdit,
  X,
  Copy,
  Type,
  Sparkles,
  Crosshair,
  RefreshCw,
  GripVertical
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkCjkFriendly from 'remark-cjk-friendly'
import clsx from 'clsx'
import EmptyState from '../components/EmptyState'

const MAX_CHAPTERS = 10

type Mode = 'diverge' | 'converge'

// Topic templates come from the active prompt locale pack (en / zh).
const DISCUSSION_TEMPLATES = PROMPTS.discussion.topicTemplates

export default function Discussion(): JSX.Element {
  const config = useStore((s) => s.config)!
  const personas = config.personas
  const settingDocs = useStore((s) => s.settingDocs)
  const refreshSettings = useStore((s) => s.refreshSettings)
  const novel = useStore((s) => s.novel)
  const currentWorldId = useStore((s) => s.currentWorldId)
  const allChapters: Chapter[] = (novel?.volumes ?? []).flatMap((v) => v.chapters)

  // 发言顺序按世界持久化到 localStorage：记住上次用的顺序，并扛住刷新/热重载。
  // 只是「上次顺序」的记忆，不入全局 personas 配置；每场讨论的顺序另存进会话存档。
  const orderKey = currentWorldId ? `lorekeeper:discussion:order:${currentWorldId}` : null

  // 把一份 id 列表对齐到当前 personas：保留已有次序、追加新人、剔除已删除者。
  const alignOrder = (ids: string[]): string[] => {
    const known = new Set(personas.map((p) => p.id))
    const kept = ids.filter((id) => known.has(id))
    const added = personas.filter((p) => !ids.includes(p.id)).map((p) => p.id)
    return [...kept, ...added]
  }

  const [topic, setTopic] = useState('')
  const [mode, setMode] = useState<Mode>('diverge')
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(personas.map((p) => p.id))
  )
  // 参与者的发言顺序（persona id 列表）。讨论组按此顺序依次发言，用户可拖动调整。
  // 懒初始化：从 localStorage 读回上次顺序（按世界），再对齐当前 personas。
  const [order, setOrder] = useState<string[]>(() => {
    if (!currentWorldId) return personas.map((p) => p.id)
    try {
      const saved = localStorage.getItem(`lorekeeper:discussion:order:${currentWorldId}`)
      const ids: string[] = saved ? JSON.parse(saved) : []
      const known = new Set(personas.map((p) => p.id))
      const kept = ids.filter((id) => known.has(id))
      const addedTail = personas.filter((p) => !ids.includes(p.id)).map((p) => p.id)
      return [...kept, ...addedTail]
    } catch {
      return personas.map((p) => p.id)
    }
  })
  const [dragId, setDragId] = useState<string | null>(null) // 正在拖动的 persona id
  const [selectedChapters, setSelectedChapters] = useState<Set<string>>(new Set())
  const [running, setRunning] = useState(false)
  const [started, setStarted] = useState(false) // 讨论是否已开始（决定按钮组与输入框显隐）
  const [round, setRound] = useState(0) // 已完成的发言轮次
  const [sessionId, setSessionId] = useState('')
  const [messages, setMessages] = useState<DiscussionMessage[]>([])
  const [conclusion, setConclusion] = useState<string | null>(null)
  const [userInput, setUserInput] = useState('') // 底部插话输入
  const [reasoning, setReasoning] = useState<Record<string, string>>({}) // 消息id → 思考过程（仅实时展示，不入正文/不存档）
  const [history, setHistory] = useState<DiscussionSession[]>([])
const [error, setError] = useState('')
const [contextInfo, setContextInfo] = useState<{ used: number; budget: number } | null>(null)
const [merge, setMerge] = useState<MergeState | null>(null) // 合并到设定的对话框状态
  // 收敛模式：提案清单与已锁定的深钻点
  const [proposals, setProposals] = useState<Proposal[] | null>(null)
  const [proposing, setProposing] = useState(false)
  const [focus, setFocus] = useState<string | null>(null)
const abortRef = useRef<AbortController>(undefined)
const scrollRef = useRef<HTMLDivElement>(null)
const stickRef = useRef(true) // 是否粘在底部：仅粘底时才自动跟随流式输出向下滚
const relevantDocIdsRef = useRef<Set<string> | null>(null) // Agent 自主选定的设定文档 ID 缓存
const CONTEXT_BUDGET = 48_000 // 上下文预算：48k tokens，预留空间给后续讨论内容

  const hasKey = config.ai.providers.some((p) => p.apiKey)

  useEffect(() => {
    window.api.listDiscussions().then(setHistory)
  }, [])

  // personas 增删后同步发言顺序：保留已有次序，追加新人，剔除已删除者。
  useEffect(() => {
    setOrder((prev) => {
      const next = alignOrder(prev)
      return next.length === prev.length && next.every((id, i) => id === prev[i]) ? prev : next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personas])

  // 顺序变化即落盘（按世界），记住上次用的顺序、并扛住刷新。
  useEffect(() => {
    if (!orderKey) return
    try {
      localStorage.setItem(orderKey, JSON.stringify(order))
    } catch {
      /* Ignore if storage unavailable; order falls back to in-memory. */
    }
  }, [order, orderKey])

  useEffect(() => {
    if (!stickRef.current) return
    const el = scrollRef.current
    el?.scrollTo({ top: el.scrollHeight })
  }, [messages, reasoning])

  // 记录用户是否贴在底部：一旦手动上翻即停止自动滚，滚回底部则恢复跟随
  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  const toggle = (id: string): void =>
    setSelected((s) => {
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

  // Context building: agents autonomously select relevant docs + trim by token budget.
  const buildContext = async (): Promise<string> => {
    const outline = await window.api.readOutline()

    // Agent 自主选择设定文档（仅第一轮触发，后续复用缓存）
    if (relevantDocIdsRef.current === null && orderedPersonas.length > 0) {
      const docs: DocBrief[] = settingDocs.map((d) => ({
        id: d.id,
        title: d.title,
        category: d.category
      }))
      const ids = await selectRelevantDocs({
        topic: topic.trim(),
        personas: orderedPersonas.filter((p) => selected.has(p.id)),
        docs
      })
      relevantDocIdsRef.current = new Set(ids)
    }

    // 加载选中的设定文档内容
    const settingContents: string[] = []
    const docSet = relevantDocIdsRef.current
    for (const doc of settingDocs) {
      if (docSet && !docSet.has(doc.id)) continue // Agent 未选中则跳过
      const { content } = await window.api.readSetting(doc.id)
      if (content.trim()) settingContents.push(`# Codex: ${doc.title}\n\n${content}`)
    }

    // 加载选中的章节内容
    const chapterContents: string[] = []
    for (const ch of allChapters.filter((c) => selectedChapters.has(c.id))) {
      const content = await window.api.readChapter(ch.file)
      if (content.trim()) chapterContents.push(`# Chapter: ${ch.title}\n\n${content}`)
    }

    // 按预算打包
    const packed = packContext({
      outline,
      settings: settingContents,
      chapters: chapterContents,
      budget: CONTEXT_BUDGET
    })

    // 更新 UI 指示器
    const used = estimateTokens(packed)
    setContextInfo({ used, budget: CONTEXT_BUDGET })

    return packed
  }

  // 流式钩子：把消息流推进 messages / reasoning 状态
  const hooks = (signal: AbortSignal) => ({
    onMessage: (m: DiscussionMessage) => setMessages((prev) => [...prev, m]),
    onContent: (id: string, delta: string) =>
      setMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, content: m.content + delta } : m))
      ),
    onReasoning: (id: string, delta: string) =>
      setReasoning((prev) => ({ ...prev, [id]: (prev[id] ?? '') + delta })),
    signal
  })

  // 按发言顺序排列的 personas；order 里可能有尚未同步的脏 id，故以 personas 为准解析。
  const orderedPersonas = order
    .map((id) => personas.find((p) => p.id === id))
    .filter((p): p is (typeof personas)[number] => !!p)

  const chosen = (): typeof personas => orderedPersonas.filter((p) => selected.has(p.id))

  // 拖动结束：把 dragId 移动到目标 id 之前，重排 order。
  const reorder = (targetId: string): void => {
    if (!dragId || dragId === targetId) return
    setOrder((prev) => {
      const next = prev.filter((id) => id !== dragId)
      const at = next.indexOf(targetId)
      if (at < 0) return prev
      next.splice(at, 0, dragId)
      return next
    })
  }

  // 保存当前会话（有结论时才存档，与原逻辑一致）
  // 保存/更新当前会话（同一 sessionId 覆盖）。结论可为 null——只讨论未总结也留档。
  const persist = async (
    id: string,
    msgs: DiscussionMessage[],
    conc: string | null,
    rnd: number
  ): Promise<void> => {
    if (msgs.filter((m) => m.personaId !== 'moderator').length === 0) return // 无实质发言不存
    const session: DiscussionSession = {
      id,
      topic: topic.trim(),
      personaIds: chosen().map((p) => p.id),
      rounds: rnd,
      messages: msgs,
      conclusion: conc,
      createdAt: Date.now()
    }
    await window.api.saveDiscussion(session)
    setHistory(await window.api.listDiscussions())
  }

  // 开始一场新讨论。发散模式：直接第一轮。收敛模式：先跑提案轮出清单，待用户选点再深钻。
  const start = async (): Promise<void> => {
    if (!topic.trim() || selected.size === 0 || running || proposing) return
    setError('')
    setMessages([])
    setReasoning({})
    setConclusion(null)
    setRound(0)
    setProposals(null)
    setFocus(null)
    relevantDocIdsRef.current = null // 清空 Agent 选档缓存，下一轮重新选择
    setContextInfo(null)
    const sid = uid('d_')
    setSessionId(sid)
    stickRef.current = true
    const controller = new AbortController()
    abortRef.current = controller

    if (mode === 'converge') {
      // 提案轮：每人各报一点，产出可点选清单
      setProposing(true)
      setStarted(true)
      try {
        const context = await buildContext()
        const list = await proposalRound({
          topic: topic.trim(),
          personas: chosen(),
          context: context || undefined,
          signal: controller.signal
        })
        if (!controller.signal.aborted) setProposals(list)
      } catch (e) {
        if (!controller.signal.aborted) {
          setError((e as Error).message)
          toastError(parseAiError(e))
        }
      } finally {
        setProposing(false)
      }
      return
    }

    // 发散模式：原逻辑不变
    setRunning(true)
    setStarted(true)
    try {
      const context = await buildContext()
      const added = await runRound({
        topic: topic.trim(),
        personas: chosen(),
        round: 1,
        context: context || undefined,
        prior: [],
        hooks: hooks(controller.signal)
      })
      if (!controller.signal.aborted) {
        setRound(1)
        await persist(sid, added, null, 1)
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

  // 收敛模式：选定一个点开始深钻（清单上的点或自定义输入）。清空上一个点的记录，focus 焊死。
  const pickFocus = async (point: string): Promise<void> => {
    const f = point.trim()
    if (!f || running) return
    setFocus(f)
    setRunning(true)
    setError('')
    setMessages([])
    setReasoning({})
    setConclusion(null)
    setRound(0)
    stickRef.current = true
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const context = await buildContext()
      const added = await runRound({
        topic: topic.trim(),
        personas: chosen(),
        round: 1,
        context: context || undefined,
        focus: f,
        prior: [],
        hooks: hooks(controller.signal)
      })
      if (!controller.signal.aborted) {
        setRound(1)
        await persist(sessionId, added, null, 1)
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

  // 继续讨论：可携带我的插话；Agent 下一轮都能看到它
  const continueRound = async (): Promise<void> => {
    if (running || selected.size === 0) return
    setRunning(true)
    setError('')
    setConclusion(null) // 继续讨论后旧结论作废，需重新总结
    stickRef.current = true
    const controller = new AbortController()
    abortRef.current = controller

    // 先把用户插话作为一条消息落入记录（Agent 立即可见）
    let prior = messages
    const note = userInput.trim()
    if (note) {
      const userMsg: DiscussionMessage = {
        id: uid('m_'),
        personaId: 'user',
        personaName: 'You',
        content: note,
        round: round + 1,
        ts: Date.now()
      }
      prior = [...messages, userMsg]
      setMessages(prior)
      setUserInput('')
    }

    try {
      const context = await buildContext()
      const added = await runRound({
        topic: topic.trim(),
        personas: chosen(),
        round: round + 1,
        context: context || undefined,
        focus: focus ?? undefined,
        prior,
        hooks: hooks(controller.signal)
      })
      if (!controller.signal.aborted) {
        const nextRound = round + 1
        setRound(nextRound)
        await persist(sessionId, [...prior, ...added], null, nextRound)
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

  // 生成总结：主持人综合全部记录，得出结论并存档
  const doSummarize = async (): Promise<void> => {
    if (running) return
    setRunning(true)
    setError('')
    stickRef.current = true
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const transcript = messages.filter((m) => m.personaId !== 'moderator')
      const concMsg = await summarize({
        topic: topic.trim(),
        transcript,
        focus: focus ?? undefined,
        providerId: chosen()[0]?.providerId,
        hooks: hooks(controller.signal)
      })
      if (!controller.signal.aborted && concMsg.content) {
        setConclusion(concMsg.content)
        const finalMsgs = [...messages, concMsg]
        setMessages(finalMsgs)
        await persist(sessionId, finalMsgs, concMsg.content, round)
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

  // 重新生成某条发言：就地覆写同一 message id，不新增消息、不动前后其它消息。
  // 与生成流程一致，同样走 persist 落盘。
  const regenerate = async (targetId: string): Promise<void> => {
    if (running) return
    const idx = messages.findIndex((m) => m.id === targetId)
    if (idx < 0) return
    const target = messages[idx]
    const isSummary = target.personaId === 'moderator'
    const persona = isSummary ? null : chosen().find((p) => p.id === target.personaId)
    if (!isSummary && !persona) {
      setError('This persona is no longer in the participants list; cannot regenerate.')
      return
    }

    setRunning(true)
    setError('')
    stickRef.current = true
    const controller = new AbortController()
    abortRef.current = controller

    // 清空目标消息的正文与已展示的思考，供流式覆写
    const cleared: DiscussionMessage = { ...target, content: '', ts: Date.now() }
    const nextMessages = [...messages.slice(0, idx), cleared, ...messages.slice(idx + 1)]
    setMessages(nextMessages)
    setReasoning((prev) => {
      if (!(targetId in prev)) return prev
      const n = { ...prev }
      delete n[targetId]
      return n
    })
    // 若重生成的是总结，旧的 conclusion 状态也一并作废、等新版落定后再回填
    if (isSummary) setConclusion(null)

    const streamHooks = {
      onContent: (id: string, delta: string) =>
        setMessages((prev) =>
          prev.map((m) => (m.id === id ? { ...m, content: m.content + delta } : m))
        ),
      onReasoning: (id: string, delta: string) =>
        setReasoning((prev) => ({ ...prev, [id]: (prev[id] ?? '') + delta })),
      signal: controller.signal
    }

    try {
      const context = await buildContext()
      if (isSummary) {
        // 总结：以当前所有非主持人消息为素材重跑
        const transcript = nextMessages.filter((m) => m.personaId !== 'moderator')
        await regenerateSummary({
          topic: topic.trim(),
          transcript,
          focus: focus ?? undefined,
          providerId: chosen()[0]?.providerId,
          target: cleared,
          hooks: streamHooks
        })
      } else {
        // 发言：拼 prompt 时只喂目标消息之前的记录，与首次生成时的上下文一致
        await regenerateSpeak({
          topic: topic.trim(),
          persona: persona!,
          round: target.round,
          context: context || undefined,
          focus: focus ?? undefined,
          prior: nextMessages.slice(0, idx),
          target: cleared,
          hooks: streamHooks
        })
      }
      if (!controller.signal.aborted && cleared.content) {
        // regenerate* 已把最终 content 写回 cleared,同步进 messages 再持久化
        const finalMessages = nextMessages.map((m) =>
          m.id === targetId ? { ...m, content: cleared.content } : m
        )
        setMessages(finalMessages)
        if (isSummary) setConclusion(cleared.content)
        const conc = finalMessages.find((m) => m.personaId === 'moderator')?.content ?? null
        await persist(sessionId, finalMessages, conc, round)
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

  const loadSession = (s: DiscussionSession): void => {
    stop()
    setTopic(s.topic)
    setSelected(new Set(s.personaIds))
    // 恢复该会话的发言顺序：已存在的 persona 按存档次序在前，其余追加在后。
    setOrder((prev) => [
      ...s.personaIds.filter((id) => personas.some((p) => p.id === id)),
      ...prev.filter((id) => !s.personaIds.includes(id))
    ])
    setMessages(s.messages)
    setConclusion(s.conclusion)
    setSessionId(s.id)
    setRound(Math.max(0, ...s.messages.map((m) => (m.personaId === 'moderator' ? 0 : m.round))))
    setStarted(true)
    setMode('diverge')
    setReasoning({})
    setError('')
  }

  const deleteSession = async (id: string): Promise<void> => {
    await window.api.deleteDiscussion(id)
    setHistory(await window.api.listDiscussions())
  }

  const colorOf = (personaId: string): string =>
    personas.find((p) => p.id === personaId)?.color ?? '#A89676'

  const exportTranscript = (): void => {
    const msgs = messages
    if (msgs.length === 0) return

    const lines: string[] = [
      `# Writers' Room — ${topic}`,
      `**Date**: ${formatTime(Date.now())}  `,
      `**Personas**: ${chosen().map((p) => p.name).join(', ')}  `,
      `**Rounds**: ${round}  `,
      conclusion ? `**Conclusion**: included below  \n` : '',
      '',
      '---',
      ''
    ]

    for (const m of msgs) {
      if (m.personaId === 'moderator') {
        lines.push(`## 📋 Moderator — Summary\n`)
      } else {
        const c = colorOf(m.personaId)
        lines.push(`### ${m.personaName} _(Round ${m.round})_  `)
      }
      lines.push('', m.content, '', '---', '')
    }

    if (conclusion) {
      lines.push('', '## Conclusion', '', conclusion, '')
    }

    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `writers-room-${topic.slice(0, 40).replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '_')}.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="h-full flex">
      {/* 配置面板 */}
      <aside className="w-72 shrink-0 border-r border-ink-800 bg-ink-900 flex flex-col overflow-y-auto">
        <div className="px-4 py-3.5 border-b border-ink-800">
          <h2 className="text-sm font-semibold text-slate-800 flex items-center gap-2">
            <Users size={16} /> Writers Room
          </h2>
        </div>

        <div className="p-4 space-y-4">
          <div>
            <label className="block text-xs text-ink-500 mb-1.5">Mode</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setMode('diverge')}
                disabled={running || started}
                className={clsx(
                  'flex flex-col items-start gap-0.5 px-3 py-2 rounded-md text-left transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-star-gold/40 focus-visible:ring-inset',
                  mode === 'diverge'
                    ? 'bg-ink-700 border border-star-gold/40'
                    : 'bg-ink-850 hover:bg-ink-800 opacity-70'
                )}
              >
                <span className="flex items-center gap-1.5 text-sm text-slate-800">
                  <Sparkles size={13} /> Diverge
                </span>
                <span className="text-[11px] text-ink-500">Give me lots of angles</span>
              </button>
              <button
                onClick={() => setMode('converge')}
                disabled={running || started}
                className={clsx(
                  'flex flex-col items-start gap-0.5 px-3 py-2 rounded-md text-left transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-star-gold/40 focus-visible:ring-inset',
                  mode === 'converge'
                    ? 'bg-ink-700 border border-star-gold/40'
                    : 'bg-ink-850 hover:bg-ink-800 opacity-70'
                )}
              >
                <span className="flex items-center gap-1.5 text-sm text-slate-800">
                  <Crosshair size={13} /> Converge
                </span>
                <span className="text-[11px] text-ink-500">Drill one point, tight</span>
              </button>
            </div>
          </div>

          <div>
            <label className="block text-xs text-ink-500 mb-1.5 flex items-center gap-1.5">
              <FileText size={13} /> Topic templates
            </label>
            <div className="flex flex-wrap gap-1.5 mb-3">
              {DISCUSSION_TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTopic(t.prompt)}
                  className={clsx(
                    'px-2.5 py-1 rounded-md text-[11px] transition-colors border',
                    topic === t.prompt
                      ? 'bg-star-gold/10 border-star-gold/30 text-star-gold'
                      : 'bg-ink-850 border-ink-800 text-ink-500 hover:text-slate-700 hover:border-ink-700'
                  )}
                  title={t.prompt}
                >
                  {t.icon} {t.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs text-ink-500 mb-1.5">Topic</label>
            <textarea
              className="textarea min-h-30 text-sm"
              placeholder="Describe what you want the personas to discuss…"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              disabled={running || started}
            />
          </div>

          <div>
            <label className="block text-xs text-ink-500 mb-1.5">
              Participants ({selected.size})
            </label>
            <div className="space-y-1.5">
              {orderedPersonas.map((p) => {
                const on = selected.has(p.id)
                // 发言序号：仅选中者有，按当前顺序在选中集合中的位次。
                const speakIndex = on
                  ? chosen().findIndex((c) => c.id === p.id) + 1
                  : 0
                return (
                  <div
                    key={p.id}
                    draggable={!running}
                    onDragStart={() => setDragId(p.id)}
                    onDragEnd={() => setDragId(null)}
                    onDragOver={(e) => {
                      e.preventDefault()
                      reorder(p.id)
                    }}
                    className={clsx(
                      'group w-full flex items-center gap-1.5 px-2 py-2 rounded-md text-left transition-colors',
                      on ? 'bg-ink-700' : 'bg-ink-850 hover:bg-ink-800 opacity-70',
                      dragId === p.id && 'opacity-40',
                      !running && 'cursor-grab active:cursor-grabbing'
                    )}
                  >
                    <GripVertical
                      size={14}
                      className={clsx(
                        'shrink-0 text-ink-500',
                        running ? 'opacity-30' : 'opacity-40 group-hover:opacity-100'
                      )}
                    />
                    <button
                      disabled={running}
                      onClick={() => toggle(p.id)}
                      className="flex-1 min-w-0 flex items-center gap-2.5 text-left focus-visible:outline-none"
                    >
                      <span
                        className="w-6 h-6 rounded-full shrink-0 flex items-center justify-center text-[11px] font-bold text-white"
                        style={{ background: p.color }}
                      >
                        {p.name.slice(0, 1)}
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm text-slate-800 truncate">{p.name}</span>
                        <span className="block text-[11px] text-ink-500 truncate">{p.role}</span>
                      </span>
                      {on ? (
                        <span
                          className="shrink-0 w-5 h-5 rounded-full bg-star-copper/15 text-star-copper text-[11px] font-semibold flex items-center justify-center"
                          title={`Speaks #${speakIndex}`}
                        >
                          {speakIndex}
                        </span>
                      ) : (
                        <span className="shrink-0 w-5 h-5" />
                      )}
                    </button>
                  </div>
                )
              })}
            </div>
            <p className="text-[11px] text-ink-500 mt-2">
              Drag to set who speaks first. Manage personas under Settings.
            </p>
          </div>

          {/* 章节正文参考 */}
          <div>
            <label className="text-xs text-ink-500 mb-1.5 flex items-center gap-1.5">
              <FileText size={13} /> Chapter references ({selectedChapters.size}/{MAX_CHAPTERS})
            </label>
            {allChapters.length === 0 ? (
              <p className="text-[11px] text-ink-500">No chapters yet.</p>
            ) : (
              <div className="space-y-1 max-h-40 overflow-y-auto">
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
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-star-gold/40 focus-visible:ring-inset',
                        on ? 'bg-ink-700' : 'bg-ink-850 hover:bg-ink-800 opacity-70',
                        full && 'opacity-40 cursor-not-allowed'
                      )}
                    >
                      <span className="flex-1 min-w-0 truncate text-slate-700">{c.title}</span>
                      {on && <Check size={13} className="text-star-copper shrink-0" />}
                    </button>
                  )
                })}
              </div>
            )}
            {selectedChapters.size >= MAX_CHAPTERS && (
              <p className="text-[11px] text-star-gold mt-1.5">Up to {MAX_CHAPTERS} chapters.</p>
            )}

            {/* 上下文预算指示器 */}
            {contextInfo && (
              <div className="mt-2 pt-2 border-t border-ink-800">
                <div className="flex items-center justify-between text-[11px] text-ink-500 mb-1">
                  <span>Context budget</span>
                  <span>{(contextInfo.used / 1000).toFixed(1)}k / {(contextInfo.budget / 1000).toFixed(0)}k tokens</span>
                </div>
                <div className="h-1.5 rounded-full bg-ink-800 overflow-hidden">
                  <div
                    className={clsx(
                      'h-full rounded-full transition-all duration-300',
                      contextInfo.used > contextInfo.budget * 0.9
                        ? 'bg-star-iron'
                        : contextInfo.used > contextInfo.budget * 0.7
                          ? 'bg-star-gold'
                          : 'bg-star-copper'
                    )}
                    style={{ width: `${Math.min(100, (contextInfo.used / contextInfo.budget) * 100)}%` }}
                  />
                </div>
              </div>
            )}
          </div>

          {!hasKey && (
            <p className="text-xs text-star-iron leading-relaxed">
              No AI provider configured yet. Add an API key under Settings first.
            </p>
          )}

          {!started ? (
            <button
              onClick={start}
              disabled={!hasKey || !topic.trim() || selected.size === 0}
              className="w-full btn btn-primary"
            >
              <Play size={15} /> Start discussion
            </button>
          ) : (
            <button
              onClick={() => {
                stop()
                setStarted(false)
                setMessages([])
                setReasoning({})
                setConclusion(null)
                setRound(0)
                setProposals(null)
                setFocus(null)
              }}
              disabled={running}
              className="w-full btn btn-secondary"
            >
              New discussion
            </button>
          )}
        </div>

        {/* 历史 */}
        {history.length > 0 && (
          <div className="border-t border-ink-800 p-3">
            <div className="text-xs text-ink-500 mb-2 px-1">History</div>
            <div className="space-y-1">
              {history.map((s) => (
                <div
                  key={s.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => loadSession(s)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      loadSession(s)
                    }
                  }}
                  className={clsx(
                    'group w-full flex items-center gap-2 text-left px-3 py-2 rounded-md transition-colors cursor-pointer',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-star-gold/40 focus-visible:ring-inset',
                    sessionId === s.id
                      ? 'bg-ink-700 text-slate-900'
                      : 'hover:bg-ink-800'
                  )}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-slate-700 truncate">{s.topic}</div>
                    <div className="text-[11px] text-ink-500 flex items-center gap-1.5">
                      {formatTime(s.createdAt)}
                      {s.conclusion && <span className="text-star-copper">· summarized</span>}
                    </div>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      deleteSession(s.id)
                    }}
                    title="Delete this discussion"
                    className="icon-btn shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-star-iron"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </aside>

      {/* 讨论区 */}
      <div className="flex-1 min-w-0 flex flex-col">
        <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto px-6 py-6">
          {messages.length === 0 && !running && !proposing && !proposals && !focus && (
            <EmptyState
              icon={Users}
              title="Convene the writers' room"
              description="Set a topic, pick your personas, and let them workshop your story."
            />
          )}

          <div className="max-w-4xl mx-auto space-y-5">
            {/* 收敛模式：提案清单(选点前) 或 焊死的 focus 横幅(选点后) */}
            {mode === 'converge' && started && (
              <ConvergeHeader
                proposing={proposing}
                proposals={proposals}
                focus={focus}
                running={running}
                onPick={pickFocus}
                onBackToProposals={() => {
                  stop()
                  setFocus(null)
                  setMessages([])
                  setReasoning({})
                  setConclusion(null)
                  setRound(0)
                }}
              />
            )}
            {messages.map((m) => {
              const isConclusion = m.personaId === 'moderator'
              const isUser = m.personaId === 'user'
              return (
                <div key={m.id} className={clsx('flex gap-3', isConclusion && 'mt-8')}>
                  <span
                    className="w-9 h-9 rounded-full shrink-0 flex items-center justify-center text-xs font-bold text-white"
                    style={{
                      background: isConclusion ? '#7A5C4E' : isUser ? '#3B2F24' : colorOf(m.personaId)
                    }}
                  >
                    {m.personaName.slice(0, 1)}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 mb-1">
                      <span className="text-sm font-medium text-slate-800">{m.personaName}</span>
                      {!isConclusion && !isUser && (
                        <span className="text-[11px] text-ink-500">Round {m.round}</span>
                      )}
                      {isUser && <span className="text-[11px] text-star-gold">Your note</span>}
                    </div>
                    <div
                      className={clsx(
                        'markdown-body text-sm rounded-lg px-4 py-3',
                        isConclusion ? 'msg-conclusion' : isUser ? 'msg-user' : 'msg-persona'
                      )}
                    >
                      {reasoning[m.id] && (
                        <ReasoningBlock text={reasoning[m.id]} done={!!m.content} />
                      )}
                      {m.content ? (
                        <ReactMarkdown remarkPlugins={[remarkGfm, remarkCjkFriendly]}>{replaceLatexMath(m.content)}</ReactMarkdown>
                      ) : (
                        !reasoning[m.id] && <Loader2 size={14} className="animate-spin text-ink-500" />
                      )}
                    </div>
                    {!isUser && m.content && (
                      <div className="flex items-center gap-1 mt-1.5 flex-wrap">
                        <CopyButtons text={replaceLatexMath(m.content)} />
                        <button
                          onClick={() => regenerate(m.id)}
                          disabled={running}
                          title={isConclusion ? 'Regenerate this summary' : 'Regenerate this reply'}
                          className="icon-btn gap-1 px-2 text-[11px] hover:text-slate-700 hover:bg-ink-850 disabled:opacity-40"
                        >
                          <RefreshCw size={12} />
                          Regenerate
                        </button>
                      </div>
                    )}
                    {isConclusion && m.content && !running && (
                      <button
                        onClick={() => openMerge(m.content)}
                        className="mt-2 btn btn-secondary btn-sm"
                      >
                        <FileEdit size={14} /> Merge into codex
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
            {running && (
              <div className="flex items-center gap-2 text-ink-500 text-sm pl-12">
                <Loader2 size={15} className="animate-spin" /> A persona is thinking…
              </div>
            )}
            {error && <div className="text-sm text-star-iron pl-12">{error}</div>}
          </div>
        </div>

        {/* 底部交互条：插话 + 继续 / 总结 / 停止 */}
        {started && (mode === 'diverge' || focus) && (
          <div className="shrink-0 border-t border-ink-800 bg-ink-900 px-6 py-3">
            <div className="max-w-3xl mx-auto flex items-stretch gap-2">
              <textarea
                className="textarea max-h-32 text-sm flex-1"
                placeholder="Jump in as yourself to steer the next round (optional — leave blank to just continue)…"
                value={userInput}
                onChange={(e) => setUserInput(e.target.value)}
                disabled={running}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault()
                    continueRound()
                  }
                }}
              />
              {running ? (
                <button onClick={stop} className="btn btn-danger shrink-0">
                  <Square size={15} /> Stop
                </button>
              ) : (
                <div className="flex flex-col gap-2 shrink-0">
                  <button
                    onClick={continueRound}
                    disabled={selected.size === 0}
                    className="btn btn-primary"
                    title="Have the personas discuss another round based on the current transcript (including your note)"
                  >
                    {userInput.trim() ? <Send size={15} /> : <ArrowRight size={15} />} Continue
                  </button>
                  <button
                    onClick={doSummarize}
                    disabled={messages.filter((m) => m.personaId !== 'moderator').length === 0 || !!conclusion}
                    className="btn btn-secondary btn-sm"
                    title="Have the moderator synthesize the whole discussion into a conclusion"
                  >
                    <Check size={14} /> Summarize
                  </button>
                  {messages.filter((m) => m.personaId !== 'moderator').length > 0 && (
                    <button
                      onClick={exportTranscript}
                      className="btn btn-ghost btn-sm text-ink-500"
                      title="Export the full transcript as Markdown"
                    >
                      <FileText size={13} /> Export
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {merge && (
        <MergeDialog
          state={merge}
          setState={setMerge}
          onDone={() => {
            setMerge(null)
            refreshSettings()
          }}
        />
      )}
    </div>
  )

  // 打开「合并到设定」对话框。合并是机械改写、不需要推理，故默认用当前激活的 provider，
  // 而非讨论 Agent 绑定的模型（那可能是推理模型，会把预算耗在思考上、正文缩水）。
  function openMerge(conc: string): void {
    setMerge({
      conclusion: conc,
      topic: topic.trim(),
      docId: settingDocs[0]?.id ?? '',
      providerId: config.ai.activeProviderId ?? config.ai.providers[0]?.id,
      original: '',
      merged: '',
      phase: 'pick'
    })
  }
}

// ============ 合并到设定：对话框 ============

interface MergeState {
  conclusion: string
  topic: string
  docId: string
  providerId?: string
  original: string
  merged: string
  phase: 'pick' | 'generating' | 'preview'
}

function MergeDialog({
  state,
  setState,
  onDone
}: {
  state: MergeState
  setState: Dispatch<SetStateAction<MergeState | null>>
  onDone: () => void
}): JSX.Element {
  const settingDocs = useStore((s) => s.settingDocs)
  const providers = useStore((s) => s.config)!.ai.providers
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const abortRef = useRef<AbortController>(undefined)

  const doc = settingDocs.find((d) => d.id === state.docId)

  const generate = async (): Promise<void> => {
    if (!doc) return
    setError('')
    const controller = new AbortController()
    abortRef.current = controller
    const MAX_TRY = 3 // 首次 + 2 次重试，应对偶发失败/空返回
    try {
      const { content: original } = await window.api.readSetting(doc.id)
      let merged = ''
      let lastErr = ''
      for (let attempt = 1; attempt <= MAX_TRY; attempt++) {
        if (controller.signal.aborted) return
        // 每次尝试前清空预览，避免拼上一次的残缺输出
        let acc = ''
        setState({
          ...state,
          original,
          merged: '',
          phase: 'generating'
        })
        try {
          merged = await mergeConclusion({
            title: doc.title,
            original,
            topic: state.topic,
            conclusion: state.conclusion,
            providerId: state.providerId,
            onDelta: (delta) => {
              acc += delta
              setState((prev) => (prev ? { ...prev, merged: acc } : prev))
            },
            signal: controller.signal
          })
        } catch (e) {
          if (controller.signal.aborted) return
          lastErr = (e as Error).message
          merged = ''
        }
        if (merged.trim()) break // 成功拿到正文
        if (attempt < MAX_TRY) setError(`Attempt ${attempt} was empty or failed, retrying…`)
      }
      if (controller.signal.aborted) return
      if (!merged.trim()) {
        setError(
          lastErr ||
            'The AI repeatedly returned no merged text (the selected model may have put the content into its reasoning). Please retry, or switch to a non-reasoning model in Settings.'
        )
        toastError(lastErr || 'Merge failed — the AI returned no text.')
        setState({ ...state, original, phase: 'pick' })
        return
      }
      setError('')
      setState({ ...state, original, merged, phase: 'preview' })
    } catch (e) {
      if (!controller.signal.aborted) {
        setError((e as Error).message)
        toastError(parseAiError(e))
        setState({ ...state, phase: 'pick' })
      }
    }
  }

  const confirmWrite = async (): Promise<void> => {
    if (!doc) return
    setSaving(true)
    try {
      await window.api.writeSetting(doc.id, state.merged)
      onDone()
      toastSuccess(`Merged into "${doc.title}".`)
    } catch (e) {
      setError((e as Error).message)
      toastError('Failed to write merged document.')
      setSaving(false)
    }
  }

  const close = (): void => {
    abortRef.current?.abort()
    setState(null)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-6">
      <div
        className="rounded-lg border border-ink-800 w-full max-w-5xl max-h-[88vh] flex flex-col"
        style={{
          background: 'var(--surface-raised)',
          boxShadow: 'var(--shadow-warm-lg)'
        }}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-ink-800">
          <h3 className="text-sm font-semibold text-slate-800 flex items-center gap-2">
            <FileEdit size={16} /> Merge conclusion into codex
          </h3>
          <button onClick={close} className="icon-btn hover:text-slate-700" title="Close">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {state.phase === 'pick' && (
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-ink-500 mb-1.5">Codex document to update</label>
                {settingDocs.length === 0 ? (
                  <p className="text-sm text-ink-500">No codex documents yet — create one under Codex first.</p>
                ) : (
                  <select
                    className="input"
                    value={state.docId}
                    onChange={(e) => setState({ ...state, docId: e.target.value })}
                  >
                    {settingDocs.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.title}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <div>
                <label className="block text-xs text-ink-500 mb-1.5">Model for merging</label>
                <select
                  className="input"
                  value={state.providerId ?? ''}
                  onChange={(e) => setState({ ...state, providerId: e.target.value })}
                >
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · {p.model}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-ink-500 mt-1.5">
                  Merging rewrites the full text per the conclusion, so a <b>non-reasoning model</b> is recommended — a reasoning model spends its budget thinking and leaves the text incomplete.
                </p>
              </div>
              <div>
                <label className="block text-xs text-ink-500 mb-1.5">Conclusion to merge</label>
                <div className="markdown-body text-sm bg-ink-900 rounded-md px-4 py-3 max-h-64 overflow-y-auto">
                  <ReactMarkdown remarkPlugins={[remarkGfm, remarkCjkFriendly]}>{replaceLatexMath(state.conclusion)}</ReactMarkdown>
                </div>
              </div>
              {error && <div className="text-sm text-star-iron">{error}</div>}
            </div>
          )}

          {(state.phase === 'generating' || state.phase === 'preview') && (
            <div className="grid grid-cols-2 gap-4 h-full">
              <div className="flex flex-col min-h-0">
                <div className="text-xs text-ink-500 mb-1.5">Original</div>
                <pre className="flex-1 overflow-y-auto text-[13px] leading-relaxed text-slate-600 bg-ink-900 rounded-md p-3 whitespace-pre-wrap font-sans">
                  {state.original || '(this document is currently empty)'}
                </pre>
              </div>
              <div className="flex flex-col min-h-0">
                <div className="text-xs text-star-copper mb-1.5 flex items-center gap-1.5">
                  Merged (new version)
                  {state.phase === 'generating' && (
                    <Loader2 size={12} className="animate-spin" />
                  )}
                </div>
                <pre className="flex-1 overflow-y-auto text-[13px] leading-relaxed text-slate-800 bg-star-gold/5 border border-star-gold/20 rounded-md p-3 whitespace-pre-wrap font-sans">
                  {state.merged}
                  {state.phase === 'generating' && (
                    <span className="inline-block w-1.5 h-4 bg-star-gold/60 animate-pulse align-middle" />
                  )}
                </pre>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-ink-800">
          {error && state.phase !== 'pick' && (
            <span className="text-sm text-star-iron mr-auto">{error}</span>
          )}
          <button onClick={close} className="btn btn-ghost btn-sm">
            Cancel
          </button>
          {state.phase === 'pick' && (
            <button
              onClick={generate}
              disabled={!doc}
              className="btn btn-primary btn-sm"
            >
              <ArrowRight size={14} /> Generate preview
            </button>
          )}
          {state.phase === 'preview' && (
            <>
              <button
                onClick={() => setState({ ...state, phase: 'pick', merged: '' })}
                className="btn btn-secondary btn-sm"
              >
                Regenerate
              </button>
              <button onClick={confirmWrite} disabled={saving} className="btn btn-primary btn-sm">
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                Write to {doc?.title}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * 收敛模式的顶栏：先Render.提案清单(可点选深钻),选定后切换为焊死的 focus 横幅。
 * 与消息列表并列在滚动区顶部,不占底部输入条位置。
 */
function ConvergeHeader({
  proposing,
  proposals,
  focus,
  running,
  onPick,
  onBackToProposals
}: {
  proposing: boolean
  proposals: Proposal[] | null
  focus: string | null
  running: boolean
  onPick: (point: string) => void
  onBackToProposals: () => void
}): JSX.Element | null {
  const [custom, setCustom] = useState('')

  // 已锁定深钻点：横幅 + 可回到清单
  if (focus) {
    return (
      <div className="flex items-start gap-3 px-4 py-3 rounded-md bg-star-gold/5 border border-star-gold/30 mb-2">
        <Crosshair size={16} className="text-star-gold shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-[11px] text-star-gold uppercase tracking-wider mb-0.5">Focus</div>
          <div className="text-sm text-slate-800">{focus}</div>
        </div>
        {proposals && proposals.length > 0 && (
          <button
            onClick={onBackToProposals}
            disabled={running}
            className="btn btn-ghost btn-sm shrink-0"
            title="Discard this drill-down and pick another point"
          >
            Pick another
          </button>
        )}
      </div>
    )
  }

  // 提案生成中
  if (proposing) {
    return (
      <div className="flex items-center gap-2 text-ink-500 text-sm px-4 py-3">
        <Loader2 size={15} className="animate-spin" />
        Each persona is naming the one point they'd most want to drill…
      </div>
    )
  }

  // 提案已就绪:可点选清单 + 自定义输入
  if (proposals) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-xs text-ink-500 px-1">
          <Crosshair size={13} />
          Pick one point to drill. The others get set aside.
        </div>
        <div className="space-y-1.5">
          {proposals.map((p) => (
            <button
              key={p.personaId}
              onClick={() => onPick(p.reason ? `${p.point} — ${p.reason}` : p.point)}
              disabled={running}
              className="w-full flex items-start gap-3 px-4 py-3 rounded-md text-left bg-ink-900 hover:bg-ink-800 border border-transparent hover:border-star-gold/30 transition-colors group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-star-gold/40 focus-visible:ring-inset"
            >
              <span className="text-[11px] text-ink-500 shrink-0 mt-0.5 w-20 truncate">
                {p.personaName}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-sm text-slate-800">{p.point}</span>
                {p.reason && (
                  <span className="block text-[12px] text-ink-500 mt-0.5">{p.reason}</span>
                )}
              </span>
              <ArrowRight
                size={14}
                className="text-ink-500 group-hover:text-star-gold shrink-0 mt-1"
              />
            </button>
          ))}
        </div>
        <div className="flex items-stretch gap-2 pt-1">
          <input
            className="input flex-1 text-sm"
            placeholder="Or type your own point to drill…"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            disabled={running}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && custom.trim()) onPick(custom.trim())
            }}
          />
          <button
            onClick={() => custom.trim() && onPick(custom.trim())}
            disabled={running || !custom.trim()}
            className="btn btn-primary btn-sm shrink-0"
          >
            <ArrowRight size={14} /> Drill
          </button>
        </div>
      </div>
    )
  }

  return null
}

/**
 * 发言正文的复制按钮组：一个复制 Markdown 原文，一个复制去掉标记的纯文本。
 * 只作用于正文，不含思考过程。复制成功后短暂显示对勾反馈。
 * 输出为 fragment，交给父容器统一管布局（与 Regenerate 按钮并排）。
 */
function CopyButtons({ text }: { text: string }): JSX.Element {
  const [copied, setCopied] = useState<'md' | 'txt' | null>(null)

  const copy = async (kind: 'md' | 'txt'): Promise<void> => {
    const payload = kind === 'md' ? text : stripMarkdown(text)
    await navigator.clipboard.writeText(payload)
    setCopied(kind)
    setTimeout(() => setCopied(null), 1500)
  }

  return (
    <>
      <button
        onClick={() => copy('txt')}
        title="Copy as plain text (Markdown stripped)"
        className="icon-btn gap-1 px-2 text-[11px] hover:text-slate-700 hover:bg-ink-850"
      >
        {copied === 'txt' ? <Check size={12} className="text-star-copper" /> : <Type size={12} />}
        Plain text
      </button>
      <button
        onClick={() => copy('md')}
        title="Copy Markdown source"
        className="icon-btn gap-1 px-2 text-[11px] hover:text-slate-700 hover:bg-ink-850"
      >
        {copied === 'md' ? <Check size={12} className="text-star-copper" /> : <Copy size={12} />}
        Markdown
      </button>
    </>
  )
}

/**
 * 把 LLM 输出的 LaTeX 数学符号转成对应的 Unicode 字符。
 * 推理模型常输出 $\rightarrow$ 之类，ReactMarkdown 不认识它。
 */
function replaceLatexMath(text: string): string {
  return text
    .replace(/\$\\rightarrow\$/g, '→')
    .replace(/\$\\to\$/g, '→')
    .replace(/\$\\leftarrow\$/g, '←')
    .replace(/\$\\Rightarrow\$/g, '⇒')
    .replace(/\$\\Leftarrow\$/g, '⇐')
    .replace(/\$\\leftrightarrow\$/g, '↔')
    .replace(/\$\\longrightarrow\$/g, '⟶')
    .replace(/\$\\longleftarrow\$/g, '⟵')
    .replace(/\$\\implies\$/g, '⟹')
    .replace(/\$\\iff\$/g, '⟺')
}

/** 把常见 Markdown 标记剥成纯文本（用于复制）。够用即可，不追求完备解析。 */
function stripMarkdown(md: string): string {
  return md
    .replace(/^\s*```.*$/gm, '') // 代码块围栏行
    .replace(/`([^`]+)`/g, '$1') // 行内代码
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // 图片留 alt
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // 链接留文字
    .replace(/^#{1,6}\s+/gm, '') // 标题符号
    .replace(/^\s*>\s?/gm, '') // 引用符号
    .replace(/^\s*([-*+])\s+/gm, '') // 无序列表符号
    .replace(/(\*\*|__)(.*?)\1/g, '$2') // 粗体
    .replace(/(\*|_)(.*?)\1/g, '$2') // 斜体
    .replace(/~~(.*?)~~/g, '$1') // 删除线
    .replace(/^\s*[-*_]{3,}\s*$/gm, '') // 分隔线
    .replace(/\n{3,}/g, '\n\n') // 收敛多余空行
    .trim()
}

/**
 * 思考文本仅实时展示，不并入正文、不随会话存档。
 */
function ReasoningBlock({ text, done }: { text: string; done: boolean }): JSX.Element {
  return (
    <details open={!done} className="mb-2 group">
      <summary className="flex items-center gap-1.5 cursor-pointer text-[11px] text-ink-500 hover:text-slate-600 select-none list-none">
        <Brain size={12} className={clsx(!done && 'animate-pulse text-star-copper')} />
        {done ? 'View reasoning' : 'Thinking…'}
      </summary>
      <div className="mt-1.5 pl-3 border-l-2 border-ink-800 text-[13px] leading-relaxed text-ink-500 whitespace-pre-wrap">
        {text}
      </div>
    </details>
  )
}
