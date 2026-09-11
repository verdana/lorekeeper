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
 * Continuity data: the author-confirmed Story Memory, the per-chapter summaries
 * and the story-state archive rebuilt from them.
 *
 * Story Memory is the only one of the three that is not derived: entries are
 * suggested by the AI and confirmed by the author, and merging a store in keeps
 * the author's decisions (see `mergeStoryMemory`).
 */

import type {
  ChapterSummary,
  NovelMeta,
  StoryMemoryBackup,
  StoryMemoryEntry,
  StoryMemoryImportResult,
  StoryMemoryKind,
  StoryMemorySource,
  StoryMemoryStore,
  StoryMemoryStatus,
  StoryState,
} from '../../shared/types'
import {
  chapterSummariesDir,
  ensureDir,
  novelFile,
  storyMemoryBackupsDir,
  storyMemoryFile,
  storyStateFile,
} from '../paths'
import { DEFAULT_NOVEL_META } from '../defaults'
import { assertWritable, atomicWrite, readJSON, safeResolve, writeJSON } from './core'
import { chapterPath } from './manuscript'
import { existsSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync } from 'fs'
import { basename, dirname, join } from 'path'

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
