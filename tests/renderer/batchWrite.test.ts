import { describe, expect, it, vi, beforeEach } from 'vitest'

// batchWrite.ts imports renderer lib/api which pull in browser-only deps; stub
// them so the engine and pure helpers are testable under node.
vi.mock('../../src/renderer/src/lib', () => ({
  uid: (prefix = '') => `${prefix}id_${Math.random().toString(36).slice(2, 8)}`,
  wordCount: (text: string) => text.length,
}))
vi.mock('../../src/renderer/src/api', () => ({ chatStream: vi.fn() }))

import {
  CONTEXT_BUDGET,
  buildBatchMessages,
  createContextAllocator,
  deleteEmptyChapter,
  ensureHeading,
  isGenerationSuccess,
  isNearCopy,
  planContinueChapters,
  resumeBatch,
  runBatchWrite,
  type BatchChapterState,
  type BatchWriteDeps,
  type BatchWriteTask,
} from '../../src/renderer/src/batchWrite'
import { PROMPTS } from '../../src/shared/prompts'
import type { NovelMeta, Volume } from '../../src/shared/types'

// ---- fixtures ----

const baseNovel = (): NovelMeta => ({
  title: 'T',
  author: '',
  synopsis: '',
  tags: [],
  volumes: [
    {
      id: 'v1',
      title: 'Volume 1',
      order: 0,
      chapters: [
        {
          id: 'c1',
          volumeId: 'v1',
          title: 'Chapter 1',
          order: 0,
          file: 'v1_a.md',
          wordCount: 5,
          status: 'draft',
          updatedAt: 1,
        },
      ],
    },
  ],
})

const makeTask = (overrides: Partial<BatchWriteTask> = {}): BatchWriteTask => ({
  id: 'bw_1',
  worldId: 'w1',
  worldName: 'W',
  mode: 'continue',
  count: 2,
  discussionSessionId: undefined,
  useVoice: false,
  direction: '',
  status: 'preparing',
  chapters: [],
  currentIndex: 0,
  startedAt: 1,
  ...overrides,
})

interface DepsCalls {
  commit: unknown[]
  snapshot: string[]
  saveNovel: number
  chat: number
  flush: number
}

interface TestEnv {
  stopNow: boolean
  controller: AbortController | null
}

const makeDeps = (
  overrides: Partial<BatchWriteDeps> = {},
): { deps: BatchWriteDeps; calls: DepsCalls; env: TestEnv } => {
  const calls: DepsCalls = { commit: [], snapshot: [], saveNovel: 0, chat: 0, flush: 0 }
  const env: TestEnv = { stopNow: false, controller: null }
  let novel = baseNovel()
  const deps: BatchWriteDeps = {
    getNovel: () => novel,
    getConfig: () => null,
    getSettingDocs: () => [],
    getVoiceProfile: () => null,
    readSetting: async () => '',
    readOutline: async () => '',
    listTimelineEvents: async () => [],
    readStoryMemory: async () => ({ version: 1, entries: [] }),
    readChapter: async () => '',
    listDiscussions: async () => [],
    saveNovel: async (m) => {
      calls.saveNovel++
      novel = m
    },
    forceSnapshot: async (p) => {
      calls.snapshot.push(p)
      return {}
    },
    commitBatchChapter: async (input) => {
      calls.commit.push(input)
      const current = deps.getNovel()
      novel = {
        ...current,
        volumes: current.volumes.map((v) => ({
          ...v,
          chapters: v.chapters.map((c) =>
            c.id === input.chapterId
              ? { ...c, wordCount: input.patch.wordCount, updatedAt: input.patch.updatedAt }
              : c,
          ),
        })),
      }
      return novel
    },
    removeBatchChapter: async (_wid, cid) => {
      const current = deps.getNovel()
      novel = {
        ...current,
        volumes: current.volumes.map((v) => ({
          ...v,
          chapters: v.chapters.filter((c) => c.id !== cid),
        })),
      }
      return novel
    },
    chat: async (_messages, _pid, _onChunk, signal) => {
      calls.chat++
      if (env.stopNow || signal?.aborted) throw new DOMException('aborted', 'AbortError')
      return {
        content: `# Generated ${calls.chat}\n\nBody text ${calls.chat}`,
        reasoning: '',
        finishReason: 'stop',
        completed: true,
      }
    },
    flushOrThrow: async () => {
      calls.flush++
    },
    onUpdate: () => {},
    applyNovel: (m) => {
      novel = m
    },
    registerAbort: (c) => {
      env.controller = c
    },
    ...overrides,
  }
  return { deps, calls, env }
}

// ---- ensureHeading ----

describe('ensureHeading', () => {
  it('replaces a wrong first H1', () => {
    expect(ensureHeading('# Wrong Title\n\nbody', 'Right')).toBe('# Right\n\nbody')
  })
  it('prepends when no H1 exists', () => {
    expect(ensureHeading('body text', 'Right')).toBe('# Right\n\nbody text')
  })
  it('strips BOM and leading whitespace before matching', () => {
    expect(ensureHeading('\uFEFF   # Wrong\nbody', 'Right')).toBe('# Right\nbody')
  })
  it('keeps an existing matching H1', () => {
    expect(ensureHeading('# Right\n\nbody', 'Right')).toBe('# Right\n\nbody')
  })
})

// ---- isGenerationSuccess ----

describe('isGenerationSuccess', () => {
  it('accepts only completed + whitelisted reason + non-empty body', () => {
    expect(isGenerationSuccess({ content: 'x', finishReason: 'stop', completed: true })).toBe(true)
    expect(isGenerationSuccess({ content: 'x', finishReason: 'length', completed: true })).toBe(
      false,
    )
    expect(
      isGenerationSuccess({ content: 'x', finishReason: 'content_filter', completed: true }),
    ).toBe(false)
    expect(isGenerationSuccess({ content: 'x', finishReason: 'tool_calls', completed: true })).toBe(
      false,
    )
    expect(isGenerationSuccess({ content: 'x', finishReason: null, completed: true })).toBe(false)
    expect(isGenerationSuccess({ content: 'x', finishReason: 'stop', completed: false })).toBe(
      false,
    )
    expect(isGenerationSuccess({ content: '  ', finishReason: 'stop', completed: true })).toBe(
      false,
    )
  })
})

describe('isNearCopy', () => {
  it('detects a near-identical chapter while tolerating headings and whitespace', () => {
    const body = 'The river ran black beneath the bridge. '.repeat(20)
    expect(isNearCopy(body, `# Chapter 1\n\n${body.replace('river', 'water')}`)).toBe(true)
  })

  it('does not reject a substantially rewritten chapter', () => {
    const source = 'The river ran black beneath the bridge. '.repeat(20)
    const rewrite = 'Mara burned the bridge at dawn and confessed to the guard. '.repeat(20)
    expect(isNearCopy(source, rewrite)).toBe(false)
  })
})

// ---- createContextAllocator ----

describe('createContextAllocator', () => {
  const long = 'x'.repeat(CONTEXT_BUDGET + 1000)
  it('returns everything unchanged within budget', () => {
    const a = createContextAllocator({ settings: 0.3, outline: 0.1, timeline: 0.1, memories: 0.25 })
    const out = a({ settings: 's', outline: 'o', timeline: 't', memories: 'm', prevChapters: 'p' })
    expect(out).toMatchObject({
      settings: 's',
      outline: 'o',
      timeline: 't',
      memories: 'm',
      prevChapters: 'p',
      truncated: false,
    })
  })
  it('keeps legacy shares identical to the old applyBudget behavior', () => {
    const a = createContextAllocator({ settings: 0.3, outline: 0.1, timeline: 0.1, memories: 0.25 })
    const out = a({
      settings: long,
      outline: long,
      timeline: long,
      memories: long,
      prevChapters: long,
    })
    expect(out.truncated).toBe(true)
    expect(out.settings.length).toBe(Math.floor(CONTEXT_BUDGET * 0.3))
    expect(out.outline.length).toBe(Math.floor(CONTEXT_BUDGET * 0.1))
    expect(out.timeline.length).toBe(Math.floor(CONTEXT_BUDGET * 0.1))
    expect(out.memories.length).toBe(Math.floor(CONTEXT_BUDGET * 0.25))
    // prev gets the remainder, taken from the end.
    const used =
      Math.floor(CONTEXT_BUDGET * 0.3) +
      Math.floor(CONTEXT_BUDGET * 0.1) +
      Math.floor(CONTEXT_BUDGET * 0.1) +
      Math.floor(CONTEXT_BUDGET * 0.25)
    expect(out.prevChapters).toBe(long.slice(-(CONTEXT_BUDGET - used)))
  })
  it('carves out a discussion share when configured', () => {
    const a = createContextAllocator({
      settings: 0.3,
      outline: 0.1,
      timeline: 0.1,
      memories: 0.25,
      discussion: 0.1,
    })
    const out = a({
      settings: long,
      outline: long,
      timeline: long,
      memories: long,
      discussion: long,
      prevChapters: long,
    })
    expect(out.discussion!.length).toBe(Math.floor(CONTEXT_BUDGET * 0.1))
    expect(out.prevChapters.length).toBeLessThan(long.length)
    expect(out.truncated).toBe(true)
  })
})

// ---- planContinueChapters ----

describe('planContinueChapters', () => {
  it('appends to the last volume with frozen baseCount numbering', () => {
    const novel = baseNovel()
    const plan = planContinueChapters(novel, 2)
    expect(plan.createdVolume).toBe(false)
    expect(plan.chapters).toHaveLength(2)
    expect(plan.chapters[0].title).toBe('Chapter 2')
    expect(plan.chapters[1].title).toBe('Chapter 3')
    expect(plan.chapters[0].order).toBe(1)
    expect(plan.chapters[1].order).toBe(2)
    expect(plan.volume.chapters).toHaveLength(3)
  })
  it('creates a volume when the book has none', () => {
    const plan = planContinueChapters(
      { title: 'T', author: '', synopsis: '', tags: [], volumes: [] },
      1,
    )
    expect(plan.createdVolume).toBe(true)
    expect(plan.volume.id).toBeTruthy()
    expect(plan.chapters[0].title).toBe('Chapter 1')
  })
})

// ---- buildBatchMessages ----

describe('buildBatchMessages', () => {
  const base = {
    mode: 'continue' as const,
    i: 1,
    n: 2,
    chapterTitle: 'Chapter 2',
    direction: '',
    settings: 's',
    outline: 'o',
    timeline: 't',
    memories: 'm',
    scene: '',
    prevChapters: 'prev',
    systemPrompt: 'SYS',
    voiceContext: '',
  }
  it('omits the workshop-report section when not selected', () => {
    const [sys, user] = buildBatchMessages({ ...base })
    expect(sys.content).toBe('SYS')
    expect(user.content).not.toContain(PROMPTS.assist.batch.workshopReport)
  })
  it('injects the workshop report when provided', () => {
    const [sys, user] = buildBatchMessages({
      ...base,
      mode: 'rewrite',
      rewriteTarget: 'original',
      discussion: '## Topic\n\nconclusion',
      workshopChecklist: '1. Add the confrontation.',
    })
    expect(user.content).toContain(PROMPTS.assist.batch.workshopReport)
    expect(user.content).toContain('conclusion')
    expect(user.content).toContain(PROMPTS.assist.batch.workshopChecklist)
    expect(sys.content).toContain(PROMPTS.assist.batch.workshopComplianceGate(false))
  })
  it('appends the voice profile to the system prompt', () => {
    const [sys] = buildBatchMessages({ ...base, voiceContext: '\n\n## Author voice profile' })
    expect(sys.content).toBe('SYS\n\n## Author voice profile')
  })
  it('uses the localized batch instruction (localized text present)', () => {
    const [, user] = buildBatchMessages({ ...base, mode: 'rewrite', rewriteTarget: 'orig' })
    expect(user.content).toContain(PROMPTS.assist.batch.batchInstructionRewrite(1, 2, 'Chapter 2'))
  })
})

describe('engine custom system prompt', () => {
  it('prefers a user-supplied custom system prompt over the built-in', async () => {
    const { deps, calls } = makeDeps({
      getCustomSystemPrompt: (mode) => (mode === 'rewrite' ? 'CUSTOM-REWRITE' : 'CUSTOM-CONTINUE'),
    })
    const task = makeTask({ count: 1 })
    await runBatchWrite(deps, task)
    expect(calls.chat).toBe(1)
    expect(task.status).toBe('done')
  })

  it('uses the built-in prompt when no custom prompt is provided', async () => {
    const { deps, calls } = makeDeps()
    const task = makeTask({ count: 1 })
    await runBatchWrite(deps, task)
    expect(calls.chat).toBe(1)
    expect(task.status).toBe('done')
  })
})

describe('engine world guard', () => {
  it('aborts before any write when the world switched mid-batch', async () => {
    const { deps, calls } = makeDeps({
      getCurrentWorldId: () => 'w_other',
    })
    const task = makeTask({ count: 2 })
    await runBatchWrite(deps, task)
    expect(task.status).toBe('failed')
    expect(task.error).toContain('World switched')
    expect(calls.snapshot).toHaveLength(0)
    expect(calls.commit).toHaveLength(0)
    expect(calls.saveNovel).toBe(0)
  })
})

// ---- engine: continue flow ----

describe('runBatchWrite (continue)', () => {
  it('runs claim → flush → snapshot → pre-create → generate → done', async () => {
    const { deps, calls } = makeDeps()
    const task = makeTask({ count: 2 })
    await runBatchWrite(deps, task)
    expect(calls.flush).toBe(1)
    expect(calls.snapshot).toEqual(['novel.json'])
    expect(calls.saveNovel).toBe(1) // pre-create
    expect(calls.chat).toBe(2)
    expect(calls.commit).toHaveLength(2)
    expect(task.status).toBe('done')
    expect(task.chapters.map((c) => c.status)).toEqual(['done', 'done'])
    expect(task.chapters.map((c) => c.title)).toEqual(['Chapter 2', 'Chapter 3'])
  })

  it('marks later chapters stopped and pauses (attention) when generation fails', async () => {
    const { deps, calls } = makeDeps({
      chat: async () => {
        calls.chat++
        return { content: 'partial', reasoning: '', finishReason: 'length', completed: true }
      },
    })
    const task = makeTask({ count: 3 })
    await runBatchWrite(deps, task)
    // One automatic retry per chapter → 2 attempts on chapter 1, then stop.
    expect(calls.chat).toBe(2)
    expect(calls.commit).toHaveLength(0)
    expect(task.status).toBe('attention')
    expect(task.chapters[0].status).toBe('failed')
    expect(task.chapters[0].failureKind).toBe('generation')
    expect(task.chapters.slice(1).every((c) => c.status === 'stopped')).toBe(true)
  })

  it('keeps generated text and pauses on persist failure', async () => {
    const { deps, calls } = makeDeps({
      commitBatchChapter: async () => {
        throw new Error('disk full')
      },
    })
    const task = makeTask({ count: 2 })
    await runBatchWrite(deps, task)
    expect(task.status).toBe('attention')
    expect(task.chapters[0].status).toBe('failed')
    expect(task.chapters[0].failureKind).toBe('persist')
    expect(task.chapters[0].generatedText).toBeTruthy()
    expect(task.chapters[1].status).toBe('stopped')
  })

  it('persist-only retry via resumeBatch reuses the cached text without re-calling the model', async () => {
    let failOnce = true
    const { deps, calls } = makeDeps({
      commitBatchChapter: async (input) => {
        calls.commit.push(input)
        if (failOnce) {
          failOnce = false
          throw new Error('disk full')
        }
        return deps.getNovel()
      },
    })
    const task = makeTask({ count: 1 })
    await runBatchWrite(deps, task)
    expect(task.status).toBe('attention')
    expect(task.chapters[0].failureKind).toBe('persist')
    const chatsBefore = calls.chat
    // Resume from the failed chapter: persist-only, no new model call.
    await resumeBatch(deps, task, 0)
    expect(calls.chat).toBe(chatsBefore)
    expect(task.status).toBe('done')
    expect(task.chapters[0].status).toBe('done')
  })

  it('stops cleanly on AbortError and never retries', async () => {
    const { deps, calls, env } = makeDeps({
      chat: async (_messages, _pid, _onChunk, signal) => {
        calls.chat++
        // Block until the test aborts: the abort must surface as an AbortError
        // and must NOT trigger the automatic retry.
        await new Promise<void>((resolve) => {
          signal?.addEventListener('abort', () => resolve())
        })
        throw new DOMException('aborted', 'AbortError')
      },
    })
    const task = makeTask({ count: 5 })
    const running = runBatchWrite(deps, task)
    // Wait until the engine has entered the loop and registered its controller.
    await vi.waitFor(() => expect(env.controller).not.toBeNull())
    await vi.waitFor(() => expect(calls.chat).toBeGreaterThan(0))
    env.controller!.abort()
    await running
    expect(task.status).toBe('stopped')
    // The aborted attempt must not be re-run.
    expect(task.chapters.every((c) => c.status === 'done' || c.status === 'stopped')).toBe(true)
    expect(calls.chat).toBe(1)
  })
})

// ---- engine: rewrite flow ----

describe('runBatchWrite (rewrite)', () => {
  it('uses the frozen workshop report and the complete original chapter in the prompt', async () => {
    const original = `Opening\n\n${'x'.repeat(8_000)}\n\nLate scene marker`
    const report = 'Replace the late scene marker with a confrontation.'
    let sentMessages: import('../../src/shared/types').ChatMessage[] | undefined
    const { deps, calls } = makeDeps({
      readChapter: async () => original,
      listDiscussions: async () => [],
      chat: async (messages) => {
        calls.chat++
        sentMessages = messages
        return {
          content: '# Rewritten\n\nBody',
          reasoning: '',
          finishReason: 'stop',
          completed: true,
        }
      },
    })
    const task = makeTask({
      mode: 'rewrite',
      count: 1,
      startChapterId: 'c1',
      discussionSessionId: 'd1',
      workshopReport: { sessionId: 'd1', topic: 'Late scene', conclusion: report },
      chapters: [{ id: 'c1', title: 'Chapter 1', file: 'v1_a.md', status: 'pending', words: 0 }],
    })

    await runBatchWrite(deps, task)

    expect(sentMessages?.[1].content).toContain(report)
    expect(sentMessages?.[1].content).toContain('Late scene marker')
    expect(task.workshopReportStatus).toMatchObject({
      state: 'included',
      characters: expect.any(Number),
    })
  })

  it('fails explicitly when a selected workshop report can no longer be loaded', async () => {
    const { deps, calls } = makeDeps({ listDiscussions: async () => [] })
    const task = makeTask({
      mode: 'rewrite',
      count: 1,
      startChapterId: 'c1',
      discussionSessionId: 'missing',
      chapters: [{ id: 'c1', title: 'Chapter 1', file: 'v1_a.md', status: 'pending', words: 0 }],
    })

    await runBatchWrite(deps, task)

    expect(calls.chat).toBe(0)
    expect(task.status).toBe('failed')
    expect(task.error).toContain('workshop report is unavailable')
    expect(task.workshopReportStatus?.state).toBe('missing')
  })

  it('retries then rejects a near-copy when a workshop report was selected', async () => {
    const original = 'The river ran black beneath the bridge. '.repeat(20)
    const messages: import('../../src/shared/types').ChatMessage[][] = []
    const { deps, calls } = makeDeps({
      readChapter: async () => original,
      chat: async (request) => {
        calls.chat++
        messages.push(request)
        return { content: original, reasoning: '', finishReason: 'stop', completed: true }
      },
    })
    const task = makeTask({
      mode: 'rewrite',
      count: 1,
      startChapterId: 'c1',
      discussionSessionId: 'd1',
      workshopReport: { sessionId: 'd1', topic: 'Conflict', conclusion: 'Add a confrontation.' },
      chapters: [{ id: 'c1', title: 'Chapter 1', file: 'v1_a.md', status: 'pending', words: 0 }],
    })

    await runBatchWrite(deps, task)

    expect(calls.chat).toBe(3)
    expect(messages[2][0].content).toContain(PROMPTS.assist.batch.workshopComplianceGate(true))
    expect(calls.commit).toHaveLength(0)
    expect(task.chapters[0].error).toContain('too similar')
  })

  it('snapshots each target chapter and rewrites them in order', async () => {
    const novel = {
      ...baseNovel(),
      volumes: [
        {
          ...baseNovel().volumes[0],
          chapters: [
            ...baseNovel().volumes[0].chapters,
            {
              id: 'c2',
              volumeId: 'v1',
              title: 'Chapter 2',
              order: 1,
              file: 'v1_b.md',
              wordCount: 8,
              status: 'draft',
              updatedAt: 2,
            },
          ],
        } as Volume,
      ],
    }
    const { deps, calls } = makeDeps({ getNovel: () => novel })
    const task = makeTask({
      mode: 'rewrite',
      count: 2,
      startChapterId: 'c1',
      chapters: [
        { id: 'c1', title: 'Chapter 1', file: 'v1_a.md', status: 'pending', words: 0 },
        { id: 'c2', title: 'Chapter 2', file: 'v1_b.md', status: 'pending', words: 0 },
      ] as BatchChapterState[],
    })
    await runBatchWrite(deps, task)
    expect(calls.snapshot).toEqual(['novel.json', 'chapters/v1_a.md', 'chapters/v1_b.md'])
    expect(calls.saveNovel).toBe(0) // no pre-creation in rewrite mode
    expect(calls.commit).toHaveLength(2)
    expect(task.status).toBe('done')
    expect(task.chapters.map((c) => c.status)).toEqual(['done', 'done'])
  })

  it('keeps the original and continues to later chapters on generation failure', async () => {
    let attempts = 0
    const twoChapterNovel = {
      ...baseNovel(),
      volumes: [
        {
          ...baseNovel().volumes[0],
          chapters: [
            ...baseNovel().volumes[0].chapters,
            {
              id: 'c2',
              volumeId: 'v1',
              title: 'Chapter 2',
              order: 1,
              file: 'v1_b.md',
              wordCount: 8,
              status: 'draft',
              updatedAt: 2,
            },
          ],
        } as Volume,
      ],
    }
    const { deps, calls } = makeDeps({
      getNovel: () => twoChapterNovel,
      chat: async () => {
        attempts++
        // Chapter 1 fails twice (initial + one auto-retry); chapter 2 succeeds.
        if (attempts <= 2)
          return { content: 'x', reasoning: '', finishReason: 'length', completed: true }
        return { content: '# OK\n\nbody', reasoning: '', finishReason: 'stop', completed: true }
      },
    })
    const task = makeTask({
      mode: 'rewrite',
      count: 2,
      startChapterId: 'c1',
      chapters: [
        { id: 'c1', title: 'Chapter 1', file: 'v1_a.md', status: 'pending', words: 0 },
        { id: 'c2', title: 'Chapter 2', file: 'v1_b.md', status: 'pending', words: 0 },
      ] as BatchChapterState[],
    })
    await runBatchWrite(deps, task)
    expect(task.chapters[0].status).toBe('failed')
    expect(task.chapters[1].status).toBe('done')
    expect(task.status).toBe('attention') // failed chapter remains → attention
    expect(calls.commit).toHaveLength(1)
  })
})

// ---- deleteEmptyChapter ----

describe('deleteEmptyChapter', () => {
  it('marks the chapter deleted and re-settles the task to done', async () => {
    const { deps } = makeDeps()
    const task = makeTask({
      count: 1,
      status: 'attention',
      chapters: [
        {
          id: 'c1',
          title: 'Chapter 1',
          file: 'v1_a.md',
          status: 'failed',
          failureKind: 'generation',
          words: 0,
        },
      ],
    })
    await deleteEmptyChapter(deps, task, 'c1')
    expect(task.chapters[0].status).toBe('deleted')
    expect(task.status).toBe('done')
  })
})
