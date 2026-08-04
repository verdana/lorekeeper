import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import MarkdownEditor from '../components/MarkdownEditor'
import AiAssistPanel, { SETTING_ASSIST } from '../components/AiAssistPanel'
import EmptyState from '../components/EmptyState'
import { toastError, toastSuccess } from '../toast'
import type { ExternalMapping, SettingCategory, SettingDoc, SettingDocContent } from '@shared/types'
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
  FolderOpen,
  RefreshCw,
  FolderPlus,
  Copy,
  X,
} from 'lucide-react'
import {
  CATEGORY_ICONS,
  CATEGORY_COLORS,
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  extractWikilinks,
  resolveWikilink,
  wordCount,
  assessDocDevelopment,
  type DocDevelopmentInfo,
} from '../lib'
import clsx from 'clsx'

// Resolve a doc to its display category, falling back to misc for unknown ones.
const categoryOf = (d: SettingDoc): SettingCategory =>
  CATEGORY_ORDER.includes(d.category) ? d.category : '99-misc'

export default function SettingsDocs(): JSX.Element {
  const settingDocs = useStore((s) => s.settingDocs)
  const refreshSettings = useStore((s) => s.refreshSettings)
  const settingFocusId = useStore((s) => s.settingFocusId)
  const clearSettingFocus = useStore((s) => s.clearSettingFocus)

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
  // Collapsed category groups in the document list (default: all expanded).
  const [collapsedCats, setCollapsedCats] = useState<Record<string, boolean>>({})
  // External folder mappings (read-only codex sources).
  const [mappings, setMappings] = useState<ExternalMapping[]>([])
  const [showMappings, setShowMappings] = useState(false)
  const [addingMapping, setAddingMapping] = useState(false)
  const [mappingPath, setMappingPath] = useState('')
  const [mappingCategory, setMappingCategory] = useState<SettingCategory>('99-misc')
  // Copy-external-doc-into-world dialog.
  const [copying, setCopying] = useState<SettingDoc | null>(null)
  const [copyCategory, setCopyCategory] = useState<SettingCategory>('99-misc')
  const [copyAsNew, setCopyAsNew] = useState(false)

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

  useEffect(() => {
    if (!settingFocusId) return
    setActiveId(settingFocusId)
    clearSettingFocus()
  }, [clearSettingFocus, settingFocusId])

  // 离开视图（组件卸载）前把未保存内容写回
  useEffect(() => {
    return () => {
      flush()
    }
  }, [])

  // 选中文档时确保其所属分类展开，避免文档在折叠分组中不可见
  useEffect(() => {
    if (!activeId) return
    const [catRaw] = activeId.split('/')
    if (!(CATEGORY_ORDER as readonly string[]).includes(catRaw)) return
    const cat = catRaw as SettingCategory
    setCollapsedCats((c) => {
      if (!c[cat]) return c
      const next = { ...c }
      delete next[cat]
      return next
    })
  }, [activeId])

  // 清除已无文档的分类的折叠状态，避免残留导致之后新增文档默认折叠
  useEffect(() => {
    setCollapsedCats((c) => {
      const keys = Object.keys(c)
      if (keys.length === 0) return c
      const next = { ...c }
      let changed = false
      for (const k of keys) {
        if (!settingDocs.some((d) => categoryOf(d) === k)) {
          delete next[k]
          changed = true
        }
      }
      return changed ? next : c
    })
  }, [settingDocs])

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
    const activeTitle = settingDocs.find((d) => d.id === activeId)?.title ?? ''
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
      const doc = await window.api.createSetting('99-misc', newTitle.trim() || 'Untitled')
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

  // 当前打开的文档；外部映射文档带 external 标记（只读）。
  const activeDoc = settingDocs.find((d) => d.id === activeId) ?? null
  const activeIsExternal = !!activeDoc?.external

  const loadMappings = async (): Promise<void> => {
    try {
      setMappings(await window.api.listExternalMappings())
    } catch (e) {
      toastError('Failed to load external folders: ' + (e as Error).message)
    }
  }

  useEffect(() => {
    if (showMappings) void loadMappings()
  }, [showMappings])

  // 挂载时加载映射：列表 badge 与只读提示需要显示映射名。
  useEffect(() => {
    void loadMappings()
  }, [])

  const pickFolderPath = async (): Promise<void> => {
    try {
      const p = await window.api.pickFolder()
      if (p) setMappingPath(p)
    } catch (e) {
      // 非 Electron 运行时：提示用户手动输入路径。
      toastError((e as Error).message)
    }
  }

  const addMapping = async (): Promise<void> => {
    const path = mappingPath.trim()
    if (!path) return
    try {
      await window.api.addExternalMapping({ rootPath: path, category: mappingCategory })
      setMappingPath('')
      setAddingMapping(false)
      await loadMappings()
      await refreshSettings()
      toastSuccess('External folder linked.')
    } catch (e) {
      toastError((e as Error).message)
    }
  }

  const removeMapping = async (id: string): Promise<void> => {
    if (!confirm('Unlink this external folder? Its files are not modified.')) return
    try {
      await window.api.removeExternalMapping(id)
      // 当前打开的外部文档若属于该映射，关闭它：避免落入“可编辑但写入被拒”
      // 的失效状态（activeDoc 已消失，编辑器却显示可编辑）。
      if (activeId?.startsWith(`external:${id}/`)) setActiveId(null)
      await loadMappings()
      await refreshSettings()
      toastSuccess('External folder unlinked.')
    } catch (e) {
      toastError('Failed to unlink: ' + (e as Error).message)
    }
  }

  const openCopy = (doc: SettingDoc): void => {
    setCopying(doc)
    setCopyCategory(doc.category)
    setCopyAsNew(false)
  }

  // 目标 category 下是否已存在同名内部文档（覆盖前需用户确认）。
  const copyConflict = copying
    ? settingDocs.some((d) => d.id === `${copyCategory}/${copying.title}.md` && !d.external)
    : false

  const doCopy = async (): Promise<void> => {
    if (!copying) return
    try {
      // 复制前重新读取该外部文档的最新内容：content state 是异步加载的，
      // 快速点击可能拿到上一份文档的 buffer。
      const { content: latest } = await window.api.readSetting(copying.id)
      const title = copyAsNew ? `${copying.title} (copy)` : copying.title
      const target = await window.api.createSetting(copyCategory, title)
      await window.api.writeSetting(target.id, latest)
      setCopying(null)
      await refreshSettings()
      setActiveId(target.id)
      toastSuccess(`"${title}" copied into the world.`)
    } catch (e) {
      toastError('Failed to copy: ' + (e as Error).message)
    }
  }

  return (
    <div className="h-full flex">
      {/* 文档列表 */}
      <aside className="w-64 shrink-0 border-r border-ink-800 bg-ink-900 overflow-y-auto">
        <div className="px-4 py-3.5 border-b border-ink-800 sticky top-0 bg-ink-900 z-10 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink-body">Codex</h2>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setShowMappings((v) => !v)}
              className={clsx(
                'icon-btn',
                showMappings ? 'text-star-info' : 'hover:text-star-accent',
              )}
              title="External folders (read-only codex sources)"
            >
              <FolderOpen size={16} />
            </button>
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
          {(() => {
            // Group docs by category, falling back to misc for unknown categories.
            const groups = new Map<SettingCategory, SettingDoc[]>()
            for (const d of settingDocs) {
              const cat = categoryOf(d)
              const arr = groups.get(cat) ?? []
              arr.push(d)
              groups.set(cat, arr)
            }
            return CATEGORY_ORDER.map((cat) => {
              const docs = groups.get(cat)
              if (!docs || docs.length === 0) return null
              const isCollapsed = !!collapsedCats[cat]
              const Icon = CATEGORY_ICONS[cat]
              return (
                <div key={cat}>
                  <button
                    type="button"
                    onClick={() => setCollapsedCats((c) => ({ ...c, [cat]: !isCollapsed }))}
                    aria-expanded={!isCollapsed}
                    className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium text-ink-500 hover:text-ink-body hover:bg-ink-850 transition-colors select-none"
                  >
                    {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                    <Icon size={13} className="shrink-0" style={{ color: CATEGORY_COLORS[cat] }} />
                    <span className="flex-1 truncate text-left">{CATEGORY_LABELS[cat]}</span>
                    <span className="text-[10px] text-ink-600">{docs.length}</span>
                  </button>
                  {!isCollapsed &&
                    docs.map((d) => (
                      <div
                        key={d.id}
                        role="button"
                        tabIndex={0}
                        aria-current={activeId === d.id ? 'page' : undefined}
                        className={clsx(
                          'group flex items-center gap-2 pl-8 pr-2 py-1.5 cursor-pointer text-sm',
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
                        <span className="flex-1 truncate">{d.title}</span>
                        {d.external && (
                          <span
                            className="text-[9px] uppercase tracking-wide text-star-info bg-star-info/10 rounded px-1 py-0.5 shrink-0"
                            title={`Read-only · external folder${
                              mappings.find((m) => m.id === d.external?.mappingId)
                                ? ` · ${mappings.find((m) => m.id === d.external?.mappingId)?.name}`
                                : ''
                            }`}
                          >
                            ext
                          </span>
                        )}
                        {!d.external && (
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
                        )}
                      </div>
                    ))}
                </div>
              )
            })
          })()}
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
              {CATEGORY_ORDER.map((cat) => {
                const catDocs = settingDocs.filter((d) => categoryOf(d) === cat)
                return (
                  <div key={cat} className="flex items-center gap-2 text-xs">
                    <div
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: CATEGORY_COLORS[cat] }}
                    />
                    <span className="flex-1 text-ink-500 truncate">{CATEGORY_LABELS[cat]}</span>
                    <span className="text-ink-500 tabular-nums">{catDocs.length} docs</span>
                  </div>
                )
              })}
              {stats.thinDocs.length > 0 && (
                <div className="pt-2 border-t border-ink-800/50">
                  <div className="text-[11px] text-star-accent mb-1.5">Under-developed docs</div>
                  {stats.thinDocs.map((d) => (
                    <div key={d.id} className="flex items-center gap-1.5 pl-1">
                      <button
                        onClick={() => {
                          setActiveId(d.id)
                          if (!d.external) setShowAi(true)
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
                      {!d.external && (
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
                      )}
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

        {/* External folder mappings (read-only codex sources) */}
        {showMappings && (
          <div className="border-t border-ink-800 px-3 py-3 space-y-2">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-ink-500">
              <FolderOpen size={12} />
              External folders
              <button
                onClick={() => void loadMappings()}
                className="icon-btn ml-auto hover:text-star-accent"
                title="Refresh"
              >
                <RefreshCw size={11} />
              </button>
            </div>
            <p className="text-[10px] text-ink-600 leading-snug">
              Link a Markdown folder (e.g. an Obsidian vault) as a read-only codex source. Files are
              never modified.
            </p>
            {mappings.length === 0 && !addingMapping && (
              <div className="text-[11px] text-ink-600">No external folders linked.</div>
            )}
            {mappings.map((m) => (
              <div key={m.id} className="flex items-center gap-1.5 text-xs">
                <span className="flex-1 min-w-0">
                  <span className="block truncate text-ink-body">{m.name}</span>
                  <span className="block truncate text-[10px] text-ink-600">{m.rootPath}</span>
                </span>
                <button
                  onClick={() => void removeMapping(m.id)}
                  className="icon-btn hover:text-star-danger shrink-0"
                  title="Unlink this folder"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            ))}
            {addingMapping ? (
              <div className="space-y-1.5">
                <div className="flex gap-1.5">
                  <input
                    autoFocus
                    className="input text-xs py-1 flex-1 min-w-0"
                    placeholder="Folder path (absolute)"
                    value={mappingPath}
                    onChange={(e) => setMappingPath(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void addMapping()
                      if (e.key === 'Escape') setAddingMapping(false)
                    }}
                  />
                  <button
                    onClick={() => void pickFolderPath()}
                    className="btn btn-sm btn-ghost shrink-0"
                    title="Choose folder…"
                  >
                    <FolderPlus size={13} />
                  </button>
                </div>
                <select
                  className="input text-xs py-1 w-full"
                  value={mappingCategory}
                  onChange={(e) => setMappingCategory(e.target.value as SettingCategory)}
                >
                  {CATEGORY_ORDER.map((c) => (
                    <option key={c} value={c}>
                      {CATEGORY_LABELS[c]}
                    </option>
                  ))}
                </select>
                <div className="flex gap-1.5">
                  <button
                    onClick={() => void addMapping()}
                    className="btn btn-sm btn-primary flex-1"
                  >
                    Link folder
                  </button>
                  <button onClick={() => setAddingMapping(false)} className="btn btn-sm btn-ghost">
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => {
                  setMappingPath('')
                  setAddingMapping(true)
                }}
                className="text-[11px] text-star-accent hover:text-star-accent/80 flex items-center gap-1"
              >
                <Plus size={11} /> Link folder
              </button>
            )}
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
                  {activeDoc?.title ?? ''}
                  {dirty && !activeIsExternal && (
                    <span className="ml-2 text-star-accent text-xs">● Unsaved</span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {activeIsExternal ? (
                  <>
                    <span className="text-[11px] text-ink-500 flex items-center gap-1.5 min-w-0">
                      <FolderOpen size={12} className="shrink-0" />
                      <span className="truncate">
                        Read-only
                        {activeDoc?.external
                          ? ` · ${
                              mappings.find((m) => m.id === activeDoc.external?.mappingId)?.name ??
                              'external folder'
                            }`
                          : ''}
                      </span>
                    </span>
                    <button
                      onClick={() => activeDoc && openCopy(activeDoc)}
                      className="btn btn-sm btn-secondary"
                      title="Copy as an editable document inside the world"
                    >
                      <Copy size={14} />
                      Copy into world
                    </button>
                  </>
                ) : (
                  <>
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
                  </>
                )}
              </div>
            </div>
            <div className="flex-1 min-h-0 flex">
              <div className="flex-1 min-w-0 min-h-0">
                <MarkdownEditor
                  value={content}
                  onWikilinkClick={handleWikilinkClick}
                  defaultMode="read"
                  readOnly={activeIsExternal}
                  onChange={(v) => {
                    if (activeIsExternal) return
                    setContent(v)
                    setDirty(true)
                  }}
                />
              </div>
              {showAi && !activeIsExternal && (
                <AiAssistPanel
                  mode="polish"
                  content={content}
                  chapterId={activeId}
                  chapterTitle={activeDoc?.title ?? ''}
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

      {/* Copy external doc into the world */}
      {copying && (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center"
          onClick={() => setCopying(null)}
        >
          <div
            className="bg-ink-900 border border-ink-800 rounded-lg w-96 p-5 space-y-3 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-ink-body">Copy into world</h3>
              <button onClick={() => setCopying(null)} className="icon-btn" title="Close">
                <X size={14} />
              </button>
            </div>
            <p className="text-xs text-ink-muted leading-snug">
              Copy <span className="text-ink-body">"{copying.title}"</span> as an editable codex
              document inside the world. The external file is only read and stays untouched.
            </p>
            <label className="block text-xs text-ink-500">
              Target category
              <select
                className="input text-xs py-1 mt-1 w-full"
                value={copyCategory}
                onChange={(e) => setCopyCategory(e.target.value as SettingCategory)}
              >
                {CATEGORY_ORDER.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABELS[c]}
                  </option>
                ))}
              </select>
            </label>
            {copyConflict && (
              <div className="text-[11px] text-star-accent space-y-1">
                <div>
                  A document named "{copying.title}" already exists in this category. Copying will
                  overwrite it.
                </div>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={copyAsNew}
                    onChange={(e) => setCopyAsNew(e.target.checked)}
                  />
                  Save as "{copying.title} (copy)" instead
                </label>
              </div>
            )}
            <div className="flex justify-end gap-1.5 pt-1">
              <button onClick={() => setCopying(null)} className="btn btn-sm btn-ghost">
                Cancel
              </button>
              <button onClick={() => void doCopy()} className="btn btn-sm btn-primary">
                <Copy size={13} />
                Copy
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
