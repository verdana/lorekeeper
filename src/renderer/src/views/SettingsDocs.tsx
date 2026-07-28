import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import MarkdownEditor from '../components/MarkdownEditor'
import AiAssistPanel, { SETTING_ASSIST } from '../components/AiAssistPanel'
import EmptyState from '../components/EmptyState'
import { toastError, toastSuccess } from '../toast'
import type { SettingDocContent } from '@shared/types'
import {
  Plus,
  Trash2,
  Save,
  Sparkles,
  BookText,
  Link2,
  BarChart3,
  ChevronDown,
  ChevronRight,
} from 'lucide-react'
import {
  CATEGORY_ICONS,
  CATEGORY_COLORS,
  extractWikilinks,
  resolveWikilink,
  wordCount,
  assessDocDevelopment,
  type DocDevelopmentInfo,
} from '../lib'
import clsx from 'clsx'

export default function SettingsDocs(): JSX.Element {
  const settingDocs = useStore((s) => s.settingDocs)
  const refreshSettings = useStore((s) => s.refreshSettings)

  const [activeId, setActiveId] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const [showAi, setShowAi] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [backlinks, setBacklinks] = useState<{ title: string; id: string }[]>([])
  const [showStats, setShowStats] = useState(false)
  const [thinExpanding, setThinExpanding] = useState<string | null>(null)
  const [docWordCounts, setDocWordCounts] = useState<Record<string, number>>({})
  const [docDev, setDocDev] = useState<Record<string, DocDevelopmentInfo>>({})

  // Holds latest edit state for flushing dirty content before switch/unmount.
  const flushRef = useRef({ activeId, content, dirty })
  flushRef.current = { activeId, content, dirty }

  // 把当前脏内容写回磁盘（若有）。切文档、新建、离开视图前调用，避免静默丢失。
  const flush = async (): Promise<void> => {
    const { activeId: id, content: c, dirty: d } = flushRef.current
    if (!id || !d) return
    try {
      await window.api.writeSetting(id, c)
    } catch (e) {
      toastError('Failed to save document: ' + (e as Error).message)
    }
  }

  // 载入选中文档
  useEffect(() => {
    if (!activeId) {
      setContent('')
      return
    }
    window.api.readSetting(activeId).then((doc: SettingDocContent) => {
      setContent(doc.content)
      setDirty(false)
    })
  }, [activeId])

  // 离开视图（组件卸载）前把未保存内容写回
  useEffect(() => {
    return () => {
      flush()
    }
  }, [])

  // Listen for navigation events from Graph view
  useEffect(() => {
    const handler = (e: CustomEvent<{ docId: string }>) => {
      setActiveId(e.detail.docId)
    }
    window.addEventListener('codex-navigate', handler as EventListener)
    return () => window.removeEventListener('codex-navigate', handler as EventListener)
  }, [])

  // Scan for backlinks when a document is selected
  useEffect(() => {
    if (!activeId) {
      setBacklinks([])
      return
    }
    const activeTitle = activeId.split('/')[1]?.replace(/\.md$/, '') ?? ''
    let cancelled = false
    ;(async () => {
      const results: { title: string; id: string }[] = []
      for (const doc of settingDocs) {
        if (doc.id === activeId) continue
        try {
          const { content } = await window.api.readSetting(doc.id)
          if (cancelled) return
          const refs = extractWikilinks(content)
          if (refs.some((r) => r.toLowerCase() === activeTitle.toLowerCase())) {
            results.push({ title: doc.title, id: doc.id })
          }
        } catch {
          // skip unreadable docs
        }
      }
      if (!cancelled) setBacklinks(results)
    })()
    return () => {
      cancelled = true
    }
  }, [activeId, settingDocs])

  // Compute word counts for all docs
  useEffect(() => {
    ;(async () => {
      const counts: Record<string, number> = {}
      const dev: Record<string, DocDevelopmentInfo> = {}
      for (const doc of settingDocs) {
        try {
          const { content } = await window.api.readSetting(doc.id)
          counts[doc.id] = wordCount(content)
          dev[doc.id] = assessDocDevelopment(content)
        } catch {
          counts[doc.id] = 0
          dev[doc.id] = { level: 'stub', bodyWords: 0, reason: 'empty' }
        }
      }
      setDocWordCounts(counts)
      setDocDev(dev)
    })()
  }, [settingDocs])

  // Stats computation
  const stats = (() => {
    const allCounts = Object.values(docWordCounts)
    const totalWords = allCounts.reduce((a, b) => a + b, 0)
    // Flag docs by absolute per-document signals (empty / placeholder / stub),
    // not a relative average, so short-but-complete entries are not penalized.
    const thinDocs = settingDocs.filter((d) => docDev[d.id]?.level === 'stub')
    return { thinDocs, totalWords }
  })()

  const handleWikilinkClick = (title: string): void => {
    const target = resolveWikilink(title, settingDocs)
    if (target) setActiveId(target.id)
  }

  // 切换到另一份文档前，先把当前脏内容写回
  const switchDoc = async (id: string): Promise<void> => {
    if (id === activeId) return
    await flush()
    if (flushRef.current.dirty) refreshSettings()
    setActiveId(id)
  }

  const save = async (): Promise<void> => {
    if (!activeId) return
    try {
      await window.api.writeSetting(activeId, content)
      setDirty(false)
      refreshSettings()
    } catch (e) {
      toastError('Failed to save: ' + (e as Error).message)
    }
  }

  // Ctrl+S 保存
  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        save()
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  })

  const doCreate = async (): Promise<void> => {
    await flush() // 先把当前脏内容写回，避免新建后切走丢失
    try {
      const doc = await window.api.createSetting('misc', newTitle.trim() || 'Untitled')
      await refreshSettings()
      setActiveId(doc.id)
      setCreating(false)
      setNewTitle('')
      toastSuccess(`"${doc.title}" created.`)
    } catch (e) {
      toastError('Failed to create document: ' + (e as Error).message)
    }
  }

  const doDelete = async (id: string): Promise<void> => {
    if (!confirm('Delete this codex document? This cannot be undone.')) return
    try {
      await window.api.deleteSetting(id)
      if (activeId === id) setActiveId(null)
      refreshSettings()
      toastSuccess('Document deleted.')
    } catch (e) {
      toastError('Failed to delete: ' + (e as Error).message)
    }
  }

  return (
    <div className="h-full flex">
      {/* 文档列表 */}
      <aside className="w-64 shrink-0 border-r border-ink-800 bg-ink-900 overflow-y-auto">
        <div className="px-4 py-3.5 border-b border-ink-800 sticky top-0 bg-ink-900 z-10 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink-body">Codex</h2>
          <button
            onClick={() => {
              setCreating(true)
              setNewTitle('')
            }}
            className="icon-btn hover:text-star-accent"
            title="New document"
          >
            <Plus size={16} />
          </button>
        </div>
        <div className="py-2">
          {creating && (
            <div className="px-3 py-1.5">
              <input
                autoFocus
                className="input text-xs py-1"
                placeholder="Document title, press Enter to create"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') doCreate()
                  if (e.key === 'Escape') setCreating(false)
                }}
                onBlur={() => !newTitle && setCreating(false)}
              />
            </div>
          )}
          {settingDocs.map((d) => {
            const Icon = CATEGORY_ICONS[d.category]
            return (
              <div
                key={d.id}
                role="button"
                tabIndex={0}
                aria-current={activeId === d.id ? 'page' : undefined}
                className={clsx(
                  'group flex items-center gap-2 px-4 py-1.5 cursor-pointer text-sm',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-star-accent/40 focus-visible:ring-inset',
                  activeId === d.id
                    ? 'bg-ink-700 text-ink-deep'
                    : 'text-ink-faint hover:bg-ink-800',
                )}
                onClick={() => switchDoc(d.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    switchDoc(d.id)
                  }
                }}
              >
                <Icon
                  size={14}
                  className="shrink-0"
                  style={{ color: CATEGORY_COLORS[d.category] }}
                />
                <span className="flex-1 truncate">{d.title}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    doDelete(d.id)
                  }}
                  className="icon-btn opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-star-danger shrink-0"
                  title="Delete this document"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            )
          })}
          {settingDocs.length === 0 && !creating && (
            <div className="px-4 py-6 text-xs text-ink-500 text-center">
              No codex documents yet. Click + in the top right to create one.
            </div>
          )}
        </div>

        {/* Codex Stats */}
        <div className="border-t border-ink-800">
          <button
            onClick={() => setShowStats(!showStats)}
            className="w-full flex items-center gap-2 px-4 py-2.5 text-xs text-ink-500 hover:text-ink-body hover:bg-ink-850 transition-colors"
          >
            {showStats ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <BarChart3 size={13} />
            Codex Stats
            <span className="ml-auto text-[11px] text-ink-600">
              {settingDocs.length} docs, {(stats.totalWords / 1000).toFixed(1)}k words
            </span>
          </button>
          {showStats && (
            <div className="px-4 pb-3 space-y-2">
              {(['worldview', 'character', 'geography', 'economy', 'outline', 'misc'] as const).map(
                (cat) => {
                  const catDocs = settingDocs.filter((d) => d.category === cat)
                  return (
                    <div key={cat} className="flex items-center gap-2 text-xs">
                      <div
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: CATEGORY_COLORS[cat] }}
                      />
                      <span className="flex-1 text-ink-500 truncate">
                        {cat.charAt(0).toUpperCase() + cat.slice(1)}
                      </span>
                      <span className="text-ink-400">{catDocs.length} docs</span>
                    </div>
                  )
                },
              )}
              {stats.thinDocs.length > 0 && (
                <div className="pt-2 border-t border-ink-800/50">
                  <div className="text-[11px] text-star-accent mb-1.5">Under-developed docs</div>
                  {stats.thinDocs.map((d) => (
                    <div key={d.id} className="flex items-center gap-1.5 pl-1">
                      <button
                        onClick={() => {
                          setActiveId(d.id)
                          setShowAi(true)
                        }}
                        className="flex-1 text-left text-xs text-ink-muted hover:text-ink-body py-1 truncate"
                      >
                        {d.title}
                        <span className="ml-1.5 text-[10px] text-ink-500">
                          {docDev[d.id]?.reason === 'empty'
                            ? 'empty'
                            : docDev[d.id]?.reason === 'placeholder'
                              ? 'placeholder'
                              : `${docDev[d.id]?.bodyWords ?? 0}w`}
                        </span>
                      </button>
                      <button
                        onClick={async () => {
                          // Open the doc and trigger AI assist with expand prompt
                          setActiveId(d.id)
                          setShowAi(true)
                        }}
                        className="text-[10px] px-1.5 py-0.5 rounded text-star-accent hover:bg-star-accent/10 transition-colors shrink-0"
                        title="Open and expand this document"
                      >
                        <Sparkles size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Backlinks panel */}
        {activeId && backlinks.length > 0 && (
          <div className="border-t border-ink-800 px-4 py-3">
            <div className="text-[11px] text-ink-500 flex items-center gap-1.5 mb-2">
              <Link2 size={12} />
              Referenced by ({backlinks.length})
            </div>
            <div className="space-y-0.5">
              {backlinks.map((bl) => (
                <button
                  key={bl.id}
                  onClick={() => switchDoc(bl.id)}
                  className="block w-full text-left text-xs text-star-accent hover:text-star-accent/80 px-2 py-1 rounded-sm hover:bg-ink-800 transition-colors truncate focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-star-accent/40"
                >
                  {bl.title}
                </button>
              ))}
            </div>
          </div>
        )}
      </aside>

      {/* 编辑区 */}
      <div className="flex-1 min-w-0 flex flex-col">
        {activeId ? (
          <>
            <div className="flex items-center justify-between px-6 py-3 border-b border-ink-800">
              <div className="min-w-0">
                <div className="text-sm font-medium text-ink-body truncate">
                  {activeId.split('/')[1]?.replace(/\.md$/, '')}
                  {dirty && <span className="ml-2 text-star-accent text-xs">● Unsaved</span>}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowAi((v) => !v)}
                  className={clsx(
                    'btn btn-sm',
                    showAi ? 'btn-secondary text-star-info' : 'btn-ghost',
                  )}
                  title="AI writing assistant"
                >
                  <Sparkles size={15} />
                  AI Assist
                </button>
                <button onClick={save} className="btn btn-sm btn-primary">
                  <Save size={15} />
                  Save
                </button>
              </div>
            </div>
            <div className="flex-1 min-h-0 flex">
              <div className="flex-1 min-w-0 min-h-0">
                <MarkdownEditor
                  value={content}
                  onWikilinkClick={handleWikilinkClick}
                  defaultMode="read"
                  onChange={(v) => {
                    setContent(v)
                    setDirty(true)
                  }}
                />
              </div>
              {showAi && (
                <AiAssistPanel
                  mode="polish"
                  content={content}
                  chapterId={activeId}
                  chapterTitle={activeId?.split('/')[1]?.replace(/\.md$/, '') ?? ''}
                  polishPreset={SETTING_ASSIST}
                  onInsert={(text) => {
                    setContent((c) => c + '\n\n' + text)
                    setDirty(true)
                  }}
                  onClose={() => setShowAi(false)}
                />
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <EmptyState
              icon={BookText}
              title="No document open"
              description="Select or create a codex document from the left to start editing."
            />
          </div>
        )}
      </div>
    </div>
  )
}
