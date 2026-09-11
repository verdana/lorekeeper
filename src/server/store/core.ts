/**
 * World store — every persisted file of a world, addressed through one module.
 *
 * Layout note: the data layer is split by domain, each module owning one kind of
 * file and importing the shared infrastructure from `./core`. `store.ts` is the
 * facade the RPC layer and the tests import, so callers see one module while the
 * implementation stays navigable:
 *
 *   core              atomic write, snapshot, damaged-file guards, safe paths
 *   worlds            the world index, world lifecycle, novel metadata
 *   config            app config (providers, personas, prompts) + API keys
 *   codex             codex documents and read-only external folder mappings
 *   manuscript        chapter files and manuscript prose search
 *   generation-runs   generation evidence
 *   history           version snapshots
 *   timeline          world events
 *   story             Story Memory, chapter summaries, the story-state archive
 *   outline           the structured outline (structure's source of truth)
 *   records           discussions, consistency reports, character chats, review queue
 *   voice             Voice Profile and style exemplars
 *   exports           whole-world zip, static codex wiki, epub
 *   forge-run         the Novel Forge run record (shape owned by the engine)
 *
 * Two rules hold across all of them: writes go through `atomicWrite` (temp file
 * → fsync → rename) and anything overwritten is snapshotted first, so a crash or
 * a bad AI response never costs the author unrecoverable text.
 */
/**
 * Shared infrastructure: reading and writing a world's files.
 *
 * Every other module builds on this one and none of it is re-exported from the
 * facade — these are implementation details of the data layer, not its API.
 * The damaged-file handling exists because a data file that exists but cannot be
 * parsed must never be silently replaced by an empty default: the bytes are
 * copied aside and the write is refused until the author repairs it.
 */

import {
  readFileSync,
  writeSync,
  fsyncSync,
  openSync,
  closeSync,
  renameSync,
  readdirSync,
  existsSync,
  unlinkSync,
} from 'fs'
import { join, basename, dirname, resolve, relative, isAbsolute } from 'path'
import { currentWorldDir, snapshotsDir, ensureDir } from './../paths'

export { ensureDir } from '../paths'

export const readJSON = <T>(file: string, fallback: T): T => {
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
export const safeResolve = (base: string, ...segments: string[]): string => {
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
export const atomicWrite = (file: string, data: string): void => {
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

export const writeJSON = (file: string, data: unknown): void => {
  atomicWrite(file, JSON.stringify(data, null, 2))
}

/**
 * Sidecar path holding the exact bytes of a data file that could not be parsed.
 * The name is derived from the original, so repeated failures overwrite a single
 * copy instead of accumulating, and the dot prefix keeps it out of the world
 * export's file walk.
 */
export const damagedCopyPath = (file: string): string =>
  join(dirname(file), `.corrupt-${basename(file)}`)

/**
 * Preserve a damaged file's bytes before anything can overwrite it, so a read
 * failure leaves evidence to recover from. Best-effort: never masks the failure.
 */
export const preserveDamagedFile = (file: string): void => {
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
export type DataFileRead<T> =
  { state: 'missing' } | { state: 'damaged' } | { state: 'ok'; value: T }

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
export const assertWritable = (file: string, label: string): void => {
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
export function snapshot(full: string, force = false): void {
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
