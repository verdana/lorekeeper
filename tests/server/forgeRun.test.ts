import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  ensureWorldSkeleton,
  forgeRunFile,
  initPaths,
  setCurrentWorldId,
} from '../../src/server/paths'
import * as store from '../../src/server/store'
import {
  cancelForgeRun,
  discardForgeRun,
  forgeExtendPlan,
  forgeMoreChapters,
  pauseForgeRun,
  readForgeRun,
  redraftForgeChapter,
  resumeForgeRun,
  startForgeRun,
  writeForgeDirectives,
} from '../../src/server/forge'
import type {
  ChatMessage,
  ForgeBrief,
  ForgeRun,
  GenerationTokenUsage,
} from '../../src/shared/types'

let dataRoot = ''
const worldId = 'w_forge_test'

// ---- Stub provider -----------------------------------------------------------

interface StubOptions {
  /**
   * Fail every attempt to draft the chapter whose prompt contains this text.
   * Use a unique per-chapter marker (a beat's summary), because prompts are
   * pack-language dependent and neighbour titles appear in the prompt too.
   */
  failChapterMarker?: string
  /** Record every system prompt the pipeline sent. */
  seen?: string[]
  /** Record every message list the pipeline sent, for prompt assertions. */
  record?: ChatMessage[][]
}

const CHAPTERS = [
  { title: 'Chapter 1: Ash', beats: [{ title: 'Arrival', summary: 'She arrives in the city.' }] },
  { title: 'Chapter 2: Debt', beats: [{ title: 'Ledger', summary: 'The ledger names her.' }] },
  { title: 'Chapter 3: Storm', beats: [{ title: 'Break', summary: 'She burns the ledger.' }] },
]

/** A stub model that answers each stage in its expected shape. */
function stubChat(options: StubOptions = {}) {
  const answer = async (messages: ChatMessage[]): Promise<string> => {
    const system = messages.find((m) => m.role === 'system')?.content ?? ''
    const user = messages.find((m) => m.role === 'user')?.content ?? ''
    const all = `${system}\n${user}`
    options.seen?.push(system.slice(0, 60))
    options.record?.push(messages.map((message) => ({ ...message })))

    if (all.includes('"issues"')) {
      return JSON.stringify({
        issues: [
          {
            severity: 'critical',
            chapterTitle: 'Chapter 2: Debt',
            text: 'The ledger burns twice.',
            relatedDocTitles: ['Ilyra'],
          },
        ],
      })
    }
    if (all.includes('"stateChanges"')) {
      return JSON.stringify({
        summary: 'She learns the ledger is real.',
        endState: 'Night, the archive, alone.',
        stateChanges: [
          { entity: 'Ilyra', aspect: 'location', change: 'In the archive', permanent: false },
          {
            entity: 'Ilyra',
            aspect: 'knowledge',
            change: 'Learned the ledger is forged.',
            permanent: false,
          },
        ],
        plantedThreads: ['the missing page'],
        resolvedThreads: [],
      })
    }
    if (all.includes('"volumes"')) {
      return JSON.stringify({
        volumes: [{ title: 'Volume One', summary: 'The debt comes due.', chapters: CHAPTERS }],
      })
    }
    if (all.includes('"chapters"')) {
      // The continuation prompt asks for a flat chapter list.
      return JSON.stringify({
        chapters: [
          { title: 'Chapter 4: Storm', beats: [{ title: 'Break', summary: 'She burns it.' }] },
          { title: 'Chapter 5: Ash', beats: [{ title: 'Fallout', summary: 'The city reacts.' }] },
          { title: 'Chapter 6: Debt', beats: [{ title: 'Ledger', summary: 'It comes due.' }] },
        ],
      })
    }
    if (all.includes('"docs"')) {
      return JSON.stringify({
        docs: [
          {
            category: '01-worldview',
            title: 'The City',
            content: '# The City\n\nMemories are currency.',
          },
          {
            category: '11-character',
            title: 'Ilyra',
            content: '# Ilyra\n\nA broker with no past.',
          },
        ],
      })
    }
    if (all.includes('【正文】')) {
      if (options.failChapterMarker && all.includes(options.failChapterMarker)) {
        throw new Error('provider exploded')
      }
      return [
        '【节点落地清单】',
        '1. Arrival → opening scene',
        '',
        '【正文】',
        '',
        `The rain had been falling since the border, and Ilyra had stopped counting the days. `.repeat(
          6,
        ),
      ].join('\n')
    }
    return JSON.stringify({
      title: 'Ashes of the Accord',
      genre: 'Fantasy',
      logline: 'A memory broker buys back the past she sold.',
      synopsis: 'A synopsis of the whole book.',
      themes: ['memory', 'debt'],
      tone: 'dark and literary',
      pov: 'third-person limited',
      styleGuide: 'Short sentences. Concrete nouns.',
      cast: [{ name: 'Ilyra', role: 'protagonist', description: 'A broker with no past.' }],
      worldNotes: 'Memories are currency.',
    })
  }
  // The engine accepts an answer with or without provider usage.
  return async (messages: ChatMessage[]): Promise<{ content: string }> => ({
    content: await answer(messages),
  })
}

/** A stub that reports the usage block a real provider sends. */
function stubChatWithUsage(): (
  messages: ChatMessage[],
) => Promise<{ content: string; usage: GenerationTokenUsage }> {
  const inner = stubChat()
  return async (messages) => ({
    ...(await inner(messages)),
    usage: { source: 'reported', inputTokens: 12, outputTokens: 34, totalTokens: 46 },
  })
}

const brief = (overrides: Partial<ForgeBrief> = {}): ForgeBrief => ({
  theme: 'A city where memories are sold, and the broker who sold her own.',
  genre: 'Fantasy',
  tone: 'dark',
  language: 'en',
  pov: 'third-person limited',
  chapters: 3,
  wordsPerChapter: 500,
  constraints: '',
  providerId: null,
  scope: 'draft',
  draftCount: 0,
  replaceExisting: false,
  ...overrides,
})

const proseOf = (run: ForgeRun, index: number): string => {
  const meta = store.getNovelMeta()
  const files = meta.volumes.flatMap((v) => v.chapters)
  const chapter = run.chapters[index]
  const file = files.find((c) => c.id === chapter.chapterId)
  return file ? store.readChapter(file.file) : ''
}

beforeAll(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'lorekeeper-forge-'))
  process.env.ORBIT_DATA_DIR = dataRoot
  initPaths()
  ensureWorldSkeleton(worldId)
  setCurrentWorldId(worldId)
  writeFileSync(
    join(dataRoot, 'worlds', worldId, 'novel.json'),
    JSON.stringify(
      { title: 'Forge Test', author: '', synopsis: '', tags: [], volumes: [] },
      null,
      2,
    ),
  )
})

afterAll(() => {
  rmSync(dataRoot, { recursive: true, force: true })
})

beforeEach(() => {
  // Each test starts from a clean world: no run record, no codex, no prose.
  discardForgeRun()
  rmSync(join(dataRoot, 'worlds', worldId, 'settings'), { recursive: true, force: true })
  rmSync(join(dataRoot, 'worlds', worldId, 'chapters'), { recursive: true, force: true })
  rmSync(join(dataRoot, 'worlds', worldId, 'outline'), { recursive: true, force: true })
  rmSync(join(dataRoot, 'worlds', worldId, 'chapter-memory'), { recursive: true, force: true })
  rmSync(join(dataRoot, 'worlds', worldId, 'review-queue.json'), { force: true })
  ensureWorldSkeleton(worldId)
  store.saveNovelMeta({ title: 'Forge Test', author: '', synopsis: '', tags: [], volumes: [] })
})

describe('startForgeRun', () => {
  it('refuses an empty theme', async () => {
    await expect(
      startForgeRun({ ...brief(), theme: '   ' }, { chat: stubChat(), awaitCompletion: true }),
    ).rejects.toThrow(/Enter a theme/)
  })
})

describe('evidence quality', () => {
  it('records provider-reported usage and estimates only what was not reported', async () => {
    const reported = await startForgeRun(brief({ scope: 'plan' }), {
      chat: stubChatWithUsage(),
      awaitCompletion: true,
    })
    // 3 planning calls, each reporting 12 in / 34 out.
    expect(reported.totals.inputTokens).toBe(36)
    expect(reported.totals.outputTokens).toBe(102)
    expect(reported.steps.every((step) => step.usage.source !== 'estimated')).toBe(true)

    discardForgeRun()
    const estimated = await startForgeRun(brief({ scope: 'plan' }), {
      chat: stubChat(),
      awaitCompletion: true,
    })
    expect(estimated.totals.inputTokens).toBeGreaterThan(0)
    expect(
      estimated.steps.filter((step) => step.usage.source === 'estimated').length,
    ).toBeGreaterThan(0)
  })
})

describe('a full forge run', () => {
  it('writes codex, outline, chapters, memory and review findings', async () => {
    const run = await startForgeRun(brief(), { chat: stubChat(), awaitCompletion: true })

    expect(run.status).toBe('completed')
    expect(run.phase).toBe('done')
    expect(run.concept?.title).toBe('Ashes of the Accord')

    // Story bible
    const docs = store.listSettings()
    const titles = docs.map((d) => d.title).sort()
    expect(titles).toEqual(['Ilyra', 'The City'])

    // Outline + manuscript structure
    const outline = store.readOutlineStore()
    expect(outline.volumes).toHaveLength(1)
    expect(outline.volumes[0].chapters).toHaveLength(3)
    expect(outline.overview).toContain('Ashes of the Accord')
    const meta = store.getNovelMeta()
    expect(meta.title).toBe('Ashes of the Accord')
    expect(meta.synopsis).toContain('synopsis')
    expect(meta.volumes[0].chapters).toHaveLength(3)
    expect(meta.volumes[0].chapters.every((c) => c.wordCount > 0)).toBe(true)

    // Prose landed in the chapter files, without the node-landing list.
    for (let i = 0; i < 3; i += 1) {
      const prose = proseOf(run, i)
      expect(prose).toContain('The rain had been falling')
      expect(prose).not.toContain('节点落地清单')
      expect(prose).not.toContain('【正文】')
      expect(prose.startsWith('# Chapter')).toBe(true)
    }
    expect(run.chapters.every((c) => c.prose === 'drafted')).toBe(true)
    expect(run.chapters.every((c) => c.memory === 'done')).toBe(true)

    // Continuity memory feeds the rest of the app: one summary per chapter, and
    // a story-state archive rebuilt from them.
    const summaries = store.listChapterSummaries()
    expect(summaries.map((s) => s.chapterId).sort()).toEqual(
      run.chapters.map((c) => c.chapterId).sort(),
    )
    const state = store.readStoryState()
    expect(run.chapters.some((c) => c.chapterId === state.upToChapterId)).toBe(true)
    expect(state.characters.find((c) => c.name === 'Ilyra')?.location).toBe('In the archive')
    // Knowledge is a state dimension of its own, so "who knows what" survives
    // the chapter it was established in.
    expect(state.characters.find((c) => c.name === 'Ilyra')?.knows).toBe(
      'Learned the ledger is forged.',
    )

    // Review findings became actionable queue items and a saved report.
    const queue = store.readReviewQueue()
    expect(queue.items).toHaveLength(1)
    expect(queue.items[0].severity).toBe('critical')
    expect(queue.items[0].text).toContain('[Chapter 2: Debt]')
    expect(queue.items[0].relatedDocIds).toContain('11-character/Ilyra.md')
    expect(store.listConsistencyReports()).toHaveLength(1)

    // Evidence: one step per model call plus finalize, with usage recorded.
    const kinds = run.steps.map((s) => s.kind)
    expect(kinds).toEqual([
      'concept',
      'codex',
      'outline',
      'draft',
      'memory',
      'draft',
      'memory',
      'draft',
      'memory',
      'review',
      'finalize',
    ])
    expect(run.totals.modelCalls).toBe(10)
    expect(run.totals.inputTokens).toBeGreaterThan(0)
    expect(run.steps[0].output).toContain('Ashes of the Accord')
  })

  it('stops after the outline in plan-only mode', async () => {
    const run = await startForgeRun(brief({ scope: 'plan' }), {
      chat: stubChat(),
      awaitCompletion: true,
    })
    expect(run.status).toBe('completed')
    expect(run.chapters).toHaveLength(3)
    expect(run.chapters.every((c) => c.prose === 'pending')).toBe(true)
    expect(run.steps.some((s) => s.kind === 'draft')).toBe(false)
    expect(store.listSettings().length).toBeGreaterThan(0)
    // Chapter files stay placeholders, so no prose was invented.
    expect(proseOf(run, 0).length).toBeLessThan(100)
  })

  it('drafts only the requested number of chapters', async () => {
    const run = await startForgeRun(brief({ draftCount: 1 }), {
      chat: stubChat(),
      awaitCompletion: true,
    })
    expect(run.status).toBe('completed')
    expect(run.chapters[0].prose).toBe('drafted')
    expect(run.chapters[1].prose).toBe('pending')
    expect(run.steps.filter((s) => s.kind === 'draft')).toHaveLength(1)
    // Nothing to review with a single chapter? It is still reviewed.
    expect(run.steps.some((s) => s.kind === 'review')).toBe(true)
  })
})

describe('failure handling', () => {
  it('skips a chapter that keeps failing, and resumes it later', async () => {
    const run = await startForgeRun(brief(), {
      chat: stubChat({ failChapterMarker: 'The ledger names her.' }),
      awaitCompletion: true,
    })

    // The book still finished; the failed chapter is recorded, not lost.
    expect(run.status).toBe('completed')
    expect(run.chapters[1].prose).toBe('failed')
    expect(run.chapters[1].error).toContain('provider exploded')
    expect(run.chapters[0].prose).toBe('drafted')
    expect(run.chapters[2].prose).toBe('drafted')
    expect(store.listChapterSummaries()).toHaveLength(2)
    expect(run.log.some((entry) => entry.level === 'error')).toBe(true)

    // A completed run with a failed chapter is resumable, and the retry works.
    const resumed = await resumeForgeRun({ chat: stubChat(), awaitCompletion: true })
    expect(resumed?.chapters[1].prose).toBe('drafted')
    expect(store.listChapterSummaries()).toHaveLength(3)
  })

  it('fails the run when a planning stage fails, and can resume from there', async () => {
    let calls = 0
    const inner = stubChat()
    const failing = async (messages: ChatMessage[]): Promise<{ content: string }> => {
      const all = messages.map((m) => m.content).join('\n')
      calls += 1
      if (all.includes('"docs"')) throw new Error('codex stage is down')
      return inner(messages)
    }

    const run = await startForgeRun(brief(), { chat: failing, awaitCompletion: true })
    expect(run.status).toBe('failed')
    expect(run.error).toContain('codex stage is down')
    expect(run.concept?.title).toBe('Ashes of the Accord')
    expect(calls).toBeGreaterThan(0)

    const resumed = await resumeForgeRun({ chat: stubChat(), awaitCompletion: true })
    expect(resumed?.status).toBe('completed')
    expect(resumed?.chapters).toHaveLength(3)
  })
})

describe('run lifecycle', () => {
  it('persists the run so a fresh read sees it, and marks it interrupted', async () => {
    // A run left `running` on disk (the server died) reads back as paused.
    const stale: ForgeRun = {
      version: 1,
      id: 'fr_stale',
      worldId,
      worldTitle: 'Forge Test',
      brief: brief(),
      status: 'running',
      phase: 'concept',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      finishedAt: null,
      concept: null,
      chapters: [],
      direction: [],
      reviewedUpTo: 0,
      planRequest: 0,
      steps: [
        {
          id: 's1',
          kind: 'concept',
          label: 'Story concept',
          chapterId: null,
          status: 'running',
          startedAt: Date.now(),
          durationMs: null,
          providerName: 'p',
          model: 'm',
          inputChars: 1,
          outputChars: 0,
          usage: {
            source: 'unavailable',
            inputTokens: null,
            outputTokens: null,
            totalTokens: null,
          },
          error: null,
          output: '',
        },
      ],
      log: [],
      totals: { modelCalls: 0, inputTokens: 0, outputTokens: 0, durationMs: 0, words: 0 },
      error: null,
    }
    writeFileSync(forgeRunFile(), JSON.stringify(stale))

    const read = readForgeRun()
    expect(read?.status).toBe('paused')
    expect(read?.steps[0].status).toBe('failed')
    expect(read?.log.some((entry) => entry.message.includes('interrupted'))).toBe(true)
    expect(existsSync(forgeRunFile())).toBe(true)
  })

  it('pauses and cancels a run, and refuses a second run over an unfinished one', async () => {
    // A run held open by a gate, so the loop is mid-call while we control it.
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const inner = stubChat()
    const slowChat = async (messages: ChatMessage[]): Promise<{ content: string }> => {
      await gate
      return inner(messages)
    }

    const started = await startForgeRun(brief(), { chat: slowChat })
    try {
      expect(started.status).toBe('running')
      // A second run cannot start while the first is unfinished.
      await expect(startForgeRun(brief(), { chat: stubChat() })).rejects.toThrow(/already/)
      const paused = pauseForgeRun()
      expect(paused?.status).toBe('paused')
    } finally {
      release()
    }

    // Let the in-flight call settle, then confirm the loop stopped for good.
    await new Promise((resolve) => setTimeout(resolve, 50))
    const afterPause = readForgeRun()
    expect(afterPause?.status).toBe('paused')
    const stepsAfterPause = afterPause?.steps.length ?? 0
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(readForgeRun()?.steps.length).toBe(stepsAfterPause)

    const cancelled = cancelForgeRun()
    expect(cancelled?.status).toBe('cancelled')

    discardForgeRun()
    expect(readForgeRun()).toBeNull()
  })

  it('refuses to start over a run left unfinished on disk', async () => {
    // A paused run on disk (no live loop) still blocks a fresh start.
    await startForgeRun(brief(), {
      chat: stubChat({ failChapterMarker: 'She arrives in the city.' }),
      awaitCompletion: true,
    })
    const finished = readForgeRun()
    expect(finished).not.toBeNull()
    writeFileSync(forgeRunFile(), JSON.stringify({ ...finished, status: 'paused' }))

    await expect(
      startForgeRun(brief({ replaceExisting: true }), { chat: stubChat() }),
    ).rejects.toThrow(/unfinished forge run/)
  })

  it('refuses to forge over existing prose unless replacement is allowed', async () => {
    await startForgeRun(brief(), { chat: stubChat(), awaitCompletion: true })
    discardForgeRun()

    await expect(
      startForgeRun(brief(), { chat: stubChat(), awaitCompletion: true }),
    ).rejects.toThrow(/already has 3 chapters/)

    const replaced = await startForgeRun(brief({ replaceExisting: true }), {
      chat: stubChat(),
      awaitCompletion: true,
    })
    expect(replaced.status).toBe('completed')
    expect(replaced.chapters).toHaveLength(3)
  })
})

describe('author steering', () => {
  const promptFor = (record: ChatMessage[][], marker: string): string =>
    record
      .map((messages) => messages.map((m) => m.content).join('\n'))
      .filter((text) => text.includes('【正文】') && text.includes(marker))
      .join('\n---\n')

  it('applies a direction to every chapter it covers', async () => {
    const record: ChatMessage[][] = []
    // Plan only, so nothing is drafted yet.
    await startForgeRun(brief({ scope: 'plan' }), {
      chat: stubChat({ record }),
      awaitCompletion: true,
    })
    discardForgeRun()

    const planned = await startForgeRun(brief({ scope: 'plan' }), {
      chat: stubChat({ record }),
      awaitCompletion: true,
    })
    writeForgeDirectives([
      { id: 'd1', text: 'No romance, ever.', fromOrder: 1, onlyOrder: null, createdAt: Date.now() },
      { id: 'd2', text: 'Only chapter three.', fromOrder: 3, onlyOrder: 3, createdAt: Date.now() },
    ])

    const continued = forgeMoreChapters(2, { chat: stubChat({ record }) })
    expect(continued?.status).toBe('running')
    await new Promise((resolve) => setTimeout(resolve, 50))
    for (let i = 0; i < 80; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      const current = readForgeRun()
      if (current && current.status !== 'running') break
    }

    const finished = readForgeRun()
    expect(finished?.chapters[0].prose).toBe('drafted')
    expect(finished?.chapters[1].prose).toBe('drafted')
    expect(finished?.chapters[2].prose).toBe('pending')

    // The standing direction reached both drafted chapters...
    expect(promptFor(record, 'Arrival')).toContain('No romance, ever.')
    expect(promptFor(record, 'Ledger')).toContain('No romance, ever.')
    // ...and the chapter-only one reached neither of them.
    expect(promptFor(record, 'Arrival')).not.toContain('Only chapter three.')
    expect(promptFor(record, 'Ledger')).not.toContain('Only chapter three.')
    expect(planned.chapters).toHaveLength(3)
  })

  it('writes one chapter again under a new instruction', async () => {
    const record: ChatMessage[][] = []
    await startForgeRun(brief({ draftCount: 2 }), {
      chat: stubChat({ record }),
      awaitCompletion: true,
    })
    const before = readForgeRun()
    const target = before!.chapters[1]
    expect(target.prose).toBe('drafted')

    const restarted = redraftForgeChapter(
      { chapterId: target.chapterId, instruction: 'Much faster.' },
      { chat: stubChat({ record }) },
    )
    expect(restarted?.status).toBe('running')
    expect(restarted?.chapters[1].prose).toBe('pending')

    for (let i = 0; i < 80; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      const current = readForgeRun()
      if (current && current.status !== 'running') break
    }

    const after = readForgeRun()
    expect(after?.chapters[1].prose).toBe('drafted')
    expect(after?.chapters[1].words).toBeGreaterThan(0)
    // The instruction is a chapter-only direction, and it reached the prompt.
    const directive = after?.direction.find((d) => d.onlyOrder === 2)
    expect(directive?.text).toBe('Much faster.')
    expect(promptFor(record, 'Ledger')).toContain('Much faster.')
    // The chapter before it was not written again.
    expect(after?.steps.filter((step) => step.kind === 'draft')).toHaveLength(3)
  })

  it('plans the next arc and drafts it', async () => {
    // A three-chapter plan of which the first two are written.
    const first = await startForgeRun(brief({ draftCount: 2 }), {
      chat: stubChat(),
      awaitCompletion: true,
    })
    expect(first.status).toBe('completed')
    expect(first.chapters).toHaveLength(3)
    expect(first.chapters.filter((c) => c.prose === 'drafted')).toHaveLength(2)

    const extending = forgeExtendPlan(3, { chat: stubChat() })
    expect(extending?.status).toBe('running')

    for (let i = 0; i < 120; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      const current = readForgeRun()
      if (current && current.status !== 'running') break
    }

    const after = readForgeRun()
    expect(after?.status).toBe('completed')
    // Three planned + three new, in order, with the original ids untouched.
    expect(after?.chapters).toHaveLength(6)
    expect(after?.chapters.slice(0, 3).map((c) => c.chapterId)).toEqual(
      first.chapters.map((c) => c.chapterId),
    )
    // The new chapters are drafted, and so is the planned chapter the limited
    // run had left out; the sixth is past the (grown) draft limit.
    expect(after?.chapters.slice(0, 5).every((c) => c.prose === 'drafted')).toBe(true)
    expect(after?.chapters[5].prose).toBe('pending')
    expect(after?.planRequest).toBe(0)

    // The outline on disk gained the chapters, and novel.json mirrors them.
    expect(store.readOutlineStore().volumes[0].chapters).toHaveLength(6)
    expect(store.getNovelMeta().volumes[0].chapters).toHaveLength(6)

    // The continuation prompt ran, and the review looked at the new chapters.
    expect(after?.steps.some((step) => step.label.includes('Continue the plan'))).toBe(true)
    expect(after?.steps.filter((step) => step.kind === 'review')).toHaveLength(2)
  })

  it('feeds what a character learned into the next chapter prompt', async () => {
    const record: ChatMessage[][] = []
    await startForgeRun(brief({ draftCount: 2 }), {
      chat: stubChat({ record }),
      awaitCompletion: true,
    })

    const chapterTwo = record
      .map((messages) => messages.map((m) => m.content).join('\n'))
      .filter((text) => text.includes('【正文】') && text.includes('Ledger'))
      .join('\n---\n')
    // Chapter 1 established that she learned the ledger is forged; chapter 2
    // must be drafted knowing it (the label comes from the active prompt pack,
    // so the assertion is on the fact itself).
    expect(chapterTwo).toContain('Learned the ledger is forged.')
    expect(chapterTwo).toContain('In the archive')
  })

  it('keeps an author edit made while the run is live', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const inner = stubChat()
    const slowChat = async (messages: ChatMessage[]): Promise<{ content: string }> => {
      await gate
      return inner(messages)
    }

    await startForgeRun(brief(), { chat: slowChat })
    writeForgeDirectives([
      {
        id: 'd1',
        text: 'Written while running.',
        fromOrder: 1,
        onlyOrder: null,
        createdAt: Date.now(),
      },
    ])
    expect(readForgeRun()?.direction).toHaveLength(1)
    release()

    for (let i = 0; i < 80; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      const current = readForgeRun()
      if (current && current.status !== 'running') break
    }
    // The loop's own writes must not have dropped the author's edit.
    expect(readForgeRun()?.direction.map((d) => d.text)).toEqual(['Written while running.'])
  })
})
