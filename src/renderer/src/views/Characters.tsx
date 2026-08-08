import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import MarkdownEditor from '../components/MarkdownEditor'
import AiAssistPanel, { SETTING_ASSIST } from '../components/AiAssistPanel'
import EmptyState from '../components/EmptyState'
import { toastError, toastSuccess } from '../toast'
import type { SettingDocContent } from '@shared/types'
import { Plus, Trash2, Save, Sparkles, UserRound, Search } from 'lucide-react'
import { formatTime, resolveWikilink } from '../lib'
import clsx from 'clsx'

/**
 * Characters — one codex document per character (category '11-character').
 * A character roster on the left (name + last update, searchable), the same
 * markdown editor as Codex on the right. Reuses the codex storage layer:
 * docs live in settings/11-character/<name>.md and are one entity per file.
 */
export default function Characters(): JSX.Element {
  const settingDocs = useStore((s) => s.settingDocs)
  const refreshSettings = useStore((s) => s.refreshSettings)

  const [activeId, setActiveId] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const [showAi, setShowAi] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [search, setSearch] = useState('')

  // Character docs of the current world (incl. read-only external mappings).
  // listSettings already sorts by title with natural ordering.
  const characters = settingDocs.filter((d) => d.category === '11-character')
  const q = search.trim().toLowerCase()
  const filtered = q ? characters.filter((d) => d.title.toLowerCase().includes(q)) : characters

  // Holds latest edit state for flushing dirty content before switch/unmount.
  const flushRef = useRef({ activeId, content, dirty })
  flushRef.current = { activeId, content, dirty }

  // 把当前脏内容写回磁盘(若有)。切文档、新建、离开视图前调用,避免静默丢失。
  const flush = async (): Promise<void> => {
    const { activeId: id, content: c, dirty: d } = flushRef.current
    if (!id || !d) return
    try {
      await window.api.writeSetting(id, c)
    } catch (e) {
      toastError('Failed to save document: ' + (e as Error).message)
    }
  }

  // 载入选中的文档
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

  // 离开视图(组件卸载)前把未保存内容写回
  useEffect(() => {
    return () => {
      void flush()
    }
  }, [])

  const handleWikilinkClick = (title: string): void => {
    const target = resolveWikilink(title, settingDocs)
    if (target) setActiveId(target.id)
  }

  // 切换到另一位人物前,先把当前脏内容写回
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
        void save()
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  })

  const doCreate = async (): Promise<void> => {
    await flush() // 先把当前脏内容写回,避免新建后切走丢失
    try {
      const doc = await window.api.createSetting('11-character', newName.trim() || 'Untitled')
      await refreshSettings()
      setActiveId(doc.id)
      setCreating(false)
      setNewName('')
      toastSuccess(`"${doc.title}" created.`)
    } catch (e) {
      toastError('Failed to create character: ' + (e as Error).message)
    }
  }

  const doDelete = async (id: string): Promise<void> => {
    if (!confirm('Delete this character document? This cannot be undone.')) return
    try {
      await window.api.deleteSetting(id)
      if (activeId === id) setActiveId(null)
      refreshSettings()
      toastSuccess('Character deleted.')
    } catch (e) {
      toastError('Failed to delete: ' + (e as Error).message)
    }
  }

  // 当前打开的人物文档;外部映射文档带 external 标记(只读)。
  const activeDoc = characters.find((d) => d.id === activeId) ?? null
  const activeIsExternal = !!activeDoc?.external

  return (
    <div className="h-full flex">
      {/* 人物列表 */}
      <aside className="w-64 shrink-0 border-r border-ink-800 bg-ink-900 overflow-y-auto">
        <div className="px-4 py-3.5 border-b border-ink-800 sticky top-0 bg-ink-900 z-10 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink-body">Characters</h2>
          <button
            onClick={() => {
              setCreating(true)
              setNewName('')
            }}
            className="icon-btn hover:text-star-accent"
            title="New character"
          >
            <Plus size={16} />
          </button>
        </div>
        <div className="px-3 pt-2 pb-1 sticky top-[53px] bg-ink-900 z-10">
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-600" />
            <input
              className="input text-xs py-1 pl-7 w-full"
              placeholder="Search characters…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
        <div className="py-2">
          {creating && (
            <div className="px-3 py-1.5">
              <input
                autoFocus
                className="input text-xs py-1"
                placeholder="Character name, press Enter to create"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void doCreate()
                  if (e.key === 'Escape') setCreating(false)
                }}
                onBlur={() => !newName && setCreating(false)}
              />
            </div>
          )}
          {filtered.map((d) => (
            <div
              key={d.id}
              role="button"
              tabIndex={0}
              aria-current={activeId === d.id ? 'page' : undefined}
              className={clsx(
                'group flex items-center gap-2 px-3 py-1.5 cursor-pointer text-sm',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-star-accent/40 focus-visible:ring-inset',
                activeId === d.id ? 'bg-ink-700 text-ink-deep' : 'text-ink-faint hover:bg-ink-800',
              )}
              onClick={() => void switchDoc(d.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  void switchDoc(d.id)
                }
              }}
            >
              <span className="flex-1 min-w-0">
                <span className="block truncate">{d.title}</span>
                <span className="block text-[10px] text-ink-600">{formatTime(d.updatedAt)}</span>
              </span>
              {d.external && (
                <span
                  className="text-[9px] uppercase tracking-wide text-star-info bg-star-info/10 rounded px-1 py-0.5 shrink-0"
                  title="Read-only · external folder"
                >
                  ext
                </span>
              )}
              {!d.external && (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    void doDelete(d.id)
                  }}
                  className="icon-btn opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-star-danger shrink-0"
                  title="Delete this character"
                >
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          ))}
          {filtered.length === 0 && !creating && (
            <div className="px-4 py-6 text-xs text-ink-500 text-center">
              {characters.length === 0
                ? 'No characters yet. Click + in the top right to create one.'
                : 'No characters match your search.'}
            </div>
          )}
        </div>
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
                  <span className="text-[11px] text-ink-500 flex items-center gap-1.5">
                    Read-only · external folder
                  </span>
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
                    <button onClick={() => void save()} className="btn btn-sm btn-primary">
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
              icon={UserRound}
              title="No character open"
              description="Select or create a character from the left to start editing."
            />
          </div>
        )}
      </div>
    </div>
  )
}
