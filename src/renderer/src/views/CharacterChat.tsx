import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { PROMPTS } from '@shared/prompts'
import { toastError } from '../toast'
import { Send, MessageCircle, Download, Loader2, RefreshCw, User, Bot } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkCjkFriendly from 'remark-cjk-friendly'
import clsx from 'clsx'
import EmptyState from '../components/EmptyState'

interface ChatMessage {
  id: string
  role: 'user' | 'character'
  content: string
  ts: number
}

export default function CharacterChat(): JSX.Element {
  const config = useStore((s) => s.config)
  const settingDocs = useStore((s) => s.settingDocs)
  const characters = settingDocs.filter((d) => d.category === 'character')

  const [selectedId, setSelectedId] = useState<string>('')
  const [characterContent, setCharacterContent] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  const hasKey = config?.ai.providers.some((p) => p.apiKey) ?? false

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

  const resetChat = (): void => {
    setMessages([])
  }

  const send = async (): Promise<void> => {
    if (!input.trim() || !systemPrompt || loading) return
    const text = input.trim()
    setInput('')
    const userMsg: ChatMessage = {
      id: `u_${Date.now()}`,
      role: 'user',
      content: text,
      ts: Date.now(),
    }
    setMessages((prev) => [...prev, userMsg])
    setLoading(true)
    try {
      const history = messages.map((m) => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.content,
      }))
      const raw = await window.api.chat(
        [{ role: 'system', content: systemPrompt }, ...history, { role: 'user', content: text }],
        config?.ai.activeProviderId ?? undefined,
      )
      setMessages((prev) => [
        ...prev,
        { id: `c_${Date.now()}`, role: 'character', content: raw.trim(), ts: Date.now() },
      ])
    } catch (e) {
      toastError((e as Error).message)
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
      {/* Sidebar: character selection */}
      <aside className="w-64 shrink-0 border-r border-ink-800 bg-ink-900 flex flex-col">
        <div className="px-4 py-3.5 border-b border-ink-800">
          <h2 className="text-sm font-semibold text-ink-body flex items-center gap-2">
            <MessageCircle size={16} /> Character Chat
          </h2>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-1">
          {characters.map((c) => (
            <button
              key={c.id}
              onClick={() => setSelectedId(c.id)}
              className={clsx(
                'w-full text-left px-3 py-2 rounded-md text-sm transition-colors',
                selectedId === c.id
                  ? 'bg-ink-body text-white'
                  : 'text-ink-faint hover:bg-ink-850 hover:text-ink-body',
              )}
            >
              {c.title}
            </button>
          ))}
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
    </div>
  )
}
