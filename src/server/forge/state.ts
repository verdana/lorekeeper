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
 * Run state: the live-run registry, the run file, logging, and the guards that
 * keep a run inside its own world.
 *
 * Everything a stage needs in order to observe or advance a run lives here, so
 * the stage modules hold prompt and content logic only.
 */

import type { ForgeBrief, ForgeRun } from '../../shared/types'
import { FORGE_LIMITS, normalizeForgeRun } from '../../shared/forge'
import { ensureDir, forgeDir, forgeRunFile, getCurrentWorldId } from '../paths'
import * as store from '../store'
import { existsSync, readFileSync } from 'fs'
import type { ChatFn } from './limits'

// ---- Active runs (one per world) ----

export interface ActiveRun {
  run: ForgeRun
  paused: boolean
  cancelled: boolean
  chatFn: ChatFn
}

export const activeRuns = new Map<string, ActiveRun>()

// ---- Run state I/O ----

export const readRunFile = (): ForgeRun | null => {
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

export const persist = (run: ForgeRun): void => {
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

export function appendLog(run: ForgeRun, level: 'info' | 'warn' | 'error', message: string): void {
  run.log.push({ ts: Date.now(), level, message })
  if (run.log.length > FORGE_LIMITS.logEntries) {
    run.log = run.log.slice(-FORGE_LIMITS.logEntries)
  }
}

/**
 * The run object the author's edits must be applied to.
 *
 * While a run is live, the loop owns an in-memory object and persists it after
 * every step; mutating the on-disk copy instead would be overwritten by the
 * loop's next write. So edits target the live object when there is one, and the
 * freshly read file only when the run is idle.
 */
export function currentRunForWrite(): ForgeRun | null {
  const worldId = getCurrentWorldId()
  if (!worldId) return null
  const active = activeRuns.get(worldId)
  return active ? active.run : readRunFile()
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
export function assertExistingContentAllowed(brief: ForgeBrief): void {
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
export function worldStillCurrent(run: ForgeRun): boolean {
  return getCurrentWorldId() === run.worldId
}

/**
 * Stop the run because its world is no longer the active one. Nothing is
 * written and the run stays resumable from its last completed step; returning
 * null keeps the caller on the non-fatal path so the loop pauses rather than
 * marking the book as failed.
 */
export function pauseBecauseWorldChanged(active: ActiveRun, stage: string): null {
  active.paused = true
  active.run.status = 'paused'
  appendLog(active.run, 'warn', `Paused before ${stage}: the active world changed.`)
  return null
}

// ---- Error helpers ----

export function fatalMessage(run: ForgeRun, stage: string, e: unknown): string {
  const message = e instanceof Error ? e.message : String(e)
  const hint =
    stage === 'concept'
      ? 'Nothing was written. Check the provider settings, then resume.'
      : 'Resume to retry this stage; already written stages are kept.'
  appendLog(run, 'error', `${stage} stage failed: ${message}`)
  return `${stage} stage failed: ${message} ${hint}`
}
