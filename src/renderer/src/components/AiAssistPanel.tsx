import { useEffect, useRef, useState } from 'react'
import { X, Send, Loader2, CornerDownLeft, Square, BookOpen, Play, Settings2, RotateCcw } from 'lucide-react'
import { useStore } from '../store'
import { chatStream } from '../api'
import { toastError, parseAiError } from '../toast'

/** AI assistant presets: same panel reused for settings and prose, swapping title and prompts. */
export interface AssistPreset {
  title: string
  systemPrompt: string
  contextLabel: string // 上下文在 prompt 里的标签，如「当前设定文档」
  quickPrompts: string[]
}

/** Codex scene: polish / expand / find gaps / suggest hooks. */
export const SETTING_ASSIST: AssistPreset = {
  title: 'AI Codex Assistant',
  systemPrompt:
    'You are a seasoned worldbuilding and story-bible editor. Below is the codex document the user is currently writing. Help them according to their request. Answer in English, concise and professional, ready to drop straight into the document.',
  contextLabel: 'Current codex document',
  quickPrompts: [
    'Polish this entry so it reads more precisely and vividly',
    'Expand on what I have with more concrete detail',
    'Find logic gaps or internal contradictions in this',
    'Suggest three plot hooks that could grow out of this'
  ]
}

/** Volume.章正文润色场景 */
export const CHAPTER_ASSIST: AssistPreset = {
  title: '润色',
  systemPrompt:
    '你是一位小说行文编辑。直接用修改后的正文回复——不要解释、不要前言、不要引号包裹。保持原文语种（中文输入则输出中文，英文输入则输出英文）。始终保留作者的原始声音、视角和语调。只改必要的部分，杜绝翻译腔、AI 腔或说教味的总结。',
  contextLabel: '当前正文',
  quickPrompts: [
    '润色这段文字，让行文更流畅生动，保持我的语气',
    '去掉 AI 腔：删掉"值得注意的是 / 不仅……而且…… / 总而言之"之类的水词，避免叠床架屋的排比，读起来像人写的',
    '扩展这段内容，不改情节——增加场景细节和人物动作、神情',
    '收紧这段文字：砍掉冗余和重复，让节奏更利落',
    '打磨这段对话：加入潜台词和个性化语气，别让所有角色说话一个味儿'
  ]
}

// ---- Default system prompts (also exported to Preferences as templates). ----

export const BUILTIN_OUTLINE_PROMPT = `你是一位小说家。根据下面提供的Outline.、设定和前情，写本章正文。

## 叙事铁律

你是在角色皮肤里面写，不是在天花板上俯视。读者通过角色的眼睛看、耳朵听、身体感受。永远不要跳出角色，站在外面分析他的处境。

1. 直接呈现感官和动作，不解释。写「血从指缝渗出来」，不要写「他意识到自己在流血」。
2. 角色首先是动物——恐惧、疼痛、饥饿、欲望先于思考。危急时刻人靠本能反应，不会做临床分析。一个快死的人不会推理自己的死因，他只会想活。
3. 每一句都要推动叙事。要么推进情节，要么揭示角色，要么营造氛围。做不到就删掉。
4. 句子长短交错。允许连续三个短句制造节奏，但大段长句后必须断开。

## 文字洁癖

删除一切可有可无的词。写完每段后问自己：删掉这半句，意思变了吗？没变就删。
- 少用「的」——一个名词前面最多一个定语。
- 比喻不是装饰品。只有当你真的需要用一件东西说清楚另一件东西时才用。整段最多一个比喻。
- 不要用任何形式的「不是……而是……」「不是……是……」句式。直接说是什么。
- 不要写「取而代之」「准确地说」「换句话说」「不，不对——」。
- 不要写「第一……第二……」「一件是……另一件是……」「一边……一边……（连续使用）」。
- 不要写角色「注意到」「意识到」「观察到」「感觉到」——直接写他看到的、听到的、感受到的东西。

## 词汇禁区

你的故事世界没有以下概念，除非故事背景明确包含：信号、坐标、常数、参数、程序、系统、数据、分析、函数、模块、反馈、代偿、本体论、物理、化学、基因、DNA、频率、波段。

角色不可能想到他没见过的东西。中世纪的铁匠不会用钟表齿轮作比喻，古代将军不会知道什么叫「降维打击」。

## 只输出正文，不要任何前言后语。`

export const BUILTIN_CONTINUE_PROMPT = `你是一位小说家，正在续写故事。从下文末尾无缝接续。

## 续写铁律

1. 从最后一个句子直接长出来，当作你就是原作者在继续往下敲键盘。不重述、不总结、不另起一行喊章节标题。
2. 严格继承前文的叙事视角、时态、语言密度。前文是第三人称有限视角就继续用那个角色的眼睛看世界。
3. 动作和对话推进，不要停下来做大段描写或内心独白。

## 文字洁癖

- 少用「的」——一个名词前面最多一个定语。
- 比喻不是装饰品。整段最多一个比喻。
- 禁止「不是……而是……」「不是……是……」句式。直接说是什么。
- 禁止「取而代之」「准确地说」「换句话说」「不，不对——」。
- 禁止「第一……第二……」「一件是……另一件是……」「一边……一边……（连续）」。
- 禁止「注意到」「意识到」「观察到」「感觉到」——角色直接看、听、感受，不「觉察」。

## 人物必须像人

危急时人凭本能行动，不推理。快死的人只想活，不想别的。描写角色的第一反应永远是身体反应——手抖、胃缩、喉咙发紧、视野收窄——不要跳过身体直接写心理活动。

## 只输出续写正文，不要任何前言后语。`

// ---- Custom prompts persisted to localStorage. ----

function loadCustomPrompt(mode: string): string | null {
  try {
    return localStorage.getItem(`ai-prompt:${mode}`)
  } catch {
    return null
  }
}

function saveCustomPrompt(mode: string, prompt: string): void {
  try {
    localStorage.setItem(`ai-prompt:${mode}`, prompt)
  } catch {
    // Fail silently.
  }
}

function getDefaultPrompt(mode: string): string {
  if (mode === 'outline-write') return BUILTIN_OUTLINE_PROMPT
  if (mode === 'continue') return BUILTIN_CONTINUE_PROMPT
  return ''
}

/** Read custom prompts from config if set, otherwise use hardcoded defaults. */
function getConfigPrompt(mode: string, config: { writing?: { outlineSystemPrompt?: string; continueSystemPrompt?: string } } | null): string {
  if (!config?.writing) return getDefaultPrompt(mode)
  if (mode === 'outline-write' && config.writing.outlineSystemPrompt?.trim()) return config.writing.outlineSystemPrompt
  if (mode === 'continue' && config.writing.continueSystemPrompt?.trim()) return config.writing.continueSystemPrompt
  return getDefaultPrompt(mode)
}

// ---- Context loading hook. ----

interface OutlineContext {
  settings: string
  outline: string
  prevChapters: string
  loading: boolean
}

function useOutlineContext(chapterId: string, active: boolean): OutlineContext {
  const novel = useStore((s) => s.novel)!
  const settingDocs = useStore((s) => s.settingDocs)
  const [settings, setSettings] = useState('')
  const [outline, setOutline] = useState('')
  const [prevChapters, setPrevChapters] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!active) return
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        // 1) All codex settings.
        const settingTexts: string[] = []
        for (const doc of settingDocs) {
          const { content } = await window.api.readSetting(doc.id)
          if (content.trim()) settingTexts.push(`## ${doc.title}\n\n${content}`)
        }

        // 2) Outline.
        const outlineText = await window.api.readOutline()

        // 3) 前文章节（当前章之前的全部章节，按Volume.章顺序）
        const chapterSnippets: string[] = []
        for (const vol of novel.volumes) {
          for (const ch of vol.chapters) {
            if (ch.id === chapterId) break
            const text = await window.api.readChapter(ch.file)
            if (text.trim()) {
              chapterSnippets.push(`### ${ch.title}\n\n${text.slice(0, 800)}${text.length > 800 ? '…' : ''}`)
            }
          }
        }

        if (!cancelled) {
          setSettings(settingTexts.join('\n\n---\n\n'))
          setOutline(outlineText)
          setPrevChapters(chapterSnippets.join('\n\n'))
        }
      } catch {
        // Loading failure does not block the panel.
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [active, chapterId])

  return { settings, outline, prevChapters, loading }
}

// ---- Main panel. ----

type AiMode = 'polish' | 'outline-write' | 'continue'

interface Props {
  mode: AiMode
  content: string
  /** User’s text selection; when set, polish only the selection. */
  selectedText?: string
  chapterId: string
  chapterTitle: string
  /** Optionally override the preset in polish mode; defaults to CHAPTER_ASSIST. */
  polishPreset?: AssistPreset
  onInsert: (text: string) => void
  onClose: () => void
}

/** Strip blank lines between paragraphs in LLM output so it matches original style. */
function stripBlankLines(text: string): string {
  return text.replace(/\n{2,}/g, '\n').trim()
}

export default function AiAssistPanel({ mode, content, selectedText, chapterId, chapterTitle, polishPreset, onInsert, onClose }: Props): JSX.Element {
  const polish = polishPreset ?? CHAPTER_ASSIST
  const config = useStore((s) => s.config)
  const [prompt, setPrompt] = useState('')
  const [answer, setAnswer] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const abortRef = useRef<AbortController>(undefined)

  // Outline.编写模式需要加载设定 + Outline. + 前文章节
  const outlineCtx = useOutlineContext(chapterId, mode === 'outline-write' || mode === 'continue')
  // Continuation mode takes ~2000 chars from the end as context.
  const tailContext = mode === 'continue' ? content.slice(-2000).trimStart() : ''

  // ---- Editable system prompts. ----
  const canEditPrompt = mode === 'outline-write' || mode === 'continue'
  const [showSysPrompt, setShowSysPrompt] = useState(false)

  // Prompt priority: localStorage > config.writing > hardcoded defaults.
  const [sysPrompt, setSysPrompt] = useState(() => {
    if (!canEditPrompt) return ''
    return loadCustomPrompt(mode) ?? getConfigPrompt(mode, config)
  })

  // Reload when switching mode.
  useEffect(() => {
    if (!canEditPrompt) return
    setSysPrompt(loadCustomPrompt(mode) ?? getConfigPrompt(mode, config))
    setShowSysPrompt(false)
  }, [mode])

  const isCustomized = canEditPrompt && loadCustomPrompt(mode) !== null && loadCustomPrompt(mode) !== getConfigPrompt(mode, config)

  // Refresh on config update (only when no localStorage override).
  useEffect(() => {
    if (!canEditPrompt) return
    if (loadCustomPrompt(mode) !== null) return
    setSysPrompt(getConfigPrompt(mode, config))
  }, [config])

  const resetSysPrompt = (): void => {
    const def = getConfigPrompt(mode, config)
    setSysPrompt(def)
    try { localStorage.removeItem(`ai-prompt:${mode}`) } catch { /* */ }
  }

  useEffect(() => () => abortRef.current?.abort(), [])

  const hasKey = config?.ai.providers.some((p) => p.apiKey)

  // ---- Build messages. ----

  const buildMessages = (q: string): { role: 'system' | 'user'; content: string }[] => {
    if (mode === 'polish') {
      const target = selectedText || content.slice(0, 6000)
      const label = selectedText ? '选中的段落' : polish.contextLabel
      return [
        { role: 'system', content: polish.systemPrompt },
        { role: 'user', content: `[${label}]\n${target}\n\n[My request]\n${q}` }
      ]
    }
    if (mode === 'outline-write') {
      return [
        { role: 'system', content: sysPrompt },
        {
          role: 'user',
          content: [
            '## 法典设定',
            outlineCtx.settings || '(无)',
            '',
            '## 情节Outline.',
            outlineCtx.outline || '(无)',
            '',
            '## 前情提要',
            outlineCtx.prevChapters || '(无)',
            '',
            '## 本章',
            `标题：${chapterTitle}`,
            '',
            '## 写作指令',
            q || `根据Outline.和设定撰写完整正文。`
          ].join('\n')
        }
      ]
    }
    // continue
    return [
      { role: 'system', content: sysPrompt },
      {
        role: 'user',
        content: [
          q.trim()
            ? `[前文末尾]\n${tailContext}\n\n[续写方向]\n${q}`
            : `[前文末尾]\n${tailContext}\n\n从以上内容的最后一句自然接续，不要停顿，不要另起话题。`,
          '',
          '## 设定与上下文',
          outlineCtx.settings || '(无设定)',
          '',
          '## 情节Outline.',
          outlineCtx.outline || '(无Outline.)',
          '',
          '## 前情提要',
          outlineCtx.prevChapters || '(无前文)'
        ].join('\n')
      }
    ]
  }

  // ---- Send. ----

  const run = async (q: string): Promise<void> => {
    if (!q.trim() && mode !== 'continue') return
    if (loading) return

    // Save current system prompt to localStorage.
    if (canEditPrompt && sysPrompt !== getConfigPrompt(mode, config)) {
      saveCustomPrompt(mode, sysPrompt)
    }

    setLoading(true)
    setError('')
    setAnswer('')
    const controller = new AbortController()
    abortRef.current = controller
    try {
      await chatStream(
        buildMessages(q),
        // Writing mode uses writing config model; polish uses global default.
        (mode !== 'polish' ? config?.writing?.providerId : null) ?? config?.ai.activeProviderId ?? undefined,
        (type, text) => {
          if (type === 'content') setAnswer((a) => a + text)
        },
        controller.signal,
        // Writing mode passes temperature/topP; polish uses upstream defaults.
        mode !== 'polish' ? config?.writing?.temperature : undefined,
        mode !== 'polish' ? config?.writing?.topP : undefined
      )
    } catch (e) {
      if (!controller.signal.aborted) {
        setError((e as Error).message)
        toastError(parseAiError(e))
      }
    } finally {
      setLoading(false)
    }
  }

  const stop = (): void => {
    abortRef.current?.abort()
    setLoading(false)
  }

  // ---- Title & icon. ----

  const header = (() => {
    switch (mode) {
      case 'outline-write':
        return { title: 'Write from Outline', Icon: BookOpen }
      case 'continue':
        return { title: 'Continue Writing', Icon: Play }
      case 'polish':
        return {
          title: selectedText ? `${polish.title}（选区）` : polish.title,
          Icon: null
        }
    }
  })()

  // ---- Render. ----

  return (
    <div className="w-80 shrink-0 border-l border-ink-800 bg-ink-900 flex flex-col">
      {/* 头部 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-ink-800">
        <span className="text-sm font-medium text-star-tin flex items-center gap-2">
          {header.Icon && <header.Icon size={15} />}
          {header.title}
        </span>
        <button onClick={onClose} className="icon-btn hover:text-slate-800" title="Close AI panel">
          <X size={16} />
        </button>
      </div>

      {!hasKey ? (
        <div className="p-4 text-xs text-ink-500 leading-relaxed">
          No AI provider configured yet. Add an API key under Settings first.
        </div>
      ) : mode === 'polish' ? (
        /* ---- Polish mode (keeps existing UI). ---- */
        <>
          <div className="p-3 space-y-1.5 border-b border-ink-800">
            {polish.quickPrompts.map((p) => (
              <button
                key={p}
                onClick={() => {
                  setPrompt(p)
                  run(p)
                }}
                className="btn btn-sm btn-ghost w-full justify-start text-left text-xs font-normal"
              >
                {p}
              </button>
            ))}
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto p-4">
            {loading && !answer && (
              <div className="flex items-center gap-2 text-ink-500 text-sm">
                <Loader2 size={15} className="animate-spin" /> Thinking…
              </div>
            )}
            {error && <div className="text-xs text-star-iron leading-relaxed">{error}</div>}
            {answer && (
              <div className="space-y-3">
                <div className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">
                  {answer}
                  {loading && (
                    <span className="inline-block w-1.5 h-4 bg-star-tin/60 animate-pulse align-middle ml-0.5" />
                  )}
                </div>
                {!loading && (
                  <button onClick={() => onInsert(stripBlankLines(answer))} className="btn btn-sm btn-secondary">
                    <CornerDownLeft size={13} /> {selectedText ? 'Replace selection' : 'Append to document'}
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="p-3 border-t border-ink-800">
            <div className="relative">
              <textarea
                className="textarea min-h-16 resize-none pr-10 text-sm"
                placeholder="Ask the AI, press Enter to send…"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    run(prompt)
                  }
                }}
              />
              {loading ? (
                <button
                  onClick={stop}
                  className="icon-btn absolute right-2 bottom-2 text-star-iron hover:brightness-90"
                  title="Stop generating"
                >
                  <Square size={16} />
                </button>
              ) : (
                <button
                  onClick={() => run(prompt)}
                  className="icon-btn absolute right-2 bottom-2 text-star-tin hover:text-star-gold"
                  title="Send prompt"
                >
                  <Send size={16} />
                </button>
              )}
            </div>
          </div>
        </>
      ) : (
        /* ---- Outline.编写 / 续写（共用结构，仅上下文区域不同） ---- */
        <>
          {/* 上下文区域 */}
          {(mode === 'outline-write' || mode === 'continue') ? (
            <div className="p-3 border-b border-ink-800 text-xs text-ink-500 leading-relaxed space-y-1">
              {outlineCtx.loading ? (
                <span className="flex items-center gap-2">
                  <Loader2 size={13} className="animate-spin" /> Loading context…
                </span>
              ) : (
                <>
                  <div>Context ready:</div>
                  <ul className="list-disc list-inside space-y-0.5">
                    <li>{outlineCtx.settings ? 'Codex settings loaded' : 'No codex settings'}</li>
                    <li>Outline loaded ({(outlineCtx.outline.length).toLocaleString()} chars)</li>
                    <li>{outlineCtx.prevChapters ? 'Previous chapters loaded' : 'No previous chapters'}</li>
                  </ul>
                </>
              )}
            </div>
          ) : (
            <div className="p-3 border-b border-ink-800 text-xs text-ink-500 leading-relaxed max-h-24 overflow-y-auto">
              <div className="font-medium mb-1 text-ink-400">Continuing from:</div>
              <div className="line-clamp-4 whitespace-pre-wrap">
                {tailContext || '(empty chapter)'}
              </div>
            </div>
          )}

          {/* Editable system prompts. */}
          <div className="border-b border-ink-800">
            <button
              onClick={() => setShowSysPrompt((v) => !v)}
              className="flex items-center gap-1.5 w-full px-4 py-2 text-xs text-ink-500 hover:text-slate-700 transition-colors"
            >
              <Settings2 size={12} />
              System Prompt
              {isCustomized && <span className="w-1.5 h-1.5 rounded-full bg-star-gold" />}
              <span className="ml-auto text-[10px]">{showSysPrompt ? '▲' : '▼'}</span>
            </button>
            {showSysPrompt && (
              <div className="px-4 pb-3 space-y-2">
                <textarea
                  className="textarea min-h-24 resize-y text-[11px] leading-relaxed font-mono"
                  value={sysPrompt}
                  onChange={(e) => setSysPrompt(e.target.value)}
                  onBlur={() => {
                    const base = getConfigPrompt(mode, config)
                    if (sysPrompt !== base) {
                      saveCustomPrompt(mode, sysPrompt)
                    } else {
                      try { localStorage.removeItem(`ai-prompt:${mode}`) } catch { /* */ }
                    }
                  }}
                />
                <button
                  onClick={resetSysPrompt}
                  className="flex items-center gap-1 text-[10px] text-ink-500 hover:text-star-gold transition-colors"
                >
                  <RotateCcw size={10} /> Reset to default
                </button>
              </div>
            )}
          </div>

          {/* 输出区 */}
          <div className="flex-1 min-h-0 overflow-y-auto p-4">
            {loading && !answer && (
              <div className="flex items-center gap-2 text-ink-500 text-sm">
                <Loader2 size={15} className="animate-spin" /> Writing…
              </div>
            )}
            {error && <div className="text-xs text-star-iron leading-relaxed">{error}</div>}
            {answer && (
              <div className="space-y-3">
                <div className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">
                  {answer}
                  {loading && (
                    <span className="inline-block w-1.5 h-4 bg-star-tin/60 animate-pulse align-middle ml-0.5" />
                  )}
                </div>
                {!loading && (
                  <button onClick={() => onInsert(stripBlankLines(answer))} className="btn btn-sm btn-secondary">
                    <CornerDownLeft size={13} /> Append to document
                  </button>
                )}
              </div>
            )}
          </div>

          {/* 输入区 */}
          <div className="p-3 border-t border-ink-800">
            <div className="relative">
              <textarea
                className="textarea min-h-16 resize-none pr-10 text-sm"
                placeholder={
                  mode === 'continue'
                    ? 'Optional: give a direction hint, or leave empty and press Enter to continue…'
                    : 'Describe what to write, or leave default and press Enter…'
                }
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    run(prompt)
                  }
                }}
              />
              {loading ? (
                <button
                  onClick={stop}
                  className="icon-btn absolute right-2 bottom-2 text-star-iron hover:brightness-90"
                  title="Stop generating"
                >
                  <Square size={16} />
                </button>
              ) : (
                <button
                  onClick={() => run(prompt)}
                  className="icon-btn absolute right-2 bottom-2 text-star-tin hover:text-star-gold"
                  title="Send prompt"
                >
                  <Send size={16} />
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
