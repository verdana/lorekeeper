/**
 * World store — every persisted file of a world, addressed through one module.
 *
 * Layout note: the data layer is split by domain, each module owning one kind of
 * file and importing the shared infrastructure from `./core`. `store.ts` is the
 * facade the RPC layer and the tests import, so callers see one module while the
 * implementation stays navigable:
 *
 *   core              atomic write, snapshot, damaged-file guards, safe paths
 *   worlds            the world index, world lifecycle, novel metadata
 *   config            app config (providers, personas, prompts) + API keys
 *   codex             codex documents and read-only external folder mappings
 *   manuscript        chapter files and manuscript prose search
 *   generation-runs   generation evidence
 *   history           version snapshots
 *   timeline          world events
 *   story             Story Memory, chapter summaries, the story-state archive
 *   outline           the structured outline (structure's source of truth)
 *   records           discussions, consistency reports, character chats, review queue
 *   voice             Voice Profile and style exemplars
 *   exports           whole-world zip, static codex wiki, epub
 *   forge-run         the Novel Forge run record (shape owned by the engine)
 *
 * Two rules hold across all of them: writes go through `atomicWrite` (temp file
 * → fsync → rename) and anything overwritten is snapshotted first, so a crash or
 * a bad AI response never costs the author unrecoverable text.
 */
/**
 * Generation evidence: one JSON record per model run, preserving the exact
 * prompt, context layers, parameters, output, usage and the author's result.
 *
 * Runs are pruned by count but never below the ones that carry a baseline, a
 * reproduction link or an author result.
 */

import type {
  CreateGenerationRunInput,
  GenerationRun,
  GenerationRunSummary,
  GenerationSelectedResult,
  GenerationStage,
  SaveGenerationAuthorResultInput,
} from '../../shared/types'
import { ensureDir, generationRunsDir } from '../paths'
import { calculateRetentionRatio, estimateChatUsage } from '../../shared/generationEvidence'
import { readJSON, safeResolve, writeJSON } from './core'
import { withoutProviderPricing, type LegacyPricedProvider } from './config'
import { createHash } from 'crypto'
import { existsSync, readdirSync, unlinkSync } from 'fs'
import { extname, join } from 'path'

// ---- Generation evidence ----

const generationRunPath = (id: string): string => {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid generation run id.')
  return safeResolve(generationRunsDir(), `${id}.json`)
}

const hashMessages = (stage: GenerationStage): string =>
  createHash('sha256').update(JSON.stringify(stage.messages)).digest('hex')

type LegacyCostedGenerationStage = GenerationStage & { cost?: unknown }

const withoutGenerationStagePricing = (stage: GenerationStage): GenerationStage => {
  const current: LegacyCostedGenerationStage = { ...stage }
  delete current.cost
  current.provider = withoutProviderPricing(current.provider as LegacyPricedProvider)
  return current
}

const withoutGenerationRunPricing = (run: GenerationRun): GenerationRun => ({
  ...run,
  stages: run.stages.map(withoutGenerationStagePricing),
})

const normalizeStageEvidence = (stage: GenerationStage): GenerationStage => {
  const current = withoutGenerationStagePricing(stage)
  const usage =
    current.status !== 'running' && current.usage.source === 'unavailable'
      ? estimateChatUsage(current.messages, current.output)
      : current.usage
  return {
    ...current,
    promptHash: hashMessages(current),
    usage,
  }
}

const hasCompletedSourceDraft = (run: GenerationRun): boolean => {
  if (run.reproductionOf) return false
  const draft = run.stages.find((stage) => stage.kind === 'draft')
  return draft?.status === 'completed' && Boolean(draft.output.trim())
}

const isValidGenerationBaseline = (run: GenerationRun): boolean =>
  Boolean(run.baseline) && hasCompletedSourceDraft(run)

const hasGenerationBaseline = (exceptId?: string): boolean => {
  const dir = generationRunsDir()
  if (!existsSync(dir)) return false
  return readdirSync(dir).some((file) => {
    if (extname(file) !== '.json') return false
    const run = readJSON<GenerationRun | null>(join(dir, file), null)
    return Boolean(
      run?.version === 1 && run.id !== exceptId && run.id && isValidGenerationBaseline(run),
    )
  })
}

/**
 * How many generation runs a world keeps on disk.
 *
 * A run stores its full prompt messages, context layers, raw output and the
 * author's saved text — measured at ~200 KB each — and nothing used to remove
 * them, so the archive grew without bound while every listing and every stage
 * save re-parsed all of it. The window follows the same policy as the version
 * snapshots: keep a useful recent history, discard the rest.
 */
const GENERATION_RUN_KEEP = 60

/**
 * Whether a run must survive pruning because it cannot be recreated.
 *
 * A baseline is the reference point every later comparison is measured against,
 * and a run carrying author evidence holds the only record of how much of a
 * draft the author actually kept. Both are historical facts, not diagnostics.
 */
const isProtectedGenerationRun = (run: GenerationRun): boolean =>
  Boolean(run.baseline) || Boolean(run.authorResult)

/**
 * Delete the oldest generation runs beyond the retention window. Returns how
 * many were removed. Runs that cannot be recreated are always kept, as is the
 * source of any kept reproduction and the oldest completed run, which is what
 * the baseline promotion in `listGenerationRuns` picks.
 */
export function pruneGenerationRuns(keep = GENERATION_RUN_KEEP): number {
  const dir = generationRunsDir()
  if (!existsSync(dir)) return 0
  const runs: GenerationRun[] = []
  for (const file of readdirSync(dir)) {
    if (extname(file) !== '.json') continue
    const run = readJSON<GenerationRun | null>(join(dir, file), null)
    if (run?.version === 1 && run.id) runs.push(run)
  }
  if (runs.length <= keep) return 0

  const newestFirst = [...runs].sort((a, b) => b.createdAt - a.createdAt)
  const kept = new Set(newestFirst.slice(0, keep).map((run) => run.id))
  for (const run of newestFirst) {
    if (isProtectedGenerationRun(run)) kept.add(run.id)
    // The source of a kept reproduction has to outlive it, or the kept run's
    // replay link dangles.
    if (run.reproductionOf && kept.has(run.id)) kept.add(run.reproductionOf)
  }
  const oldestComplete = [...runs]
    .filter(hasCompletedSourceDraft)
    .sort((a, b) => a.createdAt - b.createdAt)[0]
  if (oldestComplete) kept.add(oldestComplete.id)

  let removed = 0
  for (const run of newestFirst) {
    if (kept.has(run.id)) continue
    try {
      unlinkSync(generationRunPath(run.id))
      removed++
    } catch {
      // A run that cannot be removed is left in place; retention is best-effort.
    }
  }
  return removed
}

export function createGenerationRun(input: CreateGenerationRunInput): GenerationRun {
  ensureDir(generationRunsDir())
  const full = generationRunPath(input.id)
  if (existsSync(full)) throw new Error('Generation run already exists.')
  if (input.reproductionOf) {
    const source = readGenerationRun(input.reproductionOf)
    if (!source) throw new Error('Generation reproduction source not found.')
    if (source.chapterId !== input.chapterId || source.chapterTitle !== input.chapterTitle) {
      throw new Error('Generation reproduction must keep the source chapter identity.')
    }
  }
  const now = Date.now()
  const run: GenerationRun = {
    version: 1,
    id: input.id,
    pipeline: 'source-draft',
    mode: 'outline-write',
    chapterId: input.chapterId,
    chapterTitle: input.chapterTitle,
    createdAt: now,
    updatedAt: now,
    stages: [],
    selectedResult: null,
    authorResult: null,
    baseline: null,
    reproductionOf: input.reproductionOf ?? null,
  }
  writeJSON(full, run)
  // Prune at creation: a bounded, predictable moment that needs no extra UI.
  pruneGenerationRuns()
  return run
}

export function saveGenerationStage(runId: string, stage: GenerationStage): GenerationRun {
  ensureDir(generationRunsDir())
  const full = generationRunPath(runId)
  const stored = readJSON<GenerationRun | null>(full, null)
  if (!stored || stored.version !== 1 || stored.id !== runId) {
    throw new Error('Generation run not found or invalid.')
  }
  const current = withoutGenerationRunPricing(stored)
  if (!/^[A-Za-z0-9_-]+$/.test(stage.id)) throw new Error('Invalid generation stage id.')
  if (stage.kind !== 'draft') {
    throw new Error('Calibration stages are historical evidence and cannot be created or updated.')
  }
  const index = current.stages.findIndex((item) => item.id === stage.id)
  const existing = current.stages[index]
  const savedStage = normalizeStageEvidence(
    existing
      ? {
          ...existing,
          status: stage.status,
          durationMs: stage.durationMs,
          finishReason: stage.finishReason,
          usage: stage.usage,
          output: stage.output,
          error: stage.error,
        }
      : stage,
  )
  const stages = [...current.stages]
  if (index === -1) stages.push(savedStage)
  else stages[index] = savedStage
  const next: GenerationRun = { ...current, updatedAt: Date.now(), stages }
  const saved: GenerationRun =
    !next.baseline && hasCompletedSourceDraft(next) && !hasGenerationBaseline(next.id)
      ? {
          ...next,
          baseline: {
            capturedAt: Date.now(),
            pipelineVersion:
              next.pipeline === 'legacy-two-pass' ? 'legacy-two-pass-v1' : 'source-draft-v2',
          },
        }
      : next
  writeJSON(full, saved)
  return saved
}

export function readGenerationRun(id: string): GenerationRun | null {
  const full = generationRunPath(id)
  const run = readJSON<GenerationRun | null>(full, null)
  if (!run || run.version !== 1 || run.id !== id) return null
  const cleaned = withoutGenerationRunPricing(run)
  if (JSON.stringify(cleaned) !== JSON.stringify(run)) writeJSON(full, cleaned)
  return cleaned
}

export function selectGenerationResult(
  runId: string,
  result: Omit<GenerationSelectedResult, 'selectedAt'>,
): GenerationRun {
  const full = generationRunPath(runId)
  const stored = readJSON<GenerationRun | null>(full, null)
  if (!stored || stored.version !== 1 || stored.id !== runId) {
    throw new Error('Generation run not found or invalid.')
  }
  const current = withoutGenerationRunPricing(stored)
  if (result.kind !== 'draft') {
    throw new Error('Calibration results are historical evidence and cannot be newly selected.')
  }
  const stageIds = Array.from(new Set(result.stageIds))
  if (stageIds.length === 0 || !result.text) throw new Error('Invalid generation selection.')
  const selectedStages = stageIds.map((id) => current.stages.find((stage) => stage.id === id))
  if (selectedStages.some((stage) => !stage)) throw new Error('Generation stage not found.')
  const expectedStageIds = current.stages
    .filter((stage) => stage.kind === 'draft')
    .map((stage) => stage.id)
  if (!selectedStages.every((stage) => stage?.kind === 'draft')) {
    throw new Error('Generation selection does not match its stages.')
  }
  if (
    stageIds.length !== expectedStageIds.length ||
    expectedStageIds.some((id) => !stageIds.includes(id))
  ) {
    throw new Error('Generation selection must include every source stage of its kind.')
  }
  const now = Date.now()
  const saved: GenerationRun = {
    ...current,
    updatedAt: now,
    selectedResult: { ...result, stageIds, selectedAt: now },
    authorResult: null,
  }
  writeJSON(full, saved)
  return saved
}

export function saveGenerationAuthorResult(
  runId: string,
  result: SaveGenerationAuthorResultInput,
): GenerationRun {
  const full = generationRunPath(runId)
  const stored = readJSON<GenerationRun | null>(full, null)
  if (!stored || stored.version !== 1 || stored.id !== runId) {
    throw new Error('Generation run not found or invalid.')
  }
  const current = withoutGenerationRunPricing(stored)
  if (!current.selectedResult) throw new Error('Generation result has not been selected.')
  const now = Date.now()
  if (
    !Number.isFinite(result.editingStartedAt) ||
    result.editingStartedAt < current.selectedResult.selectedAt ||
    result.editingStartedAt > now
  ) {
    throw new Error('Invalid generation editing start time.')
  }
  const saved: GenerationRun = {
    ...current,
    updatedAt: now,
    authorResult: {
      text: result.text,
      savedAt: now,
      editingStartedAt: result.editingStartedAt,
      editingDurationMs: now - result.editingStartedAt,
      durationMeasurement: 'elapsed',
      retentionRatio: calculateRetentionRatio(current.selectedResult.text, result.text),
    },
  }
  writeJSON(full, saved)
  return saved
}

const summarizeGenerationRun = (run: GenerationRun): GenerationRunSummary => ({
  id: run.id,
  chapterId: run.chapterId,
  chapterTitle: run.chapterTitle,
  createdAt: run.createdAt,
  updatedAt: run.updatedAt,
  stageCount: run.stages.length,
  status: run.stages.at(-1)?.status ?? 'empty',
  selectedResultKind: run.selectedResult?.kind ?? null,
  hasAuthorResult: Boolean(run.authorResult),
  retentionRatio: run.authorResult?.retentionRatio ?? null,
  isBaseline: isValidGenerationBaseline(run),
  reproductionOf: run.reproductionOf ?? null,
})

export function listGenerationRuns(chapterId?: string): GenerationRunSummary[] {
  const dir = generationRunsDir()
  if (!existsSync(dir)) return []
  const runs: GenerationRun[] = []
  for (const file of readdirSync(dir)) {
    if (extname(file) !== '.json') continue
    const full = join(dir, file)
    const run = readJSON<GenerationRun | null>(full, null)
    if (!run || run.version !== 1 || !run.id) continue
    const cleaned = withoutGenerationRunPricing(run)
    if (JSON.stringify(cleaned) !== JSON.stringify(run)) writeJSON(full, cleaned)
    if (chapterId && cleaned.chapterId !== chapterId) continue
    runs.push(cleaned)
  }
  if (!chapterId && !runs.some(isValidGenerationBaseline)) {
    const candidate = runs
      .filter(hasCompletedSourceDraft)
      .sort((a, b) => a.createdAt - b.createdAt)[0]
    if (candidate) {
      candidate.baseline = {
        capturedAt: Date.now(),
        pipelineVersion:
          candidate.pipeline === 'legacy-two-pass' ? 'legacy-two-pass-v1' : 'source-draft-v2',
      }
      candidate.updatedAt = Date.now()
      writeJSON(generationRunPath(candidate.id), candidate)
    }
  }
  return runs.sort((a, b) => b.createdAt - a.createdAt).map(summarizeGenerationRun)
}
