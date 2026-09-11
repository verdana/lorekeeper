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
 * Codex documents and external folder mappings.
 *
 * External mappings are read-only by construction: every write path refuses an
 * id that came from a mapped folder, so a world's codex can include a notes
 * directory that the app never modifies.
 */

import type {
  ExternalMapping,
  SettingCategory,
  SettingDoc,
  SettingDocContent,
} from '../../shared/types'
import { SETTING_CATEGORIES, currentWorldDir, settingsDir } from '../paths'
import { CATEGORY_TEMPLATES } from '../defaults'
import { atomicWrite, readJSON, safeResolve, snapshot, writeJSON } from './core'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync } from 'fs'
import { basename, extname, isAbsolute, join, relative } from 'path'

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
