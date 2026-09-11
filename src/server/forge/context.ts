/**
 * Novel Forge — the theme-driven whole-book pipeline.
 *
 * One run takes a theme and grows a complete, internally consistent novel out
 * of it, stage by stage:
 *
 *   concept  → a story concept (logline, synopsis, tone, style guide, cast)
 *   codex    → the story bible, written into the world's codex documents
 *   outline  → volumes, chapters and beats, written into the structured outline
 *   draft    → chapter prose, one chapter at a time (+ memory, below)
 *   memory   → a structured chapter summary after each chapter, which rebuilds
 *              the world's story state and becomes the next chapter's context
 *   review   → a non-destructive continuity pass over the drafted chapters
 *   finalize → book metadata committed to novel.json
 *
 * The pipeline is split by layer, each module depending only on those above it:
 *
 *   forge/limits            types and tunables shared by every stage
 *   forge/state             live-run registry, run-file I/O, logging, guards
 *   forge/model-call        one recorded, retried, usage-accounted model call
 *   forge/context           prompt context: concept, beats, codex, voice, plan
 *   forge/*-stages          the stages themselves, in pipeline order
 *   forge.ts                the public control surface and the loop
 *
 * What the layers buy: the stage modules hold prompt and content logic only, and
 * everything that touches run state goes through one module, so "what is
 * persisted, and when" is answerable by reading a single file.
 */
/**
 * Prompt context assembly.
 *
 * Every block a planning or drafting prompt receives is built here: the concept
 * digest, the chapter's plan, the codex digest (characters and world first, then
 * whatever fits), the voice and exemplar material, and the structured outline
 * the plan is written into. Keeping it in one module is what lets the stages
 * stay about prompts and content.
 */

import type {
  ChapterContract,
  ForgeBrief,
  ForgeConcept,
  ForgeRun,
  OutlineBeat,
  OutlineChapterData,
  OutlineStore,
  SettingCategory,
} from '../../shared/types'
import { parseForgePlan } from '../../shared/forge'
import { serializeChapterContract, findOutlineChapter } from '../../shared/outlineStore'
import { PROMPTS } from '../../shared/prompts'
import { BUDGET } from './limits'
import { uid } from '../../shared/uid'
import * as store from '../store'

// ---- Context assembly helpers ----

export function forgeBriefParams(brief: ForgeBrief): {
  theme: string
  languageDirective: string
  genre: string
  tone: string
  pov: string
  chapters: number
  wordsPerChapter: number
  constraints: string
  titleFormat: string
} {
  return {
    theme: brief.theme,
    languageDirective: languageDirective(brief),
    genre: brief.genre,
    tone: brief.tone,
    pov: brief.pov,
    chapters: brief.chapters,
    wordsPerChapter: brief.wordsPerChapter,
    constraints: brief.constraints,
    titleFormat: PROMPTS.forge.chapterTitleFormat[brief.language],
  }
}

export function languageDirective(brief: ForgeBrief): string {
  return PROMPTS.forge.languageDirective[brief.language]
}

/** Compact, stable text form of the concept used across stage prompts. */
export function serializeConcept(concept: ForgeConcept | null): string {
  if (!concept) return '(no concept)'
  const lines = [
    `Title: ${concept.title}`,
    concept.genre ? `Genre: ${concept.genre}` : '',
    concept.logline ? `Logline: ${concept.logline}` : '',
    concept.tone ? `Tone: ${concept.tone}` : '',
    concept.pov ? `Viewpoint: ${concept.pov}` : '',
    concept.themes.length > 0 ? `Themes: ${concept.themes.join('; ')}` : '',
    concept.synopsis ? `Synopsis:\n${concept.synopsis}` : '',
    concept.worldNotes ? `World notes:\n${concept.worldNotes}` : '',
    concept.styleGuide ? `Style guide (applies to every chapter):\n${concept.styleGuide}` : '',
    concept.cast.length > 0
      ? `Cast:\n${concept.cast
          .map(
            (member) =>
              `- ${member.name}${member.role ? ` (${member.role})` : ''}: ${member.description}`,
          )
          .join('\n')}`
      : '',
  ]
  return lines.filter(Boolean).join('\n')
}

/**
 * The plan a chapter must actually deliver.
 *
 * The outline is the authority for structure, so this prefers the outline's
 * current version of the chapter over the snapshot the run started with: an
 * author who edits a chapter's beats or contract after the plan was written
 * expects the next draft — first draft, re-draft or continuation — to obey the
 * edit rather than the version they replaced. The run's snapshot is the
 * fallback for a chapter the outline no longer describes.
 */
export function currentChapterPlan(
  run: ForgeRun,
  index: number,
): { beats: OutlineBeat[]; contract?: ChapterContract } {
  const chapter = run.chapters[index]
  if (!chapter) return { beats: [] }
  const authored = findOutlineChapter(store.readOutlineStore(), chapter.chapterId)
  if (!authored)
    return { beats: chapter.beats, ...(chapter.contract ? { contract: chapter.contract } : {}) }
  return {
    beats: authored.beats,
    ...(authored.contract ? { contract: authored.contract } : {}),
  }
}

/**
 * The active chapter's plan: its beats, its volume's purpose, and the titles of
 * its neighbours, so the chapter sits in the book rather than floating free.
 */
export function chapterPlanText(run: ForgeRun, index: number): string {
  const chapter = run.chapters[index]
  if (!chapter) return ''
  const plan = currentChapterPlan(run, index)
  const lines = [
    chapter.volumeTitle ? `Volume: ${chapter.volumeTitle}` : '',
    `Beats (land every one, in order):`,
    serializeBeats(plan.beats) || '- (no beats were planned; invent nothing beyond the concept)',
    // The author's decisions for this chapter ride with the plan, so every draft
    // path (first draft, re-draft, continue) is bound by them without having to
    // remember to pass them separately.
    serializeChapterContract(plan.contract),
  ]
  const previous = run.chapters[index - 1]
  const next = run.chapters[index + 1]
  if (previous) lines.push(`Previous chapter: ${previous.title}`)
  if (next) lines.push(`Next chapter (do not write it, but leave it possible): ${next.title}`)
  return lines.filter(Boolean).join('\n')
}

export function serializeBeats(beats: OutlineBeat[]): string {
  return beats
    .map((beat, i) => {
      const title = beat.title.trim()
      const summary = beat.summary.trim()
      if (title && summary) return `${i + 1}. ${title}: ${summary}`
      return `${i + 1}. ${title || summary}`
    })
    .filter((line) => line.trim().length > 2)
    .join('\n')
}

/** The tail of the preceding chapter's prose, for voice and continuity. */
export function previousChapterTail(
  previous: { chapterId: string } | undefined,
  limit = 0,
): string {
  if (!previous) return ''
  const meta = store.getNovelMeta()
  const file = chapterFileById(
    meta.volumes.flatMap((v) => v.chapters),
    previous.chapterId,
  )
  if (!file) return ''
  const prose = store.readChapter(file).trim()
  if (!prose) return ''
  const budget = limit > 0 ? limit : BUDGET.previousEnding
  return prose.length <= budget ? prose : `…${prose.slice(-budget)}`
}

/**
 * Author voice material: the hand-written profile wins over extracted traits,
 * and exemplar passages follow when the author picked any.
 */
export function buildVoiceBlock(): string {
  const parts: string[] = []
  const profile = store.readVoiceProfile()
  if (profile?.manualText?.trim()) {
    parts.push(profile.manualText.trim())
  } else if (profile?.traits) {
    const labels: [keyof typeof profile.traits, string][] = [
      ['sentenceLength', 'Sentence length'],
      ['verbStyle', 'Verb style'],
      ['narrativeDistance', 'Narrative distance'],
      ['dialogueStyle', 'Dialogue style'],
      ['rhetoricalPatterns', 'Rhetorical patterns'],
      ['diction', 'Diction'],
      ['syntax', 'Syntax'],
      ['punctuation', 'Punctuation'],
      ['paragraphing', 'Paragraphing'],
      ['characterVoices', 'Character voices'],
      ['emotionExternalization', 'Emotion externalization'],
      ['sensoryPalette', 'Sensory palette'],
      ['motifs', 'Motifs'],
      ['taboos', 'Avoid'],
      ['proseNotes', 'Notes'],
    ]
    const lines = labels
      .map(([key, label]) => {
        const value = profile.traits[key]
        return typeof value === 'string' && value.trim() ? `- ${label}: ${value.trim()}` : ''
      })
      .filter(Boolean)
    if (lines.length > 0) parts.push(lines.join('\n'))
  }
  const exemplars = store.readExemplars()
  if (exemplars.texts.length > 0) {
    parts.push(
      [
        PROMPTS.assist.exemplar.header,
        PROMPTS.assist.exemplar.instruction,
        ...exemplars.texts.slice(0, 3).map((text, i) => `--- excerpt ${i + 1} ---\n${text.trim()}`),
      ].join('\n'),
    )
  }
  return parts.join('\n\n')
}

/**
 * Internal (non-external) codex documents as digest input. Mapped folders are
 * left out: they can be arbitrarily large and are not part of this run's story
 * bible.
 */
export function internalCodexDocs(): {
  category: SettingCategory
  title: string
  content: string
}[] {
  return store
    .listSettings()
    .filter((doc) => !doc.external)
    .flatMap((doc) => {
      try {
        const full = store.readSetting(doc.id)
        return [{ category: doc.category, title: doc.title, content: full.content }]
      } catch {
        return []
      }
    })
}

// ---- Outline construction ----

export function settingDocId(category: SettingCategory, title: string): string {
  const safe = title.replace(/[/\\:*?"<>|]/g, '_').trim() || 'Untitled'
  return `${category}/${safe}.md`
}

export function chapterFileById(
  chapters: { id: string; file: string }[],
  chapterId: string,
): string | null {
  return chapters.find((chapter) => chapter.id === chapterId)?.file ?? null
}

interface AssignedChapter {
  chapterId: string
  title: string
  beats: OutlineBeat[]
  /** The planner's proposed author decisions, when it offered any. */
  contract?: ChapterContract
}

export interface AssignedVolume {
  volumeId: string
  title: string
  summary: string
  chapters: AssignedChapter[]
}

/**
 * Give every planned volume and chapter its final id exactly once.
 *
 * Ids are reused by position from `previous` (the ids this run already wrote to
 * disk) so a resumed or re-planned outline keeps pointing at the same chapter
 * files; volume ids are reused by position from novel.json for the same reason.
 */
export function assignPlan(
  planned: ReturnType<typeof parseForgePlan>,
  previous: Map<number, string>,
): AssignedVolume[] {
  const existingVolumes = store.getNovelMeta().volumes
  let order = 0
  return planned
    .filter((volume) => volume.chapters.length > 0)
    .map((volume, volumeIndex) => ({
      volumeId: existingVolumes[volumeIndex]?.id ?? uid('v_'),
      title: volume.title || `Volume ${volumeIndex + 1}`,
      summary: volume.summary,
      chapters: volume.chapters.map((chapter) => {
        const id = previous.get(order) ?? uid('c_')
        order += 1
        return {
          chapterId: id,
          title: chapter.title || `Chapter ${order}`,
          beats: chapter.beats,
          ...(chapter.contract ? { contract: chapter.contract } : {}),
        }
      }),
    }))
}

/** Turn the assigned plan into a structured outline store. */
export function outlineStoreFrom(run: ForgeRun, volumes: AssignedVolume[]): OutlineStore {
  return {
    version: 1,
    updatedAt: Date.now(),
    overview: run.concept
      ? [
          `# ${run.concept.title}`,
          run.concept.logline ? `**Logline.** ${run.concept.logline}` : '',
          run.concept.synopsis,
          run.concept.themes.length > 0 ? `**Themes.** ${run.concept.themes.join('; ')}` : '',
          run.concept.styleGuide ? `**Prose contract.** ${run.concept.styleGuide}` : '',
        ]
          .filter(Boolean)
          .join('\n\n')
      : '',
    notes: `Generated by Novel Forge from the theme: ${run.brief.theme.slice(0, 500)}`,
    volumes: volumes.map((volume) => ({
      id: volume.volumeId,
      title: volume.title,
      summary: volume.summary,
      config: '',
      status: 'planning' as const,
      chapters: volume.chapters.map((chapter): OutlineChapterData => ({
        id: chapter.chapterId,
        title: chapter.title,
        status: 'planned' as const,
        beats: chapter.beats,
        ...(chapter.contract ? { contract: chapter.contract } : {}),
      })),
    })),
  }
}
