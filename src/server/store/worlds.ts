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
 * The world index and world lifecycle.
 *
 * `worlds.json` is the one file that cannot fall back to an empty default: every
 * creation path persists `[...readWorlds(), meta]`, so treating a damaged index
 * as "no worlds" would make every existing world unreachable. It is reported
 * instead (see `readWorlds`).
 */

import type { NovelMeta, Volume, Chapter, WorldMeta, GeneratedWorld } from '../../shared/types'
import {
  ensureDir,
  worldsFile,
  worldDir,
  worldsRoot,
  projectRoot,
  novelFile,
  ensureWorldSkeleton,
  getCurrentWorldId as pathsGetCurrentWorldId,
  setCurrentWorldId,
} from '../paths'
import { DEFAULT_NOVEL_META } from '../defaults'
import { countWords } from '../../shared/text'
import {
  assertWritable,
  atomicWrite,
  damagedCopyPath,
  preserveDamagedFile,
  readJSON,
  safeResolve,
  snapshot,
  writeJSON,
} from './core'
import { cpSync, existsSync, readFileSync, renameSync, rmSync } from 'fs'
import { join, basename } from 'path'

/** Generate a world ID. */
const newWorldId = (): string =>
  `w_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

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
/** Exported for the outline and history modules, which rewrite novel.json. */
export function syncWorldFromNovel(meta: NovelMeta): void {
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
