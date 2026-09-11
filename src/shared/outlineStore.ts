/**
 * Structured outline: parsing, normalization, AI serialization, chapter-beats
 * lookup, and novel.json sync. The outline store is the single source of truth
 * for structure; novel.json mirrors its ids/titles/order and carries prose
 * state (file, wordCount, status, updatedAt).
 */

import type {
  Chapter,
  ChapterContract,
  ChapterScene,
  NovelMeta,
  OutlineBeat,
  OutlineChapterData,
  OutlineStore,
  OutlineVolumeData,
  OutlineVolumeStatus,
  Volume,
} from './types'
import { uid } from './uid'

const OUTLINE_VOLUME_STATUSES: OutlineVolumeStatus[] = ['planned', 'planning', 'confirmed']

const isOutlineVolumeStatus = (v: unknown): v is OutlineVolumeStatus =>
  typeof v === 'string' && (OUTLINE_VOLUME_STATUSES as string[]).includes(v)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

export function emptyOutlineStore(): OutlineStore {
  return { version: 1, updatedAt: Date.now(), overview: '', notes: '', volumes: [] }
}

/** 当未显式设置状态时，由内容推导：无章 → planned；全章已确认 → confirmed；其余 → planning。 */
/** 仅由内容推导状态：无章 → planned；全章已确认 → confirmed；其余 → planning。 */
function deriveStatusFromContent(v: Pick<OutlineVolumeData, 'chapters'>): OutlineVolumeStatus {
  if (v.chapters.length === 0) return 'planned'
  return v.chapters.every((c) => c.status === 'confirmed') ? 'confirmed' : 'planning'
}

export function deriveVolumeStatus(v: OutlineVolumeData): OutlineVolumeStatus {
  // 显式状态优先；未设置时由内容推导。
  if (isOutlineVolumeStatus(v.status)) return v.status
  return deriveStatusFromContent(v)
}

function normalizeBeat(raw: unknown): OutlineBeat | null {
  if (!isRecord(raw)) return null
  return { title: str(raw.title), summary: str(raw.summary) }
}

/** The authored decisions for one chapter, in the order a draft needs them. */
export const CONTRACT_FIELDS: ReadonlyArray<{ id: keyof ChapterContract; label: string }> = [
  { id: 'event', label: 'Required event' },
  { id: 'goal', label: 'Viewpoint goal' },
  { id: 'entryState', label: 'Entry state' },
  { id: 'exitState', label: 'Exit state' },
  { id: 'protectedReveals', label: 'Must not be revealed yet' },
]

const EMPTY_CONTRACT: ChapterContract = {
  event: '',
  goal: '',
  entryState: '',
  exitState: '',
  protectedReveals: '',
}

/**
 * Read a contract off untrusted input. An all-empty contract normalizes to
 * `undefined` rather than an object of blanks, so "no contract" has one
 * representation on disk and nothing has to guess whether the author meant it.
 */
export function normalizeChapterContract(raw: unknown): ChapterContract | undefined {
  if (!isRecord(raw)) return undefined
  const contract: ChapterContract = {
    event: str(raw.event).trim(),
    goal: str(raw.goal).trim(),
    entryState: str(raw.entryState).trim(),
    exitState: str(raw.exitState).trim(),
    protectedReveals: str(raw.protectedReveals).trim(),
  }
  return hasChapterContract(contract) ? contract : undefined
}

/** The contract's fields, all present, whether or not the chapter has one. */
export function chapterContract(chapter: Pick<OutlineChapterData, 'contract'>): ChapterContract {
  return { ...EMPTY_CONTRACT, ...(chapter.contract ?? {}) }
}

export function hasChapterContract(contract: ChapterContract | undefined): boolean {
  if (!contract) return false
  return CONTRACT_FIELDS.some(({ id }) => (contract[id] ?? '').trim().length > 0)
}

/** The scene fields, in the order a scene is planned and drafted. */
export const SCENE_FIELDS: ReadonlyArray<{ id: SceneTextField; label: string }> = [
  { id: 'purpose', label: 'Purpose' },
  { id: 'goal', label: 'Wants' },
  { id: 'obstacle', label: 'Obstacle' },
  { id: 'turn', label: 'Turn' },
  { id: 'exitState', label: 'Leaves them' },
]

/** The scene fields that hold prose, as opposed to its title and beat links. */
type SceneTextField = 'purpose' | 'goal' | 'obstacle' | 'turn' | 'exitState'

/**
 * Read one scene off untrusted input.
 *
 * A scene the author named is kept even if its fields are still blank — that is
 * a sketch. A row with no text at all is dropped: it would cost a model call in
 * the scene-by-scene draft and produce nothing.
 */
export function normalizeChapterScene(raw: unknown, index: number): ChapterScene | null {
  if (!isRecord(raw)) return null
  const rawTitle = str(raw.title).trim()
  const scene: ChapterScene = {
    id: str(raw.id).trim() || uid('sc_'),
    title: rawTitle || `Scene ${index + 1}`,
    purpose: str(raw.purpose).trim(),
    goal: str(raw.goal).trim(),
    obstacle: str(raw.obstacle).trim(),
    turn: str(raw.turn).trim(),
    exitState: str(raw.exitState).trim(),
    beats: Array.isArray(raw.beats)
      ? [
          ...new Set(
            raw.beats
              .map((n) => (typeof n === 'number' ? Math.trunc(n) : Number.parseInt(str(n), 10)))
              .filter((n) => Number.isFinite(n) && n > 0),
          ),
        ].sort((a, b) => a - b)
      : [],
  }
  const hasText = rawTitle.length > 0 || SCENE_FIELDS.some(({ id }) => scene[id].length > 0)
  return hasText ? scene : null
}

export function normalizeChapterScenes(raw: unknown): ChapterScene[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const scenes = raw
    .map((scene, index) => normalizeChapterScene(scene, index))
    .filter((scene): scene is ChapterScene => scene !== null)
  return scenes.length > 0 ? scenes : undefined
}

/** The chapter's scenes, or an empty list when its blueprint was cleared. */
export function chapterScenes(chapter: Pick<OutlineChapterData, 'scenes'>): ChapterScene[] {
  return chapter.scenes ?? []
}

/**
 * The chapter's blueprint as a compact numbered list.
 *
 * This is what the whole-chapter prompt carries, so a chapter drafted in one
 * pass still follows the scene chain rather than re-deriving it.
 */
export function serializeSceneList(scenes: ChapterScene[] | undefined): string {
  if (!scenes || scenes.length === 0) return ''
  return scenes
    .map((scene, index) => {
      const parts = SCENE_FIELDS.flatMap(({ id, label }) => {
        const value = scene[id].trim()
        return value ? [`${label}: ${value}`] : []
      })
      const beats = scene.beats.length > 0 ? [`Lands beats: ${scene.beats.join(', ')}`] : []
      const body = [...parts, ...beats].join(' | ')
      return `${index + 1}. ${scene.title}${body ? ` — ${body}` : ''}`
    })
    .join('\n')
}

/** One scene in full, for the prompt that drafts only that scene. */
export function serializeScene(scene: ChapterScene, index: number, total: number): string {
  const lines = [`Scene ${index + 1} of ${total}: ${scene.title}`]
  for (const { id, label } of SCENE_FIELDS) {
    const value = scene[id].trim()
    if (value) lines.push(`- ${label}: ${value}`)
  }
  if (scene.beats.length > 0) lines.push(`- Beats this scene must land: ${scene.beats.join(', ')}`)
  return lines.join('\n')
}

function normalizeChapter(raw: unknown): OutlineChapterData | null {
  if (!isRecord(raw)) return null
  const id = str(raw.id)
  if (!id) return null
  const beats = Array.isArray(raw.beats)
    ? raw.beats.map(normalizeBeat).filter((b): b is OutlineBeat => b !== null)
    : []
  return {
    id,
    title: str(raw.title),
    status: raw.status === 'confirmed' ? 'confirmed' : 'planned',
    beats,
    contract: normalizeChapterContract(raw.contract),
    scenes: normalizeChapterScenes(raw.scenes),
  }
}

function normalizeVolume(raw: unknown): OutlineVolumeData | null {
  if (!isRecord(raw)) return null
  const id = str(raw.id)
  if (!id) return null
  const chapters = Array.isArray(raw.chapters)
    ? raw.chapters.map(normalizeChapter).filter((c): c is OutlineChapterData => c !== null)
    : []
  return {
    id,
    title: str(raw.title),
    summary: str(raw.summary),
    config: str(raw.config),
    status: isOutlineVolumeStatus(raw.status) ? raw.status : deriveStatusFromContent({ chapters }),
    chapters,
  }
}

/** 校验并规范化外部读入的 store（容忍缺失字段/未知字段；丢弃无效 id 条目）。 */
export function normalizeOutlineStore(raw: unknown): OutlineStore {
  if (!isRecord(raw)) return emptyOutlineStore()
  const volumes = Array.isArray(raw.volumes)
    ? raw.volumes.map(normalizeVolume).filter((v): v is OutlineVolumeData => v !== null)
    : []
  return {
    version: 1,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
    overview: str(raw.overview),
    notes: str(raw.notes),
    volumes,
  }
}

/** 按全局阅读顺序给每章编号（跨卷连续，如卷1为第1-10章、卷2为第11-20章）。 */
export function outlineChapterOrdinals(store: OutlineStore): Map<string, number> {
  const map = new Map<string, number>()
  let ordinal = 0
  for (const v of store.volumes) {
    for (const c of v.chapters) {
      ordinal += 1
      map.set(c.id, ordinal)
    }
  }
  return map
}

/** 直接按 id 查找大纲章节（大纲 id 与 novel.json Chapter.id 一致）。 */
export function findOutlineChapter(
  store: OutlineStore,
  chapterId: string,
): OutlineChapterData | null {
  for (const v of store.volumes) {
    const found = v.chapters.find((c) => c.id === chapterId)
    if (found) return found
  }
  return null
}

/** 章节要点序列化为「- 标题：正文」行（供 AI 的「本章大纲」层注入）。 */
export function serializeChapterBeats(chapter: OutlineChapterData): string {
  if (chapter.beats.length === 0) return ''
  return chapter.beats
    .map((b) => {
      const t = b.title.trim()
      const s = b.summary.trim()
      if (t && s) return `- ${t}：${s}`
      if (t) return `- ${t}`
      if (s) return `- ${s}`
      return '-'
    })
    .join('\n')
}

export interface ChapterOutlineOptions {
  /** 卷内相邻章节标题行数（当前章前后各 N 章），默认 5。 */
  neighborRadius?: number
}

/**
 * The author's decisions for a chapter, as a labelled block for a prompt.
 *
 * It is emitted wherever a chapter's outline is emitted, so an author who sets
 * a contract once does not have to remember which drafting path reads it: the
 * Forge's chapter prompt, the rewrite prompt, the consistency check and the
 * memory step all see the same block.
 */
export function serializeChapterContract(contract: ChapterContract | undefined): string {
  if (!hasChapterContract(contract)) return ''
  const lines = CONTRACT_FIELDS.flatMap(({ id, label }) => {
    const value = (contract?.[id] ?? '').trim()
    return value ? [`- ${label}: ${value}`] : []
  })
  return ['Chapter contract (author decisions, binding):', ...lines].join('\n')
}

/**
 * 按章节 id 从结构化大纲定向构建 AI 的「情节大纲」层：全书 overview +
 * 当前章所在卷（标题/简介）+ 当前章要点全文 + 卷内相邻章标题行。
 * 与 serializeOutlineForAI 不同，它不依赖长文本头部截断——无论当前章
 * 在 50 章还是 110 章之后，其要点都能完整进入上下文。找不到章节时
 * 回退到全量序列化文本。
 */
export function serializeChapterOutline(
  store: OutlineStore,
  chapterId: string,
  opts: ChapterOutlineOptions = {},
): string {
  const { neighborRadius = 5 } = opts
  const chapter = findOutlineChapter(store, chapterId)
  if (!chapter) return serializeOutlineForAI(store)
  const volume = store.volumes.find((v) => v.chapters.some((c) => c.id === chapterId))
  if (!volume) return serializeOutlineForAI(store)

  const ordinals = outlineChapterOrdinals(store)
  const lines: string[] = ['# Plot Outline']
  if (store.overview.trim()) lines.push('', store.overview.trim())

  const firstOrd = volume.chapters.length > 0 ? (ordinals.get(volume.chapters[0].id) ?? 0) : 0
  const lastOrd =
    volume.chapters.length > 0
      ? (ordinals.get(volume.chapters[volume.chapters.length - 1].id) ?? 0)
      : 0
  const range = volume.chapters.length > 0 ? `（第${firstOrd}-${lastOrd}章）` : ''
  lines.push('', `## ${volume.title.trim() || 'Volume'}${range}`)
  if (volume.summary.trim()) lines.push('', `本卷简介：${volume.summary.trim()}`)

  const index = volume.chapters.findIndex((c) => c.id === chapterId)
  const from = Math.max(0, index - neighborRadius)
  const to = Math.min(volume.chapters.length - 1, index + neighborRadius)
  for (let i = from; i <= to; i += 1) {
    const c = volume.chapters[i]
    lines.push('', `### ${c.title.trim()}`)
    if (i === index) {
      lines.push(serializeChapterBeats(c) || '- （暂无要点）')
      const contract = serializeChapterContract(c.contract)
      if (contract) lines.push('', contract)
      const scenes = serializeSceneList(c.scenes)
      if (scenes) lines.push('', 'Scene blueprint (draft in this order):', scenes)
    } else {
      lines.push('- （略）')
    }
  }
  return lines.join('\n')
}

/**
 * 派生 AI 使用的全文大纲文本：确定性、有序、无杂质（不含讨论结论/备注/卷配置）。
 * 消费方：readOutline()、大纲导出、AI 写作上下文。
 */
export function serializeOutlineForAI(store: OutlineStore): string {
  const lines: string[] = ['# Plot Outline']
  if (store.overview.trim()) lines.push('', store.overview.trim())
  const ordinals = outlineChapterOrdinals(store)
  store.volumes.forEach((vol, vi) => {
    const first = vol.chapters.length > 0 ? (ordinals.get(vol.chapters[0].id) ?? 0) : 0
    const last =
      vol.chapters.length > 0 ? (ordinals.get(vol.chapters[vol.chapters.length - 1].id) ?? 0) : 0
    const range = vol.chapters.length > 0 ? `（第${first}-${last}章）` : ''
    lines.push('', `## ${vi + 1} · ${vol.title.trim() || `Volume ${vi + 1}`}${range}`)
    if (vol.summary.trim()) lines.push('', `本卷简介：${vol.summary.trim()}`)
    for (const ch of vol.chapters) {
      lines.push('', `### ${ch.title.trim()}`)
      const beats = serializeChapterBeats(ch)
      lines.push(beats || '- （暂无要点）')
      const contract = serializeChapterContract(ch.contract)
      if (contract) lines.push('', contract)
      const scenes = serializeSceneList(ch.scenes)
      if (scenes) lines.push('', 'Scene blueprint (draft in this order):', scenes)
    }
  })
  return lines.join('\n')
}

// ---- Legacy Markdown parsing (best-effort, lossless-by-default) ----

export interface ParsedLegacyVolume {
  title: string
  summary: string
  config: string
  chapters: { title: string; beats: OutlineBeat[] }[]
}

export interface ParsedLegacyOutline {
  overview: string
  volumes: ParsedLegacyVolume[]
  notes: string
}

const CN_DIGITS: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
}

/** 「第12章」「第三章」「第二十章」等 → 12 / 3 / 20；无法解析返回 null。 */
function chineseNumeralToInt(s: string): number | null {
  if (/^\d+$/.test(s)) return Number(s)
  if (s === '十') return 10
  if (s.length === 2 && s[0] === '十' && CN_DIGITS[s[1]] !== undefined) return 10 + CN_DIGITS[s[1]]
  if (s.length === 2 && CN_DIGITS[s[0]] !== undefined && s[1] === '十') return CN_DIGITS[s[0]] * 10
  if (s.length === 3 && CN_DIGITS[s[0]] !== undefined && s[1] === '十')
    return CN_DIGITS[s[0]] * 10 + (CN_DIGITS[s[2]] ?? 0)
  if (s.length === 1 && CN_DIGITS[s] !== undefined) return CN_DIGITS[s]
  return null
}

const CHAPTER_HEADING = /^#{3,4}\s+(第\s*[0-9零一二三四五六七八九十百]+\s*章)/

const isChapterHeading = (line: string): boolean => CHAPTER_HEADING.test(line)

const stripEmphasis = (text: string): string => text.replace(/\*\*/g, '').replace(/\*/g, '').trim()

/** 一行 bullet → 一个要点：标题取到第一个「：」/「:」为止，其余为正文。 */
function bulletToBeat(line: string): OutlineBeat {
  const body = line.replace(/^[-*•]\s*/, '').trim()
  const sep = body.search(/[：:]/)
  if (sep === -1) return { title: stripEmphasis(body), summary: '' }
  return { title: stripEmphasis(body.slice(0, sep)), summary: body.slice(sep + 1).trim() }
}

/**
 * 把旧版大纲 Markdown 解析为结构化计划（纯解析，不做任何写盘）。
 * 规则：
 * - 第一个 H2 之前的内容 → overview；
 * - H2 小节：其下含「第N章」标题的 → 卷（H2 与首个章标题之间的内容 → 卷简介，
 *   章标题之后的非章 H3/H4 小节 → 卷配置）；其下不含「第N章」的 → 并入 overview
 *   （如「大事件宏观规划」这类顶层规划段；其中的非章 H3/H4 子标题同样并入
 *   overview，不会把该 H2 误判为卷）；
 * - H3/H4 且含「第N章」（支持中文数字，如「第一章」）→ 章；只有章标题能确立卷；
 * - 章标题与下一标题之间的内容 → 要点（按行拆分 bullet，非 bullet 续行并入上一条）。
 */
export function parseLegacyOutline(text: string): ParsedLegacyOutline {
  const overview: string[] = []
  const volumes: ParsedLegacyVolume[] = []
  const notes: string[] = []
  // 已看到但尚未判定为卷的 H2 小节（等待其下是否出现章标题）
  let candidate: { title: string; lines: string[] } | null = null
  let volume: ParsedLegacyVolume | null = null
  let volumeSummarySet = false
  let chapter: { title: string; beats: OutlineBeat[] } | null = null
  let current: string[] = [] // 当前待归属的正文行

  const flushBody = (): void => {
    if (current.length === 0) return
    const body = current.join('\n').trim()
    current = []
    if (!body) return
    if (chapter) {
      const bullets = body.split('\n').filter((l) => /^\s*[-*•]\s+/.test(l))
      if (bullets.length > 0) {
        for (const line of body.split('\n')) {
          if (/^\s*[-*•]\s+/.test(line)) {
            chapter.beats.push(bulletToBeat(line))
          } else if (chapter.beats.length > 0 && line.trim()) {
            const last = chapter.beats[chapter.beats.length - 1]
            last.summary = last.summary ? `${last.summary}\n${line.trim()}` : line.trim()
          } else if (line.trim()) {
            chapter.beats.push({ title: '', summary: line.trim() })
          }
        }
      } else {
        chapter.beats.push({ title: '', summary: body })
      }
    } else if (volume) {
      if (!volumeSummarySet) {
        volume.summary = body
        volumeSummarySet = true
      } else {
        volume.config = volume.config ? `${volume.config}\n\n${body}` : body
      }
    } else if (candidate) {
      candidate.lines.push(body)
    } else {
      overview.push(body)
    }
  }

  /** 把仍处于候选态的 H2 小节提升为 overview 段落。 */
  const promoteCandidate = (): void => {
    if (!candidate) return
    const lines = candidate.lines.join('\n').trim()
    overview.push(lines ? `${candidate.title}\n\n${lines}` : candidate.title)
    candidate = null
  }

  /** 候选 H2 下出现章标题 → 该候选判定为卷；无候选时（章直接出现）造一个默认卷。 */
  const promoteToVolume = (): ParsedLegacyVolume => {
    if (volume) return volume
    if (candidate) {
      volume = {
        title: candidate.title,
        summary: candidate.lines.join('\n').trim(),
        config: '',
        chapters: [],
      }
      candidate = null
      volumeSummarySet = true
    } else {
      volume = { title: `Volume ${volumes.length + 1}`, summary: '', config: '', chapters: [] }
      volumeSummarySet = false
    }
    volumes.push(volume)
    return volume
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    const trimmed = line.trim()
    const h2 = /^##\s+/.test(line)
    const h3or4 = /^#{3,4}\s+/.test(line)
    if (h2) {
      flushBody()
      chapter = null
      volume = null
      promoteCandidate()
      candidate = { title: trimmed.replace(/^##\s*/, '').trim(), lines: [] }
    } else if (h3or4 && isChapterHeading(line)) {
      flushBody()
      const v = promoteToVolume()
      chapter = { title: trimmed.replace(/^#{3,4}\s*/, '').trim(), beats: [] }
      v.chapters.push(chapter)
    } else if (h3or4) {
      // 非章小节标题：不决定卷的成立——卷只能由章标题确立。
      // 已确立卷时，该标题作为卷配置正文；否则作为顶层规划正文
      // （并入候选段，随后随 H2 提升进 overview）。小节不隶属于当前章。
      flushBody()
      chapter = null
      const title = trimmed.replace(/^#{3,4}\s*/, '').trim()
      if (volume) {
        current = [title]
      } else if (candidate) {
        candidate.lines.push(title)
      } else {
        overview.push(title)
      }
    } else {
      current.push(line)
    }
  }
  flushBody()
  promoteCandidate()
  return { overview: overview.join('\n\n'), volumes, notes: notes.join('\n\n') }
}

/** 章标题里的序号（「第12章」「第三章」→ 12 / 3），用于迁移时与现有章节匹配。 */
function chapterOrdinal(title: string): number | null {
  const m = /第\s*([0-9零一二三四五六七八九十百]+)\s*章/.exec(title)
  return m ? chineseNumeralToInt(m[1]) : null
}

/** 卷标题里的序号（第一卷/卷1/1 → 1），用于迁移时与现有卷匹配。 */
function volumeOrdinal(title: string): number | null {
  const m = /第\s*([0-9零一二三四五六七八九十百]+)\s*卷/.exec(title)
  if (m) return chineseNumeralToInt(m[1])
  const plain = /(?:^|\s)(\d+)\s*(?:·|、|\.|-)?\s*$/.exec(title.trim())
  return plain ? Number(plain[1]) : null
}

/** 从现有 novel.json 结构反向构建大纲（迁移步骤：无大纲数据时的起点）。 */
export function outlineFromNovel(meta: NovelMeta): OutlineStore {
  const store = emptyOutlineStore()
  store.updatedAt = Date.now()
  store.volumes = meta.volumes.map((v) => ({
    id: v.id,
    title: v.title,
    summary: '',
    config: '',
    status: v.chapters.length > 0 ? 'planning' : 'planned',
    chapters: v.chapters.map((c) => ({
      id: c.id,
      title: c.title,
      status: 'planned',
      beats: [],
    })),
  }))
  return store
}

/**
 * 把旧版 md 计划合并进当前 novel.json 结构，产出大纲 store：
 * - 已存在的卷/章按标题（其次序号）匹配，复用其 id（保留正文关联）；
 * - md 中不存在的卷/章用新 id 追加（同步时会在 novel.json 建占位条目）。
 */
export function outlineFromLegacy(meta: NovelMeta, parsed: ParsedLegacyOutline): OutlineStore {
  const store = emptyOutlineStore()
  store.updatedAt = Date.now()
  store.overview = parsed.overview
  store.notes = parsed.notes

  const usedVolumeIds = new Set<string>()
  const usedChapterIds = new Set<string>()

  const matchVolume = (title: string, ord: number | null): Volume | undefined => {
    if (ord !== null) {
      const byOrd = meta.volumes.find((v) => volumeOrdinal(v.title) === ord)
      if (byOrd && !usedVolumeIds.has(byOrd.id)) return byOrd
    }
    const byTitle = meta.volumes.find((v) => v.title === title)
    return byTitle && !usedVolumeIds.has(byTitle.id) ? byTitle : undefined
  }

  parsed.volumes.forEach((pv) => {
    const existingVolume = matchVolume(pv.title, volumeOrdinal(pv.title))
    const volume: OutlineVolumeData = {
      id: existingVolume?.id ?? uid('v_'),
      title: existingVolume?.title ?? pv.title,
      summary: pv.summary,
      config: pv.config,
      status: pv.chapters.length > 0 ? 'planning' : 'planned',
      chapters: [],
    }
    if (existingVolume) usedVolumeIds.add(existingVolume.id)

    const matchChapter = (title: string, ord: number | null): Chapter | undefined => {
      const pool = existingVolume?.chapters ?? meta.volumes.flatMap((v) => v.chapters)
      if (ord !== null) {
        const byOrd = pool.find((c) => chapterOrdinal(c.title) === ord)
        if (byOrd && !usedChapterIds.has(byOrd.id)) return byOrd
      }
      const byTitle = pool.find((c) => c.title === title)
      return byTitle && !usedChapterIds.has(byTitle.id) ? byTitle : undefined
    }

    for (const pc of pv.chapters) {
      const existing = matchChapter(pc.title, chapterOrdinal(pc.title))
      if (existing) usedChapterIds.add(existing.id)
      volume.chapters.push({
        id: existing?.id ?? uid('c_'),
        title: existing?.title ?? pc.title,
        status: 'planned',
        beats: pc.beats,
      })
    }
    store.volumes.push(volume)
  })
  return store
}

/**
 * 用大纲结构重建 novel.json 的卷/章（id/标题/顺序以大纲为准）。
 * 已存在的章保留正文状态（file/wordCount/status/updatedAt）；新章建占位条目
 * （file 由卷/章 id 决定，幂等）；不在大纲中的卷/章从 novel.json 移除。
 * 顶层 title/author/synopsis/tags 原样保留。
 */
export function syncNovelFromOutline(meta: NovelMeta, store: OutlineStore): NovelMeta {
  const volumes: Volume[] = store.volumes.map((ov, vi) => {
    const existing = meta.volumes.find((v) => v.id === ov.id)
    const chapters: Chapter[] = ov.chapters.map((oc, ci) => {
      const prev = existing?.chapters.find((c) => c.id === oc.id)
      if (prev) {
        return { ...prev, volumeId: ov.id, title: oc.title, order: ci }
      }
      return {
        id: oc.id,
        volumeId: ov.id,
        title: oc.title,
        order: ci,
        file: `${ov.id}_${oc.id}.md`,
        wordCount: 0,
        status: 'draft',
        updatedAt: Date.now(),
      }
    })
    return { id: ov.id, title: ov.title, order: vi, chapters }
  })
  return { ...meta, volumes }
}
