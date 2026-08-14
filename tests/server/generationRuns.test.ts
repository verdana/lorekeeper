import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  ensureWorldSkeleton,
  generationRunsDir,
  initPaths,
  setCurrentWorldId,
} from '../../src/server/paths'
import {
  createGenerationRun,
  listGenerationRuns,
  readGenerationRun,
  saveGenerationStage,
  saveGenerationAuthorResult,
  selectGenerationResult,
} from '../../src/server/store'
import type { GenerationStage } from '../../src/shared/types'

let dataRoot = ''
const worldId = 'w_generation_runs'

const stage = (status: GenerationStage['status'] = 'running'): GenerationStage => ({
  id: 'draft',
  kind: 'draft',
  partIndex: 1,
  partTotal: 1,
  status,
  promptVersion: 'legacy-outline-draft-v1',
  promptHash: '',
  messages: [
    { role: 'system', content: 'Write the chapter.' },
    { role: 'user', content: 'Use this outline.' },
  ],
  contextLayers: [{ key: 'outline', label: 'Outline', content: 'The event.' }],
  provider: {
    id: 'provider-1',
    name: 'Provider',
    baseUrl: 'https://example.test/v1',
    model: 'model-1',
    inputPriceCnyPerMillionTokens: 2,
    outputPriceCnyPerMillionTokens: 8,
  },
  parameters: {
    temperature: 0.8,
    topP: 0.9,
    maxTokens: 4096,
    disableThinking: true,
  },
  startedAt: 100,
  durationMs: null,
  finishReason: null,
  usage: {
    source: 'unavailable',
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
  },
  output: '',
  error: null,
})

beforeAll(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'lorekeeper-generation-runs-'))
  process.env.ORBIT_DATA_DIR = dataRoot
  initPaths()
  ensureWorldSkeleton(worldId)
  setCurrentWorldId(worldId)
})

afterAll(() => {
  rmSync(dataRoot, { recursive: true, force: true })
})

beforeEach(() => {
  for (const file of readdirSync(generationRunsDir())) {
    rmSync(join(generationRunsDir(), file), { force: true })
  }
})

describe('generation run persistence', () => {
  it('persists the run before any model stage starts', () => {
    const run = createGenerationRun({
      id: 'gr_first',
      chapterId: 'chapter-1',
      chapterTitle: 'Chapter One',
    })
    expect(run.pipeline).toBe('legacy-two-pass')
    expect(run.stages).toEqual([])
    expect(run.selectedResult).toBeNull()
    expect(existsSync(join(generationRunsDir(), 'gr_first.json'))).toBe(true)
  })

  it('rejects draft-only runs before a two-pass baseline exists', () => {
    expect(() =>
      createGenerationRun({
        id: 'gr_no_baseline',
        chapterId: 'chapter-1',
        chapterTitle: 'One',
        calibrationEnabled: false,
      }),
    ).toThrow('before a two-pass baseline')
  })

  it('links the exact author-selected text to its source stages', () => {
    createGenerationRun({ id: 'gr_selection', chapterId: 'chapter-1', chapterTitle: 'One' })
    saveGenerationStage('gr_selection', {
      ...stage('completed'),
      output: 'Raw draft',
    })

    const selected = selectGenerationResult('gr_selection', {
      kind: 'draft',
      stageIds: ['draft'],
      text: 'Raw draft',
    })
    expect(selected.selectedResult).toMatchObject({
      kind: 'draft',
      stageIds: ['draft'],
      text: 'Raw draft',
    })
    expect(selected.selectedResult?.selectedAt).toBeGreaterThan(0)
    expect(readGenerationRun('gr_selection')?.selectedResult?.text).toBe('Raw draft')
  })

  it('rejects selections whose declared kind does not match the source stages', () => {
    createGenerationRun({ id: 'gr_mismatch', chapterId: 'chapter-1', chapterTitle: 'One' })
    saveGenerationStage('gr_mismatch', stage('completed'))
    expect(() =>
      selectGenerationResult('gr_mismatch', {
        kind: 'calibrated',
        stageIds: ['draft'],
        text: 'Wrong source',
      }),
    ).toThrow('does not match')
  })

  it('upserts a stage and computes its prompt hash on the server', () => {
    createGenerationRun({ id: 'gr_update', chapterId: 'chapter-1', chapterTitle: 'One' })
    const running = saveGenerationStage('gr_update', stage())
    expect(running.stages).toHaveLength(1)
    expect(running.stages[0].promptHash).toMatch(/^[a-f0-9]{64}$/)

    const completed = saveGenerationStage('gr_update', {
      ...stage('completed'),
      durationMs: 1200,
      finishReason: 'stop',
      usage: {
        source: 'reported',
        inputTokens: 100,
        outputTokens: 200,
        totalTokens: 300,
      },
      output: 'Raw draft',
    })
    expect(completed.stages).toHaveLength(1)
    expect(completed.stages[0]).toMatchObject({
      status: 'completed',
      durationMs: 1200,
      output: 'Raw draft',
      usage: { source: 'reported', totalTokens: 300 },
    })
  })

  it('keeps captured stage inputs immutable when completion is saved', () => {
    createGenerationRun({ id: 'gr_immutable', chapterId: 'chapter-1', chapterTitle: 'One' })
    const running = saveGenerationStage('gr_immutable', stage())
    const completed = saveGenerationStage('gr_immutable', {
      ...stage('completed'),
      messages: [{ role: 'user', content: 'Altered after the request.' }],
      provider: { ...stage().provider, model: 'altered-model' },
      output: 'Raw draft',
    })
    expect(completed.stages[0]).toMatchObject({
      status: 'completed',
      messages: running.stages[0].messages,
      provider: running.stages[0].provider,
      promptHash: running.stages[0].promptHash,
      output: 'Raw draft',
    })
  })

  it('estimates missing token usage and cost from the captured prices', () => {
    createGenerationRun({ id: 'gr_estimate', chapterId: 'chapter-1', chapterTitle: 'One' })
    const completed = saveGenerationStage('gr_estimate', {
      ...stage('completed'),
      output: '一段模型输出。',
    })
    expect(completed.stages[0].usage).toMatchObject({
      source: 'estimated',
      inputTokens: expect.any(Number),
      outputTokens: expect.any(Number),
      totalTokens: expect.any(Number),
    })
    expect(completed.stages[0].cost).toMatchObject({
      source: 'estimated',
      currency: 'CNY',
      totalCost: expect.any(Number),
    })
    expect(listGenerationRuns('chapter-1')[0].totalCostCny).toBeGreaterThan(0)
  })

  it('links later author saves and calculates retention against the selected result', () => {
    createGenerationRun({ id: 'gr_author', chapterId: 'chapter-1', chapterTitle: 'One' })
    saveGenerationStage('gr_author', { ...stage('completed'), output: '甲乙丙丁' })
    const selected = selectGenerationResult('gr_author', {
      kind: 'draft',
      stageIds: ['draft'],
      text: '甲乙丙丁',
    })
    const saved = saveGenerationAuthorResult('gr_author', {
      text: '# Chapter\n\n甲乙丁',
      editingStartedAt: selected.selectedResult!.selectedAt,
    })
    expect(saved.authorResult).toMatchObject({
      text: '# Chapter\n\n甲乙丁',
      durationMeasurement: 'elapsed',
      retentionRatio: 0.75,
    })
    expect(listGenerationRuns('chapter-1')[0]).toMatchObject({
      hasAuthorResult: true,
      retentionRatio: 0.75,
    })
  })

  it('captures the first complete two-pass run as baseline and links reproductions', () => {
    createGenerationRun({ id: 'gr_baseline', chapterId: 'chapter-1', chapterTitle: 'One' })
    saveGenerationStage('gr_baseline', { ...stage('completed'), output: 'Draft' })
    const baseline = saveGenerationStage('gr_baseline', {
      ...stage('completed'),
      id: 'calibration-1',
      kind: 'calibration',
      output: 'Calibrated',
    })
    expect(baseline.baseline).toMatchObject({ pipelineVersion: 'legacy-two-pass-v1' })

    const replay = createGenerationRun({
      id: 'gr_replay',
      chapterId: 'chapter-1',
      chapterTitle: 'One',
      reproductionOf: 'gr_baseline',
    })
    expect(replay.reproductionOf).toBe('gr_baseline')
    saveGenerationStage('gr_replay', { ...stage('completed'), output: 'Replay draft' })
    const completedReplay = saveGenerationStage('gr_replay', {
      ...stage('completed'),
      id: 'calibration-1',
      kind: 'calibration',
      output: 'Replay calibrated',
    })
    expect(completedReplay.baseline).toBeNull()
    expect(
      listGenerationRuns('chapter-1').find((run) => run.id === 'gr_baseline')?.isBaseline,
    ).toBe(true)
  })

  it('rejects reproduction metadata that changes the source chapter identity', () => {
    createGenerationRun({ id: 'gr_source', chapterId: 'chapter-1', chapterTitle: 'One' })
    expect(() =>
      createGenerationRun({
        id: 'gr_wrong_chapter',
        chapterId: 'chapter-2',
        chapterTitle: 'Two',
        reproductionOf: 'gr_source',
      }),
    ).toThrow('source chapter identity')
  })

  it('rejects calibrated selections that omit a calibration source stage', () => {
    createGenerationRun({ id: 'gr_partial_selection', chapterId: 'chapter-1', chapterTitle: 'One' })
    saveGenerationStage('gr_partial_selection', { ...stage('completed'), output: 'Draft' })
    for (const partIndex of [1, 2]) {
      saveGenerationStage('gr_partial_selection', {
        ...stage('completed'),
        id: `calibration-${partIndex}`,
        kind: 'calibration',
        partIndex,
        partTotal: 2,
        output: `Part ${partIndex}`,
      })
    }
    expect(() =>
      selectGenerationResult('gr_partial_selection', {
        kind: 'calibrated',
        stageIds: ['calibration-1'],
        text: 'Only one part',
      }),
    ).toThrow('every source stage')
  })

  it('promotes an eligible record from an earlier evidence slice when global history loads', () => {
    createGenerationRun({ id: 'gr_legacy', chapterId: 'chapter-1', chapterTitle: 'One' })
    saveGenerationStage('gr_legacy', { ...stage('completed'), output: 'Draft' })
    saveGenerationStage('gr_legacy', {
      ...stage('completed'),
      id: 'calibration-1',
      kind: 'calibration',
      output: 'Calibrated',
    })
    const full = join(generationRunsDir(), 'gr_legacy.json')
    const legacy = JSON.parse(readFileSync(full, 'utf8')) as Record<string, unknown>
    delete legacy.baseline
    writeFileSync(full, JSON.stringify(legacy))

    expect(listGenerationRuns().find((run) => run.id === 'gr_legacy')?.isBaseline).toBe(true)
    expect(readGenerationRun('gr_legacy')?.baseline).toMatchObject({
      pipelineVersion: 'legacy-two-pass-v1',
    })
  })

  it('reads and lists runs newest first with an optional chapter filter', async () => {
    createGenerationRun({ id: 'gr_old', chapterId: 'chapter-1', chapterTitle: 'One' })
    await new Promise((resolve) => setTimeout(resolve, 2))
    createGenerationRun({ id: 'gr_new', chapterId: 'chapter-2', chapterTitle: 'Two' })

    expect(listGenerationRuns().map((run) => run.id)).toEqual(['gr_new', 'gr_old'])
    expect(listGenerationRuns('chapter-1').map((run) => run.id)).toEqual(['gr_old'])
    expect(listGenerationRuns('chapter-1')[0]).toMatchObject({
      stageCount: 0,
      status: 'empty',
      selectedResultKind: null,
    })
    expect(readGenerationRun('gr_new')?.chapterTitle).toBe('Two')
  })

  it('rejects unsafe ids and ignores corrupt history files', () => {
    expect(() =>
      createGenerationRun({ id: '../escape', chapterId: 'chapter-1', chapterTitle: 'One' }),
    ).toThrow('Invalid generation run id')
    const corrupt = join(generationRunsDir(), 'broken.json')
    writeFileSync(corrupt, '{broken')
    createGenerationRun({ id: 'gr_valid', chapterId: 'chapter-1', chapterTitle: 'One' })
    expect(listGenerationRuns().map((run) => run.id)).toEqual(['gr_valid'])
    expect(readFileSync(join(generationRunsDir(), 'gr_valid.json'), 'utf8')).toContain('gr_valid')
  })
})
