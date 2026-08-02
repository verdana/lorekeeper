import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  consistencyDir,
  ensureWorldSkeleton,
  initPaths,
  setCurrentWorldId,
} from '../../src/server/paths'
import {
  deleteConsistencyReport,
  listConsistencyReports,
  saveConsistencyReport,
} from '../../src/server/store'
import type { ConsistencyReport } from '../../src/shared/types'

let dataRoot = ''
const worldId = 'w_test'

const writeReportFile = (r: ConsistencyReport): void => {
  writeFileSync(join(consistencyDir(), `${r.id}.json`), JSON.stringify(r, null, 2))
}

beforeAll(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'lorekeeper-consistency-'))
  process.env.ORBIT_DATA_DIR = dataRoot
  initPaths()
  ensureWorldSkeleton(worldId)
  setCurrentWorldId(worldId)
})

afterAll(() => {
  rmSync(dataRoot, { recursive: true, force: true })
})

beforeEach(() => {
  for (const f of readdirSync(consistencyDir())) {
    rmSync(join(consistencyDir(), f), { force: true })
  }
})

describe('consistency report persistence', () => {
  it('persists a report with generated metadata', () => {
    const r = saveConsistencyReport({
      content: '# Report\n\n- 🔴 name drift\n- 🟡 timeline conflict',
      scope: { docs: ['Codex A'], chapters: ['Chapter 1'] },
    })
    expect(r.id).toMatch(/^c_/)
    expect(r.createdAt).toBeGreaterThan(0)
    expect(r.wordCount).toBeGreaterThan(0)
    expect(r.status).toBe('open')
    expect(existsSync(join(consistencyDir(), `${r.id}.json`))).toBe(true)
  })

  it('strips whitespace and dedupes scope entries', () => {
    const r = saveConsistencyReport({
      content: 'a b',
      scope: { docs: ['Codex A', 'Codex A', '  '], chapters: ['C1', 'C1'] },
    })
    expect(r.wordCount).toBe(2)
    expect(r.scope.docs).toEqual(['Codex A'])
    expect(r.scope.chapters).toEqual(['C1'])
  })

  it('lists reports newest first and deletes by id', () => {
    const older: ConsistencyReport = {
      id: 'c_older',
      createdAt: 100,
      scope: { docs: [], chapters: [] },
      content: 'older',
      wordCount: 5,
      status: 'open',
    }
    const newer: ConsistencyReport = {
      id: 'c_newer',
      createdAt: 200,
      scope: { docs: [], chapters: [] },
      content: 'newer',
      wordCount: 5,
      status: 'open',
    }
    writeReportFile(older)
    writeReportFile(newer)
    expect(listConsistencyReports().map((r) => r.id)).toEqual(['c_newer', 'c_older'])

    deleteConsistencyReport('c_older')
    expect(listConsistencyReports().map((r) => r.id)).toEqual(['c_newer'])
    expect(existsSync(join(consistencyDir(), 'c_older.json'))).toBe(false)
  })

  it('ignores non-JSON files and corrupt entries', () => {
    writeFileSync(join(consistencyDir(), 'notes.txt'), 'not a report')
    writeFileSync(join(consistencyDir(), 'broken.json'), '{oops')
    saveConsistencyReport({ content: 'ok', scope: { docs: [], chapters: [] } })
    expect(listConsistencyReports().length).toBe(1)
  })

  it('recreates the directory when missing (legacy world)', () => {
    rmSync(consistencyDir(), { recursive: true, force: true })
    const r = saveConsistencyReport({ content: 'x', scope: { docs: [], chapters: [] } })
    expect(existsSync(consistencyDir())).toBe(true)
    expect(existsSync(join(consistencyDir(), `${r.id}.json`))).toBe(true)
  })
})
