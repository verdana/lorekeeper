import { useEffect, useRef, useState } from 'react'
import type { StoryMemoryStore, VoiceProfile, TimelineEvent } from '@shared/types'
import { buildStoryMemoryContext, orderedChapters, selectStoryMemories } from '@shared/storyMemory'
import { buildSceneCardContext } from '@shared/sceneCard'
import {
  X,
  Send,
  Loader2,
  CornerDownLeft,
  Square,
  BookOpen,
  Play,
  Settings2,
  RotateCcw,
  Brain,
} from 'lucide-react'
import { useStore } from '../store'
import { chatStream } from '../api'
import { toastError, parseAiError } from '../toast'
import { PROMPTS } from '@shared/prompts'
import DiffView from './DiffView'

/** AI assistant presets: same panel reused for settings and prose, swapping title and prompts. */
export interface AssistPreset {
  title: string
  systemPrompt: string
  contextLabel: string // 上下文在 prompt 里的标签，如「当前设定文档」
  quickPrompts: string[]
}

/** Codex scene: polish / expand / find gaps / suggest hooks. */
export const SETTING_ASSIST: AssistPreset = PROMPTS.assist.setting

/** Volume.章正文润色场景 */
export const CHAPTER_ASSIST: AssistPreset = PROMPTS.assist.chapter

// ---- Default system prompts (also exported to Preferences as templates). ----

export const BUILTIN_OUTLINE_PROMPT = PROMPTS.assist.outlinePrompt

export const BUILTIN_CONTINUE_PROMPT = PROMPTS.assist.continuePrompt

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
function getConfigPrompt(
  mode: string,
  config: { writing?: { outlineSystemPrompt?: string; continueSystemPrompt?: string } } | null,
): string {
  if (!config?.writing) return getDefaultPrompt(mode)
  if (mode === 'outline-write' && config.writing.outlineSystemPrompt?.trim())
    return config.writing.outlineSystemPrompt
  if (mode === 'continue' && config.writing.continueSystemPrompt?.trim())
    return config.writing.continueSystemPrompt
  return getDefaultPrompt(mode)
}

// ---- Context loading hook. ----

interface OutlineContext {
  settings: string
  outline: string
  timeline: string
  scene: string
  memories: string
  memoryCount: number
  prevChapters: string
  loading: boolean
  truncated: boolean
}

/** Character budget for continuation / outline-write context injection.
 *  When exceeded, settings, outline, timeline, and prevChapters are truncated
 *  proportionally (settings ~30%, outline ~10%, timeline ~10%, memory ~25%,
 *  prevChapters ~25% - most recent first). */
const CONTEXT_BUDGET = 12000
const MEMORY_CONTEXT_BUDGET = Math.floor(CONTEXT_BUDGET * 0.25)

/** Build voice-profile injection text for system prompts. Shared by all writing modes. */
function buildVoiceContext(voiceProfile: VoiceProfile | null): string {
  const t = voiceProfile?.traits
  if (!t) return ''
  return `\n\n## Author voice profile (follow these traits strictly):\n- Sentence length: ${t.sentenceLength}\n- Verb style: ${t.verbStyle}\n- Narrative distance: ${t.narrativeDistance}\n- Dialogue: ${t.dialogueStyle}\n- Rhetorical patterns: ${t.rhetoricalPatterns}\n- Notes: ${t.proseNotes}`
}

function applyBudget(
  settings: string,
  outline: string,
  timeline: string,
  memories: string,
  prevChapters: string,
): {
  settings: string
  outline: string
  timeline: string
  memories: string
  prevChapters: string
  truncated: boolean
} {
  const total =
    settings.length + outline.length + timeline.length + memories.length + prevChapters.length
  if (total <= CONTEXT_BUDGET)
    return { settings, outline, timeline, memories, prevChapters, truncated: false }
  const settingsBudget = Math.floor(CONTEXT_BUDGET * 0.3)
  const outlineBudget = Math.floor(CONTEXT_BUDGET * 0.1)
  const timelineBudget = Math.floor(CONTEXT_BUDGET * 0.1)
  const memoryBudget = Math.floor(CONTEXT_BUDGET * 0.25)
  const prevBudget = CONTEXT_BUDGET - settingsBudget - outlineBudget - timelineBudget - memoryBudget
  return {
    settings: settings.slice(0, settingsBudget),
    outline: outline.slice(0, outlineBudget),
    timeline: timeline.slice(0, timelineBudget),
    memories: memories.slice(0, memoryBudget),
    prevChapters: prevChapters.slice(-prevBudget),
    truncated: true,
  }
}

function useOutlineContext(
  chapterId: string,
  chapterTitle: string,
  content: string,
  active: boolean,
): OutlineContext {
  const novel = useStore((s) => s.novel)!
  const settingDocs = useStore((s) => s.settingDocs)
  const [settings, setSettings] = useState('')
  const [outline, setOutline] = useState('')
  const [timeline, setTimeline] = useState('')
  const [scene, setScene] = useState('')
  const [memories, setMemories] = useState('')
  const [memoryCount, setMemoryCount] = useState(0)
  const [prevChapters, setPrevChapters] = useState('')
  const [loading, setLoading] = useState(true)
  const [truncated, setTruncated] = useState(false)

  // Refs for scene-filter signal: updated every render but excluded from
  // deps so typing in the editor doesn't trigger a full context reload.
  const chapterTitleRef = useRef(chapterTitle)
  const contentRef = useRef(content)
  chapterTitleRef.current = chapterTitle
  contentRef.current = content

  useEffect(() => {
    if (!active) return
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        // 1) Outline (loaded early; also serves as scene-filter signal).
        const outlineText = await window.api.readOutline()

        // 2) Codex settings filtered by scene relevance.
        //    Signal = chapter title + current prose + outline. worldview is
        //    always included (global rules); other categories included only
        //    when the doc title appears in the signal. Fallback: if no
        //    character doc matches, include all characters.
        const currentScene = novel.volumes
          .flatMap((volume) => volume.chapters)
          .find((chapter) => chapter.id === chapterId)?.scene
        const relevant = new Set<string>()
        if (currentScene?.locationId) relevant.add(currentScene.locationId)
        for (const participantId of currentScene?.participantIds ?? []) {
          relevant.add(participantId)
        }
        const signalText = `${chapterTitleRef.current}\n${JSON.stringify(currentScene ?? {})}\n${contentRef.current}\n${outlineText}`
        const hasSignal = signalText.trim().length > 0
        for (const doc of settingDocs) {
          if (doc.category === 'worldview') {
            relevant.add(doc.id)
          } else if (hasSignal && doc.title && signalText.includes(doc.title)) {
            relevant.add(doc.id)
          }
        }
        const anyCharacter = [...relevant].some((id) =>
          settingDocs.some((d) => d.id === id && d.category === 'character'),
        )
        if (!anyCharacter) {
          for (const doc of settingDocs) {
            if (doc.category === 'character') relevant.add(doc.id)
          }
        }
        const settingTexts: string[] = []
        for (const doc of settingDocs) {
          if (!relevant.has(doc.id)) continue
          const { content } = await window.api.readSetting(doc.id)
          if (content.trim()) settingTexts.push(`## ${doc.title}\n\n${content}`)
        }

        // 3) Timeline events and confirmed Story Memory entries.
        // Story Memory is optional context: an unreadable local memory file
        // must never block the existing drafting workflow.
        const events: TimelineEvent[] = await window.api.listTimelineEvents()
        const sceneContext = buildSceneCardContext(currentScene, settingDocs, events)
        let memoryStore: StoryMemoryStore = { version: 1, entries: [] }
        try {
          memoryStore = await window.api.readStoryMemory()
        } catch (e) {
          console.warn('[story-memory] skipped unreadable memory file:', e)
        }
        const timelineText = events
          .slice()
          .sort((a, b) => a.dateOrder - b.dateOrder)
          .map(
            (e) =>
              `- ${e.dateLabel ? `**${e.dateLabel}** ` : ''}${e.title}${e.description ? `：${e.description}` : ''}`,
          )
          .join('\n')

        const ordered = orderedChapters(novel)
        const currentIndex = ordered.findIndex((item) => item.chapter.id === chapterId)
        const textCache = new Map<string, string>()
        const readSavedChapter = async (id: string): Promise<string> => {
          const cached = textCache.get(id)
          if (cached !== undefined) return cached
          // The active chapter may have unsaved editor changes. Use the live
          // prose for its fingerprint so outdated memories cannot leak into
          // a drafting request before the debounce save completes.
          if (id === chapterId) {
            const text = contentRef.current
            textCache.set(id, text)
            return text
          }
          const item = ordered.find((candidate) => candidate.chapter.id === id)
          if (!item) return ''
          const text = await window.api.readChapter(item.chapter.file)
          textCache.set(id, text)
          return text
        }
        const sourceIds = [...new Set(memoryStore.entries.map((entry) => entry.source.chapterId))]
        await Promise.all(sourceIds.map((id) => readSavedChapter(id)))
        const selectedMemories = selectStoryMemories({
          store: memoryStore,
          novel,
          activeChapterId: chapterId,
          sourceTexts: textCache,
          signalText,
          settingDocs,
        })
        const memoryContext = buildStoryMemoryContext(
          selectedMemories,
          events,
          MEMORY_CONTEXT_BUDGET,
        )

        // 4) Previous chapters before the active chapter in flattened reading order.
        const chapterSnippets: string[] = []
        for (const item of ordered.slice(0, Math.max(0, currentIndex))) {
          const text = await readSavedChapter(item.chapter.id)
          if (text.trim()) {
            chapterSnippets.push(
              `### ${item.chapter.title}\n\n${text.slice(0, 800)}${text.length > 800 ? '…' : ''}`,
            )
          }
        }

        if (!cancelled) {
          const rawSettings = settingTexts.join('\n\n---\n\n')
          const rawOutline = outlineText
          const rawTimeline = timelineText
          const rawMemories = memoryContext.text
          const rawPrev = chapterSnippets.join('\n\n')
          const trimmed = applyBudget(rawSettings, rawOutline, rawTimeline, rawMemories, rawPrev)
          setSettings(trimmed.settings)
          setOutline(trimmed.outline)
          setTimeline(trimmed.timeline)
          setScene(sceneContext)
          setMemories(trimmed.memories)
          setMemoryCount(memoryContext.count)
          setPrevChapters(trimmed.prevChapters)
          setTruncated(trimmed.truncated || memoryContext.truncated)
        }
      } catch {
        // Loading failure does not block the panel.
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [active, chapterId, novel, settingDocs])

  return {
    settings,
    outline,
    timeline,
    scene,
    memories,
    memoryCount,
    prevChapters,
    loading,
    truncated,
  }
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

export default function AiAssistPanel({
  mode,
  content,
  selectedText,
  chapterId,
  chapterTitle,
  polishPreset,
  onInsert,
  onClose,
}: Props): JSX.Element {
  const polish = polishPreset ?? CHAPTER_ASSIST
  const config = useStore((s) => s.config)
  const voiceProfile = useStore((s) => s.voiceProfile)
  const [prompt, setPrompt] = useState('')
  const [answer, setAnswer] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const abortRef = useRef<AbortController>(undefined)

  // Outline.编写模式需要加载设定 + Outline. + 前文章节
  const outlineCtx = useOutlineContext(
    chapterId,
    chapterTitle,
    content,
    mode === 'outline-write' || mode === 'continue',
  )
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

  const isCustomized =
    canEditPrompt &&
    loadCustomPrompt(mode) !== null &&
    loadCustomPrompt(mode) !== getConfigPrompt(mode, config)

  // Refresh on config update (only when no localStorage override).
  useEffect(() => {
    if (!canEditPrompt) return
    if (loadCustomPrompt(mode) !== null) return
    setSysPrompt(getConfigPrompt(mode, config))
  }, [config])

  const resetSysPrompt = (): void => {
    const def = getConfigPrompt(mode, config)
    setSysPrompt(def)
    try {
      localStorage.removeItem(`ai-prompt:${mode}`)
    } catch {
      /* */
    }
  }

  useEffect(() => () => abortRef.current?.abort(), [])

  const hasKey = config?.ai.providers.some((p) => p.apiKey)

  // ---- Build messages. ----

  const buildMessages = (q: string): { role: 'system' | 'user'; content: string }[] => {
    if (mode === 'polish') {
      const target = selectedText || content.slice(0, 6000)
      const label = selectedText ? '选中的段落' : polish.contextLabel
      return [
        { role: 'system', content: polish.systemPrompt + buildVoiceContext(voiceProfile) },
        { role: 'user', content: `[${label}]\n${target}\n\n[My request]\n${q}` },
      ]
    }
    if (mode === 'outline-write') {
      return [
        { role: 'system', content: sysPrompt + buildVoiceContext(voiceProfile) },
        {
          role: 'user',
          content: [
            '## 法典设定',
            outlineCtx.settings || '(无)',
            '',
            outlineCtx.scene,
            '',
            '## 世界事件时间线',
            outlineCtx.timeline || '(无)',
            '',
            '## 已确认的故事记忆',
            outlineCtx.memories || '(无)',
            '',
            '## 情节大纲',
            outlineCtx.outline || '(无)',
            '',
            '## 前情提要',
            outlineCtx.prevChapters || '(无)',
            '',
            '## 本章',
            `标题：${chapterTitle}`,
            '',
            '## 写作指令',
            q || `根据大纲和设定撰写完整正文。`,
          ].join('\n'),
        },
      ]
    }
    // continue
    return [
      { role: 'system', content: sysPrompt + buildVoiceContext(voiceProfile) },
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
          outlineCtx.scene,
          '',
          '## 世界事件时间线',
          outlineCtx.timeline || '(无)',
          '',
          '## 已确认的故事记忆',
          outlineCtx.memories || '(无)',
          '',
          '## 情节Outline.',
          outlineCtx.outline || '(无Outline.)',
          '',
          '## 前情提要',
          outlineCtx.prevChapters || '(无前文)',
        ].join('\n'),
      },
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
        (mode !== 'polish' ? config?.writing?.providerId : null) ??
          config?.ai.activeProviderId ??
          undefined,
        (type, text) => {
          if (type === 'content') setAnswer((a) => a + text)
        },
        controller.signal,
        // Writing mode passes temperature/topP; polish uses upstream defaults.
        mode !== 'polish' ? config?.writing?.temperature : undefined,
        mode !== 'polish' ? config?.writing?.topP : undefined,
        true,
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
          Icon: null,
        }
    }
  })()

  // ---- Render. ----

  return (
    <div className="w-80 shrink-0 border-l border-ink-800 bg-ink-900 flex flex-col">
      {/* 头部 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-ink-800">
        <span className="text-sm font-medium text-star-info flex items-center gap-2">
          {header.Icon && <header.Icon size={15} />}
          {header.title}
        </span>
        <button onClick={onClose} className="icon-btn hover:text-ink-body" title="Close AI panel">
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
            {error && <div className="text-xs text-star-danger leading-relaxed">{error}</div>}
            {answer && (
              <div className="space-y-3">
                {!loading ? (
                  <DiffView
                    original={selectedText || content.slice(0, 6000)}
                    revised={stripBlankLines(answer)}
                    onAccept={() => onInsert(stripBlankLines(answer))}
                    onReject={() => setAnswer('')}
                  />
                ) : (
                  <div className="text-sm text-ink-muted whitespace-pre-wrap leading-relaxed">
                    {answer}
                    <span className="inline-block w-1.5 h-4 bg-star-info/60 animate-pulse align-middle ml-0.5" />
                  </div>
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
                  className="icon-btn absolute right-2 bottom-2 text-star-danger hover:brightness-90"
                  title="Stop generating"
                >
                  <Square size={16} />
                </button>
              ) : (
                <button
                  onClick={() => run(prompt)}
                  className="icon-btn absolute right-2 bottom-2 text-star-info hover:text-star-accent"
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
          {mode === 'outline-write' || mode === 'continue' ? (
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
                    <li>Outline loaded ({outlineCtx.outline.length.toLocaleString()} chars)</li>
                    <li>
                      {outlineCtx.memoryCount > 0 ? (
                        <span className="inline-flex items-center gap-1 text-star-info">
                          <Brain size={12} /> {outlineCtx.memoryCount} confirmed story memor
                          {outlineCtx.memoryCount === 1 ? 'y' : 'ies'} included
                        </span>
                      ) : (
                        'No confirmed story memories'
                      )}
                    </li>
                    <li>
                      {outlineCtx.prevChapters
                        ? 'Previous chapters loaded'
                        : 'No previous chapters'}
                    </li>
                    {outlineCtx.truncated && (
                      <li className="text-star-warning">
                        ⚠ Context truncated — budget exceeded. Earlier chapters / settings omitted.
                      </li>
                    )}
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
              className="flex items-center gap-1.5 w-full px-4 py-2 text-xs text-ink-500 hover:text-ink-muted transition-colors"
            >
              <Settings2 size={12} />
              System Prompt
              {isCustomized && <span className="w-1.5 h-1.5 rounded-full bg-star-accent" />}
              <span className="ml-auto text-[11px]">{showSysPrompt ? '▲' : '▼'}</span>
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
                      try {
                        localStorage.removeItem(`ai-prompt:${mode}`)
                      } catch {
                        /* */
                      }
                    }
                  }}
                />
                <button
                  onClick={resetSysPrompt}
                  className="flex items-center gap-1 text-[11px] text-ink-500 hover:text-star-accent transition-colors"
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
            {error && <div className="text-xs text-star-danger leading-relaxed">{error}</div>}
            {answer && (
              <div className="space-y-3">
                <div className="text-sm text-ink-muted whitespace-pre-wrap leading-relaxed">
                  {answer}
                  {loading && (
                    <span className="inline-block w-1.5 h-4 bg-star-info/60 animate-pulse align-middle ml-0.5" />
                  )}
                </div>
                {!loading && (
                  <button
                    onClick={() => onInsert(stripBlankLines(answer))}
                    className="btn btn-sm btn-secondary"
                  >
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
                  className="icon-btn absolute right-2 bottom-2 text-star-danger hover:brightness-90"
                  title="Stop generating"
                >
                  <Square size={16} />
                </button>
              ) : (
                <button
                  onClick={() => run(prompt)}
                  className="icon-btn absolute right-2 bottom-2 text-star-info hover:text-star-accent"
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
