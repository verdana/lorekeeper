import { useState } from 'react'
import { X, Square, RotateCcw, Play, Trash2, ArrowLeft, Layers } from 'lucide-react'
import clsx from 'clsx'
import { useStore } from '../store'
import { t } from '../i18n'
import { toastError, toastSuccess } from '../toast'
import type { BatchChapterStatus, BatchTaskStatus } from '../batchWrite'

const STATUS_ICON: Record<BatchChapterStatus, string> = {
  pending: '○',
  writing: '⟳',
  done: '✓',
  failed: '✗',
  stopped: '⊘',
  deleted: '⌫',
}

export default function BatchWriteProgress(): JSX.Element | null {
  const task = useStore((s) => s.batchWriteTask)
  const currentWorldId = useStore((s) => s.currentWorldId)
  const [confirmDismiss, setConfirmDismiss] = useState(false)
  if (!task) return null

  const lockedByOtherWorld = task.worldId !== currentWorldId
  const isActive =
    task.status === 'preparing' || task.status === 'running' || task.status === 'retrying'
  const canResume =
    (task.status === 'attention' || task.status === 'stopped') && !lockedByOtherWorld
  const firstRecoverable = task.chapters.findIndex(
    (c) => c.status !== 'done' && c.status !== 'deleted',
  )
  const failedChapter = task.chapters.find((c) => c.status === 'failed')

  const header =
    task.status === 'preparing'
      ? t('batchWrite.progress.preparing')
      : task.status === 'attention'
        ? t('batchWrite.progress.attention')
        : task.status === 'stopped'
          ? t('batchWrite.progress.stopped')
          : task.status === 'failed'
            ? t('batchWrite.progress.failed', { error: task.error ?? '' })
            : task.status === 'done'
              ? t('batchWrite.summary', {
                  done: String(task.chapters.filter((c) => c.status === 'done').length),
                  failed: String(task.chapters.filter((c) => c.status === 'failed').length),
                })
              : task.mode === 'rewrite'
                ? t('batchWrite.progress.rewriting', {
                    i: String(Math.min(task.currentIndex + 1, task.count)),
                    n: String(task.count),
                  })
                : t('batchWrite.progress.writing', {
                    i: String(Math.min(task.currentIndex + 1, task.count)),
                    n: String(task.count),
                  })

  const doneCount = task.chapters.filter(
    (c) => c.status === 'done' || c.status === 'deleted',
  ).length
  const progress = task.count === 0 ? 0 : doneCount / task.count

  const dismiss = (): void => {
    if (task.status === 'attention' || task.status === 'stopped') {
      const hasArtifacts = task.chapters.some(
        (c) =>
          c.status === 'failed' ||
          c.generatedText ||
          (c.status === 'stopped' && task.mode === 'continue'),
      )
      if (hasArtifacts && !confirmDismiss) {
        setConfirmDismiss(true)
        return
      }
    }
    useStore.getState().clearBatchTask()
  }

  const retryContinue = (): void => {
    if (firstRecoverable === -1) return
    useStore.getState().resumeBatchWrite(firstRecoverable)
  }

  const deleteChapter = async (chapterId: string): Promise<void> => {
    try {
      await useStore.getState().deleteBatchChapter(chapterId)
      toastSuccess(t('batchWrite.delete'))
    } catch (e) {
      toastError(t('batchWrite.progress.failed', { error: (e as Error).message }))
    }
  }

  const backToWorld = async (): Promise<void> => {
    try {
      await useStore.getState().enterWorld(task.worldId)
    } catch {
      // Guarded by the store; ignore.
    }
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 w-80 rounded-lg border border-ink-800 bg-ink-900 shadow-warm-lg flex flex-col">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-ink-800">
        <span className="text-sm font-medium text-star-info flex items-center gap-2">
          <Layers size={14} /> {t('batchWrite.title')}
        </span>
        <span className="text-[11px] text-ink-500">
          {t('batchWrite.world', { name: task.worldName })}
        </span>
      </div>

      <div className="px-4 py-3 space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="text-ink-body truncate">{header}</span>
          <span className="text-ink-500 tabular-nums">
            {doneCount}/{task.count}
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-ink-800 overflow-hidden">
          <div
            className="h-full bg-star-info transition-all duration-300"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>

        <div className="max-h-48 overflow-y-auto space-y-0.5 mt-1">
          {task.chapters.map((c, idx) => (
            <div key={c.id} className="flex items-center gap-2 text-xs text-ink-muted">
              <span
                className={clsx(
                  'w-4 shrink-0 text-center tabular-nums',
                  c.status === 'writing' && 'text-star-info',
                  c.status === 'done' && 'text-star-success',
                  c.status === 'failed' && 'text-star-danger',
                )}
              >
                {STATUS_ICON[c.status]}
              </span>
              <span className="flex-1 truncate" title={c.title}>
                {idx + 1}. {c.title}
              </span>
              {c.status === 'done' && <span className="tabular-nums text-ink-500">{c.words}</span>}
              {c.status === 'failed' && task.mode === 'continue' && (
                <button
                  onClick={() => deleteChapter(c.id)}
                  className="icon-btn hover:text-star-accent"
                  title={t('batchWrite.delete')}
                >
                  <Trash2 size={11} />
                </button>
              )}
            </div>
          ))}
        </div>

        {failedChapter && (
          <div className="text-[11px] text-star-danger leading-snug break-words">
            {t('batchWrite.progress.failed', { error: failedChapter.error ?? '' })}
          </div>
        )}
        {lockedByOtherWorld && (
          <button onClick={backToWorld} className="btn btn-sm btn-ghost w-full justify-start">
            <ArrowLeft size={12} /> {t('batchWrite.backToWorld')}
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 px-4 py-2.5 border-t border-ink-800">
        {isActive && (
          <button
            onClick={() => useStore.getState().stopBatchWrite()}
            className="btn btn-sm btn-ghost text-star-danger"
          >
            <Square size={12} /> {t('batchWrite.stop')}
          </button>
        )}
        {canResume && firstRecoverable !== -1 && (
          <button onClick={retryContinue} className="btn btn-sm btn-secondary">
            <RotateCcw size={12} /> {t('batchWrite.retryContinue')}
          </button>
        )}
        {task.status === 'stopped' && !lockedByOtherWorld && firstRecoverable !== -1 && (
          <button onClick={retryContinue} className="btn btn-sm btn-secondary">
            <Play size={12} /> {t('batchWrite.continueBatch')}
          </button>
        )}
        <button
          onClick={dismiss}
          disabled={isActive}
          className="btn btn-sm btn-ghost ml-auto disabled:opacity-40"
        >
          <X size={12} /> {t('batchWrite.dismiss')}
        </button>
      </div>

      {confirmDismiss && (
        <div className="px-4 py-2 border-t border-ink-800 bg-ink-950/60 text-xs text-ink-muted space-y-2">
          <div>{t('batchWrite.confirmAbandon')}</div>
          <div className="flex gap-2">
            <button
              onClick={() => useStore.getState().clearBatchTask()}
              className="btn btn-sm btn-primary"
            >
              {t('batchWrite.dismiss')}
            </button>
            <button onClick={() => setConfirmDismiss(false)} className="btn btn-sm btn-ghost">
              {t('batchWrite.cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
