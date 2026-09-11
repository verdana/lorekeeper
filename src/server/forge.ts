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
import type { ForgeDirective, ForgeRun } from '../shared/types'
import {
  FORGE_LIMITS,
  emptyForgeRun,
  forgeCanRetry,
  forgeNextWork,
  forgePhaseForWork,
  normalizeForgeBrief,
  normalizeDirective,
  type ForgeWork,
} from '../shared/forge'
import { chatWithUsage } from './ai'
import { forgeRunFile, getCurrentWorldId } from './paths'
import * as store from './store'
import { existsSync, rmSync } from 'fs'
import { uid } from '../shared/uid'
import type { ChatFn } from './forge/limits'
import {
  activeRuns,
  appendLog,
  assertExistingContentAllowed,
  currentRunForWrite,
  persist,
  readRunFile,
  worldStillCurrent,
  type ActiveRun,
} from './forge/state'
import { stepConcept, stepCodex, stepOutline, stepExpand } from './forge/planning-stages'
import { stepDraft, stepFinalize, stepMemory, stepReview } from './forge/chapter-stages'

// The run record is read and written by the state module; re-exported so callers
// (the RPC handlers, the tests) keep one import path for the whole feature.
export { readForgeRun } from './forge/state'

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
