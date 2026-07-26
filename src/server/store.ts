import {
  readFileSync,
  writeSync,
  fsyncSync,
  openSync,
  closeSync,
  renameSync,
  readdirSync,
  statSync,
  existsSync,
  cpSync,
  unlinkSync,
  rmSync,
} from 'fs'
import { join, basename, extname, dirname, relative } from 'path'
import type {
  AppConfig,
  NovelMeta,
  SettingCategory,
  SettingDoc,
  SettingDocContent,
  DiscussionSession,
  WorldMeta,
  GeneratedWorld,
  SnapshotEntry,
} from '../shared/types'
import {
  chaptersDir,
  configFile,
  discussionsDir,
  novelFile,
  outlineFile,
  projectRoot,
  settingsDir,
  worldsFile,
  worldDir,
  ensureDir,
  ensureWorldSkeleton,
  getCurrentWorldId as pathsGetCurrentWorldId,
  setCurrentWorldId,
  currentWorldDir,
  snapshotsDir,
} from './paths'
import { CATEGORY_LABELS, DEFAULT_CONFIG, DEFAULT_NOVEL_META, DEFAULT_WRITING } from './defaults'
import { decryptSecret, encryptSecret } from './secrets'

const readJSON = <T>(file: string, fallback: T): T => {
  try {
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf-8')) as T
  } catch {
    return fallback
  }
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

// ---- 版本快照（找回被误删/被 AI 写坏的正文与设定）----
// 布局：<world>/.snapshots/<编码源路径>/<时间戳>.snap，每个源文件一个子目录。
const SNAPSHOT_THROTTLE_MS = 3 * 60 * 1000 // 3 分钟内的连续保存只留会话起点，避免刷爆
const SNAPSHOT_KEEP = 15 // 每个文件滚动保留最近份数

// 源文件绝对路径 → 快照子目录名（编码使 "chapters/x.md" 变成单层目录名）
const snapKey = (sourcePath: string): string => encodeURIComponent(sourcePath)

/**
 * Before overwriting/deleting a file, snapshot its old content.
 * Only applies to chapters/ and settings/; no-op if file doesn’t exist.
 * 3-min throttle, 15 snapshot rolling window. Failures never affect main write.
 * force=true 跳过节流：恢复操作前必须给当前版留底，否则「可反悔」的承诺落空。
 */
function snapshot(full: string, force = false): void {
  try {
    if (!existsSync(full)) return
    const sourcePath = relative(currentWorldDir(), full).replace(/\\/g, '/')
    if (!sourcePath.startsWith('chapters/') && !sourcePath.startsWith('settings/')) return

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

    // 滚动清理：只留最近 SNAPSHOT_KEEP 份
    const all = readdirSync(dir)
      .filter((f) => f.endsWith('.snap'))
      .map((f) => Number(basename(f, '.snap')))
      .filter((n) => !Number.isNaN(n))
      .sort((a, b) => b - a)
    for (const ts of all.slice(SNAPSHOT_KEEP)) unlinkSync(join(dir, `${ts}.snap`))
  } catch {
    // 快照是尽力而为的保险，任何失败都不能拖累用户的正常保存，
    // 但至少留一条 warn 日志方便排查磁盘/权限问题。
    console.warn('[snapshot] failed:', full)
  }
}

/** Generate a world ID. */
const newWorldId = (): string =>
  `w_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

// ---- 世界索引（worlds.json）----
const readWorlds = (): WorldMeta[] => readJSON<WorldMeta[]>(worldsFile(), [])
const writeWorlds = (list: WorldMeta[]): void => writeJSON(worldsFile(), list)

/**
 * App bootstrap: ensure multi-world layout and select current world.
 * Three cases:
 *   1. worlds.json exists → select world with latest lastOpenedAt.
 *   2. Legacy <root>/novel.json exists → migrate to first world.
 *   3. First-time user → copy seed directory (sample world) into data root.
 */
export function bootstrap(seedDir: string): void {
  if (existsSync(worldsFile())) {
    const list = readWorlds()
    if (list.length > 0) {
      // Don't auto-select a world on startup — the WorldGate page is the entry
    }
    return
  }

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
  cpSync(seedDir, projectRoot(), { recursive: true })

  const list = readWorlds()
  if (list.length > 0) {
    // Don't auto-select — the user picks the entry point from WorldGate
  }
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
}

export function deleteWorld(id: string): void {
  const list = readWorlds()
  const next = list.filter((x) => x.id !== id)
  writeWorlds(next)
  const dir = worldDir(id)
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  // 删的是当前世界 → 重置，前端据此退回入口页
  if (pathsGetCurrentWorldId() === id) setCurrentWorldId(null)
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
    const novel: NovelMeta = {
      ...DEFAULT_NOVEL_META,
      title: data.title || meta.title || 'Untitled World',
      synopsis: data.synopsis,
      tags: data.genre ? [data.genre] : [],
      volumes: [],
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
export const saveNovelMeta = (meta: NovelMeta): void => {
  writeJSON(novelFile(), meta)
  // 双源同步：把标题/题材联动写回 worlds.json 中当前世界那条
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

// ---- 配置 ----
export const getConfig = (): AppConfig => {
  const cfg = readJSON(configFile(), DEFAULT_CONFIG)
  // 若用户配置里 personas 为空，回落到默认
  if (!cfg.personas || cfg.personas.length === 0) cfg.personas = DEFAULT_CONFIG.personas
  // 旧版 config.json 无 consistency 块，回落到默认
  if (!cfg.consistency) cfg.consistency = DEFAULT_CONFIG.consistency
  // 旧版 config.json 无 writing 块，回落到默认
  if (!cfg.writing) cfg.writing = DEFAULT_WRITING
  // 旧版 writing 块缺少 temperature / topP 时补齐默认值
  if (cfg.writing.temperature == null) cfg.writing.temperature = DEFAULT_WRITING.temperature
  if (cfg.writing.topP == null) cfg.writing.topP = DEFAULT_WRITING.topP

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
    writeJSON(configFile(), encrypted)
  }

  // 解密 API Key 供内存使用（旧版无前缀的明文会直接透传）。
  for (const p of cfg.ai.providers) {
    p.apiKey = decryptSecret(p.apiKey) ?? ''
  }

  return cfg
}

export const saveConfig = (cfg: AppConfig): void => {
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
  writeJSON(configFile(), encrypted)
}

// ---- 设定文档 ----
const CATEGORIES: SettingCategory[] = [
  'worldview',
  'character',
  'geography',
  'economy',
  'outline',
  'misc',
]

export function listSettings(): SettingDoc[] {
  const out: SettingDoc[] = []
  for (const cat of CATEGORIES) {
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
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

const settingPath = (id: string): string => {
  // id 形如 "worldview/世界观.md"，禁止路径穿越
  const safe = id.replace(/\.\.[/\\]/g, '')
  return join(settingsDir(), safe)
}

export function readSetting(id: string): SettingDocContent {
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
  const full = settingPath(id)
  snapshot(full) // 覆盖前先留旧版
  atomicWrite(full, content)
}

export function createSetting(category: SettingCategory, title: string): SettingDoc {
  const safeTitle = title.replace(/[/\\:*?"<>|]/g, '_').trim() || 'Untitled'
  const id = `${category}/${safeTitle}.md`
  const full = settingPath(id)
  if (!existsSync(full)) {
    atomicWrite(full, `# ${safeTitle}\n\n`)
  }
  return { id, title: safeTitle, category, updatedAt: Date.now() }
}

export function deleteSetting(id: string): void {
  const full = settingPath(id)
  if (existsSync(full)) {
    snapshot(full) // 删除前先留旧版，可从历史找回
    unlinkSync(full)
  }
}

// ---- 章节正文 ----
const chapterPath = (file: string): string => {
  const safe = file.replace(/\.\.[/\\]/g, '').replace(/[/\\]/g, '_')
  return join(chaptersDir(), safe)
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

// ---- 版本快照 RPC ----
/** Map source file path to display name and type. */
function describeSource(sourcePath: string): { label: string; kind: 'chapter' | 'setting' } {
  if (sourcePath.startsWith('settings/')) {
    return { label: basename(sourcePath, '.md'), kind: 'setting' }
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
  if (!key || !file || file.includes('..') || !file.endsWith('.snap')) {
    throw new Error('Invalid snapshot id.')
  }
  return { full: join(snapshotsDir(), key, file), sourcePath: decodeURIComponent(key) }
}

export function readSnapshot(id: string): string {
  const { full } = resolveSnapshot(id)
  return existsSync(full) ? readFileSync(full, 'utf-8') : ''
}

/** Write snapshot content back to source file. Also snapshots the current version first for undo. */
export function restoreSnapshot(id: string): void {
  const { full, sourcePath } = resolveSnapshot(id)
  if (!existsSync(full)) throw new Error('Snapshot not found.')
  const dest = join(currentWorldDir(), sourcePath)
  snapshot(dest, true) // 回写前强制给当前版留底（跳过节流），确保恢复动作本身可反悔
  atomicWrite(dest, readFileSync(full, 'utf-8'))
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
  writeJSON(join(discussionsDir(), `${session.id}.json`), session)
}

export function deleteDiscussion(id: string): void {
  const full = join(discussionsDir(), `${basename(id)}.json`)
  if (existsSync(full)) unlinkSync(full)
}

// ---- Volume.章Outline.（单文件 markdown） ----
export function readOutline(): string {
  const f = outlineFile()
  return existsSync(f) ? readFileSync(f, 'utf-8') : ''
}

export function writeOutline(content: string): void {
  const f = outlineFile()
  snapshot(f)
  atomicWrite(f, content)
}

export { CATEGORY_LABELS, projectRoot }
