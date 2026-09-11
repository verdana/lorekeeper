/**
 * Loading and budgeting the context a writing request receives.
 *
 * The panel drafts from the outline, the codex, the timeline, the layered story
 * memory and the preceding chapters; this hook decides what fits in the token
 * budget and which codex documents are relevant enough to include.
 */

import { useEffect, useRef, useState } from 'react'
import type { ChapterSummary, StoryMemoryStore, StoryState, TimelineEvent } from '@shared/types'
import { buildStoryMemoryContext, orderedChapters, selectStoryMemories } from '@shared/storyMemory'
import { buildMemoryLayers, type MemoryLayerLabels } from '@shared/chapterMemory'

import { useStore } from '../../store'

import { PROMPTS } from '@shared/prompts'

import { CONTEXT_BUDGET, createContextAllocator } from '../../contextBudget'
import {
  findOutlineChapter,
  serializeChapterBeats,
  serializeChapterOutline,
} from '@shared/outlineStore'

import { countGramHits, extractSignalGrams } from '../../writingStyle'

// ---- Context loading hook. ----

export interface OutlineContext {
  settings: string
  outline: string
  /** Author-written beats for the chapter being drafted (may be empty). */
  chapterBeats: string
  timeline: string
  memories: string
  memoryCount: number
  memory: string
  prevChapters: string
  loading: boolean
  truncated: boolean
}

/** Character budget for the legacy confirmed Story Memory context injection. */
const MEMORY_CONTEXT_BUDGET = Math.floor(CONTEXT_BUDGET * 0.1)

// ---- Setting-doc relevance matching (see writingStyle.ts for the n-gram helpers). ----

// Legacy panel shares: outline is the primary input for outline-write, so it
// gets the largest share; prev keeps the remainder. The layered-memory block
// (story state + chapter summaries) gets 25% so buildMemoryLayers' default
// 7500-char budget survives the allocator untouched.
const legacyAllocator = createContextAllocator({
  settings: 0.14,
  outline: 0.28,
  timeline: 0.07,
  memories: 0.08,
  memory: 0.25,
})

export function applyBudget(
  settings: string,
  outline: string,
  timeline: string,
  memories: string,
  memory: string,
  prevChapters: string,
): {
  settings: string
  outline: string
  timeline: string
  memories: string
  memory: string
  prevChapters: string
  truncated: boolean
} {
  const budgeted = legacyAllocator({
    settings,
    outline,
    timeline,
    memories,
    memory,
    prevChapters,
  })
  return {
    settings: budgeted.settings,
    outline: budgeted.outline,
    timeline: budgeted.timeline,
    memories: budgeted.memories,
    memory: budgeted.memory,
    prevChapters: budgeted.prevChapters,
    truncated: budgeted.truncated,
  }
}

export function useOutlineContext(
  chapterId: string,
  chapterTitle: string,
  content: string,
  active: boolean,
): OutlineContext {
  const novel = useStore((s) => s.novel)!
  const settingDocs = useStore((s) => s.settingDocs)
  const [settings, setSettings] = useState('')
  const [outline, setOutline] = useState('')
  const [chapterBeats, setChapterBeats] = useState('')
  const [timeline, setTimeline] = useState('')
  const [memories, setMemories] = useState('')
  const [memoryCount, setMemoryCount] = useState(0)
  const [memory, setMemory] = useState('')
  const [prevChapters, setPrevChapters] = useState('')
  const [loading, setLoading] = useState(true)
  const [truncated, setTruncated] = useState(false)

  // Refs for scene-filter signal: updated every render but excluded from
  // deps so typing in the editor doesn't trigger a full context reload.
  const chapterTitleRef = useRef(chapterTitle)
  const contentRef = useRef(content)
  chapterTitleRef.current = chapterTitle
  contentRef.current = content

  useEffect(() => {
    if (!active) return
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        // 1) Outline (loaded early; also serves as scene-filter signal).
        const outlineText = await window.api.readOutline()
        // The long outline is truncated by the context budget, which hid the
        // author's per-chapter beats (usually deep inside the 50-chapter
        // outline) from the drafter. Look the chapter up by id from the
        // structured store (no regex over the merged text): the dedicated
        // chapter-beats layer carries its beats, and the outline layer is
        // rebuilt around the current chapter (overview + its volume + its
        // beats + adjacent chapter titles) so it survives any truncation.
        const outlineStore = await window.api.readOutlineStore()
        const beatsChapter = findOutlineChapter(outlineStore, chapterId)
        const beats = beatsChapter ? serializeChapterBeats(beatsChapter) : ''
        const chapterOutline = serializeChapterOutline(outlineStore, chapterId)

        // 2) Codex settings filtered by relevance.
        //    Signal = chapter title + current prose + outline. worldview and
        //    character docs are always included (global rules; OOC is the most
        //    common continuity failure). Other docs match when the doc title
        //    appears in the signal OR ≥3 signal n-grams appear in the doc
        //    body — title-only matching silently dropped docs whose titles the
        //    outline never mentions verbatim, which read as "the AI ignored
        //    the setting".
        const relevant = new Set<string>()
        const signalText = `${chapterTitleRef.current}\n${contentRef.current}\n${outlineText}`
        const hasSignal = signalText.trim().length > 0
        for (const doc of settingDocs) {
          if (doc.category === '01-worldview' || doc.category === '11-character') {
            relevant.add(doc.id)
          } else if (hasSignal && doc.title && signalText.includes(doc.title)) {
            relevant.add(doc.id)
          }
        }
        // Body-level pass: read the remaining docs once (cached), and keep any
        // whose content shares ≥3 signal n-grams with the current scene.
        const contentCache = new Map<string, string>()
        if (hasSignal) {
          const grams = extractSignalGrams(signalText)
          if (grams.length > 0) {
            await Promise.all(
              settingDocs
                .filter((d) => !relevant.has(d.id))
                .map(async (doc) => {
                  try {
                    const { content } = await window.api.readSetting(doc.id)
                    contentCache.set(doc.id, content)
                    if (content.trim() && countGramHits(content, grams) >= 3) {
                      relevant.add(doc.id)
                    }
                  } catch {
                    // Unreadable docs must not block context loading.
                  }
                }),
            )
          }
        }
        const settingTexts: string[] = []
        for (const doc of settingDocs) {
          if (!relevant.has(doc.id)) continue
          const content = contentCache.get(doc.id) ?? (await window.api.readSetting(doc.id)).content
          if (content.trim()) settingTexts.push(`## ${doc.title}\n\n${content}`)
        }

        // 3) Timeline events and confirmed Story Memory entries.
        // Story Memory is optional context: an unreadable local memory file
        // must never block the existing drafting workflow.
        const events: TimelineEvent[] = await window.api.listTimelineEvents()
        let memoryStore: StoryMemoryStore = { version: 1, entries: [] }
        try {
          memoryStore = await window.api.readStoryMemory()
        } catch (e) {
          console.warn('[story-memory] skipped unreadable memory file:', e)
        }
        const timelineText = events
          .slice()
          .sort((a, b) => a.dateOrder - b.dateOrder)
          .map(
            (e) =>
              `- ${e.dateLabel ? `**${e.dateLabel}** ` : ''}${e.title}${e.description ? `: ${e.description}` : ''}`,
          )
          .join('\n')

        const ordered = orderedChapters(novel)
        const currentIndex = ordered.findIndex((item) => item.chapter.id === chapterId)
        const textCache = new Map<string, string>()
        const readSavedChapter = async (id: string): Promise<string> => {
          const cached = textCache.get(id)
          if (cached !== undefined) return cached
          // The active chapter may have unsaved editor changes. Use the live
          // prose for its fingerprint so outdated memories cannot leak into
          // a drafting request before the debounce save completes.
          if (id === chapterId) {
            const text = contentRef.current
            textCache.set(id, text)
            return text
          }
          const item = ordered.find((candidate) => candidate.chapter.id === id)
          if (!item) return ''
          const text = await window.api.readChapter(item.chapter.file)
          textCache.set(id, text)
          return text
        }
        const sourceIds = [...new Set(memoryStore.entries.map((entry) => entry.source.chapterId))]
        await Promise.all(sourceIds.map((id) => readSavedChapter(id)))
        const selectedMemories = selectStoryMemories({
          store: memoryStore,
          novel,
          activeChapterId: chapterId,
          sourceTexts: textCache,
          signalText,
          settingDocs,
        })
        const memoryContext = buildStoryMemoryContext(
          selectedMemories,
          events,
          MEMORY_CONTEXT_BUDGET,
        )

        // 4) Previous chapters before the active chapter in flattened reading order.
        // Keep each chapter's ENDING (the state the next chapter continues from),
        // not its opening; the allocator's tail-first truncation then preserves
        // the closest chapters' closing scenes.
        const chapterSnippets: string[] = []
        for (const item of ordered.slice(0, Math.max(0, currentIndex))) {
          const text = await readSavedChapter(item.chapter.id)
          if (text.trim()) {
            chapterSnippets.push(
              `### ${item.chapter.title}\n\n${text.length > 800 ? '…' : ''}${text.slice(-800)}`,
            )
          }
        }

        // 5) Layered memory: current story state (hard constraints) + chapter
        //    summaries (recent full, distant condensed). Like Story Memory,
        //    this is optional context — unreadable files must not block the
        //    existing drafting workflow.
        const memoryLabels = PROMPTS.assist.memory as MemoryLayerLabels
        let summaryList: ChapterSummary[] = []
        let storyState: StoryState = {
          version: 1,
          upToChapterId: null,
          updatedAt: 0,
          characters: [],
          worldState: [],
          openThreads: [],
          currentEndState: '',
        }
        try {
          summaryList = await window.api.listChapterSummaries()
          storyState = await window.api.readStoryState()
        } catch (e) {
          console.warn('[chapter-memory] skipped unreadable memory data:', e)
        }
        // Fingerprint cache: summaries whose source prose changed count as stale.
        const summarySourceIds = summaryList.map((s) => s.chapterId)
        await Promise.all(summarySourceIds.map((id) => readSavedChapter(id)))
        const layers = buildMemoryLayers(summaryList, storyState, novel, chapterId, memoryLabels, {
          sourceTexts: textCache,
        })
        const rawMemory = [
          layers.stateText ? memoryLabels.stateHint : '',
          layers.stateText,
          layers.recentText,
          layers.distantText,
        ]
          .filter(Boolean)
          .join('\n\n')

        if (!cancelled) {
          const rawSettings = settingTexts.join('\n\n---\n\n')
          const rawOutline = chapterOutline
          const rawTimeline = timelineText
          const rawMemories = memoryContext.text
          const rawPrev = chapterSnippets.join('\n\n')
          const trimmed = applyBudget(
            rawSettings,
            rawOutline,
            rawTimeline,
            rawMemories,
            rawMemory,
            rawPrev,
          )
          setSettings(trimmed.settings)
          setOutline(trimmed.outline)
          setChapterBeats(beats)
          setTimeline(trimmed.timeline)
          setMemories(trimmed.memories)
          setMemoryCount(memoryContext.count)
          setMemory(trimmed.memory)
          setPrevChapters(trimmed.prevChapters)
          setTruncated(trimmed.truncated || memoryContext.truncated || layers.truncated)
        }
      } catch {
        // Loading failure does not block the panel.
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [active, chapterId, novel, settingDocs])

  return {
    settings,
    outline,
    chapterBeats,
    timeline,
    memories,
    memoryCount,
    memory,
    prevChapters,
    loading,
    truncated,
  }
}
