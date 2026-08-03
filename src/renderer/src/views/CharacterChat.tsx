import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { PROMPTS } from '@shared/prompts'
import { toastError, toastSuccess } from '../toast'
import { uid } from '../lib'
import type {
  CharacterChatMessage,
  CharacterChatSession,
  StoryMemoryEntry,
  StoryMemoryKind,
  StoryMemoryStore,
} from '@shared/types'
import {
  Send,
  MessageCircle,
  Download,
  Loader2,
  RefreshCw,
  User,
  Bot,
  Archive,
  Trash2,
  FilePlus2,
  Brain,
  X,
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkCjkFriendly from 'remark-cjk-friendly'
import clsx from 'clsx'
import EmptyState from '../components/EmptyState'

const MEMORY_KIND_LABELS: { id: StoryMemoryKind; label: string }[] = [
  { id: 'character-state', label: 'Character state' },
  { id: 'relationship', label: 'Relationship' },
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'location', label: 'Location' },
  { id: 'object', label: 'Object' },
  { id: 'world-state', label: 'World state' },
  { id: 'open-thread', label: 'Open thread' },
]

export default function CharacterChat(): JSX.Element {
  const config = useStore((s) => s.config)
  const settingDocs = useStore((s) => s.settingDocs)
  const currentWorldId = useStore((s) => s.currentWorldId)
  const characters = settingDocs.filter((d) => d.category === '11-character')

  const [selectedId, setSelectedId] = useState<string>('')
  const [characterContent, setCharacterContent] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [messages, setMessages] = useState<CharacterChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [sessions, setSessions] = useState<CharacterChatSession[]>([])
  // 晋升对话框状态
  const [promoteOpen, setPromoteOpen] = useState(false)
  const [memoryKind, setMemoryKind] = useState<StoryMemoryKind>('character-state')
  const [memoryStatement, setMemoryStatement] = useState('')
  const [promoting, setPromoting] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const lastSelectedRef = useRef<string | null>(null)
  // 当前面板实际展示的角色:send 的异步响应回来时用它判断面板是否已切走。
  const activeCharacterRef = useRef<string | null>(null)

  const hasKey = config?.ai.providers.some((p) => p.apiKey) ?? false

  // 挂载/切换世界时加载持久化会话
  useEffect(() => {
    lastSelectedRef.current = null
    activeCharacterRef.current = null
    setSelectedId('')
    setMessages([])
    window.api
      .listCharacterChats()
      .then(setSessions)
      .catch(() => setSessions([]))
  }, [currentWorldId])

  // 角色切换:加载该角色的持久化会话（sessions 就绪后也会补一次,避免初次进入读到空列表）
  useEffect(() => {
    if (selectedId === lastSelectedRef.current) return
    lastSelectedRef.current = selectedId
    activeCharacterRef.current = selectedId
    setMessages(sessions.find((s) => s.characterId === selectedId)?.messages ?? [])
  }, [selectedId, sessions])

  useEffect(() => {
    if (!selectedId) return
    let cancelled = false
    ;(async () => {
      setGenerating(true)
      try {
        const { content, title } = await window.api.readSetting(selectedId)
        if (cancelled) return
        setCharacterContent(content)
        setSystemPrompt(PROMPTS.characterChat.systemPrompt({ name: title, content }))
      } catch (e) {
        toastError((e as Error).message)
      } finally {
        if (!cancelled) setGenerating(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [selectedId])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [messages])

  /** 把当前角色的一组消息落盘（每角色一份活动会话，覆盖保存）。 */
  const persistMessages = async (next: CharacterChatMessage[]): Promise<void> => {
    if (!selectedId || next.length === 0) return
    const existing = sessions.find((s) => s.characterId === selectedId)
    const now = Date.now()
    const session: CharacterChatSession = {
      id: existing?.id ?? uid('cc_'),
      characterId: selectedId,
      characterTitle: characters.find((c) => c.id === selectedId)?.title ?? 'Unknown',
      messages: next,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    try {
      await window.api.saveCharacterChat(session)
      setSessions((prev) => [session, ...prev.filter((s) => s.characterId !== selectedId)])
    } catch (e) {
      toastError('Failed to save chat: ' + (e as Error).message)
    }
  }

  const resetChat = async (): Promise<void> => {
    if (messages.length === 0) return
    const target = selectedId
    setMessages([])
    const existing = sessions.find((s) => s.characterId === target)
    if (existing) {
      try {
        await window.api.deleteCharacterChat(target)
        setSessions((prev) => prev.filter((s) => s.characterId !== target))
      } catch (e) {
        toastError('Failed to clear chat: ' + (e as Error).message)
      }
    }
  }

  const send = async (): Promise<void> => {
    if (!input.trim() || !systemPrompt || loading) return
    const text = input.trim()
    setInput('')
    const sendForCharacter = selectedId
    const userMsg: CharacterChatMessage = {
      id: uid('u_'),
      role: 'user',
      content: text,
      ts: Date.now(),
    }
    const nextUser = [...messages, userMsg]
    setMessages(nextUser)
    setLoading(true)
    try {
      const history = nextUser.map((m) => ({
        role: m.role === 'user' ? ('user' as const) : ('assistant' as const),
        content: m.content,
      }))
      const raw = await window.api.chat(
        [{ role: 'system', content: systemPrompt }, ...history],
        config?.ai.activeProviderId ?? undefined,
      )
      const charMsg: CharacterChatMessage = {
        id: uid('c_'),
        role: 'character',
        content: raw.trim(),
        ts: Date.now(),
      }
      if (activeCharacterRef.current !== sendForCharacter) {
        // 面板已切到别的角色:只把回复落盘到发起角色的会话,不污染当前面板。
        // persistMessages 的闭包 selectedId 仍是发起角色,保存目标正确。
        await persistMessages([...nextUser, charMsg])
        return
      }
      const next = [...nextUser, charMsg]
      setMessages(next)
      await persistMessages(next)
    } catch (e) {
      toastError((e as Error).message)
      await persistMessages(nextUser)
    } finally {
      setLoading(false)
    }
  }

  const exportChat = (): void => {
    if (messages.length === 0) return
    const doc = characters.find((c) => c.id === selectedId)
    const lines = [
      `# Character chat — ${doc?.title ?? 'Unknown'}`,
      '',
      ...messages.map(
        (m) => `**${m.role === 'user' ? 'You' : (doc?.title ?? 'Character')}:** ${m.content}`,
      ),
      '',
    ]
    const blob = new Blob([lines.join('\n\n')], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `chat-${(doc?.title ?? 'character').replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '_')}.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  const openPromote = (): void => {
    const replies = messages
      .filter((m) => m.role === 'character')
      .map((m) => m.content)
      .join('\n\n')
      .slice(0, 600)
    setMemoryStatement(replies)
    setMemoryKind('character-state')
    setPromoteOpen(true)
  }

  /** 晋升 1:整段对话追加到角色设定文档（writeSetting 自带快照保护）。 */
  const promoteToCodex = async (): Promise<void> => {
    const doc = characters.find((c) => c.id === selectedId)
    if (!doc || messages.length === 0) return
    setPromoting(true)
    try {
      const { content } = await window.api.readSetting(doc.id)
      const header = `## Character chat — ${new Date().toLocaleString()}`
      const body = messages
        .map((m) => `**${m.role === 'user' ? 'You' : doc.title}:** ${m.content}`)
        .join('\n\n')
      await window.api.writeSetting(doc.id, `${content.trimEnd()}\n\n${header}\n\n${body}\n`)
      toastSuccess('Conversation appended to the character document.')
      setPromoteOpen(false)
    } catch (e) {
      toastError('Failed to append to codex: ' + (e as Error).message)
    } finally {
      setPromoting(false)
    }
  }

  /** 晋升 2:把对话结论存为作者确认的 Story Memory 条目。 */
  const promoteToMemory = async (): Promise<void> => {
    if (!memoryStatement.trim() || !selectedId) return
    const doc = characters.find((c) => c.id === selectedId)
    setPromoting(true)
    const now = Date.now()
    const entry: StoryMemoryEntry = {
      id: uid('mem_'),
      kind: memoryKind,
      statement: memoryStatement.trim().slice(0, 600),
      entityRefIds: [selectedId],
      // 作者主动录入的记忆没有章节来源;空 source 在 UI 里显示为 author note。
      source: {
        chapterId: '',
        chapterFile: '',
        chapterTitle: '',
        volumeId: '',
        volumeOrder: -1,
        chapterOrder: -1,
        fingerprint: '',
        evidence: '',
      },
      timelineEventId: null,
      storyDateLabel: '',
      confidence: null,
      status: 'confirmed',
      origin: 'author',
      createdAt: now,
      updatedAt: now,
      confirmedAt: now,
    }
    try {
      const store = await window.api.readStoryMemory()
      const next: StoryMemoryStore = { ...store, entries: [entry, ...store.entries] }
      await window.api.writeStoryMemory(next)
      toastSuccess(`Saved "${doc?.title ?? 'character'}" conclusion to Story Memory.`)
      setPromoteOpen(false)
    } catch (e) {
      toastError('Failed to save to Story Memory: ' + (e as Error).message)
    } finally {
      setPromoting(false)
    }
  }

  if (characters.length === 0) {
    return (
      <div className="h-full flex items-center justify-center p-8">
        <EmptyState
          icon={Bot}
          title="No characters yet"
          description="Create a character document under Codex first, then come back to chat in-character."
        />
      </div>
    )
  }

  return (
    <div className="h-full flex">
      {/* Sidebar: character selection + saved chats */}
      <aside className="w-64 shrink-0 border-r border-ink-800 bg-ink-900 flex flex-col">
        <div className="px-4 py-3.5 border-b border-ink-800">
          <h2 className="text-sm font-semibold text-ink-body flex items-center gap-2">
            <MessageCircle size={16} /> Character Chat
          </h2>
        </div>
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="overflow-y-auto p-3 space-y-1">
            {characters.map((c) => (
              <button
                key={c.id}
                onClick={() => setSelectedId(c.id)}
                className={clsx(
                  'w-full text-left px-3 py-2 rounded-md text-sm transition-colors',
                  selectedId === c.id
                    ? 'bg-ink-700 text-ink-deep'
                    : 'text-ink-faint hover:bg-ink-850 hover:text-ink-body',
                )}
              >
                {c.title}
              </button>
            ))}
          </div>
          <div className="border-t border-ink-800 px-3 py-3 flex-1 min-h-0 flex flex-col">
            <label className="text-[12px] font-medium text-ink-muted mb-2 flex items-center gap-1.5">
              <Archive size={12} /> Saved chats ({sessions.length})
            </label>
            {sessions.length === 0 ? (
              <p className="text-[11px] text-ink-500 leading-relaxed">
                Conversations are saved automatically. Reopen any character's chat here.
              </p>
            ) : (
              <div className="space-y-1 overflow-y-auto">
                {sessions.map((s) => (
                  <div
                    key={s.id}
                    className={clsx(
                      'group flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] transition-colors',
                      s.characterId === selectedId
                        ? 'bg-ink-700 text-ink-body'
                        : 'text-ink-muted hover:bg-ink-850',
                    )}
                  >
                    <button
                      onClick={() => setSelectedId(s.characterId)}
                      className="flex-1 min-w-0 text-left truncate"
                      title={`${s.messages.length} messages`}
                    >
                      <span className="block truncate">{s.characterTitle}</span>
                      <span className="block text-[10px] text-ink-500">
                        {new Date(s.updatedAt).toLocaleString([], {
                          month: '2-digit',
                          day: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}{' '}
                        · {s.messages.length} msgs
                      </span>
                    </button>
                    <button
                      onClick={async () => {
                        if (s.characterId === selectedId) {
                          setMessages([])
                          activeCharacterRef.current = null
                        }
                        try {
                          await window.api.deleteCharacterChat(s.characterId)
                          setSessions((prev) => prev.filter((x) => x.id !== s.id))
                        } catch (e) {
                          toastError('Failed to delete chat: ' + (e as Error).message)
                        }
                      }}
                      className="icon-btn text-ink-500 hover:text-star-danger opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                      aria-label="Delete saved chat"
                      title="Delete saved chat"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </aside>

      {/* Chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        {!selectedId ? (
          <div className="flex-1 flex items-center justify-center p-8">
            <EmptyState
              icon={MessageCircle}
              title="Pick a character"
              description="Select a character from the sidebar to start an in-character conversation."
            />
          </div>
        ) : (
          <>
            <div className="px-5 py-3 border-b border-ink-800 flex items-center justify-between bg-ink-900">
              <div className="flex items-center gap-2">
                <Bot size={16} className="text-star-accent" />
                <span className="text-sm font-medium text-ink-body">
                  {characters.find((c) => c.id === selectedId)?.title}
                </span>
                {generating && <Loader2 size={13} className="animate-spin text-ink-500" />}
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={openPromote}
                  disabled={messages.length === 0 || loading}
                  className="icon-btn gap-1 text-[11px] hover:text-ink-muted"
                  title="Promote this conversation into the codex or Story Memory"
                >
                  <FilePlus2 size={12} /> Promote
                </button>
                <button
                  onClick={resetChat}
                  disabled={messages.length === 0 || loading}
                  className="icon-btn gap-1 text-[11px] hover:text-ink-muted"
                  title="Reset conversation"
                >
                  <RefreshCw size={12} /> Reset
                </button>
                <button
                  onClick={exportChat}
                  disabled={messages.length === 0}
                  className="icon-btn gap-1 text-[11px] hover:text-ink-muted"
                  title="Export chat as Markdown"
                >
                  <Download size={12} /> Export
                </button>
              </div>
            </div>

            <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 space-y-5">
              {messages.length === 0 && !loading && (
                <div className="text-center text-xs text-ink-500 py-12">
                  Start a conversation with this character.
                </div>
              )}
              {messages.map((m) => (
                <div
                  key={m.id}
                  className={clsx('flex gap-3', m.role === 'user' && 'flex-row-reverse')}
                >
                  <span
                    className={clsx(
                      'w-8 h-8 rounded-full shrink-0 flex items-center justify-center text-xs font-bold text-white',
                      m.role === 'user' ? 'bg-ink-700' : 'bg-star-accent',
                    )}
                  >
                    {m.role === 'user' ? <User size={14} /> : <Bot size={14} />}
                  </span>
                  <div
                    className={clsx(
                      'max-w-[80%] rounded-lg px-4 py-3 text-sm leading-relaxed',
                      m.role === 'user'
                        ? 'bg-ink-700 text-ink-body'
                        : 'bg-ink-850 text-ink-body border border-ink-800',
                    )}
                  >
                    <ReactMarkdown remarkPlugins={[remarkGfm, remarkCjkFriendly]}>
                      {m.content}
                    </ReactMarkdown>
                  </div>
                </div>
              ))}
              {loading && (
                <div className="flex items-center gap-2 text-ink-500 text-sm pl-12">
                  <Loader2 size={15} className="animate-spin" /> Character is thinking…
                </div>
              )}
            </div>

            <div className="shrink-0 border-t border-ink-800 px-5 py-3 bg-ink-900">
              {!hasKey ? (
                <div className="text-xs text-ink-500">
                  No AI provider configured yet. Add an API key under Settings first.
                </div>
              ) : (
                <div className="flex items-stretch gap-2 max-w-3xl mx-auto">
                  <textarea
                    className="textarea flex-1 max-h-32 text-sm"
                    placeholder="Say something to this character…"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    disabled={loading || generating}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        send()
                      }
                    }}
                  />
                  {loading ? (
                    <button disabled className="btn btn-primary shrink-0">
                      <Loader2 size={15} className="animate-spin" /> Sending…
                    </button>
                  ) : (
                    <button
                      onClick={send}
                      disabled={!input.trim() || generating || !systemPrompt}
                      className="btn btn-primary shrink-0"
                    >
                      <Send size={15} /> Send
                    </button>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Promote 对话框 */}
      {promoteOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-deep/60 p-6">
          <div className="w-full max-w-lg bg-ink-850 border border-ink-700 rounded-[14px] shadow-warm-lg">
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-ink-800">
              <h3 className="text-sm font-semibold text-ink-body flex items-center gap-2">
                <FilePlus2 size={15} /> Promote conversation
              </h3>
              <button
                onClick={() => setPromoteOpen(false)}
                className="icon-btn text-ink-500 hover:text-ink-body"
                aria-label="Close"
              >
                <X size={15} />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <p className="text-[12px] text-ink-500 leading-relaxed">
                Turn confirmed character insights into durable project material. Append the whole
                conversation to the character document, or save a distilled note to Story Memory.
              </p>
              <button
                onClick={promoteToCodex}
                disabled={promoting || messages.length === 0}
                className="w-full btn btn-secondary justify-start"
              >
                <FilePlus2 size={14} />
                Append conversation to the character document
              </button>
              <div className="border-t border-ink-800 pt-4 space-y-3">
                <label className="text-[12px] font-medium text-ink-muted flex items-center gap-1.5">
                  <Brain size={13} /> Save to Story Memory (confirmed author note)
                </label>
                <select
                  className="input text-sm w-full"
                  value={memoryKind}
                  onChange={(e) => setMemoryKind(e.target.value as StoryMemoryKind)}
                >
                  {MEMORY_KIND_LABELS.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.label}
                    </option>
                  ))}
                </select>
                <textarea
                  className="textarea text-sm w-full h-28"
                  placeholder="What did you learn about this character?"
                  value={memoryStatement}
                  onChange={(e) => setMemoryStatement(e.target.value)}
                />
                <button
                  onClick={promoteToMemory}
                  disabled={promoting || !memoryStatement.trim()}
                  className="w-full btn btn-primary"
                >
                  {promoting ? <Loader2 size={14} className="animate-spin" /> : <Brain size={14} />}
                  {promoting ? 'Saving…' : 'Save to Story Memory'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
