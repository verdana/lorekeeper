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
 * The small world-local records: writers' room sessions, saved consistency
 * reports, character chat sessions and the review queue.
 *
 * They share one pattern — a JSON file (or a directory of them) read with a
 * shape guard, written atomically, snapshotted first — so they live together
 * rather than in four near-identical modules.
 */

import type {
  CharacterChatSession,
  ConsistencyReport,
  DiscussionSession,
  ReviewQueueStore,
} from '../../shared/types'
import {
  characterChatsDir,
  consistencyDir,
  discussionsDir,
  ensureDir,
  reviewQueueFile,
} from '../paths'
import { isReviewQueueItem } from '../../shared/reviewQueue'
import { assertWritable, readJSON, snapshot, writeJSON } from './core'
import { existsSync, readdirSync, unlinkSync } from 'fs'
import { basename, extname, join } from 'path'

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
