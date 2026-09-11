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
 * One model call, recorded.
 *
 * Every call becomes a `ForgeStep` written to the run before the request goes
 * out, so an interrupted call is visible rather than invisible, and rewritten
 * with its output, timing and token usage when it returns. Usage prefers what
 * the provider reported and falls back to a local estimate, keeping the two
 * distinguishable (see `GenerationTokenUsage.source`).
 */

import type {
  ChatMessage,
  ForgeRun,
  ForgeStep,
  ForgeStepKind,
  GenerationTokenUsage,
} from '../../shared/types'
import { FORGE_LIMITS } from '../../shared/forge'
import { estimateChatUsage } from '../../shared/generationEvidence'
import { uid } from '../../shared/uid'
import * as store from '../store'
import { MODEL_ATTEMPTS } from './limits'
import { appendLog, persist, type ActiveRun } from './state'

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
export async function callModel(
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
export function recordStageStep(run: ForgeRun, kind: ForgeStepKind, label: string): void {
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
