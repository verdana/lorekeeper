import { useState, useEffect } from 'react'
import { Mic, Loader2, RefreshCw, Check, FileText, ClipboardPaste } from 'lucide-react'
import { useStore } from '../store'
import { toastError } from '../toast'
import { PROMPTS } from '@shared/prompts'
import type { VoiceProfile, VoiceTraits, Chapter } from '@shared/types'

const SAMPLE_COUNT = 3 // chapters to sample for voice analysis
/** Pasted prose needs at least this many chars to be a meaningful sample. */
const MIN_PASTED_LENGTH = 200

export default function VoiceProfileView(): JSX.Element {
  const novel = useStore((s) => s.novel)
  const config = useStore((s) => s.config)
  const voiceProfile = useStore((s) => s.voiceProfile)
  const loadVoiceProfile = useStore((s) => s.loadVoiceProfile)
  const saveVoiceProfile = useStore((s) => s.saveVoiceProfile)

  const allChapters: Chapter[] = (novel?.volumes ?? []).flatMap((v) => v.chapters)
  const [selectedChapterIds, setSelectedChapterIds] = useState<Set<string>>(new Set())
  const [pastedText, setPastedText] = useState('')
  const [analyzing, setAnalyzing] = useState(false)
  const [draftTraits, setDraftTraits] = useState<VoiceTraits | null>(null)

  useEffect(() => {
    loadVoiceProfile()
  }, [])

  const hasKey = config?.ai.providers.some((p) => p.apiKey)
  const hasSamples = selectedChapterIds.size >= 2 || pastedText.trim().length >= MIN_PASTED_LENGTH
  const canAnalyze = hasSamples && hasKey && !analyzing

  const toggleChapter = (id: string): void =>
    setSelectedChapterIds((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else if (n.size < SAMPLE_COUNT) n.add(id)
      return n
    })

  const runAnalysis = async (): Promise<void> => {
    if (!hasSamples) return
    setAnalyzing(true)
    try {
      const ids = [...selectedChapterIds]
      const samples: string[] = []
      for (const id of ids) {
        const ch = allChapters.find((c) => c.id === id)
        if (!ch) continue
        const text = await window.api.readChapter(ch.file)
        samples.push(`### ${ch.title}

${text.slice(0, 3000)}${text.length > 3000 ? '…' : ''}`)
      }
      // Human-written prose pasted in by the author (e.g. from another novel):
      // valid samples even when every chapter in this world is AI-generated.
      const pasted = pastedText.trim()
      if (pasted.length >= MIN_PASTED_LENGTH) {
        samples.push(`### Pasted prose (author-provided sample)

${pasted.slice(0, 8000)}${pasted.length > 8000 ? '…' : ''}`)
      }
      const raw = await window.api.chat(
        [
          { role: 'system', content: PROMPTS.assist.voiceAnalysis.systemPrompt },
          {
            role: 'user',
            content: PROMPTS.assist.voiceAnalysis.userTemplate(samples.join('\n\n---\n\n')),
          },
        ],
        config?.ai.activeProviderId ?? undefined,
      )
      let traits: VoiceTraits
      try {
        traits = JSON.parse(raw.trim()) as VoiceTraits
      } catch {
        const m = raw.match(/{[\s\S]*}/)
        if (m) traits = JSON.parse(m[0]) as VoiceTraits
        else throw new Error('Voice analysis returned invalid JSON')
      }
      setDraftTraits(traits)
    } catch (e) {
      toastError((e as Error).message)
    } finally {
      setAnalyzing(false)
    }
  }

  const saveProfile = (): void => {
    if (!draftTraits) return
    const pasted = pastedText.trim()
    const profile: VoiceProfile = {
      generatedAt: Date.now(),
      sampleChapterIds: [...selectedChapterIds],
      sampleTexts: pasted.length >= MIN_PASTED_LENGTH ? [pasted.slice(0, 8000)] : undefined,
      traits: draftTraits,
    }
    saveVoiceProfile(profile)
    setDraftTraits(null)
  }

  const renderTraits = (traits: VoiceTraits): JSX.Element => (
    <div className="space-y-3 text-sm">
      <div>
        <span className="font-medium text-ink-muted">Sentence length:</span>{' '}
        <span className="text-ink-body">{traits.sentenceLength}</span>
      </div>
      <div>
        <span className="font-medium text-ink-muted">Verb style:</span>{' '}
        <span className="text-ink-body">{traits.verbStyle}</span>
      </div>
      <div>
        <span className="font-medium text-ink-muted">Narrative distance:</span>{' '}
        <span className="text-ink-body">{traits.narrativeDistance}</span>
      </div>
      <div>
        <span className="font-medium text-ink-muted">Dialogue:</span>{' '}
        <span className="text-ink-body">{traits.dialogueStyle}</span>
      </div>
      <div>
        <span className="font-medium text-ink-muted">Rhetorical patterns:</span>{' '}
        <span className="text-ink-body">{traits.rhetoricalPatterns}</span>
      </div>
      <div className="pt-2 border-t border-ink-800">
        <span className="font-medium text-ink-muted">Notes:</span>{' '}
        <span className="text-ink-body">{traits.proseNotes}</span>
      </div>
    </div>
  )

  return (
    <div className="h-full flex flex-col">
      <div className="p-6 border-b border-ink-800">
        <h1 className="text-xl font-semibold text-ink-body flex items-center gap-2">
          <Mic size={20} className="text-star-accent" /> Voice Profile
        </h1>
        <p className="text-xs text-ink-500 mt-1">
          Analyse your prose to build a style profile. The AI will then use it to keep your voice
          consistent during polish and editing.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {/* Current profile */}
        {voiceProfile && (
          <section className="space-y-3">
            <h2 className="text-sm font-medium text-ink-muted flex items-center gap-1.5">
              <Check size={14} className="text-star-success" /> Current Profile
            </h2>
            <p className="text-[11px] text-ink-500">
              Generated {new Date(voiceProfile.generatedAt).toLocaleString()} from{' '}
              {voiceProfile.sampleChapterIds.length} chapters
              {voiceProfile.sampleTexts && voiceProfile.sampleTexts.length > 0
                ? ` + ${voiceProfile.sampleTexts.length} pasted prose sample${voiceProfile.sampleTexts.length > 1 ? 's' : ''}`
                : ''}
              .
              <button onClick={loadVoiceProfile} className="ml-2 text-star-info hover:underline">
                <RefreshCw size={10} className="inline" /> refresh
              </button>
            </p>
            <div className="p-4 bg-ink-900 rounded-lg border border-ink-800">
              {renderTraits(voiceProfile.traits)}
            </div>
          </section>
        )}

        {/* Chapter selection */}
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-ink-muted flex items-center gap-1.5">
            <FileText size={14} /> Select {SAMPLE_COUNT} representative chapters
          </h2>
          <p className="text-[11px] text-ink-500">
            Choose chapters that best represent your natural writing voice — not AI-heavy or highly
            edited ones.
          </p>
          {allChapters.length === 0 ? (
            <p className="text-xs text-ink-500">No chapters yet. Write some chapters first.</p>
          ) : (
            <div className="space-y-1">
              {allChapters.map((c) => {
                const on = selectedChapterIds.has(c.id)
                const full = !on && selectedChapterIds.size >= SAMPLE_COUNT
                return (
                  <button
                    key={c.id}
                    disabled={full}
                    onClick={() => toggleChapter(c.id)}
                    className={`w-full text-left px-3 py-2 rounded text-xs transition-colors ${
                      on
                        ? 'bg-star-info/10 text-star-info border border-star-info/20'
                        : full
                          ? 'opacity-40 cursor-not-allowed bg-ink-850'
                          : 'bg-ink-850 hover:bg-ink-800 text-ink-muted'
                    }`}
                  >
                    {c.title}{' '}
                    <span className="text-ink-500">({c.wordCount.toLocaleString()} words)</span>
                  </button>
                )
              })}
            </div>
          )}
        </section>

        {/* Pasted human-written prose: an alternative sample source when the
            world's chapters are all AI-generated (analyzing AI text would only
            bake the AI voice back in). */}
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-ink-muted flex items-center gap-1.5">
            <ClipboardPaste size={14} /> Or paste human-written prose
          </h2>
          <p className="text-[11px] text-ink-500">
            If every chapter in this world was AI-written, paste {MIN_PASTED_LENGTH}+ characters of
            prose written by a human (your own work, or a passage from a novel you admire) — the
            analysis will learn from it instead.
          </p>
          <textarea
            className="textarea min-h-32 text-sm"
            value={pastedText}
            placeholder={`Paste human-written fiction here (at least ${MIN_PASTED_LENGTH} characters, up to ~8000)…`}
            onChange={(e) => setPastedText(e.target.value)}
          />
          {pastedText.trim().length > 0 && pastedText.trim().length < MIN_PASTED_LENGTH && (
            <p className="text-[11px] text-star-accent">
              {pastedText.trim().length}/{MIN_PASTED_LENGTH} characters — keep pasting.
            </p>
          )}
        </section>

        {/* Draft result */}
        {draftTraits && (
          <section className="space-y-3">
            <h2 className="text-sm font-medium text-star-accent">Analysis Result</h2>
            <div className="p-4 bg-ink-900 rounded-lg border border-star-info/20">
              {renderTraits(draftTraits)}
            </div>
            <div className="flex gap-2">
              <button onClick={saveProfile} className="btn btn-sm btn-primary">
                <Check size={13} /> Save Profile
              </button>
              <button onClick={() => setDraftTraits(null)} className="btn btn-sm btn-secondary">
                Discard
              </button>
            </div>
          </section>
        )}

        {!voiceProfile && !draftTraits && allChapters.length > 0 && (
          <section className="p-4 bg-ink-900 rounded-lg border border-ink-800 text-center">
            <p className="text-xs text-ink-500 mb-3">
              No voice profile yet. Select {SAMPLE_COUNT} chapters and run the analysis.
            </p>
          </section>
        )}
      </div>

      {/* Bottom bar */}
      <div className="p-4 border-t border-ink-800 flex items-center justify-between">
        <span className="text-[11px] text-ink-500">
          {hasSamples
            ? `${selectedChapterIds.size} chapters${pastedText.trim() ? ' + pasted prose' : ''} selected`
            : `${selectedChapterIds.size}/${SAMPLE_COUNT} chapters or ${MIN_PASTED_LENGTH}+ pasted chars`}
        </span>
        <button disabled={!canAnalyze} onClick={runAnalysis} className="btn btn-sm btn-primary">
          {analyzing ? (
            <>
              <Loader2 size={13} className="animate-spin" /> Analysing…
            </>
          ) : (
            <>
              <Mic size={13} /> Analyse Voice
            </>
          )}
        </button>
      </div>
    </div>
  )
}
