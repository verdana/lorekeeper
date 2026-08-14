import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { uid, wordCount, todayKey } from '../lib'
import MarkdownEditor, { type MarkdownEditorHandle } from '../components/MarkdownEditor'
import type { EditorSelection } from '../components/MarkdownEditor'
import AiAssistPanel from '../components/AiAssistPanel'
import type { GenerationInsertEvidence } from '../components/AiAssistPanel'
import EmptyState from '../components/EmptyState'
import { toastError, toastSuccess } from '../toast'
import type { Chapter, GenerationRunSummary, Volume } from '@shared/types'
import {
  Plus,
  ChevronRight,
  ChevronDown,
  Save,
  Maximize2,
  Minimize2,
  Trash2,
  FileText,
  CircleCheck,
  CircleDashed,
  ArrowUp,
  ArrowDown,
  Sparkles,
  BookOpen,
  Play,
  RefreshCw,
  Brain,
} from 'lucide-react'
import clsx from 'clsx'

async function readLatestGenerationEvidence(
  chapterId: string,
): Promise<GenerationInsertEvidence | null> {
  const summaries = await window.api.listGenerationRuns(chapterId)
  const latest = summaries.find((run: GenerationRunSummary) => run.selectedResultKind !== null)
  if (!latest) return null
  const run = await window.api.readGenerationRun(latest.id)
  if (!run?.selectedResult) return null
  return {
    runId: run.id,
    editingStartedAt: run.authorResult?.editingStartedAt ?? run.selectedResult.selectedAt,
  }
}

export default function Chapters(): JSX.Element {
  const novel = useStore((s) => s.novel)!
  const saveNovel = useStore((s) => s.saveNovel)
  const openStoryMemory = useStore((s) => s.openStoryMemory)
  const chapterFocusId = useStore((s) => s.chapterFocusId)
  const clearChapterFocus = useStore((s) => s.clearChapterFocus)
  const currentWorldId = useStore((s) => s.currentWorldId)

  const [activeChapter, setActiveChapter] = useState<Chapter | null>(null)
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const [zen, setZen] = useState(false)
  const [aiMode, setAiMode] = useState<'polish' | 'outline-write' | 'continue' | 'rewrite' | null>(
    null,
  )
  const editorRef = useRef<MarkdownEditorHandle>(null)
  const [aiDropdownOpen, setAiDropdownOpen] = useState(false)
  const [aiSelection, setAiSelection] = useState<EditorSelection | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(novel.volumes.map((v) => v.id)),
  )
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  // Snapshot previous chapter before switch to avoid debounce race.
  const pending = useRef<{ chapter: Chapter; content: string } | null>(null)
  const generationEdits = useRef(new Map<string, GenerationInsertEvidence>())
  const generationLinksResolved = useRef(new Set<string>())

  // Total word count: sum of chapter metadata, live content for the active chapter.
  const liveWords = activeChapter ? wordCount(content) : 0
  const totalWords = useMemo(() => {
    let sum = 0
    for (const v of novel.volumes)
      for (const c of v.chapters) sum += c.id === activeChapter?.id ? liveWords : c.wordCount
    return sum
  }, [novel.volumes, activeChapter?.id, liveWords])

  // Today's new words: baseline from first entry, live diff is today's output.
  const [todayBase, setTodayBase] = useState<number | null>(null)
  // Latest-ref pattern: the effect below runs once, but must read the current
  // novel (it may load after mount) without re-running on every volume change.
  const novelRef = useRef(novel)
  novelRef.current = novel

  useEffect(() => {
    if (!chapterFocusId) return
    const focused = novel.volumes.flatMap((v) => v.chapters).find((c) => c.id === chapterFocusId)
    if (focused) setActiveChapter(focused)
    clearChapterFocus()
  }, [chapterFocusId, novel, clearChapterFocus])
  useEffect(() => {
    const key = `wayfarer:wordbase:${todayKey()}`
    const saved = localStorage.getItem(key)
    if (saved !== null) {
      setTodayBase(Number(saved))
    } else {
      // Use static metadata total as baseline to avoid counting active chapter live words.
      const base = novelRef.current.volumes.reduce(
        (s, v) => s + v.chapters.reduce((a, c) => a + c.wordCount, 0),
        0,
      )
      localStorage.setItem(key, String(base))
      setTodayBase(base)
    }
  }, [])
  const todayWords = todayBase === null ? 0 : Math.max(0, totalWords - todayBase)

  // Write chapter body to disk and update word count. Uses getState() to avoid stale closures.
  const persist = useCallback(
    async (ch: Chapter, text: string): Promise<void> => {
      await window.api.writeChapter(ch.file, text)
      const cur = useStore.getState().novel!
      await saveNovel({
        ...cur,
        volumes: cur.volumes.map((v) => ({
          ...v,
          chapters: v.chapters.map((c) =>
            c.id === ch.id ? { ...c, wordCount: wordCount(text), updatedAt: Date.now() } : c,
          ),
        })),
      })
      let evidence = generationEdits.current.get(ch.id)
      if (!evidence && !generationLinksResolved.current.has(ch.id)) {
        try {
          evidence = (await readLatestGenerationEvidence(ch.id)) ?? undefined
          if (evidence) generationEdits.current.set(ch.id, evidence)
        } catch (loadError) {
          console.warn('[generation-evidence] failed to restore author linkage:', loadError)
        } finally {
          generationLinksResolved.current.add(ch.id)
        }
      }
      if (evidence) {
        try {
          await window.api.saveGenerationAuthorResult(evidence.runId, {
            text,
            editingStartedAt: evidence.editingStartedAt,
          })
        } catch (e) {
          console.warn('[generation-evidence] failed to link author save:', e)
          toastError('Chapter saved, but generation evidence could not be updated.')
        }
      }
    },
    [saveNovel],
  )

  // Strict flush for chapter persistence: persists and only clears pending on
  // success; throws so the caller can surface the failure.
  const flushOrThrow = useCallback(async (): Promise<void> => {
    clearTimeout(saveTimer.current)
    const p = pending.current
    if (!p) return
    await persist(p.chapter, p.content)
    if (pending.current === p) {
      pending.current = null
      setDirty(false)
    }
  }, [persist])

  // Compatible flush for chapter-switch/unmount: same as flushOrThrow but toasts.
  const flush = useCallback(async (): Promise<void> => {
    try {
      await flushOrThrow()
    } catch (e) {
      toastError('Failed to save chapter: ' + (e as Error).message)
    }
  }, [flushOrThrow])

  const activeChapterId = activeChapter?.id ?? null
  const activeChapterFile = activeChapter?.file ?? null

  useEffect(() => {
    generationEdits.current.clear()
    generationLinksResolved.current.clear()
  }, [currentWorldId])

  useEffect(() => {
    if (!activeChapterId || !activeChapterFile) {
      setContent('')
      setDirty(false)
      return
    }
    let cancelled = false
    generationEdits.current.delete(activeChapterId)
    generationLinksResolved.current.delete(activeChapterId)
    window.api
      .readChapter(activeChapterFile)
      .then((chapterContent: string) => {
        if (cancelled) return
        setContent(chapterContent)
        setDirty(false)
      })
      .catch((loadError: unknown) => {
        if (!cancelled) toastError('Failed to load chapter: ' + (loadError as Error).message)
      })
    ;(async () => {
      try {
        const evidence = await readLatestGenerationEvidence(activeChapterId)
        if (!cancelled) {
          if (evidence) generationEdits.current.set(activeChapterId, evidence)
          generationLinksResolved.current.add(activeChapterId)
        }
      } catch (loadError) {
        if (!cancelled) {
          console.warn('[generation-evidence] failed to restore author linkage:', loadError)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeChapterFile, activeChapterId, currentWorldId])

  // Before switching chapters or unmounting, flush previous chapter's pending content.
  useEffect(() => {
    return () => {
      flush()
    }
  }, [activeChapter?.id, flush])

  const saveChapter = async (): Promise<void> => {
    if (!activeChapter) return
    clearTimeout(saveTimer.current)
    const request =
      pending.current?.chapter.id === activeChapter.id && pending.current.content === content
        ? pending.current
        : { chapter: activeChapter, content }
    try {
      await persist(request.chapter, request.content)
      if (pending.current === request || pending.current === null) {
        pending.current = null
        setDirty(false)
      }
    } catch (e) {
      toastError('Failed to save chapter: ' + (e as Error).message)
    }
  }

  // Ctrl+S + autosave.
  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        saveChapter()
      }
      if (e.key === 'Escape' && zen) setZen(false)
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  })

  const onEdit = (v: string): void => {
    setContent(v)
    setDirty(true)
    if (activeChapter) pending.current = { chapter: activeChapter, content: v }
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => void flush(), 2000) // 停顿 2s 自动保存
  }

  const addVolume = async (): Promise<void> => {
    const vol: Volume = {
      id: uid('v_'),
      title: `Volume ${novel.volumes.length + 1}`,
      order: novel.volumes.length,
      chapters: [],
    }
    await saveNovel({ ...novel, volumes: [...novel.volumes, vol] })
    setExpanded((s) => new Set(s).add(vol.id))
  }

  const addChapter = async (vol: Volume): Promise<void> => {
    const ch: Chapter = {
      id: uid('c_'),
      volumeId: vol.id,
      title: `Chapter ${vol.chapters.length + 1}`,
      order: vol.chapters.length,
      file: `${vol.id}_${uid()}.md`,
      wordCount: 0,
      status: 'draft',
      updatedAt: Date.now(),
    }
    await window.api.writeChapter(ch.file, `# ${ch.title}\n\n`)
    await saveNovel({
      ...novel,
      volumes: novel.volumes.map((v) =>
        v.id === vol.id ? { ...v, chapters: [...v.chapters, ch] } : v,
      ),
    })
    setActiveChapter(ch)
    toastSuccess(`"${ch.title}" created.`)
  }

  const renameVolume = async (vid: string, title: string): Promise<void> => {
    await saveNovel({
      ...novel,
      volumes: novel.volumes.map((v) => (v.id === vid ? { ...v, title } : v)),
    })
  }

  const renameChapter = async (ch: Chapter, title: string): Promise<void> => {
    await saveNovel({
      ...novel,
      volumes: novel.volumes.map((v) => ({
        ...v,
        chapters: v.chapters.map((c) => (c.id === ch.id ? { ...c, title } : c)),
      })),
    })
    if (activeChapter?.id === ch.id) setActiveChapter({ ...ch, title })
  }

  // 切换章节草稿↔定稿状态
  const toggleStatus = async (ch: Chapter): Promise<void> => {
    const next: Chapter['status'] = ch.status === 'done' ? 'draft' : 'done'
    await saveNovel({
      ...novel,
      volumes: novel.volumes.map((v) => ({
        ...v,
        chapters: v.chapters.map((c) => (c.id === ch.id ? { ...c, status: next } : c)),
      })),
    })
    if (activeChapter?.id === ch.id) setActiveChapter({ ...ch, status: next })
  }

  // Volume.排序：dir=-1 上移 / +1 下移。同时重排 order 字段。
  const moveVolume = async (vid: string, dir: -1 | 1): Promise<void> => {
    const idx = novel.volumes.findIndex((v) => v.id === vid)
    const to = idx + dir
    if (idx === -1 || to < 0 || to >= novel.volumes.length) return
    const volumes = [...novel.volumes]
    ;[volumes[idx], volumes[to]] = [volumes[to], volumes[idx]]
    await saveNovel({ ...novel, volumes: volumes.map((v, i) => ({ ...v, order: i })) })
  }

  // 章排序（Volume.内）：dir=-1 上移 / +1 下移。同时重排 order 字段。
  const moveChapter = async (vol: Volume, cid: string, dir: -1 | 1): Promise<void> => {
    const idx = vol.chapters.findIndex((c) => c.id === cid)
    const to = idx + dir
    if (idx === -1 || to < 0 || to >= vol.chapters.length) return
    const chapters = [...vol.chapters]
    ;[chapters[idx], chapters[to]] = [chapters[to], chapters[idx]]
    await saveNovel({
      ...novel,
      volumes: novel.volumes.map((v) =>
        v.id === vol.id ? { ...v, chapters: chapters.map((c, i) => ({ ...c, order: i })) } : v,
      ),
    })
  }

  const deleteChapter = async (ch: Chapter): Promise<void> => {
    const sourceVolume = novel.volumes.find((volume) =>
      volume.chapters.some((chapter) => chapter.id === ch.id),
    )
    const sourceIndex = sourceVolume?.chapters.findIndex((chapter) => chapter.id === ch.id) ?? -1
    if (!sourceVolume || sourceIndex < 0) return
    if (
      !confirm(
        `Remove "${ch.title}" from the contents? The prose and generation evidence stay on disk, and you can undo this action.`,
      )
    )
      return
    await saveNovel({
      ...novel,
      volumes: novel.volumes.map((v) => ({
        ...v,
        chapters: v.chapters.filter((c) => c.id !== ch.id),
      })),
    })
    if (activeChapter?.id === ch.id) setActiveChapter(null)
    const deletedWorldId = currentWorldId
    toastSuccess(`"${ch.title}" removed from the contents.`, {
      label: 'Undo',
      onClick: async () => {
        const state = useStore.getState()
        if (!deletedWorldId || state.currentWorldId !== deletedWorldId) {
          throw new Error('Return to the original world before restoring this chapter.')
        }
        const currentNovel = state.novel
        if (!currentNovel) throw new Error('The current novel is unavailable.')
        if (
          currentNovel.volumes.some((volume) =>
            volume.chapters.some((chapter) => chapter.id === ch.id),
          )
        ) {
          toastSuccess(`"${ch.title}" is already in the contents.`)
          return
        }
        const targetVolume = currentNovel.volumes.find((volume) => volume.id === sourceVolume.id)
        if (!targetVolume) throw new Error('The original volume no longer exists.')
        const restoredChapters = [...targetVolume.chapters]
        restoredChapters.splice(Math.min(sourceIndex, restoredChapters.length), 0, ch)
        await state.saveNovel({
          ...currentNovel,
          volumes: currentNovel.volumes.map((volume) =>
            volume.id === targetVolume.id
              ? {
                  ...volume,
                  chapters: restoredChapters.map((chapter, index) => ({
                    ...chapter,
                    order: index,
                  })),
                }
              : volume,
          ),
        })
        setExpanded((current) => new Set(current).add(targetVolume.id))
        setActiveChapter(ch)
        toastSuccess(`"${ch.title}" restored.`)
      },
    })
  }

  const toggle = (vid: string): void =>
    setExpanded((s) => {
      const n = new Set(s)
      if (n.has(vid)) n.delete(vid)
      else n.add(vid)
      return n
    })

  // 禅模式：全屏纯净写作
  if (zen && activeChapter) {
    return (
      <div className="h-full flex flex-col bg-ink-950">
        <div className="flex items-center justify-between px-6 py-2 text-xs text-ink-500">
          <span>{activeChapter.title}</span>
          <div className="flex items-center gap-4 tabular-nums">
            <span>{wordCount(content).toLocaleString()} words</span>
            <span className={clsx(todayWords > 0 && 'text-star-success')}>
              Today +{todayWords.toLocaleString()}
            </span>
            <span>{dirty ? '● Unsaved' : 'Saved'}</span>
            <button
              onClick={() => setZen(false)}
              className="icon-btn flex items-center gap-1 hover:text-ink-body text-xs"
              title="Exit zen mode"
            >
              <Minimize2 size={13} /> Exit Zen (Esc)
            </button>
          </div>
        </div>
        <div className="flex-1 min-h-0">
          <MarkdownEditor ref={editorRef} value={content} onChange={onEdit} zen />
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex">
      {/* 目录树 */}
      <aside className={clsx('w-64 shrink-0 border-r border-ink-800 bg-ink-900 overflow-y-auto')}>
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-ink-800 sticky top-0 bg-ink-900 z-10">
          <h2 className="text-sm font-semibold text-ink-body">Contents</h2>
          <button
            onClick={addVolume}
            className="icon-btn hover:text-star-accent"
            title="New volume"
          >
            <Plus size={16} />
          </button>
        </div>
        <div className="py-2">
          {novel.volumes.length === 0 && (
            <p className="px-4 py-6 text-xs text-ink-500 text-center leading-relaxed">
              No volumes yet. Click + in the top right to add your first volume.
            </p>
          )}
          {novel.volumes.map((vol, vi) => (
            <div key={vol.id} className="mb-1">
              <div className="group flex items-center gap-1 px-2 py-1.5">
                <button
                  onClick={() => toggle(vol.id)}
                  className="icon-btn hover:text-ink-muted"
                  title="Expand / collapse volume"
                >
                  {expanded.has(vol.id) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
                <input
                  className="flex-1 bg-transparent text-sm font-medium text-ink-muted outline-none focus:text-star-accent min-w-0"
                  defaultValue={vol.title}
                  onBlur={(e) =>
                    e.target.value !== vol.title && renameVolume(vol.id, e.target.value)
                  }
                />
                <button
                  onClick={() => moveVolume(vol.id, -1)}
                  disabled={vi === 0}
                  className="icon-btn opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-ink-muted disabled:opacity-0 shrink-0"
                  title="Move volume up"
                >
                  <ArrowUp size={13} />
                </button>
                <button
                  onClick={() => moveVolume(vol.id, 1)}
                  disabled={vi === novel.volumes.length - 1}
                  className="icon-btn opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-ink-muted disabled:opacity-0 shrink-0"
                  title="Move volume down"
                >
                  <ArrowDown size={13} />
                </button>
                <button
                  onClick={() => addChapter(vol)}
                  className="icon-btn opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-star-accent shrink-0"
                  title="New chapter"
                >
                  <Plus size={14} />
                </button>
              </div>
              {expanded.has(vol.id) &&
                vol.chapters.map((ch, ci) => (
                  <div
                    key={ch.id}
                    role="button"
                    tabIndex={0}
                    aria-current={activeChapter?.id === ch.id ? 'page' : undefined}
                    onClick={() => setActiveChapter(ch)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setActiveChapter(ch)
                      }
                    }}
                    className={clsx(
                      'group flex items-center gap-2 pl-8 pr-2 py-1.5 cursor-pointer text-sm',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-star-accent/40 focus-visible:ring-inset',
                      activeChapter?.id === ch.id
                        ? 'bg-ink-700 text-ink-deep'
                        : 'text-ink-faint hover:bg-ink-800',
                    )}
                  >
                    {ch.status === 'done' ? (
                      <CircleCheck size={13} className="shrink-0 text-star-success" />
                    ) : (
                      <FileText size={13} className="shrink-0 text-ink-500" />
                    )}
                    <span className="flex-1 truncate">{ch.title}</span>
                    <span className="text-[11px] text-ink-500 shrink-0 group-hover:hidden">
                      {ch.wordCount > 0 ? `${(ch.wordCount / 1000).toFixed(1)}k` : ''}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        moveChapter(vol, ch.id, -1)
                      }}
                      disabled={ci === 0}
                      className="icon-btn hidden group-hover:inline-flex focus-visible:inline-flex hover:text-ink-muted disabled:opacity-30 shrink-0"
                      title="Move up"
                    >
                      <ArrowUp size={12} />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        moveChapter(vol, ch.id, 1)
                      }}
                      disabled={ci === vol.chapters.length - 1}
                      className="icon-btn hidden group-hover:inline-flex focus-visible:inline-flex hover:text-ink-muted disabled:opacity-30 shrink-0"
                      title="Move down"
                    >
                      <ArrowDown size={12} />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        deleteChapter(ch)
                      }}
                      className="icon-btn opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-star-danger shrink-0"
                      title="Delete chapter"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
            </div>
          ))}
        </div>
      </aside>

      {/* 编辑器 */}
      <div className="flex-1 min-w-0 flex flex-col">
        {activeChapter ? (
          <>
            <div className="flex items-center justify-between px-6 py-3 border-b border-ink-800">
              <input
                className="bg-transparent text-sm font-medium text-ink-body outline-none focus:text-star-accent"
                defaultValue={activeChapter.title}
                key={activeChapter.id}
                onBlur={(e) =>
                  e.target.value !== activeChapter.title &&
                  renameChapter(activeChapter, e.target.value)
                }
              />
              <div className="flex items-center gap-3 tabular-nums">
                <span className="text-xs text-ink-500">
                  {wordCount(content).toLocaleString()} words
                  {dirty && <span className="ml-2 text-star-accent">● Unsaved</span>}
                </span>
                <button
                  onClick={() => toggleStatus(activeChapter)}
                  className={clsx(
                    'btn btn-sm disabled:opacity-40',
                    activeChapter.status === 'done'
                      ? 'btn-secondary'
                      : 'btn-ghost border border-transparent',
                  )}
                  title={
                    activeChapter.status === 'done'
                      ? 'Final — click to revert to draft'
                      : 'Mark as final'
                  }
                >
                  {activeChapter.status === 'done' ? (
                    <CircleCheck size={15} className="text-star-success" />
                  ) : (
                    <CircleDashed size={15} />
                  )}
                  {activeChapter.status === 'done' ? 'Final' : 'Draft'}
                </button>
                <button
                  onClick={() => openStoryMemory(activeChapter.id)}
                  disabled={dirty}
                  className="btn btn-sm btn-ghost disabled:opacity-40"
                  title={
                    dirty
                      ? 'Save this chapter before reviewing Story Memory'
                      : 'Review continuity facts from this chapter'
                  }
                >
                  <Brain size={15} /> Story Memory
                </button>
                <div className="relative">
                  <button
                    onClick={() => setAiDropdownOpen(!aiDropdownOpen)}
                    className={clsx(
                      'btn btn-sm',
                      aiMode !== null ? 'btn-secondary text-star-info' : 'btn-ghost',
                    )}
                    title="AI-assisted writing"
                  >
                    <Sparkles size={15} /> AI Assist <ChevronDown size={12} />
                  </button>
                  {aiDropdownOpen && (
                    <>
                      <div
                        className="fixed inset-0 z-40"
                        onClick={() => setAiDropdownOpen(false)}
                      />
                      <div className="absolute right-0 top-full mt-1 w-44 bg-ink-900 border border-ink-800 rounded-lg shadow-warm-lg z-50 py-1.5">
                        <button
                          onClick={() => {
                            setAiMode(aiMode === 'outline-write' ? null : 'outline-write')
                            setAiDropdownOpen(false)
                          }}
                          className={clsx(
                            'w-full flex items-center gap-2.5 px-4 py-2 text-sm text-left transition-colors',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-star-accent/40',
                            aiMode === 'outline-write'
                              ? 'bg-star-info/10 text-star-info'
                              : 'text-ink-muted hover:bg-ink-850 hover:text-ink-body',
                          )}
                        >
                          <BookOpen size={15} />
                          <span>Outline</span>
                        </button>
                        <button
                          onClick={() => {
                            setAiMode(aiMode === 'continue' ? null : 'continue')
                            setAiDropdownOpen(false)
                          }}
                          className={clsx(
                            'w-full flex items-center gap-2.5 px-4 py-2 text-sm text-left transition-colors',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-star-accent/40',
                            aiMode === 'continue'
                              ? 'bg-star-info/10 text-star-info'
                              : 'text-ink-muted hover:bg-ink-850 hover:text-ink-body',
                          )}
                        >
                          <Play size={15} />
                          <span>Continue</span>
                        </button>
                        <button
                          onClick={() => {
                            if (aiMode === 'rewrite') {
                              setAiMode(null)
                              setAiSelection(null)
                            } else {
                              const sel = editorRef.current?.getSelection() ?? null
                              setAiSelection(sel)
                              setAiMode('rewrite')
                            }
                            setAiDropdownOpen(false)
                          }}
                          className={clsx(
                            'w-full flex items-center gap-2.5 px-4 py-2 text-sm text-left transition-colors',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-star-accent/40',
                            aiMode === 'rewrite'
                              ? 'bg-star-info/10 text-star-info'
                              : 'text-ink-muted hover:bg-ink-850 hover:text-ink-body',
                          )}
                          title="Rewrite the selected passage, or the whole chapter if nothing is selected"
                        >
                          <RefreshCw size={15} />
                          <span>Rewrite</span>
                        </button>
                        <button
                          onClick={() => {
                            if (aiMode === 'polish') {
                              setAiMode(null)
                              setAiSelection(null)
                            } else {
                              const sel = editorRef.current?.getSelection() ?? null
                              setAiSelection(sel)
                              setAiMode('polish')
                            }
                            setAiDropdownOpen(false)
                          }}
                          className={clsx(
                            'w-full flex items-center gap-2.5 px-4 py-2 text-sm text-left transition-colors',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-star-accent/40',
                            aiMode === 'polish'
                              ? 'bg-star-info/10 text-star-info'
                              : 'text-ink-muted hover:bg-ink-850 hover:text-ink-body',
                          )}
                        >
                          <Sparkles size={15} />
                          <span>Polish</span>
                        </button>
                      </div>
                    </>
                  )}
                </div>
                <button onClick={() => setZen(true)} className="btn btn-sm btn-ghost">
                  <Maximize2 size={15} /> Zen
                </button>
                <button onClick={saveChapter} className="btn btn-sm btn-primary">
                  <Save size={15} /> Save
                </button>
              </div>
            </div>
            <div className="flex-1 min-h-0 flex">
              <div className="flex-1 min-w-0 min-h-0 flex flex-col">
                <div className="flex-1 min-h-0">
                  <MarkdownEditor ref={editorRef} value={content} onChange={onEdit} />
                </div>
                {/* 实时统计条 */}
                <div className="flex items-center gap-4 px-6 py-1.5 border-t border-ink-800 text-[11px] text-ink-500 bg-ink-900 tabular-nums">
                  <span>This chapter {liveWords.toLocaleString()} words</span>
                  <span>Book {totalWords.toLocaleString()} words</span>
                  <span className={clsx(todayWords > 0 && 'text-star-success')}>
                    Today +{todayWords.toLocaleString()}
                  </span>
                  <span className="ml-auto">
                    ~{Math.max(1, Math.round(liveWords / 500))} min read
                  </span>
                </div>
              </div>
              {aiMode && (
                <AiAssistPanel
                  mode={aiMode}
                  content={content}
                  selectedText={aiSelection?.text}
                  chapterId={activeChapter.id}
                  chapterTitle={activeChapter.title}
                  onInsert={(text, evidence) => {
                    if (evidence) {
                      generationEdits.current.set(activeChapter.id, evidence)
                      generationLinksResolved.current.add(activeChapter.id)
                    }
                    if ((aiMode === 'polish' || aiMode === 'rewrite') && aiSelection) {
                      // The selection was captured when the panel opened; if the editor
                      // content changed since, splicing on stale offsets would corrupt
                      // the chapter — refuse instead of silently overwriting.
                      if (content.slice(aiSelection.from, aiSelection.to) === aiSelection.text) {
                        const before = content.slice(0, aiSelection.from)
                        const after = content.slice(aiSelection.to)
                        onEdit(before + text + after)
                      } else {
                        toastError(
                          'Selection changed while the panel was open — the result was not applied.',
                        )
                      }
                      setAiSelection(null)
                    } else if (aiMode === 'polish' || aiMode === 'rewrite') {
                      // Replace the whole chapter body when no selection is active.
                      onEdit(text)
                    } else {
                      onEdit(content + '\n\n' + text)
                    }
                  }}
                  onClose={() => {
                    setAiMode(null)
                    setAiSelection(null)
                  }}
                />
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <EmptyState
              icon={FileText}
              title="No chapter open"
              description="Select a chapter from the left, or create a volume and chapter to start writing."
            />
          </div>
        )}
      </div>
    </div>
  )
}
