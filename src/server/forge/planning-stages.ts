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
 * Planning stages: concept → story bible → outline, plus planning the next arc
 * of a book that has outgrown its outline.
 *
 * Each returns a fatal message when the run cannot continue, or null when the
 * loop should carry on. Planning failures are fatal on purpose: nothing can be
 * drafted from a concept that does not exist, and half a story bible is worse
 * than none.
 */

import type { ForgeRun, OutlineStore } from '../../shared/types'
import {
  forgeCodexDigest,
  forgeStorySoFar,
  parseForgeCodex,
  parseForgeConcept,
  parseForgePlan,
} from '../../shared/forge'
import { PROMPTS } from '../../shared/prompts'
import { uid } from '../../shared/uid'
import * as store from '../store'
import { BUDGET, JSON_CALL_TIMEOUT } from './limits'
import {
  appendLog,
  assertExistingContentAllowed,
  fatalMessage,
  pauseBecauseWorldChanged,
  worldStillCurrent,
  type ActiveRun,
} from './state'
import { callModel } from './model-call'
import {
  assignPlan,
  forgeBriefParams,
  internalCodexDocs,
  languageDirective,
  outlineStoreFrom,
  serializeBeats,
  serializeConcept,
  settingDocId,
} from './context'

// ---- Stage 1: concept ----

export async function stepConcept(active: ActiveRun): Promise<string | null> {
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

export async function stepCodex(active: ActiveRun): Promise<string | null> {
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

export async function stepOutline(active: ActiveRun): Promise<string | null> {
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
        ...(chapter.contract ? { contract: chapter.contract } : {}),
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
export async function stepExpand(active: ActiveRun): Promise<string | null> {
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
      ...(chapter.contract ? { contract: chapter.contract } : {}),
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
        ...(chapter.contract ? { contract: chapter.contract } : {}),
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
    // The request is cleared rather than retried: a failing planner must not
    // loop, and the author can ask again once the cause is fixed.
    run.planRequest = 0
    appendLog(
      run,
      'warn',
      `Planning more chapters failed (the existing plan is untouched, ask again to retry): ${
        e instanceof Error ? e.message : String(e)
      }`,
    )
    return null
  }
}

/** The last few planned chapters, for the continuation prompt. */
function planTailText(run: ForgeRun, outline: OutlineStore, count: number): string {
  const written = new Set(
    run.chapters
      .filter((chapter) => chapter.prose === 'drafted')
      .map((chapter) => chapter.chapterId),
  )
  return outline.volumes
    .flatMap((volume) => volume.chapters)
    .slice(-count)
    .map((chapter) => {
      const state = written.has(chapter.id) ? 'written' : 'planned only'
      const beats = serializeBeats(chapter.beats)
      return [`### ${chapter.title} (${state})`, beats].filter(Boolean).join('\n')
    })
    .join('\n\n')
}
