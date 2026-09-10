import { describe, expect, it } from 'vitest'
import {
  CHAPTER_PROSE_MATCH_LIMIT,
  hasSearchableProse,
  matchChapterProse,
  searchChapterProse,
} from '../../src/shared/chapterSearch'
import type { ChapterProseSource } from '../../src/shared/types'

const chapter = (id: string, title: string, text: string): ChapterProseSource => ({
  chapterId: id,
  chapterTitle: title,
  text,
})

// Shaped like the real manuscript: CJK prose, one line per paragraph.
const chapterThree = chapter(
  'c3',
  '第03章｜镜子里的人先动了',
  [
    '# 第03章｜镜子里的人先动了',
    '',
    '杨羽盯着铜盘，指腹擦过那道划痕。',
    '',
    '瓦莱里娅没有说话。',
  ].join('\n'),
)

/**
 * The palette could only match chapter titles and statuses, so finding a line
 * you had written meant opening chapters one at a time. These cases pin the
 * matching rules that manuscript text search relies on.
 */
describe('matchChapterProse', () => {
  it('finds a CJK phrase without word boundaries', () => {
    const match = matchChapterProse(chapterThree, '铜盘')
    expect(match).not.toBeNull()
    expect(match?.chapterId).toBe('c3')
    expect(match?.chapterTitle).toBe('第03章｜镜子里的人先动了')
  })

  it('reports the whole line containing the match', () => {
    const match = matchChapterProse(chapterThree, '划痕')
    expect(match?.line).toBe('杨羽盯着铜盘，指腹擦过那道划痕。')
  })

  it('strips a heading marker when the heading shares the match line', () => {
    // Real chapters glue the heading to the opening paragraph on one line.
    const source = chapter(
      'c1',
      '第05章',
      '## 第05章｜账只算到天亮 马在暗色里小跑，瓦莱里娅没有催它。',
    )
    const match = matchChapterProse(source, '瓦莱里娅')
    expect(match?.line.startsWith('##')).toBe(false)
    expect(match?.line.startsWith('第05章｜账只算到天亮')).toBe(true)
  })

  it('includes surrounding context in the snippet, marking what it cut', () => {
    const long = chapter('c1', 'One', `# One\n\n${'前'.repeat(60)}铜盘${'后'.repeat(60)}`)
    const match = matchChapterProse(long, '铜盘')
    expect(match?.snippet).toContain('铜盘')
    // Both ends sit beyond the padding, so both are marked as cut.
    expect(match?.snippet.startsWith('…')).toBe(true)
    expect(match?.snippet.endsWith('…')).toBe(true)
    expect(match?.snippet.length).toBeLessThan(long.text.length)
  })

  it('keeps a short chapter whole, without cut markers', () => {
    const match = matchChapterProse(chapterThree, '瓦莱里娅')
    expect(match?.snippet).toContain('瓦莱里娅')
    expect(match?.snippet.startsWith('…')).toBe(false)
    expect(match?.snippet.endsWith('…')).toBe(false)
  })

  it('matches case-insensitively for latin text', () => {
    const source = chapter('c1', 'One', '# One\n\nAri hides the Brass Key.')
    expect(matchChapterProse(source, 'brass key')).not.toBeNull()
    expect(matchChapterProse(source, 'BRASS KEY')).not.toBeNull()
  })

  it('reports the match offset within the chapter body', () => {
    const source = chapter('c1', 'One', '# One\n\nAri hides the key.')
    const offset = source.text.indexOf('key')
    expect(matchChapterProse(source, 'key')?.offset).toBe(offset)
  })

  it('counts every occurrence in the chapter', () => {
    const source = chapter('c1', 'One', 'key here, key there, key everywhere')
    expect(matchChapterProse(source, 'key')?.count).toBe(3)
  })

  it('returns null when the query does not occur', () => {
    expect(matchChapterProse(chapterThree, '不存在的词')).toBeNull()
  })

  it('returns null for an empty or whitespace query', () => {
    expect(matchChapterProse(chapterThree, '')).toBeNull()
    expect(matchChapterProse(chapterThree, '   ')).toBeNull()
  })

  it('tolerates a match at the very start and very end', () => {
    const source = chapter('c1', 'One', 'alpha middle omega')
    expect(matchChapterProse(source, 'alpha')?.snippet.startsWith('…')).toBe(false)
    expect(matchChapterProse(source, 'omega')?.snippet.endsWith('…')).toBe(false)
  })
})

/**
 * A planned chapter sits on disk as its heading alone, and that heading is the
 * chapter title — already answered by the metadata search. Searching those
 * bodies would return the title the author typed in response to a prose query.
 */
describe('hasSearchableProse', () => {
  it('rejects an empty body', () => {
    expect(hasSearchableProse('')).toBe(false)
    expect(hasSearchableProse('\n\n   \n')).toBe(false)
  })

  it('rejects a body that holds only headings', () => {
    expect(hasSearchableProse('# 第02章｜空章\n')).toBe(false)
    expect(hasSearchableProse('# One\n## Two\n\n')).toBe(false)
  })

  it('accepts a body with any non-heading line', () => {
    expect(hasSearchableProse('# One\n\nAri waits.')).toBe(true)
    expect(hasSearchableProse('Ari waits.')).toBe(true)
  })
})

describe('searchChapterProse', () => {
  it('searches every chapter and keeps reading order', () => {
    const chapters = [
      chapter('c1', 'One', '# One\n\nAri waits.'),
      chapter('c2', 'Two', '# Two\n\nNothing here.'),
      chapter('c3', 'Three', '# Three\n\nAri returns.'),
    ]

    const matches = searchChapterProse(chapters, 'Ari')

    expect(matches.map((match) => match.chapterId)).toEqual(['c1', 'c3'])
  })

  it('keeps at most one hit per chapter, so one phrase cannot flood results', () => {
    const chapters = [chapter('c1', 'One', Array(20).fill('Ari waits.').join('\n'))]

    const matches = searchChapterProse(chapters, 'Ari')

    expect(matches).toHaveLength(1)
    expect(matches[0].count).toBe(20)
  })

  it('stops at the limit', () => {
    const chapters = Array.from({ length: 30 }, (_, i) =>
      chapter(`c${i}`, `Chapter ${i}`, `Ari appears in chapter ${i}.`),
    )

    expect(searchChapterProse(chapters, 'Ari')).toHaveLength(CHAPTER_PROSE_MATCH_LIMIT)
    expect(searchChapterProse(chapters, 'Ari', 3)).toHaveLength(3)
  })

  it('returns nothing for an empty query or a non-positive limit', () => {
    expect(searchChapterProse([chapterThree], '')).toEqual([])
    expect(searchChapterProse([chapterThree], '铜盘', 0)).toEqual([])
  })

  it('returns nothing for an empty manuscript', () => {
    expect(searchChapterProse([], 'anything')).toEqual([])
  })
})
