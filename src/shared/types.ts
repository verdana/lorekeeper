// Shared type definitions: the data contract between the server and renderer.

/** Setting document categories (directory names under settings/). */
export type SettingCategory =
  | '01-worldview' // 世界观与宇宙法则
  | '02-magic' // 魔法与超凡体系
  | '03-history' // 历史与时间线
  | '04-geography' // 地理与版图
  | '05-faction' // 国家与势力组织
  | '06-religion' // 宗教与神话
  | '07-society' // 社会与文化
  | '08-economy' // 经济与贸易
  | '09-technology' // 技术、军事与生产力
  | '10-species' // 种族、魔物与生态
  | '11-character' // 角色
  | '12-item' // 器物与载具
  | '99-misc' // 杂项与参考

export interface SettingDoc {
  id: string // 相对 settings 目录的文件路径，如 "worldview/世界观与法则.md"；外部映射文档为 "external:<mappingId>/<relPath>"
  title: string
  category: SettingCategory
  updatedAt: number
  /** Present iff the doc is a read-only doc mapped from an external folder. */
  external?: { mappingId: string; relPath: string }
}

/** Read-only mapping of an external Markdown folder into a world's codex. */
export interface ExternalMapping {
  id: string
  /** Display name; defaults to the folder basename. */
  name: string
  /** Absolute path of the external folder. */
  rootPath: string
  /** All docs of this mapping appear under this category. */
  category: SettingCategory
  addedAt: number
}

export interface SettingDocContent extends SettingDoc {
  content: string
}

/** Outline document (a Markdown file under the world's outline/ directory). */
export interface OutlineDoc {
  id: string // file name relative to outline/, e.g. "01-总纲.md"
  title: string
  updatedAt: number
}

export interface OutlineDocContent extends OutlineDoc {
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
  category: SettingCategory // 落入现有十六个分类之一
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
  /**
   * Per-language slots for the user-edited system prompt. saveConfig archives
   * the active `systemPrompt` into the slot matching PROMPT_LANG; the other
   * locale's slot is left untouched so saving one language never overwrites
   * the other. getConfig restores the current locale's slot into
   * `systemPrompt`. Legacy configs (no slots) keep working unchanged.
   */
  systemPromptEn?: string
  systemPromptZh?: string
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
  label: string // 展示名：章节标题、设定标题或数据文件名
  kind:
    | 'chapter'
    | 'setting'
    | 'outline'
    | 'novel'
    | 'timeline'
    | 'voice'
    | 'discussion'
    | 'reviewQueue'
    | 'characterChat'
  ts: number // 快照时间
  size: number // 快照内容字节数
}

/** OpenAI-compatible chat message. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** Token usage reported by a provider, estimated locally, or unavailable. */
export interface GenerationTokenUsage {
  source: 'reported' | 'estimated' | 'unavailable'
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
}

export interface GenerationContextLayer {
  key: string
  label: string
  content: string
}

export interface GenerationProviderSnapshot {
  id: string
  name: string
  baseUrl: string
  model: string
}

export interface GenerationParameters {
  temperature: number | null
  topP: number | null
  maxTokens: number | null
  disableThinking: boolean
}

export type GenerationStageKind = 'draft' | 'calibration'
export type GenerationStageStatus = 'running' | 'completed' | 'incomplete' | 'failed' | 'aborted'

/** One model call inside a generation run. */
export interface GenerationStage {
  id: string
  kind: GenerationStageKind
  partIndex: number
  partTotal: number
  status: GenerationStageStatus
  promptVersion: string
  promptHash: string
  messages: ChatMessage[]
  contextLayers: GenerationContextLayer[]
  provider: GenerationProviderSnapshot
  parameters: GenerationParameters
  startedAt: number
  durationMs: number | null
  finishReason: string | null
  usage: GenerationTokenUsage
  output: string
  error: string | null
}

export interface GenerationSelectedResult {
  /** `calibrated` is retained only for reading historical evidence. */
  kind: 'draft' | 'calibrated'
  stageIds: string[]
  text: string
  selectedAt: number
}

export interface GenerationAuthorResult {
  text: string
  savedAt: number
  editingStartedAt: number
  editingDurationMs: number
  durationMeasurement: 'elapsed'
  retentionRatio: number
}

export interface GenerationBaseline {
  capturedAt: number
  pipelineVersion: 'legacy-two-pass-v1' | 'source-draft-v2'
}

/** Durable evidence. Legacy two-pass runs remain readable after Calibration removal. */
export interface GenerationRun {
  version: 1
  id: string
  pipeline: 'source-draft' | 'legacy-two-pass'
  mode: 'outline-write'
  chapterId: string
  chapterTitle: string
  createdAt: number
  updatedAt: number
  stages: GenerationStage[]
  selectedResult: GenerationSelectedResult | null
  authorResult?: GenerationAuthorResult | null
  baseline?: GenerationBaseline | null
  reproductionOf?: string | null
  /** Historical field retained for old evidence files. New runs are always single-pass. */
  calibrationEnabled?: boolean
}

export interface GenerationRunSummary {
  id: string
  chapterId: string
  chapterTitle: string
  createdAt: number
  updatedAt: number
  stageCount: number
  status: GenerationStageStatus | 'empty'
  selectedResultKind: GenerationSelectedResult['kind'] | null
  hasAuthorResult: boolean
  retentionRatio: number | null
  isBaseline: boolean
  reproductionOf: string | null
}

export interface CreateGenerationRunInput {
  id: string
  chapterId: string
  chapterTitle: string
  reproductionOf?: string
}

export interface SaveGenerationAuthorResultInput {
  text: string
  editingStartedAt: number
}

/** Consistency check configuration. */
export interface ConsistencyConfig {
  providerId: string | null // 巡检专用提供商，null 时回落到 ai.activeProviderId
  systemPrompt: string // 巡检助手人设
  userTemplate: string // 用户消息模板，含 {{material}} 占位符（缺失时材料追加到末尾）
  /** Per-language slots for the user-edited prompts (see AgentPersona). */
  systemPromptEn?: string
  systemPromptZh?: string
  userTemplateEn?: string
  userTemplateZh?: string
}

/** AI writing config (outline / rewrite). */
export interface WritingConfig {
  providerId: string | null // 正文编写专用提供商，null 时回落到 ai.activeProviderId
  outlineSystemPrompt: string // 根据大纲编写正文的人设
  rewriteSystemPrompt: string // 基于大纲改写既有正文的人设
  temperature: number // 0–2，默认 0.8
  topP: number // 0–1，默认 0.9
  /** Per-language slots for the user-edited prompts (see AgentPersona). */
  outlineSystemPromptEn?: string
  outlineSystemPromptZh?: string
  rewriteSystemPromptEn?: string
  rewriteSystemPromptZh?: string
}

/** Full app config (stored in config.json). */

/** Author voice profile — learned from representative prose samples. */
export interface VoiceProfile {
  /** When the profile was last generated (epoch ms). */
  generatedAt: number
  /** IDs of the chapters used as samples. */
  sampleChapterIds: string[]
  /** Optional human-written prose pasted in by the author (e.g. from another
   *  novel) — used when the author has no AI-free chapters of their own. */
  sampleTexts?: string[]
  /** Hand-written voice description pasted by the author (no AI analysis).
   *  When present it takes precedence over the structured `traits` in writing
   *  prompts — the author's own words are applied verbatim. */
  manualText?: string
  /** Structured voice traits extracted by the AI. */
  traits: VoiceTraits
}

/**
 * Style exemplars for a world: short passages the author picks as prose
 * models. Injected into writing prompts so generated prose imitates their
 * rhythm and register instead of the model's default voice. Stored in the
 * world directory (`exemplars.json`) so each world keeps its own set.
 */
export interface ExemplarStore {
  version: 1
  texts: string[]
}

/**
 * Voice traits extracted from prose samples. The original six fields are
 * required; the dimensions added later (diction, syntax, …) are optional so
 * profiles generated by older builds still load — re-running the analysis
 * fills them in.
 */
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
  /** Overall diction / register: abstract-vs-concrete ratio, rare words,
   *  period flavor, literary-vs-colloquial balance. */
  diction?: string
  /** Syntactic organization beyond length: parataxis vs subordination,
   *  dashes/semicolons, passive voice, inversion, ellipsis. */
  syntax?: string
  /** Punctuation system: exclamation, dashes, quotes for inner monologue. */
  punctuation?: string
  /** Paragraph and scene cutting: paragraph length, scene-break markers,
   *  how time jumps / flashbacks are signaled. */
  paragraphing?: string
  /** Per-POV character voice fingerprints (for multi-viewpoint novels). */
  characterVoices?: string
  /** How emotion is externalized: emotion → object / bodily reaction / action. */
  emotionExternalization?: string
  /** Sensory palette weighting, e.g. "hearing-dominant, touch secondary,
   *  smell/taste extremely restrained". */
  sensoryPalette?: string
  /** Recurring motifs / image bank that keep imagery consistent. */
  motifs?: string
  /** Negative constraints: what to avoid (taboos, clichés, forbidden moves). */
  taboos?: string
}

export interface AppConfig {
  ai: AIConfig
  personas: AgentPersona[]
  consistency: ConsistencyConfig
  writing: WritingConfig
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

/** Author-reviewed continuity facts extracted from chapter prose. */
export type StoryMemoryStatus = 'suggested' | 'confirmed' | 'rejected'

export type StoryMemoryKind =
  | 'character-state'
  | 'relationship'
  | 'knowledge'
  | 'location'
  | 'object'
  | 'world-state'
  | 'open-thread'

export interface StoryMemorySource {
  chapterId: string
  chapterFile: string
  chapterTitle: string
  volumeId: string
  volumeOrder: number
  chapterOrder: number
  fingerprint: string
  evidence: string
}

export interface StoryMemoryEntry {
  id: string
  kind: StoryMemoryKind
  statement: string
  entityRefIds: string[]
  source: StoryMemorySource
  timelineEventId: string | null
  storyDateLabel: string
  confidence: number | null
  status: StoryMemoryStatus
  origin: 'ai' | 'author'
  createdAt: number
  updatedAt: number
  confirmedAt: number | null
}

export interface StoryMemoryStore {
  version: 1
  entries: StoryMemoryEntry[]
}

/** ---- Chapter Memory（分层记忆：章节摘要 + 故事状态档案）---- */

/**
 * AI 生成的单章结构化摘要（分层记忆的基本单元）。正文改动后
 * sourceFingerprint 不再匹配，摘要视为过期，需重新生成。
 */
export interface ChapterSummary {
  chapterId: string
  chapterTitle: string
  /** 正文指纹（storyMemoryFingerprint），用于检测正文改动导致摘要过期。 */
  sourceFingerprint: string
  generatedAt: number
  /** 本章事件概要（150~250 字）。 */
  summary: string
  /** 章末状态：时间 / 地点 / 在场人物 / 未完成的动作 —— 下一章的起点。 */
  endState: string
  /** 本章确立的持久状态变化。 */
  stateChanges: StoryStateChange[]
  /** 本章埋下的伏笔 / 钩子。 */
  plantedThreads: string[]
  /** 本章兑现的伏笔 / 钩子（引用之前埋下的）。 */
  resolvedThreads: string[]
}

/** 一条持久状态变化。 */
export interface StoryStateChange {
  /** 主体：人物名、物件名或「世界」。 */
  entity: string
  /** 状态维度：伤势 / 位置 / 物品 / 关系 / 目标 / 世界局势 等。 */
  aspect: string
  /** 变化描述，如「左肺被刺穿，失血濒死」。 */
  change: string
  /** 是否不可逆的物理事实（写作时必须作为硬约束遵守）。 */
  permanent: boolean
}

/** 角色当前状态（跨章累积）。 */
export interface StoryCharacterState {
  name: string
  /** 当前所在位置。 */
  location: string
  /** 伤势 / 体力 / 生理状态（硬约束重点）。 */
  condition: string
  /** 随身携带的物件。 */
  possessions: string
  /** 当前目标。 */
  goals: string
  /** 与其他角色的关系现状。 */
  relations: string
}

/** 跨章累积的故事状态档案。 */
export interface StoryState {
  version: 1
  /** 状态档案已覆盖到哪一章（不含该章之后）。 */
  upToChapterId: string | null
  updatedAt: number
  characters: StoryCharacterState[]
  /** 世界局势 / 全局状态（如「王国陷入内战」）。 */
  worldState: string[]
  /** 尚未兑现的伏笔 / 钩子。 */
  openThreads: string[]
  /** 最新一章的 endState（下一章的起点）。 */
  currentEndState: string
}

export interface StoryMemoryImportResult {
  added: number
  skipped: number
}

export interface StoryMemoryBackup {
  id: string
  createdAt: number
  entryCount: number
}

/**
 * A persisted consistency-check report. Saved into the world directory
 * (`consistency/<id>.json`) so findings survive across sessions and are
 * included in world exports. `status` is reserved for the upcoming
 * Persistent Review Queue; reports are created as 'open'.
 */
export interface ConsistencyReport {
  id: string
  createdAt: number
  /** Scope snapshot: titles of the codex docs / chapters the check ran over. */
  scope: { docs: string[]; chapters: string[] }
  /** Full markdown text of the AI report. */
  content: string
  /** Report char count (whitespace-stripped), for display. */
  wordCount: number
  status: 'open'
}

/**
 * One message in a character chat session.
 */
export interface CharacterChatMessage {
  id: string
  role: 'user' | 'character'
  content: string
  ts: number
}

/**
 * A character-chat session, persisted to the world directory
 * (`character-chats/<id>.json`). One active session per character: saving a
 * session for a character replaces the previous one.
 */
export interface CharacterChatSession {
  id: string
  characterId: string
  /** Title snapshot so the session stays recognizable if the doc is renamed. */
  characterTitle: string
  messages: CharacterChatMessage[]
  createdAt: number
  updatedAt: number
}

/** ---- Persistent Review Queue ---- */

export type ReviewItemStatus = 'open' | 'fixing' | 'verified' | 'resolved'
export type ReviewItemSeverity = 'critical' | 'moderate' | 'unsure'

/**
 * One actionable review item, typically parsed from a consistency report.
 * Persisted in the world directory (`review-queue.json`) so findings stay
 * trackable across sessions: who owns them, what was fixed, what is verified.
 */
export interface ReviewQueueItem {
  id: string
  /** Source report id; null for manually added items. */
  reportId: string | null
  /** Display label of the source report (creation time), for back-linking. */
  reportLabel: string
  severity: ReviewItemSeverity
  text: string
  /** Codex document IDs the report attributed to this issue, for fix targeting. */
  relatedDocIds: string[]
  status: ReviewItemStatus
  /** Target document/chapter backfilled by the fix action. */
  fixedIn: { kind: 'doc' | 'chapter'; id: string; title: string } | null
  note: string
  createdAt: number
  updatedAt: number
}

export interface ReviewQueueStore {
  version: 1
  items: ReviewQueueItem[]
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

  // 外部文件夹映射（只读 codex 文档源，非破坏性：绝不写入外部文件夹）
  listExternalMappings: () => Promise<ExternalMapping[]>
  addExternalMapping: (input: {
    name?: string
    rootPath: string
    category: SettingCategory
  }) => Promise<ExternalMapping>
  removeExternalMapping: (id: string) => Promise<void>
  /** 原生目录选择对话框（仅 Electron 桌面端）；取消返回 null。 */
  pickFolder: () => Promise<string | null>

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

  // Generation evidence for the current writing pipeline
  createGenerationRun: (input: CreateGenerationRunInput) => Promise<GenerationRun>
  saveGenerationStage: (runId: string, stage: GenerationStage) => Promise<GenerationRun>
  selectGenerationResult: (
    runId: string,
    result: Omit<GenerationSelectedResult, 'selectedAt'>,
  ) => Promise<GenerationRun>
  saveGenerationAuthorResult: (
    runId: string,
    result: SaveGenerationAuthorResultInput,
  ) => Promise<GenerationRun>
  readGenerationRun: (id: string) => Promise<GenerationRun | null>
  listGenerationRuns: (chapterId?: string) => Promise<GenerationRunSummary[]>

  // 讨论组
  listDiscussions: () => Promise<DiscussionSession[]>
  saveDiscussion: (session: DiscussionSession) => Promise<void>
  deleteDiscussion: (id: string) => Promise<void>

  // 版本快照（找回被误删/被 AI 写坏的数据：正文、设定、大纲、元数据、时间线等）
  listSnapshots: () => Promise<SnapshotEntry[]>
  readSnapshot: (id: string) => Promise<string>
  restoreSnapshot: (id: string) => Promise<void>
  /** 读世界内某文件的当前内容（供 History diff 对比），sourcePath 为相对世界目录路径。 */
  readWorldFile: (sourcePath: string) => Promise<string>

  // 卷/章大纲（outline/ 目录下多个 Markdown 文档；readOutline 合并全部文档，
  // 目录为空时回退旧的单文件 outline.md）
  listOutlineDocs: () => Promise<OutlineDoc[]>
  readOutlineDoc: (id: string) => Promise<OutlineDocContent>
  writeOutlineDoc: (id: string, content: string) => Promise<void>
  createOutlineDoc: (title: string) => Promise<OutlineDoc>
  deleteOutlineDoc: (id: string) => Promise<void>
  readOutline: () => Promise<string>
  writeOutline: (content: string) => Promise<void>

  // Voice profile
  readVoiceProfile: () => Promise<VoiceProfile | null>
  writeVoiceProfile: (profile: VoiceProfile) => Promise<void>

  // 文风范例（exemplars，按世界存储于 exemplars.json）
  readExemplars: () => Promise<ExemplarStore>
  writeExemplars: (store: ExemplarStore) => Promise<void>

  // 时间线
  listTimelineEvents: () => Promise<TimelineEvent[]>
  saveTimelineEvents: (events: TimelineEvent[]) => Promise<void>

  // Story Memory
  readStoryMemory: () => Promise<StoryMemoryStore>
  writeStoryMemory: (store: StoryMemoryStore) => Promise<void>
  mergeStoryMemory: (store: StoryMemoryStore) => Promise<StoryMemoryImportResult>
  listStoryMemoryBackups: () => Promise<StoryMemoryBackup[]>
  restoreStoryMemoryBackup: (id: string) => Promise<void>

  // Chapter Memory（分层记忆：章节摘要 + 故事状态档案）
  listChapterSummaries: () => Promise<ChapterSummary[]>
  readChapterSummary: (chapterId: string) => Promise<ChapterSummary | null>
  writeChapterSummary: (summary: ChapterSummary) => Promise<void>
  deleteChapterSummary: (chapterId: string) => Promise<void>
  readStoryState: () => Promise<StoryState>
  writeStoryState: (state: StoryState) => Promise<void>

  // 一致性报告（持久化到世界目录 consistency/ 下）
  listConsistencyReports: () => Promise<ConsistencyReport[]>
  saveConsistencyReport: (report: {
    content: string
    scope: { docs: string[]; chapters: string[] }
  }) => Promise<ConsistencyReport>
  deleteConsistencyReport: (id: string) => Promise<void>

  // 角色对话（持久化到世界目录 character-chats/ 下,每角色一个文件）
  listCharacterChats: () => Promise<CharacterChatSession[]>
  saveCharacterChat: (session: CharacterChatSession) => Promise<void>
  deleteCharacterChat: (characterId: string) => Promise<void>

  // 审查队列（持久化到世界目录 review-queue.json）
  readReviewQueue: () => Promise<ReviewQueueStore>
  writeReviewQueue: (store: ReviewQueueStore) => Promise<void>
}
