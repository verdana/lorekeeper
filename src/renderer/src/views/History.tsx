import { useEffect, useMemo, useState } from 'react'
import { useStore, isBatchWriteLocked } from '../store'
import { formatTime } from '../lib'
import { toastError, toastSuccess } from '../toast'
import type { SnapshotEntry } from '@shared/types'
import {
  History as HistoryIcon,
  RotateCcw,
  Loader2,
  FileText,
  BookText,
  BookOpen,
  Clock,
  AudioLines,
  MessagesSquare,
  MessageCircle,
  ClipboardList,
  X,
  type LucideIcon,
} from 'lucide-react'
import clsx from 'clsx'
import EmptyState from '../components/EmptyState'
import DiffView from '../components/DiffView'

const KIND_META: Record<SnapshotEntry['kind'], { icon: LucideIcon; className: string }> = {
  chapter: { icon: BookText, className: 'text-star-info' },
  setting: { icon: FileText, className: 'text-star-warm' },
  outline: { icon: FileText, className: 'text-star-warm' },
  novel: { icon: BookOpen, className: 'text-star-accent' },
  timeline: { icon: Clock, className: 'text-star-info' },
  voice: { icon: AudioLines, className: 'text-star-success' },
  discussion: { icon: MessagesSquare, className: 'text-star-accent' },
  reviewQueue: { icon: ClipboardList, className: 'text-star-danger' },
  characterChat: { icon: MessageCircle, className: 'text-star-success' },
}

// Version history: lists snapshots (auto-saved before write/delete), preview and one-click restore.
// 恢复动作本身也会先给当前版留快照，故可反悔。
export default function History(): JSX.Element {
  const refreshNovel = useStore((s) => s.refreshNovel)
  const refreshSettings = useStore((s) => s.refreshSettings)
  const loadVoiceProfile = useStore((s) => s.loadVoiceProfile)
  const snapshotFocusId = useStore((s) => s.snapshotFocusId)
  const clearSnapshotFocus = useStore((s) => s.clearSnapshotFocus)

  const [snapshots, setSnapshots] = useState<SnapshotEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [preview, setPreview] = useState<{
    entry: SnapshotEntry
    content: string
    current: string
  } | null>(null)
  const [previewMode, setPreviewMode] = useState<'raw' | 'diff'>('raw')
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
    const map = new Map<
      string,
      { label: string; kind: SnapshotEntry['kind']; entries: SnapshotEntry[] }
    >()
    for (const s of snapshots) {
      const g = map.get(s.sourcePath)
      if (g) g.entries.push(s)
      else map.set(s.sourcePath, { label: s.label, kind: s.kind, entries: [s] })
    }
    return [...map.values()]
  }, [snapshots])

  const openPreview = async (entry: SnapshotEntry): Promise<void> => {
    const [content, current] = await Promise.all([
      window.api.readSnapshot(entry.id),
      window.api.readWorldFile(entry.sourcePath),
    ])
    setPreviewMode('raw')
    setPreview({ entry, content, current })
  }

  useEffect(() => {
    if (!snapshotFocusId) return
    const snapshot = snapshots.find((item) => item.id === snapshotFocusId)
    if (!snapshot) return
    clearSnapshotFocus()
    openPreview(snapshot).catch((error: unknown) =>
      toastError('Failed to open snapshot: ' + (error as Error).message),
    )
  }, [clearSnapshotFocus, snapshotFocusId, snapshots])

  const restore = async (entry: SnapshotEntry): Promise<void> => {
    // Chapter/novel restores would fight the batch engine's frozen targets.
    if (
      (entry.kind === 'chapter' || entry.kind === 'novel') &&
      isBatchWriteLocked(useStore.getState())
    ) {
      toastError('Batch writing is active — restore is disabled for chapters and NovelMeta.')
      return
    }
    if (
      !confirm(
        `Restore "${entry.label}" to its version from ${formatTime(entry.ts)}? The current version is snapshotted first, so you can undo this.`,
      )
    )
      return
    setBusy(true)
    try {
      await window.api.restoreSnapshot(entry.id)
      // 按快照类型刷新对应数据；timeline / discussion / reviewQueue / characterChat
      // 视图在挂载时重新读取，无需在此代为刷新。
      const refreshes: Promise<void>[] = []
      if (entry.kind === 'setting') refreshes.push(refreshSettings())
      // outline / timeline / discussion / reviewQueue / characterChat 视图在挂载时
      // 重新读取，无需在此代为刷新；chapter 与 novel 恢复影响 novel store。
      if (entry.kind === 'chapter' || entry.kind === 'novel') refreshes.push(refreshNovel())
      if (entry.kind === 'voice') refreshes.push(loadVoiceProfile())
      await Promise.all(refreshes)
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
        <h1 className="text-xl font-semibold text-ink-deep">Version History</h1>
        <span className="text-xs text-ink-500 ml-2">
          Automatic snapshots taken before each save or deletion — recover chapters, codex entries,
          outlines, timeline data, discussions, voice profiles, or world metadata if AI garbled them
          or you deleted them by mistake.
        </span>
      </div>

      <div className="flex-1 min-h-0 flex">
        {/* 快照列表 */}
        <div className="flex-1 min-w-0 overflow-y-auto">
          <div className="max-w-4xl mx-auto px-8 py-8">
            {loading ? (
              <div className="flex items-center gap-2 text-ink-500 text-sm">
                <Loader2 size={15} className="animate-spin" /> Loading…
              </div>
            ) : groups.length === 0 ? (
              <EmptyState
                icon={HistoryIcon}
                title="No snapshots yet"
                description="As you edit chapters, codex entries, outlines, timeline, discussions, voice profiles, and world metadata, previous versions are saved here automatically — nothing to restore for now."
              />
            ) : (
              <div className="space-y-6">
                {groups.map((g) => (
                  <section key={g.label + g.entries[0].sourcePath}>
                    <div className="flex items-center gap-2 mb-2">
                      {(() => {
                        const meta = KIND_META[g.kind]
                        const Icon = meta.icon
                        return <Icon size={14} className={clsx(meta.className, 'shrink-0')} />
                      })()}
                      <h2 className="text-sm font-medium text-ink-body truncate">{g.label}</h2>
                      <span className="text-[11px] text-ink-500 shrink-0">
                        {g.entries.length} version{g.entries.length > 1 ? 's' : ''}
                      </span>
                    </div>
                    <div className="space-y-1">
                      {g.entries.map((e) => (
                        <div
                          key={e.id}
                          onClick={() => openPreview(e)}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(ev) => {
                            if (ev.key === 'Enter' || ev.key === ' ') {
                              ev.preventDefault()
                              openPreview(e)
                            }
                          }}
                          className={clsx(
                            'group flex items-center gap-3 px-3 py-2 rounded-md cursor-pointer text-sm',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-star-accent/40 focus-visible:ring-inset',
                            preview?.entry.id === e.id
                              ? 'bg-ink-700 text-ink-deep'
                              : 'text-ink-faint hover:bg-ink-800',
                          )}
                        >
                          <span className="flex-1 truncate">{formatTime(e.ts)}</span>
                          <span className="text-[11px] text-ink-500 shrink-0 tabular-nums">
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
                <div className="text-sm font-medium text-ink-body truncate">
                  {preview.entry.label}
                </div>
                <div className="text-[11px] text-ink-500">{formatTime(preview.entry.ts)}</div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <div className="flex items-center rounded-md bg-ink-850 border border-ink-800 p-0.5">
                  {(['raw', 'diff'] as const).map((mode) => (
                    <button
                      key={mode}
                      onClick={() => setPreviewMode(mode)}
                      className={clsx(
                        'rounded px-2 py-0.5 text-[11px] transition-colors',
                        previewMode === mode
                          ? 'bg-ink-body text-white'
                          : 'text-ink-muted hover:text-ink-body',
                      )}
                    >
                      {mode === 'raw' ? 'Raw' : 'Diff'}
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => restore(preview.entry)}
                  disabled={busy}
                  className="btn btn-sm btn-primary"
                >
                  {busy ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
                  Restore
                </button>
                <button
                  onClick={() => setPreview(null)}
                  className="icon-btn hover:text-ink-muted"
                  title="Close preview"
                >
                  <X size={16} />
                </button>
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
              {previewMode === 'diff' ? (
                <div className="space-y-2">
                  <p className="text-[11px] text-ink-500">
                    Red = current version, green = snapshot from {formatTime(preview.entry.ts)}.
                  </p>
                  <DiffView
                    original={preview.current}
                    revised={preview.content}
                    onAccept={() => undefined}
                    onReject={() => undefined}
                    readOnly
                  />
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-[11px] text-ink-500">
                    {preview.content.length.toLocaleString()} chars — snapshot from{' '}
                    {formatTime(preview.entry.ts)}.
                  </p>
                  <div className="p-3 bg-ink-850 rounded border border-ink-800 text-sm text-ink-500 leading-relaxed whitespace-pre-wrap font-mono">
                    {preview.content}
                  </div>
                </div>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  )
}
