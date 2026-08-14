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
  promptVersion: 'source-outline-draft-v2',
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
    expect(run.pipeline).toBe('source-draft')
    expect(run.stages).toEqual([])
    expect(run.selectedResult).toBeNull()
    expect(existsSync(join(generationRunsDir(), 'gr_first.json'))).toBe(true)
  })

  it('allows a source-draft run without a prior baseline', () => {
    const run = createGenerationRun({
      id: 'gr_no_baseline',
      chapterId: 'chapter-1',
      chapterTitle: 'One',
    })
    expect(run.pipeline).toBe('source-draft')
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
    ).toThrow('historical evidence')
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

  it('estimates missing token usage locally', () => {
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
    expect(listGenerationRuns('chapter-1')[0].status).toBe('completed')
  })

  it('removes legacy price snapshots and computed costs when a run is read', () => {
    createGenerationRun({ id: 'gr_legacy_cost', chapterId: 'chapter-1', chapterTitle: 'One' })
    saveGenerationStage('gr_legacy_cost', { ...stage('completed'), output: 'Draft' })
    const full = join(generationRunsDir(), 'gr_legacy_cost.json')
    const legacy = JSON.parse(readFileSync(full, 'utf8')) as {
      stages: Array<{
        cost?: unknown
        provider: {
          inputPriceCnyPerMillionTokens?: number
          outputPriceCnyPerMillionTokens?: number
        }
      }>
    }
    legacy.stages[0].cost = { currency: 'CNY', totalCost: 1 }
    legacy.stages[0].provider.inputPriceCnyPerMillionTokens = 2
    legacy.stages[0].provider.outputPriceCnyPerMillionTokens = 8
    writeFileSync(full, JSON.stringify(legacy))

    const cleaned = readGenerationRun('gr_legacy_cost')!
    expect(cleaned.stages[0]).not.toHaveProperty('cost')
    expect(cleaned.stages[0].provider).not.toHaveProperty('inputPriceCnyPerMillionTokens')
    const persisted = JSON.parse(readFileSync(full, 'utf8')) as { stages: unknown[] }
    expect(persisted.stages[0]).not.toHaveProperty('cost')
  })

  it('keeps historical calibration evidence readable without allowing new selections', () => {
    createGenerationRun({ id: 'gr_history', chapterId: 'chapter-1', chapterTitle: 'One' })
    saveGenerationStage('gr_history', { ...stage('completed'), output: 'Draft' })
    const full = join(generationRunsDir(), 'gr_history.json')
    const historical = JSON.parse(readFileSync(full, 'utf8')) as Record<string, unknown>
    historical.pipeline = 'legacy-two-pass'
    historical.calibrationEnabled = true
    historical.stages = [
      ...((historical.stages as GenerationStage[]) ?? []),
      {
        ...stage('completed'),
        id: 'calibration-1',
        kind: 'calibration',
        promptVersion: 'legacy-calibration-v1',
        output: 'Historical calibrated text',
      },
    ]
    historical.selectedResult = {
      kind: 'calibrated',
      stageIds: ['calibration-1'],
      text: 'Historical calibrated text',
      selectedAt: Date.now(),
    }
    writeFileSync(full, JSON.stringify(historical))

    const loaded = readGenerationRun('gr_history')!
    expect(loaded.pipeline).toBe('legacy-two-pass')
    expect(loaded.stages.find((item) => item.kind === 'calibration')?.output).toBe(
      'Historical calibrated text',
    )
    expect(loaded.selectedResult?.kind).toBe('calibrated')
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

  it('captures the first complete source draft as baseline and links reproductions', () => {
    createGenerationRun({ id: 'gr_baseline', chapterId: 'chapter-1', chapterTitle: 'One' })
    const baseline = saveGenerationStage('gr_baseline', {
      ...stage('completed'),
      output: 'Draft',
    })
    expect(baseline.baseline).toMatchObject({ pipelineVersion: 'source-draft-v2' })

    const replay = createGenerationRun({
      id: 'gr_replay',
      chapterId: 'chapter-1',
      chapterTitle: 'One',
      reproductionOf: 'gr_baseline',
    })
    expect(replay.reproductionOf).toBe('gr_baseline')
    const completedReplay = saveGenerationStage('gr_replay', {
      ...stage('completed'),
      output: 'Replay draft',
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

  it('rejects new calibration stages', () => {
    createGenerationRun({ id: 'gr_no_calibration', chapterId: 'chapter-1', chapterTitle: 'One' })
    expect(() =>
      saveGenerationStage('gr_no_calibration', {
        ...stage('completed'),
        id: 'calibration-1',
        kind: 'calibration',
        output: 'Calibrated',
      }),
    ).toThrow('historical evidence')
  })

  it('promotes an eligible record from an earlier evidence slice when global history loads', () => {
    createGenerationRun({ id: 'gr_legacy', chapterId: 'chapter-1', chapterTitle: 'One' })
    saveGenerationStage('gr_legacy', { ...stage('completed'), output: 'Draft' })
    const full = join(generationRunsDir(), 'gr_legacy.json')
    const legacy = JSON.parse(readFileSync(full, 'utf8')) as Record<string, unknown>
    delete legacy.baseline
    writeFileSync(full, JSON.stringify(legacy))

    expect(listGenerationRuns().find((run) => run.id === 'gr_legacy')?.isBaseline).toBe(true)
    expect(readGenerationRun('gr_legacy')?.baseline).toMatchObject({
      pipelineVersion: 'source-draft-v2',
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
