import { homedir } from 'os'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import type { SettingCategory } from '../shared/types'

/**
 * Multi-world data layout (defaults to ~/.lorekeeper, override via ORBIT_DATA_DIR):
 *   <root>/
 *     worlds.json         World index (list; current world inferred from lastOpenedAt).
 *     config.json         AI providers + agent personas (global, shared across worlds).
 *     worlds/<worldId>/
 *       novel.json          小说元信息（卷、章结构）
 *       settings/           Codex settings docs (Markdown, by category).
 *         01-worldview/ 02-magic/ 03-history/ 04-geography/ 05-faction/
 *         06-religion/ 07-society/ 08-economy/ 09-technology/ 10-species/
 *         11-character/ 12-item/ 99-misc/
 *       chapters/           Chapter prose (Markdown).
 *       discussions/        Writers’ room sessions (JSON).
 *
 * First launch: import seed directory as the first world.
 * Legacy (single-work) first launch: migrate into worlds/<id>/.
 */

let rootDir: string
// 当前世界 id。所有依赖当前世界的路径函数据此定位；未选世界时为 null。
let currentWorldId: string | null = null

export const SETTING_CATEGORIES: SettingCategory[] = [
  '01-worldview',
  '02-magic',
  '03-history',
  '04-geography',
  '05-faction',
  '06-religion',
  '07-society',
  '08-economy',
  '09-technology',
  '10-species',
  '11-character',
  '12-item',
  '99-misc',
]

export function initPaths(): void {
  // 允许通过环境变量覆盖（开发时指向仓库内 .orbit-data，方便查看）
  rootDir = process.env.ORBIT_DATA_DIR ?? join(homedir(), '.lorekeeper')
  ensureDir(rootDir)
  ensureDir(worldsRoot())
}

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

// ---- 全局路径（基于 root，与具体世界无关）----
export const projectRoot = (): string => rootDir
export const worldsFile = (): string => join(rootDir, 'worlds.json')
export const configFile = (): string => join(rootDir, 'config.json')
export const worldsRoot = (): string => join(rootDir, 'worlds')
export const worldDir = (id: string): string => join(worldsRoot(), id)

// ---- 当前世界状态 ----
export const getCurrentWorldId = (): string | null => currentWorldId
export const setCurrentWorldId = (id: string | null): void => {
  currentWorldId = id
}

/** Current world dir; throws if no world selected (frontend should be at WorldGate). */
export function currentWorldDir(): string {
  if (!currentWorldId) throw new Error('No world selected.')
  return worldDir(currentWorldId)
}

// ---- 当前世界内的路径（基于 currentWorldId）----
export const settingsDir = (): string => join(currentWorldDir(), 'settings')
export const chaptersDir = (): string => join(currentWorldDir(), 'chapters')
export const discussionsDir = (): string => join(currentWorldDir(), 'discussions')
// 一致性报告目录：以非点开头，导出打包时会包含，保证审查成果可随世界迁移。
export const consistencyDir = (): string => join(currentWorldDir(), 'consistency')
// 角色对话目录：同上，会话随世界导出/迁移。
export const characterChatsDir = (): string => join(currentWorldDir(), 'character-chats')
export const outlineFile = (): string => join(currentWorldDir(), 'outline.md')
export const novelFile = (): string => join(currentWorldDir(), 'novel.json')
export const storyMemoryFile = (): string => join(currentWorldDir(), 'story-memory.json')
export const storyMemoryBackupsDir = (): string => join(currentWorldDir(), '.story-memory-backups')
// 审查队列:consistency 等审查发现的待处理项,跨会话跟踪状态。
export const reviewQueueFile = (): string => join(currentWorldDir(), 'review-queue.json')
// 快照目录（版本历史）。以点开头，导出打包时会跳过它，不污染用户的书稿。
export const snapshotsDir = (): string => join(currentWorldDir(), '.snapshots')

/** Create a complete world dir skeleton (settings categories + chapters + discussions). */
export function ensureWorldSkeleton(id: string): void {
  const dir = worldDir(id)
  ensureDir(dir)
  const settings = join(dir, 'settings')
  ensureDir(settings)
  for (const c of SETTING_CATEGORIES) ensureDir(join(settings, c))
  ensureDir(join(dir, 'chapters'))
  ensureDir(join(dir, 'discussions'))
  ensureDir(join(dir, 'consistency'))
  ensureDir(join(dir, 'character-chats'))
}
