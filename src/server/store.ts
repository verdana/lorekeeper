import {
  readFileSync,
  writeSync,
  fsyncSync,
  openSync,
  closeSync,
  renameSync,
  readdirSync,
  statSync,
  realpathSync,
  existsSync,
  cpSync,
  unlinkSync,
  rmSync,
} from 'fs'
import { join, basename, extname, dirname, relative, resolve, isAbsolute } from 'path'
import type {
  AppConfig,
  AIProvider,
  WritingConfig,
  NovelMeta,
  Volume,
  Chapter,
  SettingCategory,
  SettingDoc,
  SettingDocContent,
  ExternalMapping,
  DiscussionSession,
  WorldMeta,
  GeneratedWorld,
  SnapshotEntry,
  TimelineEvent,
  VoiceProfile,
  StoryMemoryEntry,
  StoryMemoryBackup,
  StoryMemoryImportResult,
  StoryMemoryKind,
  StoryMemorySource,
  StoryMemoryStore,
  StoryMemoryStatus,
  ConsistencyReport,
  CharacterChatSession,
  ReviewQueueStore,
  OutlineStore,
  ExemplarStore,
  ChapterSummary,
  StoryState,
  CreateGenerationRunInput,
  GenerationRun,
  GenerationRunSummary,
  GenerationSelectedResult,
  GenerationStage,
  SaveGenerationAuthorResultInput,
} from '../shared/types'
import {
  chaptersDir,
  characterChatsDir,
  configFile,
  consistencyDir,
  discussionsDir,
  novelFile,
  outlineDir,
  outlineJsonFile,
  projectRoot,
  settingsDir,
  worldsFile,
  worldDir,
  worldsRoot,
  ensureDir,
  ensureWorldSkeleton,
  getCurrentWorldId as pathsGetCurrentWorldId,
  setCurrentWorldId,
  currentWorldDir,
  forgeDir,
  forgeRunFile,
  snapshotsDir,
  storyMemoryFile,
  storyMemoryBackupsDir,
  reviewQueueFile,
  exemplarsFile,
  chapterSummariesDir,
  storyStateFile,
  generationRunsDir,
  SETTING_CATEGORIES,
} from './paths'
import {
  CATEGORY_LABELS,
  CATEGORY_TEMPLATES,
  DEFAULT_CONFIG,
  DEFAULT_NOVEL_META,
  DEFAULT_WRITING,
} from './defaults'
import { PROMPT_LANG, PROMPTS } from '../shared/prompts'
import { decryptSecret, encryptSecret } from './secrets'
import { isReviewQueueItem } from '../shared/reviewQueue'
import {
  hasSearchableProse,
  searchChapterProse as searchChapterProseMatches,
  type ChapterProseMatch,
  type ChapterProseSource,
} from '../shared/chapterSearch'
import JSZip from 'jszip'
import { createHash } from 'crypto'
import { calculateRetentionRatio, estimateChatUsage } from '../shared/generationEvidence'
import {
  emptyOutlineStore,
  normalizeOutlineStore,
  outlineFromLegacy,
  outlineFromNovel,
  parseLegacyOutline,
  serializeOutlineForAI,
  syncNovelFromOutline,
} from '../shared/outlineStore'

const readJSON = <T>(file: string, fallback: T): T => {
  try {
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf-8')) as T
  } catch {
    return fallback
  }
}

/**
 * Resolve a child path under `base`, refusing any input that escapes it.
 * Hardens all user/RPC-supplied ids against path traversal (e.g. "..", "....//",
 * URL-encoded separators) by checking the fully-resolved path, not by
 * string-stripping which is bypassable.
 */
const safeResolve = (base: string, ...segments: string[]): string => {
  const full = resolve(base, ...segments)
  const rel = relative(base, full)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('Invalid path.')
  }
  return full
}

/**
 * Atomic write: temp file in same dir, fsync, then rename over target.
 * rename is atomic: old file intact or new file complete,
 * no partial-write intermediate state.写作工具的正文/设定/元数据都必须走此路径，
 * 避免断电/崩溃损毁用户心血。
 */
const atomicWrite = (file: string, data: string): void => {
  // 临时文件与目标同目录，确保 rename 跨的是同一文件系统（否则 rename 非原子甚至失败）
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.tmp`)
  try {
    const fd = openSync(tmp, 'w')
    try {
      writeSync(fd, data)
      fsyncSync(fd) // 强制刷盘，确保 rename 前数据已真正落地
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, file)
  } catch (e) {
    // 失败时清理残留临时文件，避免污染数据目录；原目标文件因未 rename 而保持完好
    try {
      unlinkSync(tmp)
    } catch {
      // 临时文件可能压根没创建，或清理失败——都无妨，忽略
    }
    throw e
  }
}

const writeJSON = (file: string, data: unknown): void => {
  atomicWrite(file, JSON.stringify(data, null, 2))
}

/**
 * Sidecar path holding the exact bytes of a data file that could not be parsed.
 * The name is derived from the original, so repeated failures overwrite a single
 * copy instead of accumulating, and the dot prefix keeps it out of the world
 * export's file walk.
 */
const damagedCopyPath = (file: string): string => join(dirname(file), `.corrupt-${basename(file)}`)

/**
 * Preserve a damaged file's bytes before anything can overwrite it, so a read
 * failure leaves evidence to recover from. Best-effort: never masks the failure.
 */
const preserveDamagedFile = (file: string): void => {
  try {
    if (!existsSync(file)) return
    atomicWrite(damagedCopyPath(file), readFileSync(file, 'utf-8'))
  } catch {
    // Failing to keep a copy must not hide the original read error.
  }
}

/**
 * Read a data file while keeping apart the three cases a write-back must tell
 * apart: missing (a normal empty state), parsed, or existing but unreadable.
 * `readJSON` collapses the last two into its fallback, so any caller that
 * persists that fallback destroys the author's data with no error.
 */
type DataFileRead<T> = { state: 'missing' } | { state: 'damaged' } | { state: 'ok'; value: T }

const readDataFile = <T>(file: string): DataFileRead<T> => {
  if (!existsSync(file)) return { state: 'missing' }
  try {
    return { state: 'ok', value: JSON.parse(readFileSync(file, 'utf-8')) as T }
  } catch {
    preserveDamagedFile(file)
    return { state: 'damaged' }
  }
}

/**
 * Refuse a write that would replace a damaged data file.
 *
 * Use this where the file is the only copy of its data (timeline, review queue,
 * story state, exemplars, novel metadata, config): the caller's payload was
 * built from a read that fell back to an empty value, so persisting it would
 * replace what the author still has with that empty version. The exception is a
 * payload that fully reconstructs the file from another source — outline.json is
 * rebuilt from novel.json, so writing it is a repair, not a loss.
 *
 * The damaged bytes are copied aside by `readDataFile` before this throws, and
 * the message says so, because the author has to repair or remove the file to
 * carry on.
 */
const assertWritable = (file: string, label: string): void => {
  if (readDataFile<unknown>(file).state !== 'damaged') return
  throw new Error(
    `${label} could not be saved: the file on disk is damaged, and saving would replace it ` +
      `with an incomplete version. It was left untouched, and a copy was saved next to it as ` +
      `${basename(damagedCopyPath(file))}. Repair or remove that file, then try again.`,
  )
}

// ---- 版本快照（找回被误删/被 AI 写坏的正文与设定）----
// 布局：<world>/.snapshots/<编码源路径>/<时间戳>.snap，每个源文件一个子目录。
const SNAPSHOT_THROTTLE_MS = 3 * 60 * 1000 // 3 分钟内的连续保存只留会话起点，避免刷爆
const SNAPSHOT_KEEP = 15 // 每个文件滚动保留最近份数

// 源文件绝对路径 → 快照子目录名（编码使 "chapters/x.md" 变成单层目录名）
const snapKey = (sourcePath: string): string => encodeURIComponent(sourcePath)

// 滚动清理：只留最近 SNAPSHOT_KEEP 份（时间戳排序，新在前）
function pruneSnapshots(dir: string): void {
  const all = readdirSync(dir)
    .filter((f) => f.endsWith('.snap'))
    .map((f) => Number(basename(f, '.snap')))
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => b - a)
  for (const ts of all.slice(SNAPSHOT_KEEP)) unlinkSync(join(dir, `${ts}.snap`))
}

/**
 * Before overwriting/deleting a file, snapshot its old content.
 * Applies to chapters/, settings/, outline/, discussions/, character-chats/ and the
 * single-file world data (novel.json, timeline.json, voice-profile.json,
 * review-queue.json); no-op if the file doesn’t exist.
 * 3-min throttle, 15 snapshot rolling window. Failures never affect main write.
 * force=true 跳过节流：恢复操作前必须给当前版留底，否则「可反悔」的承诺落空。
 */
function snapshot(full: string, force = false): void {
  try {
    if (!existsSync(full)) return
    const sourcePath = relative(currentWorldDir(), full).replace(/\\/g, '/')
    if (
      !sourcePath.startsWith('chapters/') &&
      !sourcePath.startsWith('settings/') &&
      !sourcePath.startsWith('outline/') &&
      !sourcePath.startsWith('discussions/') &&
      !sourcePath.startsWith('character-chats/') &&
      sourcePath !== 'novel.json' &&
      sourcePath !== 'timeline.json' &&
      sourcePath !== 'voice-profile.json' &&
      // Author-curated style exemplars are the one overwritten resource that
      // cannot be rebuilt from anything else, so they must stay in this list —
      // writeExemplars already calls snapshot(), which used to be a no-op.
      sourcePath !== 'exemplars.json' &&
      sourcePath !== 'review-queue.json'
    )
      return

    const dir = join(snapshotsDir(), snapKey(sourcePath))
    if (!force && existsSync(dir)) {
      const snaps = readdirSync(dir)
        .filter((f) => f.endsWith('.snap'))
        .map((f) => Number(basename(f, '.snap')))
        .filter((n) => !Number.isNaN(n))
        .sort((a, b) => b - a)
      // 节流：最近一份还很新，就不再留
      if (snaps.length > 0 && Date.now() - snaps[0] < SNAPSHOT_THROTTLE_MS) return
    }
    ensureDir(dir)
    atomicWrite(join(dir, `${Date.now()}.snap`), readFileSync(full, 'utf-8'))
    pruneSnapshots(dir)
  } catch {
    // 快照是尽力而为的保险，任何失败都不能拖累用户的正常保存，
    // 但至少留一条 warn 日志方便排查磁盘/权限问题。
    console.warn('[snapshot] failed:', full)
  }
}

/** Generate a world ID. */
const newWorldId = (): string =>
  `w_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

/** Word count mirroring the renderer helper: CJK chars + ASCII words. */
function countWords(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length
  const words = (text.replace(/[\u4e00-\u9fff]/g, ' ').match(/\b\w+\b/g) || []).length
  return cjk + words
}

// ---- 世界索引（worlds.json）----
/**
 * Read the world index.
 *
 * Unlike other data files this one cannot fall back to an empty list: every
 * creator path persists `[...readWorlds(), meta]`, so treating a damaged file as
 * "no worlds" would replace the whole index with the one world being created and
 * leave every existing world directory unreachable. An unreadable index is
 * therefore reported, with the damaged bytes copied aside first.
 */
const readWorlds = (): WorldMeta[] => {
  const file = worldsFile()
  if (!existsSync(file)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    preserveDamagedFile(file)
    throw new Error(
      `The world list could not be read: worlds.json is damaged. The file was left ` +
        `untouched, and a copy was saved next to it as ${basename(damagedCopyPath(file))}. ` +
        `Fix or replace worlds.json, then reopen the app.`,
    )
  }
  if (!Array.isArray(parsed)) {
    preserveDamagedFile(file)
    throw new Error(
      `The world list could not be read: worlds.json does not contain a list of worlds. ` +
        `The file was left untouched, and a copy was saved next to it as ` +
        `${basename(damagedCopyPath(file))}.`,
    )
  }
  return parsed as WorldMeta[]
}
const writeWorlds = (list: WorldMeta[]): void => writeJSON(worldsFile(), list)

/**
 * App bootstrap: ensure multi-world layout and select current world.
 * Three cases:
 *   1. worlds.json exists → select world with latest lastOpenedAt.
 *   2. Legacy <root>/novel.json exists → migrate to first world.
 *   3. First-time user → copy seed directory (sample world) into data root.
 */
export function bootstrap(seedDir: string): void {
  // Existing data root: leave currentWorldId unset so the WorldGate page is the entry point.
  if (existsSync(worldsFile())) return

  const legacyNovel = join(projectRoot(), 'novel.json')
  if (existsSync(legacyNovel)) {
    migrateLegacy(legacyNovel)
    return
  }

  seedNewWorld(seedDir)
}

/**
 * Legacy (single-work)迁移：把 <root>/novel.json、settings/、chapters/、discussions/
 * into worlds/<id>/. Source and target share the filesystem, rename is atomic.
 * Move one by one; failure aborts (old data intact). worlds.json is written last.
 */
function migrateLegacy(legacyNovel: string): void {
  const id = newWorldId()
  const dir = worldDir(id)
  ensureDir(dir)

  const move = (from: string, to: string): void => {
    if (existsSync(from)) renameSync(from, to)
  }
  const root = projectRoot()
  move(legacyNovel, join(dir, 'novel.json'))
  move(join(root, 'settings'), join(dir, 'settings'))
  move(join(root, 'chapters'), join(dir, 'chapters'))
  move(join(root, 'discussions'), join(dir, 'discussions'))
  ensureWorldSkeleton(id) // 补齐迁移后可能缺失的子目录

  const meta = readJSON<NovelMeta>(join(dir, 'novel.json'), DEFAULT_NOVEL_META)
  const now = Date.now()
  writeWorlds([
    {
      id,
      title: meta.title || 'Untitled World',
      genre: meta.tags?.[0] ?? '',
      coverColor: '#B8642E',
      createdAt: now,
      lastOpenedAt: now,
    },
  ])
  // Don't auto-select — the user picks the entry point from WorldGate
}

/**
 * First-time user: copy seed directory (full snapshot with worlds.json, config.json,
 * worlds/<id>/）整体拷入空的数据根，作为开箱即用的示例世界。
 * 种子目录不存在或已无内容时，静默跳过——用户首启即进入世界入口页从零建世界。
 */
function seedNewWorld(seedDir: string): void {
  if (!existsSync(seedDir) || !existsSync(join(seedDir, 'worlds.json'))) return
  // Seed is copied in as-is; the user picks the entry point from WorldGate (no auto-select).
  cpSync(seedDir, projectRoot(), { recursive: true })
}

// ---- 世界管理 RPC ----
export const listWorlds = (): WorldMeta[] =>
  readWorlds().sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)

export const getCurrentWorldId = (): string | null => pathsGetCurrentWorldId()

export function switchWorld(id: string): void {
  const list = readWorlds()
  const w = list.find((x) => x.id === id)
  if (!w) throw new Error('World not found.')
  w.lastOpenedAt = Date.now()
  writeWorlds(list)
  setCurrentWorldId(id)
  // 旧世界补齐骨架(consistency/、character-chats/ 等新增目录),保证写入不因缺目录失败。
  ensureWorldSkeleton(id)
}

export function deleteWorld(id: string): void {
  const list = readWorlds()
  // id 必须是一个真实存在的世界：拒绝任意路径片段（"../../.." 之类）,
  // 否则下方的 rmSync(recursive) 会递归删除数据目录之外的内容。
  if (!list.some((x) => x.id === id)) throw new Error('World not found.')
  // safeResolve 二次防御：目录必须解析回 worlds 根内。
  const dir = safeResolve(worldsRoot(), id)
  const next = list.filter((x) => x.id !== id)
  writeWorlds(next)
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  // 删的是当前世界 → 重置，前端据此退回入口页
  if (pathsGetCurrentWorldId() === id) setCurrentWorldId(null)
}

export function updateWorldMeta(
  id: string,
  meta: { title: string; genre: string; coverColor: string },
): WorldMeta {
  const list = readWorlds()
  const w = list.find((x) => x.id === id)
  if (!w) throw new Error('World not found.')
  w.title = meta.title || 'Untitled World'
  w.genre = meta.genre || ''
  w.coverColor = meta.coverColor || '#B8642E'
  writeWorlds(list)
  // 同步 novel.json 中的 title + tags（genre 始终作为 tags[0] 权威源，
  // 不只在 tags 为空时同步——WorldGate 改题材后 AI 写作读取 tags[0] 必须拿到新值）
  const novelFile_ = join(worldDir(id), 'novel.json')
  const novel = readJSON<NovelMeta>(novelFile_, DEFAULT_NOVEL_META)
  novel.title = w.title
  if (w.genre) {
    novel.tags = [w.genre, ...(novel.tags ?? []).slice(1)]
  }
  snapshot(novelFile_) // 标题/题材联动写入前留底,非当前世界时自动 no-op
  writeJSON(novelFile_, novel)
  return w
}

export function createBlankWorld(title: string, genre: string, coverColor: string): WorldMeta {
  const id = newWorldId()
  ensureWorldSkeleton(id)
  const now = Date.now()
  const meta: WorldMeta = {
    id,
    title: title || 'Untitled World',
    genre,
    coverColor,
    createdAt: now,
    lastOpenedAt: now,
  }
  writeWorlds([...readWorlds(), meta])
  // 写一份带标题的 novel.json（此时 currentWorldId 尚未切换，直接按目录写）
  writeJSON(join(worldDir(id), 'novel.json'), {
    ...DEFAULT_NOVEL_META,
    title: meta.title,
    tags: genre ? [genre] : [],
    synopsis: '',
    volumes: [],
  })
  return meta
}

/**
 * Transactional commit: skeleton → settings → novel.json → worlds.json.
 * Failure removes the partial worlds/<id>/ directory, preventing half-initialized worlds.
 */
export function createWorldWithData(
  meta: { title: string; genre: string; coverColor: string },
  data: GeneratedWorld,
): WorldMeta {
  const id = newWorldId()
  const dir = worldDir(id)
  try {
    ensureWorldSkeleton(id)
    for (const doc of data.docs) {
      const safeTitle = doc.title.replace(/[/\\:*?"<>|]/g, '_').trim() || 'Untitled'
      atomicWrite(join(dir, 'settings', doc.category, `${safeTitle}.md`), doc.content)
    }
    // Imported manuscript chapters (if any): write each to chapters/ and gather
    // them under a single "Imported" volume so the author can reorganise later.
    const volumes: Volume[] = []
    if (data.chapters && data.chapters.length > 0) {
      const volId = `v_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      const chapters: Chapter[] = data.chapters.map((ch, i) => {
        const cid = `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
        const file = `${volId}_${cid}.md`
        atomicWrite(join(dir, 'chapters', file), ch.content)
        return {
          id: cid,
          volumeId: volId,
          title: ch.title || `Chapter ${i + 1}`,
          order: i,
          file,
          wordCount: countWords(ch.content),
          status: 'draft' as const,
          updatedAt: Date.now(),
        }
      })
      volumes.push({ id: volId, title: 'Imported', order: 0, chapters })
    }
    const novel: NovelMeta = {
      ...DEFAULT_NOVEL_META,
      title: data.title || meta.title || 'Untitled World',
      synopsis: data.synopsis,
      tags: data.genre ? [data.genre] : [],
      volumes,
    }
    writeJSON(join(dir, 'novel.json'), novel)

    const now = Date.now()
    const world: WorldMeta = {
      id,
      title: novel.title,
      genre: data.genre || meta.genre,
      coverColor: meta.coverColor,
      createdAt: now,
      lastOpenedAt: now,
    }
    writeWorlds([...readWorlds(), world])
    return world
  } catch (e) {
    // 回滚：清掉半成品目录（worlds.json 尚未写入该条，无需清理）
    try {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    } catch {
      // 清理失败无妨，目录里没有有效索引指向它
    }
    throw e
  }
}

// ---- 小说元信息 ----
export const getNovelMeta = (): NovelMeta => readJSON(novelFile(), DEFAULT_NOVEL_META)

/** 双源同步：把 novel.json 的标题/题材联动写回 worlds.json 中当前世界那条。 */
function syncWorldFromNovel(meta: NovelMeta): void {
  const id = pathsGetCurrentWorldId()
  if (!id) return
  const list = readWorlds()
  const w = list.find((x) => x.id === id)
  if (w) {
    w.title = meta.title || 'Untitled World'
    w.genre = meta.tags?.[0] ?? ''
    writeWorlds(list)
  }
}

export const saveNovelMeta = (meta: NovelMeta): void => {
  assertWritable(novelFile(), 'The manuscript structure')
  snapshot(novelFile())
  writeJSON(novelFile(), meta)
  syncWorldFromNovel(meta)
}

// ---- 配置 ----
type LegacyPricedProvider = AIProvider & {
  inputPriceCnyPerMillionTokens?: number
  outputPriceCnyPerMillionTokens?: number
}

const withoutProviderPricing = (provider: AIProvider): AIProvider => {
  const current: LegacyPricedProvider = { ...provider }
  delete current.inputPriceCnyPerMillionTokens
  delete current.outputPriceCnyPerMillionTokens
  return current
}

type LegacyCalibratedWritingConfig = WritingConfig & {
  calibrateProviderId?: unknown
  calibrationEnabled?: unknown
  calibrateSystemPrompt?: unknown
  calibrateTemperature?: unknown
  calibrateTopP?: unknown
  calibrateSystemPromptEn?: unknown
  calibrateSystemPromptZh?: unknown
}

const withoutCalibrationConfig = (writing: WritingConfig): WritingConfig => {
  const current: LegacyCalibratedWritingConfig = { ...writing }
  delete current.calibrateProviderId
  delete current.calibrationEnabled
  delete current.calibrateSystemPrompt
  delete current.calibrateTemperature
  delete current.calibrateTopP
  delete current.calibrateSystemPromptEn
  delete current.calibrateSystemPromptZh
  return current
}

/**
 * The pre-P1 outline prompt told the model that prose polish was deferred to a
 * dedicated calibration step that no longer exists. Configs saved while that
 * template was current froze it into the per-language slot, so the
 * strengthened source-draft prompt ("no later cleanup pass; this output owns
 * plot and prose") never reached real runs. Such slots are refreshed to the
 * current built-in at load time.
 */
const SUPERSEDED_OUTLINE_MARKERS = [
  '由后续的专门校准步骤统一处理',
  'handled by a dedicated calibration step afterwards',
]

const isSupersededOutlinePrompt = (text: string): boolean =>
  SUPERSEDED_OUTLINE_MARKERS.some((marker) => text.includes(marker))

export const getConfig = (): AppConfig => {
  // Clone the loaded config so the per-language slot block below never mutates
  // the module-level defaults (getConfig is called per chat request, and
  // readJSON hands back the DEFAULT_CONFIG singleton when no config.json
  // exists). DEFAULT_CONFIG and the section defaults are plain data, so
  // structuredClone is safe.
  const cfg = structuredClone(readJSON(configFile(), DEFAULT_CONFIG))
  cfg.ai.providers = cfg.ai.providers.map(withoutProviderPricing)
  // 若用户配置里 personas 为空，回落到默认
  if (!cfg.personas || cfg.personas.length === 0)
    cfg.personas = structuredClone(DEFAULT_CONFIG.personas)
  // 旧版 config.json 无 consistency 块，回落到默认
  if (!cfg.consistency) cfg.consistency = structuredClone(DEFAULT_CONFIG.consistency)
  // 旧版 config.json 无 writing 块，回落到默认
  if (!cfg.writing) cfg.writing = structuredClone(DEFAULT_WRITING)
  cfg.writing = withoutCalibrationConfig(cfg.writing)
  // 旧版 writing 块缺少 temperature / topP / rewriteSystemPrompt 时补齐默认值
  if (cfg.writing.temperature == null) cfg.writing.temperature = DEFAULT_WRITING.temperature
  if (cfg.writing.topP == null) cfg.writing.topP = DEFAULT_WRITING.topP
  if (cfg.writing.rewriteSystemPrompt == null)
    cfg.writing.rewriteSystemPrompt = DEFAULT_WRITING.rewriteSystemPrompt

  // ---- Per-language prompt slots ----
  // saveConfig archives each editable prompt into a <field>En / <field>Zh slot
  // for the current PROMPT_LANG. Once a config carries any such slot, the
  // active field is resolved from the current locale's slot (falling back to
  // the built-in default), so saving Chinese prompts never overwrites English
  // ones and vice versa. Legacy configs without slots are left untouched.
  const langIsZh = PROMPT_LANG === 'zh'
  const hasLangSlots =
    cfg.personas.some((p) => p.systemPromptEn !== undefined || p.systemPromptZh !== undefined) ||
    cfg.consistency.systemPromptEn !== undefined ||
    cfg.consistency.systemPromptZh !== undefined ||
    cfg.consistency.userTemplateEn !== undefined ||
    cfg.consistency.userTemplateZh !== undefined ||
    cfg.writing.outlineSystemPromptEn !== undefined ||
    cfg.writing.outlineSystemPromptZh !== undefined ||
    cfg.writing.rewriteSystemPromptEn !== undefined ||
    cfg.writing.rewriteSystemPromptZh !== undefined
  if (hasLangSlots) {
    for (const p of cfg.personas) {
      const slot = langIsZh ? p.systemPromptZh : p.systemPromptEn
      if (slot !== undefined) p.systemPrompt = slot
      else {
        // Slot missing for the current locale: fall back to the built-in
        // persona (same id) or keep the legacy value for user-created ones.
        const builtin = DEFAULT_CONFIG.personas.find((bp) => bp.id === p.id)
        p.systemPrompt = builtin?.systemPrompt ?? p.systemPrompt
      }
    }
    const cons = cfg.consistency
    const consSp = langIsZh ? cons.systemPromptZh : cons.systemPromptEn
    cons.systemPrompt = consSp !== undefined ? consSp : DEFAULT_CONFIG.consistency.systemPrompt
    const consUt = langIsZh ? cons.userTemplateZh : cons.userTemplateEn
    cons.userTemplate = consUt !== undefined ? consUt : DEFAULT_CONFIG.consistency.userTemplate
    const w = cfg.writing
    let wO = langIsZh ? w.outlineSystemPromptZh : w.outlineSystemPromptEn
    // Slots that froze the superseded two-pass outline prompt are refreshed to
    // the current built-in so the source-draft contract actually takes effect.
    if (wO !== undefined && isSupersededOutlinePrompt(wO)) wO = PROMPTS.assist.outlinePrompt
    w.outlineSystemPrompt = wO !== undefined ? wO : PROMPTS.assist.outlinePrompt
    const wR = langIsZh ? w.rewriteSystemPromptZh : w.rewriteSystemPromptEn
    w.rewriteSystemPrompt = wR !== undefined ? wR : PROMPTS.assist.rewritePrompt
  }

  // Move the untouched legacy default to the selected DeepSeek writing model.
  const legacyDefaultProvider = cfg.ai.providers.find(
    (provider) =>
      provider.id === 'default-openai' &&
      provider.baseUrl.toLowerCase().includes('api.deepseek.com') &&
      provider.model === 'deepseek-v4-pro',
  )
  if (legacyDefaultProvider) legacyDefaultProvider.model = 'deepseek-v4-flash'

  // 旧版明文 API Key 自动迁移：只要有 key 还没被加密且当前环境支持加密，
  // 就回写一次密文。这样用户升级后第一次启动即可把旧明文 key 转为密文。
  const needsMigrate = cfg.ai.providers.some((p) => p.apiKey && !p.apiKey.startsWith('enc:v1:'))
  if (needsMigrate) {
    const encrypted: AppConfig = {
      ...cfg,
      ai: {
        ...cfg.ai,
        providers: cfg.ai.providers.map((p) => ({
          ...p,
          apiKey: encryptSecret(p.apiKey) ?? '',
        })),
      },
    }
    // This is a read-time write, so it must respect the same rule as saveConfig:
    // never persist a config built from a file that could not be read.
    assertWritable(configFile(), 'Settings')
    writeJSON(configFile(), encrypted)
  }

  // 解密 API Key 供内存使用（旧版无前缀的明文会直接透传）。
  for (const p of cfg.ai.providers) {
    p.apiKey = decryptSecret(p.apiKey) ?? ''
  }

  return cfg
}

export const saveConfig = (cfg: AppConfig): void => {
  // Archive every editable prompt into the per-language slot matching the
  // current PROMPT_LANG. The other locale's slot is left untouched, so saving
  // English prompts never overwrites the Chinese ones (and vice versa).
  //
  // Legacy configs (no slots at all) get both slots written on their first
  // save: the plain field may hold a custom prompt written before the slot
  // system existed, and we cannot know its language — writing it to both
  // locales keeps it reachable whichever language is active later.
  const langIsZh = PROMPT_LANG === 'zh'
  const writing = withoutCalibrationConfig(cfg.writing)
  const hasAnySlot =
    cfg.personas.some((p) => p.systemPromptEn !== undefined || p.systemPromptZh !== undefined) ||
    cfg.consistency.systemPromptEn !== undefined ||
    cfg.consistency.systemPromptZh !== undefined ||
    cfg.consistency.userTemplateEn !== undefined ||
    cfg.consistency.userTemplateZh !== undefined ||
    writing.outlineSystemPromptEn !== undefined ||
    writing.outlineSystemPromptZh !== undefined ||
    writing.rewriteSystemPromptEn !== undefined ||
    writing.rewriteSystemPromptZh !== undefined
  const archive = (field: string, value: string): Record<string, string> =>
    hasAnySlot
      ? langIsZh
        ? { [`${field}Zh`]: value }
        : { [`${field}En`]: value }
      : { [`${field}En`]: value, [`${field}Zh`]: value }

  const localized: AppConfig = {
    ...cfg,
    personas: cfg.personas.map((p) => ({ ...p, ...archive('systemPrompt', p.systemPrompt) })),
    consistency: {
      ...cfg.consistency,
      ...archive('systemPrompt', cfg.consistency.systemPrompt),
      ...archive('userTemplate', cfg.consistency.userTemplate),
    },
    writing: {
      ...writing,
      ...archive('outlineSystemPrompt', writing.outlineSystemPrompt),
      ...archive('rewriteSystemPrompt', writing.rewriteSystemPrompt),
    },
  }
  const encrypted: AppConfig = {
    ...localized,
    ai: {
      ...localized.ai,
      providers: localized.ai.providers.map((p) => {
        const current = withoutProviderPricing(p)
        return { ...current, apiKey: encryptSecret(current.apiKey) ?? '' }
      }),
    },
  }
  // An unreadable config.json reads as the built-in defaults, so saving over it
  // would discard every provider, API key, persona and prompt slot the author
  // configured. Refuse and keep the damaged file for repair.
  assertWritable(configFile(), 'Settings')
  writeJSON(configFile(), encrypted)
}

// ---- 设定文档 ----// ---- 外部文件夹映射（只读 codex 文档源）----
// 外部文档 id 形如 "external:<mappingId>/<relPath>"，relPath 为相对映射根目录的
// posix 路径（服务端遍历生成，不信任渲染端输入）。外部文档只读：写/删一律拒绝。
const EXTERNAL_ID_PREFIX = 'external:'

const isExternalId = (id: string): boolean => id.startsWith(EXTERNAL_ID_PREFIX)

/** Parse an external doc id into mapping id + relative path; null if malformed. */
function parseExternalId(id: string): { mappingId: string; relPath: string } | null {
  const rest = id.slice(EXTERNAL_ID_PREFIX.length)
  const idx = rest.indexOf('/')
  if (idx <= 0) return null
  return { mappingId: rest.slice(0, idx), relPath: rest.slice(idx + 1) }
}

const mappingsFile = (): string => join(currentWorldDir(), 'mappings.json')

/** Read-only accessor for the world's external folder mappings (lenient). */
export function readExternalMappings(): ExternalMapping[] {
  return readJSON<ExternalMapping[]>(mappingsFile(), [])
}

function writeExternalMappings(list: ExternalMapping[]): void {
  writeJSON(mappingsFile(), list)
}

const newMappingId = (existing: ExternalMapping[]): string => {
  let id = ''
  do {
    id = `m_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  } while (existing.some((m) => m.id === id))
  return id
}

/**
 * Register an external folder as a read-only codex source. Validates that the
 * path is absolute and is an existing directory; never writes into it.
 */
export function addExternalMapping(input: {
  name?: string
  rootPath: string
  category: SettingCategory
}): ExternalMapping {
  if (!isAbsolute(input.rootPath)) {
    throw new Error('External folder path must be absolute.')
  }
  if (!existsSync(input.rootPath) || !statSync(input.rootPath).isDirectory()) {
    throw new Error('External folder does not exist or is not a directory.')
  }
  // 拒绝世界目录内部或其子目录：否则同一文件会同时以内部文档和只读外部
  // 文档出现，内部写入会落在“承诺永不修改”的外部文件上。
  const rel = relative(currentWorldDir(), input.rootPath)
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new Error('External folder must be outside the world directory.')
  }
  const existing = readExternalMappings()
  const mapping: ExternalMapping = {
    id: newMappingId(existing),
    name: input.name?.trim() || basename(input.rootPath) || 'External',
    rootPath: input.rootPath,
    category: input.category,
    addedAt: Date.now(),
  }
  writeExternalMappings([...existing, mapping])
  return mapping
}

export function removeExternalMapping(id: string): void {
  writeExternalMappings(readExternalMappings().filter((m) => m.id !== id))
}

/**
 * Resolve an external doc path under a mapping root, refusing escapes via
 * symlinks: after the lexical safeResolve, the real path must stay under the
 * mapping root's real path. Throws when the file does not exist or escapes;
 * callers treat a throw as an unreadable doc ('' content).
 */
function resolveExternalFile(mapping: ExternalMapping, relPath: string): string {
  const resolved = safeResolve(mapping.rootPath, relPath)
  const rootReal = realpathSync(mapping.rootPath)
  const fileReal = realpathSync(resolved)
  const rel = relative(rootReal, fileReal)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('Invalid path.')
  }
  return resolved
}

/**
 * Walk a mapping root for `*.md` files and append their SettingDocs. Skips
 * hidden entries and symlinks (Dirent isDirectory/isFile do not follow links,
 * so linked-out files never surface); a vanished root is skipped silently.
 * Per-entry failures (file deleted mid-walk) skip that entry; depth is capped.
 */
function collectExternalDocs(mapping: ExternalMapping, out: SettingDoc[]): void {
  if (!existsSync(mapping.rootPath)) return
  const MAX_DEPTH = 32
  const walk = (dir: string, prefix: string, depth: number): void => {
    if (depth > MAX_DEPTH) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const full = join(dir, e.name)
      const relPath = prefix ? `${prefix}/${e.name}` : e.name
      try {
        if (e.isDirectory()) {
          walk(full, relPath, depth + 1)
        } else if (e.isFile() && extname(e.name).toLowerCase() === '.md') {
          out.push({
            id: `${EXTERNAL_ID_PREFIX}${mapping.id}/${relPath}`,
            title: basename(e.name, '.md'),
            category: mapping.category,
            updatedAt: statSync(full).mtimeMs,
            external: { mappingId: mapping.id, relPath },
          })
        }
      } catch {
        // 文件在遍历中被删除/不可读：跳过该条目，不中断整个合并。
      }
    }
  }
  walk(mapping.rootPath, '', 0)
}

export function listSettings(): SettingDoc[] {
  const out: SettingDoc[] = []
  for (const cat of SETTING_CATEGORIES) {
    const dir = join(settingsDir(), cat)
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) {
      if (extname(f) !== '.md') continue
      const full = join(dir, f)
      out.push({
        id: `${cat}/${f}`,
        title: basename(f, '.md'),
        category: cat,
        updatedAt: statSync(full).mtimeMs,
      })
    }
  }
  // Merge read-only docs mapped from external folders.
  for (const mapping of readExternalMappings()) collectExternalDocs(mapping, out)
  // Sort by title with natural ordering so numeric prefixes (00-xx, 01-xx...) sort
  // by value, consistent with how outline docs are ordered.
  return out.sort((a, b) =>
    a.title.localeCompare(b.title, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' }),
  )
}

const settingPath = (id: string): string => {
  // id 形如 "worldview/世界观.md"，禁止路径穿越。
  // 用 resolved 路径校验取代单次 regex 替换，后者可被 ....// 等模式绕过。
  return safeResolve(settingsDir(), id)
}

export function readSetting(id: string): SettingDocContent {
  // Read-only external docs: resolve against the mapping root (path-traversal
  // guarded), never write; unknown mapping / missing file → '' like internal.
  if (isExternalId(id)) {
    const parsed = parseExternalId(id)
    if (!parsed) {
      return {
        id,
        title: basename(id, '.md'),
        category: '99-misc',
        updatedAt: Date.now(),
        content: '',
      }
    }
    const mapping = readExternalMappings().find((m) => m.id === parsed.mappingId)
    let full: string
    let content = ''
    let updatedAt = Date.now()
    try {
      full = mapping ? resolveExternalFile(mapping, parsed.relPath) : ''
      // 防 crafted id 指向真实目录：仅读取常规文件（isFile），其余一律视为空文档。
      if (full && statSync(full).isFile()) {
        content = readFileSync(full, 'utf-8')
        updatedAt = statSync(full).mtimeMs
      }
    } catch {
      content = ''
    }
    return {
      id,
      title: basename(parsed.relPath, '.md'),
      category: mapping?.category ?? '99-misc',
      updatedAt,
      content,
      external: { mappingId: parsed.mappingId, relPath: parsed.relPath },
    }
  }
  const full = settingPath(id)
  const [cat] = id.split('/')
  return {
    id,
    title: basename(id, '.md'),
    category: cat as SettingCategory,
    updatedAt: existsSync(full) ? statSync(full).mtimeMs : Date.now(),
    content: existsSync(full) ? readFileSync(full, 'utf-8') : '',
  }
}

export function writeSetting(id: string, content: string): void {
  if (isExternalId(id)) return // read-only external docs: refuse writes
  const full = settingPath(id)
  snapshot(full) // 覆盖前先留旧版
  atomicWrite(full, content)
}

export function createSetting(category: SettingCategory, title: string): SettingDoc {
  const safeTitle = title.replace(/[/\\:*?"<>|]/g, '_').trim() || 'Untitled'
  const id = `${category}/${safeTitle}.md`
  const full = settingPath(id)
  if (!existsSync(full)) {
    const template = CATEGORY_TEMPLATES[category]
    const content = template ? template.replace(/\{\{title\}\}/g, safeTitle) : `# ${safeTitle}\n\n`
    atomicWrite(full, content)
  }
  return { id, title: safeTitle, category, updatedAt: Date.now() }
}

export function deleteSetting(id: string): void {
  if (isExternalId(id)) return // read-only external docs: refuse deletes
  const full = settingPath(id)
  if (existsSync(full)) {
    snapshot(full) // 删除前先留旧版，可从历史找回
    unlinkSync(full)
  }
}

// ---- 章节正文 ----
const chapterPath = (file: string): string => {
  const safe = file.replace(/[/\\]/g, '_')
  return safeResolve(chaptersDir(), safe)
}

export function readChapter(file: string): string {
  const full = chapterPath(file)
  return existsSync(full) ? readFileSync(full, 'utf-8') : ''
}

export function writeChapter(file: string, content: string): void {
  const full = chapterPath(file)
  snapshot(full) // 覆盖前先留旧版
  atomicWrite(full, content)
}

/**
 * Search the manuscript's prose.
 *
 * Reads the chapter files, so results always match what is on disk rather than a
 * cached copy. Bounded by the chapter count: a world holds at most a few hundred
 * small Markdown files, and planned chapters still hold nothing but a heading.
 */
export function searchManuscriptProse(query: string, limit?: number): ChapterProseMatch[] {
  if (!query.trim()) return []
  const meta = readJSON<NovelMeta>(novelFile(), DEFAULT_NOVEL_META)
  const sources: ChapterProseSource[] = []
  for (const volume of meta.volumes) {
    for (const chapter of volume.chapters) {
      const text = readChapter(chapter.file)
      if (!hasSearchableProse(text)) continue
      sources.push({ chapterId: chapter.id, chapterTitle: chapter.title, text })
    }
  }
  return searchChapterProseMatches(sources, query, limit)
}

// ---- Generation evidence ----

const generationRunPath = (id: string): string => {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid generation run id.')
  return safeResolve(generationRunsDir(), `${id}.json`)
}

const hashMessages = (stage: GenerationStage): string =>
  createHash('sha256').update(JSON.stringify(stage.messages)).digest('hex')

type LegacyCostedGenerationStage = GenerationStage & { cost?: unknown }

const withoutGenerationStagePricing = (stage: GenerationStage): GenerationStage => {
  const current: LegacyCostedGenerationStage = { ...stage }
  delete current.cost
  current.provider = withoutProviderPricing(current.provider as LegacyPricedProvider)
  return current
}

const withoutGenerationRunPricing = (run: GenerationRun): GenerationRun => ({
  ...run,
  stages: run.stages.map(withoutGenerationStagePricing),
})

const normalizeStageEvidence = (stage: GenerationStage): GenerationStage => {
  const current = withoutGenerationStagePricing(stage)
  const usage =
    current.status !== 'running' && current.usage.source === 'unavailable'
      ? estimateChatUsage(current.messages, current.output)
      : current.usage
  return {
    ...current,
    promptHash: hashMessages(current),
    usage,
  }
}

const hasCompletedSourceDraft = (run: GenerationRun): boolean => {
  if (run.reproductionOf) return false
  const draft = run.stages.find((stage) => stage.kind === 'draft')
  return draft?.status === 'completed' && Boolean(draft.output.trim())
}

const isValidGenerationBaseline = (run: GenerationRun): boolean =>
  Boolean(run.baseline) && hasCompletedSourceDraft(run)

const hasGenerationBaseline = (exceptId?: string): boolean => {
  const dir = generationRunsDir()
  if (!existsSync(dir)) return false
  return readdirSync(dir).some((file) => {
    if (extname(file) !== '.json') return false
    const run = readJSON<GenerationRun | null>(join(dir, file), null)
    return Boolean(
      run?.version === 1 && run.id !== exceptId && run.id && isValidGenerationBaseline(run),
    )
  })
}

/**
 * How many generation runs a world keeps on disk.
 *
 * A run stores its full prompt messages, context layers, raw output and the
 * author's saved text — measured at ~200 KB each — and nothing used to remove
 * them, so the archive grew without bound while every listing and every stage
 * save re-parsed all of it. The window follows the same policy as the version
 * snapshots: keep a useful recent history, discard the rest.
 */
const GENERATION_RUN_KEEP = 60

/**
 * Whether a run must survive pruning because it cannot be recreated.
 *
 * A baseline is the reference point every later comparison is measured against,
 * and a run carrying author evidence holds the only record of how much of a
 * draft the author actually kept. Both are historical facts, not diagnostics.
 */
const isProtectedGenerationRun = (run: GenerationRun): boolean =>
  Boolean(run.baseline) || Boolean(run.authorResult)

/**
 * Delete the oldest generation runs beyond the retention window. Returns how
 * many were removed. Runs that cannot be recreated are always kept, as is the
 * source of any kept reproduction and the oldest completed run, which is what
 * the baseline promotion in `listGenerationRuns` picks.
 */
export function pruneGenerationRuns(keep = GENERATION_RUN_KEEP): number {
  const dir = generationRunsDir()
  if (!existsSync(dir)) return 0
  const runs: GenerationRun[] = []
  for (const file of readdirSync(dir)) {
    if (extname(file) !== '.json') continue
    const run = readJSON<GenerationRun | null>(join(dir, file), null)
    if (run?.version === 1 && run.id) runs.push(run)
  }
  if (runs.length <= keep) return 0

  const newestFirst = [...runs].sort((a, b) => b.createdAt - a.createdAt)
  const kept = new Set(newestFirst.slice(0, keep).map((run) => run.id))
  for (const run of newestFirst) {
    if (isProtectedGenerationRun(run)) kept.add(run.id)
    // The source of a kept reproduction has to outlive it, or the kept run's
    // replay link dangles.
    if (run.reproductionOf && kept.has(run.id)) kept.add(run.reproductionOf)
  }
  const oldestComplete = [...runs]
    .filter(hasCompletedSourceDraft)
    .sort((a, b) => a.createdAt - b.createdAt)[0]
  if (oldestComplete) kept.add(oldestComplete.id)

  let removed = 0
  for (const run of newestFirst) {
    if (kept.has(run.id)) continue
    try {
      unlinkSync(generationRunPath(run.id))
      removed++
    } catch {
      // A run that cannot be removed is left in place; retention is best-effort.
    }
  }
  return removed
}

export function createGenerationRun(input: CreateGenerationRunInput): GenerationRun {
  ensureDir(generationRunsDir())
  const full = generationRunPath(input.id)
  if (existsSync(full)) throw new Error('Generation run already exists.')
  if (input.reproductionOf) {
    const source = readGenerationRun(input.reproductionOf)
    if (!source) throw new Error('Generation reproduction source not found.')
    if (source.chapterId !== input.chapterId || source.chapterTitle !== input.chapterTitle) {
      throw new Error('Generation reproduction must keep the source chapter identity.')
    }
  }
  const now = Date.now()
  const run: GenerationRun = {
    version: 1,
    id: input.id,
    pipeline: 'source-draft',
    mode: 'outline-write',
    chapterId: input.chapterId,
    chapterTitle: input.chapterTitle,
    createdAt: now,
    updatedAt: now,
    stages: [],
    selectedResult: null,
    authorResult: null,
    baseline: null,
    reproductionOf: input.reproductionOf ?? null,
  }
  writeJSON(full, run)
  // Prune at creation: a bounded, predictable moment that needs no extra UI.
  pruneGenerationRuns()
  return run
}

export function saveGenerationStage(runId: string, stage: GenerationStage): GenerationRun {
  ensureDir(generationRunsDir())
  const full = generationRunPath(runId)
  const stored = readJSON<GenerationRun | null>(full, null)
  if (!stored || stored.version !== 1 || stored.id !== runId) {
    throw new Error('Generation run not found or invalid.')
  }
  const current = withoutGenerationRunPricing(stored)
  if (!/^[A-Za-z0-9_-]+$/.test(stage.id)) throw new Error('Invalid generation stage id.')
  if (stage.kind !== 'draft') {
    throw new Error('Calibration stages are historical evidence and cannot be created or updated.')
  }
  const index = current.stages.findIndex((item) => item.id === stage.id)
  const existing = current.stages[index]
  const savedStage = normalizeStageEvidence(
    existing
      ? {
          ...existing,
          status: stage.status,
          durationMs: stage.durationMs,
          finishReason: stage.finishReason,
          usage: stage.usage,
          output: stage.output,
          error: stage.error,
        }
      : stage,
  )
  const stages = [...current.stages]
  if (index === -1) stages.push(savedStage)
  else stages[index] = savedStage
  const next: GenerationRun = { ...current, updatedAt: Date.now(), stages }
  const saved: GenerationRun =
    !next.baseline && hasCompletedSourceDraft(next) && !hasGenerationBaseline(next.id)
      ? {
          ...next,
          baseline: {
            capturedAt: Date.now(),
            pipelineVersion:
              next.pipeline === 'legacy-two-pass' ? 'legacy-two-pass-v1' : 'source-draft-v2',
          },
        }
      : next
  writeJSON(full, saved)
  return saved
}

export function readGenerationRun(id: string): GenerationRun | null {
  const full = generationRunPath(id)
  const run = readJSON<GenerationRun | null>(full, null)
  if (!run || run.version !== 1 || run.id !== id) return null
  const cleaned = withoutGenerationRunPricing(run)
  if (JSON.stringify(cleaned) !== JSON.stringify(run)) writeJSON(full, cleaned)
  return cleaned
}

export function selectGenerationResult(
  runId: string,
  result: Omit<GenerationSelectedResult, 'selectedAt'>,
): GenerationRun {
  const full = generationRunPath(runId)
  const stored = readJSON<GenerationRun | null>(full, null)
  if (!stored || stored.version !== 1 || stored.id !== runId) {
    throw new Error('Generation run not found or invalid.')
  }
  const current = withoutGenerationRunPricing(stored)
  if (result.kind !== 'draft') {
    throw new Error('Calibration results are historical evidence and cannot be newly selected.')
  }
  const stageIds = Array.from(new Set(result.stageIds))
  if (stageIds.length === 0 || !result.text) throw new Error('Invalid generation selection.')
  const selectedStages = stageIds.map((id) => current.stages.find((stage) => stage.id === id))
  if (selectedStages.some((stage) => !stage)) throw new Error('Generation stage not found.')
  const expectedStageIds = current.stages
    .filter((stage) => stage.kind === 'draft')
    .map((stage) => stage.id)
  if (!selectedStages.every((stage) => stage?.kind === 'draft')) {
    throw new Error('Generation selection does not match its stages.')
  }
  if (
    stageIds.length !== expectedStageIds.length ||
    expectedStageIds.some((id) => !stageIds.includes(id))
  ) {
    throw new Error('Generation selection must include every source stage of its kind.')
  }
  const now = Date.now()
  const saved: GenerationRun = {
    ...current,
    updatedAt: now,
    selectedResult: { ...result, stageIds, selectedAt: now },
    authorResult: null,
  }
  writeJSON(full, saved)
  return saved
}

export function saveGenerationAuthorResult(
  runId: string,
  result: SaveGenerationAuthorResultInput,
): GenerationRun {
  const full = generationRunPath(runId)
  const stored = readJSON<GenerationRun | null>(full, null)
  if (!stored || stored.version !== 1 || stored.id !== runId) {
    throw new Error('Generation run not found or invalid.')
  }
  const current = withoutGenerationRunPricing(stored)
  if (!current.selectedResult) throw new Error('Generation result has not been selected.')
  const now = Date.now()
  if (
    !Number.isFinite(result.editingStartedAt) ||
    result.editingStartedAt < current.selectedResult.selectedAt ||
    result.editingStartedAt > now
  ) {
    throw new Error('Invalid generation editing start time.')
  }
  const saved: GenerationRun = {
    ...current,
    updatedAt: now,
    authorResult: {
      text: result.text,
      savedAt: now,
      editingStartedAt: result.editingStartedAt,
      editingDurationMs: now - result.editingStartedAt,
      durationMeasurement: 'elapsed',
      retentionRatio: calculateRetentionRatio(current.selectedResult.text, result.text),
    },
  }
  writeJSON(full, saved)
  return saved
}

const summarizeGenerationRun = (run: GenerationRun): GenerationRunSummary => ({
  id: run.id,
  chapterId: run.chapterId,
  chapterTitle: run.chapterTitle,
  createdAt: run.createdAt,
  updatedAt: run.updatedAt,
  stageCount: run.stages.length,
  status: run.stages.at(-1)?.status ?? 'empty',
  selectedResultKind: run.selectedResult?.kind ?? null,
  hasAuthorResult: Boolean(run.authorResult),
  retentionRatio: run.authorResult?.retentionRatio ?? null,
  isBaseline: isValidGenerationBaseline(run),
  reproductionOf: run.reproductionOf ?? null,
})

export function listGenerationRuns(chapterId?: string): GenerationRunSummary[] {
  const dir = generationRunsDir()
  if (!existsSync(dir)) return []
  const runs: GenerationRun[] = []
  for (const file of readdirSync(dir)) {
    if (extname(file) !== '.json') continue
    const full = join(dir, file)
    const run = readJSON<GenerationRun | null>(full, null)
    if (!run || run.version !== 1 || !run.id) continue
    const cleaned = withoutGenerationRunPricing(run)
    if (JSON.stringify(cleaned) !== JSON.stringify(run)) writeJSON(full, cleaned)
    if (chapterId && cleaned.chapterId !== chapterId) continue
    runs.push(cleaned)
  }
  if (!chapterId && !runs.some(isValidGenerationBaseline)) {
    const candidate = runs
      .filter(hasCompletedSourceDraft)
      .sort((a, b) => a.createdAt - b.createdAt)[0]
    if (candidate) {
      candidate.baseline = {
        capturedAt: Date.now(),
        pipelineVersion:
          candidate.pipeline === 'legacy-two-pass' ? 'legacy-two-pass-v1' : 'source-draft-v2',
      }
      candidate.updatedAt = Date.now()
      writeJSON(generationRunPath(candidate.id), candidate)
    }
  }
  return runs.sort((a, b) => b.createdAt - a.createdAt).map(summarizeGenerationRun)
}

// ---- 批量写作（batch write）专用接口 ----
// ---- 版本快照 RPC ----
/** Map source file path to display name and type. */
function describeSource(sourcePath: string): { label: string; kind: SnapshotEntry['kind'] } {
  if (sourcePath.startsWith('settings/')) {
    return { label: basename(sourcePath, '.md'), kind: 'setting' }
  }
  if (sourcePath === 'outline/outline.json') return { label: 'Outline', kind: 'outline' }
  if (sourcePath.startsWith('outline/')) {
    const name = basename(sourcePath, '.md')
    return { label: name === 'outline' ? 'Outline' : name, kind: 'outline' }
  }
  if (sourcePath === 'novel.json') return { label: 'Novel Metadata', kind: 'novel' }
  if (sourcePath === 'timeline.json') return { label: 'Timeline', kind: 'timeline' }
  if (sourcePath === 'voice-profile.json') return { label: 'Voice Profile', kind: 'voice' }
  if (sourcePath === 'exemplars.json') return { label: 'Style Exemplars', kind: 'voice' }
  if (sourcePath === 'review-queue.json') return { label: 'Review Queue', kind: 'reviewQueue' }
  if (sourcePath.startsWith('discussions/')) {
    const s = readJSON<DiscussionSession | null>(join(currentWorldDir(), sourcePath), null)
    return { label: s?.topic ?? basename(sourcePath, '.json'), kind: 'discussion' }
  }
  if (sourcePath.startsWith('character-chats/')) {
    const s = readJSON<CharacterChatSession | null>(join(currentWorldDir(), sourcePath), null)
    let fallback = basename(sourcePath, '.json')
    try {
      fallback = decodeURIComponent(fallback)
    } catch {
      // 手工构造的非法编码目录名，保留原样即可
    }
    return { label: s?.characterTitle ?? fallback, kind: 'characterChat' }
  }
  // chapters/<file>.md → 用 novel.json 里的章节标题（找不到就用文件名）
  const file = basename(sourcePath)
  const novel = readJSON<NovelMeta>(novelFile(), DEFAULT_NOVEL_META)
  for (const v of novel.volumes) {
    for (const c of v.chapters) {
      if (c.file === file) return { label: c.title, kind: 'chapter' }
    }
  }
  return { label: file, kind: 'chapter' }
}

export function listSnapshots(): SnapshotEntry[] {
  const root = snapshotsDir()
  if (!existsSync(root)) return []
  const out: SnapshotEntry[] = []
  for (const key of readdirSync(root)) {
    const dir = join(root, key)
    let sourcePath: string
    try {
      sourcePath = decodeURIComponent(key)
    } catch {
      continue // 非本引擎产生的目录，跳过
    }
    const { label, kind } = describeSource(sourcePath)
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.snap')) continue
      const ts = Number(basename(f, '.snap'))
      if (Number.isNaN(ts)) continue
      out.push({
        id: `${key}/${f}`,
        sourcePath,
        label,
        kind,
        ts,
        size: statSync(join(dir, f)).size,
      })
    }
  }
  return out.sort((a, b) => b.ts - a.ts)
}

// 校验快照 id 形如 "<key>/<ts>.snap"、无路径穿越，返回其绝对路径与源路径
const resolveSnapshot = (id: string): { full: string; sourcePath: string } => {
  const [key, file] = id.split('/')
  if (
    !key ||
    !file ||
    key.includes('..') ||
    key.includes('/') ||
    file.includes('..') ||
    !file.endsWith('.snap')
  ) {
    throw new Error('Invalid snapshot id.')
  }
  const sourcePath = decodeURIComponent(key)
  return { full: safeResolve(snapshotsDir(), key, file), sourcePath }
}

export function readSnapshot(id: string): string {
  const { full } = resolveSnapshot(id)
  return existsSync(full) ? readFileSync(full, 'utf-8') : ''
}

/** Write snapshot content back to source file. Also snapshots the current version first for undo. */
export function restoreSnapshot(id: string): void {
  const { full, sourcePath } = resolveSnapshot(id)
  if (!existsSync(full)) throw new Error('Snapshot not found.')
  // safeResolve 拒绝解码后仍含 ".." 的源路径（编码形式的穿越无法被字面检查拦下）
  const dest = safeResolve(currentWorldDir(), sourcePath)
  snapshot(dest, true) // 回写前强制给当前版留底（跳过节流），确保恢复动作本身可反悔
  atomicWrite(dest, readFileSync(full, 'utf-8'))
  // novel.json 恢复后同步 worlds.json 的标题/题材镜像，避免世界列表显示恢复前的旧标题
  if (sourcePath === 'novel.json') {
    syncWorldFromNovel(readJSON<NovelMeta>(novelFile(), DEFAULT_NOVEL_META))
  }
}

/** Read the current content of a world file (for History diff previews). */
export function readWorldFile(sourcePath: string): string {
  const full = safeResolve(currentWorldDir(), sourcePath)
  return existsSync(full) ? readFileSync(full, 'utf-8') : ''
}

// ---- 时间线 ----
const timelineFile = (): string => join(currentWorldDir(), 'timeline.json')

export function listTimelineEvents(): TimelineEvent[] {
  try {
    return readJSON<TimelineEvent[]>(timelineFile(), [])
  } catch {
    return []
  }
}

export function saveTimelineEvents(events: TimelineEvent[]): void {
  assertWritable(timelineFile(), 'The timeline')
  snapshot(timelineFile())
  writeJSON(timelineFile(), events)
}

// ---- Story Memory ----

const STORY_MEMORY_KINDS = new Set<StoryMemoryKind>([
  'character-state',
  'relationship',
  'knowledge',
  'location',
  'object',
  'world-state',
  'open-thread',
])
const STORY_MEMORY_STATUSES = new Set<StoryMemoryStatus>(['suggested', 'confirmed', 'rejected'])
const STORY_MEMORY_BACKUP_KEEP = 10

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid Story Memory ${field}.`)
  return value
}

const requiredNumber = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid Story Memory ${field}.`)
  }
  return value
}

/**
 * Validate a Story Memory source.
 *
 * AI-extracted memories must cite the chapter they came from: the fingerprint
 * is what ties them to that prose and marks them stale once it changes. A
 * memory the author enters by hand — a Writers' Room conclusion or a Character
 * Chat discovery — has no chapter provenance by design (the UI records an empty
 * source and shows it as an author note), so an absent source is accepted for
 * `origin === 'author'`, and only then. An empty source is normalised to fully
 * empty so a half-filled one can never claim provenance it does not have.
 */
function normalizeStoryMemorySource(
  source: Record<string, unknown>,
  origin: StoryMemoryEntry['origin'],
): StoryMemorySource {
  const chapterId = typeof source.chapterId === 'string' ? source.chapterId.trim() : ''
  if (!chapterId) {
    if (origin !== 'author') throw new Error('Invalid Story Memory source chapter id.')
    return {
      chapterId: '',
      chapterFile: '',
      chapterTitle: '',
      volumeId: '',
      volumeOrder: -1,
      chapterOrder: -1,
      fingerprint: '',
      evidence: '',
    }
  }
  return {
    chapterId: requiredString(source.chapterId, 'source chapter id'),
    chapterFile: requiredString(source.chapterFile, 'source chapter file'),
    chapterTitle: requiredString(source.chapterTitle, 'source chapter title'),
    volumeId: requiredString(source.volumeId, 'source volume id'),
    volumeOrder: requiredNumber(source.volumeOrder, 'source volume order'),
    chapterOrder: requiredNumber(source.chapterOrder, 'source chapter order'),
    fingerprint: requiredString(source.fingerprint, 'source fingerprint'),
    evidence: requiredString(source.evidence, 'source evidence'),
  }
}

function normalizeStoryMemoryEntry(value: unknown): StoryMemoryEntry {
  if (!isRecord(value) || !isRecord(value.source)) throw new Error('Invalid Story Memory entry.')
  const source = value.source
  if (!STORY_MEMORY_KINDS.has(value.kind as StoryMemoryKind)) {
    throw new Error('Invalid Story Memory kind.')
  }
  if (!STORY_MEMORY_STATUSES.has(value.status as StoryMemoryStatus)) {
    throw new Error('Invalid Story Memory status.')
  }
  if (value.origin !== 'ai' && value.origin !== 'author')
    throw new Error('Invalid Story Memory origin.')
  if (
    !Array.isArray(value.entityRefIds) ||
    value.entityRefIds.some((id) => typeof id !== 'string')
  ) {
    throw new Error('Invalid Story Memory entity references.')
  }
  if (value.timelineEventId !== null && typeof value.timelineEventId !== 'string') {
    throw new Error('Invalid Story Memory timeline reference.')
  }
  if (
    value.confidence !== null &&
    (typeof value.confidence !== 'number' || value.confidence < 0 || value.confidence > 1)
  ) {
    throw new Error('Invalid Story Memory confidence.')
  }
  if (value.confirmedAt !== null && typeof value.confirmedAt !== 'number') {
    throw new Error('Invalid Story Memory confirmation time.')
  }

  return {
    id: requiredString(value.id, 'entry id'),
    kind: value.kind as StoryMemoryKind,
    statement: requiredString(value.statement, 'statement'),
    entityRefIds: value.entityRefIds,
    source: normalizeStoryMemorySource(source, value.origin),
    timelineEventId: value.timelineEventId,
    storyDateLabel: typeof value.storyDateLabel === 'string' ? value.storyDateLabel : '',
    confidence: value.confidence,
    status: value.status as StoryMemoryStatus,
    origin: value.origin,
    createdAt: requiredNumber(value.createdAt, 'creation time'),
    updatedAt: requiredNumber(value.updatedAt, 'update time'),
    confirmedAt: value.confirmedAt,
  }
}

function normalizeStoryMemoryStore(value: unknown): StoryMemoryStore {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entries)) {
    throw new Error('Story Memory file has an unsupported format.')
  }
  return { version: 1, entries: value.entries.map(normalizeStoryMemoryEntry) }
}

export function readStoryMemory(): StoryMemoryStore {
  const file = storyMemoryFile()
  if (!existsSync(file)) return { version: 1, entries: [] }
  try {
    return normalizeStoryMemoryStore(JSON.parse(readFileSync(file, 'utf-8')))
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    throw new Error(`Unable to read Story Memory without risking overwrite: ${detail}`, {
      cause: e,
    })
  }
}

function nextStoryMemoryBackupFile(): string {
  const dir = storyMemoryBackupsDir()
  ensureDir(dir)
  let createdAt = Date.now()
  let file = join(dir, `${createdAt}.json`)
  while (existsSync(file)) {
    createdAt++
    file = join(dir, `${createdAt}.json`)
  }
  return file
}

function pruneStoryMemoryBackups(): void {
  const dir = storyMemoryBackupsDir()
  if (!existsSync(dir)) return
  const backups = readdirSync(dir)
    .filter((file) => /^\d+\.json$/.test(file))
    .map((file) => Number(basename(file, '.json')))
    .filter((createdAt) => Number.isFinite(createdAt))
    .sort((a, b) => b - a)
  for (const createdAt of backups.slice(STORY_MEMORY_BACKUP_KEEP)) {
    unlinkSync(join(dir, `${createdAt}.json`))
  }
}

function backupStoryMemory(store: StoryMemoryStore): void {
  writeJSON(nextStoryMemoryBackupFile(), store)
  pruneStoryMemoryBackups()
}

export function listStoryMemoryBackups(): StoryMemoryBackup[] {
  const dir = storyMemoryBackupsDir()
  if (!existsSync(dir)) return []
  const backups: StoryMemoryBackup[] = []
  for (const file of readdirSync(dir)) {
    if (!/^\d+\.json$/.test(file)) continue
    try {
      const createdAt = Number(basename(file, '.json'))
      const store = normalizeStoryMemoryStore(JSON.parse(readFileSync(join(dir, file), 'utf-8')))
      backups.push({ id: file, createdAt, entryCount: store.entries.length })
    } catch {
      // Invalid backups are ignored so they cannot block recovery from valid data.
    }
  }
  return backups.sort((a, b) => b.createdAt - a.createdAt)
}

function resolveStoryMemoryBackup(id: string): string {
  if (!/^\d+\.json$/.test(id)) throw new Error('Invalid Story Memory backup id.')
  return safeResolve(storyMemoryBackupsDir(), id)
}

export function restoreStoryMemoryBackup(id: string): void {
  const backupFile = resolveStoryMemoryBackup(id)
  if (!existsSync(backupFile)) throw new Error('Story Memory backup not found.')
  const restored = normalizeStoryMemoryStore(JSON.parse(readFileSync(backupFile, 'utf-8')))
  const currentFile = storyMemoryFile()
  if (existsSync(currentFile)) {
    try {
      backupStoryMemory(readStoryMemory())
    } catch {
      const raw = readFileSync(currentFile, 'utf-8')
      ensureDir(storyMemoryBackupsDir())
      atomicWrite(join(storyMemoryBackupsDir(), `corrupt-${Date.now()}.json`), raw)
    }
  }
  writeJSON(currentFile, restored)
}

export function writeStoryMemory(store: StoryMemoryStore): void {
  // Refuse to overwrite a malformed local file; preserving user-owned data
  // takes priority over accepting a new renderer payload.
  const normalized = normalizeStoryMemoryStore(store)
  if (existsSync(storyMemoryFile())) backupStoryMemory(readStoryMemory())
  writeJSON(storyMemoryFile(), normalized)
}

/** Append validated imported memories without replacing existing user data. */
export function mergeStoryMemory(store: StoryMemoryStore): StoryMemoryImportResult {
  const imported = normalizeStoryMemoryStore(store)
  const existing = readStoryMemory()
  const seen = new Set(existing.entries.map((entry) => entry.id))
  const additions: StoryMemoryEntry[] = []
  let skipped = 0
  for (const entry of imported.entries) {
    if (seen.has(entry.id)) {
      skipped++
      continue
    }
    seen.add(entry.id)
    additions.push(entry)
  }
  if (additions.length > 0) {
    writeStoryMemory({ version: 1, entries: [...existing.entries, ...additions] })
  }
  return { added: additions.length, skipped }
}

// ---- 导出全书 ----
/**
 * 收集当前世界目录下的所有文件（跳过 .snapshots 等点目录），
 * 返回 zip 内相对路径 + 内容。供 index.ts 的导出端点打包。
 */
export function collectWorldFiles(): { name: string; files: { path: string; content: Buffer }[] } {
  const base = currentWorldDir()
  const files: { path: string; content: Buffer }[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue // 跳过 .snapshots 等
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) walk(abs)
      else if (entry.isFile()) {
        files.push({ path: relative(base, abs).replace(/\\/g, '/'), content: readFileSync(abs) })
      }
    }
  }
  walk(base)
  const novel = readJSON<NovelMeta>(novelFile(), DEFAULT_NOVEL_META)
  const name = (novel.title || 'world').replace(/[/\\:*?"<>|]/g, '_').trim() || 'world'
  return { name, files }
}

/**
 * Generate a self-contained static wiki HTML from all codex documents.
 * Converts markdown to HTML and embeds styling + sidebar navigation.
 */
export async function exportWikiHtml(): Promise<{ name: string; html: string }> {
  const novel = readJSON<NovelMeta>(novelFile(), DEFAULT_NOVEL_META)
  const name = (novel.title || 'world').replace(/[/\\:*?"<>|]/g, '_').trim() || 'world'
  const docs = listSettings()
    .reverse()
    .map((d) => ({ ...readSetting(d.id), category: d.category }))

  // Group by category for sidebar
  const groups: Record<string, { id: string; title: string }[]> = {}
  for (const d of docs) {
    const catLabel = CATEGORY_LABELS[d.category] || d.category
    if (!groups[catLabel]) groups[catLabel] = []
    groups[catLabel].push({ id: d.id, title: d.title })
  }

  // Convert markdown to HTML with wikilink handling
  const { Marked } = await import('marked')
  const marked = new Marked({ gfm: true })
  const mdToHtml = (md: string): string => {
    // Convert [[Title]] wikilinks to anchor links before markdown processing
    const withLinks = md.replace(/\[\[([^\]]+)\]\]/g, (_, title: string) => {
      // Find matching doc by title
      const match = docs.find(
        (dd) =>
          dd.title.toLowerCase() === title.toLowerCase() ||
          dd.id.split('/').pop()?.replace(/\.md$/i, '').toLowerCase() === title.toLowerCase(),
      )
      const anchorId = match ? `doc-${match.id.replace(/[/.]/g, '-')}` : ''
      return `<a href="#${anchorId}" class="wiki-link">${title}</a>`
    })
    return marked.parse(withLinks) as string
  }

  // Build sidebar HTML
  const sidebarHtml = Object.entries(groups)
    .map(
      ([cat, items]) => `
    <div class="wiki-group">
      <div class="wiki-group-title">${cat}</div>
      ${items
        .map(
          (item) =>
            `<a href="#doc-${item.id.replace(/[/.]/g, '-')}" class="wiki-nav-item">${item.title}</a>`,
        )
        .join('\n')}
    </div>`,
    )
    .join('\n')

  // Build content HTML
  const contentHtml = docs
    .map(
      (d) => `
    <div id="doc-${d.id.replace(/[/.]/g, '-')}" class="wiki-doc">
      <h1 class="wiki-doc-title">${d.title}</h1>
      <div class="wiki-doc-meta">Category: ${CATEGORY_LABELS[d.category] || d.category}</div>
      <div class="wiki-doc-body">${mdToHtml(d.content)}</div>
    </div>`,
    )
    .join('\n')

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${novel.title || 'Untitled'} — Codex Wiki</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html { font-size: 15px; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  color: #3B2F24; background: #F5F0EA; display: flex; min-height: 100vh;
}
.wiki-sidebar {
  width: 260px; min-width: 260px; background: #E8E0D6; border-right: 1px solid #D4C8B8;
  overflow-y: auto; padding: 20px 0;
}
.wiki-sidebar h2 {
  font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;
  color: #8A7A62; padding: 0 16px 12px; border-bottom: 1px solid #D4C8B8; margin-bottom: 12px;
}
.wiki-group { margin-bottom: 8px; }
.wiki-group-title {
  font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px;
  color: #A89676; padding: 6px 16px 2px; cursor: default;
}
.wiki-nav-item {
  display: block; font-size: 13px; padding: 4px 16px 4px 20px;
  color: #6B5B47; text-decoration: none; border-left: 2px solid transparent;
  transition: background 120ms, border-color 120ms; border-radius: 0 4px 4px 0;
}
.wiki-nav-item:hover { background: #D4C8B8; border-left-color: #B8642E; color: #3B2F24; }
.wiki-content { flex: 1; overflow-y: auto; padding: 40px 48px; max-width: 900px; }
.wiki-doc { margin-bottom: 60px; }
.wiki-doc-title { font-size: 24px; font-weight: 700; color: #2A2018; margin-bottom: 4px; }
.wiki-doc-meta { font-size: 12px; color: #A89676; margin-bottom: 20px; }
.wiki-doc-body { line-height: 1.75; color: #4E3E30; }
.wiki-doc-body h2 { font-size: 18px; margin: 24px 0 12px; color: #2A2018; }
.wiki-doc-body h3 { font-size: 15px; margin: 20px 0 8px; color: #3B2F24; }
.wiki-doc-body p { margin-bottom: 12px; }
.wiki-doc-body ul, .wiki-doc-body ol { margin-bottom: 12px; padding-left: 24px; }
.wiki-doc-body li { margin-bottom: 4px; }
.wiki-doc-body pre { background: #E8E0D6; padding: 12px 16px; border-radius: 6px; overflow-x: auto; margin-bottom: 12px; }
.wiki-doc-body code { font-family: 'JetBrains Mono', 'Fira Code', monospace; font-size: 13px; }
.wiki-doc-body blockquote { border-left: 3px solid #B8642E; padding: 4px 16px; margin: 0 0 12px; color: #8A7A62; }
.wiki-doc-body table { border-collapse: collapse; width: 100%; margin-bottom: 12px; font-size: 13px; }
.wiki-doc-body th, .wiki-doc-body td { border: 1px solid #D4C8B8; padding: 8px 12px; text-align: left; }
.wiki-doc-body th { background: #E8E0D6; font-weight: 600; color: #3B2F24; }
.wiki-doc-body td { background: #F5F0EA; }
.wiki-doc-body tr:nth-child(even) td { background: #EDE6DC; }
.wiki-doc-body a { color: #B8642E; text-decoration: underline; }
.wiki-link { color: #B8642E; text-decoration: underline; text-decoration-style: dotted; }
.wiki-link:hover { text-decoration-style: solid; }
@media (max-width: 720px) {
  body { flex-direction: column; }
  .wiki-sidebar { width: 100%; min-width: unset; max-height: 40vh; border-right: none; border-bottom: 1px solid #D4C8B8; }
  .wiki-content { padding: 24px 20px; }
}
</style>
</head>
<body>
<nav class="wiki-sidebar">
  <h2>${novel.title || 'Untitled'}</h2>
  ${sidebarHtml}
</nav>
<main class="wiki-content">
  <div class="wiki-doc">
    <h1 style="font-size:28px;margin-bottom:8px;">${novel.title || 'Untitled'}</h1>
    ${novel.author ? `<p style="color:#8A7A62;margin-bottom:4px;">by ${novel.author}</p>` : ''}
    ${novel.synopsis ? `<p style="color:#6B5B47;line-height:1.7;margin-top:12px;">${novel.synopsis}</p>` : ''}
    <hr style="border:none;border-top:1px solid #D4C8B8;margin:24px 0;">
  </div>
  ${contentHtml}
</main>
</body>
</html>`

  return { name, html }
}

// ---- 讨论组 ----
export function listDiscussions(): DiscussionSession[] {
  const dir = discussionsDir()
  if (!existsSync(dir)) return []
  const out: DiscussionSession[] = []
  for (const f of readdirSync(dir)) {
    if (extname(f) !== '.json') continue
    const s = readJSON<DiscussionSession | null>(join(dir, f), null)
    if (s) out.push(s)
  }
  return out.sort((a, b) => b.createdAt - a.createdAt)
}

export function saveDiscussion(session: DiscussionSession): void {
  // id 由渲染器提供：basename 拒绝目录穿越（与 deleteDiscussion 的防护一致），
  // 且必须是纯文件名（含分隔符/相对段的 id 直接拒绝）。
  const id = basename(session.id ?? '')
  if (!id || id !== session.id) throw new Error('Invalid discussion id.')
  const full = join(discussionsDir(), `${id}.json`)
  snapshot(full)
  writeJSON(full, session)
}

export function deleteDiscussion(id: string): void {
  const full = join(discussionsDir(), `${basename(id)}.json`)
  if (existsSync(full)) {
    snapshot(full) // 删除前留底,误删可找回
    unlinkSync(full)
  }
}

// ---- 一致性报告（持久化，供跨会话回顾 / 后续 Review Queue 使用）----
const newConsistencyReportId = (): string =>
  `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

export function listConsistencyReports(): ConsistencyReport[] {
  const dir = consistencyDir()
  if (!existsSync(dir)) return []
  const out: ConsistencyReport[] = []
  for (const f of readdirSync(dir)) {
    if (extname(f) !== '.json') continue
    const r = readJSON<ConsistencyReport | null>(join(dir, f), null)
    if (r) out.push(r)
  }
  return out.sort((a, b) => b.createdAt - a.createdAt)
}

export function saveConsistencyReport(report: {
  content: string
  scope: { docs: string[]; chapters: string[] }
}): ConsistencyReport {
  // 旧世界可能没有 consistency/ 目录,写入前补齐(幂等)。
  ensureDir(consistencyDir())
  const now = Date.now()
  const saved: ConsistencyReport = {
    id: newConsistencyReportId(),
    createdAt: now,
    scope: {
      docs: Array.from(new Set(report.scope.docs)).filter((s) => s.trim()),
      chapters: Array.from(new Set(report.scope.chapters)).filter((s) => s.trim()),
    },
    content: report.content,
    wordCount: report.content.replace(/\s/g, '').length,
    status: 'open',
  }
  writeJSON(join(consistencyDir(), `${saved.id}.json`), saved)
  return saved
}

export function deleteConsistencyReport(id: string): void {
  const full = join(consistencyDir(), `${basename(id)}.json`)
  if (existsSync(full)) unlinkSync(full)
}

// ---- 角色对话（持久化;每角色一个文件,文件名以 characterId 编码,再保存即覆盖）----
export function listCharacterChats(): CharacterChatSession[] {
  const dir = characterChatsDir()
  if (!existsSync(dir)) return []
  const out: CharacterChatSession[] = []
  for (const f of readdirSync(dir)) {
    if (extname(f) !== '.json') continue
    const s = readJSON<CharacterChatSession | null>(join(dir, f), null)
    if (s) out.push(s)
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function saveCharacterChat(session: CharacterChatSession): void {
  // 旧世界可能没有 character-chats/ 目录,写入前补齐(幂等)。
  ensureDir(characterChatsDir())
  // 幂等:同一角色的会话永远写同一个文件,避免并发保存产生重复会话。
  snapshot(join(characterChatsDir(), `${encodeURIComponent(session.characterId)}.json`))
  writeJSON(join(characterChatsDir(), `${encodeURIComponent(session.characterId)}.json`), session)
}

export function deleteCharacterChat(characterId: string): void {
  const full = join(characterChatsDir(), `${encodeURIComponent(characterId)}.json`)
  if (existsSync(full)) {
    snapshot(full) // 删除前留底,误删可找回
    unlinkSync(full)
  }
}

// ---- 审查队列（单文件 review-queue.json）----
export function readReviewQueue(): ReviewQueueStore {
  const s = readJSON<ReviewQueueStore | null>(reviewQueueFile(), null)
  if (!s || !Array.isArray(s.items)) return { version: 1, items: [] }
  // 逐条校验:丢弃手工编辑/损坏产生的畸形条目,避免 UI 崩溃。
  // 旧版文件没有 relatedDocIds,读取时规范化为空数组。
  return {
    version: 1,
    items: s.items.filter(isReviewQueueItem).map((item) => ({
      ...item,
      relatedDocIds: item.relatedDocIds ?? [],
    })),
  }
}

export function writeReviewQueue(store: ReviewQueueStore): void {
  assertWritable(reviewQueueFile(), 'The review queue')
  snapshot(reviewQueueFile())
  writeJSON(reviewQueueFile(), { version: 1, items: store.items })
}

// ---- 卷/章大纲（结构化 outline/outline.json；结构以大纲为准，novel.json 同步镜像）----

/** 旧版大纲 md 归档（迁移读取用），按文件名排序；目录缺失时视为空。 */
function outlineMdFiles(): string[] {
  const dir = outlineDir()
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => extname(f) === '.md')
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
}

/** 若同步后 novel.json 结构发生变化，则留底并写回（幂等：无变化不写盘）。 */
function syncNovelFromStore(store: OutlineStore): NovelMeta {
  // A damaged novel.json reads as empty metadata, so syncing would rewrite it
  // with a default title/synopsis and only the outline's structure — the
  // manuscript's own fields would be gone. Refuse instead of repairing.
  assertWritable(novelFile(), 'The manuscript structure')
  const meta = readJSON<NovelMeta>(novelFile(), DEFAULT_NOVEL_META)
  const synced = syncNovelFromOutline(meta, store)
  if (JSON.stringify(synced) !== JSON.stringify(meta)) {
    snapshot(novelFile())
    writeJSON(novelFile(), synced)
    syncWorldFromNovel(synced)
  }
  return synced
}

/**
 * 读取结构化大纲。迁移顺序：
 * 1. outline/outline.json 可用 → 规范化并回同步修复 novel.json 漂移；
 * 2. outline/outline.json 损坏或没有可用结构 → 保留原件并从 novel.json 反向重建
 *    （只读，不写盘），避免一次读取把 novel.json 的章节清空；
 * 3. 存在旧版 outline/*.md → 解析并与现有 novel.json 结构合并（按标题/序号匹配 id）；
 * 4. novel.json 已有卷/章 → 反向构建大纲（id/标题保留，要点为空）；
 * 5. 全空 → 空 store。
 */
export function readOutlineStore(): OutlineStore {
  const file = outlineJsonFile()
  if (existsSync(file)) {
    const store = normalizeOutlineStore(readJSON<unknown>(file, null))
    const meta = readJSON<NovelMeta>(novelFile(), DEFAULT_NOVEL_META)
    // A store with no volumes cannot be the structure source of a manuscript
    // that still has chapters: the file is damaged (unparseable, or valid JSON
    // whose volumes are missing), because deleting every volume in the Outline
    // view also empties novel.json through writeOutlineStore. Syncing it would
    // strip every chapter from novel.json and orphan the prose, so preserve the
    // damaged file and rebuild the structure from novel.json instead. The next
    // structural save rewrites outline.json and completes the recovery.
    if (store.volumes.length === 0 && meta.volumes.length > 0) {
      preserveDamagedFile(file)
      return outlineFromNovel(meta)
    }
    syncNovelFromStore(store)
    return store
  }

  const meta = readJSON<NovelMeta>(novelFile(), DEFAULT_NOVEL_META)
  const mdFiles = outlineMdFiles()
  let store: OutlineStore
  if (mdFiles.length > 0) {
    const text = mdFiles.map((f) => readFileSync(join(outlineDir(), f), 'utf-8')).join('\n\n')
    store = outlineFromLegacy(meta, parseLegacyOutline(text))
  } else if (meta.volumes.length > 0) {
    store = outlineFromNovel(meta)
  } else {
    return emptyOutlineStore()
  }

  ensureDir(outlineDir())
  snapshot(file)
  writeJSON(file, store)
  syncNovelFromStore(store)
  return store
}

/** 保存结构化大纲：先落盘，再同步 novel.json 结构并返回同步后的元数据。 */
export function writeOutlineStore(store: OutlineStore): NovelMeta {
  const normalized = normalizeOutlineStore(store)
  ensureDir(outlineDir())
  snapshot(outlineJsonFile())
  writeJSON(outlineJsonFile(), normalized)

  // 新章建占位正文文件（与 Manuscript 新建章行为一致），保证正文目录与结构一致
  const synced = syncNovelFromStore(normalized)
  for (const vol of synced.volumes) {
    for (const ch of vol.chapters) {
      const full = join(chaptersDir(), ch.file)
      if (!existsSync(full)) atomicWrite(full, `# ${ch.title}\n\n`)
    }
  }
  return synced
}

/** AI 消费的派生文本：由结构化 store 序列化，确定性、无杂质。 */
export function readOutline(): string {
  return serializeOutlineForAI(readOutlineStore())
}

/**
 * 收集大纲文件供导出打包：outline/outline.json + 派生的可读 outline.md +
 * 迁移前遗留的 md 归档（如有）。zip 条目保留 `outline/` 目录结构。
 */
export function collectOutlineFiles(): {
  name: string
  files: { path: string; content: Buffer }[]
} {
  const files: { path: string; content: Buffer }[] = []
  const store = readOutlineStore()
  files.push({ path: 'outline/outline.json', content: Buffer.from(JSON.stringify(store, null, 2)) })
  files.push({ path: 'outline/outline.md', content: Buffer.from(serializeOutlineForAI(store)) })
  for (const f of outlineMdFiles()) {
    files.push({ path: `outline/${f}`, content: readFileSync(join(outlineDir(), f)) })
  }
  const novel = readJSON<NovelMeta>(novelFile(), DEFAULT_NOVEL_META)
  const name = (novel.title || 'outline').replace(/[/\\:*?"<>|]/g, '_').trim() || 'outline'
  return { name, files }
}

// ---- Novel Forge（整书自动创作流水线的运行状态）----

/**
 * Persist the forge run record.
 *
 * The forge engine owns the shape of this file and normalizes it on read, so
 * the store only provides the atomic write (temp file + fsync + rename) that
 * keeps a crash from leaving a half-written run behind.
 */
export function writeForgeRunFile(content: string): void {
  ensureDir(forgeDir())
  atomicWrite(forgeRunFile(), content)
}

// ---- Chapter Memory（分层记忆：章节摘要 + 故事状态档案）----

/** 摘要文件名：chapterId 转安全文件名，杜绝路径穿越。 */
const chapterSummaryPath = (chapterId: string): string => {
  const safe = chapterId.replace(/[/\\]/g, '_')
  return safeResolve(chapterSummariesDir(), `${safe}.json`)
}

export function listChapterSummaries(): ChapterSummary[] {
  const dir = chapterSummariesDir()
  if (!existsSync(dir)) return []
  // 只保留已写过正文的章节摘要：未写章节的旧摘要（如迁移期占位章节的
  // 预演摘要）不得进入故事状态，否则会把尚未发生的事当作既成事实注入
  // 后续章节的上下文（D-023）。
  const meta = readJSON<NovelMeta>(novelFile(), DEFAULT_NOVEL_META)
  const fileByChapter = new Map<string, string>()
  for (const vol of meta.volumes) {
    for (const ch of vol.chapters) fileByChapter.set(ch.id, ch.file)
  }
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
    .map((f) => {
      try {
        const summary = readJSON<ChapterSummary | null>(join(dir, f), null)
        return summary && typeof summary.chapterId === 'string' ? summary : null
      } catch {
        return null
      }
    })
    .filter((s): s is ChapterSummary => {
      if (!s) return false
      const file = fileByChapter.get(s.chapterId)
      if (!file) return false
      const full = chapterPath(file)
      // 占位正文（只有标题，约几十字节）不算已写；超过 100 字节视为有真实内容
      return existsSync(full) && statSync(full).size > 100
    })
}

export function readChapterSummary(chapterId: string): ChapterSummary | null {
  const full = chapterSummaryPath(chapterId)
  return existsSync(full) ? readJSON<ChapterSummary | null>(full, null) : null
}

export function writeChapterSummary(summary: ChapterSummary): void {
  if (!summary.chapterId || !summary.chapterTitle) {
    throw new Error('Chapter summary is missing chapterId or chapterTitle.')
  }
  const full = chapterSummaryPath(summary.chapterId)
  ensureDir(chapterSummariesDir())
  writeJSON(full, summary)
}

export function deleteChapterSummary(chapterId: string): void {
  const full = chapterSummaryPath(chapterId)
  if (existsSync(full)) rmSync(full, { force: true })
}

const DEFAULT_STORY_STATE: StoryState = {
  version: 1,
  upToChapterId: null,
  updatedAt: 0,
  characters: [],
  worldState: [],
  openThreads: [],
  currentEndState: '',
}

export function readStoryState(): StoryState {
  const f = storyStateFile()
  if (!existsSync(f)) return { ...DEFAULT_STORY_STATE }
  const state = readJSON<StoryState | null>(f, null)
  if (!state || state.version !== 1) return { ...DEFAULT_STORY_STATE }
  return {
    version: 1,
    upToChapterId: typeof state.upToChapterId === 'string' ? state.upToChapterId : null,
    updatedAt: typeof state.updatedAt === 'number' ? state.updatedAt : 0,
    characters: Array.isArray(state.characters) ? state.characters : [],
    worldState: Array.isArray(state.worldState)
      ? state.worldState.filter((s): s is string => typeof s === 'string')
      : [],
    openThreads: Array.isArray(state.openThreads)
      ? state.openThreads.filter((s): s is string => typeof s === 'string')
      : [],
    currentEndState: typeof state.currentEndState === 'string' ? state.currentEndState : '',
  }
}

export function writeStoryState(state: StoryState): void {
  assertWritable(storyStateFile(), 'The story state')
  ensureDir(dirname(storyStateFile()))
  writeJSON(storyStateFile(), { ...state, version: 1, updatedAt: Date.now() })
}

// ---- Voice profile ----

const voiceProfileFile = (): string => join(currentWorldDir(), 'voice-profile.json')

export function readVoiceProfile(): VoiceProfile | null {
  const f = voiceProfileFile()
  return existsSync(f) ? readJSON<VoiceProfile | null>(f, null) : null
}

export function writeVoiceProfile(profile: VoiceProfile): void {
  snapshot(voiceProfileFile())
  writeJSON(voiceProfileFile(), profile)
}

// ---- 文风范例（exemplars，按世界存储）----

const DEFAULT_EXEMPLARS: ExemplarStore = { version: 1, texts: [] }

export function readExemplars(): ExemplarStore {
  const f = exemplarsFile()
  if (!existsSync(f)) return { version: 1, texts: [] }
  const store = readJSON<ExemplarStore>(f, DEFAULT_EXEMPLARS)
  // 防御：损坏/缺字段时回退到空列表，绝不阻塞写作面板。
  if (!store || !Array.isArray(store.texts)) return { version: 1, texts: [] }
  return { version: 1, texts: store.texts.filter((t) => typeof t === 'string') }
}

export function writeExemplars(store: ExemplarStore): void {
  assertWritable(exemplarsFile(), 'Style exemplars')
  snapshot(exemplarsFile())
  writeJSON(exemplarsFile(), { version: 1, texts: store.texts.filter((t) => t.trim()) })
}

// ---- Epub export ----

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function mdToXhtml(md: string): string {
  let html = md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>')
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>')
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>')
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>')
  html = html.replace(/^(?!<[hH]|\s*$)(.+)$/gm, '<p>$1</p>')
  html = html.replace(/\n\n/g, '\n')
  return html
}

export async function exportEpub(): Promise<{ name: string; buffer: Buffer }> {
  const novel = readJSON<NovelMeta>(novelFile(), DEFAULT_NOVEL_META)
  const name = (novel.title || 'world').replace(/[/\\:*?"<>|]/g, '_').trim() || 'world'

  const zip = new JSZip()

  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })

  const containerXml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '\n' +
    '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
    '\n' +
    '  <rootfiles>' +
    '\n' +
    '    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>' +
    '\n' +
    '  </rootfiles>' +
    '\n' +
    '</container>'
  zip.file('META-INF/container.xml', containerXml)

  const chapters: Array<{ title: string; file: string; content: string }> = []
  for (const vol of novel.volumes) {
    for (const ch of vol.chapters) {
      const text = readChapter(ch.file)
      if (text.trim()) {
        chapters.push({ title: ch.title, file: ch.file, content: text })
      }
    }
  }

  const now = new Date().toISOString()
  const bookId = 'urn:uuid:' + crypto.randomUUID()

  const manifestItems: string[] = []
  const spineItems: string[] = []
  const navPoints: string[] = []

  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i]
    const id = 'chapter-' + (i + 1)
    const fname = 'chapter-' + (i + 1) + '.xhtml'
    const bodyHtml = mdToXhtml(ch.content)
    const xhtml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '\n' +
      '<!DOCTYPE html>' +
      '\n' +
      '<html xmlns="http://www.w3.org/1999/xhtml">' +
      '\n' +
      '<head>' +
      '\n' +
      '  <title>' +
      escapeXml(ch.title) +
      '</title>' +
      '\n' +
      '</head>' +
      '\n' +
      '<body>' +
      '\n' +
      '  <h1>' +
      escapeXml(ch.title) +
      '</h1>' +
      '\n' +
      bodyHtml +
      '\n' +
      '</body>' +
      '\n' +
      '</html>'
    zip.file('OEBPS/' + fname, xhtml)
    manifestItems.push(
      '    <item id="' + id + '" href="' + fname + '" media-type="application/xhtml+xml"/>',
    )
    spineItems.push('    <itemref idref="' + id + '"/>')
    navPoints.push(
      '      <navPoint id="navpoint-' +
        (i + 1) +
        '" playOrder="' +
        (i + 1) +
        '">' +
        '\n' +
        '        <navLabel><text>' +
        escapeXml(ch.title) +
        '</text></navLabel>' +
        '\n' +
        '        <content src="' +
        fname +
        '"/>' +
        '\n' +
        '      </navPoint>',
    )
  }

  const ncxParts = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">',
    '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">',
    '  <head>',
    '    <meta name="dtb:uid" content="' + bookId + '"/>',
    '    <meta name="dtb:depth" content="1"/>',
    '    <meta name="dtb:totalPageCount" content="0"/>',
    '    <meta name="dtb:maxPageNumber" content="0"/>',
    '  </head>',
    '  <docTitle><text>' + escapeXml(novel.title) + '</text></docTitle>',
    '  <navMap>',
    navPoints.join('\n'),
    '  </navMap>',
    '</ncx>',
  ]
  zip.file('OEBPS/toc.ncx', ncxParts.join('\n'))

  const opfParts = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="book-id">',
    '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">',
    '    <dc:identifier id="book-id">' + bookId + '</dc:identifier>',
    '    <dc:title>' + escapeXml(novel.title) + '</dc:title>',
    novel.author ? '    <dc:creator>' + escapeXml(novel.author) + '</dc:creator>' : '',
    '    <dc:language>zh-CN</dc:language>',
    '    <dc:date>' + now + '</dc:date>',
    novel.synopsis ? '    <dc:description>' + escapeXml(novel.synopsis) + '</dc:description>' : '',
    '  </metadata>',
    '  <manifest>',
    '    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
    manifestItems.join('\n'),
    '  </manifest>',
    '  <spine toc="ncx">',
    spineItems.join('\n'),
    '  </spine>',
    '</package>',
  ].filter(Boolean)
  zip.file('OEBPS/content.opf', opfParts.join('\n'))

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  return { name, buffer }
}

export { CATEGORY_LABELS, projectRoot }
