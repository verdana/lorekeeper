/**
 * The brief: everything the pipeline needs before it can start, in one form.
 *
 * Only the theme is required. Every empty field is a decision handed to the
 * planner, which is why they are labelled with what happens when they are left
 * blank rather than presented as required inputs.
 */

import { FORGE_LIMITS } from '@shared/forge'
import type { ForgeBrief } from '@shared/types'
import { ChevronDown, ChevronRight, Flame, Loader2, Sparkles, AlertTriangle } from 'lucide-react'
import clsx from 'clsx'
import { GENRE_PRESETS, THEME_IDEAS, TONE_PRESETS } from './constants'

// ---- Brief form ----

export function BriefForm({
  brief,
  setBrief,
  advanced,
  setAdvanced,
  providers,
  existingProse,
  estimatedCalls,
  busy,
  onStart,
}: {
  brief: ForgeBrief
  setBrief: (update: (current: ForgeBrief) => ForgeBrief) => void
  advanced: boolean
  setAdvanced: (value: boolean) => void
  providers: { id: string; name: string; model: string }[]
  existingProse: number
  estimatedCalls: number
  busy: string
  onStart: () => void | Promise<void>
}): JSX.Element {
  const patch = (changes: Partial<ForgeBrief>): void =>
    setBrief((current) => ({ ...current, ...changes }))

  return (
    <div className="space-y-5 max-w-3xl">
      <section className="card">
        <label className="block text-sm font-semibold text-ink-deep mb-2">Theme</label>
        <textarea
          className="textarea min-h-[104px]"
          placeholder="One or two sentences. A premise, an image, a question — whatever the book should grow from."
          value={brief.theme}
          disabled={!!busy}
          autoFocus
          onChange={(e) => patch({ theme: e.target.value })}
        />
        <div className="flex flex-wrap gap-1.5 mt-3">
          <span className="text-[11px] text-ink-500 self-center mr-1">
            <Sparkles size={11} className="inline -mt-0.5 mr-1" />
            Need a spark?
          </span>
          {THEME_IDEAS.map((idea) => (
            <button
              key={idea.label}
              type="button"
              className="tab-pill text-[11px]"
              disabled={!!busy}
              onClick={() => patch({ theme: idea.theme, genre: idea.genre })}
            >
              {idea.label}
            </button>
          ))}
        </div>
      </section>

      <section className="card space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Field label="Genre" hint="Empty = the model picks one">
            <input
              className="input"
              list="forge-genres"
              placeholder="Fantasy…"
              value={brief.genre}
              disabled={!!busy}
              onChange={(e) => patch({ genre: e.target.value })}
            />
            <datalist id="forge-genres">
              {GENRE_PRESETS.map((genre) => (
                <option key={genre} value={genre} />
              ))}
            </datalist>
          </Field>
          <Field label="Tone" hint="Two or three words">
            <input
              className="input"
              list="forge-tones"
              placeholder="Dark and literary…"
              value={brief.tone}
              disabled={!!busy}
              onChange={(e) => patch({ tone: e.target.value })}
            />
            <datalist id="forge-tones">
              {TONE_PRESETS.map((tone) => (
                <option key={tone} value={tone} />
              ))}
            </datalist>
          </Field>
          <Field label="Prose language">
            <select
              className="input"
              value={brief.language}
              disabled={!!busy}
              onChange={(e) => patch({ language: e.target.value as ForgeBrief['language'] })}
            >
              <option value="auto">Follow the app language</option>
              <option value="zh">简体中文</option>
              <option value="en">English</option>
            </select>
          </Field>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Field label="Chapters" hint={`${FORGE_LIMITS.minChapters}–${FORGE_LIMITS.maxChapters}`}>
            <input
              className="input"
              type="number"
              min={FORGE_LIMITS.minChapters}
              max={FORGE_LIMITS.maxChapters}
              value={brief.chapters}
              disabled={!!busy}
              onChange={(e) => patch({ chapters: Number(e.target.value) })}
            />
          </Field>
          <Field label="Words per chapter" hint="CJK characters count as one">
            <input
              className="input"
              type="number"
              min={FORGE_LIMITS.minWordsPerChapter}
              max={FORGE_LIMITS.maxWordsPerChapter}
              step={100}
              value={brief.wordsPerChapter}
              disabled={!!busy}
              onChange={(e) => patch({ wordsPerChapter: Number(e.target.value) })}
            />
          </Field>
          <Field label="Viewpoint" hint="Empty = the model decides">
            <input
              className="input"
              placeholder="Third-person limited…"
              value={brief.pov}
              disabled={!!busy}
              onChange={(e) => patch({ pov: e.target.value })}
            />
          </Field>
        </div>

        <Field label="Author constraints" hint="Binding rules every chapter must respect">
          <textarea
            className="textarea min-h-[64px]"
            placeholder="Single POV. No romance. Every chapter must end on a decision, not a cliffhanger."
            value={brief.constraints}
            disabled={!!busy}
            onChange={(e) => patch({ constraints: e.target.value })}
          />
        </Field>
      </section>

      <section className="card">
        <div className="text-sm font-semibold text-ink-deep mb-3">How far should it go?</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <ScopeCard
            active={brief.scope === 'plan'}
            disabled={!!busy}
            title="Plan only"
            desc="Concept, story bible and chapter outline. You write the prose yourself."
            onClick={() => patch({ scope: 'plan' })}
          />
          <ScopeCard
            active={brief.scope === 'draft'}
            disabled={!!busy}
            title="Plan + draft prose"
            desc="Also writes each chapter, and updates the continuity memory after every one."
            onClick={() => patch({ scope: 'draft' })}
          />
        </div>

        {brief.scope === 'draft' && (
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Chapters to draft" hint="Drafting is resumable — you can continue later">
              <select
                className="input"
                value={brief.draftCount === 0 ? 'all' : 'some'}
                disabled={!!busy}
                onChange={(e) =>
                  patch({ draftCount: e.target.value === 'all' ? 0 : Math.min(3, brief.chapters) })
                }
              >
                <option value="all">All planned chapters</option>
                <option value="some">Only the first…</option>
              </select>
            </Field>
            {brief.draftCount > 0 && (
              <Field label="First N chapters">
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={brief.chapters}
                  value={brief.draftCount}
                  disabled={!!busy}
                  onChange={(e) => patch({ draftCount: Number(e.target.value) })}
                />
              </Field>
            )}
          </div>
        )}
      </section>

      <section className="card space-y-4">
        <button
          type="button"
          className="flex items-center gap-1.5 text-sm font-semibold text-ink-deep"
          onClick={() => setAdvanced(!advanced)}
        >
          {advanced ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          Advanced
        </button>

        {advanced && (
          <div className="space-y-4">
            <Field label="Provider" hint="Defaults to the writing provider, then the active one">
              <select
                className="input"
                value={brief.providerId ?? ''}
                disabled={!!busy}
                onChange={(e) => patch({ providerId: e.target.value || null })}
              >
                <option value="">Use the default provider</option>
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name} · {provider.model}
                  </option>
                ))}
              </select>
            </Field>

            <label className="flex items-start gap-2.5 text-sm text-ink-muted">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={brief.replaceExisting}
                disabled={!!busy}
                onChange={(e) => patch({ replaceExisting: e.target.checked })}
              />
              <span>
                Replace the existing outline
                <span className="block text-[11px] text-ink-500">
                  Required when the world already has chapters with prose. Version snapshots keep
                  the old text recoverable from History.
                </span>
              </span>
            </label>
          </div>
        )}

        {existingProse > 0 && !brief.replaceExisting && (
          <div className="flex items-start gap-2 text-[13px] text-star-accent bg-star-accent/10 rounded-sm px-3 py-2">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>
              This world already has {existingProse} chapter{existingProse === 1 ? '' : 's'} with
              prose. Forging rewrites the outline, so turn on “Replace the existing outline” or
              start from a blank world.
            </span>
          </div>
        )}
      </section>

      <div className="flex items-center gap-4">
        <button
          className="btn btn-primary"
          onClick={onStart}
          disabled={!!busy || !brief.theme.trim()}
        >
          {busy ? <Loader2 className="animate-spin" size={16} /> : <Flame size={16} />}
          {busy || 'Forge the novel'}
        </button>
        <span className="text-[11px] text-ink-500">
          About {estimatedCalls} model calls. Runs in the background — you can leave this view.
        </span>
      </div>
    </div>
  )
}

function ScopeCard({
  active,
  disabled,
  title,
  desc,
  onClick,
}: {
  active: boolean
  disabled: boolean
  title: string
  desc: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        'text-left rounded-md border px-4 py-3 transition-colors disabled:opacity-60',
        active
          ? 'border-star-accent bg-star-accent/5'
          : 'border-ink-800 hover:border-ink-700 bg-ink-900',
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={clsx(
            'w-3.5 h-3.5 rounded-full border-2 shrink-0',
            active ? 'border-star-accent bg-star-accent' : 'border-ink-600',
          )}
        />
        <span className="text-sm font-semibold text-ink-deep">{title}</span>
      </div>
      <div className="text-[11px] text-ink-500 mt-1.5 leading-relaxed">{desc}</div>
    </button>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <label className="block">
      <span className="flex items-baseline gap-2 mb-1.5">
        <span className="text-[13px] font-medium text-ink-muted">{label}</span>
        {hint && <span className="text-[11px] text-ink-500">{hint}</span>}
      </span>
      {children}
    </label>
  )
}
