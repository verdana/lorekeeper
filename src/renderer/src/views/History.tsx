import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { formatTime } from '../lib'
import { toastError, toastSuccess } from '../toast'
import type { SnapshotEntry } from '@shared/types'
import { History as HistoryIcon, RotateCcw, Loader2, FileText, BookText, X } from 'lucide-react'
import clsx from 'clsx'
import EmptyState from '../components/EmptyState'

// Version history: lists snapshots (auto-saved before write/delete), preview and one-click restore.
// 恢复动作本身也会先给当前版留快照，故可反悔。
export default function History(): JSX.Element {
  const refreshNovel = useStore((s) => s.refreshNovel)
  const refreshSettings = useStore((s) => s.refreshSettings)

  const [snapshots, setSnapshots] = useState<SnapshotEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [preview, setPreview] = useState<{ entry: SnapshotEntry; content: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const load = async (): Promise<void> => {
    setLoading(true)
    setSnapshots(await window.api.listSnapshots())
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  // 按源文件分组，组内按时间倒序
  const groups = useMemo(() => {
    const map = new Map<string, { label: string; kind: SnapshotEntry['kind']; entries: SnapshotEntry[] }>()
    for (const s of snapshots) {
      const g = map.get(s.sourcePath)
      if (g) g.entries.push(s)
      else map.set(s.sourcePath, { label: s.label, kind: s.kind, entries: [s] })
    }
    return [...map.values()]
  }, [snapshots])

  const openPreview = async (entry: SnapshotEntry): Promise<void> => {
    const content = await window.api.readSnapshot(entry.id)
    setPreview({ entry, content })
  }

  const restore = async (entry: SnapshotEntry): Promise<void> => {
    if (!confirm(`Restore "${entry.label}" to its version from ${formatTime(entry.ts)}? The current version is snapshotted first, so you can undo this.`)) return
    setBusy(true)
    try {
      await window.api.restoreSnapshot(entry.id)
      // 恢复可能改动的是章节正文或设定，两处都刷新以反映最新状态
      await Promise.all([refreshNovel(), refreshSettings()])
      await load()
      setPreview(null)
      toastSuccess(`"${entry.label}" restored.`)
    } catch (e) {
      toastError('Failed to restore: ' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-8 py-4 border-b border-ink-800">
        <HistoryIcon size={18} className="text-star-accent" />
        <h1 className="text-sm font-semibold text-slate-900">Version History</h1>
        <span className="text-xs text-ink-500 ml-2">
          Automatic snapshots taken before each save or deletion — recover a chapter or codex entry
          if AI garbled it or you deleted it by mistake.
        </span>
      </div>

      <div className="flex-1 min-h-0 flex">
        {/* 快照列表 */}
        <div className="flex-1 min-w-0 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-8 py-6">
            {loading ? (
              <div className="flex items-center gap-2 text-ink-500 text-sm">
                <Loader2 size={15} className="animate-spin" /> Loading…
              </div>
            ) : groups.length === 0 ? (
              <EmptyState
                icon={HistoryIcon}
                title="No snapshots yet"
                description="As you edit chapters and codex entries, previous versions are saved here automatically — nothing to restore for now."
              />
            ) : (
              <div className="space-y-6">
                {groups.map((g) => (
                  <section key={g.label + g.entries[0].sourcePath}>
                    <div className="flex items-center gap-2 mb-2">
                      {g.kind === 'chapter' ? (
                        <BookText size={14} className="text-star-info shrink-0" />
                      ) : (
                        <FileText size={14} className="text-star-warm shrink-0" />
                      )}
                      <h2 className="text-sm font-medium text-slate-800 truncate">{g.label}</h2>
                      <span className="text-[11px] text-ink-500 shrink-0">
                        {g.entries.length} version{g.entries.length > 1 ? 's' : ''}
                      </span>
                    </div>
                    <div className="space-y-1">
                      {g.entries.map((e) => (
                        <div
                          key={e.id}
                          onClick={() => openPreview(e)}
                          className={clsx(
                            'group flex items-center gap-3 px-3 py-2 rounded-md cursor-pointer text-sm',
                            preview?.entry.id === e.id
                              ? 'bg-ink-700 text-slate-900'
                              : 'text-slate-600 hover:bg-ink-800'
                          )}
                        >
                          <span className="flex-1 truncate">{formatTime(e.ts)}</span>
                          <span className="text-[11px] text-ink-500 shrink-0">
                            {(e.size / 1024).toFixed(1)} KB
                          </span>
                          <button
                            onClick={(ev) => {
                              ev.stopPropagation()
                              restore(e)
                            }}
                            disabled={busy}
                            className="btn btn-sm btn-ghost opacity-0 group-hover:opacity-100 focus-visible:opacity-100 shrink-0 hover:text-star-accent"
                            title="Restore this version"
                          >
                            <RotateCcw size={13} /> Restore
                          </button>
                        </div>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 预览面板 */}
        {preview && (
          <aside className="w-[42%] shrink-0 border-l border-ink-800 bg-ink-900 flex flex-col">
            <div className="flex items-center justify-between px-5 py-3 border-b border-ink-800">
              <div className="min-w-0">
                <div className="text-sm font-medium text-slate-800 truncate">{preview.entry.label}</div>
                <div className="text-[11px] text-ink-500">{formatTime(preview.entry.ts)}</div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => restore(preview.entry)}
                  disabled={busy}
                  className="btn btn-sm btn-primary"
                >
                  {busy ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
                  Restore
                </button>
                <button onClick={() => setPreview(null)} className="icon-btn hover:text-slate-700" title="Close preview">
                  <X size={16} />
                </button>
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
              <pre className="text-xs text-slate-600 whitespace-pre-wrap wrap-break-word font-mono leading-relaxed">
                {preview.content}
              </pre>
            </div>
          </aside>
        )}
      </div>
    </div>
  )
}
