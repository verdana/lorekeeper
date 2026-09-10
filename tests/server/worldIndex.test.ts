import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { initPaths, worldsFile } from '../../src/server/paths'
import { createBlankWorld, listWorlds, switchWorld } from '../../src/server/store'
import type { WorldMeta } from '../../src/shared/types'

let dataRoot = ''

/**
 * The world index is the only record of which world directories exist. Every
 * creator path persists `[...readWorlds(), meta]`, so a parse failure that read
 * as "no worlds" replaced the whole index with the one world being created and
 * left every existing world unreachable, with no snapshot to restore from.
 */
describe('world index (worlds.json)', () => {
  const existing: WorldMeta[] = [
    {
      id: 'w_existing',
      title: 'The Existing World',
      genre: 'fantasy',
      coverColor: '#d4a24e',
      createdAt: 1,
      lastOpenedAt: 1,
    },
  ]

  const sidecarPath = (): string => join(dataRoot, '.corrupt-worlds.json')

  beforeAll(() => {
    dataRoot = mkdtempSync(join(tmpdir(), 'lorekeeper-worlds-'))
    process.env.ORBIT_DATA_DIR = dataRoot
    initPaths()
  })

  beforeEach(() => {
    rmSync(worldsFile(), { force: true })
    rmSync(sidecarPath(), { force: true })
  })

  afterAll(() => {
    rmSync(dataRoot, { recursive: true, force: true })
    delete process.env.ORBIT_DATA_DIR
  })

  it('lists worlds from a healthy index', () => {
    writeFileSync(worldsFile(), JSON.stringify(existing, null, 2))
    expect(listWorlds().map((w) => w.id)).toEqual(['w_existing'])
  })

  it('treats a missing index as an empty list', () => {
    expect(listWorlds()).toEqual([])
  })

  it('refuses to read an unparseable index instead of reporting no worlds', () => {
    const damaged = '[{"id":"w_existing"'
    writeFileSync(worldsFile(), damaged)

    expect(() => listWorlds()).toThrow(/worlds\.json is damaged/)

    // The damaged file is untouched and a copy is kept beside it.
    expect(readFileSync(worldsFile(), 'utf-8')).toBe(damaged)
    expect(existsSync(sidecarPath())).toBe(true)
    expect(readFileSync(sidecarPath(), 'utf-8')).toBe(damaged)
  })

  it('refuses to read an index that is valid JSON but not a list', () => {
    writeFileSync(worldsFile(), JSON.stringify({ worlds: existing }))

    expect(() => listWorlds()).toThrow(/does not contain a list of worlds/)
    expect(existsSync(sidecarPath())).toBe(true)
  })

  it('does not replace the index with the newly created world', () => {
    const damaged = '[{"id":"w_existing"'
    writeFileSync(worldsFile(), damaged)

    expect(() => createBlankWorld('New World', 'fantasy', '#000000')).toThrow(/damaged/)

    // The failed create must not have persisted a one-entry index over it.
    expect(readFileSync(worldsFile(), 'utf-8')).toBe(damaged)
  })

  it('keeps every world when switching worlds', () => {
    writeFileSync(worldsFile(), JSON.stringify(existing, null, 2))

    switchWorld('w_existing')

    const after = JSON.parse(readFileSync(worldsFile(), 'utf-8')) as WorldMeta[]
    expect(after.map((w) => w.id)).toEqual(['w_existing'])
    expect(after[0].lastOpenedAt).toBeGreaterThan(1)
  })

  it('refuses to switch to a world that is not in the index', () => {
    writeFileSync(worldsFile(), JSON.stringify(existing, null, 2))
    expect(() => switchWorld('w_missing')).toThrow('World not found.')
  })
})
