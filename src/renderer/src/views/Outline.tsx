import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import MarkdownEditor from '../components/MarkdownEditor'
import AiAssistPanel, { SETTING_ASSIST } from '../components/AiAssistPanel'
import EmptyState from '../components/EmptyState'
import { toastError, toastSuccess } from '../toast'
import type { OutlineDoc, OutlineDocContent } from '@shared/types'
import {
  Download,
  FileText,
  List,
  Maximize2,
  Minimize2,
  Plus,
  Save,
  Sparkles,
  Trash2,
} from 'lucide-react'
import clsx from 'clsx'

export default function Outline(): JSX.Element {
  const novel = useStore((s) => s.novel)!

  const [docs, setDocs] = useState<OutlineDoc[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const [loadingDoc, setLoadingDoc] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [zen, setZen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [showAi, setShowAi] = useState(false)

  // Holds latest edit state for flushing dirty content before switch/unmount.
  const flushRef = useRef({ activeId, content, dirty })
  flushRef.current = { activeId, content, dirty }

  const refresh = async (): Promise<OutlineDoc[]> => {
    const list = await window.api.listOutlineDocs()
    setDocs(list)
    return list
  }

  // 初次加载：拉取文档列表，自动选中第一个
  useEffect(() => {
    ;(async () => {
      const list = await refresh()
      if (list.length > 0) setActiveId(list[0].id)
      setLoaded(true)
    })()
  }, [])

  // 把当前脏内容写回磁盘（若有）。切文档、新建、导出前调用，避免静默丢失。
  // 返回是否成功；失败时调用方应中止后续动作，防止未保存编辑被丢弃。
  const flush = async (): Promise<boolean> => {
    const { activeId: id, content: c, dirty: d } = flushRef.current
    if (!id || !d) return true
    try {
      await window.api.writeOutlineDoc(id, c)
      setDirty(false)
      return true
    } catch (e) {
      toastError('Failed to save document: ' + (e as Error).message)
      return false
    }
  }

  // 载入选中文档；token 守卫丢弃过期响应，避免快速切换时旧内容覆盖新文档。
  useEffect(() => {
    if (!activeId) {
      setContent('')
      setLoadingDoc(false)
      return
    }
    let cancelled = false
    setLoadingDoc(true)
    window.api
      .readOutlineDoc(activeId)
      .then((doc: OutlineDocContent) => {
        if (cancelled) return
        setContent(doc.content)
        setDirty(false)
        setLoadingDoc(false)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setLoadingDoc(false)
        toastError('Failed to load document: ' + (e as Error).message)
      })
    return () => {
      cancelled = true
    }
  }, [activeId])

  // 离开视图（组件卸载）前把未保存内容写回
  useEffect(() => {
    return () => {
      flush()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const switchDoc = async (id: string): Promise<void> => {
    if (id === activeId) return
    if (!(await flush())) return // 保存失败：不切换，保留现场
    setShowAi(false)
    setActiveId(id)
  }

  const save = async (): Promise<void> => {
    if (!activeId || loadingDoc) return // 文档未加载完成前不保存，避免写错文件
    try {
      await window.api.writeOutlineDoc(activeId, content)
      setDirty(false)
      await refresh()
    } catch (e) {
      toastError('Failed to save: ' + (e as Error).message)
    }
  }

  // Ctrl+S 保存；Escape 退出禅模式
  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        save()
      }
      if (e.key === 'Escape' && zen) setZen(false)
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  })

  const doCreate = async (): Promise<void> => {
    if (!(await flush())) return // 先把当前脏内容写回；失败则不新建，避免切走丢失
    try {
      const doc = await window.api.createOutlineDoc(newTitle.trim() || 'Untitled')
      await refresh()
      setActiveId(doc.id)
      setCreating(false)
      setNewTitle('')
      toastSuccess(`"${doc.title}" created.`)
    } catch (e) {
      toastError('Failed to create document: ' + (e as Error).message)
    }
  }

  const doDelete = async (id: string): Promise<void> => {
    if (!confirm('Delete this outline document? This cannot be undone.')) return
    try {
      await window.api.deleteOutlineDoc(id)
      if (activeId === id) {
        setActiveId(null)
        setContent('')
        setDirty(false)
      }
      await refresh()
      toastSuccess('Document deleted.')
    } catch (e) {
      toastError('Failed to delete: ' + (e as Error).message)
    }
  }

  // 导出合并大纲为 markdown（先 flush 未保存的编辑，保证与磁盘一致）
  const handleExport = async (): Promise<void> => {
    if (!(await flush())) return // 保存失败则不导出，避免漏掉未保存内容
    try {
      const merged = await window.api.readOutline()
      const safeTitle = (novel.title.trim() || 'outline').replace(/[/\\:*?"<>|]/g, '_')
      const blob = new Blob([merged], { type: 'text/markdown;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${safeTitle}-outline.md`
      a.click()
      URL.revokeObjectURL(url)
      toastSuccess('Outline exported.')
    } catch (e) {
      toastError('Export failed: ' + (e as Error).message)
    }
  }

  if (!loaded)
    return <div className="h-full flex items-center justify-center text-ink-500">Loading…</div>

  const title = activeId ? activeId.replace(/\.md$/, '') : ''

  // 禅模式：全屏只留当前文档编辑器
  if (zen) {
    return (
      <div className="h-full flex flex-col bg-ink-950">
        <div className="flex items-center justify-between px-6 py-2 text-xs text-ink-500">
          <span className="flex items-center gap-2">
            <List size={13} /> Outline — {title}
          </span>
          <div className="flex items-center gap-3">
            <button
              onClick={save}
              className="icon-btn flex items-center gap-1 hover:text-ink-body text-xs"
              title="Save (Ctrl+S)"
            >
              <Save size={13} /> Save
            </button>
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
          <MarkdownEditor
            value={content}
            onChange={(v) => {
              setContent(v)
              setDirty(true)
            }}
            defaultMode="read"
            zen
          />
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex">
      {/* 文档列表 */}
      <aside className="w-64 shrink-0 border-r border-ink-800 bg-ink-900 overflow-y-auto">
        <div className="px-4 py-3.5 border-b border-ink-800 sticky top-0 bg-ink-900 z-10 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink-body flex items-center gap-2">
            <List size={16} /> Outline
          </h2>
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
          {docs.map((d) => (
            <div
              key={d.id}
              role="button"
              tabIndex={0}
              aria-current={activeId === d.id ? 'page' : undefined}
              className={clsx(
                'group flex items-center gap-2 px-4 py-1.5 cursor-pointer text-sm',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-star-accent/40 focus-visible:ring-inset',
                activeId === d.id ? 'bg-ink-700 text-ink-deep' : 'text-ink-faint hover:bg-ink-800',
              )}
              onClick={() => switchDoc(d.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  switchDoc(d.id)
                }
              }}
            >
              <FileText size={14} className="shrink-0" />
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
          ))}
          {docs.length === 0 && !creating && (
            <div className="px-4 py-6 text-xs text-ink-500 text-center">
              No outline documents yet. Click + in the top right to create one.
            </div>
          )}
        </div>
      </aside>

      {/* 编辑区 */}
      <div className="flex-1 min-w-0 flex flex-col">
        {activeId ? (
          <>
            <div className="flex items-center px-6 py-3 border-b border-ink-800">
              <div className="min-w-0">
                <div className="text-sm font-medium text-ink-body truncate">
                  {title}
                  {dirty && <span className="ml-2 text-star-accent text-xs">● Unsaved</span>}
                </div>
              </div>
              <div className="ml-auto flex items-center gap-3">
                <span className="text-[11px] text-ink-500">
                  {content.length.toLocaleString()} chars
                </span>
                <button
                  onClick={() => setShowAi((v) => !v)}
                  className={clsx(
                    'btn btn-sm',
                    showAi ? 'btn-secondary text-star-info' : 'btn-ghost',
                  )}
                  title="AI writing assistant"
                >
                  <Sparkles size={15} /> AI Assist
                </button>
                <button
                  onClick={handleExport}
                  className="btn btn-sm btn-ghost"
                  title="Export all outline docs as markdown"
                >
                  <Download size={15} /> Export
                </button>
                <button onClick={() => setZen(true)} className="btn btn-sm btn-ghost">
                  <Maximize2 size={15} /> Zen
                </button>
                <button onClick={save} className="btn btn-sm btn-primary">
                  <Save size={15} /> Save
                </button>
              </div>
            </div>
            <div className="flex-1 min-h-0 flex">
              <div className="flex-1 min-w-0 min-h-0">
                <MarkdownEditor
                  value={content}
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
                  chapterTitle={title}
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
              icon={List}
              title="No outline document open"
              description="Select or create an outline document from the left to start editing."
            />
          </div>
        )}
      </div>
    </div>
  )
}
