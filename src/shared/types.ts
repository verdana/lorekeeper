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

/** Minimal metadata patch a batch run may apply to one chapter (see Api.commitBatchChapter). */
export interface CommitBatchChapterInput {
  worldId: string
  chapterId: string
  file: string
  content: string
  patch: { wordCount: number; updatedAt: number; status: 'draft' }
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

/** AI writing config (outline / continuation / rewrite). */
export interface WritingConfig {
  providerId: string | null // 正文编写专用提供商，null 时回落到 ai.activeProviderId
  outlineSystemPrompt: string // 根据大纲编写正文的人设
  continueSystemPrompt: string // 续写的人设
  rewriteSystemPrompt: string // 基于大纲改写既有正文的人设
  temperature: number // 0–2，默认 0.8
  topP: number // 0–1，默认 0.9
  /** Per-language slots for the user-edited prompts (see AgentPersona). */
  outlineSystemPromptEn?: string
  outlineSystemPromptZh?: string
  continueSystemPromptEn?: string
  continueSystemPromptZh?: string
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

  // 批量写作（batch write）：严格快照 / 事务落盘 / 空章删除
  forceSnapshot: (sourcePath: string) => Promise<SnapshotEntry>
  commitBatchChapter: (input: CommitBatchChapterInput) => Promise<NovelMeta>
  removeBatchChapter: (worldId: string, chapterId: string) => Promise<NovelMeta>

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

  // 时间线
  listTimelineEvents: () => Promise<TimelineEvent[]>
  saveTimelineEvents: (events: TimelineEvent[]) => Promise<void>

  // Story Memory
  readStoryMemory: () => Promise<StoryMemoryStore>
  writeStoryMemory: (store: StoryMemoryStore) => Promise<void>
  mergeStoryMemory: (store: StoryMemoryStore) => Promise<StoryMemoryImportResult>
  listStoryMemoryBackups: () => Promise<StoryMemoryBackup[]>
  restoreStoryMemoryBackup: (id: string) => Promise<void>

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
