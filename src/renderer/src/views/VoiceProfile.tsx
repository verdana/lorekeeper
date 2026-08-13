import { useState, useEffect, useRef } from 'react'
import { Mic, Loader2, RefreshCw, Check, FileText, ClipboardPaste, PenLine, X } from 'lucide-react'
import { useStore } from '../store'
import { toastError } from '../toast'
import { PROMPTS } from '@shared/prompts'
import { isProfileEmpty } from '../writingStyle'
import MarkdownEditor from '../components/MarkdownEditor'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkCjkFriendly from 'remark-cjk-friendly'
import { markdownRehypePlugins } from '../lib'
import type { VoiceProfile, VoiceTraits, Chapter } from '@shared/types'

const SAMPLE_COUNT = 3 // chapters to sample for voice analysis
/** Pasted prose needs at least this many chars to be a meaningful sample. */
const MIN_PASTED_LENGTH = 200
/** Manual voice descriptions are capped like other pasted text. */
const MAX_MANUAL_LENGTH = 8000

/** Blank traits used when a manual-only profile has no analysed data yet. */
const EMPTY_TRAITS: VoiceTraits = {
  sentenceLength: '',
  verbStyle: '',
  narrativeDistance: '',
  dialogueStyle: '',
  rhetoricalPatterns: '',
  proseNotes: '',
}

/** Ordered [trait key, display label] rows shown in the profile card.
 *  Mirrors the analysis schema; optional traits render "—" when absent. */
const TRAIT_ROWS: Array<[keyof VoiceTraits, string]> = [
  ['sentenceLength', 'Sentence length'],
  ['verbStyle', 'Verb style'],
  ['diction', 'Diction'],
  ['syntax', 'Syntax'],
  ['punctuation', 'Punctuation'],
  ['paragraphing', 'Paragraphing'],
  ['narrativeDistance', 'Narrative distance'],
  ['characterVoices', 'Character voices'],
  ['dialogueStyle', 'Dialogue'],
  ['emotionExternalization', 'Emotion externalization'],
  ['sensoryPalette', 'Sensory palette'],
  ['rhetoricalPatterns', 'Rhetorical patterns'],
  ['motifs', 'Motifs'],
  ['taboos', 'Taboos'],
  ['proseNotes', 'Notes'],
]

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
  const [manualText, setManualText] = useState('')
  // True once the user has edited the textarea by hand; while dirty we never
  // overwrite it from the store (avoids clobbering in-flight typing) and we
  // re-sync once the user applies/clears so later refresh / History restores
  // stay reflected in the box.
  const manualDirty = useRef(false)

  useEffect(() => {
    loadVoiceProfile()
  }, [loadVoiceProfile])

  useEffect(() => {
    if (manualDirty.current) return
    setManualText(voiceProfile?.manualText ?? '')
  }, [voiceProfile])

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
    // If the user has touched the manual box, persist exactly what it holds —
    // an empty box removes the manual voice, a draft becomes the active one.
    // An untouched box keeps the applied manual voice as-is.
    const manualDraft = manualText.trim().slice(0, MAX_MANUAL_LENGTH)
    const manualTextToSave = manualDirty.current
      ? manualDraft.length > 0
        ? manualDraft
        : undefined
      : voiceProfile?.manualText
    const profile: VoiceProfile = {
      generatedAt: Date.now(),
      sampleChapterIds: [...selectedChapterIds],
      sampleTexts: pasted.length >= MIN_PASTED_LENGTH ? [pasted.slice(0, 8000)] : undefined,
      traits: draftTraits,
      manualText: manualTextToSave,
    }
    saveVoiceProfile(profile)
    setManualText(profile.manualText ?? '')
    manualDirty.current = false
    setDraftTraits(null)
  }

  const applyManualVoice = (): void => {
    const text = manualText.trim().slice(0, MAX_MANUAL_LENGTH)
    if (!text) return
    // Keep any analysed traits underneath: clearing the manual text later
    // restores them. A manual-only profile starts from blank traits.
    const base: VoiceProfile = voiceProfile ?? {
      generatedAt: 0,
      sampleChapterIds: [],
      traits: { ...EMPTY_TRAITS },
    }
    saveVoiceProfile({ ...base, generatedAt: Date.now(), manualText: text })
    setManualText(text)
    manualDirty.current = false
  }

  const clearManualVoice = (): void => {
    if (!voiceProfile?.manualText) return
    saveVoiceProfile({ ...voiceProfile, manualText: undefined })
    setManualText('')
    manualDirty.current = false
  }

  const renderTraits = (traits: VoiceTraits): JSX.Element => (
    <div className="space-y-3 text-sm">
      {TRAIT_ROWS.slice(0, -1).map(([key, label]) => (
        <div key={key}>
          <span className="font-medium text-ink-muted">{label}:</span>{' '}
          <span className="text-ink-body">{traits[key] || '—'}</span>
        </div>
      ))}
      <div className="pt-2 border-t border-ink-800">
        <span className="font-medium text-ink-muted">{TRAIT_ROWS[TRAIT_ROWS.length - 1][1]}:</span>{' '}
        <span className="text-ink-body">{traits[TRAIT_ROWS[TRAIT_ROWS.length - 1][0]] || '—'}</span>
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
        {voiceProfile && !isProfileEmpty(voiceProfile) && (
          <section className="space-y-3">
            <h2 className="text-sm font-medium text-ink-muted flex items-center gap-1.5">
              <Check size={14} className="text-star-success" /> Current Profile
            </h2>
            <p className="text-[11px] text-ink-500">
              {voiceProfile.manualText ? (
                <>
                  <PenLine size={10} className="inline mr-1 text-star-accent" />
                  Manual voice applied {new Date(voiceProfile.generatedAt).toLocaleString()} —
                  overrides the analysed profile while present.
                </>
              ) : (
                <>
                  Generated {new Date(voiceProfile.generatedAt).toLocaleString()} from{' '}
                  {voiceProfile.sampleChapterIds.length} chapters
                  {voiceProfile.sampleTexts && voiceProfile.sampleTexts.length > 0
                    ? ` + ${voiceProfile.sampleTexts.length} pasted prose sample${voiceProfile.sampleTexts.length > 1 ? 's' : ''}`
                    : ''}
                  .
                </>
              )}
              <button onClick={loadVoiceProfile} className="ml-2 text-star-info hover:underline">
                <RefreshCw size={10} className="inline" /> refresh
              </button>
            </p>
            <div className="p-4 bg-ink-900 rounded-lg border border-ink-800">
              {voiceProfile.manualText ? (
                <div className="markdown-body">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm, remarkCjkFriendly]}
                    rehypePlugins={markdownRehypePlugins}
                  >
                    {voiceProfile.manualText}
                  </ReactMarkdown>
                </div>
              ) : (
                renderTraits(voiceProfile.traits)
              )}
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

        {/* Manually written voice: no AI analysis needed — the text is applied
            to writing prompts verbatim and takes precedence over the analysed
            profile while present. */}
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-ink-muted flex items-center gap-1.5">
            <PenLine size={14} /> Or write your voice profile manually
          </h2>
          <p className="text-[11px] text-ink-500">
            Skip analysis entirely: write or paste a description of your writing voice (tone,
            sentence rhythm, diction, dialogue style, what to avoid). Markdown is supported — use
            the <span className="font-medium">Read</span> toggle to preview. It is applied to
            writing prompts verbatim and overrides the analysed profile while present — no API key
            needed.
          </p>
          <div className="h-64 rounded-lg border border-ink-800 bg-ink-900">
            <MarkdownEditor
              value={manualText}
              placeholder={
                'e.g. Third-person limited, mostly short declarative sentences with an ironic undertone; ' +
                'concrete sensory detail over abstraction; dialogue is terse with heavy subtext; ' +
                'avoid purple prose and adverbs.'
              }
              onChange={(v) => {
                manualDirty.current = true
                setManualText(v.slice(0, MAX_MANUAL_LENGTH))
              }}
            />
          </div>
          {manualText.length >= MAX_MANUAL_LENGTH && (
            <p className="text-[11px] text-star-accent">
              {MAX_MANUAL_LENGTH} character limit reached.
            </p>
          )}
          <div className="flex items-center gap-2">
            <button
              disabled={!manualText.trim()}
              onClick={applyManualVoice}
              className="btn btn-sm btn-primary"
            >
              <Check size={13} /> {voiceProfile?.manualText ? 'Update Voice' : 'Apply Voice'}
            </button>
            {voiceProfile?.manualText && (
              <button onClick={clearManualVoice} className="btn btn-sm btn-secondary">
                <X size={13} /> Clear &amp; restore analysis
              </button>
            )}
          </div>
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

        {(!voiceProfile || isProfileEmpty(voiceProfile)) &&
          !draftTraits &&
          allChapters.length > 0 && (
            <section className="p-4 bg-ink-900 rounded-lg border border-ink-800 text-center">
              <p className="text-xs text-ink-500 mb-3">
                No voice profile yet. Select {SAMPLE_COUNT} chapters and run the analysis, or write
                your voice manually above.
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
