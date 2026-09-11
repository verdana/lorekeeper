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
 * Chapter stages: prose, continuity memory, review and finalize — the part of
 * the pipeline that runs once per chapter, plus the two that close the book.
 *
 * A chapter that keeps failing is recorded and skipped rather than killing the
 * run: one broken chapter must not cost the author the rest of the book. The
 * review is non-destructive by construction — it writes findings into the review
 * queue and a report, and never touches the prose.
 */

import type { ForgeRun, ReviewQueueItem, SettingDoc } from '../../shared/types'
import {
  extractForgeProse,
  forgeCodexDigest,
  forgeDirectivesFor,
  forgeStorySoFar,
  parseForgeFindings,
} from '../../shared/forge'
import {
  formatStoryState,
  parseChapterSummaryPayload,
  rebuildStoryState,
} from '../../shared/chapterMemory'
import { storyMemoryFingerprint } from '../../shared/storyMemory'
import { countWords } from '../../shared/text'
import { PROMPTS } from '../../shared/prompts'
import { uid } from '../../shared/uid'
import * as store from '../store'
import { BUDGET, JSON_CALL_TIMEOUT, MODEL_ATTEMPTS, PROSE_CALL_TIMEOUT } from './limits'
import {
  appendLog,
  pauseBecauseWorldChanged,
  persist,
  worldStillCurrent,
  type ActiveRun,
} from './state'
import { callModel, recordStageStep } from './model-call'
import {
  buildVoiceBlock,
  chapterFileById,
  chapterPlanText,
  internalCodexDocs,
  languageDirective,
  previousChapterTail,
  serializeBeats,
  serializeConcept,
} from './context'

// ---- Stage 4: chapter prose ----

export async function stepDraft(active: ActiveRun, index: number): Promise<void> {
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

export async function stepMemory(active: ActiveRun, index: number): Promise<void> {
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

export async function stepReview(active: ActiveRun): Promise<void> {
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
    // reviewer cannot re-enter the loop forever. The findings themselves are
    // kept on the run so the author can act on one where it was reported.
    run.reviewedUpTo = drafted.length
    run.findings = findings
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

export function stepFinalize(run: ForgeRun): void {
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
