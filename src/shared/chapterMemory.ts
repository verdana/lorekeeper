import type {
  ChapterSummary,
  NovelMeta,
  StoryCharacterState,
  StoryState,
  StoryStateChange,
} from './types'
import { orderedChapters, storyMemoryFingerprint } from './storyMemory'

// ---- AI 输出解析 ----

export interface ParsedChapterSummaryPayload {
  summary: string
  endState: string
  stateChanges: StoryStateChange[]
  plantedThreads: string[]
  resolvedThreads: string[]
}

const cap = (value: unknown, max: number): string => {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, max)
}

const capList = (value: unknown, max: number): string[] => {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => cap(item, max))
    .filter((s) => s.length > 0)
    .slice(0, 12)
}

/**
 * 解析 AI 返回的章节摘要 JSON（容忍 Markdown 代码块包裹），
 * 只保留字段类型正确的内容，丢弃残缺候选。
 */
export function parseChapterSummaryPayload(raw: string): ParsedChapterSummaryPayload {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  const value = JSON.parse(fenced ?? raw) as Record<string, unknown>
  if (!value || typeof value !== 'object') {
    throw new Error('The AI did not return a chapter summary object.')
  }
  const stateChanges: StoryStateChange[] = Array.isArray(value.stateChanges)
    ? value.stateChanges
        .flatMap((c): StoryStateChange[] => {
          if (!c || typeof c !== 'object') return []
          const item = c as Record<string, unknown>
          const entity = cap(item.entity, 80)
          const aspect = cap(item.aspect, 40)
          const change = cap(item.change, 300)
          if (!entity || !aspect || !change) return []
          return [{ entity, aspect, change, permanent: item.permanent === true }]
        })
        .slice(0, 20)
    : []
  return {
    summary: cap(value.summary, 600),
    endState: cap(value.endState, 400),
    stateChanges,
    plantedThreads: capList(value.plantedThreads, 200),
    resolvedThreads: capList(value.resolvedThreads, 200),
  }
}

// ---- 状态档案累积（纯代码，从摘要重建）----

/** aspect 文本 → 角色状态槽位。未命中的维度记入 condition。 */
const SLOT_BY_ASPECT: Record<string, keyof StoryCharacterState> = {
  location: 'location',
  位置: 'location',
  地点: 'location',
  所在: 'location',
  condition: 'condition',
  状态: 'condition',
  伤势: 'condition',
  体力: 'condition',
  健康: 'condition',
  生死: 'condition',
  possession: 'possessions',
  物品: 'possessions',
  携带: 'possessions',
  装备: 'possessions',
  goal: 'goals',
  目标: 'goals',
  relation: 'relations',
  关系: 'relations',
}

const normalizeThread = (value: string): string =>
  value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

/**
 * 从按阅读顺序排列的摘要列表重建当前故事状态档案：
 * - 每个角色每个状态维度取「最后一次」变化作为当前值；
 * - 「世界」主体的变化归入 worldState；
 * - openThreads = 所有 plantedThreads 中未被 resolvedThreads 兑现的（子串匹配）。
 */
export function rebuildStoryState(summaries: ChapterSummary[]): StoryState {
  const chars = new Map<string, StoryCharacterState>()
  const worldByAspect = new Map<string, string>()
  const planted: string[] = []
  const resolved: string[] = []
  let last: ChapterSummary | null = null

  for (const summary of summaries) {
    last = summary
    for (const change of summary.stateChanges) {
      if (change.entity === '世界' || change.entity === '世界局势') {
        worldByAspect.set(change.aspect, change.change)
        continue
      }
      const slot = SLOT_BY_ASPECT[change.aspect]
      const char = chars.get(change.entity) ?? {
        name: change.entity,
        location: '',
        condition: '',
        possessions: '',
        goals: '',
        relations: '',
      }
      if (slot) char[slot] = change.change
      else if (!char.condition) char.condition = change.change
      chars.set(change.entity, char)
    }
    planted.push(...summary.plantedThreads)
    resolved.push(...summary.resolvedThreads)
  }

  const resolvedNorm = resolved.map(normalizeThread).filter((t) => t.length >= 4)
  const openThreads = [...new Set(planted)].filter((text) => {
    const n = normalizeThread(text)
    if (n.length < 4) return false
    return !resolvedNorm.some((rn) => n.includes(rn) || rn.includes(n))
  })

  return {
    version: 1,
    upToChapterId: last?.chapterId ?? null,
    updatedAt: Date.now(),
    characters: [...chars.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN')),
    worldState: [...worldByAspect.values()].filter((s) => s.length > 0),
    openThreads,
    currentEndState: last?.endState ?? '',
  }
}

// ---- 分层记忆组装 ----

/** 分层记忆各区块的文案标签（来自 PROMPTS，随语言切换）。 */
export interface MemoryLayerLabels {
  state: string
  stateHint: string
  characters: string
  worldState: string
  openThreads: string
  currentScene: string
  recent: string
  distant: string
}

export interface MemoryLayerOptions {
  /** 当前章之前最近 N 章给完整摘要（默认 3）。 */
  recentCount?: number
  /** 状态清单 + 近期摘要 + 远期浓缩的总预算（字符，默认 7500）。 */
  budget?: number
  /** chapterId → 已保存正文，用于统计过期摘要。 */
  sourceTexts?: Map<string, string>
}

export interface MemoryLayers {
  /** 当前故事状态（硬约束，优先保证完整）。 */
  stateText: string
  /** 近期章节摘要。 */
  recentText: string
  /** 远期章节一行浓缩。 */
  distantText: string
  /** 当前章之前有摘要的章节数。 */
  summaryCount: number
  /** 其中过期（正文已改动）的摘要数。 */
  staleCount: number
  truncated: boolean
}

/** 把状态档案格式化为 prompt 文本。 */
export function formatStoryState(state: StoryState, labels: MemoryLayerLabels): string {
  const parts: string[] = []
  if (state.currentEndState.trim()) {
    parts.push(`- ${labels.currentScene}：${state.currentEndState.trim()}`)
  }
  for (const char of state.characters) {
    const facts: string[] = []
    if (char.condition.trim()) facts.push(`${labels.characters}：${char.condition.trim()}`)
    if (char.location.trim()) facts.push(`${labels.currentScene}：${char.location.trim()}`)
    if (char.possessions.trim()) facts.push(`${labels.characters}：${char.possessions.trim()}`)
    if (char.goals.trim()) facts.push(`${labels.characters}：${char.goals.trim()}`)
    if (char.relations.trim()) facts.push(`${labels.characters}：${char.relations.trim()}`)
    if (facts.length > 0) parts.push(`- ${char.name}：${facts.join('；')}`)
  }
  for (const ws of state.worldState) {
    if (ws.trim()) parts.push(`- ${labels.worldState}：${ws.trim()}`)
  }
  for (const thread of state.openThreads) {
    if (thread.trim()) parts.push(`- ${labels.openThreads}：${thread.trim()}`)
  }
  return parts.join('\n')
}

const firstSentence = (text: string, max: number): string => {
  const first = text.split(/(?<=[。！？.!?])\s*/)[0]?.trim() ?? text.trim()
  return first.length > max ? `${first.slice(0, max)}…` : first
}

/**
 * 把当前章之前的摘要组装为三层记忆：
 * 1. 状态档案（硬约束，全量优先）；
 * 2. 最近 recentCount 章完整摘要；
 * 3. 更早章节每章一行浓缩（head-first 保留较近的远期）。
 */
export function buildMemoryLayers(
  summaries: ChapterSummary[],
  state: StoryState,
  novel: NovelMeta,
  activeChapterId: string,
  labels: MemoryLayerLabels,
  options: MemoryLayerOptions = {},
): MemoryLayers {
  const recentCount = options.recentCount ?? 3
  const budget = options.budget ?? 7500
  const sourceTexts = options.sourceTexts

  const ordered = orderedChapters(novel)
  const positionByChapter = new Map(ordered.map((item) => [item.chapter.id, item.index]))
  const activeIndex = positionByChapter.get(activeChapterId)
  const titled = new Map(ordered.map((item) => [item.chapter.id, item.chapter.title]))

  // 只取当前章之前的摘要，按阅读顺序排列。
  const prior = summaries
    .filter((s) => {
      const pos = positionByChapter.get(s.chapterId)
      return pos !== undefined && (activeIndex === undefined || pos < activeIndex)
    })
    .sort(
      (a, b) =>
        (positionByChapter.get(a.chapterId) ?? 0) - (positionByChapter.get(b.chapterId) ?? 0),
    )

  let staleCount = 0
  if (sourceTexts) {
    for (const s of prior) {
      const text = sourceTexts.get(s.chapterId)
      if (text === undefined || storyMemoryFingerprint(text) !== s.sourceFingerprint) staleCount++
    }
  }

  const stateText = formatStoryState(state, labels)

  const recent = prior.slice(-recentCount)
  const distant = prior.slice(0, Math.max(0, prior.length - recentCount))

  const recentText = recent
    .map((s) => {
      const title = titled.get(s.chapterId) ?? s.chapterTitle
      const head = [`### ${title}`, s.summary.trim()].filter(Boolean).join('\n')
      return s.endState.trim() ? `${head}\n${labels.currentScene}：${s.endState.trim()}` : head
    })
    .join('\n\n')

  const distantLines = distant
    .map((s) => {
      const title = titled.get(s.chapterId) ?? s.chapterTitle
      return `- ${title}：${firstSentence(s.summary, 50)}`
    })
    // 较近的远期在前：预算不足时 head-first 保留的是对当前写作更有用的章节。
    .reverse()

  // 预算分配：状态档案全量优先，其次近期摘要，最后远期浓缩。
  // 近期与状态都放不下时，远期浓缩整体让位（后续 allocator 层还会再截断）。
  let truncated = false
  let distantText = ''
  const remaining = budget - stateText.length - recentText.length
  if (remaining >= 0) {
    distantText = distantLines.join('\n')
    if (distantText.length > remaining) {
      truncated = true
      // head-first：保留较近的远期章节。
      const keep: string[] = []
      let used = 0
      for (const line of distantLines) {
        const sep = keep.length === 0 ? 0 : 1
        if (used + sep + line.length > remaining) break
        keep.push(line)
        used += sep + line.length
      }
      distantText = keep.join('\n')
    }
  } else {
    truncated = true
  }

  return {
    stateText,
    recentText,
    distantText,
    summaryCount: prior.length,
    staleCount,
    truncated,
  }
}
