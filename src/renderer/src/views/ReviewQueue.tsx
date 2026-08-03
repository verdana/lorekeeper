import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { toastError, toastSuccess } from '../toast'
import {
  applyReviewItemStatus,
  buildManualReviewItem,
  countOpenReviewItems,
  markReviewItemFixed,
  parseReportIssues,
  removeReviewItems,
  severityOrder,
  type ReportIssue,
} from '@shared/reviewQueue'
import type {
  ConsistencyReport,
  ReviewItemSeverity,
  ReviewItemStatus,
  ReviewQueueItem,
  ReviewQueueStore,
} from '@shared/types'
import {
  ClipboardList,
  Loader2,
  ListChecks,
  Wand2,
  Check,
  Trash2,
  RotateCcw,
  Plus,
  X,
  FileText,
} from 'lucide-react'
import clsx from 'clsx'
import EmptyState from '../components/EmptyState'
import ApplyFixModal from '../components/ApplyFixModal'

const STATUS_FILTERS: (ReviewItemStatus | 'all')[] = [
  'all',
  'open',
  'fixing',
  'verified',
  'resolved',
]

const SEVERITY_META: Record<ReviewItemSeverity, { label: string; dot: string; text: string }> = {
  critical: { label: 'Critical', dot: 'bg-star-danger', text: 'text-star-danger' },
  moderate: { label: 'Moderate', dot: 'bg-star-warm', text: 'text-star-warm' },
  unsure: { label: 'Unsure', dot: 'bg-star-info', text: 'text-star-info' },
}

const STATUS_META: Record<ReviewItemStatus, { label: string; className: string }> = {
  open: { label: 'Open', className: 'bg-ink-700 text-ink-body' },
  fixing: { label: 'Fixing', className: 'bg-star-accent/15 text-star-accent' },
  verified: { label: 'Verified', className: 'bg-star-info/15 text-star-info' },
  resolved: { label: 'Resolved', className: 'bg-star-success/15 text-star-success' },
}

export default function ReviewQueue(): JSX.Element {
  const config = useStore((s) => s.config)
  const settingDocs = useStore((s) => s.settingDocs)
  const novel = useStore((s) => s.novel)
  const currentWorldId = useStore((s) => s.currentWorldId)
  const allChapters = useMemo(() => (novel?.volumes ?? []).flatMap((v) => v.chapters), [novel])

  const [store, setStore] = useState<ReviewQueueStore>({ version: 1, items: [] })
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<ReviewItemStatus | 'all'>('all')
  const [fixingItem, setFixingItem] = useState<ReviewQueueItem | null>(null)
  // 导入报告对话框状态
  const [importOpen, setImportOpen] = useState(false)
  const [reports, setReports] = useState<ConsistencyReport[]>([])
  const [selectedReportId, setSelectedReportId] = useState('')
  const [importDraft, setImportDraft] = useState<
    {
      severity: ReviewItemSeverity
      text: string
      docIds: string[]
      on: boolean
    }[]
  >([])
  const [importing, setImporting] = useState(false)
  // 最新队列快照 + 串行写链:状态操作基于 storeRef(始终最新)计算,
  // 写入经 promise 链排队,避免快速连续操作互相覆盖。失败时回滚到
  // 上次成功持久化的快照,保证重试基于真实状态;世界切换时放弃排队写。
  const storeRef = useRef<ReviewQueueStore>({ version: 1, items: [] })
  const lastPersistedRef = useRef<ReviewQueueStore>({ version: 1, items: [] })
  const writeChainRef = useRef<Promise<void>>(Promise.resolve())
  const worldIdRef = useRef(currentWorldId)
  worldIdRef.current = currentWorldId

  const openCount = countOpenReviewItems(store)

  useEffect(() => {
    let cancelled = false
    Promise.all([window.api.readReviewQueue(), window.api.listConsistencyReports()])
      .then(([queue, reportList]) => {
        if (cancelled) return
        storeRef.current = queue
        lastPersistedRef.current = queue
        setStore(queue)
        setReports(reportList)
      })
      .catch((e: unknown) => {
        if (!cancelled) toastError('Failed to load review queue: ' + (e as Error).message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [currentWorldId])

  /** 串行持久化。返回是否写入成功;失败时状态已回滚并 toast。 */
  const persist = (next: ReviewQueueStore): Promise<boolean> => {
    storeRef.current = next
    const snap = next
    const worldId = worldIdRef.current
    const run = writeChainRef.current.then(async () => {
      if (worldId !== worldIdRef.current) return false
      try {
        await window.api.writeReviewQueue(snap)
        lastPersistedRef.current = snap
        setStore(snap)
        return true
      } catch (e) {
        storeRef.current = lastPersistedRef.current
        setStore(lastPersistedRef.current)
        toastError('Failed to save review queue: ' + (e as Error).message)
        return false
      }
    })
    writeChainRef.current = run.then(() => undefined)
    return run
  }

  const items = useMemo(() => {
    const visible = filter === 'all' ? store.items : store.items.filter((i) => i.status === filter)
    return [...visible].sort(
      (a, b) =>
        severityOrder(a.severity) - severityOrder(b.severity) ||
        b.createdAt - a.createdAt ||
        a.id.localeCompare(b.id),
    )
  }, [store.items, filter])

  const countByStatus = (status: ReviewItemStatus): number =>
    store.items.filter((i) => i.status === status).length

  const changeStatus = async (item: ReviewQueueItem, status: ReviewItemStatus): Promise<void> => {
    const result = applyReviewItemStatus(storeRef.current, new Set([item.id]), status)
    if (result.changed === 0) return
    await persist(result.store)
  }

  const removeItem = async (item: ReviewQueueItem): Promise<void> => {
    await persist(removeReviewItems(storeRef.current, new Set([item.id])))
  }

  // ---- 导入报告 ----
  const openImport = (): void => {
    const firstId = reports[0]?.id ?? ''
    if (firstId) {
      // 直接加载默认选中报告的预览,否则 importDraft 为空、Add 按钮一直禁用。
      loadReportPreview(firstId)
    } else {
      setSelectedReportId('')
      setImportDraft([])
    }
    setImportOpen(true)
  }

  const loadReportPreview = (reportId: string): void => {
    setSelectedReportId(reportId)
    const report = reports.find((r) => r.id === reportId)
    if (!report) {
      setImportDraft([])
      return
    }
    const validDocIds = new Set(settingDocs.map((d) => d.id))
    setImportDraft(
      parseReportIssues(report.content, validDocIds).map((issue: ReportIssue) => ({
        severity: issue.severity,
        text: issue.text,
        docIds: issue.docIds,
        on: true,
      })),
    )
  }

  const addToQueue = async (): Promise<void> => {
    const report = reports.find((r) => r.id === selectedReportId)
    if (!report) return
    const picked = importDraft.filter((d) => d.on)
    if (picked.length === 0) return
    setImporting(true)
    try {
      const now = Date.now()
      const reportLabel = new Date(report.createdAt).toLocaleString([], {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
      // 以用户编辑后的 draft 文本重建条目,并保留来源报告回链与 AI 标注的涉及文档。
      const built: ReviewQueueItem[] = importDraft
        .filter((d) => d.on)
        .map((d) => {
          const item = buildManualReviewItem(
            { text: d.text, severity: d.severity, relatedDocIds: d.docIds },
            now,
          )
          return { ...item, reportId: report.id, reportLabel }
        })
      const ok = await persist({
        ...storeRef.current,
        items: [...storeRef.current.items, ...built],
      })
      if (!ok) return // 写入失败:保留对话框与 draft,可重试。
      toastSuccess(`${built.length} item${built.length === 1 ? '' : 's'} added to the queue.`)
      setImportOpen(false)
    } catch (e) {
      toastError('Failed to add items: ' + (e as Error).message)
    } finally {
      setImporting(false)
    }
  }

  const addManual = async (): Promise<void> => {
    const text = prompt('Enter the issue to track:')
    if (!text?.trim()) return
    const item = buildManualReviewItem({ text, severity: 'moderate' })
    await persist({ ...storeRef.current, items: [item, ...storeRef.current.items] })
    toastSuccess('Item added to the queue.')
  }

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 size={20} className="animate-spin text-ink-500" />
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      {/* 工具栏 */}
      <div className="shrink-0 border-b border-ink-800 bg-ink-900/80 px-6 py-3 flex items-center gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-star-danger/10 border border-star-danger/20 flex items-center justify-center shrink-0">
            <ClipboardList size={16} className="text-star-danger" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-ink-body leading-tight">Review Queue</h2>
            <p className="text-[11px] text-ink-500">
              {openCount} open · {store.items.length} total
            </p>
          </div>
        </div>
        <div className="flex-1" />
        <button onClick={addManual} className="btn btn-sm btn-ghost">
          <Plus size={14} /> Add item
        </button>
        <button
          onClick={openImport}
          disabled={reports.length === 0}
          className="btn btn-sm btn-primary"
          title={reports.length === 0 ? 'Run a consistency check and save it first' : undefined}
        >
          <ListChecks size={14} /> Import from report…
        </button>
      </div>

      {/* 状态筛选 */}
      <div className="shrink-0 border-b border-ink-800 px-6 py-2 flex items-center gap-1.5">
        {STATUS_FILTERS.map((status) => (
          <button
            key={status}
            onClick={() => setFilter(status)}
            className={clsx(
              'rounded-md px-2.5 py-1 text-[12px] transition-colors',
              filter === status
                ? 'bg-ink-body text-white'
                : 'text-ink-muted hover:bg-ink-850 hover:text-ink-body',
            )}
          >
            {status === 'all' ? 'All' : STATUS_META[status].label}
            {status !== 'all' && (
              <span className="ml-1 text-[10px] opacity-70">{countByStatus(status)}</span>
            )}
          </button>
        ))}
      </div>

      {/* 列表 */}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        {items.length === 0 ? (
          <EmptyState
            icon={ClipboardList}
            title={
              filter === 'all'
                ? 'Queue is empty'
                : `No ${STATUS_META[filter as ReviewItemStatus].label.toLowerCase()} items`
            }
            description="Run a consistency check, save the report, then import its issues here to track them to resolution."
          />
        ) : (
          <div className="max-w-3xl mx-auto space-y-2.5">
            {items.map((item) => {
              const sev = SEVERITY_META[item.severity]
              const st = STATUS_META[item.status]
              return (
                <div
                  key={item.id}
                  className="rounded-[14px] border border-ink-800 bg-ink-900 px-4 py-3 space-y-2"
                >
                  <div className="flex items-center gap-2">
                    <span className={clsx('w-2 h-2 rounded-full shrink-0', sev.dot)} />
                    <span
                      className={clsx(
                        'text-[10px] font-semibold uppercase tracking-wider',
                        sev.text,
                      )}
                    >
                      {sev.label}
                    </span>
                    <span
                      className={clsx(
                        'text-[10px] font-medium uppercase tracking-wider rounded px-1.5 py-0.5',
                        st.className,
                      )}
                    >
                      {st.label}
                    </span>
                    <span className="flex-1" />
                    <span className="text-[10px] text-ink-500">
                      {item.reportLabel ? `report ${item.reportLabel}` : 'manual'}
                      {item.relatedDocIds.length > 0 && (
                        <span className="ml-1.5 text-star-info">
                          ·{' '}
                          {item.relatedDocIds
                            .map((id) => settingDocs.find((d) => d.id === id)?.title ?? id)
                            .join(', ')}
                        </span>
                      )}
                      {item.fixedIn && (
                        <span className="ml-1.5 text-star-info">→ {item.fixedIn.title}</span>
                      )}
                    </span>
                  </div>
                  <p className="text-[13px] text-ink-body leading-relaxed whitespace-pre-wrap">
                    {item.text}
                  </p>
                  <div className="flex items-center gap-1.5">
                    {item.status === 'open' && (
                      <button
                        onClick={() => setFixingItem(item)}
                        className="btn btn-sm btn-primary"
                      >
                        <Wand2 size={13} /> Fix
                      </button>
                    )}
                    {(item.status === 'open' || item.status === 'fixing') && (
                      <button
                        onClick={() => changeStatus(item, 'verified')}
                        className="btn btn-sm btn-secondary"
                      >
                        <Check size={13} /> Verify
                      </button>
                    )}
                    {(item.status === 'open' ||
                      item.status === 'fixing' ||
                      item.status === 'verified') && (
                      <button
                        onClick={() => changeStatus(item, 'resolved')}
                        className="btn btn-sm btn-ghost"
                      >
                        <Check size={13} /> Resolve
                      </button>
                    )}
                    {item.status === 'resolved' && (
                      <button
                        onClick={() => changeStatus(item, 'open')}
                        className="btn btn-sm btn-ghost"
                      >
                        <RotateCcw size={13} /> Reopen
                      </button>
                    )}
                    <span className="flex-1" />
                    <button
                      onClick={() => removeItem(item)}
                      className="icon-btn text-ink-500 hover:text-star-danger"
                      aria-label="Delete item"
                      title="Delete item"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 修复弹窗 */}
      {fixingItem && (
        <ApplyFixModal
          issue={fixingItem.text}
          docs={settingDocs}
          chapters={allChapters}
          providerId={config?.consistency.providerId ?? null}
          // 导入时 AI 标注的涉及文档优先作为修复目标,作者无需记住哪个文档有问题。
          suggestedTarget={(() => {
            const docId = fixingItem.relatedDocIds[0]
            const doc = docId ? settingDocs.find((d) => d.id === docId) : undefined
            return doc ? { kind: 'doc', id: doc.id, title: doc.title } : null
          })()}
          onApplied={async (target) => {
            const next = markReviewItemFixed(storeRef.current, fixingItem.id, target)
            await persist(next)
            toastSuccess('Item marked as fixing.')
          }}
          onDone={() => setFixingItem(null)}
        />
      )}

      {/* 导入报告对话框 */}
      {importOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-deep/60 p-6">
          <div className="w-full max-w-2xl max-h-[85vh] flex flex-col bg-ink-850 border border-ink-700 rounded-[14px] shadow-warm-lg">
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-ink-800">
              <h3 className="text-sm font-semibold text-ink-body flex items-center gap-2">
                <ListChecks size={15} /> Import issues from a saved report
              </h3>
              <button
                onClick={() => setImportOpen(false)}
                className="icon-btn text-ink-500 hover:text-ink-body"
                aria-label="Close"
              >
                <X size={15} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-5 space-y-3">
              <div className="flex items-center gap-2">
                <FileText size={14} className="text-ink-500 shrink-0" />
                <select
                  className="input text-sm flex-1"
                  value={selectedReportId}
                  onChange={(e) => loadReportPreview(e.target.value)}
                >
                  {reports.map((r) => (
                    <option key={r.id} value={r.id}>
                      {new Date(r.createdAt).toLocaleString([], {
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}{' '}
                      · {r.wordCount.toLocaleString()} chars
                    </option>
                  ))}
                </select>
              </div>
              {importDraft.length === 0 ? (
                <p className="text-[12px] text-ink-500">
                  No severity-marked issues found in this report (look for 🔴 / 🟡 / 🟢 or Critical
                  / Moderate / Unsure lines).
                </p>
              ) : (
                <div className="space-y-1.5">
                  {importDraft.map((draft, index) => {
                    const sev = SEVERITY_META[draft.severity]
                    return (
                      <div key={index} className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          checked={draft.on}
                          onChange={() =>
                            setImportDraft((prev) =>
                              prev.map((d, i) => (i === index ? { ...d, on: !d.on } : d)),
                            )
                          }
                          className="mt-1"
                        />
                        <span className={clsx('w-2 h-2 rounded-full shrink-0 mt-2', sev.dot)} />
                        <div className="flex-1 min-w-0">
                          <textarea
                            className="textarea text-[12px] w-full min-h-[2.5rem]"
                            value={draft.text}
                            onChange={(e) =>
                              setImportDraft((prev) =>
                                prev.map((d, i) =>
                                  i === index ? { ...d, text: e.target.value } : d,
                                ),
                              )
                            }
                          />
                          {draft.docIds.length > 0 && (
                            <div className="text-[10px] text-star-info mt-1">
                              Docs:{' '}
                              {draft.docIds
                                .map((id) => settingDocs.find((d) => d.id === id)?.title ?? id)
                                .join(', ')}
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
            <div className="shrink-0 flex items-center justify-end gap-2 px-5 py-3.5 border-t border-ink-800">
              <button onClick={() => setImportOpen(false)} className="btn btn-sm btn-ghost">
                Cancel
              </button>
              <button
                onClick={addToQueue}
                disabled={importing || importDraft.filter((d) => d.on).length === 0}
                className="btn btn-sm btn-primary"
              >
                {importing ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                {importing
                  ? 'Adding…'
                  : `Add ${importDraft.filter((d) => d.on).length} item${importDraft.filter((d) => d.on).length === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
