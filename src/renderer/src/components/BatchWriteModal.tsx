import { useEffect, useMemo, useState } from 'react'
import { X, Sparkles, Layers } from 'lucide-react'
import clsx from 'clsx'
import type { DiscussionSession, NovelMeta, VoiceProfile } from '@shared/types'
import { orderedChapters } from '@shared/storyMemory'
import { t } from '../i18n'
import { toastError } from '../toast'
import type { BatchWriteMode } from '../batchWrite'
import { clearCustomPrompt, loadCustomPrompt, saveCustomPrompt } from './AiAssistPanel'

export interface BatchWriteConfig {
  mode: BatchWriteMode
  count: number
  startChapterId?: string
  discussionSessionId?: string
  useVoice: boolean
  direction: string
}

interface Props {
  novel: NovelMeta
  voiceProfile: VoiceProfile | null
  onClose: () => void
  onStart: (config: BatchWriteConfig) => void
}

/** localStorage keys for the editable batch system prompts (ai-prompt:<key>:<lang>). */
export const PROMPT_KEY_CONTINUE = 'batch-continue'
export const PROMPT_KEY_REWRITE = 'batch-rewrite'

export default function BatchWriteModal({
  novel,
  voiceProfile,
  onClose,
  onStart,
}: Props): JSX.Element {
  const [mode, setMode] = useState<BatchWriteMode>('continue')
  const [count, setCount] = useState(3)
  const [startChapterId, setStartChapterId] = useState('')
  const [discussions, setDiscussions] = useState<DiscussionSession[]>([])
  const [discussionId, setDiscussionId] = useState('')
  const [useVoice, setUseVoice] = useState(true)
  const [direction, setDirection] = useState('')
  const [showSysPrompt, setShowSysPrompt] = useState(false)
  const [sysContinue, setSysContinue] = useState(() => loadCustomPrompt(PROMPT_KEY_CONTINUE) ?? '')
  const [sysRewrite, setSysRewrite] = useState(() => loadCustomPrompt(PROMPT_KEY_REWRITE) ?? '')
  const [error, setError] = useState('')
  const [starting, setStarting] = useState(false)

  const chapters = useMemo(() => orderedChapters(novel), [novel])

  useEffect(() => {
    window.api
      .listDiscussions()
      .then((list: DiscussionSession[]) => setDiscussions(list.filter((d) => d.conclusion)))
      .catch(() => setDiscussions([]))
  }, [])

  // Start chapter → max N available (rewrite mode).
  const startIndex = chapters.findIndex((c) => c.chapter.id === startChapterId)
  const remaining = startIndex === -1 ? 0 : chapters.length - startIndex
  const maxN = mode === 'rewrite' ? Math.min(10, remaining) : 10
  const effectiveCount = Math.min(count, maxN)

  const selectedDiscussion = discussions.find((d) => d.id === discussionId)

  const submit = (): void => {
    if (mode === 'rewrite' && !startChapterId) {
      setError(t('batchWrite.startChapter') + ' — ' + t('batchWrite.startChapterHint'))
      return
    }
    if (mode === 'rewrite' && maxN < 1) {
      setError(t('batchWrite.maxN', { n: '0' }))
      return
    }
    if (count < 1 || Number.isNaN(count)) {
      setError(t('batchWrite.count'))
      return
    }
    if (useVoice && !voiceProfile) {
      // Degrade gracefully instead of blocking.
      toastError(t('batchWrite.voiceMissing'))
      setUseVoice(false)
    }
    setError('')
    // Persist edited system prompts.
    if (sysContinue.trim()) saveCustomPrompt(PROMPT_KEY_CONTINUE, sysContinue)
    else clearCustomPrompt(PROMPT_KEY_CONTINUE)
    if (sysRewrite.trim()) saveCustomPrompt(PROMPT_KEY_REWRITE, sysRewrite)
    else clearCustomPrompt(PROMPT_KEY_REWRITE)
    setStarting(true)
    onStart({
      mode,
      count: effectiveCount,
      startChapterId: mode === 'rewrite' ? startChapterId : undefined,
      discussionSessionId: discussionId || undefined,
      useVoice: useVoice && !!voiceProfile,
      direction: direction.trim(),
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-deep/40 p-6">
      <div
        className="rounded-lg border border-ink-800 w-full max-w-xl flex flex-col max-h-[88vh]"
        style={{
          background: 'var(--surface-raised)',
          boxShadow: 'var(--shadow-warm-lg)',
        }}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-ink-800">
          <h3 className="text-sm font-semibold text-ink-body flex items-center gap-2">
            <Layers size={15} className="text-star-info" /> {t('batchWrite.title')}
          </h3>
          <button
            onClick={onClose}
            className="icon-btn hover:text-ink-body"
            title={t('batchWrite.cancel')}
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4 text-sm">
          {/* Mode */}
          <div className="flex gap-3">
            {(['continue', 'rewrite'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={clsx(
                  'flex-1 rounded-md border px-3 py-2 text-left transition-colors',
                  mode === m
                    ? 'border-star-info/60 bg-star-info/10 text-star-info'
                    : 'border-ink-800 text-ink-muted hover:border-ink-700',
                )}
              >
                <span className="block font-medium">{t(`batchWrite.mode.${m}`)}</span>
                <span className="block text-xs mt-0.5 opacity-80">
                  {m === 'continue' ? t('batchWrite.subtitle') : t('batchWrite.startChapterHint')}
                </span>
              </button>
            ))}
          </div>

          {/* N */}
          <div className="grid grid-cols-2 gap-4">
            <label className="block">
              <span className="text-xs text-ink-500">{t('batchWrite.count')}</span>
              <input
                type="number"
                min={1}
                max={maxN}
                value={count}
                onChange={(e) => setCount(Number(e.target.value))}
                className="input mt-1 w-full"
              />
              {mode === 'rewrite' && maxN < 10 && (
                <span className="text-[11px] text-star-accent">
                  {t('batchWrite.maxN', { n: String(maxN) })}
                </span>
              )}
            </label>

            {/* Start chapter (rewrite only) */}
            {mode === 'rewrite' && (
              <label className="block">
                <span className="text-xs text-ink-500">{t('batchWrite.startChapter')}</span>
                <select
                  value={startChapterId}
                  onChange={(e) => setStartChapterId(e.target.value)}
                  className="input mt-1 w-full"
                >
                  <option value="">—</option>
                  {chapters.map(({ volume, chapter }) => (
                    <option key={chapter.id} value={chapter.id}>
                      {volume.title} / {chapter.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          {/* Workshop report */}
          <label className="block">
            <span className="text-xs text-ink-500">{t('batchWrite.discussion')}</span>
            <select
              value={discussionId}
              onChange={(e) => setDiscussionId(e.target.value)}
              className="input mt-1 w-full"
            >
              <option value="">{t('batchWrite.discussionNone')}</option>
              {discussions.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.topic} · {new Date(d.createdAt).toLocaleDateString()}
                </option>
              ))}
            </select>
            <span className="text-[11px] text-ink-500">{t('batchWrite.discussionHint')}</span>
          </label>
          {selectedDiscussion?.conclusion && (
            <div className="rounded-md border border-ink-800 bg-ink-900/60 px-3 py-2 text-xs text-ink-muted max-h-28 overflow-y-auto whitespace-pre-wrap">
              {selectedDiscussion.conclusion.slice(0, 600)}
              {selectedDiscussion.conclusion.length > 600 ? '…' : ''}
            </div>
          )}

          {/* Voice profile */}
          <label className="flex items-start gap-2.5">
            <input
              type="checkbox"
              checked={useVoice && !!voiceProfile}
              disabled={!voiceProfile}
              onChange={(e) => setUseVoice(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              <span className="block text-ink-body">{t('batchWrite.voice')}</span>
              {!voiceProfile && (
                <span className="block text-[11px] text-star-accent">
                  {t('batchWrite.voiceMissing')}
                </span>
              )}
            </span>
          </label>

          {/* Direction */}
          <label className="block">
            <span className="text-xs text-ink-500">{t('batchWrite.direction')}</span>
            <textarea
              value={direction}
              onChange={(e) => setDirection(e.target.value)}
              placeholder={t('batchWrite.directionPlaceholder')}
              className="textarea mt-1 w-full min-h-16 resize-y text-sm"
            />
          </label>

          {/* Editable system prompts */}
          <div className="border-t border-ink-800 pt-3">
            <button
              onClick={() => setShowSysPrompt((v) => !v)}
              className="flex items-center gap-1.5 text-xs text-ink-500 hover:text-ink-muted transition-colors"
            >
              <Sparkles size={12} /> {t('batchWrite.systemPrompt')}
              {(sysContinue.trim() || sysRewrite.trim()) && (
                <span className="w-1.5 h-1.5 rounded-full bg-star-accent" />
              )}
              <span className="ml-auto text-[11px]">{showSysPrompt ? '▲' : '▼'}</span>
            </button>
            {showSysPrompt && (
              <div className="mt-2 space-y-3">
                <div>
                  <div className="text-[11px] text-ink-500 mb-1">
                    {t('batchWrite.systemPromptContinue')}
                  </div>
                  <textarea
                    className="textarea w-full min-h-20 resize-y text-[11px] leading-relaxed font-mono"
                    value={sysContinue}
                    onChange={(e) => setSysContinue(e.target.value)}
                  />
                </div>
                <div>
                  <div className="text-[11px] text-ink-500 mb-1">
                    {t('batchWrite.systemPromptRewrite')}
                  </div>
                  <textarea
                    className="textarea w-full min-h-20 resize-y text-[11px] leading-relaxed font-mono"
                    value={sysRewrite}
                    onChange={(e) => setSysRewrite(e.target.value)}
                  />
                </div>
                <div className="flex gap-3">
                  <button
                    onClick={() => {
                      setSysContinue('')
                      clearCustomPrompt(PROMPT_KEY_CONTINUE)
                    }}
                    className="text-[11px] text-ink-500 hover:text-star-accent transition-colors"
                  >
                    {t('batchWrite.reset')} · {t('batchWrite.systemPromptContinue')}
                  </button>
                  <button
                    onClick={() => {
                      setSysRewrite('')
                      clearCustomPrompt(PROMPT_KEY_REWRITE)
                    }}
                    className="text-[11px] text-ink-500 hover:text-star-accent transition-colors"
                  >
                    {t('batchWrite.reset')} · {t('batchWrite.systemPromptRewrite')}
                  </button>
                </div>
              </div>
            )}
          </div>

          {error && <div className="text-xs text-star-danger leading-relaxed">{error}</div>}
        </div>

        <div className="flex items-center justify-end gap-2.5 px-5 py-3.5 border-t border-ink-800">
          <button onClick={onClose} className="btn btn-sm btn-ghost">
            {t('batchWrite.cancel')}
          </button>
          <button onClick={submit} disabled={starting} className="btn btn-sm btn-primary">
            <Layers size={13} /> {starting ? '…' : t('batchWrite.submit')}
          </button>
        </div>
      </div>
    </div>
  )
}
