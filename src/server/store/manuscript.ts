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
 * Chapter prose: one Markdown file per chapter, plus the prose search that
 * backs the command palette.
 *
 * Search reads the files rather than a cached index, so results always match
 * what is on disk.
 */

import type { NovelMeta } from '../../shared/types'
import { chaptersDir, novelFile } from '../paths'
import { DEFAULT_NOVEL_META } from '../defaults'
import {
  hasSearchableProse,
  searchChapterProse as searchChapterProseMatches,
  type ChapterProseMatch,
  type ChapterProseSource,
} from '../../shared/chapterSearch'
import { atomicWrite, readJSON, safeResolve, snapshot } from './core'
import { existsSync, readFileSync } from 'fs'

// ---- 章节正文 ----
/** Exported for the story module, which checks a chapter body's size. */
export const chapterPath = (file: string): string => {
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
