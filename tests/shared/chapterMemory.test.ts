import { describe, expect, it } from 'vitest'
import {
  buildMemoryLayers,
  formatStoryState,
  parseChapterSummaryPayload,
  rebuildStoryState,
  type MemoryLayerLabels,
} from '../../src/shared/chapterMemory'
import { orderedChapters, storyMemoryFingerprint } from '../../src/shared/storyMemory'
import type { Chapter, ChapterSummary, NovelMeta, StoryState, Volume } from '../../src/shared/types'

const chapter = (id: string, order: number): Chapter => ({
  id,
  volumeId: 'volume-1',
  title: `Chapter ${order + 1}`,
  order,
  file: `${id}.md`,
  wordCount: 0,
  status: 'draft',
  updatedAt: 1,
})

const novelWithChapters = (count: number): NovelMeta => ({
  title: 'Test Novel',
  author: '',
  synopsis: '',
  tags: [],
  volumes: [
    {
      id: 'volume-1',
      order: 0,
      title: 'Volume 1',
      chapters: Array.from({ length: count }, (_, i) => chapter(`ch${i + 1}`, i)),
    },
  ] as Volume[],
})

const summary = (chapterId: string, overrides: Partial<ChapterSummary> = {}): ChapterSummary => ({
  chapterId,
  chapterTitle: chapterId,
  sourceFingerprint: 'fp-' + chapterId,
  generatedAt: 1,
  summary: `${chapterId} 的摘要：主角在城门口与守卫对峙，随后离开。`,
  endState: `${chapterId} 章末：主角在城外森林。`,
  stateChanges: [],
  plantedThreads: [],
  resolvedThreads: [],
  ...overrides,
})

const labels: MemoryLayerLabels = {
  state: '当前故事状态',
  stateHint: '状态是硬约束。',
  condition: '伤势/体力',
  location: '所在位置',
  possessions: '随身携带',
  goals: '目标',
  relations: '关系',
  knows: '知情',
  worldState: '世界局势',
  openThreads: '未兑现伏笔',
  currentScene: '当前场景',
  recent: '近期章节',
  distant: '更早章节',
}

describe('parseChapterSummaryPayload', () => {
  it('parses a plain JSON object', () => {
    const raw = JSON.stringify({
      summary: '主角受伤了。',
      endState: '夜，森林，主角独自一人。',
      stateChanges: [
        { entity: '主角', aspect: '伤势', change: '左肺被刺穿，失血濒死', permanent: true },
        { entity: '主角', aspect: 'location', change: '森林', permanent: false },
      ],
      plantedThreads: ['城门口的守卫见过主角的脸'],
      resolvedThreads: ['旧钩子'],
    })
    const parsed = parseChapterSummaryPayload(raw)
    expect(parsed.summary).toBe('主角受伤了。')
    expect(parsed.endState).toBe('夜，森林，主角独自一人。')
    expect(parsed.stateChanges).toEqual([
      { entity: '主角', aspect: '伤势', change: '左肺被刺穿，失血濒死', permanent: true },
      { entity: '主角', aspect: 'location', change: '森林', permanent: false },
    ])
    expect(parsed.plantedThreads).toEqual(['城门口的守卫见过主角的脸'])
    expect(parsed.resolvedThreads).toEqual(['旧钩子'])
  })

  it('accepts a markdown-fenced payload', () => {
    const raw = '```json\n{"summary":"x","endState":"y"}\n```'
    expect(parseChapterSummaryPayload(raw).summary).toBe('x')
  })

  it('drops malformed stateChanges and caps the list', () => {
    const changes = Array.from({ length: 30 }, (_, i) => ({
      entity: `e${i}`,
      aspect: '伤势',
      change: `c${i}`,
      permanent: i % 2 === 0,
    }))
    changes.push({ entity: '', aspect: '伤势', change: 'dropped', permanent: false })
    changes.push({ entity: 'no-aspect', change: 'dropped', permanent: false, aspect: '' })
    const parsed = parseChapterSummaryPayload(
      JSON.stringify({ summary: 's', endState: 'e', stateChanges: changes }),
    )
    expect(parsed.stateChanges.length).toBe(20)
    expect(parsed.stateChanges.every((c) => c.entity && c.aspect && c.change)).toBe(true)
    // permanent 缺省按 false 处理
    const parsed2 = parseChapterSummaryPayload(
      JSON.stringify({
        summary: 's',
        endState: 'e',
        stateChanges: [{ entity: '主角', aspect: '伤势', change: '轻伤' }],
      }),
    )
    expect(parsed2.stateChanges[0].permanent).toBe(false)
  })

  it('throws when the payload is not an object', () => {
    expect(() => parseChapterSummaryPayload('not json')).toThrow()
    expect(() => parseChapterSummaryPayload('"a string"')).toThrow()
  })
})

describe('rebuildStoryState', () => {
  it('keeps the last change per character+aspect and merges aspects', () => {
    const summaries = [
      summary('ch1', {
        stateChanges: [
          { entity: '主角', aspect: '伤势', change: '轻伤', permanent: false },
          { entity: '主角', aspect: 'location', change: '城门口', permanent: false },
        ],
      }),
      summary('ch2', {
        stateChanges: [
          { entity: '主角', aspect: '伤势', change: '左肺被刺穿，失血濒死', permanent: true },
        ],
      }),
    ]
    const state = rebuildStoryState(summaries)
    const hero = state.characters.find((c) => c.name === '主角')
    expect(hero?.condition).toBe('左肺被刺穿，失血濒死')
    expect(hero?.location).toBe('城门口')
    expect(state.upToChapterId).toBe('ch2')
    expect(state.currentEndState).toBe('ch2 章末：主角在城外森林。')
  })

  it('routes entity 世界 to worldState', () => {
    const state = rebuildStoryState([
      summary('ch1', {
        stateChanges: [{ entity: '世界', aspect: '局势', change: '王国陷入内战', permanent: true }],
      }),
      summary('ch2', {
        stateChanges: [
          { entity: '世界', aspect: '局势', change: '内战扩大到边境', permanent: true },
        ],
      }),
    ])
    expect(state.worldState).toEqual(['内战扩大到边境'])
    expect(state.characters.length).toBe(0)
  })

  // The English pack instructs the model to emit entity "World" with aspect
  // "world" (prompts/en.ts). Matching only the Chinese entity names filed those
  // changes under a phantom character called "World" and lost the world state,
  // so both signals must route to worldState.
  it('routes the English pack entity "World" to worldState', () => {
    const state = rebuildStoryState([
      summary('ch1', {
        stateChanges: [
          {
            entity: 'World',
            aspect: 'world',
            change: 'The kingdom falls into civil war',
            permanent: true,
          },
        ],
      }),
    ])
    expect(state.worldState).toEqual(['The kingdom falls into civil war'])
    expect(state.characters.length).toBe(0)
  })

  it('routes a world aspect even when the entity names the setting', () => {
    const state = rebuildStoryState([
      summary('ch1', {
        stateChanges: [
          {
            entity: 'Corvane',
            aspect: 'world',
            change: 'The northern road is closed',
            permanent: true,
          },
        ],
      }),
    ])
    expect(state.worldState).toEqual(['The northern road is closed'])
    expect(state.characters).toEqual([])
  })

  it('routes the Chinese world aspect written in Chinese', () => {
    const state = rebuildStoryState([
      summary('ch1', {
        stateChanges: [{ entity: '北境', aspect: '世界', change: '北路已封', permanent: true }],
      }),
    ])
    expect(state.worldState).toEqual(['北路已封'])
    expect(state.characters).toEqual([])
  })

  // The entity check is the fallback for summaries whose aspect is missing or
  // was renamed, so the English name must match on its own in any casing.
  it('routes a world entity on its own, whatever the casing', () => {
    for (const entity of ['World', 'world', 'WORLD']) {
      const state = rebuildStoryState([
        summary('ch1', {
          stateChanges: [
            { entity, aspect: 'condition', change: 'Plague reaches the north', permanent: true },
          ],
        }),
      ])
      expect(state.worldState, `entity ${entity}`).toEqual(['Plague reaches the north'])
      expect(state.characters, `entity ${entity}`).toEqual([])
    }
  })

  it('still treats a real character as a character', () => {
    const state = rebuildStoryState([
      summary('ch1', {
        stateChanges: [
          {
            entity: 'Kaelen',
            aspect: 'condition',
            change: 'Pierced lung, bleeding out',
            permanent: true,
          },
        ],
      }),
    ])
    expect(state.worldState).toEqual([])
    expect(state.characters[0]?.name).toBe('Kaelen')
    expect(state.characters[0]?.condition).toBe('Pierced lung, bleeding out')
  })

  it('files an unrecognised aspect under the character condition', () => {
    const state = rebuildStoryState([
      summary('ch1', {
        stateChanges: [{ entity: '主角', aspect: '心情', change: '极度疲惫', permanent: false }],
      }),
    ])
    expect(state.characters[0]?.condition).toBe('极度疲惫')
    expect(state.worldState).toEqual([])
  })

  it('tracks what a character knows separately from where they are', () => {
    const state = rebuildStoryState([
      summary('ch1', {
        stateChanges: [
          { entity: '主角', aspect: 'location', change: '档案室', permanent: false },
          {
            entity: '主角',
            aspect: 'knowledge',
            change: '已知账本是伪造的；尚不知弟弟还活着',
            permanent: false,
          },
          // The Chinese pack may spell the aspect out in Chinese.
          { entity: '配角', aspect: '知情', change: '知道主角在撒谎', permanent: false },
        ],
      }),
    ])
    const lead = state.characters.find((c) => c.name === '主角')
    expect(lead?.location).toBe('档案室')
    expect(lead?.knows).toBe('已知账本是伪造的；尚不知弟弟还活着')
    // A knowledge change is not an injury: it must not land in condition.
    expect(lead?.condition).toBe('')
    expect(state.characters.find((c) => c.name === '配角')?.knows).toBe('知道主角在撒谎')
  })

  it('keeps the last knowledge change per character', () => {
    const state = rebuildStoryState([
      summary('ch1', {
        stateChanges: [
          { entity: '主角', aspect: 'knowledge', change: '怀疑账本', permanent: false },
        ],
      }),
      summary('ch2', {
        stateChanges: [
          { entity: '主角', aspect: 'knowledge', change: '确认账本伪造', permanent: false },
        ],
      }),
    ])
    expect(state.characters[0]?.knows).toBe('确认账本伪造')
  })

  it('formats an archive written before knowledge was tracked', () => {
    // story-state.json written by an older build has no `knows` field at all;
    // the formatter must not print an empty label or crash.
    const legacy = {
      version: 1,
      upToChapterId: 'ch1',
      updatedAt: 1,
      characters: [
        {
          name: '主角',
          location: '森林',
          condition: '',
          possessions: '',
          goals: '',
          relations: '',
        },
      ],
      worldState: [],
      openThreads: [],
      currentEndState: '',
    } as unknown as StoryState
    expect(formatStoryState(legacy, labels)).toBe('- 主角：所在位置：森林')
  })

  it('keeps unresolved threads and drops resolved ones via substring match', () => {
    const state = rebuildStoryState([
      summary('ch1', { plantedThreads: ['城门口的守卫见过主角的脸'], resolvedThreads: [] }),
      summary('ch2', {
        plantedThreads: ['那把断剑的来历'],
        resolvedThreads: ['断剑是主角父亲的遗物'],
      }),
      // 兑现措辞是埋设句的子串（prompt 要求尽量沿用原话），可被匹配
      summary('ch3', { resolvedThreads: ['守卫见过主角的脸'] }),
    ])
    expect(state.openThreads).toEqual(['那把断剑的来历'])
  })

  it('returns an empty archive for no summaries', () => {
    const state = rebuildStoryState([])
    expect(state.characters).toEqual([])
    expect(state.worldState).toEqual([])
    expect(state.openThreads).toEqual([])
    expect(state.upToChapterId).toBeNull()
    expect(state.currentEndState).toBe('')
  })
})

describe('formatStoryState', () => {
  it('renders every character fact under its own label', () => {
    const state: StoryState = {
      version: 1,
      upToChapterId: 'ch1',
      updatedAt: 1,
      characters: [
        {
          name: '主角',
          location: '森林',
          condition: '重伤濒死',
          possessions: '黄铜钥匙',
          goals: '找到父亲',
          relations: '与守卫敌对',
          knows: '已知账本是伪造的；尚不知弟弟还活着',
        },
      ],
      worldState: ['王国陷入内战'],
      openThreads: ['断剑的来历'],
      currentEndState: '夜，森林，主角独自一人。',
    }
    const text = formatStoryState(state, labels)
    expect(text).toContain('当前场景：夜，森林，主角独自一人。')
    expect(text).toContain(
      '主角：伤势/体力：重伤濒死；所在位置：森林；随身携带：黄铜钥匙；目标：找到父亲；关系：与守卫敌对；知情：已知账本是伪造的；尚不知弟弟还活着',
    )
    expect(text).toContain('世界局势：王国陷入内战')
    expect(text).toContain('未兑现伏笔：断剑的来历')
  })

  it('never labels carried items, goals, or relations as injuries', () => {
    // The condition label used to be reused for possessions/goals/relations, so
    // this block read "伤势/体力：黄铜钥匙" — mislabelled hard constraints.
    const state: StoryState = {
      version: 1,
      upToChapterId: 'ch1',
      updatedAt: 1,
      characters: [
        {
          name: '主角',
          location: '',
          condition: '',
          possessions: '黄铜钥匙',
          goals: '找到父亲',
          relations: '与守卫敌对',
          knows: '',
        },
      ],
      worldState: [],
      openThreads: [],
      currentEndState: '',
    }
    const text = formatStoryState(state, labels)
    expect(text).toBe('- 主角：随身携带：黄铜钥匙；目标：找到父亲；关系：与守卫敌对')
    expect(text).not.toContain('伤势/体力')
  })
})

describe('buildMemoryLayers', () => {
  const novel = novelWithChapters(6)

  it('only uses summaries before the active chapter, ordered by reading order', () => {
    const summaries = [summary('ch3'), summary('ch1'), summary('ch6'), summary('ch2')]
    const layers = buildMemoryLayers(summaries, rebuildStoryState(summaries), novel, 'ch4', labels)
    // ch6 is after ch4 and must be excluded; ch1..ch3 stay in reading order.
    expect(layers.summaryCount).toBe(3)
    const positions = ['ch1', 'ch2', 'ch3'].map((id) => layers.recentText.indexOf(id))
    expect(positions[0]).toBeLessThan(positions[1])
    expect(positions[1]).toBeLessThan(positions[2])
    expect(layers.recentText).not.toContain('ch6')
  })

  it('puts the last 3 chapters in recent (full) and older ones in distant (one line)', () => {
    const summaries = ['ch1', 'ch2', 'ch3', 'ch4', 'ch5'].map((id) => summary(id))
    const layers = buildMemoryLayers(
      summaries,
      rebuildStoryState(summaries),
      novel,
      'ch6',
      labels,
      {
        recentCount: 3,
      },
    )
    expect(layers.recentText).toContain('ch3 的摘要')
    expect(layers.recentText).toContain('ch5 的摘要')
    expect(layers.recentText).toContain('当前场景：ch3 章末')
    // 远期浓缩以 novel 标题开头，且只有一行概括（不含 endState 细节）
    expect(layers.distantText).toContain('- Chapter 1：')
    expect(layers.distantText).toContain('- Chapter 2：')
    expect(layers.distantText).not.toContain('当前场景：')
  })

  it('truncates distant lines head-first, keeping the closest distant chapters', () => {
    const summaries = ['ch1', 'ch2', 'ch3', 'ch4', 'ch5', 'ch6'].map((id) => summary(id))
    const layers = buildMemoryLayers(
      summaries,
      rebuildStoryState(summaries),
      novel,
      'ch7',
      labels,
      {
        recentCount: 2,
        budget: 200,
      },
    )
    expect(layers.truncated).toBe(true)
    // Distant chapters are ch1..ch4; closest distant first means ch4 survives before ch1.
    const idx4 = layers.distantText.indexOf('ch4')
    const idx1 = layers.distantText.indexOf('ch1')
    expect(idx4).not.toBe(-1)
    expect(idx1).toBe(-1)
  })

  it('keeps the state block and recent summaries, dropping distant when over budget', () => {
    const state: StoryState = {
      version: 1,
      upToChapterId: 'ch2',
      updatedAt: 1,
      characters: [
        {
          name: '主角',
          location: 'A'.repeat(400),
          condition: 'B'.repeat(400),
          possessions: '',
          goals: '',
          relations: '',
          knows: '',
        },
      ],
      worldState: [],
      openThreads: [],
      currentEndState: 'C'.repeat(400),
    }
    const layers = buildMemoryLayers(
      [summary('ch1'), summary('ch2')],
      state,
      novel,
      'ch3',
      labels,
      {
        budget: 300,
      },
    )
    expect(layers.truncated).toBe(true)
    // 状态档案完整保留
    expect(layers.stateText.length).toBeGreaterThan(900)
    // 近期摘要完整保留（优先级高于远期浓缩）
    expect(layers.recentText).toContain('ch2 的摘要')
    // 远期浓缩整体让位
    expect(layers.distantText).toBe('')
  })

  it('counts stale summaries when the source prose fingerprint changed', () => {
    const prose = '第一章的正文。'.repeat(20)
    const s = summary('ch1', { sourceFingerprint: storyMemoryFingerprint(prose) })
    const layers = buildMemoryLayers([s], rebuildStoryState([s]), novel, 'ch2', labels, {
      sourceTexts: new Map([['ch1', prose + ' 改了']]),
    })
    expect(layers.staleCount).toBe(1)
    const fresh = buildMemoryLayers([s], rebuildStoryState([s]), novel, 'ch2', labels, {
      sourceTexts: new Map([['ch1', prose]]),
    })
    expect(fresh.staleCount).toBe(0)
  })

  it('does not filter out chapters when the active chapter is unknown', () => {
    const summaries = [summary('ch1'), summary('ch2')]
    const layers = buildMemoryLayers(
      summaries,
      rebuildStoryState(summaries),
      novel,
      'unknown-id',
      labels,
    )
    expect(layers.summaryCount).toBe(2)
  })
})

describe('buildMemoryLayers + orderedChapters integration', () => {
  it('uses novel chapter titles in the memory text', () => {
    const novel = {
      title: 'Test',
      author: '',
      synopsis: '',
      tags: [],
      volumes: [
        {
          id: 'v1',
          order: 0,
          title: 'Volume 1',
          chapters: [chapter('ch1', 0)],
        },
      ],
    } as unknown as NovelMeta
    const ordered = orderedChapters(novel)
    expect(ordered[0].chapter.title).toBe('Chapter 1')
  })
})
