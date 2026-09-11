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
 * The structured outline — the single source of truth for structure.
 *
 * `novel.json` mirrors it: ids, titles and order come from the outline, while
 * prose state (file, word count, draft/final) stays with the manuscript. A
 * store with no volumes while chapters exist is treated as damaged and rebuilt
 * from `novel.json`, because deleting every volume also empties `novel.json`.
 */

import type { NovelMeta, OutlineStore } from '../../shared/types'
import { chaptersDir, ensureDir, novelFile, outlineDir, outlineJsonFile } from '../paths'
import { DEFAULT_NOVEL_META } from '../defaults'
import {
  emptyOutlineStore,
  normalizeOutlineStore,
  outlineFromLegacy,
  outlineFromNovel,
  parseLegacyOutline,
  serializeOutlineForAI,
  syncNovelFromOutline,
} from '../../shared/outlineStore'
import {
  assertWritable,
  atomicWrite,
  preserveDamagedFile,
  readJSON,
  snapshot,
  writeJSON,
} from './core'
import { syncWorldFromNovel } from './worlds'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { extname, join } from 'path'

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
