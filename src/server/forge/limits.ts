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
 * Types and tunables shared by every forge module.
 *
 * The timeouts exist because a provider that accepts a connection and then says
 * nothing must not park a six-hour book for ever. The budgets are per-prompt
 * character allowances: generous enough for a full chapter of context, small
 * enough that a long book still fits an ordinary context window.
 */

import type { ChatMessage, GenerationTokenUsage } from '../../shared/types'
import { FORGE_LIMITS } from '../../shared/forge'

/** A model answer plus whatever token accounting came with it. */
export interface ChatOutcome {
  content: string
  /** Provider-reported usage; absent/unavailable falls back to a local estimate. */
  usage?: GenerationTokenUsage | null
}

export type ChatFn = (
  messages: ChatMessage[],
  providerId?: string,
  timeouts?: { connectMs?: number; bodyMs?: number },
) => Promise<ChatOutcome>

// ---- Tunables ----

export const JSON_CALL_TIMEOUT = { connectMs: 90_000, bodyMs: 180_000 }
/** Prose may legitimately take minutes on a slow provider; only a total stall aborts. */
export const PROSE_CALL_TIMEOUT = { connectMs: 120_000, bodyMs: 900_000 }
/** One retry per model call: a transient 5xx or a dropped connection is common. */
export const MODEL_ATTEMPTS = FORGE_LIMITS.maxChapterAttempts
/** Per-prompt context budget, in characters. */
export const BUDGET = {
  codex: 12_000,
  storyState: 4_000,
  storySoFar: 3_000,
  previousEnding: 1_500,
  voice: 2_500,
  direction: 2_000,
  reviewProse: 60_000,
  reviewPerChapter: 3_000,
} as const
