import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  ensureWorldSkeleton,
  initPaths,
  novelFile,
  setCurrentWorldId,
} from '../../src/server/paths'
import { searchManuscriptProse, writeChapter } from '../../src/server/store'
import type { NovelMeta } from '../../src/shared/types'

let dataRoot = ''
const worldId = 'w_search'

const novel: NovelMeta = {
  title: 'Manuscript',
  author: '',
  synopsis: '',
  tags: [],
  volumes: [
    {
      id: 'v1',
      title: 'Volume 1',
      order: 0,
      chapters: [
        {
          id: 'c1',
          volumeId: 'v1',
          title: '第01章｜血月',
          order: 0,
          file: 'v1_c1.md',
          wordCount: 0,
          status: 'done',
          updatedAt: 1,
        },
        {
          id: 'c2',
          volumeId: 'v1',
          title: '第02章｜空章',
          order: 1,
          file: 'v1_c2.md',
          wordCount: 0,
          status: 'draft',
          updatedAt: 1,
        },
        {
          id: 'c3',
          volumeId: 'v1',
          title: '第03章｜镜子',
          order: 2,
          file: 'v1_c3.md',
          wordCount: 0,
          status: 'done',
          updatedAt: 1,
        },
      ],
    },
  ],
}

beforeAll(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'lorekeeper-prose-search-'))
  process.env.ORBIT_DATA_DIR = dataRoot
  initPaths()
  ensureWorldSkeleton(worldId)
  setCurrentWorldId(worldId)
})

afterAll(() => {
  setCurrentWorldId(null)
  delete process.env.ORBIT_DATA_DIR
  rmSync(dataRoot, { recursive: true, force: true })
})

beforeEach(() => {
  writeFileSync(novelFile(), JSON.stringify(novel, null, 2))
  writeChapter('v1_c1.md', '# 第01章｜血月\n\n杨羽把铜盘按在桌上。')
  // A chapter that exists as a placeholder only — no prose to match.
  writeChapter('v1_c2.md', '# 第02章｜空章\n')
  writeChapter('v1_c3.md', '# 第03章｜镜子\n\n镜子里的人先动了，杨羽没有回头。')
})

describe('manuscript text search', () => {
  it('finds the chapter holding a phrase', () => {
    const matches = searchManuscriptProse('杨羽')

    expect(matches.map((match) => match.chapterId)).toEqual(['c1', 'c3'])
    expect(matches[0].chapterTitle).toBe('第01章｜血月')
    expect(matches[0].line).toBe('杨羽把铜盘按在桌上。')
  })

  it('reads the file on disk rather than a cached body', () => {
    expect(searchManuscriptProse('先动了')).toHaveLength(1)

    writeChapter('v1_c3.md', '# 第03章｜镜子\n\n镜子里的人始终没有动。')

    const matches = searchManuscriptProse('先动了')
    expect(matches).toEqual([])
    expect(searchManuscriptProse('没有动')).toHaveLength(1)
  })

  it('skips a chapter whose body is a placeholder heading', () => {
    expect(searchManuscriptProse('空章').map((match) => match.chapterId)).toEqual([])
  })

  it('matches a phrase that spans the heading line too', () => {
    expect(searchManuscriptProse('镜子').map((match) => match.chapterId)).toEqual(['c3'])
  })

  it('returns nothing for an empty query', () => {
    expect(searchManuscriptProse('')).toEqual([])
    expect(searchManuscriptProse('   ')).toEqual([])
  })

  it('honours the result limit', () => {
    expect(searchManuscriptProse('杨羽', 1)).toHaveLength(1)
  })

  it('returns nothing when no chapter contains the query', () => {
    expect(searchManuscriptProse('不曾出现的句子')).toEqual([])
  })
})
