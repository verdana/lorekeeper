/**
 * Novel Forge — pure logic for the theme-driven whole-book pipeline.
 *
 * Everything here is deterministic and side-effect free so it can be unit
 * tested without a server, a provider, or a data directory: parsing model
 * answers, normalizing persisted run state, deciding what work happens next,
 * and deriving display progress.
 */

import type {
  ChapterContract,
  ChapterScene,
  ForgeBrief,
  ForgeFinding,
  ForgeChapterState,
  ForgeConcept,
  ForgeDirective,
  ForgeLogEntry,
  ForgePhase,
  ForgeProgress,
  ForgeRun,
  ForgeRunStatus,
  ForgeStep,
  ForgeStepKind,
  GeneratedDoc,
  OutlineBeat,
  SettingCategory,
} from './types'
import { normalizeChapterContract, normalizeChapterScenes } from './outlineStore'

/**
 * Category ids a generated codex document may be filed under.
 *
 * Mirrors `SETTING_CATEGORIES` in `server/paths.ts`; the two are asserted equal
 * by `tests/shared/forge.test.ts` so the shared parser can validate categories
 * without importing server code.
 */
export const FORGE_SETTING_CATEGORIES: SettingCategory[] = [
  '01-worldview',
  '02-magic',
  '03-history',
  '04-geography',
  '05-faction',
  '06-religion',
  '07-society',
  '08-economy',
  '09-technology',
  '10-species',
  '11-character',
  '12-item',
  '99-misc',
]

export const DEFAULT_FORGE_BRIEF: ForgeBrief = {
  theme: '',
  genre: '',
  tone: '',
  language: 'auto',
  pov: '',
  chapters: 12,
  wordsPerChapter: 2500,
  constraints: '',
  providerId: null,
  scope: 'draft',
  draftCount: 0,
  replaceExisting: false,
}

export const FORGE_LIMITS = {
  minChapters: 1,
  maxChapters: 200,
  minWordsPerChapter: 300,
  maxWordsPerChapter: 20000,
  /** Model calls attempted per chapter unit before it is left for a resume. */
  maxChapterAttempts: 2,
  /** Cap on the scenes a chapter's blueprint may contain. */
  maxScenes: 6,
  /** Cap on the model output kept inline in run state for planning steps. */
  stepOutputChars: 20_000,
  /** Cap on a single codex document inside the chapter context digest. */
  docChars: 1_600,
  logEntries: 400,
  steps: 600,
} as const

const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

const str = (value: unknown, max = 0): string => {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return max > 0 ? trimmed.slice(0, max) : trimmed
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const strList = (value: unknown, max: number, itemMax = 200): string[] => {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => str(item, itemMax))
    .filter((item) => item.length > 0)
    .slice(0, max)
}

/** Tolerant JSON extraction: strips code fences, then slices first { to last }. */
export function parseForgeJson(raw: string): unknown {
  const text = raw.trim()
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  let candidate = (fenced ?? text).trim()
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start !== -1 && end > start) candidate = candidate.slice(start, end + 1)
  try {
    return JSON.parse(candidate)
  } catch {
    throw new Error(
      'The model did not return valid JSON — the answer may have been truncated. Retry, or switch to a model with a larger output limit.',
    )
  }
}

// ---- Parsers for each pipeline stage ----

/** Parse the concept (stage 1) answer into a `ForgeConcept`. */
export function parseForgeConcept(raw: string): ForgeConcept {
  const value = parseForgeJson(raw)
  if (!isRecord(value)) throw new Error('The concept stage did not return a JSON object.')
  const castRaw = Array.isArray(value.cast) ? value.cast : []
  const cast = castRaw
    .flatMap((item) => {
      if (!isRecord(item)) return []
      const name = str(item.name, 80)
      if (!name) return []
      return [
        {
          name,
          role: str(item.role, 120),
          description: str(item.description, 600),
        },
      ]
    })
    .slice(0, 16)
  const concept: ForgeConcept = {
    title: str(value.title, 160),
    genre: str(value.genre, 80),
    logline: str(value.logline, 400),
    synopsis: str(value.synopsis, 4000),
    themes: strList(value.themes, 8, 120),
    tone: str(value.tone, 200),
    pov: str(value.pov, 160),
    styleGuide: str(value.styleGuide, 3000),
    cast,
    worldNotes: str(value.worldNotes, 4000),
  }
  if (!concept.title && !concept.synopsis && !concept.logline) {
    throw new Error('The concept stage returned nothing usable (no title, logline, or synopsis).')
  }
  if (!concept.title) concept.title = concept.logline.slice(0, 60) || 'Untitled'
  return concept
}

/** Parse the codex (stage 2) answer into persistable codex documents. */
export function parseForgeCodex(raw: string): GeneratedDoc[] {
  const value = parseForgeJson(raw)
  if (!isRecord(value) || !Array.isArray(value.docs)) {
    throw new Error('The codex stage did not return a {"docs": [...]} object.')
  }
  const docs = value.docs
    .flatMap((item): GeneratedDoc[] => {
      if (!isRecord(item)) return []
      const title = str(item.title, 160)
      const content = str(item.content)
      if (!title || !content) return []
      const category = FORGE_SETTING_CATEGORIES.includes(item.category as SettingCategory)
        ? (item.category as SettingCategory)
        : '99-misc'
      return [{ category, title, content }]
    })
    .slice(0, 60)
  if (docs.length === 0) {
    throw new Error('The codex stage returned no usable documents.')
  }
  return docs
}

export interface ForgePlanVolume {
  title: string
  summary: string
  chapters: { title: string; beats: OutlineBeat[]; contract?: ChapterContract }[]
}

/** Parse the outline (stage 3) answer. Accepts `{volumes:[...]}` or a flat `{chapters:[...]}`. */
export function parseForgePlan(raw: string): ForgePlanVolume[] {
  const value = parseForgeJson(raw)
  if (!isRecord(value)) throw new Error('The outline stage did not return a JSON object.')

  const beatsOf = (item: unknown): OutlineBeat[] => {
    if (!Array.isArray(item)) return []
    return item
      .flatMap((beat): OutlineBeat[] => {
        if (typeof beat === 'string') {
          const text = str(beat, 600)
          return text ? [{ title: '', summary: text }] : []
        }
        if (!isRecord(beat)) return []
        const title = str(beat.title, 200)
        const summary = str(beat.summary, 900)
        return title || summary ? [{ title, summary }] : []
      })
      .slice(0, 10)
  }

  const chaptersOf = (
    item: unknown,
  ): { title: string; beats: OutlineBeat[]; contract?: ChapterContract }[] => {
    if (!Array.isArray(item)) return []
    return item
      .flatMap((chapter) => {
        if (!isRecord(chapter)) return []
        const title = str(chapter.title, 200)
        const beats = beatsOf(chapter.beats ?? chapter.nodes ?? chapter.points)
        const contract = normalizeChapterContract(chapter.contract)
        if (!title && beats.length === 0) return []
        return [{ title, beats, ...(contract ? { contract } : {}) }]
      })
      .slice(0, FORGE_LIMITS.maxChapters)
  }

  const volumesRaw = Array.isArray(value.volumes) ? value.volumes : []
  const volumes: ForgePlanVolume[] = volumesRaw.flatMap((volume) => {
    if (!isRecord(volume)) return []
    const chapters = chaptersOf(volume.chapters)
    const title = str(volume.title, 200)
    const summary = str(volume.summary, 2000)
    if (chapters.length === 0 && !title) return []
    return [{ title, summary, chapters }]
  })

  if (volumes.length === 0) {
    const flat = chaptersOf(value.chapters)
    if (flat.length > 0) volumes.push({ title: '', summary: '', chapters: flat })
  }

  const total = volumes.reduce((sum, volume) => sum + volume.chapters.length, 0)
  if (total === 0) {
    throw new Error('The outline stage returned no chapters — the answer may have been truncated.')
  }
  return volumes
}

/**
 * One continuity finding reported by the review stage. Defined in `types.ts`
 * because it is persisted on the run; re-exported here so the parser and its
 * consumers keep one import path.
 */
export type { ForgeFinding } from './types'

/**
 * Parse the scene blueprint stage's answer.
 *
 * Beat links are clamped to the chapter's real beats: a scene that claims beat 7
 * of a three-beat chapter would otherwise put a number in the prompt that no
 * beat owns, and the author would have to guess what it meant.
 */
export function parseForgeScenes(raw: string, beatCount: number): ChapterScene[] {
  const value = parseForgeJson(raw)
  if (!isRecord(value) || !Array.isArray(value.scenes)) {
    throw new Error('The scene blueprint stage did not return a JSON object with scenes.')
  }
  const scenes = (normalizeChapterScenes(value.scenes) ?? [])
    .slice(0, FORGE_LIMITS.maxScenes)
    .map((scene) => ({
      ...scene,
      beats: scene.beats.filter((n) => n >= 1 && n <= beatCount),
    }))
  if (scenes.length === 0) {
    throw new Error('The scene blueprint stage returned no usable scenes.')
  }
  return scenes
}

/** Parse the review (stage 5) answer into findings. An empty list is valid (no issues). */
export function parseForgeFindings(raw: string): ForgeFinding[] {
  const value = parseForgeJson(raw)
  if (!isRecord(value)) throw new Error('The review stage did not return a JSON object.')
  const list = Array.isArray(value.issues)
    ? value.issues
    : Array.isArray(value.findings)
      ? value.findings
      : []
  return list
    .flatMap((item): ForgeFinding[] => {
      if (typeof item === 'string') {
        const text = str(item, 800)
        return text
          ? [{ severity: 'unsure' as const, text, chapterTitle: '', relatedDocTitles: [] }]
          : []
      }
      if (!isRecord(item)) return []
      const text = str(item.text ?? item.issue ?? item.description, 800)
      if (!text) return []
      const rawSeverity = str(item.severity, 20).toLowerCase()
      const severity: ForgeFinding['severity'] =
        rawSeverity === 'critical' ? 'critical' : rawSeverity === 'moderate' ? 'moderate' : 'unsure'
      return [
        {
          severity,
          text,
          chapterTitle: str(item.chapterTitle ?? item.chapter, 200),
          relatedDocTitles: strList(item.relatedDocTitles ?? item.docs, 8, 160),
        },
      ]
    })
    .slice(0, 25)
}

/**
 * Extract prose from a draft answer that may carry a node-landing list before
 * the body (the same convention the manuscript writer uses). Text before
 * 【正文】 is planning, not prose, and is dropped.
 */
export function extractForgeProse(answer: string): string {
  const marker = '【正文】'
  const idx = answer.indexOf(marker)
  const body = idx === -1 ? answer : answer.slice(idx + marker.length)
  return stripLeadingDuplicateHeading(body).trim()
}

/**
 * Drop a leading Markdown heading when the model repeated the chapter title
 * even though only the body was requested; the chapter file keeps exactly one
 * title line.
 */
function stripLeadingDuplicateHeading(body: string): string {
  const lines = body.replace(/^\s+/, '').split('\n')
  if (lines.length === 0) return body
  if (!/^#{1,3}\s+\S/.test(lines[0])) return body
  // Drop the heading line and the blank line that usually follows it.
  let i = 1
  while (i < lines.length && lines[i].trim() === '') i += 1
  return lines.slice(i).join('\n')
}

// ---- Run state normalization ----

const FORGE_PHASES: ForgePhase[] = [
  'concept',
  'codex',
  'outline',
  'draft',
  'review',
  'finalize',
  'done',
]

const FORGE_STATUSES: ForgeRunStatus[] = ['running', 'paused', 'completed', 'failed', 'cancelled']

export function normalizeForgeBrief(raw: unknown): ForgeBrief {
  const value = isRecord(raw) ? raw : {}
  const language = value.language === 'zh' || value.language === 'en' ? value.language : 'auto'
  const providerId = str(value.providerId, 200)
  return {
    theme: str(value.theme, 4000),
    genre: str(value.genre, 120),
    tone: str(value.tone, 200),
    language,
    pov: str(value.pov, 200),
    chapters: clampInt(
      value.chapters,
      FORGE_LIMITS.minChapters,
      FORGE_LIMITS.maxChapters,
      DEFAULT_FORGE_BRIEF.chapters,
    ),
    wordsPerChapter: clampInt(
      value.wordsPerChapter,
      FORGE_LIMITS.minWordsPerChapter,
      FORGE_LIMITS.maxWordsPerChapter,
      DEFAULT_FORGE_BRIEF.wordsPerChapter,
    ),
    constraints: str(value.constraints, 4000),
    providerId: providerId || null,
    scope: value.scope === 'plan' ? 'plan' : 'draft',
    draftCount: clampInt(value.draftCount, 0, FORGE_LIMITS.maxChapters, 0),
    replaceExisting: value.replaceExisting === true,
  }
}

const normalizeStep = (raw: unknown): ForgeStep | null => {
  if (!isRecord(raw)) return null
  const id = str(raw.id, 120)
  const kind = str(raw.kind, 20) as ForgeStepKind
  if (
    !id ||
    !['concept', 'codex', 'outline', 'blueprint', 'draft', 'memory', 'review', 'finalize'].includes(
      kind,
    )
  ) {
    return null
  }
  const status = str(raw.status, 20)
  return {
    id,
    kind,
    label: str(raw.label, 200),
    chapterId: str(raw.chapterId, 120) || null,
    status: status === 'failed' ? 'failed' : status === 'running' ? 'running' : 'completed',
    startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : 0,
    durationMs: typeof raw.durationMs === 'number' ? raw.durationMs : null,
    providerName: str(raw.providerName, 120),
    model: str(raw.model, 160),
    inputChars: clampInt(raw.inputChars, 0, Number.MAX_SAFE_INTEGER, 0),
    outputChars: clampInt(raw.outputChars, 0, Number.MAX_SAFE_INTEGER, 0),
    usage:
      isRecord(raw.usage) && (raw.usage.source === 'reported' || raw.usage.source === 'estimated')
        ? {
            source: raw.usage.source,
            inputTokens: typeof raw.usage.inputTokens === 'number' ? raw.usage.inputTokens : null,
            outputTokens:
              typeof raw.usage.outputTokens === 'number' ? raw.usage.outputTokens : null,
            totalTokens: typeof raw.usage.totalTokens === 'number' ? raw.usage.totalTokens : null,
          }
        : { source: 'unavailable', inputTokens: null, outputTokens: null, totalTokens: null },
    error: str(raw.error, 1000) || null,
    output: str(raw.output, FORGE_LIMITS.stepOutputChars),
  }
}

const normalizeChapterState = (raw: unknown): ForgeChapterState | null => {
  if (!isRecord(raw)) return null
  const chapterId = str(raw.chapterId, 120)
  if (!chapterId) return null
  const beats = Array.isArray(raw.beats)
    ? raw.beats.flatMap((beat): OutlineBeat[] => {
        if (!isRecord(beat)) return []
        const title = str(beat.title, 200)
        const summary = str(beat.summary, 900)
        return title || summary ? [{ title, summary }] : []
      })
    : []
  const prose = raw.prose === 'drafted' ? 'drafted' : raw.prose === 'failed' ? 'failed' : 'pending'
  const memory = raw.memory === 'done' ? 'done' : raw.memory === 'failed' ? 'failed' : 'pending'
  const contract = normalizeChapterContract(raw.contract)
  return {
    chapterId,
    title: str(raw.title, 200),
    volumeTitle: str(raw.volumeTitle, 200),
    order: clampInt(raw.order, 0, FORGE_LIMITS.maxChapters, 0),
    beats,
    ...(contract ? { contract } : {}),
    prose,
    memory,
    words: clampInt(raw.words, 0, Number.MAX_SAFE_INTEGER, 0),
    summary: str(raw.summary, 4000),
    endState: str(raw.endState, 2000),
    attempts: clampInt(raw.attempts, 0, 100, 0),
    memoryAttempts: clampInt(raw.memoryAttempts, 0, 100, 0),
    error: str(raw.error, 1000) || null,
  }
}

const normalizeLog = (raw: unknown): ForgeLogEntry[] => {
  if (!Array.isArray(raw)) return []
  return raw
    .flatMap((item): ForgeLogEntry[] => {
      if (!isRecord(item)) return []
      const message = str(item.message, 1000)
      if (!message) return []
      const level = item.level === 'warn' || item.level === 'error' ? item.level : 'info'
      return [{ ts: typeof item.ts === 'number' ? item.ts : Date.now(), level, message }]
    })
    .slice(-FORGE_LIMITS.logEntries)
}

const FORGE_SEVERITIES = new Set<ForgeFinding['severity']>(['critical', 'moderate', 'unsure'])

/** Validate findings read back from a persisted run. */
function normalizeFindings(raw: unknown): ForgeFinding[] {
  if (!Array.isArray(raw)) return []
  return raw
    .flatMap((item): ForgeFinding[] => {
      if (!isRecord(item)) return []
      const text = str(item.text, 800)
      if (!text) return []
      const severity = str(item.severity, 20) as ForgeFinding['severity']
      return [
        {
          severity: FORGE_SEVERITIES.has(severity) ? severity : 'unsure',
          text,
          chapterTitle: str(item.chapterTitle, 200),
          relatedDocTitles: strList(item.relatedDocTitles, 8, 160),
        },
      ]
    })
    .slice(0, 25)
}

/** Validate an author direction coming from the UI or a persisted run. */
export function normalizeDirective(raw: unknown): ForgeDirective | null {
  if (!isRecord(raw)) return null
  const id = str(raw.id, 120)
  const text = str(raw.text, 2000)
  if (!id || !text) return null
  const fromOrder = clampInt(raw.fromOrder, 1, FORGE_LIMITS.maxChapters, 1)
  return {
    id,
    text,
    fromOrder,
    onlyOrder:
      typeof raw.onlyOrder === 'number'
        ? clampInt(raw.onlyOrder, 1, FORGE_LIMITS.maxChapters, fromOrder)
        : null,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
  }
}

/** Author direction that applies to one chapter (1-based ordinal). */
export function forgeDirectivesFor(run: ForgeRun, ordinal: number): ForgeDirective[] {
  return run.direction.filter((directive) =>
    directive.onlyOrder !== null ? directive.onlyOrder === ordinal : directive.fromOrder <= ordinal,
  )
}

/** The ordinal a new direction defaults to: the next chapter not yet drafted. */
export function forgeNextOrdinal(run: ForgeRun): number {
  const limit = forgeDraftLimit(run)
  const pending = run.chapters.findIndex(
    (chapter, index) => index < limit && chapter.prose !== 'drafted',
  )
  if (pending === -1) return Math.min(run.chapters.length + 1, FORGE_LIMITS.maxChapters)
  return pending + 1
}

/** Read a persisted run, tolerating partial or hand-edited files. */
export function normalizeForgeRun(raw: unknown): ForgeRun | null {
  if (!isRecord(raw)) return null
  const worldId = str(raw.worldId, 120)
  const id = str(raw.id, 120)
  if (!worldId || !id) return null
  const status = FORGE_STATUSES.includes(raw.status as ForgeRunStatus)
    ? (raw.status as ForgeRunStatus)
    : 'paused'
  const phase = FORGE_PHASES.includes(raw.phase as ForgePhase)
    ? (raw.phase as ForgePhase)
    : 'concept'
  const totalsRaw = isRecord(raw.totals) ? raw.totals : {}
  return {
    version: 1,
    id,
    worldId,
    worldTitle: str(raw.worldTitle, 200),
    brief: normalizeForgeBrief(raw.brief),
    status,
    phase,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
    finishedAt: typeof raw.finishedAt === 'number' ? raw.finishedAt : null,
    concept: isRecord(raw.concept) ? (raw.concept as unknown as ForgeConcept) : null,
    chapters: Array.isArray(raw.chapters)
      ? raw.chapters
          .map(normalizeChapterState)
          .filter((c): c is ForgeChapterState => c !== null)
          .slice(0, FORGE_LIMITS.maxChapters)
      : [],
    direction: Array.isArray(raw.direction)
      ? raw.direction
          .map(normalizeDirective)
          .filter((d): d is ForgeDirective => d !== null)
          .slice(0, 200)
      : [],
    reviewedUpTo: clampInt(raw.reviewedUpTo, 0, FORGE_LIMITS.maxChapters, 0),
    findings: normalizeFindings(raw.findings),
    planRequest: clampInt(raw.planRequest, 0, FORGE_LIMITS.maxChapters, 0),
    steps: Array.isArray(raw.steps)
      ? raw.steps
          .map(normalizeStep)
          .filter((s): s is ForgeStep => s !== null)
          .slice(-FORGE_LIMITS.steps)
      : [],
    log: normalizeLog(raw.log),
    totals: {
      modelCalls: clampInt(totalsRaw.modelCalls, 0, Number.MAX_SAFE_INTEGER, 0),
      inputTokens: clampInt(totalsRaw.inputTokens, 0, Number.MAX_SAFE_INTEGER, 0),
      outputTokens: clampInt(totalsRaw.outputTokens, 0, Number.MAX_SAFE_INTEGER, 0),
      durationMs: clampInt(totalsRaw.durationMs, 0, Number.MAX_SAFE_INTEGER, 0),
      words: clampInt(totalsRaw.words, 0, Number.MAX_SAFE_INTEGER, 0),
    },
    error: str(raw.error, 1000) || null,
  }
}

export function emptyForgeRun(params: {
  id: string
  worldId: string
  worldTitle: string
  brief: ForgeBrief
  now?: number
}): ForgeRun {
  const now = params.now ?? Date.now()
  return {
    version: 1,
    id: params.id,
    worldId: params.worldId,
    worldTitle: params.worldTitle,
    brief: params.brief,
    status: 'running',
    phase: 'concept',
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
    concept: null,
    chapters: [],
    direction: [],
    reviewedUpTo: 0,
    findings: [],
    planRequest: 0,
    steps: [],
    log: [],
    totals: { modelCalls: 0, inputTokens: 0, outputTokens: 0, durationMs: 0, words: 0 },
    error: null,
  }
}

// ---- Work scheduling (what the engine does next) ----

export type ForgeWork =
  | { kind: 'concept' }
  | { kind: 'codex' }
  | { kind: 'outline' }
  | { kind: 'expand' }
  | { kind: 'draft'; chapterIndex: number }
  | { kind: 'memory'; chapterIndex: number }
  | { kind: 'review' }
  | { kind: 'finalize' }

const hasCompletedStep = (run: ForgeRun, kind: ForgeStepKind): boolean =>
  run.steps.some((step) => step.kind === kind && step.status === 'completed')

/**
 * True once a stage was tried, whether it succeeded or failed. Used for stages
 * that must never block the book: a failed attempt is still an attempt, so the
 * loop moves on instead of retrying forever.
 */
const hasAttemptedStep = (run: ForgeRun, kind: ForgeStepKind): boolean =>
  run.steps.some((step) => step.kind === kind)

/** How many chapters this run is allowed to draft. */
export function forgeDraftLimit(run: ForgeRun): number {
  if (run.brief.scope === 'plan') return 0
  const limit = run.brief.draftCount > 0 ? run.brief.draftCount : run.chapters.length
  return Math.max(0, Math.min(limit, run.chapters.length))
}

/**
 * The next unit of work, derived only from persisted state so a run resumes
 * exactly where it stopped — after a pause, a cancel-and-resume, or a server
 * restart. Returns null when the pipeline is finished.
 *
 * Memory always precedes the next draft: chapter N+1 is planned with chapter
 * N's summary already in hand.
 *
 * A chapter unit that already burned its attempts is skipped rather than
 * retried forever, so one broken chapter cannot stall the rest of the book; a
 * resume resets those attempts (see `resumeForgeRun`).
 */
export function forgeNextWork(run: ForgeRun): ForgeWork | null {
  if (!hasCompletedStep(run, 'concept')) return { kind: 'concept' }
  if (!hasCompletedStep(run, 'codex')) return { kind: 'codex' }
  if (!hasCompletedStep(run, 'outline')) return { kind: 'outline' }

  const exhausted = (attempts: number): boolean => attempts >= FORGE_LIMITS.maxChapterAttempts

  const limit = forgeDraftLimit(run)
  for (let i = 0; i < limit; i += 1) {
    const chapter = run.chapters[i]
    if (
      chapter &&
      chapter.prose === 'drafted' &&
      chapter.memory !== 'done' &&
      !exhausted(chapter.memoryAttempts)
    ) {
      return { kind: 'memory', chapterIndex: i }
    }
  }
  for (let i = 0; i < limit; i += 1) {
    const chapter = run.chapters[i]
    if (chapter && chapter.prose !== 'drafted' && !exhausted(chapter.attempts)) {
      return { kind: 'draft', chapterIndex: i }
    }
  }

  // The book outgrew its first plan: plan the next arc before reviewing or
  // finishing, so a continuation request is served by the same run.
  if (run.planRequest > 0 && run.chapters.length > 0) return { kind: 'expand' }

  // Plan-only runs never call the reviewer, and a run whose chapters all failed
  // has no prose to check: both skip straight to finalize. The review re-runs
  // whenever more chapters were drafted (or one was written again) than the
  // last review covered, so continuing a book keeps the findings current.
  const reviewable = run.chapters.slice(0, limit).filter((chapter) => chapter.prose === 'drafted')
  if (
    run.brief.scope === 'draft' &&
    reviewable.length > 0 &&
    (!hasAttemptedStep(run, 'review') || reviewable.length > run.reviewedUpTo)
  ) {
    return { kind: 'review' }
  }
  if (!hasCompletedStep(run, 'finalize')) return { kind: 'finalize' }
  return null
}

/**
 * True when a finished run still has chapters worth retrying — a chapter that
 * failed after its retries, or one inside the draft limit that was never
 * written. Such a run can be resumed instead of forged again from scratch.
 */
export function forgeCanRetry(run: ForgeRun): boolean {
  const limit = forgeDraftLimit(run)
  return run.chapters.slice(0, limit).some((chapter) => chapter.prose !== 'drafted')
}

/** Phase implied by the work item that is about to run. */
export function forgePhaseForWork(work: ForgeWork, run: ForgeRun): ForgePhase {
  switch (work.kind) {
    case 'concept':
      return 'concept'
    case 'codex':
      return 'codex'
    case 'outline':
      return 'outline'
    case 'expand':
      return 'outline'
    case 'draft':
    case 'memory':
      return run.brief.scope === 'plan' ? 'outline' : 'draft'
    case 'review':
      return 'review'
    case 'finalize':
      return 'finalize'
  }
}

// ---- Derived progress ----

const PHASE_LABEL: Record<ForgePhase, string> = {
  concept: 'Concept',
  codex: 'Story bible',
  outline: 'Outline',
  draft: 'Drafting',
  review: 'Continuity review',
  finalize: 'Finalizing',
  done: 'Complete',
}

/**
 * Display-ready progress. Planning stages occupy the first 40% (or the whole
 * bar for plan-only runs), chapter work the next 50%, then review and finalize.
 */
export function forgeProgress(run: ForgeRun): ForgeProgress {
  const drafted = run.chapters.filter((c) => c.prose === 'drafted').length
  const failed = run.chapters.filter((c) => c.prose === 'failed').length
  const limit = forgeDraftLimit(run)
  const planOnly = run.brief.scope === 'plan' || limit === 0
  // Finalizing is not a model call, but it is recorded as a step so its
  // completion is part of the persisted state.
  const finalDone = hasCompletedStep(run, 'finalize')

  let percent: number
  if (run.status === 'completed') {
    percent = 100
  } else if (planOnly) {
    const planStart = hasCompletedStep(run, 'concept') ? 1 : 0
    const codexDone = hasCompletedStep(run, 'codex')
    const outlineDone = hasCompletedStep(run, 'outline')
    percent = finalDone ? 100 : outlineDone ? 95 : codexDone ? 70 : planStart ? 30 : 2
  } else {
    const codexDone = hasCompletedStep(run, 'codex')
    const outlineDone = hasCompletedStep(run, 'outline')
    const reviewDone = hasCompletedStep(run, 'review') || finalDone
    if (finalDone) percent = 100
    else if (reviewDone) percent = 97
    else if (outlineDone) {
      // Each chapter contributes a draft unit and a memory unit.
      const units = Math.max(1, limit * 2)
      const stored = run.chapters.slice(0, limit)
      const done = stored.reduce(
        (sum, chapter) =>
          sum + (chapter.prose === 'drafted' ? 1 : 0) + (chapter.memory === 'done' ? 1 : 0),
        0,
      )
      percent = 40 + Math.round(50 * Math.min(1, done / units))
    } else if (codexDone) percent = 25
    else percent = hasCompletedStep(run, 'concept') ? 10 : 2
  }

  return {
    phase: run.phase,
    label: PHASE_LABEL[run.phase],
    percent: Math.max(0, Math.min(100, percent)),
    plannedChapters: run.chapters.length,
    draftedChapters: drafted,
    failedChapters: failed,
    totalWords: run.chapters.reduce((sum, chapter) => sum + chapter.words, 0),
    modelCalls: run.totals.modelCalls,
    durationMs:
      run.totals.durationMs ||
      (run.finishedAt ? run.finishedAt - run.createdAt : Date.now() - run.createdAt),
  }
}

// ---- Context assembly ----

/** Category priority for the chapter context digest (most useful first). */
const DIGEST_PRIORITY: SettingCategory[] = [
  '11-character',
  '01-worldview',
  '02-magic',
  '05-faction',
  '03-history',
  '04-geography',
  '07-society',
  '06-religion',
  '09-technology',
  '10-species',
  '12-item',
  '08-economy',
  '99-misc',
]

/**
 * Build the codex block a chapter prompt receives: documents ordered by
 * usefulness for prose, each capped, assembled until the character budget runs
 * out. Documents that do not fit are named at the end so the model still knows
 * they exist.
 */
export function forgeCodexDigest(
  docs: { category: SettingCategory; title: string; content: string }[],
  budget = 12_000,
): string {
  const ordered = [...docs].sort((a, b) => {
    const ai = DIGEST_PRIORITY.indexOf(a.category)
    const bi = DIGEST_PRIORITY.indexOf(b.category)
    if (ai !== bi) return ai - bi
    return a.title.localeCompare(b.title, 'zh-Hans-CN')
  })

  const blocks: string[] = []
  const omitted: string[] = []
  let used = 0
  for (const doc of ordered) {
    const body = doc.content.trim()
    if (!body) continue
    const capped =
      body.length > FORGE_LIMITS.docChars ? `${body.slice(0, FORGE_LIMITS.docChars)}…` : body
    const block = `### ${doc.title}\n${capped}`
    if (used + block.length > budget) {
      omitted.push(doc.title)
      continue
    }
    blocks.push(block)
    used += block.length + 1
  }
  if (omitted.length > 0) {
    blocks.push(`(Codex documents not shown for length: ${omitted.join(', ')})`)
  }
  return blocks.join('\n\n')
}

/** Short digest of the run's own chapter summaries, newest last. */
export function forgeStorySoFar(run: ForgeRun, upToIndex: number, recent = 3): string {
  const prior = run.chapters
    .slice(0, upToIndex)
    .filter((chapter) => chapter.summary.trim() || chapter.endState.trim())
    .slice(-recent)
  if (prior.length === 0) return ''
  return prior
    .map((chapter) => {
      const head = `### ${chapter.title}`
      const body = chapter.summary.trim()
      const tail = chapter.endState.trim()
      return [head, body, tail ? `End state: ${tail}` : ''].filter(Boolean).join('\n')
    })
    .join('\n\n')
}
