import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { toastError, toastSuccess } from '../toast'
import type { OutlineChapterData, OutlineStore, OutlineVolumeData } from '@shared/types'
import {
  CONTRACT_FIELDS,
  chapterContract,
  deriveVolumeStatus,
  hasChapterContract,
} from '@shared/outlineStore'
import { uid } from '../lib'
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  List,
  Loader2,
  Pencil,
  Plus,
  Save,
  Settings2,
  Sparkles,
  Trash2,
} from 'lucide-react'
import clsx from 'clsx'
import {
  NEXT_STATUS,
  STATUS_LABEL,
  STATUS_STYLE,
  outlineOrdinalMap,
  type GeneratedChapter,
} from './outline/plan'
import { VolumeEditorModal } from './outline/VolumeEditorModal'
import { ChapterEditorModal } from './outline/ChapterEditorModal'
import { GenerateModal } from './outline/GenerateModal'

// ---- 主视图 ----

export default function Outline(): JSX.Element {
  const novel = useStore((s) => s.novel)!
  const refreshNovel = useStore((s) => s.refreshNovel)
  const currentWorldId = useStore((s) => s.currentWorldId)
  const [store, setStore] = useState<OutlineStore | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [expandedChapters, setExpandedChapters] = useState<Set<string>>(new Set())
  const [overviewOpen, setOverviewOpen] = useState(false)
  const [overviewDraft, setOverviewDraft] = useState('')
  const [editingVolume, setEditingVolume] = useState<OutlineVolumeData | null>(null)
  const [editingChapter, setEditingChapter] = useState<{
    volume: OutlineVolumeData
    chapter: OutlineChapterData
  } | null>(null)
  const [generating, setGenerating] = useState<OutlineVolumeData | null>(null)
  const [saving, setSaving] = useState(false)

  const load = async (): Promise<void> => {
    try {
      setStore(await window.api.readOutlineStore())
    } catch (e) {
      toastError('Failed to load outline: ' + (e as Error).message)
    }
  }

  useEffect(() => {
    load()
  }, [currentWorldId])

  /** 持久化整份大纲：写 outline.json → 同步 novel.json → 刷新前端 novel。 */
  const persist = async (next: OutlineStore): Promise<void> => {
    setSaving(true)
    try {
      await window.api.writeOutlineStore(next)
      setStore(next)
      await refreshNovel()
    } catch (e) {
      toastError('Failed to save outline: ' + (e as Error).message)
      setStore(await window.api.readOutlineStore())
    } finally {
      setSaving(false)
    }
  }

  const ordinals = useMemo(
    () => (store ? outlineOrdinalMap(store) : new Map<string, number>()),
    [store],
  )

  const toggleVolume = (id: string): void =>
    setExpanded((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const toggleChapter = (id: string): void =>
    setExpandedChapters((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  // ---- 结构操作 ----

  const addVolume = (): void => {
    if (!store) return
    const volume: OutlineVolumeData = {
      id: uid('v_'),
      title: `Volume ${store.volumes.length + 1}`,
      summary: '',
      config: '',
      status: 'planned',
      chapters: [],
    }
    void persist({ ...store, volumes: [...store.volumes, volume] })
    setExpanded((s) => new Set(s).add(volume.id))
  }

  const saveVolume = (volume: OutlineVolumeData): void => {
    if (!store) return
    void persist({
      ...store,
      volumes: store.volumes.map((v) => (v.id === volume.id ? volume : v)),
    })
    setEditingVolume(null)
  }

  const deleteVolume = (id: string): void => {
    if (!store) return
    const volume = store.volumes.find((v) => v.id === id)
    if (!volume) return
    if (
      !confirm(
        `Delete volume "${volume.title}" and its ${volume.chapters.length} chapter(s) from the outline and contents? Prose files stay on disk and remain recoverable from History.`,
      )
    )
      return
    void persist({
      ...store,
      volumes: store.volumes.filter((v) => v.id !== id),
    })
    setExpanded((s) => {
      const n = new Set(s)
      n.delete(id)
      return n
    })
  }

  const moveVolume = (id: string, dir: -1 | 1): void => {
    if (!store) return
    const idx = store.volumes.findIndex((v) => v.id === id)
    const to = idx + dir
    if (idx === -1 || to < 0 || to >= store.volumes.length) return
    const volumes = [...store.volumes]
    ;[volumes[idx], volumes[to]] = [volumes[to], volumes[idx]]
    void persist({ ...store, volumes })
  }

  const cycleVolumeStatus = (id: string): void => {
    if (!store) return
    void persist({
      ...store,
      volumes: store.volumes.map((v) =>
        v.id === id ? { ...v, status: NEXT_STATUS[deriveVolumeStatus(v)] } : v,
      ),
    })
  }

  const addChapter = (volumeId: string): void => {
    if (!store) return
    const chapter: OutlineChapterData = {
      id: uid('c_'),
      title: '',
      status: 'planned',
      beats: [],
    }
    void persist({
      ...store,
      volumes: store.volumes.map((v) =>
        v.id === volumeId
          ? {
              ...v,
              status: v.status === 'planned' ? 'planning' : v.status,
              chapters: [...v.chapters, chapter],
            }
          : v,
      ),
    })
    setExpanded((s) => new Set(s).add(volumeId))
    setExpandedChapters((s) => new Set(s).add(chapter.id))
  }

  const saveChapter = (chapter: OutlineChapterData): void => {
    if (!store || !editingChapter) return
    void persist({
      ...store,
      volumes: store.volumes.map((v) =>
        v.id === editingChapter.volume.id
          ? {
              ...v,
              chapters: v.chapters.map((c) => (c.id === chapter.id ? chapter : c)),
            }
          : v,
      ),
    })
    setEditingChapter(null)
  }

  const deleteChapter = (volumeId: string, chapterId: string): void => {
    if (!store) return
    const volume = store.volumes.find((v) => v.id === volumeId)
    const chapter = volume?.chapters.find((c) => c.id === chapterId)
    if (!volume || !chapter) return
    if (
      !confirm(
        `Delete chapter "${chapter.title || '(untitled)'}" from the outline and contents? The prose file stays on disk and remains recoverable from History.`,
      )
    )
      return
    void persist({
      ...store,
      volumes: store.volumes.map((v) =>
        v.id === volumeId ? { ...v, chapters: v.chapters.filter((c) => c.id !== chapterId) } : v,
      ),
    })
  }

  const moveChapter = (volumeId: string, chapterId: string, dir: -1 | 1): void => {
    if (!store) return
    void persist({
      ...store,
      volumes: store.volumes.map((v) => {
        if (v.id !== volumeId) return v
        const idx = v.chapters.findIndex((c) => c.id === chapterId)
        const to = idx + dir
        if (idx === -1 || to < 0 || to >= v.chapters.length) return v
        const chapters = [...v.chapters]
        ;[chapters[idx], chapters[to]] = [chapters[to], chapters[idx]]
        return { ...v, chapters }
      }),
    })
  }

  const toggleChapterStatus = (volumeId: string, chapterId: string): void => {
    if (!store) return
    void persist({
      ...store,
      volumes: store.volumes.map((v) =>
        v.id === volumeId
          ? {
              ...v,
              chapters: v.chapters.map((c) =>
                c.id === chapterId
                  ? { ...c, status: c.status === 'confirmed' ? 'planned' : 'confirmed' }
                  : c,
              ),
            }
          : v,
      ),
    })
  }

  const applyGenerated = (chapters: GeneratedChapter[], confirmed: boolean): void => {
    if (!store || !generating) return
    void persist({
      ...store,
      volumes: store.volumes.map((v) =>
        v.id === generating.id
          ? {
              ...v,
              status: v.status === 'planned' ? 'planning' : v.status,
              chapters: [
                ...v.chapters,
                ...chapters.map((c): OutlineChapterData => ({
                  id: uid('c_'),
                  title: c.title,
                  status: confirmed ? 'confirmed' : 'planned',
                  beats: c.beats,
                  ...(c.contract ? { contract: c.contract } : {}),
                })),
              ],
            }
          : v,
      ),
    })
    setGenerating(null)
    setExpanded((s) => new Set(s).add(generating.id))
  }

  const handleExport = async (): Promise<void> => {
    try {
      const resp = await fetch('/api/exportOutline')
      if (!resp.ok) throw new Error(`Export failed (${resp.status})`)
      const blob = await resp.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const safeTitle = (novel.title.trim() || 'outline').replace(/[/\\:*?"<>|]/g, '_')
      a.download = `${safeTitle}-outline.zip`
      a.click()
      URL.revokeObjectURL(url)
      toastSuccess('Outline exported.')
    } catch (e) {
      toastError('Export failed: ' + (e as Error).message)
    }
  }

  if (!store) {
    return <div className="h-full flex items-center justify-center text-ink-500">Loading…</div>
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="px-8 py-8">
        <div className="mb-6 flex flex-col gap-6 rounded-xl border border-ink-800 bg-ink-900 py-6 shadow-warm-lg">
          {/* 卡片头 */}
          <div className="grid grid-rows-[auto_auto] items-start gap-2 px-6">
            <div className="flex items-center gap-2">
              <BookOpen size={20} className="text-star-warm" />
              <h1 className="text-lg font-semibold text-ink-deep">Volume · Chapter Outline</h1>
              {saving && <Loader2 size={14} className="animate-spin text-ink-500" />}
              <div className="ml-auto flex items-center gap-2">
                <button
                  onClick={() => {
                    setOverviewOpen((v) => !v)
                    if (!overviewOpen) setOverviewDraft(store.overview)
                  }}
                  className={clsx('btn btn-sm', overviewOpen ? 'btn-secondary' : 'btn-ghost')}
                  title="Series-level plan / macro arc"
                >
                  <List size={14} /> Overview
                </button>
                <button onClick={addVolume} className="btn btn-sm btn-ghost">
                  <Plus size={14} /> New Volume
                </button>
                <button onClick={handleExport} className="btn btn-sm btn-ghost">
                  <Download size={14} /> Export
                </button>
              </div>
            </div>
          </div>

          <div className="space-y-3 px-6">
            {/* 全书总览 */}
            {overviewOpen && (
              <div className="rounded-lg border border-ink-700 bg-ink-850/40 p-3">
                <div className="mb-1.5 text-xs font-medium text-ink-500">Series overview</div>
                <textarea
                  className="textarea h-32 text-sm"
                  placeholder="The whole-book plan: major arcs, acts, big reveals…"
                  value={overviewDraft}
                  onChange={(e) => setOverviewDraft(e.target.value)}
                />
                <div className="mt-2 flex justify-end gap-2">
                  <button onClick={() => setOverviewOpen(false)} className="btn btn-sm btn-ghost">
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      void persist({ ...store, overview: overviewDraft })
                      setOverviewOpen(false)
                    }}
                    className="btn btn-sm btn-primary"
                  >
                    <Save size={13} /> Save overview
                  </button>
                </div>
              </div>
            )}

            {/* 卷卡片 */}
            {store.volumes.length === 0 && (
              <div className="rounded-lg border-2 border-dashed border-ink-400 bg-white/60 px-6 py-10 text-center">
                <Sparkles size={32} className="mx-auto mb-3 text-ink-400" />
                <p className="text-sm text-ink-500">
                  No volumes yet. Create a volume, then set its config, write chapters, or let AI
                  generate a first plan.
                </p>
                <div className="mt-4 flex justify-center gap-2">
                  <button onClick={addVolume} className="btn btn-sm btn-primary">
                    <Plus size={14} /> New Volume
                  </button>
                </div>
              </div>
            )}

            {store.volumes.map((volume, vi) => {
              const status = deriveVolumeStatus(volume)
              const style = STATUS_STYLE[status]
              const firstOrd =
                volume.chapters.length > 0 ? ordinals.get(volume.chapters[0].id) : null
              const lastOrd =
                volume.chapters.length > 0
                  ? ordinals.get(volume.chapters[volume.chapters.length - 1].id)
                  : null
              const range =
                volume.chapters.length > 0 && firstOrd && lastOrd
                  ? `Ch. ${firstOrd}-${lastOrd} (${volume.chapters.length} total)`
                  : volume.chapters.length > 0
                    ? `${volume.chapters.length} chapters`
                    : 'No chapters yet'
              const isOpen = expanded.has(volume.id)

              return (
                <div
                  key={volume.id}
                  className={clsx('rounded-lg border-2 transition-all', style.card)}
                >
                  <div className="p-4">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-3">
                        <div
                          className={clsx(
                            'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold',
                            style.circle,
                          )}
                        >
                          {status === 'confirmed' ? <Check size={15} /> : vi + 1}
                        </div>
                        <div className="min-w-0">
                          <h4 className="truncate font-medium text-ink-deep">
                            {volume.title || `Volume ${vi + 1}`}
                          </h4>
                          <p className="text-sm text-ink-500">{range}</p>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <button
                          onClick={() => toggleVolume(volume.id)}
                          className="icon-btn"
                          title={isOpen ? 'Collapse' : 'Expand'}
                        >
                          {isOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                        </button>
                        <button
                          onClick={() => cycleVolumeStatus(volume.id)}
                          className={clsx(
                            'inline-flex items-center justify-center rounded-full border px-2 py-0.5 text-xs font-medium transition-colors',
                            style.badge,
                          )}
                          title="Click to cycle status (Planned → Planning → Confirmed)"
                        >
                          <span className={clsx('mr-1 h-1.5 w-1.5 rounded-full', style.dot)} />
                          {STATUS_LABEL[status]}
                        </button>
                        <button
                          onClick={() => setEditingVolume(volume)}
                          className="icon-btn"
                          title="Edit volume config"
                        >
                          <Settings2 size={14} />
                        </button>
                        <button
                          onClick={() => moveVolume(volume.id, -1)}
                          disabled={vi === 0}
                          className="icon-btn disabled:opacity-30"
                          title="Move volume up"
                        >
                          <ArrowUp size={13} />
                        </button>
                        <button
                          onClick={() => moveVolume(volume.id, 1)}
                          disabled={vi === store.volumes.length - 1}
                          className="icon-btn disabled:opacity-30"
                          title="Move volume down"
                        >
                          <ArrowDown size={13} />
                        </button>
                        <button
                          onClick={() => deleteVolume(volume.id)}
                          className="icon-btn hover:text-star-danger"
                          title="Delete volume"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                    {volume.summary.trim() && (
                      <div className="mt-3 rounded bg-white/60 p-2 text-sm text-ink-muted">
                        <strong className="text-ink-body">Summary:</strong> {volume.summary}
                      </div>
                    )}
                  </div>

                  {isOpen && (
                    <div className="space-y-2 px-4 pb-4">
                      {volume.chapters.length === 0 ? (
                        <div className="rounded-lg border border-dashed border-star-warm/40 bg-white/60 py-6 text-center">
                          <Sparkles size={36} className="mx-auto mb-3 text-star-warm" />
                          <div className="flex flex-wrap justify-center gap-2 sm:gap-3">
                            <button
                              onClick={() => setEditingVolume(volume)}
                              className="btn btn-sm btn-ghost"
                            >
                              <Settings2 size={14} /> Set volume config
                            </button>
                            <button
                              onClick={() => setGenerating(volume)}
                              className="btn btn-sm btn-primary"
                            >
                              <Sparkles size={14} /> AI generate
                            </button>
                            <button
                              onClick={() => addChapter(volume.id)}
                              className="btn btn-sm btn-ghost"
                            >
                              <Pencil size={14} /> Manual edit
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          {volume.chapters.map((chapter, ci) => {
                            const confirmedChapter = chapter.status === 'confirmed'
                            const beatsOpen = expandedChapters.has(chapter.id)
                            const chapterOrd = ordinals.get(chapter.id)
                            const contract = chapterContract(chapter)
                            const hasContract = hasChapterContract(chapter.contract)
                            return (
                              <div key={chapter.id} className="rounded-lg bg-white/60 p-3">
                                <div className="flex items-start gap-3">
                                  <button
                                    onClick={() => toggleChapterStatus(volume.id, chapter.id)}
                                    title="Click to toggle confirmed"
                                    className={clsx(
                                      'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-colors',
                                      confirmedChapter
                                        ? 'bg-star-success text-white'
                                        : 'bg-ink-300 text-ink-600 hover:bg-ink-400',
                                    )}
                                  >
                                    {confirmedChapter ? (
                                      <Check size={14} />
                                    ) : (
                                      (chapterOrd ?? ci + 1)
                                    )}
                                  </button>
                                  <div className="min-w-0 flex-1">
                                    <h5 className="mb-1 flex items-center gap-2 text-sm font-medium text-ink-deep">
                                      {chapter.title || '(untitled chapter)'}
                                      {hasContract && (
                                        <span
                                          className="rounded bg-star-accent/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-star-accent"
                                          title="This chapter carries author decisions that every draft prompt must respect"
                                        >
                                          Contract
                                        </span>
                                      )}
                                    </h5>
                                    {beatsOpen && hasContract && (
                                      <dl className="mb-2 space-y-1 rounded-md border border-ink-700/60 bg-ink-850/40 p-2">
                                        {CONTRACT_FIELDS.map(({ id, label }) =>
                                          contract[id] ? (
                                            <div key={id} className="text-xs">
                                              <dt className="font-medium text-ink-500">{label}</dt>
                                              <dd className="text-ink-muted">{contract[id]}</dd>
                                            </div>
                                          ) : null,
                                        )}
                                      </dl>
                                    )}
                                    {beatsOpen && chapter.beats.length > 0 && (
                                      <ul className="space-y-1.5">
                                        {chapter.beats.map((b, bi) => (
                                          <li key={bi} className="text-xs text-ink-muted">
                                            <span className="font-medium text-ink-500">
                                              {b.title ? `${b.title}：` : ''}
                                            </span>
                                            {b.summary}
                                          </li>
                                        ))}
                                      </ul>
                                    )}
                                    {beatsOpen && chapter.beats.length === 0 && (
                                      <p className="text-xs text-ink-500">No beats yet.</p>
                                    )}
                                  </div>
                                  <div className="flex shrink-0 items-center gap-1">
                                    <button
                                      onClick={() => toggleChapter(chapter.id)}
                                      className="icon-btn"
                                      title="Expand / collapse beats"
                                    >
                                      {beatsOpen ? (
                                        <ChevronUp size={13} />
                                      ) : (
                                        <ChevronDown size={13} />
                                      )}
                                    </button>
                                    <button
                                      onClick={() => setEditingChapter({ volume, chapter })}
                                      className="icon-btn"
                                      title="Edit chapter"
                                    >
                                      <Pencil size={13} />
                                    </button>
                                    <button
                                      onClick={() => moveChapter(volume.id, chapter.id, -1)}
                                      disabled={ci === 0}
                                      className="icon-btn disabled:opacity-30"
                                      title="Move up"
                                    >
                                      <ArrowUp size={12} />
                                    </button>
                                    <button
                                      onClick={() => moveChapter(volume.id, chapter.id, 1)}
                                      disabled={ci === volume.chapters.length - 1}
                                      className="icon-btn disabled:opacity-30"
                                      title="Move down"
                                    >
                                      <ArrowDown size={12} />
                                    </button>
                                    <button
                                      onClick={() => deleteChapter(volume.id, chapter.id)}
                                      className="icon-btn hover:text-star-danger"
                                      title="Delete chapter"
                                    >
                                      <Trash2 size={13} />
                                    </button>
                                  </div>
                                </div>
                              </div>
                            )
                          })}
                          <button
                            onClick={() => addChapter(volume.id)}
                            className="btn btn-sm btn-ghost w-full"
                          >
                            <Plus size={14} /> Add chapter
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {editingVolume && (
        <VolumeEditorModal
          volume={editingVolume}
          onSave={saveVolume}
          onClose={() => setEditingVolume(null)}
        />
      )}
      {editingChapter && (
        <ChapterEditorModal
          volume={editingChapter.volume}
          chapter={editingChapter.chapter}
          onSave={saveChapter}
          onClose={() => setEditingChapter(null)}
        />
      )}
      {generating && (
        <GenerateModal
          volume={generating}
          store={store}
          onApply={applyGenerated}
          onClose={() => setGenerating(null)}
        />
      )}
    </div>
  )
}
