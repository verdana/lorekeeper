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
 * Version history: the snapshots taken before every overwrite, and the restores
 * that bring an earlier version back (each restore is itself snapshotted).
 */

import type {
  CharacterChatSession,
  DiscussionSession,
  NovelMeta,
  SnapshotEntry,
} from '../../shared/types'
import { currentWorldDir, novelFile, snapshotsDir } from '../paths'
import { atomicWrite, readJSON, safeResolve, snapshot } from './core'
import { DEFAULT_NOVEL_META } from '../defaults'
import { syncWorldFromNovel } from './worlds'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { basename, join } from 'path'

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
