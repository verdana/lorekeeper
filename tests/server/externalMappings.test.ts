import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ensureWorldSkeleton, initPaths, setCurrentWorldId } from '../../src/server/paths'
import {
  addExternalMapping,
  collectWorldFiles,
  createSetting,
  deleteSetting,
  listSettings,
  readExternalMappings,
  readSetting,
  removeExternalMapping,
  writeSetting,
} from '../../src/server/store'

let dataRoot = ''
let worldDir_ = ''
let extRoot = ''
const worldId = 'w_ext'

beforeAll(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'lorekeeper-ext-'))
  process.env.ORBIT_DATA_DIR = dataRoot
  initPaths()
  ensureWorldSkeleton(worldId)
  setCurrentWorldId(worldId)
  worldDir_ = join(dataRoot, 'worlds', worldId)
})

afterAll(() => {
  rmSync(dataRoot, { recursive: true, force: true })
})

beforeEach(() => {
  // Fresh external source tree per test.
  rmSync(extRoot, { recursive: true, force: true })
  extRoot = mkdtempSync(join(tmpdir(), 'lorekeeper-extsrc-'))
  // Fresh mappings state.
  writeFileSync(join(worldDir_, 'mappings.json'), '[]')
})

function addMapping(): { id: string; name: string } {
  const m = addExternalMapping({ rootPath: extRoot, category: '99-misc' })
  return { id: m.id, name: m.name }
}

describe('external folder mappings', () => {
  it('adds and removes mappings; persists across reads', () => {
    const m = addExternalMapping({ rootPath: extRoot, category: '04-geography' })
    expect(m.category).toBe('04-geography')
    expect(m.name).toBe(extRoot.split(/[\\/]/).pop())
    expect(readExternalMappings().map((x) => x.id)).toEqual([m.id])

    removeExternalMapping(m.id)
    expect(readExternalMappings()).toEqual([])
  })

  it('rejects non-absolute, missing, or non-directory roots', () => {
    expect(() => addExternalMapping({ rootPath: 'relative/path', category: '99-misc' })).toThrow(
      'must be absolute',
    )
    expect(() =>
      addExternalMapping({ rootPath: join(extRoot, 'nope'), category: '99-misc' }),
    ).toThrow('does not exist')
    const file = join(extRoot, 'a.txt')
    writeFileSync(file, 'x')
    expect(() => addExternalMapping({ rootPath: file, category: '99-misc' })).toThrow(
      'not a directory',
    )
  })

  it('lists mapped docs recursively, skipping hidden entries and non-md files', () => {
    writeFileSync(join(extRoot, 'Alice.md'), '# Alice\n\nprotagonist')
    writeFileSync(join(extRoot, 'notes.txt'), 'not a doc')
    mkdirSync(join(extRoot, '.obsidian'), { recursive: true })
    writeFileSync(join(extRoot, '.obsidian', 'conf.md'), 'hidden')
    mkdirSync(join(extRoot, 'characters'), { recursive: true })
    writeFileSync(join(extRoot, 'characters', 'Bob.md'), '# Bob\n\nsupporting')
    const { id } = addMapping()

    const docs = listSettings().filter((d) => d.external)
    expect(docs).toHaveLength(2)
    const byId = Object.fromEntries(docs.map((d) => [d.id, d]))
    expect(byId[`external:${id}/Alice.md`]).toMatchObject({
      title: 'Alice',
      category: '99-misc',
      external: { mappingId: id, relPath: 'Alice.md' },
    })
    expect(byId[`external:${id}/characters/Bob.md`].title).toBe('Bob')
    expect(docs.every((d) => d.external)).toBe(true)
  })

  it('merges external docs into listSettings alongside internal docs', () => {
    createSetting('11-character', 'Internal')
    const { id } = addMapping()
    writeFileSync(join(extRoot, 'External.md'), 'x')
    const all = listSettings()
    expect(all.some((d) => d.id === '11-character/Internal.md' && !d.external)).toBe(true)
    expect(all.some((d) => d.id === `external:${id}/External.md` && d.external)).toBe(true)
  })

  it('skips a mapping whose root vanished', () => {
    addMapping()
    rmSync(extRoot, { recursive: true, force: true })
    expect(listSettings().filter((d) => d.external)).toEqual([])
  })

  it('reads external docs via readSetting; missing file and unknown mapping return empty', () => {
    writeFileSync(join(extRoot, 'Alice.md'), '# Alice\n\nprotagonist')
    const { id } = addMapping()

    const doc = readSetting(`external:${id}/Alice.md`)
    expect(doc.content).toBe('# Alice\n\nprotagonist')
    expect(doc.title).toBe('Alice')
    expect(doc.external).toEqual({ mappingId: id, relPath: 'Alice.md' })

    expect(readSetting(`external:${id}/Missing.md`).content).toBe('')
    expect(readSetting('external:unknown-mapping/x.md').content).toBe('')
    expect(readSetting('external:malformed').content).toBe('')
  })

  it('refuses writes and deletes to external ids, leaving the file untouched', () => {
    writeFileSync(join(extRoot, 'Alice.md'), 'original')
    const { id } = addMapping()
    const docId = `external:${id}/Alice.md`

    writeSetting(docId, 'mutated')
    expect(readFileSync(join(extRoot, 'Alice.md'), 'utf-8')).toBe('original')

    deleteSetting(docId)
    expect(existsSync(join(extRoot, 'Alice.md'))).toBe(true)
  })

  it('rejects path traversal in external relPath', () => {
    writeFileSync(join(extRoot, 'Alice.md'), 'original')
    const { id } = addMapping()
    // Crafted relPath escaping the mapping root.
    expect(readSetting(`external:${id}/../secret.md`).content).toBe('')
  })

  it('rejects encoded and backslash traversal attempts in relPath', () => {
    writeFileSync(join(extRoot, 'secret.md'), 's')
    const { id } = addMapping()
    // URL-encoded dots are treated as a literal file name (resolved outside
    // the root on Windows, or as a missing file elsewhere): never escapes.
    expect(readSetting(`external:${id}/%2e%2e/secret.md`).content).toBe('')
    // Backslash separators: on Windows this lexically escapes (blocked), on
    // POSIX it is a literal file name that does not exist: either way ''.
    expect(readSetting(`external:${id}/..\\secret.md`).content).toBe('')
  })

  it('blocks symlink escapes from the mapping root', () => {
    const outside = join(extRoot, '..', 'outside-secret.md')
    writeFileSync(outside, 'top secret')
    const link = join(extRoot, 'leak.md')
    try {
      symlinkSync(outside, link)
    } catch {
      return // 平台/权限不允许创建符号链接：跳过该用例
    }
    const { id } = addMapping()
    // The symlink lives inside the root but points outside: must not leak.
    expect(readSetting(`external:${id}/leak.md`).content).toBe('')
  })

  it('falls back to an empty list when mappings.json is corrupt', () => {
    writeFileSync(join(worldDir_, 'mappings.json'), '{not json')
    expect(readExternalMappings()).toEqual([])
  })

  it('excludes external content from world export but includes mappings.json', () => {
    writeFileSync(join(extRoot, 'Alice.md'), 'external secret')
    addMapping()
    const { files } = collectWorldFiles()
    expect(files.some((f) => f.path.includes('Alice.md'))).toBe(false)
    expect(files.some((f) => f.path === 'mappings.json')).toBe(true)
  })
})
