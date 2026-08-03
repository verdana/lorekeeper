import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  ensureWorldSkeleton,
  initPaths,
  outlineDir,
  outlineFile,
  setCurrentWorldId,
} from '../../src/server/paths'
import {
  collectOutlineFiles,
  createOutlineDoc,
  deleteOutlineDoc,
  listOutlineDocs,
  readOutline,
  readOutlineDoc,
  writeOutline,
  writeOutlineDoc,
} from '../../src/server/store'

let dataRoot = ''
const worldId = 'w_test'

beforeAll(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'lorekeeper-outline-'))
  process.env.ORBIT_DATA_DIR = dataRoot
  initPaths()
  ensureWorldSkeleton(worldId)
  setCurrentWorldId(worldId)
})

afterAll(() => {
  rmSync(dataRoot, { recursive: true, force: true })
})

beforeEach(() => {
  // Reset: clear the outline dir and the legacy single-file outline.
  rmSync(outlineDir(), { recursive: true, force: true })
  if (existsSync(outlineFile())) rmSync(outlineFile())
})

describe('outline multi-document storage', () => {
  it('merges all directory docs on read, sorted by file name', () => {
    writeOutlineDoc('02-细纲.md', '# 细纲\n\n第二卷细节。')
    writeOutlineDoc('01-总纲.md', '# 总纲\n\n第一卷概要。')
    const merged = readOutline()
    expect(merged).toContain('第一卷概要')
    expect(merged).toContain('第二卷细节')
    expect(merged.indexOf('第一卷概要')).toBeLessThan(merged.indexOf('第二卷细节'))
  })

  it('lists docs in file-name order', () => {
    writeOutlineDoc('b.md', 'x')
    writeOutlineDoc('a.md', 'y')
    writeOutlineDoc('c.md', 'z')
    expect(listOutlineDocs().map((d) => d.id)).toEqual(['a.md', 'b.md', 'c.md'])
  })

  it('creates, reads, updates and deletes a doc', () => {
    const created = createOutlineDoc('03-新文档')
    expect(existsSync(join(outlineDir(), '03-新文档.md'))).toBe(true)
    writeOutlineDoc(created.id, '# 新文档\n\n正文')
    expect(readOutlineDoc(created.id).content).toContain('正文')
    deleteOutlineDoc(created.id)
    expect(existsSync(join(outlineDir(), '03-新文档.md'))).toBe(false)
  })

  it('sanitizes unsafe create titles', () => {
    const doc = createOutlineDoc('a/b:c')
    expect(doc.id).toBe('a_b_c.md')
    expect(existsSync(join(outlineDir(), doc.id))).toBe(true)
  })

  it('writeOutline round-trips into the directory file', () => {
    writeOutline('## 讨论室分发内容\n')
    const doc = readOutlineDoc('outline.md')
    expect(doc.content).toContain('讨论室分发内容')
    expect(readOutline()).toContain('讨论室分发内容')
  })

  it('falls back to legacy outline.md when the directory is empty', () => {
    writeFileSync(outlineFile(), '# 旧版大纲\n\n迁移前的正文。')
    expect(readOutline()).toBe('# 旧版大纲\n\n迁移前的正文。')
    const list = listOutlineDocs()
    expect(list.length).toBe(1)
    expect(list[0].id).toBe('outline.md')
    expect(list[0].title).toBe('outline')
  })

  it('writeOutline always writes into the outline dir, never the legacy file', () => {
    writeFileSync(outlineFile(), '# 旧版大纲\n')
    writeOutline('# 旧版大纲\n\n追加后的正文。')
    // The written content is always visible via the merged read.
    expect(readOutline()).toContain('追加后的正文')
    expect(existsSync(join(outlineDir(), 'outline.md'))).toBe(true)
    // The legacy file is left untouched on disk.
    expect(readFileSync(outlineFile(), 'utf-8')).toBe('# 旧版大纲\n')
    expect(listOutlineDocs().map((d) => d.id)).toEqual(['outline.md'])
  })

  it('ignores the legacy file once the dir is non-empty (no divergence)', () => {
    writeFileSync(outlineFile(), '# 旧版大纲\n')
    writeOutlineDoc('01-总纲.md', '# 总纲\n')
    writeOutline('## 分发内容\n') // writes outline/outline.md inside the dir
    expect(readOutline()).toContain('# 总纲')
    expect(readOutline()).toContain('分发内容')
    expect(readOutline()).not.toContain('旧版大纲')
    expect(listOutlineDocs().map((d) => d.id)).toEqual(['01-总纲.md', 'outline.md'])
  })

  it('prefers the directory doc over the legacy file for id outline.md', () => {
    writeFileSync(outlineFile(), '# 旧版大纲\n')
    writeOutlineDoc('outline.md', '# 新版大纲\n')
    expect(readOutlineDoc('outline.md').content).toBe('# 新版大纲\n')
    expect(listOutlineDocs().map((d) => d.id)).toEqual(['outline.md'])
  })

  it('rejects path traversal in doc ids', () => {
    writeOutlineDoc('01-总纲.md', 'x')
    expect(() => readOutlineDoc('../secret.md')).toThrow()
    expect(() => writeOutlineDoc('..\\evil.md', 'x')).toThrow()
    expect(() => deleteOutlineDoc('../escape.md')).toThrow()
    // Traversal that normalizes back inside the dir is safely allowed.
    expect(() => deleteOutlineDoc('sub/../escape.md')).not.toThrow()
  })

  it('collects all dir docs for zip export, sorted, with outline/ prefix', () => {
    writeOutlineDoc('02-细纲.md', '# 细纲\n')
    writeOutlineDoc('01-总纲.md', '# 总纲\n')
    const { name, files } = collectOutlineFiles()
    expect(name).toBe('Untitled Manuscript') // fallback novel meta title
    expect(files.map((f) => f.path)).toEqual(['outline/01-总纲.md', 'outline/02-细纲.md'])
    expect(files[0].content.toString('utf-8')).toContain('# 总纲')
  })

  it('collects the legacy outline.md when the dir is empty', () => {
    writeFileSync(outlineFile(), '# 旧版大纲\n')
    const { files } = collectOutlineFiles()
    expect(files.map((f) => f.path)).toEqual(['outline.md'])
    expect(files[0].content.toString('utf-8')).toContain('# 旧版大纲')
  })

  it('collects nothing when there is no outline at all', () => {
    const { files } = collectOutlineFiles()
    expect(files).toEqual([])
  })
})
