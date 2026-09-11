/**
 * "Merge into the codex" dialog: stream a rewritten document for preview, then
 * write it back, or distribute the conclusion to the timeline or Story Memory.
 */

import { useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { useStore } from '../../store'
import { mergeConclusion } from '../../discussion'
import { uid } from '../../lib'
import { toastError, toastSuccess, parseAiError } from '../../toast'
import type {
  StoryMemoryEntry,
  StoryMemoryKind,
  StoryMemoryStore,
  TimelineEvent,
} from '@shared/types'

import { Loader2, Check, Brain, ArrowRight, FileEdit, X, Clock } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkCjkFriendly from 'remark-cjk-friendly'
import type { MergeState } from './types'
import { replaceLatexMath } from './parts'

// ============ 合并到设定：对话框 ============

export function MergeDialog({
  state,
  setState,
  onDone,
}: {
  state: MergeState
  setState: Dispatch<SetStateAction<MergeState | null>>
  onDone: () => void
}): JSX.Element {
  const settingDocs = useStore((s) => s.settingDocs)
  const providers = useStore((s) => s.config)!.ai.providers
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const abortRef = useRef<AbortController>(undefined)

  const doc = settingDocs.find((d) => d.id === state.docId)

  const generate = async (): Promise<void> => {
    if (!doc) return
    setError('')
    const controller = new AbortController()
    abortRef.current = controller
    const MAX_TRY = 3 // 首次 + 2 次重试，应对偶发失败/空返回
    try {
      const { content: original } = await window.api.readSetting(doc.id)
      let merged = ''
      let lastErr = ''
      for (let attempt = 1; attempt <= MAX_TRY; attempt++) {
        if (controller.signal.aborted) return
        // 每次尝试前清空预览，避免拼上一次的残缺输出
        let acc = ''
        setState({
          ...state,
          original,
          merged: '',
          phase: 'generating',
        })
        try {
          merged = await mergeConclusion({
            title: doc.title,
            original,
            topic: state.topic,
            conclusion: state.conclusion,
            providerId: state.providerId,
            onDelta: (delta) => {
              acc += delta
              setState((prev) => (prev ? { ...prev, merged: acc } : prev))
            },
            signal: controller.signal,
          })
        } catch (e) {
          if (controller.signal.aborted) return
          lastErr = (e as Error).message
          merged = ''
        }
        if (merged.trim()) break // 成功拿到正文
        if (attempt < MAX_TRY) setError(`Attempt ${attempt} was empty or failed, retrying…`)
      }
      if (controller.signal.aborted) return
      if (!merged.trim()) {
        setError(
          lastErr ||
            'The AI repeatedly returned no merged text (the selected model may have put the content into its reasoning). Please retry, or switch to a non-reasoning model in Settings.',
        )
        toastError(lastErr || 'Merge failed — the AI returned no text.')
        setState({ ...state, original, phase: 'pick' })
        return
      }
      setError('')
      setState({ ...state, original, merged, phase: 'preview' })
    } catch (e) {
      if (!controller.signal.aborted) {
        setError((e as Error).message)
        toastError(parseAiError(e))
        setState({ ...state, phase: 'pick' })
      }
    }
  }

  const setDistribute = (patch: Partial<MergeState['distribute']>): void =>
    setState((prev) => (prev ? { ...prev, distribute: { ...prev.distribute, ...patch } } : prev))

  /** 把结论分发到 Timeline / Story Memory(逐项容错,不因单项失败中断)。 */
  const distributeConclusion = async (): Promise<string[]> => {
    const done: string[] = []
    if (state.distribute.timeline) {
      try {
        const events: TimelineEvent[] = await window.api.listTimelineEvents()
        const maxOrder = events.reduce((max, ev) => Math.max(max, ev.dateOrder), 0)
        const event: TimelineEvent = {
          id: uid('ev_'),
          title: state.distribute.timelineTitle.trim() || state.topic || 'Discussion conclusion',
          dateLabel: state.distribute.timelineDate.trim(),
          dateOrder: maxOrder + 1,
          description: state.conclusion.trim(),
          docRefs: doc ? [doc.id] : [],
        }
        await window.api.saveTimelineEvents([...events, event])
        done.push('timeline')
      } catch (e) {
        toastError('Failed to create timeline event: ' + (e as Error).message)
      }
    }
    if (state.distribute.memory && state.distribute.memoryStatement.trim()) {
      try {
        const store = await window.api.readStoryMemory()
        const now = Date.now()
        const entry: StoryMemoryEntry = {
          id: uid('mem_'),
          kind: state.distribute.memoryKind,
          statement: state.distribute.memoryStatement.trim().slice(0, 600),
          entityRefIds: doc ? [doc.id] : [],
          // 作者从讨论结论主动录入,没有章节来源;UI 显示为 author note。
          source: {
            chapterId: '',
            chapterFile: '',
            chapterTitle: '',
            volumeId: '',
            volumeOrder: -1,
            chapterOrder: -1,
            fingerprint: '',
            evidence: '',
          },
          timelineEventId: null,
          storyDateLabel: '',
          confidence: null,
          status: 'confirmed',
          origin: 'author',
          createdAt: now,
          updatedAt: now,
          confirmedAt: now,
        }
        const next: StoryMemoryStore = { ...store, entries: [entry, ...store.entries] }
        await window.api.writeStoryMemory(next)
        done.push('story memory')
      } catch (e) {
        toastError('Failed to save to Story Memory: ' + (e as Error).message)
      }
    }
    return done
  }

  const confirmWrite = async (): Promise<void> => {
    if (!doc) return
    setSaving(true)
    try {
      await window.api.writeSetting(doc.id, state.merged)
    } catch (e) {
      setError((e as Error).message)
      toastError('Failed to write merged document.')
      setSaving(false)
      return
    }
    const extra = await distributeConclusion()
    onDone()
    toastSuccess(`Merged into "${doc.title}"${extra.length > 0 ? ` + ${extra.join(', ')}` : ''}.`)
  }

  const close = (): void => {
    abortRef.current?.abort()
    setState(null)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-deep/40 p-6">
      <div
        className="rounded-lg border border-ink-800 w-full max-w-5xl max-h-[88vh] flex flex-col"
        style={{
          background: 'var(--surface-raised)',
          boxShadow: 'var(--shadow-warm-lg)',
        }}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-ink-800">
          <h3 className="text-sm font-semibold text-ink-body flex items-center gap-2">
            <FileEdit size={16} /> Merge conclusion into codex
          </h3>
          <button onClick={close} className="icon-btn hover:text-ink-muted" title="Close">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {state.phase === 'pick' && (
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-ink-500 mb-1.5">
                  Codex document to update
                </label>
                {settingDocs.length === 0 ? (
                  <p className="text-sm text-ink-500">
                    No codex documents yet — create one under Codex first.
                  </p>
                ) : (
                  <select
                    className="input"
                    value={state.docId}
                    onChange={(e) => setState({ ...state, docId: e.target.value })}
                  >
                    {settingDocs.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.title}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <div>
                <label className="block text-xs text-ink-500 mb-1.5">Model for merging</label>
                <select
                  className="input"
                  value={state.providerId ?? ''}
                  onChange={(e) => setState({ ...state, providerId: e.target.value })}
                >
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · {p.model}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-ink-500 mt-1.5">
                  Merging rewrites the full text per the conclusion, so a <b>non-reasoning model</b>{' '}
                  is recommended — a reasoning model spends its budget thinking and leaves the text
                  incomplete.
                </p>
              </div>
              <div>
                <label className="block text-xs text-ink-500 mb-1.5">Conclusion to merge</label>
                <div className="markdown-body text-sm bg-ink-900 rounded-md px-4 py-3 max-h-64 overflow-y-auto">
                  <ReactMarkdown remarkPlugins={[remarkGfm, remarkCjkFriendly]}>
                    {replaceLatexMath(state.conclusion)}
                  </ReactMarkdown>
                </div>
              </div>

              {/* 结论分发:除写入 codex 外,可同步落到时间线 / 记忆 */}
              <div className="border-t border-ink-800 pt-3 space-y-2.5">
                <label className="block text-xs text-ink-500">Also distribute the conclusion</label>
                <label className="flex items-center gap-2 text-sm text-ink-muted cursor-pointer">
                  <input
                    type="checkbox"
                    checked={state.distribute.timeline}
                    onChange={(e) => setDistribute({ timeline: e.target.checked })}
                  />
                  <Clock size={13} /> Create a timeline event
                </label>
                {state.distribute.timeline && (
                  <div className="grid grid-cols-2 gap-2 pl-6">
                    <input
                      className="input"
                      placeholder="Event title"
                      value={state.distribute.timelineTitle}
                      onChange={(e) => setDistribute({ timelineTitle: e.target.value })}
                    />
                    <input
                      className="input"
                      placeholder="Date label (optional)"
                      value={state.distribute.timelineDate}
                      onChange={(e) => setDistribute({ timelineDate: e.target.value })}
                    />
                  </div>
                )}
                <label className="flex items-center gap-2 text-sm text-ink-muted cursor-pointer">
                  <input
                    type="checkbox"
                    checked={state.distribute.memory}
                    onChange={(e) => setDistribute({ memory: e.target.checked })}
                  />
                  <Brain size={13} /> Save the conclusion to Story Memory
                </label>
                {state.distribute.memory && (
                  <div className="pl-6 space-y-2">
                    <select
                      className="input"
                      value={state.distribute.memoryKind}
                      onChange={(e) =>
                        setDistribute({ memoryKind: e.target.value as StoryMemoryKind })
                      }
                    >
                      {(
                        [
                          ['character-state', 'Character state'],
                          ['relationship', 'Relationship'],
                          ['knowledge', 'Knowledge'],
                          ['location', 'Location'],
                          ['object', 'Object'],
                          ['world-state', 'World state'],
                          ['open-thread', 'Open thread'],
                        ] as [StoryMemoryKind, string][]
                      ).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                    <textarea
                      className="textarea text-sm h-24"
                      placeholder="Memory statement (author-confirmed)"
                      value={state.distribute.memoryStatement}
                      onChange={(e) => setDistribute({ memoryStatement: e.target.value })}
                    />
                  </div>
                )}
              </div>

              {error && <div className="text-sm text-star-danger">{error}</div>}
            </div>
          )}

          {(state.phase === 'generating' || state.phase === 'preview') && (
            <div className="grid grid-cols-2 gap-4 h-full">
              <div className="flex flex-col min-h-0">
                <div className="text-xs text-ink-500 mb-1.5">Original</div>
                <pre className="flex-1 overflow-y-auto text-[13px] leading-relaxed text-ink-faint bg-ink-900 rounded-md p-3 whitespace-pre-wrap font-sans">
                  {state.original || '(this document is currently empty)'}
                </pre>
              </div>
              <div className="flex flex-col min-h-0">
                <div className="text-xs text-star-success mb-1.5 flex items-center gap-1.5">
                  Merged (new version)
                  {state.phase === 'generating' && <Loader2 size={12} className="animate-spin" />}
                </div>
                <pre className="flex-1 overflow-y-auto text-[13px] leading-relaxed text-ink-body bg-star-accent/5 border border-star-accent/20 rounded-md p-3 whitespace-pre-wrap font-sans">
                  {state.merged}
                  {state.phase === 'generating' && (
                    <span className="inline-block w-1.5 h-4 bg-star-accent/60 animate-pulse align-middle" />
                  )}
                </pre>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-ink-800">
          {error && state.phase !== 'pick' && (
            <span className="text-sm text-star-danger mr-auto">{error}</span>
          )}
          <button onClick={close} className="btn btn-ghost btn-sm">
            Cancel
          </button>
          {state.phase === 'pick' && (
            <button onClick={generate} disabled={!doc} className="btn btn-primary btn-sm">
              <ArrowRight size={14} /> Generate preview
            </button>
          )}
          {state.phase === 'preview' && (
            <>
              <button
                onClick={() => setState({ ...state, phase: 'pick', merged: '' })}
                className="btn btn-secondary btn-sm"
              >
                Regenerate
              </button>
              <button onClick={confirmWrite} disabled={saving} className="btn btn-primary btn-sm">
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                Write to {doc?.title}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * 收敛模式的顶栏：先Render.提案清单(可点选深钻),选定后切换为焊死的 focus 横幅。
 * 与消息列表并列在滚动区顶部,不占底部输入条位置。
 */
