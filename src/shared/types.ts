// Shared type definitions: the data contract between the server and renderer.

/** Setting document categories. */
export type SettingCategory =
  | 'worldview' // 世界观与法则
  | 'character' // 角色
  | 'geography' // 地理与版图
  | 'economy' // 社会经济模型
  | 'outline' // 情节大纲
  | 'misc' // 杂项

export interface SettingDoc {
  id: string // 相对 settings 目录的文件路径，如 "worldview/世界观与法则.md"
  title: string
  category: SettingCategory
  updatedAt: number
}

export interface SettingDocContent extends SettingDoc {
  content: string
}

/** Volume (a book part grouping chapters). */
export interface Volume {
  id: string
  title: string
  order: number
  chapters: Chapter[]
}

/** Chapter (metadata only; body in separate .md files). */
export interface Chapter {
  id: string
  volumeId: string
  title: string
  order: number
  file: string // 相对 chapters 目录的 md 文件名
  wordCount: number
  status: 'draft' | 'done' // 草稿 / 定稿
  updatedAt: number
}

/** Novel basic info. */
export interface NovelMeta {
  title: string
  author: string
  synopsis: string
  tags: string[]
  volumes: Volume[]
}

/** World index entry (stored in worlds.json). */
export interface WorldMeta {
  id: string
  title: string
  genre: string // 题材标签
  coverColor: string // 卡片封面色
  createdAt: number
  lastOpenedAt: number
}

/** World gen input: prompt (one sentence) or seedText (source material). */
export interface GenerateWorldInput {
  prompt?: string
  seedText?: string
}

/** AI-generated self-consistent world package (not yet persisted). */
export interface GeneratedWorld {
  title: string
  genre: string
  synopsis: string // 世界概述，同时用作 novel.synopsis
  docs: GeneratedDoc[] // 变长：AI 按题材弹性决定
  chapters?: GeneratedChapter[] // optional: imported manuscript chapters (not AI-generated)
}

/** A chapter imported from existing manuscript files (not AI-generated). */
export interface GeneratedChapter {
  title: string
  content: string
}

export interface GeneratedDoc {
  category: SettingCategory // 落入现有六个分类之一
  title: string // 文档标题（= 文件名）
  content: string // markdown 正文
}

/** AI provider configuration. */
export interface AIProvider {
  id: string
  name: string
  baseUrl: string // OpenAI 兼容 base url，如 https://api.deepseek.com/v1
  apiKey: string
  model: string
  /** Max output tokens for this provider's models. Null/undefined = 16384. */
  maxTokens?: number
}

export interface AIConfig {
  providers: AIProvider[]
  activeProviderId: string | null
}

/** Agent persona in discussion group. */
export interface AgentPersona {
  id: string
  name: string // 如「网文主编 · 阿星」
  role: string // 一句话身份，如「资深起点主编」
  systemPrompt: string // 完整人设 prompt
  color: string // UI 头像色
  providerId?: string // 可为不同 agent 指定不同提供商，缺省用 active
}

/** Discussion message. */
export interface DiscussionMessage {
  id: string
  personaId: string // 'moderator' 表示主持人/系统，'user' 表示用户
  personaName: string
  content: string
  round: number
  ts: number
}

/** A single discussion session. */
export interface DiscussionSession {
  id: string
  topic: string
  personaIds: string[]
  rounds: number
  messages: DiscussionMessage[]
  conclusion: string | null
  createdAt: number
}

/** Snapshot entry (old content before write/delete). */
export interface SnapshotEntry {
  id: string // 快照定位符：<编码后的源路径>/<时间戳>.snap，传给 readSnapshot
  sourcePath: string // 原始文件相对世界目录的路径，如 "chapters/xxx.md"
  label: string // 展示名：章节标题或设定标题
  kind: 'chapter' | 'setting'
  ts: number // 快照时间
  size: number // 快照内容字节数
}

/** OpenAI-compatible chat message. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** Consistency check configuration. */
export interface ConsistencyConfig {
  providerId: string | null // 巡检专用提供商，null 时回落到 ai.activeProviderId
  systemPrompt: string // 巡检助手人设
  userTemplate: string // 用户消息模板，含 {{material}} 占位符（缺失时材料追加到末尾）
}

/** AI writing config (outline / continuation). */
export interface WritingConfig {
  providerId: string | null // 正文编写专用提供商，null 时回落到 ai.activeProviderId
  outlineSystemPrompt: string // 根据大纲编写正文的人设
  continueSystemPrompt: string // 续写的人设
  temperature: number // 0–2，默认 0.8
  topP: number // 0–1，默认 0.9
}

/** Full app config (stored in config.json). */

/** Author voice profile — learned from representative prose samples. */
export interface VoiceProfile {
  /** When the profile was last generated (epoch ms). */
  generatedAt: number
  /** IDs of the chapters used as samples. */
  sampleChapterIds: string[]
  /** Structured voice traits extracted by the AI. */
  traits: VoiceTraits
}

export interface VoiceTraits {
  /** Sentence length range, e.g. "12–25 words". */
  sentenceLength: string
  /** Preferred verb style, e.g. "concrete action verbs, avoids adverbs". */
  verbStyle: string
  /** Narrative distance, e.g. "third-person limited, inside character's skin". */
  narrativeDistance: string
  /** Dialogue style, e.g. "terse, heavy subtext, character-specific rhythms". */
  dialogueStyle: string
  /** Common rhetorical devices or patterns. */
  rhetoricalPatterns: string
  /** Free-form prose notes from the AI analysis. */
  proseNotes: string
}

/** ---- De-slop (AI-writing-smell) analysis ---- */

/** Identifiers for the local statistical detector dimensions. */
export type SlopDimId =
  | 'burstiness'
  | 'connectives'
  | 'parallelism'
  | 'abstractNouns'
  | 'sentenceHeadRepetition'
  | 'punctuationMonotony'
  | 'idiomDensity'
  | 'paragraphUniformity'

/** Weight map for the detector dimensions (calibratable later). */
export type SlopWeights = Record<SlopDimId, number>

/** One dimension's contribution to the overall slop score. */
export interface SlopDimScore {
  id: SlopDimId
  /** Human-readable label (localized by the analyzer via uiLang). */
  label: string
  /** Normalized sub-score in 0–1 (1 = most AI-like). */
  score: number
  /** Weight applied to this dimension when computing the total. */
  weight: number
  /** Short, concrete explanation of what drove this score (localized via uiLang). */
  detail: string
}

/** A single flagged span in the prose, with why it looks AI-generated. */
export interface SlopFlag {
  /** Absolute char offset of the flagged sentence within the analyzed text. */
  start: number
  /** Absolute char offset just past the flagged sentence. */
  end: number
  /** The flagged sentence text (verbatim slice). */
  text: string
  /** Per-sentence risk in 0–1 (1 = most AI-like). */
  risk: number
  /** Dimension ids that fired on this sentence. */
  reasons: SlopDimId[]
  /** Short human-readable reason summary (localized via uiLang). */
  note: string
}

/** Full report from the local analyzer. Pure output, no side effects. */
export interface SlopReport {
  /** Overall AI-smell score, 0–100 (higher = more AI-like). */
  score: number
  /** Severity band derived from score: green / yellow / red. */
  band: 'green' | 'yellow' | 'red'
  /** Per-dimension breakdown. */
  dimensions: SlopDimScore[]
  /** Sentence-level flags, most risky first. */
  flags: SlopFlag[]
  /** Basic text stats (sentences, chars) for display. */
  stats: { sentences: number; chars: number; paragraphs: number }
}

/** De-slop feature config (parallel to ConsistencyConfig). */
export interface SlopConfig {
  /** Provider for the rewrite step; null falls back to active provider. */
  rewriteProviderId: string | null
  /** Editable system prompt for the rewrite step. */
  rewriteSystemPrompt: string
  /** Calibratable dimension weights. */
  weights: SlopWeights
  /** Version tag of the rules pack in use. */
  rulesPackVersion: string
}

/** ---- De-slop human-in-the-loop calibration (M3) ---- */

/**
 * One calibration sample: a chapter's local feature vector paired with a
 * manually backfilled Zhuque AI-suspicion score. Used to fit the detector
 * weights toward real-world detector output via ridge regression.
 */
export interface SlopCalibrationSample {
  id: string
  ts: number
  /** Chapter title at capture time, for recognition in the sample list. */
  chapterTitle: string
  /** Per-dimension sub-scores (0-1) captured by the local analyzer. */
  features: Record<SlopDimId, number>
  /** Local machine-smell score (0-100) at capture time. */
  localScore: number
  /** Manually backfilled Zhuque AI-suspicion %, null until the user enters it. */
  zhuqueScore: number | null
  /** Short prose snippet for recognition. */
  snippet: string
}

/** Calibration state persisted per world in localStorage. */
export interface SlopCalibration {
  samples: SlopCalibrationSample[]
  /** Weights derived from regression over backfilled samples; null until computed. */
  calibratedWeights: SlopWeights | null
  updatedAt: number
}

export interface AppConfig {
  ai: AIConfig
  personas: AgentPersona[]
  consistency: ConsistencyConfig
  writing: WritingConfig
  /** Optional so older config.json still loads; defaults applied at read time. */
  slop?: SlopConfig
}

/** A single event on a world's timeline. */
export interface TimelineEvent {
  id: string
  title: string
  /** Human-readable date label, e.g. "Year 1240", "3rd Moon, 1240" */
  dateLabel: string
  /** Numeric sort key: larger = later. Ascending order. */
  dateOrder: number
  /** Markdown description of the event. */
  description: string
  /** IDs of related codex documents. */
  docRefs: string[]
  /** Optional color accent for the event card. */
  color?: string
}

/** IPC contract: method signatures exposed to renderer via window.api. */
export interface Api {
  // 项目
  getNovelMeta: () => Promise<NovelMeta>
  saveNovelMeta: (meta: NovelMeta) => Promise<void>
  getProjectPath: () => Promise<string>

  // 世界管理（多世界）
  listWorlds: () => Promise<WorldMeta[]>
  getCurrentWorldId: () => Promise<string | null>
  switchWorld: (id: string) => Promise<void>
  deleteWorld: (id: string) => Promise<void>
  updateWorldMeta: (
    id: string,
    meta: { title: string; genre: string; coverColor: string },
  ) => Promise<WorldMeta>
  createBlankWorld: (title: string, genre: string, coverColor: string) => Promise<WorldMeta>
  // 事务落地：一次调用完成建骨架 + 写全部设定 + 写 novel.json + 写 worlds.json，失败回滚
  createWorldWithData: (
    meta: { title: string; genre: string; coverColor: string },
    data: GeneratedWorld,
  ) => Promise<WorldMeta>

  // 设定文档
  listSettings: () => Promise<SettingDoc[]>
  readSetting: (id: string) => Promise<SettingDocContent>
  writeSetting: (id: string, content: string) => Promise<void>
  createSetting: (category: SettingCategory, title: string) => Promise<SettingDoc>
  deleteSetting: (id: string) => Promise<void>

  // 章节正文
  readChapter: (file: string) => Promise<string>
  writeChapter: (file: string, content: string) => Promise<void>

  // 配置
  getConfig: () => Promise<AppConfig>
  saveConfig: (config: AppConfig) => Promise<void>

  // AI
  chat: (messages: ChatMessage[], providerId?: string) => Promise<string>
  // AI 生成世界（纯无状态：只生成并返回，不落盘）
  generateWorld: (input: GenerateWorldInput) => Promise<GeneratedWorld>

  // 讨论组
  listDiscussions: () => Promise<DiscussionSession[]>
  saveDiscussion: (session: DiscussionSession) => Promise<void>
  deleteDiscussion: (id: string) => Promise<void>

  // 版本快照（找回被误删/被 AI 写坏的正文与设定）
  listSnapshots: () => Promise<SnapshotEntry[]>
  readSnapshot: (id: string) => Promise<string>
  restoreSnapshot: (id: string) => Promise<void>

  // 卷/章大纲（单文件 markdown，存于世界目录下）
  readOutline: () => Promise<string>
  writeOutline: (content: string) => Promise<void>

  // Voice profile
  readVoiceProfile: () => Promise<VoiceProfile | null>
  writeVoiceProfile: (profile: VoiceProfile) => Promise<void>

  // 时间线
  listTimelineEvents: () => Promise<TimelineEvent[]>
  saveTimelineEvents: (events: TimelineEvent[]) => Promise<void>
}
