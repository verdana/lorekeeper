// Batch writing engine: create or rewrite N chapters in one run.
//
// Pure helpers (ensureHeading, createContextAllocator, buildBatchMessages,
// planContinueChapters, isGenerationSuccess) are unit-testable; the engine
// (runBatchWrite / resumeBatch) takes all IO through deps so tests can mock
// window.api and the store.
//
// Design doc: docs/manuscript-batch-write-design.md (§3/§4).

import type {
  AppConfig,
  Chapter,
  ChatMessage,
  CommitBatchChapterInput,
  DiscussionSession,
  NovelMeta,
  SettingDoc,
  StoryMemoryStore,
  TimelineEvent,
  VoiceProfile,
} from '@shared/types'
import { PROMPTS } from '@shared/prompts'
import { orderedChapters, selectStoryMemories, buildStoryMemoryContext } from '@shared/storyMemory'
import { buildSceneCardContext } from '@shared/sceneCard'
import { uid, wordCount } from './lib'

// ---- Task types ----

export type BatchWriteMode = 'continue' | 'rewrite'
export type BatchTaskStatus =
  'preparing' | 'running' | 'retrying' | 'attention' | 'done' | 'failed' | 'stopped'
export type BatchChapterStatus = 'pending' | 'writing' | 'done' | 'failed' | 'stopped' | 'deleted'
export type BatchFailureKind = 'generation' | 'persist'

export interface BatchChapterState {
  id: string
  title: string
  /** Chapter body file name (chapters/<file> on disk). */
  file: string
  status: BatchChapterStatus
  failureKind?: BatchFailureKind
  error?: string
  words: number
  /** Generated text kept in memory when a persist failure must retry without re-calling the model. */
  generatedText?: string
}

export interface BatchWriteTask {
  id: string
  worldId: string
  worldName: string
  mode: BatchWriteMode
  count: number
  /** Rewrite mode: first target chapter id (index into the reading order). */
  startChapterId?: string
  /** Optional writers'-room session whose conclusion is injected. */
  discussionSessionId?: string
  useVoice: boolean
  /** User-supplied direction; empty string falls back to the pack default. */
  direction: string
  status: BatchTaskStatus
  chapters: BatchChapterState[]
  currentIndex: number
  error?: string
  startedAt: number
}

// ---- Completeness verdict ----

/** Finish reasons accepted as a complete generation (whitelist, not denylist). */
export const SUCCESS_FINISH_REASONS = new Set(['stop'])

export interface GenerationOutcome {
  content: string
  finishReason: string | null
  completed: boolean
}

/** A chapter counts as generated only on model-level done + whitelisted reason + non-empty body. */
export function isGenerationSuccess(outcome: GenerationOutcome): boolean {
  return (
    outcome.completed === true &&
    outcome.finishReason !== null &&
    SUCCESS_FINISH_REASONS.has(outcome.finishReason) &&
    outcome.content.trim().length > 0
  )
}

// ---- ensureHeading ----

/**
 * Normalize a generated chapter body so it starts with exactly one `# {title}`
 * H1: strips BOM/leading whitespace, replaces a wrong first H1, prepends when
 * missing. Pure and deterministic — the model's heading is never trusted.
 */
export function ensureHeading(text: string, title: string): string {
  const trimmed = text.replace(/^\uFEFF/, '').trimStart()
  const heading = `# ${title}`
  if (/^#\s+[^\n]*/.test(trimmed)) {
    return trimmed.replace(/^#\s+[^\n]*/, heading)
  }
  return `${heading}\n\n${text}`
}

// ---- Context budget allocator ----

export const CONTEXT_BUDGET = 12000

export interface ContextAllocatorWeights {
  settings: number
  outline: number
  timeline: number
  memories: number
  /** Optional; when set it takes its own share and prev shrinks. */
  discussion?: number
}

export interface ContextInputs {
  settings: string
  outline: string
  timeline: string
  memories: string
  discussion?: string
  prevChapters: string
}

export interface BudgetedContext extends ContextInputs {
  truncated: boolean
}

/**
 * Proportional budget allocator, extracted from AiAssistPanel.applyBudget so
 * the panel keeps its exact legacy shares while batch writing adds a
 * discussion share. `prev` always gets whatever remains.
 */
export function createContextAllocator(weights: ContextAllocatorWeights) {
  return (inputs: ContextInputs): BudgetedContext => {
    const parts: { key: keyof ContextInputs; text: string; budget: number; fromEnd: boolean }[] = [
      { key: 'settings', text: inputs.settings, budget: weights.settings, fromEnd: false },
      { key: 'outline', text: inputs.outline, budget: weights.outline, fromEnd: false },
      { key: 'timeline', text: inputs.timeline, budget: weights.timeline, fromEnd: false },
      { key: 'memories', text: inputs.memories, budget: weights.memories, fromEnd: false },
    ]
    if (weights.discussion !== undefined) {
      parts.push({
        key: 'discussion',
        text: inputs.discussion ?? '',
        budget: weights.discussion,
        fromEnd: false,
      })
    }
    parts.push({ key: 'prevChapters', text: inputs.prevChapters, budget: 0, fromEnd: true })

    const total = parts.reduce((sum, p) => sum + p.text.length, 0)
    if (total <= CONTEXT_BUDGET) {
      return { ...inputs, truncated: false }
    }
    const result: ContextInputs = { ...inputs }
    let used = 0
    for (const p of parts) {
      if (p.key === 'prevChapters') {
        // prev keeps whatever remains, taken from the end (most recent first).
        result.prevChapters = p.text.slice(-(CONTEXT_BUDGET - used))
        continue
      }
      const cap = Math.floor(CONTEXT_BUDGET * p.budget)
      const sliced = p.text.slice(0, cap)
      result[p.key] = sliced
      used += sliced.length
    }
    return { ...result, truncated: true }
  }
}

// ---- Pre-creation plan (continue mode) ----

export interface ContinuePlan {
  /** Target volume with the planned chapters already appended. */
  volume: { id: string; title: string; order: number; chapters: Chapter[] }
  chapters: Chapter[]
  createdVolume: boolean
}

/**
 * Compute the frozen target list for a continue run: append `count` chapters
 * to the last volume (creating a volume when the book has none). Titles/orders/
 * ids are decided once here and never shift afterwards.
 */
export function planContinueChapters(novel: NovelMeta, count: number): ContinuePlan {
  const last = novel.volumes[novel.volumes.length - 1]
  let volume = last
  let createdVolume = false
  if (!volume) {
    const maxVolumeOrder = novel.volumes.reduce((m, v) => Math.max(m, v.order), -1)
    volume = {
      id: uid('v_'),
      title: `Volume ${novel.volumes.length + 1}`,
      order: maxVolumeOrder + 1,
      chapters: [],
    }
    createdVolume = true
  }
  const baseCount = volume.chapters.length
  // Titles count sequentially; orders follow max(existing order)+1 so gaps left
  // by deleted chapters never collide with the new ones.
  const maxChapterOrder = volume.chapters.reduce((m, c) => Math.max(m, c.order), -1)
  const chapters: Chapter[] = Array.from({ length: count }, (_, i) => ({
    id: uid('c_'),
    volumeId: volume.id,
    title: `Chapter ${baseCount + i + 1}`,
    order: maxChapterOrder + 1 + i,
    file: `${volume.id}_${uid()}.md`,
    wordCount: 0,
    status: 'draft',
    updatedAt: Date.now(),
  }))
  return {
    volume: { ...volume, chapters: [...volume.chapters, ...chapters] },
    chapters,
    createdVolume,
  }
}

// ---- Message assembly ----

function sceneRelevantDocIds(
  docs: SettingDoc[],
  signalText: string,
  scene: { locationId: string | null; participantIds: string[] } | undefined,
): Set<string> {
  const relevant = new Set<string>()
  if (scene?.locationId) relevant.add(scene.locationId)
  for (const id of scene?.participantIds ?? []) relevant.add(id)
  const hasSignal = signalText.trim().length > 0
  for (const doc of docs) {
    if (doc.category === '01-worldview') {
      relevant.add(doc.id)
    } else if (hasSignal && doc.title && signalText.includes(doc.title)) {
      relevant.add(doc.id)
    }
  }
  const anyCharacter = [...relevant].some((id) =>
    docs.some((d) => d.id === id && d.category === '11-character'),
  )
  if (!anyCharacter) {
    for (const doc of docs) {
      if (doc.category === '11-character') relevant.add(doc.id)
    }
  }
  return relevant
}

export interface BatchMessageInput {
  mode: BatchWriteMode
  /** 1-based chapter position in the batch. */
  i: number
  n: number
  chapterTitle: string
  direction: string
  settings: string
  outline: string
  timeline: string
  memories: string
  scene: string
  prevChapters: string
  discussion?: string
  /** Rewrite mode only: the chapter's current body. */
  rewriteTarget?: string
  systemPrompt: string
  voiceContext: string
}

/** Assemble the system + user messages for one batch chapter (localized via PromptPack). */
export function buildBatchMessages(input: BatchMessageInput): ChatMessage[] {
  const ctx = PROMPTS.assist.context
  const b = PROMPTS.assist.batch
  const blocks: string[] = []
  if (input.mode === 'rewrite') {
    const r = ctx.rewrite
    blocks.push(`## ${r.chapter}`, input.rewriteTarget || ctx.empty, '')
    blocks.push(`## ${ctx.outline.codex}`, input.settings || ctx.empty, '')
    if (input.scene) blocks.push(input.scene, '')
    blocks.push(`## ${ctx.outline.timeline}`, input.timeline || ctx.empty, '')
    blocks.push(`## ${ctx.outline.memories}`, input.memories || ctx.empty, '')
    blocks.push(`## ${ctx.outline.outline}`, input.outline || ctx.empty, '')
    if (input.discussion) {
      blocks.push(`## ${b.workshopReport}`, input.discussion, '')
    }
    blocks.push(`## ${ctx.outline.prevChapters}`, input.prevChapters || ctx.empty, '')
    blocks.push(
      `## ${r.instructions}`,
      b.batchInstructionRewrite(input.i, input.n, input.chapterTitle),
    )
  } else {
    const c = ctx.continue
    const tail = input.prevChapters
    blocks.push(
      input.direction.trim()
        ? `[${c.prevTail}]\n${tail.slice(-2000)}\n\n[${c.direction}]\n${input.direction}`
        : `[${c.prevTail}]\n${tail.slice(-2000)}\n\n${b.defaultDirection}`,
      '',
      `## ${c.codex}`,
      input.settings || c.emptyCodex,
      '',
    )
    if (input.scene) blocks.push(input.scene, '')
    blocks.push(
      `## ${c.timeline}`,
      input.timeline || ctx.empty,
      '',
      `## ${c.memories}`,
      input.memories || ctx.empty,
      '',
      `## ${c.outline}`,
      input.outline || c.emptyOutline,
      '',
    )
    if (input.discussion) {
      blocks.push(`## ${b.workshopReport}`, input.discussion, '')
    }
    blocks.push(
      `## ${c.prevChapters}`,
      input.prevChapters || c.emptyPrev,
      '',
      b.batchInstructionContinue(input.i, input.n, input.chapterTitle),
    )
  }
  return [
    { role: 'system', content: input.systemPrompt + input.voiceContext },
    { role: 'user', content: blocks.join('\n') },
  ]
}

// ---- Engine ----

/** Everything the engine needs from the outside world — injected for testability. */
export interface BatchWriteDeps {
  getNovel: () => NovelMeta
  getConfig: () => AppConfig | null
  getSettingDocs: () => SettingDoc[]
  getVoiceProfile: () => VoiceProfile | null
  readSetting: (id: string) => Promise<string>
  readOutline: () => Promise<string>
  listTimelineEvents: () => Promise<TimelineEvent[]>
  readStoryMemory: () => Promise<StoryMemoryStore>
  readChapter: (file: string) => Promise<string>
  listDiscussions: () => Promise<DiscussionSession[]>
  saveNovel: (meta: NovelMeta) => Promise<void>
  forceSnapshot: (sourcePath: string) => Promise<unknown>
  commitBatchChapter: (input: CommitBatchChapterInput) => Promise<NovelMeta>
  removeBatchChapter: (worldId: string, chapterId: string) => Promise<NovelMeta>
  chat: (
    messages: ChatMessage[],
    providerId: string | undefined,
    onChunk: (type: 'reasoning' | 'content', text: string) => void,
    signal?: AbortSignal,
    temperature?: number,
    topP?: number,
    disableThinking?: boolean,
  ) => Promise<{
    content: string
    reasoning: string
    finishReason: string | null
    completed: boolean
  }>
  /** Strict editor flush; throws instead of swallowing save errors. */
  flushOrThrow: () => Promise<void>
  /** Push the latest task state to the store. */
  onUpdate: (task: BatchWriteTask) => void
  /** Apply the server-returned novel meta (e.g. useStore.setState). */
  applyNovel: (meta: NovelMeta) => void
  /** Register the engine's current AbortController so the UI can Stop it. */
  registerAbort: (ctrl: AbortController) => void
  /**
   * User-edited batch system prompt from localStorage (ai-prompt:batch-*:{lang}),
   * overriding the built-in pack default; null/undefined falls back to built-in.
   */
  getCustomSystemPrompt?: (mode: BatchWriteMode) => string | null
  /** Current world id (used to guard the continue-mode pre-creation step). */
  getCurrentWorldId?: () => string | null
}

const MAX_GENERATION_RETRIES = 1

const isAbort = (e: unknown): boolean =>
  (e instanceof DOMException && e.name === 'AbortError') ||
  (e instanceof Error && e.name === 'AbortError')

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Run the full batch: flush → strict snapshots → pre-create (continue) →
 * generate chapters sequentially. The task object is mutated in place and
 * pushed through deps.onUpdate after every transition.
 */
export async function runBatchWrite(deps: BatchWriteDeps, task: BatchWriteTask): Promise<void> {
  task.status = 'preparing'
  deps.onUpdate(task)
  // Register the abort handle immediately so Stop works during flush/snapshots,
  // not only once the generation loop starts.
  const controller = new AbortController()
  deps.registerAbort(controller)
  try {
    // 2. strict flush (order per design §3.4; claim already done by the caller).
    await deps.flushOrThrow()

    // Guard the whole run against a world switch that slipped past the UI
    // guards: the server writes to whatever world it currently has selected,
    // so a stale task must abort before snapshot/pre-creation/commit.
    if (deps.getCurrentWorldId && deps.getCurrentWorldId() !== task.worldId) {
      task.status = 'failed'
      task.error = 'World switched mid-batch.'
      deps.onUpdate(task)
      return
    }

    // 3. strict snapshots (must precede pre-creation so restores carry no batch rows).
    await deps.forceSnapshot('novel.json')
    if (task.mode === 'rewrite') {
      for (const ch of task.chapters) {
        if (ch.status === 'deleted') continue
        await deps.forceSnapshot(`chapters/${ch.file}`)
      }
    }

    // 4. pre-create frozen metadata (continue mode).
    let novel = deps.getNovel()
    if (task.mode === 'continue') {
      const plan = planContinueChapters(novel, task.count)
      const volumes = plan.createdVolume
        ? [...novel.volumes, plan.volume]
        : novel.volumes.map((v) => (v.id === plan.volume.id ? plan.volume : v))
      const next: NovelMeta = { ...novel, volumes }
      await deps.saveNovel(next)
      deps.applyNovel(next)
      novel = next
      task.chapters = plan.chapters.map((c) => ({
        id: c.id,
        title: c.title,
        file: c.file,
        status: 'pending' as const,
        words: 0,
      }))
      task.currentIndex = 0
      deps.onUpdate(task)
    }

    // 5. generate.
    task.status = 'running'
    deps.onUpdate(task)
    await runChapterLoop(deps, task, novel, 0, controller.signal)
    settle(task, deps.onUpdate)
  } catch (e) {
    if (isAbort(e)) {
      task.status = 'stopped'
    } else {
      task.status = 'failed'
      task.error = errorMessage(e)
    }
    deps.onUpdate(task)
  } finally {
    controller.abort()
  }
}

/**
 * Resume a paused batch (attention/stopped) from `startIndex` under a fresh
 * AbortController. Used by "retry and continue" and "continue batch".
 */
export async function resumeBatch(
  deps: BatchWriteDeps,
  task: BatchWriteTask,
  startIndex: number,
): Promise<void> {
  let controller: AbortController | null = null
  try {
    controller = new AbortController()
    deps.registerAbort(controller)
    task.status = 'retrying'
    task.error = undefined
    deps.onUpdate(task)
    await runChapterLoop(deps, task, deps.getNovel(), startIndex, controller.signal)
    settle(task, deps.onUpdate)
  } catch (e) {
    if (isAbort(e)) task.status = 'stopped'
    else {
      task.status = 'failed'
      task.error = errorMessage(e)
    }
    deps.onUpdate(task)
  } finally {
    controller?.abort()
  }
}

/** Compute the final task status after the loop stops (done/attention/stopped). */
function settle(task: BatchWriteTask, onUpdate: (t: BatchWriteTask) => void): void {
  if (task.status === 'stopped' || task.status === 'failed') {
    onUpdate(task)
    return
  }
  if (task.chapters.length === 0) {
    // An empty target list must never look like a successful run.
    task.status = 'failed'
    task.error = 'No target chapters.'
    onUpdate(task)
    return
  }
  const hasFailed = task.chapters.some((c) => c.status === 'failed')
  if (hasFailed) task.status = 'attention'
  else if (task.chapters.every((c) => c.status === 'done' || c.status === 'deleted'))
    task.status = 'done'
  else task.status = 'stopped'
  task.currentIndex = -1
  onUpdate(task)
}

/**
 * Delete one pre-created empty chapter from a paused batch. The task is
 * temporarily put in `retrying` (guarding world switches), the server validates
 * emptiness, the chapter is marked `deleted`, then the task is re-settled.
 */
export async function deleteEmptyChapter(
  deps: BatchWriteDeps,
  task: BatchWriteTask,
  chapterId: string,
): Promise<void> {
  task.status = 'retrying'
  task.error = undefined
  deps.onUpdate(task)
  try {
    const next = await deps.removeBatchChapter(task.worldId, chapterId)
    deps.applyNovel(next)
    task.chapters = task.chapters.map((c) =>
      c.id === chapterId ? { ...c, status: 'deleted' as const } : c,
    )
    settle(task, deps.onUpdate)
  } catch (e) {
    task.error = errorMessage(e)
    task.status = 'attention'
    deps.onUpdate(task)
    throw e
  }
}

async function runChapterLoop(
  deps: BatchWriteDeps,
  task: BatchWriteTask,
  initialNovel: NovelMeta,
  startIndex: number,
  signal: AbortSignal,
): Promise<void> {
  const config = deps.getConfig()
  const settingDocs = deps.getSettingDocs()
  const voiceProfile = deps.getVoiceProfile()
  const [outlineText, events, memoryStore, discussions] = await Promise.all([
    deps.readOutline(),
    deps.listTimelineEvents(),
    deps.readStoryMemory().catch(() => ({ version: 1 as const, entries: [] })),
    deps.listDiscussions(),
  ])
  const eventsSorted = [...events].sort((a, b) => a.dateOrder - b.dateOrder)
  const timelineText = eventsSorted
    .map(
      (e) =>
        `- ${e.dateLabel ? `**${e.dateLabel}** ` : ''}${e.title}${e.description ? `: ${e.description}` : ''}`,
    )
    .join('\n')
  const selectedDiscussion = task.discussionSessionId
    ? discussions.find((d) => d.id === task.discussionSessionId)
    : undefined
  const discussionText = selectedDiscussion?.conclusion
    ? `## ${selectedDiscussion.topic || 'Discussion conclusion'}\n\n${selectedDiscussion.conclusion}`
    : undefined

  const settingContents = new Map<string, string>()
  for (const doc of settingDocs) {
    try {
      settingContents.set(doc.id, await deps.readSetting(doc.id))
    } catch {
      settingContents.set(doc.id, '')
    }
  }

  const ordered = orderedChapters(initialNovel)
  const textCache = new Map<string, string>()
  const readSavedText = async (chapterId: string): Promise<string> => {
    const hit = textCache.get(chapterId)
    if (hit !== undefined) return hit
    const item = ordered.find((o) => o.chapter.id === chapterId)
    if (!item) return ''
    const text = await deps.readChapter(item.chapter.file)
    textCache.set(chapterId, text)
    return text
  }

  const allocator = createContextAllocator({
    settings: 0.3,
    outline: 0.1,
    timeline: 0.1,
    memories: 0.25,
    discussion: 0.1,
  })
  const writingProvider = config?.writing?.providerId ?? config?.ai.activeProviderId ?? undefined
  const temperature = config?.writing?.temperature
  const topP = config?.writing?.topP
  const sysPrompt =
    deps.getCustomSystemPrompt?.(task.mode) ??
    (task.mode === 'rewrite'
      ? PROMPTS.assist.batch.rewriteSystemPrompt
      : PROMPTS.assist.batch.continueSystemPrompt)
  const voiceContext = task.useVoice && voiceProfile ? buildVoiceContextText(voiceProfile) : ''

  let novel = initialNovel
  for (let idx = startIndex; idx < task.chapters.length; idx++) {
    if (signal.aborted) {
      markRestStopped(task, idx)
      return
    }
    const chapter = task.chapters[idx]
    if (chapter.status === 'done' || chapter.status === 'deleted') continue
    if (chapter.status === 'stopped') {
      chapter.status = 'pending'
    }
    task.currentIndex = idx
    chapter.status = 'writing'
    chapter.error = undefined
    deps.onUpdate(task)

    // Locate the chapter in the (possibly updated) novel metadata.
    let meta: Chapter | undefined
    for (const v of novel.volumes) {
      for (const c of v.chapters) {
        if (c.id === chapter.id) {
          meta = c
          break
        }
      }
      if (meta) break
    }
    if (!meta) {
      // The chapter was deleted out-of-band — treat as deleted.
      chapter.status = 'deleted'
      deps.onUpdate(task)
      continue
    }

    // Assemble per-chapter context.
    const originalText = await readSavedText(meta.id)
    const signalText =
      task.mode === 'rewrite'
        ? `${meta.title}\n${originalText}\n${outlineText}`
        : `${meta.title}\n${outlineText}`
    const relevant = sceneRelevantDocIds(settingDocs, signalText, meta.scene)
    const settingTexts: string[] = []
    for (const doc of settingDocs) {
      if (!relevant.has(doc.id)) continue
      const content = settingContents.get(doc.id) ?? ''
      if (content.trim()) settingTexts.push(`## ${doc.title}\n\n${content}`)
    }
    const sceneText = buildSceneCardContext(meta.scene, settingDocs, eventsSorted)
    const sourceIds = [...new Set(memoryStore.entries.map((e) => e.source.chapterId))]
    await Promise.all(sourceIds.map((id) => readSavedText(id)))
    const selectedMemories = selectStoryMemories({
      store: memoryStore,
      novel,
      activeChapterId: meta.id,
      sourceTexts: textCache,
      signalText,
      settingDocs,
    })
    const memoryCtx = buildStoryMemoryContext(
      selectedMemories,
      eventsSorted,
      Math.floor(CONTEXT_BUDGET * 0.25),
    )

    // Previous chapters in reading order, before the current one, newest tail
    // preferred by the allocator (prev slice(-budget)).
    const chapterSnippets: string[] = []
    const currentIndexInOrder = ordered.findIndex((o) => o.chapter.id === meta.id)
    for (let k = 0; k < currentIndexInOrder; k++) {
      const item = ordered[k]
      const text = await readSavedText(item.chapter.id)
      if (text.trim()) {
        chapterSnippets.push(
          `### ${item.chapter.title}\n\n${text.slice(0, 800)}${text.length > 800 ? '…' : ''}`,
        )
      }
    }

    const budgeted = allocator({
      settings: settingTexts.join('\n\n---\n\n'),
      outline: outlineText,
      timeline: timelineText,
      memories: memoryCtx.text,
      discussion: discussionText,
      prevChapters: chapterSnippets.join('\n\n'),
    })

    const messages = buildBatchMessages({
      mode: task.mode,
      i: idx + 1,
      n: task.count,
      chapterTitle: meta.title,
      direction: task.direction,
      settings: budgeted.settings,
      outline: budgeted.outline,
      timeline: budgeted.timeline,
      memories: budgeted.memories,
      scene: sceneText,
      prevChapters: budgeted.prevChapters,
      discussion: budgeted.discussion,
      rewriteTarget: task.mode === 'rewrite' ? originalText.slice(0, 8000) : undefined,
      systemPrompt: sysPrompt,
      voiceContext,
    })

    // Generate with one automatic retry on generation failure. A chapter with
    // cached generatedText (a previous persist failure) is replayed instead:
    // persist-only retry, never re-calling the model.
    let outcome: GenerationOutcome | null = null
    let lastError: string | undefined
    if (chapter.generatedText) {
      outcome = { content: chapter.generatedText, finishReason: 'stop', completed: true }
    } else {
      for (let attempt = 0; attempt <= MAX_GENERATION_RETRIES; attempt++) {
        if (signal.aborted) {
          markRestStopped(task, idx)
          return
        }
        const ctrl = new AbortController()
        const link = (): void => {
          if (signal.aborted) ctrl.abort()
        }
        signal.addEventListener('abort', link)
        try {
          outcome = await deps.chat(
            messages,
            writingProvider,
            () => {}, // streaming deltas are not rendered in v1 (progress panel shows status only)
            ctrl.signal,
            temperature,
            topP,
            true,
          )
        } catch (e) {
          if (signal.aborted || isAbort(e)) {
            markRestStopped(task, idx)
            return
          }
          lastError = errorMessage(e)
          outcome = null
        } finally {
          signal.removeEventListener('abort', link)
        }
        if (outcome && isGenerationSuccess(outcome)) break
        if (outcome && !isGenerationSuccess(outcome)) {
          lastError = `Incomplete generation (finishReason=${outcome.finishReason ?? 'none'}, completed=${outcome.completed}).`
        }
      }
    }

    if (!outcome || !isGenerationSuccess(outcome)) {
      // Generation failed after retries.
      chapter.status = 'failed'
      chapter.failureKind = 'generation'
      chapter.error = lastError ?? 'Generation failed.'
      deps.onUpdate(task)
      if (task.mode === 'continue') {
        markRestStopped(task, idx + 1)
        return
      }
      continue // rewrite: keep the original, move on
    }

    // Persist transactionally. On persist failure: pause the batch (both modes),
    // keep the generated text in memory for a persist-only retry.
    const body = ensureHeading(outcome.content, meta.title)
    try {
      const nextMeta = await deps.commitBatchChapter({
        worldId: task.worldId,
        chapterId: meta.id,
        file: meta.file,
        content: body,
        patch: { wordCount: wordCount(body), updatedAt: Date.now(), status: 'draft' },
      })
      textCache.set(meta.id, body)
      novel = nextMeta
      deps.applyNovel(nextMeta)
      chapter.status = 'done'
      chapter.words = wordCount(body)
      chapter.generatedText = undefined
      deps.onUpdate(task)
    } catch (e) {
      chapter.status = 'failed'
      chapter.failureKind = 'persist'
      chapter.error = errorMessage(e)
      chapter.generatedText = body
      deps.onUpdate(task)
      markRestStopped(task, idx + 1)
      return
    }
  }
}

function markRestStopped(task: BatchWriteTask, fromIndex: number): void {
  for (let k = fromIndex; k < task.chapters.length; k++) {
    const c = task.chapters[k]
    if (c.status === 'pending' || c.status === 'writing') c.status = 'stopped'
  }
}

/** Voice profile injection, mirroring AiAssistPanel.buildVoiceContext (exported there). */
function buildVoiceContextText(voice: VoiceProfile): string {
  const t = voice.traits
  return `\n\n## Author voice profile (follow these traits strictly):\n- Sentence length: ${t.sentenceLength}\n- Verb style: ${t.verbStyle}\n- Narrative distance: ${t.narrativeDistance}\n- Dialogue: ${t.dialogueStyle}\n- Rhetorical patterns: ${t.rhetoricalPatterns}\n- Notes: ${t.proseNotes}`
}
