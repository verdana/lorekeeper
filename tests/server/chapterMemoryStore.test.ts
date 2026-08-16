import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  chapterSummariesDir,
  ensureWorldSkeleton,
  initPaths,
  setCurrentWorldId,
} from '../../src/server/paths'
import { listChapterSummaries, writeChapter, writeChapterSummary } from '../../src/server/store'
import type { ChapterSummary, NovelMeta } from '../../src/shared/types'

let dataRoot = ''
const worldId = 'w_cm_test'

const novel: NovelMeta = {
  title: 'Test',
  author: '',
  synopsis: '',
  tags: [],
  volumes: [
    {
      id: 'v1',
      title: 'Vol',
      order: 0,
      chapters: [
        {
          id: 'c1',
          volumeId: 'v1',
          title: '第01章',
          order: 0,
          file: 'v1_c1.md',
          wordCount: 0,
          status: 'draft',
          updatedAt: 1,
        },
        {
          id: 'c2',
          volumeId: 'v1',
          title: '第02章',
          order: 1,
          file: 'v1_c2.md',
          wordCount: 0,
          status: 'draft',
          updatedAt: 1,
        },
        {
          id: 'c3',
          volumeId: 'v1',
          title: '第03章',
          order: 2,
          file: 'v1_c3.md',
          wordCount: 0,
          status: 'draft',
          updatedAt: 1,
        },
      ],
    },
  ],
}

const summary = (chapterId: string, title: string): ChapterSummary => ({
  chapterId,
  chapterTitle: title,
  sourceFingerprint: 'fnv1a-abc',
  generatedAt: Date.now(),
  summary: '摘要。',
  endState: '状态。',
  stateChanges: [],
  plantedThreads: [],
  resolvedThreads: [],
})

beforeAll(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'lorekeeper-cm-'))
  process.env.ORBIT_DATA_DIR = dataRoot
  initPaths()
  ensureWorldSkeleton(worldId)
  setCurrentWorldId(worldId)
  writeFileSync(join(dataRoot, 'worlds', worldId, 'novel.json'), JSON.stringify(novel, null, 2))
})

afterAll(() => {
  rmSync(dataRoot, { recursive: true, force: true })
})

beforeEach(() => {
  const dir = chapterSummariesDir()
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
})

describe('listChapterSummaries filters unwritten chapters', () => {
  it('drops summaries whose chapter has only a placeholder body', () => {
    // c1 has real prose; c2 has only the placeholder; c3 has no file at all.
    writeChapter('v1_c1.md', '# 第01章\n\n正文内容足够长超过一百字节以通过过滤。'.repeat(6))
    writeChapter('v1_c2.md', '# 第02章\n\n')
    writeChapterSummary(summary('c1', '第01章'))
    writeChapterSummary(summary('c2', '第02章'))
    writeChapterSummary(summary('c3', '第03章'))

    const listed = listChapterSummaries()
    expect(listed.map((s) => s.chapterId)).toEqual(['c1'])
  })

  it('keeps summaries for all chapters once every body exists', () => {
    writeChapter('v1_c1.md', '# 第01章\n\n'.padEnd(200, '正文'))
    writeChapter('v1_c2.md', '# 第02章\n\n'.padEnd(200, '正文'))
    writeChapter('v1_c3.md', '# 第03章\n\n'.padEnd(200, '正文'))
    writeChapterSummary(summary('c1', '第01章'))
    writeChapterSummary(summary('c2', '第02章'))
    writeChapterSummary(summary('c3', '第03章'))

    const listed = listChapterSummaries()
    expect(listed).toHaveLength(3)
  })
})
