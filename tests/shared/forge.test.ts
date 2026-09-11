import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FORGE_BRIEF,
  FORGE_LIMITS,
  FORGE_SETTING_CATEGORIES,
  emptyForgeRun,
  extractForgeProse,
  forgeCanRetry,
  forgeCodexDigest,
  forgeDirectivesFor,
  forgeDraftLimit,
  forgeNextOrdinal,
  forgeNextWork,
  forgePhaseForWork,
  forgeProgress,
  forgeStorySoFar,
  normalizeForgeBrief,
  normalizeForgeRun,
  parseForgeCodex,
  parseForgeConcept,
  parseForgeFindings,
  parseForgeJson,
  parseForgePlan,
  parseForgeScenes,
} from '../../src/shared/forge'
import { SETTING_CATEGORIES } from '../../src/server/paths'
import type {
  ForgeBrief,
  ForgeChapterState,
  ForgeDirective,
  ForgeRun,
} from '../../src/shared/types'

const brief = (overrides: Partial<ForgeBrief> = {}): ForgeBrief => ({
  ...DEFAULT_FORGE_BRIEF,
  theme: 'A city where memories are traded',
  chapters: 3,
  scope: 'draft',
  ...overrides,
})

const chapter = (overrides: Partial<ForgeChapterState> = {}): ForgeChapterState => ({
  chapterId: 'c1',
  title: 'Chapter 1',
  volumeTitle: 'Volume One',
  order: 0,
  beats: [],
  prose: 'pending',
  memory: 'pending',
  words: 0,
  summary: '',
  endState: '',
  attempts: 0,
  memoryAttempts: 0,
  error: null,
  ...overrides,
})

const runWith = (chapters: ForgeChapterState[], steps: ForgeRun['steps'] = []): ForgeRun => ({
  ...emptyForgeRun({ id: 'fr_1', worldId: 'w1', worldTitle: 'W', brief: brief() }),
  chapters,
  steps,
})

const completedStep = (kind: ForgeRun['steps'][number]['kind']): ForgeRun['steps'][number] => ({
  id: `s_${kind}`,
  kind,
  label: kind,
  chapterId: null,
  status: 'completed',
  startedAt: 1,
  durationMs: 1,
  providerName: 'p',
  model: 'm',
  inputChars: 0,
  outputChars: 0,
  usage: { source: 'unavailable', inputTokens: null, outputTokens: null, totalTokens: null },
  error: null,
  output: '',
})

describe('category ids stay in sync with the server', () => {
  it('mirrors SETTING_CATEGORIES', () => {
    expect(FORGE_SETTING_CATEGORIES).toEqual(SETTING_CATEGORIES)
  })
})

describe('parseForgeJson', () => {
  it('unwraps a fenced answer', () => {
    expect(parseForgeJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it('recovers an object embedded in prose', () => {
    expect(parseForgeJson('Sure! {"a":1} hope that helps')).toEqual({ a: 1 })
  })

  it('throws a retryable message on a truncated answer', () => {
    expect(() => parseForgeJson('{"a": ')).toThrow(/valid JSON/)
  })
})

describe('parseForgeConcept', () => {
  it('normalizes a full concept', () => {
    const concept = parseForgeConcept(
      JSON.stringify({
        title: 'Ashes',
        genre: 'Fantasy',
        logline: 'A broker loses her own past.',
        synopsis: 'Long synopsis.',
        themes: ['memory', 'debt', ''],
        tone: 'dark',
        pov: 'third limited',
        styleGuide: 'Short sentences.',
        cast: [
          { name: 'Ilyra', role: 'protagonist', description: 'Broker.' },
          { role: 'extra' },
          'junk',
        ],
        worldNotes: 'Rules.',
      }),
    )
    expect(concept.title).toBe('Ashes')
    expect(concept.themes).toEqual(['memory', 'debt'])
    expect(concept.cast).toHaveLength(1)
    expect(concept.cast[0].name).toBe('Ilyra')
  })

  it('falls back to the logline when no title is given', () => {
    const concept = parseForgeConcept('{"logline":"A one-line hook"}')
    expect(concept.title).toBe('A one-line hook')
  })

  it('refuses an empty concept', () => {
    expect(() => parseForgeConcept('{"title":"","synopsis":"","logline":""}')).toThrow(
      /nothing usable/,
    )
  })
})

describe('parseForgeCodex', () => {
  it('keeps valid docs and files unknown categories under 99-misc', () => {
    const docs = parseForgeCodex(
      JSON.stringify({
        docs: [
          { category: '11-character', title: 'Ilyra', content: '# Ilyra' },
          { category: 'not-a-category', title: 'Odd', content: 'body' },
          { category: '01-worldview', title: '', content: 'no title' },
        ],
      }),
    )
    expect(docs).toHaveLength(2)
    expect(docs[0].category).toBe('11-character')
    expect(docs[1].category).toBe('99-misc')
  })

  it('throws when no document survives', () => {
    expect(() => parseForgeCodex('{"docs":[]}')).toThrow(/no usable documents/)
  })
})

describe('parseForgePlan', () => {
  it('reads the volume shape and caps beats per chapter', () => {
    const plan = parseForgePlan(
      JSON.stringify({
        volumes: [
          {
            title: 'Volume One',
            summary: 'Setup.',
            chapters: [
              {
                title: 'Chapter 1: Ash',
                beats: Array.from({ length: 14 }, (_, i) => ({ title: `b${i}`, summary: 'x' })),
              },
              { title: 'Chapter 2: Debt', beats: [{ title: 'b', summary: 'y' }] },
            ],
          },
          { title: 'Empty volume', chapters: [] },
        ],
      }),
    )
    expect(plan).toHaveLength(2)
    expect(plan[0].chapters).toHaveLength(2)
    expect(plan[0].chapters[0].beats).toHaveLength(10)
    expect(FORGE_LIMITS.maxChapters).toBeGreaterThan(0)
  })

  it('accepts a flat chapter list and string beats', () => {
    const plan = parseForgePlan(
      JSON.stringify({ chapters: [{ title: 'Ch 1', beats: ['something happens'] }] }),
    )
    expect(plan).toHaveLength(1)
    expect(plan[0].chapters[0].beats[0].summary).toBe('something happens')
  })

  it('throws when nothing was planned', () => {
    expect(() => parseForgePlan('{"volumes":[]}')).toThrow(/no chapters/)
  })

  it('reads the chapter contract the planner proposed, and drops an empty one', () => {
    const plan = parseForgePlan(
      JSON.stringify({
        volumes: [
          {
            title: 'Volume One',
            chapters: [
              {
                title: 'Chapter 1: Ash',
                contract: {
                  event: '  She burns the ledger.  ',
                  goal: 'Keep the guild from reading it.',
                  entryState: 'Night, the archive.',
                  exitState: '',
                  protectedReveals: 'Her father is alive.',
                },
                beats: [{ title: 'b', summary: 'y' }],
              },
              // A planner with no opinion on this chapter must not leave five
              // empty strings behind for the editor to display as decisions.
              { title: 'Chapter 2: Debt', contract: { event: '' }, beats: [] },
            ],
          },
        ],
      }),
    )

    expect(plan[0].chapters[0].contract).toEqual({
      event: 'She burns the ledger.',
      goal: 'Keep the guild from reading it.',
      entryState: 'Night, the archive.',
      exitState: '',
      protectedReveals: 'Her father is alive.',
    })
    expect(plan[0].chapters[1].contract).toBeUndefined()
  })
})

describe('parseForgeScenes', () => {
  it('reads the blueprint shape and clamps beat links to the chapter', () => {
    const scenes = parseForgeScenes(
      JSON.stringify({
        scenes: [
          {
            title: 'The archive at night',
            purpose: 'Establish the ledger.',
            goal: 'Get the ledger.',
            obstacle: 'The clerk will not talk.',
            turn: 'She learns it is forged.',
            exitState: 'Alone, with the ledger.',
            // 7 belongs to no beat of a three-beat chapter; 2 is real.
            beats: [1, 2, 7],
          },
          { title: 'Only a name', beats: [0] },
        ],
      }),
      3,
    )

    expect(scenes).toHaveLength(2)
    expect(scenes[0]).toMatchObject({ title: 'The archive at night', beats: [1, 2] })
    expect(scenes[0].id).toMatch(/^sc_/)
    expect(scenes[1].beats).toEqual([])
  })

  it('refuses an answer that is not a blueprint', () => {
    // The provider answered something else entirely: the caller must be able to
    // tell, so it can warn and draft from the beats instead of stalling.
    expect(() => parseForgeScenes('{"title":"a concept"}', 3)).toThrow(/scenes/)
    expect(() => parseForgeScenes('{"scenes":[]}', 3)).toThrow(/no usable scenes/)
    expect(() => parseForgeScenes('not json at all', 3)).toThrow()
  })

  it('caps how many scenes one chapter may carry', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ title: `Scene ${i}`, purpose: 'x' }))
    expect(parseForgeScenes(JSON.stringify({ scenes: many }), 3)).toHaveLength(
      FORGE_LIMITS.maxScenes,
    )
  })
})

describe('parseForgeFindings', () => {
  it('normalizes severities and drops empty findings', () => {
    const findings = parseForgeFindings(
      JSON.stringify({
        issues: [
          {
            severity: 'critical',
            chapterTitle: 'Ch 2',
            text: 'Dead character acts.',
            relatedDocTitles: ['Ilyra'],
          },
          { severity: 'weird', text: 'Unsure.' },
          { severity: 'moderate', text: '' },
        ],
      }),
    )
    expect(findings).toHaveLength(2)
    expect(findings[0].severity).toBe('critical')
    expect(findings[0].relatedDocTitles).toEqual(['Ilyra'])
    expect(findings[1].severity).toBe('unsure')
  })
})

describe('extractForgeProse', () => {
  it('drops the node-landing list', () => {
    const answer = '【节点落地清单】\n1. beat one → scene one\n\n【正文】\n\nShe counted the coins.'
    expect(extractForgeProse(answer)).toBe('She counted the coins.')
  })

  it('strips a repeated chapter heading', () => {
    const answer = '【正文】\n\n# Chapter 1: Ash\n\nThe bell rang.'
    expect(extractForgeProse(answer)).toBe('The bell rang.')
  })

  it('returns the whole answer when no marker is present', () => {
    expect(extractForgeProse('  The bell rang.  ')).toBe('The bell rang.')
  })
})

describe('normalizeForgeBrief', () => {
  it('clamps numbers and defaults unknown values', () => {
    const normalized = normalizeForgeBrief({
      theme: '  a theme  ',
      chapters: 9999,
      wordsPerChapter: 1,
      scope: 'nonsense',
      language: 'fr',
      draftCount: -5,
      replaceExisting: 'yes',
    })
    expect(normalized.theme).toBe('a theme')
    expect(normalized.chapters).toBe(FORGE_LIMITS.maxChapters)
    expect(normalized.wordsPerChapter).toBe(FORGE_LIMITS.minWordsPerChapter)
    expect(normalized.scope).toBe('draft')
    expect(normalized.language).toBe('auto')
    expect(normalized.draftCount).toBe(0)
    expect(normalized.replaceExisting).toBe(false)
  })
})

describe('normalizeForgeRun', () => {
  it('rejects a run without ids and normalizes the rest', () => {
    expect(normalizeForgeRun({})).toBeNull()
    const run = normalizeForgeRun({
      id: 'fr_1',
      worldId: 'w1',
      status: 'nonsense',
      phase: 'nonsense',
      brief: { theme: 't' },
      chapters: [{ chapterId: 'c1', prose: 'drafted', memory: 'done', words: 120 }],
      steps: [{ id: 's1', kind: 'draft', status: 'completed' }],
    })
    expect(run?.status).toBe('paused')
    expect(run?.phase).toBe('concept')
    expect(run?.chapters[0].prose).toBe('drafted')
    expect(run?.chapters[0].words).toBe(120)
    expect(run?.steps).toHaveLength(1)
  })
})

describe('forgeNextWork', () => {
  it('walks the stages in order', () => {
    const run = runWith([chapter()])
    expect(forgeNextWork(run)).toEqual({ kind: 'concept' })
    run.steps.push(completedStep('concept'))
    expect(forgeNextWork(run)).toEqual({ kind: 'codex' })
    run.steps.push(completedStep('codex'))
    expect(forgeNextWork(run)).toEqual({ kind: 'outline' })
    run.steps.push(completedStep('outline'))
    expect(forgeNextWork(run)).toEqual({ kind: 'draft', chapterIndex: 0 })
  })

  it('summarizes a chapter before drafting the next one', () => {
    const run = runWith([
      chapter({ chapterId: 'c1', prose: 'drafted' }),
      chapter({ chapterId: 'c2', order: 1 }),
    ])
    run.steps.push(completedStep('concept'), completedStep('codex'), completedStep('outline'))
    expect(forgeNextWork(run)).toEqual({ kind: 'memory', chapterIndex: 0 })
    run.chapters[0].memory = 'done'
    expect(forgeNextWork(run)).toEqual({ kind: 'draft', chapterIndex: 1 })
  })

  it('gives up on a chapter that failed both attempts and moves on', () => {
    const run = runWith([
      chapter({ chapterId: 'c1', prose: 'failed', attempts: 2 }),
      chapter({ chapterId: 'c2', order: 1 }),
    ])
    run.steps.push(completedStep('concept'), completedStep('codex'), completedStep('outline'))
    expect(forgeNextWork(run)).toEqual({ kind: 'draft', chapterIndex: 1 })
  })

  it('gives up on a summary separately from the draft', () => {
    const run = runWith([
      chapter({
        chapterId: 'c1',
        prose: 'drafted',
        memory: 'failed',
        attempts: 1,
        memoryAttempts: 1,
      }),
      chapter({ chapterId: 'c2', order: 1 }),
    ])
    run.steps.push(completedStep('concept'), completedStep('codex'), completedStep('outline'))
    // The draft budget is untouched by the failing summary.
    expect(forgeNextWork(run)).toEqual({ kind: 'memory', chapterIndex: 0 })
    run.chapters[0].memoryAttempts = 2
    expect(forgeNextWork(run)).toEqual({ kind: 'draft', chapterIndex: 1 })
  })

  it('skips the review when nothing was drafted, and does not retry a failed review', () => {
    const nothingDrafted = runWith([chapter({ prose: 'failed', attempts: 2 })])
    nothingDrafted.steps.push(
      completedStep('concept'),
      completedStep('codex'),
      completedStep('outline'),
    )
    expect(forgeNextWork(nothingDrafted)).toEqual({ kind: 'finalize' })

    const failedReview = runWith([chapter({ prose: 'drafted', memory: 'done' })])
    failedReview.steps.push(
      completedStep('concept'),
      completedStep('codex'),
      completedStep('outline'),
    )
    failedReview.steps.push({ ...completedStep('review'), status: 'failed' })
    // A failed review still records its coverage, so it is not retried forever.
    failedReview.reviewedUpTo = 1
    expect(forgeNextWork(failedReview)).toEqual({ kind: 'finalize' })
    // ...but a chapter written afterwards makes the review due again.
    failedReview.chapters.push(
      chapter({ chapterId: 'c2', order: 1, prose: 'drafted', memory: 'done' }),
    )
    expect(forgeNextWork(failedReview)).toEqual({ kind: 'review' })
  })

  it('respects the draft limit and skips review for plan-only runs', () => {
    const planRun = runWith([chapter(), chapter({ chapterId: 'c2', order: 1 })])
    planRun.brief = brief({ scope: 'plan' })
    planRun.steps.push(completedStep('concept'), completedStep('codex'), completedStep('outline'))
    expect(forgeDraftLimit(planRun)).toBe(0)
    expect(forgeNextWork(planRun)).toEqual({ kind: 'finalize' })

    const limited = runWith([chapter(), chapter({ chapterId: 'c2', order: 1 })])
    limited.brief = brief({ draftCount: 1 })
    limited.steps.push(completedStep('concept'), completedStep('codex'), completedStep('outline'))
    expect(forgeDraftLimit(limited)).toBe(1)
    expect(forgeNextWork(limited)).toEqual({ kind: 'draft', chapterIndex: 0 })
  })

  it('reviews before finalizing once every chapter is drafted', () => {
    const run = runWith([chapter({ prose: 'drafted', memory: 'done' })])
    run.steps.push(completedStep('concept'), completedStep('codex'), completedStep('outline'))
    expect(forgeNextWork(run)).toEqual({ kind: 'review' })
    // The engine records how many drafted chapters the review covered.
    run.steps.push(completedStep('review'))
    run.reviewedUpTo = 1
    expect(forgeNextWork(run)).toEqual({ kind: 'finalize' })
    run.steps.push(completedStep('finalize'))
    expect(forgeNextWork(run)).toBeNull()
  })

  it('plans the next arc when the author asked for more chapters', () => {
    const run = runWith([chapter({ prose: 'drafted', memory: 'done' })])
    run.steps.push(completedStep('concept'), completedStep('codex'), completedStep('outline'))
    run.planRequest = 3
    expect(forgeNextWork(run)).toEqual({ kind: 'expand' })
    // Once served, the pipeline carries on from wherever it now is.
    run.planRequest = 0
    expect(forgeNextWork(run)).toEqual({ kind: 'review' })
  })

  it('reviews again after more chapters were drafted than the last review covered', () => {
    const run = runWith([
      chapter({ chapterId: 'c1', prose: 'drafted', memory: 'done' }),
      chapter({ chapterId: 'c2', order: 1, prose: 'drafted', memory: 'done' }),
    ])
    run.steps.push(
      completedStep('concept'),
      completedStep('codex'),
      completedStep('outline'),
      completedStep('review'),
      completedStep('finalize'),
    )
    // The review covered one chapter; a second one appeared afterwards.
    run.reviewedUpTo = 1
    expect(forgeNextWork(run)).toEqual({ kind: 'review' })
    run.reviewedUpTo = 2
    expect(forgeNextWork(run)).toBeNull()
  })
})

describe('forgeDirectivesFor', () => {
  const directive = (over: Partial<ForgeDirective>): ForgeDirective => ({
    id: 'd1',
    text: 'text',
    fromOrder: 1,
    onlyOrder: null,
    createdAt: 1,
    ...over,
  })

  it('applies standing directions from their chapter on', () => {
    const run = runWith([chapter()])
    run.direction = [directive({ id: 'a', fromOrder: 3 })]
    expect(forgeDirectivesFor(run, 2)).toHaveLength(0)
    expect(forgeDirectivesFor(run, 3)).toHaveLength(1)
    expect(forgeDirectivesFor(run, 9)).toHaveLength(1)
  })

  it('applies a chapter-only direction to exactly that chapter', () => {
    const run = runWith([chapter()])
    run.direction = [directive({ id: 'a', onlyOrder: 2, fromOrder: 2 })]
    expect(forgeDirectivesFor(run, 1)).toHaveLength(0)
    expect(forgeDirectivesFor(run, 2)).toHaveLength(1)
    expect(forgeDirectivesFor(run, 3)).toHaveLength(0)
  })

  it('keeps directives, coverage and findings across a reload', () => {
    const run = runWith([chapter()])
    run.direction = [directive({ id: 'a', text: 'Be brief.', fromOrder: 2 })]
    run.reviewedUpTo = 1
    run.planRequest = 4
    run.findings = [
      {
        severity: 'critical',
        text: 'The ledger burns twice.',
        chapterTitle: 'Chapter 2: Debt',
        relatedDocTitles: ['Ilyra'],
      },
    ]
    const reloaded = normalizeForgeRun(JSON.parse(JSON.stringify(run)))
    expect(reloaded?.direction).toEqual(run.direction)
    expect(reloaded?.reviewedUpTo).toBe(1)
    expect(reloaded?.planRequest).toBe(4)
    expect(reloaded?.findings).toEqual(run.findings)
    // A run written by an older build has none of these fields and still loads.
    const legacy = normalizeForgeRun({ id: 'fr_old', worldId: 'w1' })
    expect(legacy?.direction).toEqual([])
    expect(legacy?.reviewedUpTo).toBe(0)
    expect(legacy?.planRequest).toBe(0)
    expect(legacy?.findings).toEqual([])
  })

  it('drops malformed findings and keeps unknown severities as unsure', () => {
    const run = normalizeForgeRun({
      id: 'fr_1',
      worldId: 'w1',
      findings: [
        { severity: 'critical', text: 'kept', chapterTitle: 'Ch 1', relatedDocTitles: ['A'] },
        { severity: 'huge', text: 'kept as unsure' },
        { severity: 'critical', text: '' },
        'not an object',
      ],
    })
    expect(run?.findings).toHaveLength(2)
    expect(run?.findings[0].severity).toBe('critical')
    expect(run?.findings[1].severity).toBe('unsure')
  })
})

describe('forgeNextOrdinal', () => {
  it('points at the next chapter that has not been written', () => {
    const run = runWith([
      chapter({ chapterId: 'c1', prose: 'drafted' }),
      chapter({ chapterId: 'c2', order: 1, prose: 'failed' }),
    ])
    expect(forgeNextOrdinal(run)).toBe(2)
    run.chapters[1].prose = 'drafted'
    expect(forgeNextOrdinal(run)).toBe(3)
  })
})

describe('forgeCanRetry', () => {
  it('is true while a chapter inside the draft limit is unwritten or failed', () => {
    expect(forgeCanRetry(runWith([chapter({ prose: 'failed' })]))).toBe(true)
    expect(forgeCanRetry(runWith([chapter({ prose: 'drafted' })]))).toBe(false)
    const beyondLimit = runWith([
      chapter({ prose: 'drafted' }),
      chapter({ chapterId: 'c2', prose: 'pending' }),
    ])
    beyondLimit.brief = brief({ draftCount: 1 })
    expect(forgeCanRetry(beyondLimit)).toBe(false)
  })
})

describe('forgeProgress', () => {
  it('reaches 100 only after finalize', () => {
    const run = runWith([chapter({ prose: 'drafted', memory: 'done' })])
    run.steps.push(completedStep('concept'), completedStep('codex'), completedStep('outline'))
    const mid = forgeProgress(run)
    expect(mid.percent).toBeGreaterThan(50)
    expect(mid.percent).toBeLessThan(100)
    run.steps.push(completedStep('review'), completedStep('finalize'))
    expect(forgeProgress(run).percent).toBe(100)
  })

  it('counts drafted and failed chapters', () => {
    const run = runWith([
      chapter({ chapterId: 'c1', prose: 'drafted', words: 100 }),
      chapter({ chapterId: 'c2', prose: 'failed', words: 0 }),
    ])
    const progress = forgeProgress(run)
    expect(progress.draftedChapters).toBe(1)
    expect(progress.failedChapters).toBe(1)
    expect(progress.totalWords).toBe(100)
    expect(progress.plannedChapters).toBe(2)
  })
})

describe('forgePhaseForWork', () => {
  it('labels chapter work as drafting', () => {
    const run = runWith([chapter()])
    expect(forgePhaseForWork({ kind: 'draft', chapterIndex: 0 }, run)).toBe('draft')
    expect(forgePhaseForWork({ kind: 'memory', chapterIndex: 0 }, run)).toBe('draft')
    run.brief = brief({ scope: 'plan' })
    expect(forgePhaseForWork({ kind: 'draft', chapterIndex: 0 }, run)).toBe('outline')
  })
})

describe('forgeCodexDigest', () => {
  it('orders characters first and names what did not fit', () => {
    const digest = forgeCodexDigest(
      [
        { category: '99-misc', title: 'Notes', content: 'misc body' },
        { category: '11-character', title: 'Ilyra', content: 'char body' },
      ],
      25,
    )
    expect(digest).toContain('Ilyra')
    expect(digest.indexOf('Ilyra')).toBeLessThan(digest.indexOf('Notes'))
    // The dropped document is still named, so the model knows it exists.
    expect(digest).toMatch(/not shown for length: Notes/)
  })

  it('truncates an over-long document', () => {
    const digest = forgeCodexDigest(
      [
        {
          category: '01-worldview',
          title: 'World',
          content: 'x'.repeat(FORGE_LIMITS.docChars + 500),
        },
      ],
      100_000,
    )
    expect(digest).toContain('…')
    expect(digest.length).toBeLessThan(FORGE_LIMITS.docChars + 200)
  })
})

describe('forgeStorySoFar', () => {
  it('uses only chapters before the active one', () => {
    const run = runWith([
      chapter({ chapterId: 'c1', title: 'One', summary: 'first', endState: 'ends here' }),
      chapter({ chapterId: 'c2', title: 'Two', order: 1, summary: 'second' }),
    ])
    const text = forgeStorySoFar(run, 1)
    expect(text).toContain('first')
    expect(text).not.toContain('second')
  })
})
