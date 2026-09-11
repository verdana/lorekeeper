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
 * Design constraints this module honors:
 *
 * - **Durable and resumable.** Every step transition is persisted to
 *   `<world>/forge/run.json`, and the next unit of work is derived from that
 *   state alone (`forgeNextWork`), so a run survives a pause, a crash, or a
 *   server restart without repeating paid model calls.
 * - **The world is fixed at start.** The pipeline writes through the store,
 *   which resolves paths from the *current* world. If the author switches
 *   worlds mid-run, the engine pauses before its next write instead of
 *   corrupting a different project (see `worldStillCurrent`).
 * - **Nothing is written without evidence.** Each model call is recorded as a
 *   `ForgeStep` with its provider, model, timing, usage and output, and all
 *   content writes go through store functions, which snapshot first.
 */

import type {
  ChatMessage,
  ForgeBrief,
  ForgeConcept,
  ForgeDirective,
  ForgeRun,
  ForgeStep,
  ForgeStepKind,
  GenerationTokenUsage,
  OutlineBeat,
  OutlineChapterData,
  OutlineStore,
  ReviewQueueItem,
  SettingCategory,
  SettingDoc,
} from '../shared/types'
import {
  FORGE_LIMITS,
  emptyForgeRun,
  extractForgeProse,
  forgeCanRetry,
  forgeCodexDigest,
  forgeDirectivesFor,
  forgeNextWork,
  forgePhaseForWork,
  forgeStorySoFar,
  normalizeForgeBrief,
  normalizeDirective,
  normalizeForgeRun,
  parseForgeCodex,
  parseForgeConcept,
  parseForgeFindings,
  parseForgePlan,
  type ForgeWork,
} from '../shared/forge'
import {
  formatStoryState,
  parseChapterSummaryPayload,
  rebuildStoryState,
} from '../shared/chapterMemory'
import { estimateChatUsage } from '../shared/generationEvidence'
import { storyMemoryFingerprint } from '../shared/storyMemory'
import { PROMPTS } from '../shared/prompts'
import { chatWithUsage } from './ai'
import { ensureDir, forgeDir, forgeRunFile, getCurrentWorldId } from './paths'
import * as store from './store'
import { existsSync, readFileSync, rmSync } from 'fs'
import { randomUUID } from 'crypto'

/** A model answer plus whatever token accounting came with it. */
export interface ChatOutcome {
  content: string
  /** Provider-reported usage; absent/unavailable falls back to a local estimate. */
  usage?: GenerationTokenUsage | null
}

type ChatFn = (
  messages: ChatMessage[],
  providerId?: string,
  timeouts?: { connectMs?: number; bodyMs?: number },
) => Promise<ChatOutcome>

// ---- Tunables ----

const JSON_CALL_TIMEOUT = { connectMs: 90_000, bodyMs: 180_000 }
/** Prose may legitimately take minutes on a slow provider; only a total stall aborts. */
const PROSE_CALL_TIMEOUT = { connectMs: 120_000, bodyMs: 900_000 }
/** One retry per model call: a transient 5xx or a dropped connection is common. */
const MODEL_ATTEMPTS = FORGE_LIMITS.maxChapterAttempts
/** Per-prompt context budget, in characters. */
const BUDGET = {
  codex: 12_000,
  storyState: 4_000,
  storySoFar: 3_000,
  previousEnding: 1_500,
  voice: 2_500,
  direction: 2_000,
  reviewProse: 60_000,
  reviewPerChapter: 3_000,
} as const

const uid = (prefix: string): string => `${prefix}${randomUUID().replace(/-/g, '').slice(0, 16)}`

// ---- Active runs (one per world) ----

interface ActiveRun {
  run: ForgeRun
  paused: boolean
  cancelled: boolean
  chatFn: ChatFn
}

const activeRuns = new Map<string, ActiveRun>()

export function hasActiveForgeRun(): boolean {
  for (const active of activeRuns.values()) if (!active.paused && !active.cancelled) return true
  return false
}

/** Ids of worlds with a live pipeline loop; used to keep runs from crossing worlds. */
export function activeForgeWorldIds(): string[] {
  return [...activeRuns.values()].filter((a) => !a.paused && !a.cancelled).map((a) => a.run.worldId)
}

// ---- Run state I/O ----

const readRunFile = (): ForgeRun | null => {
  // Every forge path is resolved from the current world, and the server runs
  // with no world selected while the user sits on the world picker. Reading a
  // run is therefore "there is none" rather than an error.
  if (!getCurrentWorldId()) return null
  const file = forgeRunFile()
  if (!existsSync(file)) return null
  try {
    return normalizeForgeRun(JSON.parse(readFileSync(file, 'utf-8')))
  } catch {
    return null
  }
}

const persist = (run: ForgeRun): void => {
  ensureDir(forgeDir())
  run.updatedAt = Date.now()
  store.writeForgeRunFile(JSON.stringify(run, null, 2))
}

/**
 * Read the persisted run. A run marked `running` with no live loop was
 * interrupted (server restart, crash, killed process): it is reported and
 * stored as paused so the author can resume it deliberately.
 */
export function readForgeRun(): ForgeRun | null {
  const run = readRunFile()
  if (!run) return null
  if (run.status === 'running' && !activeRuns.has(run.worldId)) {
    run.status = 'paused'
    markRunningStepsInterrupted(run)
    appendLog(
      run,
      'warn',
      'The run was interrupted (the app closed or restarted). Resume to continue.',
    )
    persist(run)
  }
  return run
}

/** A step left `running` by an interrupted process never finished. */
function markRunningStepsInterrupted(run: ForgeRun): void {
  for (const step of run.steps) {
    if (step.status === 'running') {
      step.status = 'failed'
      step.error = step.error ?? 'Interrupted before the call returned.'
      step.durationMs = step.durationMs ?? 0
    }
  }
}

function appendLog(run: ForgeRun, level: 'info' | 'warn' | 'error', message: string): void {
  run.log.push({ ts: Date.now(), level, message })
  if (run.log.length > FORGE_LIMITS.logEntries) {
    run.log = run.log.slice(-FORGE_LIMITS.logEntries)
  }
}

// ---- Public control surface ----

export interface StartForgeOptions {
  /** Injected for tests; defaults to the real provider call. */
  chat?: ChatFn
  /** Await the whole pipeline instead of returning as soon as it starts. */
  awaitCompletion?: boolean
}

/**
 * Start a run in the current world and return immediately; the pipeline keeps
 * going in the background so the UI can poll it.
 */
export async function startForgeRun(
  rawBrief: unknown,
  opts: StartForgeOptions = {},
): Promise<ForgeRun> {
  const brief = normalizeForgeBrief(rawBrief)
  if (!brief.theme.trim()) throw new Error('Enter a theme to forge a novel from.')

  const worldId = getCurrentWorldId()
  if (!worldId) throw new Error('Select a world before starting a forge run.')
  if (activeRuns.has(worldId)) throw new Error('A forge run is already active in this world.')

  const existing = readRunFile()
  if (existing && (existing.status === 'running' || existing.status === 'paused')) {
    throw new Error(
      'This world already has an unfinished forge run. Resume it, or discard it before starting a new one.',
    )
  }

  assertExistingContentAllowed(brief)

  const meta = store.getNovelMeta()
  const run = emptyForgeRun({
    id: uid('fr_'),
    worldId,
    worldTitle: meta.title || 'Untitled World',
    brief,
  })
  appendLog(run, 'info', `Forge started: ${brief.chapters} chapters, ${brief.scope} scope.`)
  persist(run)

  return launch(run, opts)
}

/** Continue a paused, failed, cancelled or interrupted run from persisted state. */
export async function resumeForgeRun(opts: StartForgeOptions = {}): Promise<ForgeRun | null> {
  const run = readRunFile()
  if (!run) throw new Error('There is no forge run to resume in this world.')
  if (run.worldId !== getCurrentWorldId()) {
    throw new Error('This run belongs to a different world. Open that world to resume it.')
  }
  if (run.status === 'completed' && !forgeCanRetry(run)) return run
  if (activeRuns.has(run.worldId)) return run

  // Retrying is the point of resuming: chapters that gave up are eligible again.
  for (const chapter of run.chapters) {
    if (chapter.prose === 'failed') {
      chapter.prose = 'pending'
      chapter.attempts = 0
      chapter.error = null
    }
    if (chapter.memory === 'failed') {
      chapter.memory = 'pending'
      chapter.attempts = 0
    }
  }
  run.status = 'running'
  run.error = null
  run.finishedAt = null
  appendLog(run, 'info', 'Run resumed.')
  persist(run)
  return launch(run, opts)
}

function launch(run: ForgeRun, opts: StartForgeOptions): Promise<ForgeRun> {
  const active: ActiveRun = {
    run,
    paused: false,
    cancelled: false,
    chatFn: opts.chat ?? chatWithUsage,
  }
  activeRuns.set(run.worldId, active)
  const loop = runPipeline(active)
  if (opts.awaitCompletion) {
    return loop.then(() => run)
  }
  // Background: the caller (HTTP handler) only needs the starting state. A
  // failure inside is already recorded on the run, so swallow the rejection.
  void loop.catch((e) => {
    appendLog(run, 'error', e instanceof Error ? e.message : String(e))
    persist(run)
  })
  return Promise.resolve(run)
}

/**
 * Ask the active run to stop after the model call in flight. Returns the run
 * with `status: 'paused'` immediately — the loop finishes the current call
 * first, so nothing is written half-way.
 */
export function pauseForgeRun(reason?: string): ForgeRun | null {
  const run = readRunFile()
  if (!run) return null
  const active = activeRuns.get(run.worldId)
  if (active) active.paused = true
  if (run.status === 'running') {
    run.status = 'paused'
    appendLog(run, 'info', reason ? `Paused: ${reason}` : 'Paused by the author.')
    persist(run)
  } else if (reason) {
    appendLog(run, 'info', `Paused: ${reason}`)
    persist(run)
  }
  return run
}

/** Stop the run for good. Content already written stays on disk. */
export function cancelForgeRun(): ForgeRun | null {
  const run = readRunFile()
  if (!run) return null
  const active = activeRuns.get(run.worldId)
  if (active) active.cancelled = true
  run.status = 'cancelled'
  run.finishedAt = Date.now()
  appendLog(run, 'warn', 'Run cancelled. Generated content was kept.')
  persist(run)
  return run
}

/** Forget the run record. Codex, outline and chapters produced by it stay. */
export function discardForgeRun(): void {
  if (!getCurrentWorldId()) return
  const run = readRunFile()
  if (run) {
    const active = activeRuns.get(run.worldId)
    if (active) active.cancelled = true
  }
  const file = forgeRunFile()
  if (existsSync(file)) rmSync(file, { force: true })
}

// ---- Author steering ----

/**
 * The run object the author's edits must be applied to.
 *
 * While a run is live, the loop owns an in-memory object and persists it after
 * every step; mutating the on-disk copy instead would be overwritten by the
 * loop's next write. So edits target the live object when there is one, and the
 * freshly read file only when the run is idle.
 */
function currentRunForWrite(): ForgeRun | null {
  const worldId = getCurrentWorldId()
  if (!worldId) return null
  const active = activeRuns.get(worldId)
  return active ? active.run : readRunFile()
}

/** Replace the direction list. Add, re-scope or delete instructions. */
export function writeForgeDirectives(rawDirectives: unknown): ForgeRun | null {
  const run = currentRunForWrite()
  if (!run) return null
  const list = Array.isArray(rawDirectives) ? rawDirectives : []
  run.direction = list
    .map(normalizeDirective)
    .filter((directive): directive is ForgeDirective => directive !== null)
    .slice(0, 200)
  appendLog(
    run,
    'info',
    run.direction.length === 0
      ? 'Author direction cleared.'
      : `Author direction updated (${run.direction.length} active).`,
  )
  persist(run)
  return run
}

/**
 * Write one chapter again from scratch, optionally under a new instruction.
 *
 * The chapter is reset (prose and its summary are dropped so the memory step
 * regenerates them) and the run continues, which re-drafts exactly that chapter
 * before picking up whatever else is pending. Later chapters keep their prose:
 * they were written against the previous version, so the author is told which
 * ones they may want to revisit.
 */
export function redraftForgeChapter(
  input: {
    chapterId: string
    instruction?: string
  },
  opts: StartForgeOptions = {},
): ForgeRun | null {
  const run = currentRunForWrite()
  if (!run) return null
  const index = run.chapters.findIndex((chapter) => chapter.chapterId === input.chapterId)
  if (index === -1) throw new Error('That chapter is not part of this run.')
  const ordinal = index + 1
  const chapter = run.chapters[index]

  const instruction = (input.instruction ?? '').trim()
  if (instruction) {
    // One live instruction per chapter: replace any previous chapter-only note
    // so repeated attempts do not stack contradictory directions.
    run.direction = run.direction.filter((directive) => directive.onlyOrder !== ordinal)
    run.direction.push({
      id: uid('d_'),
      text: instruction,
      fromOrder: ordinal,
      onlyOrder: ordinal,
      createdAt: Date.now(),
    })
  }

  chapter.prose = 'pending'
  chapter.memory = 'pending'
  chapter.attempts = 0
  chapter.memoryAttempts = 0
  chapter.error = null
  // The story state is rebuilt from the summaries, so the re-draft invalidates
  // the review's coverage from this chapter onwards.
  run.reviewedUpTo = Math.min(run.reviewedUpTo, ordinal - 1)

  const later = run.chapters.slice(index + 1).filter((c) => c.prose === 'drafted')
  appendLog(
    run,
    'info',
    `Re-drafting chapter ${ordinal}: ${chapter.title}${instruction ? ' under a new instruction' : ''}.` +
      (later.length > 0
        ? ` ${later.length} later chapter${later.length === 1 ? '' : 's'} still follow the previous version.`
        : ''),
  )

  if (activeRuns.has(run.worldId)) {
    // Already live: the loop picks the chapter up on its next iteration.
    persist(run)
    return run
  }
  run.status = 'running'
  run.error = null
  run.finishedAt = null
  persist(run)
  void launch(run, opts)
  return run
}

/**
 * Continue a run with more chapters: raise the draft limit and resume.
 *
 * The plan is untouched — this drafts chapters that were already planned but
 * left out (a "first N chapters" run, a plan-only run, or a resumed book). More
 * chapters than the outline holds must be planned first, either with
 * `forgeExtendPlan` or in the Outline view.
 */
export function forgeMoreChapters(count: number, opts: StartForgeOptions = {}): ForgeRun | null {
  const run = currentRunForWrite()
  if (!run) return null
  const wanted = Math.max(1, Math.round(Number(count) || 0))
  const drafted = run.chapters.filter((chapter) => chapter.prose === 'drafted').length
  const target = Math.min(run.chapters.length, Math.max(drafted, run.brief.draftCount) + wanted)
  if (run.chapters.length === 0) {
    throw new Error('This run has no planned chapters yet.')
  }
  if (target <= Math.max(drafted, run.brief.draftCount) && run.brief.scope === 'draft') {
    throw new Error(
      'Every planned chapter is already drafted. Plan more chapters in the Outline view first.',
    )
  }
  run.brief.scope = 'draft'
  run.brief.draftCount = target
  run.status = 'running'
  run.error = null
  run.finishedAt = null
  appendLog(run, 'info', `Continuing: drafting up to chapter ${target}.`)
  persist(run)

  if (activeRuns.has(run.worldId)) return run
  void launch(run, opts)
  return run
}

/**
 * Keep the book going past its outline: plan `count` further chapters from what
 * has actually happened, then let the pipeline draft them.
 *
 * The request is stored on the run (`planRequest`) and served by the loop, so it
 * works whether the run is idle or mid-flight, and it survives a restart.
 */
export function forgeExtendPlan(count: number, opts: StartForgeOptions = {}): ForgeRun | null {
  const run = currentRunForWrite()
  if (!run) return null
  if (run.chapters.length === 0) {
    throw new Error('This run has no outline yet — start it before extending the plan.')
  }
  const wanted = Math.max(1, Math.round(Number(count) || 0))
  run.planRequest = Math.min(run.planRequest + wanted, FORGE_LIMITS.maxChapters)
  run.error = null
  run.finishedAt = null
  run.status = 'running'
  appendLog(run, 'info', `Planning ${wanted} more chapter${wanted === 1 ? '' : 's'}.`)
  persist(run)

  if (activeRuns.has(run.worldId)) return run
  void launch(run, opts)
  return run
}

// ---- Guards ----

/** Chapter bodies long enough to be real prose rather than a placeholder. */
function writtenChapterCount(): number {
  const meta = store.getNovelMeta()
  let count = 0
  for (const volume of meta.volumes) {
    for (const chapter of volume.chapters) {
      if (chapter.wordCount > 0) count += 1
      else if (store.readChapter(chapter.file).trim().length > 100) count += 1
    }
  }
  return count
}

/**
 * Forging a book rewrites the outline and therefore the chapter tree. Refuse to
 * do that silently over prose the author already wrote.
 */
function assertExistingContentAllowed(brief: ForgeBrief): void {
  if (brief.replaceExisting) return
  const written = writtenChapterCount()
  if (written > 0) {
    throw new Error(
      `This world already has ${written} chapter${written === 1 ? '' : 's'} with prose. ` +
        'Turn on "Replace the existing outline" to forge over it, or start from a blank world.',
    )
  }
}

/** False once the author switched worlds: the loop must stop before writing. */
function worldStillCurrent(run: ForgeRun): boolean {
  return getCurrentWorldId() === run.worldId
}

/**
 * Stop the run because its world is no longer the active one. Nothing is
 * written and the run stays resumable from its last completed step; returning
 * null keeps the caller on the non-fatal path so the loop pauses rather than
 * marking the book as failed.
 */
function pauseBecauseWorldChanged(active: ActiveRun, stage: string): null {
  active.paused = true
  active.run.status = 'paused'
  appendLog(active.run, 'warn', `Paused before ${stage}: the active world changed.`)
  return null
}

// ---- The loop ----

async function runPipeline(active: ActiveRun): Promise<void> {
  const { run } = active
  try {
    for (;;) {
      if (active.cancelled) {
        if (run.status !== 'cancelled') {
          run.status = 'cancelled'
          run.finishedAt = Date.now()
          persist(run)
        }
        return
      }
      if (active.paused) {
        if (run.status === 'running') {
          run.status = 'paused'
          persist(run)
        }
        return
      }

      const work = forgeNextWork(run)
      if (!work) {
        completeRun(run)
        return
      }
      if (!worldStillCurrent(run)) {
        run.status = 'paused'
        appendLog(run, 'warn', 'Paused: the active world changed. Reopen this world and resume.')
        persist(run)
        return
      }

      run.phase = forgePhaseForWork(work, run)
      persist(run)

      const fatal = await executeWork(active, work)
      if (fatal) {
        run.status = 'failed'
        run.error = fatal
        run.finishedAt = Date.now()
        appendLog(run, 'error', fatal)
        persist(run)
        return
      }
      persist(run)
    }
  } finally {
    activeRuns.delete(run.worldId)
  }
}

function completeRun(run: ForgeRun): void {
  run.phase = 'done'
  run.status = 'completed'
  run.finishedAt = Date.now()
  const drafted = run.chapters.filter((c) => c.prose === 'drafted').length
  const failed = run.chapters.filter((c) => c.prose === 'failed').length
  const words = run.chapters.reduce((sum, c) => sum + c.words, 0)
  appendLog(
    run,
    failed > 0 ? 'warn' : 'info',
    `Forge complete: ${drafted} chapter${drafted === 1 ? '' : 's'} drafted, ` +
      `${words.toLocaleString('en-US')} words` +
      (failed > 0
        ? `. ${failed} chapter${failed === 1 ? '' : 's'} failed — resume to retry.`
        : '.'),
  )
  persist(run)
}

/**
 * Run one unit of work. Returns a fatal message when the run cannot continue
 * (planning stages), or null when the loop should keep going. A chapter that
 * fails after its retries is recorded and skipped rather than killing the book.
 */
async function executeWork(active: ActiveRun, work: ForgeWork): Promise<string | null> {
  const { run } = active
  switch (work.kind) {
    case 'concept':
      return stepConcept(active)
    case 'codex':
      return stepCodex(active)
    case 'outline':
      return stepOutline(active)
    case 'expand':
      return stepExpand(active)
    case 'draft': {
      await stepDraft(active, work.chapterIndex)
      return null
    }
    case 'memory': {
      await stepMemory(active, work.chapterIndex)
      return null
    }
    case 'review': {
      await stepReview(active)
      return null
    }
    case 'finalize':
      stepFinalize(run)
      return null
  }
}

// ---- Model call helpers ----

interface CallResult {
  output: string
  step: ForgeStep
}

function providerSnapshot(providerId: string | null): {
  name: string
  model: string
  id: string | null
} {
  const cfg = store.getConfig()
  const pid = providerId ?? cfg.writing.providerId ?? cfg.ai.activeProviderId
  const provider = cfg.ai.providers.find((p) => p.id === pid) ?? cfg.ai.providers[0]
  if (!provider) throw new Error('No AI provider configured. Add one under Settings first.')
  return { name: provider.name, model: provider.model, id: provider.id }
}

/**
 * One recorded model call. The step is pushed in `running` state before the
 * request so an interrupted call is visible, then rewritten with its result.
 */
async function callModel(
  active: ActiveRun,
  params: {
    kind: ForgeStep['kind']
    label: string
    chapterId?: string | null
    messages: ChatMessage[]
    providerId: string | null
    timeouts?: { connectMs?: number; bodyMs?: number }
    /** Transform the raw answer before it is stored as evidence. */
    shape?: (raw: string) => string
  },
): Promise<CallResult> {
  const { run } = active
  const provider = providerSnapshot(params.providerId)
  const step: ForgeStep = {
    id: uid('s_'),
    kind: params.kind,
    label: params.label,
    chapterId: params.chapterId ?? null,
    status: 'running',
    startedAt: Date.now(),
    durationMs: null,
    providerName: provider.name,
    model: provider.model,
    inputChars: params.messages.reduce((sum, m) => sum + m.content.length, 0),
    outputChars: 0,
    usage: { source: 'unavailable', inputTokens: null, outputTokens: null, totalTokens: null },
    error: null,
    output: '',
  }
  run.steps.push(step)
  if (run.steps.length > FORGE_LIMITS.steps) run.steps = run.steps.slice(-FORGE_LIMITS.steps)
  persist(run)

  const startedAt = step.startedAt
  let lastError: unknown = null
  for (let attempt = 1; attempt <= MODEL_ATTEMPTS; attempt += 1) {
    try {
      const result = await active.chatFn(params.messages, provider.id ?? undefined, params.timeouts)
      const output = params.shape ? params.shape(result.content) : result.content
      // Prefer what the provider reported; estimate only when it said nothing.
      const usage =
        result.usage && result.usage.source !== 'unavailable'
          ? result.usage
          : estimateChatUsage(params.messages, result.content)
      step.status = 'completed'
      step.durationMs = Date.now() - startedAt
      step.outputChars = output.length
      step.usage = usage
      step.output = output.slice(0, FORGE_LIMITS.stepOutputChars)
      accumulateUsage(run, usage, step.durationMs)
      return { output, step }
    } catch (e) {
      lastError = e
      const message = e instanceof Error ? e.message : String(e)
      if (attempt < MODEL_ATTEMPTS) {
        appendLog(run, 'warn', `${params.label}: ${message} — retrying once.`)
        persist(run)
      }
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError)
  step.status = 'failed'
  step.error = message
  step.durationMs = Date.now() - startedAt
  step.output = ''
  appendLog(run, 'error', `${params.label} failed: ${message}`)
  persist(run)
  throw new Error(message)
}

function accumulateUsage(run: ForgeRun, usage: GenerationTokenUsage, durationMs: number): void {
  run.totals.modelCalls += 1
  run.totals.inputTokens += usage.inputTokens ?? 0
  run.totals.outputTokens += usage.outputTokens ?? 0
  run.totals.durationMs += durationMs
}

/**
 * Record a stage that is not a model call. The loop decides what to do next
 * from the recorded steps, so a stage that decided to do nothing still has to
 * say so — otherwise it would be re-entered forever.
 */
function recordStageStep(run: ForgeRun, kind: ForgeStepKind, label: string): void {
  run.steps.push({
    id: uid('s_'),
    kind,
    label,
    chapterId: null,
    status: 'completed',
    startedAt: Date.now(),
    durationMs: 0,
    providerName: '',
    model: '',
    inputChars: 0,
    outputChars: 0,
    usage: { source: 'unavailable', inputTokens: null, outputTokens: null, totalTokens: null },
    error: null,
    output: '',
  })
}

// ---- Stage 1: concept ----

async function stepConcept(active: ActiveRun): Promise<string | null> {
  const { run } = active
  const brief = run.brief
  const params = forgeBriefParams(brief)
  try {
    const { output } = await callModel(active, {
      kind: 'concept',
      label: 'Story concept',
      messages: [
        { role: 'system', content: PROMPTS.forge.concept.system },
        { role: 'user', content: PROMPTS.forge.concept.user(params) },
      ],
      providerId: brief.providerId,
      timeouts: JSON_CALL_TIMEOUT,
    })
    const concept = parseForgeConcept(output)
    run.concept = concept
    if (concept.genre) run.brief.genre = run.brief.genre || concept.genre
    appendLog(run, 'info', `Concept ready: “${concept.title}”.`)
    // Commit the book identity early so every other view shows the real title.
    const meta = store.getNovelMeta()
    store.saveNovelMeta({
      ...meta,
      title: concept.title || meta.title,
      synopsis: concept.synopsis || meta.synopsis,
      tags: concept.genre ? [concept.genre] : meta.tags,
    })
    return null
  } catch (e) {
    return fatalMessage(run, 'concept', e)
  }
}

// ---- Stage 2: codex ----

async function stepCodex(active: ActiveRun): Promise<string | null> {
  const { run } = active
  const brief = run.brief
  const concept = run.concept
  if (!concept) return 'The concept stage produced nothing to build a story bible from.'
  try {
    const { output } = await callModel(active, {
      kind: 'codex',
      label: 'Story bible',
      messages: [
        { role: 'system', content: PROMPTS.forge.codex.system },
        {
          role: 'user',
          content: PROMPTS.forge.codex.user({
            ...forgeBriefParams(brief),
            concept: serializeConcept(concept),
          }),
        },
      ],
      providerId: brief.providerId,
      timeouts: JSON_CALL_TIMEOUT,
    })
    const docs = parseForgeCodex(output)
    let written = 0
    for (const doc of docs) {
      if (!worldStillCurrent(run)) {
        return pauseBecauseWorldChanged(active, 'writing the story bible')
      }
      store.writeSetting(settingDocId(doc.category, doc.title), `${doc.content.trim()}\n`)
      written += 1
    }
    appendLog(run, 'info', `Story bible written: ${written} codex documents.`)
    return null
  } catch (e) {
    return fatalMessage(run, 'codex', e)
  }
}

// ---- Stage 3: outline ----

async function stepOutline(active: ActiveRun): Promise<string | null> {
  const { run } = active
  const brief = run.brief
  const concept = run.concept
  if (!concept) return 'The concept stage produced nothing to plan from.'
  try {
    assertExistingContentAllowed(brief)
    const { output } = await callModel(active, {
      kind: 'outline',
      label: `Outline (${brief.chapters} chapters)`,
      messages: [
        { role: 'system', content: PROMPTS.forge.outline.system },
        {
          role: 'user',
          content: PROMPTS.forge.outline.user({
            ...forgeBriefParams(brief),
            concept: serializeConcept(concept),
            codex: forgeCodexDigest(internalCodexDocs(), BUDGET.codex),
          }),
        },
      ],
      providerId: brief.providerId,
      timeouts: JSON_CALL_TIMEOUT,
    })

    const planned = parseForgePlan(output)
    const previous = new Map(run.chapters.map((c) => [c.order, c.chapterId]))
    // Ids are assigned once and used for both the outline store and the run
    // state; generating them twice would leave the manuscript structure and the
    // pipeline pointing at different chapter files.
    const volumes = assignPlan(planned, previous)

    if (!worldStillCurrent(run)) {
      return pauseBecauseWorldChanged(active, 'writing the outline')
    }
    // writeOutlineStore rewrites the structure and creates placeholder chapter
    // files, so the manuscript tree always matches the plan.
    store.writeOutlineStore(outlineStoreFrom(run, volumes))

    run.chapters = volumes.flatMap((volume) =>
      volume.chapters.map((chapter) => ({
        chapterId: chapter.chapterId,
        title: chapter.title,
        volumeTitle: volume.title,
        order: 0,
        beats: chapter.beats,
        prose: 'pending' as const,
        memory: 'pending' as const,
        words: 0,
        summary: '',
        endState: '',
        attempts: 0,
        memoryAttempts: 0,
        error: null,
      })),
    )
    run.chapters.forEach((chapter, index) => {
      chapter.order = index
    })
    appendLog(
      run,
      'info',
      `Outline ready: ${run.chapters.length} chapters in ${volumes.length} volume${
        volumes.length === 1 ? '' : 's'
      }.`,
    )
    return null
  } catch (e) {
    return fatalMessage(run, 'outline', e)
  }
}

// ---- Stage 3b: plan the next arc ----

/**
 * Add chapters to the end of the book.
 *
 * New chapters are appended to the outline's last volume (a continuation stays
 * inside the arc it is continuing), with the same id-assignment discipline as
 * the first outline: ids are created once and used for both the store and the
 * run state. The draft limit grows by the same amount, so the new chapters are
 * drafted next.
 */
async function stepExpand(active: ActiveRun): Promise<string | null> {
  const { run } = active
  const wanted = run.planRequest
  if (wanted <= 0) return null
  const concept = run.concept
  if (!concept) {
    run.planRequest = 0
    return 'There is no concept to continue from.'
  }

  const prior = store.readOutlineStore()
  const lastVolume = prior.volumes[prior.volumes.length - 1]
  if (!lastVolume) {
    run.planRequest = 0
    return 'The outline has no volume to continue from.'
  }

  try {
    const { output } = await callModel(active, {
      kind: 'outline',
      label: `Continue the plan (+${wanted} chapters)`,
      messages: [
        { role: 'system', content: PROMPTS.forge.expand.system },
        {
          role: 'user',
          content: PROMPTS.forge.expand.user({
            concept: serializeConcept(concept),
            codex: forgeCodexDigest(internalCodexDocs(), BUDGET.codex),
            planTail: planTailText(run, prior, 6),
            storySoFar: forgeStorySoFar(run, run.chapters.length, 4).slice(0, BUDGET.storySoFar),
            count: wanted,
            firstNumber: run.chapters.length + 1,
            titleFormat: PROMPTS.forge.chapterTitleFormat[run.brief.language],
            constraints: run.brief.constraints,
            languageDirective: languageDirective(run.brief),
          }),
        },
      ],
      providerId: run.brief.providerId,
      timeouts: JSON_CALL_TIMEOUT,
    })

    const planned = parseForgePlan(output)
    const added = planned.flatMap((volume) => volume.chapters)
    if (added.length === 0) throw new Error('The model planned no chapters.')

    if (!worldStillCurrent(run)) {
      return pauseBecauseWorldChanged(active, 'writing the extended outline')
    }

    // Append to the last volume, keeping every existing id and beat untouched.
    const newChapters = added.map((chapter, index) => ({
      id: uid('c_'),
      title: chapter.title || `Chapter ${run.chapters.length + index + 1}`,
      status: 'planned' as const,
      beats: chapter.beats,
    }))
    const nextStore: OutlineStore = {
      ...prior,
      updatedAt: Date.now(),
      volumes: prior.volumes.map((volume, index) =>
        index === prior.volumes.length - 1
          ? { ...volume, chapters: [...volume.chapters, ...newChapters] }
          : volume,
      ),
    }
    store.writeOutlineStore(nextStore)

    run.chapters.push(
      ...newChapters.map((chapter, index) => ({
        chapterId: chapter.id,
        title: chapter.title,
        volumeTitle: lastVolume.title,
        order: run.chapters.length + index,
        beats: chapter.beats,
        prose: 'pending' as const,
        memory: 'pending' as const,
        words: 0,
        summary: '',
        endState: '',
        attempts: 0,
        memoryAttempts: 0,
        error: null,
      })),
    )
    // Draft the new chapters: raise the limit to cover them, including any
    // earlier chapters a limited run had left out.
    const drafted = run.chapters.filter((chapter) => chapter.prose === 'drafted').length
    run.brief.scope = 'draft'
    run.brief.draftCount = Math.max(run.brief.draftCount, drafted) + newChapters.length
    run.planRequest = 0
    appendLog(
      run,
      'info',
      `Planned ${newChapters.length} more chapter${newChapters.length === 1 ? '' : 's'} ` +
        `(now ${run.chapters.length} in "${lastVolume.title}").`,
    )
    return null
  } catch (e) {
    run.planRequest = 0
    appendLog(
      run,
      'warn',
      `Planning more chapters failed (the existing plan is untouched): ${
        e instanceof Error ? e.message : String(e)
      }`,
    )
    return null
  }
}

/** The last few planned chapters, for the continuation prompt. */
function planTailText(run: ForgeRun, outline: OutlineStore, count: number): string {
  const serialized = outline.volumes
    .flatMap((volume) =>
      volume.chapters.map((chapter) => `### ${chapter.title}\n${serializeBeats(chapter.beats)}`),
    )
    .slice(-count)
  const drafts = run.chapters
    .slice(-count)
    .map(
      (chapter) =>
        `### ${chapter.title}${chapter.prose === 'drafted' ? ' (written)' : ' (planned only)'}`,
    )
  return [...new Set([...serialized, ...drafts])].join('\n\n')
}

// ---- Stage 4: chapter prose ----

async function stepDraft(active: ActiveRun, index: number): Promise<void> {
  const { run } = active
  const chapter = run.chapters[index]
  if (!chapter) return
  const brief = run.brief
  chapter.attempts += 1

  const meta = store.getNovelMeta()
  const file = chapterFileById(
    meta.volumes.flatMap((v) => v.chapters),
    chapter.chapterId,
  )
  if (!file) {
    chapter.prose = 'failed'
    chapter.error = 'This chapter is no longer part of the manuscript structure.'
    appendLog(run, 'error', `“${chapter.title}”: dropped from the outline, skipping.`)
    persist(run)
    return
  }

  try {
    const previousEnding = index > 0 ? previousChapterTail(run.chapters[index - 1]) : ''
    const { output } = await callModel(active, {
      kind: 'draft',
      label: `Chapter ${index + 1}: ${chapter.title}`,
      chapterId: chapter.chapterId,
      messages: [
        {
          role: 'system',
          content: PROMPTS.forge.chapter.system({
            chapterNumber: index + 1,
            totalChapters: run.chapters.length,
            wordsPerChapter: brief.wordsPerChapter,
            languageDirective: languageDirective(brief),
          }),
        },
        {
          role: 'user',
          content: PROMPTS.forge.chapter.user({
            concept: serializeConcept(run.concept),
            chapterNumber: index + 1,
            totalChapters: run.chapters.length,
            chapterTitle: chapter.title,
            chapterPlan: chapterPlanText(run, index),
            codex: forgeCodexDigest(internalCodexDocs(), BUDGET.codex),
            storyState: formatStoryState(store.readStoryState(), PROMPTS.assist.memory).slice(
              0,
              BUDGET.storyState,
            ),
            storySoFar: forgeStorySoFar(run, index).slice(0, BUDGET.storySoFar),
            previousEnding,
            voice: buildVoiceBlock().slice(0, BUDGET.voice),
            direction: forgeDirectivesFor(run, index + 1)
              .map((directive) => `- ${directive.text}`)
              .join('\n')
              .slice(0, BUDGET.direction),
            constraints: brief.constraints,
            languageDirective: languageDirective(brief),
            wordsPerChapter: brief.wordsPerChapter,
          }),
        },
      ],
      providerId: brief.providerId,
      timeouts: PROSE_CALL_TIMEOUT,
      shape: extractForgeProse,
    })

    const prose = output.trim()
    if (!prose) throw new Error('The model returned an empty chapter.')
    if (!worldStillCurrent(run)) {
      pauseBecauseWorldChanged(active, 'saving the chapter')
      return
    }

    store.writeChapter(file, `# ${chapter.title}\n\n${prose}\n`)
    const fresh = store.getNovelMeta()
    const target = fresh.volumes.flatMap((v) => v.chapters).find((c) => c.id === chapter.chapterId)
    if (target) {
      store.saveNovelMeta({
        ...fresh,
        volumes: fresh.volumes.map((volume) => ({
          ...volume,
          chapters: volume.chapters.map((c) =>
            c.id === chapter.chapterId
              ? {
                  ...c,
                  wordCount: countWords(prose),
                  status: 'draft' as const,
                  updatedAt: Date.now(),
                }
              : c,
          ),
        })),
      })
    }
    chapter.words = countWords(prose)
    chapter.prose = 'drafted'
    chapter.error = null
    run.totals.words = run.chapters.reduce((sum, c) => sum + c.words, 0)
    appendLog(
      run,
      'info',
      `Chapter ${index + 1} drafted: ${chapter.words.toLocaleString('en-US')} words.`,
    )
    persist(run)
  } catch (e) {
    chapter.prose = 'failed'
    chapter.error = e instanceof Error ? e.message : String(e)
    appendLog(
      run,
      'error',
      `Chapter ${index + 1} failed${chapter.attempts >= MODEL_ATTEMPTS ? ' — skipping it' : ''}: ${chapter.error}`,
    )
    persist(run)
  }
}

// ---- Stage 4b: chapter memory (continuity state) ----

async function stepMemory(active: ActiveRun, index: number): Promise<void> {
  const { run } = active
  const chapter = run.chapters[index]
  if (!chapter) return
  chapter.memoryAttempts += 1

  const meta = store.getNovelMeta()
  const file = chapterFileById(
    meta.volumes.flatMap((v) => v.chapters),
    chapter.chapterId,
  )
  const prose = file ? store.readChapter(file) : ''
  if (!prose.trim()) {
    chapter.memory = 'failed'
    chapter.error = 'Chapter prose is missing on disk, so it cannot be summarized.'
    persist(run)
    return
  }

  try {
    const { output } = await callModel(active, {
      kind: 'memory',
      label: `Memory: ${chapter.title}`,
      chapterId: chapter.chapterId,
      messages: [
        { role: 'system', content: PROMPTS.chapterSummary.systemPrompt },
        {
          role: 'user',
          content: PROMPTS.chapterSummary.userTemplate({
            chapterTitle: chapter.title,
            prose: prose.slice(0, 24_000),
          }),
        },
      ],
      providerId: run.brief.providerId,
      timeouts: JSON_CALL_TIMEOUT,
    })

    const parsed = parseChapterSummaryPayload(output)
    if (!parsed.summary.trim()) throw new Error('The model returned an empty chapter summary.')

    if (!worldStillCurrent(run)) {
      pauseBecauseWorldChanged(active, 'saving memory')
      return
    }
    store.writeChapterSummary({
      chapterId: chapter.chapterId,
      chapterTitle: chapter.title,
      sourceFingerprint: storyMemoryFingerprint(prose),
      generatedAt: Date.now(),
      summary: parsed.summary,
      endState: parsed.endState,
      stateChanges: parsed.stateChanges,
      plantedThreads: parsed.plantedThreads,
      resolvedThreads: parsed.resolvedThreads,
    })
    // The archive is always rebuilt from the summaries, never patched in place.
    store.writeStoryState(rebuildStoryState(store.listChapterSummaries()))

    chapter.summary = parsed.summary
    chapter.endState = parsed.endState
    chapter.memory = 'done'
    chapter.error = null
    appendLog(run, 'info', `Chapter ${index + 1} memory updated.`)
    persist(run)
  } catch (e) {
    chapter.memory = 'failed'
    appendLog(
      run,
      'warn',
      `Chapter ${index + 1} summary failed (later chapters continue without it): ${
        e instanceof Error ? e.message : String(e)
      }`,
    )
    persist(run)
  }
}

// ---- Stage 5: continuity review ----

async function stepReview(active: ActiveRun): Promise<void> {
  const { run } = active
  const brief = run.brief
  const drafted = run.chapters.filter((c) => c.prose === 'drafted')
  if (drafted.length === 0) {
    // Unreachable while the scheduler gates review on drafted prose, but a
    // review stage that does nothing still has to be recorded as attempted.
    recordStageStep(run, 'review', 'Continuity review (nothing drafted)')
    run.reviewedUpTo = 0
    appendLog(run, 'info', 'No drafted chapters to review.')
    persist(run)
    return
  }

  const meta = store.getNovelMeta()
  const files = meta.volumes.flatMap((v) => v.chapters)
  const proseBlocks: string[] = []
  let used = 0
  for (const chapter of drafted) {
    const file = chapterFileById(files, chapter.chapterId)
    const prose = file ? store.readChapter(file) : ''
    const body = prose.trim().slice(0, BUDGET.reviewPerChapter)
    const block = `### ${chapter.title}\n${body}`
    if (used + block.length > BUDGET.reviewProse) {
      proseBlocks.push(`### ${chapter.title}\n(omitted for length)`)
      continue
    }
    proseBlocks.push(block)
    used += block.length + 1
  }

  try {
    const { output } = await callModel(active, {
      kind: 'review',
      label: `Continuity review (${drafted.length} chapters)`,
      messages: [
        { role: 'system', content: PROMPTS.forge.review.system },
        {
          role: 'user',
          content: PROMPTS.forge.review.user({
            concept: serializeConcept(run.concept),
            chapterPlans: run.chapters
              .map((c, i) => `### ${i + 1}. ${c.title}\n${serializeBeats(c.beats)}`)
              .join('\n\n'),
            prose: proseBlocks.join('\n\n'),
            constraints: brief.constraints,
            languageDirective: languageDirective(brief),
          }),
        },
      ],
      providerId: brief.providerId,
      timeouts: JSON_CALL_TIMEOUT,
    })

    const findings = parseForgeFindings(output)
    // Coverage is recorded on the attempt (not only on success) so a failing
    // reviewer cannot re-enter the loop forever.
    run.reviewedUpTo = drafted.length
    if (findings.length === 0) {
      appendLog(run, 'info', 'Continuity review found no issues.')
      persist(run)
      return
    }

    if (!worldStillCurrent(run)) {
      pauseBecauseWorldChanged(active, 'saving review findings')
      return
    }
    const docs = store.listSettings()
    const queue = store.readReviewQueue()
    const now = Date.now()
    const items: ReviewQueueItem[] = findings.map((finding) => ({
      id: uid('rq_'),
      reportId: null,
      reportLabel: `Novel Forge · ${run.concept?.title ?? run.worldTitle}`,
      severity: finding.severity,
      text: finding.chapterTitle ? `[${finding.chapterTitle}] ${finding.text}` : finding.text,
      relatedDocIds: docs
        .filter((doc: SettingDoc) => finding.relatedDocTitles.includes(doc.title))
        .map((doc: SettingDoc) => doc.id),
      status: 'open',
      fixedIn: null,
      note: '',
      createdAt: now,
      updatedAt: now,
    }))
    store.writeReviewQueue({ version: 1, items: [...queue.items, ...items] })

    store.saveConsistencyReport({
      content: renderReviewMarkdown(run, findings),
      scope: { docs: [], chapters: drafted.map((c) => c.title) },
    })
    appendLog(run, 'info', `Continuity review: ${items.length} finding(s) queued for review.`)
    return
  } catch (e) {
    // A failed reviewer ends the stage rather than the book: record the
    // coverage so the loop moves on, and keep the draft untouched.
    run.reviewedUpTo = drafted.length
    appendLog(
      run,
      'warn',
      `Continuity review failed (the draft is unaffected): ${e instanceof Error ? e.message : String(e)}`,
    )
  }
}

function renderReviewMarkdown(
  run: ForgeRun,
  findings: ReturnType<typeof parseForgeFindings>,
): string {
  const lines = [
    `# Continuity review — ${run.concept?.title ?? run.worldTitle}`,
    '',
    `${findings.length} finding(s) from the Novel Forge pipeline.`,
    '',
  ]
  for (const finding of findings) {
    lines.push(`## [${finding.severity}] ${finding.chapterTitle || 'Whole draft'}`)
    lines.push('')
    lines.push(finding.text)
    if (finding.relatedDocTitles.length > 0) {
      lines.push('')
      lines.push(`Related: ${finding.relatedDocTitles.join(', ')}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

// ---- Stage 6: finalize ----

function stepFinalize(run: ForgeRun): void {
  const concept = run.concept
  if (concept) {
    const meta = store.getNovelMeta()
    store.saveNovelMeta({
      ...meta,
      title: concept.title || meta.title,
      synopsis: concept.synopsis || meta.synopsis,
      tags: concept.genre ? [concept.genre] : meta.tags,
    })
  }
  // Recorded as a step (no model call) so the main loop terminates and a
  // resumed run knows the book metadata was already committed.
  recordStageStep(run, 'finalize', 'Finalize')
  appendLog(run, 'info', 'Book metadata committed.')
  persist(run)
}

// ---- Context assembly helpers ----

function forgeBriefParams(brief: ForgeBrief): {
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

function languageDirective(brief: ForgeBrief): string {
  return PROMPTS.forge.languageDirective[brief.language]
}

/** Compact, stable text form of the concept used across stage prompts. */
function serializeConcept(concept: ForgeConcept | null): string {
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
 * The active chapter's plan: its beats, its volume's purpose, and the titles of
 * its neighbours, so the chapter sits in the book rather than floating free.
 */
function chapterPlanText(run: ForgeRun, index: number): string {
  const chapter = run.chapters[index]
  if (!chapter) return ''
  const lines = [
    chapter.volumeTitle ? `Volume: ${chapter.volumeTitle}` : '',
    `Beats (land every one, in order):`,
    serializeBeats(chapter.beats) || '- (no beats were planned; invent nothing beyond the concept)',
  ]
  const previous = run.chapters[index - 1]
  const next = run.chapters[index + 1]
  if (previous) lines.push(`Previous chapter: ${previous.title}`)
  if (next) lines.push(`Next chapter (do not write it, but leave it possible): ${next.title}`)
  return lines.filter(Boolean).join('\n')
}

function serializeBeats(beats: OutlineBeat[]): string {
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
function previousChapterTail(previous: { chapterId: string } | undefined, limit = 0): string {
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
function buildVoiceBlock(): string {
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
function internalCodexDocs(): { category: SettingCategory; title: string; content: string }[] {
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

function settingDocId(category: SettingCategory, title: string): string {
  const safe = title.replace(/[/\\:*?"<>|]/g, '_').trim() || 'Untitled'
  return `${category}/${safe}.md`
}

function chapterFileById(
  chapters: { id: string; file: string }[],
  chapterId: string,
): string | null {
  return chapters.find((chapter) => chapter.id === chapterId)?.file ?? null
}

function countWords(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length
  const words = (text.replace(/[\u4e00-\u9fff]/g, ' ').match(/\b\w+\b/g) || []).length
  return cjk + words
}

interface AssignedChapter {
  chapterId: string
  title: string
  beats: OutlineBeat[]
}

interface AssignedVolume {
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
function assignPlan(
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
        }
      }),
    }))
}

/** Turn the assigned plan into a structured outline store. */
function outlineStoreFrom(run: ForgeRun, volumes: AssignedVolume[]): OutlineStore {
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
      })),
    })),
  }
}

// ---- Error helpers ----

function fatalMessage(run: ForgeRun, stage: string, e: unknown): string {
  const message = e instanceof Error ? e.message : String(e)
  const hint =
    stage === 'concept'
      ? 'Nothing was written. Check the provider settings, then resume.'
      : 'Resume to retry this stage; already written stages are kept.'
  appendLog(run, 'error', `${stage} stage failed: ${message}`)
  return `${stage} stage failed: ${message} ${hint}`
}
