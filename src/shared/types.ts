// 共享类型定义：主进程与Render.进程之间的数据契约

/** Setting document categories. */
export type SettingCategory =
  | 'worldview' // 世界观与法则
  | 'character' // 角色
  | 'geography' // 地理与版图
  | 'economy' // 社会经济模型
  | 'outline' // 情节Outline.
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

/** Volume. */
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
}

export interface GeneratedDoc {
  category: SettingCategory // 落进现有六分类之一
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
  outlineSystemPrompt: string // 根据Outline.编写的人设
  continueSystemPrompt: string // 续写的人设
  temperature: number // 0–2，默认 0.8
  topP: number // 0–1，默认 0.9
}

/** Full app config (stored in config.json). */
export interface AppConfig {
  ai: AIConfig
  personas: AgentPersona[]
  consistency: ConsistencyConfig
  writing: WritingConfig
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

  // Volume.章Outline.（单文件 markdown，存于世界目录下）
  readOutline: () => Promise<string>
  writeOutline: (content: string) => Promise<void>
}
