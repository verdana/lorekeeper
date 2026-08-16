import { describe, expect, it } from 'vitest'
import type { NovelMeta, OutlineStore } from '../../src/shared/types'
import {
  deriveVolumeStatus,
  emptyOutlineStore,
  findOutlineChapter,
  normalizeOutlineStore,
  outlineChapterOrdinals,
  outlineFromLegacy,
  outlineFromNovel,
  parseLegacyOutline,
  serializeChapterBeats,
  serializeChapterOutline,
  serializeOutlineForAI,
  syncNovelFromOutline,
} from '../../src/shared/outlineStore'

const meta: NovelMeta = {
  title: 'Star Tracker',
  author: 'Author',
  synopsis: '…',
  tags: ['fantasy'],
  volumes: [
    {
      id: 'v1',
      title: '第一卷',
      order: 0,
      chapters: [
        {
          id: 'c1',
          volumeId: 'v1',
          title: '第01章｜血月下的第二次心跳',
          order: 0,
          file: 'v1_c1.md',
          wordCount: 100,
          status: 'done',
          updatedAt: 1,
        },
        {
          id: 'c2',
          volumeId: 'v1',
          title: '第02章｜盘没有回答他',
          order: 1,
          file: 'v1_c2.md',
          wordCount: 200,
          status: 'draft',
          updatedAt: 2,
        },
      ],
    },
  ],
}

const store = (): OutlineStore => ({
  version: 1,
  updatedAt: 1,
  overview: '全书总览',
  notes: '',
  volumes: [
    {
      id: 'v1',
      title: '·废铁砸门',
      summary: '陆小满的学徒日常被一块废铁打破。',
      config: '第1、5章为付费点。',
      status: 'planning',
      chapters: [
        {
          id: 'c1',
          title: '第01章｜咣当一声',
          status: 'confirmed',
          beats: [{ title: '咣当一声', summary: '废铁砸在桌上。' }],
        },
        {
          id: 'c2',
          title: '第02章｜夜半低语',
          status: 'planned',
          beats: [{ title: '夜半低语', summary: '废铁夜里低语。' }],
        },
      ],
    },
    {
      id: 'v2',
      title: '·会走路的影城',
      summary: '',
      config: '',
      status: 'planned',
      chapters: [],
    },
  ],
})

describe('emptyOutlineStore / normalizeOutlineStore', () => {
  it('produces a valid empty store', () => {
    const s = emptyOutlineStore()
    expect(s.version).toBe(1)
    expect(s.volumes).toEqual([])
  })

  it('normalizes a well-formed store unchanged', () => {
    expect(normalizeOutlineStore(store())).toEqual(store())
  })

  it('fills defaults for missing fields and drops invalid ids', () => {
    const normalized = normalizeOutlineStore({
      overview: 'x',
      volumes: [
        { title: 'no id', chapters: [] },
        { id: 'v9', title: '', chapters: [{ id: 'c9', beats: [{ summary: 'only body' }] }] },
      ],
    } as unknown)
    expect(normalized.overview).toBe('x')
    expect(normalized.volumes).toHaveLength(1)
    expect(normalized.volumes[0].id).toBe('v9')
    expect(normalized.volumes[0].status).toBe('planning') // 有章但未全确认
    expect(normalized.volumes[0].chapters[0].status).toBe('planned')
    expect(normalized.volumes[0].chapters[0].beats[0].title).toBe('')
    expect(normalized.volumes[0].chapters[0].beats[0].summary).toBe('only body')
  })

  it('derives volume status from content when missing', () => {
    const s = normalizeOutlineStore({ volumes: [{ id: 'a', chapters: [] }] } as unknown)
    expect(s.volumes[0].status).toBe('planned')
    const s2 = normalizeOutlineStore({
      volumes: [
        {
          id: 'a',
          chapters: [
            { id: 'c', beats: [] },
            { id: 'd', status: 'confirmed', beats: [] },
          ],
        },
      ],
    } as unknown)
    expect(s2.volumes[0].status).toBe('planning')
    const s3 = normalizeOutlineStore({
      volumes: [{ id: 'a', chapters: [{ id: 'c', status: 'confirmed', beats: [] }] }],
    } as unknown)
    expect(s3.volumes[0].status).toBe('confirmed')
  })

  it('rejects garbage input with the empty store', () => {
    const a = normalizeOutlineStore(null)
    const b = normalizeOutlineStore('nope')
    const empty = emptyOutlineStore()
    for (const s of [a, b]) {
      expect(s.version).toBe(1)
      expect(s.overview).toBe('')
      expect(s.notes).toBe('')
      expect(s.volumes).toEqual([])
      expect(typeof s.updatedAt).toBe('number')
    }
    expect(empty.volumes).toEqual([])
  })
})

describe('deriveVolumeStatus', () => {
  it('prefers explicit status, falls back to content', () => {
    const v = store().volumes[0]
    expect(deriveVolumeStatus({ ...v, status: 'confirmed' })).toBe('confirmed')
    expect(deriveVolumeStatus({ ...v, status: 'planned' })).toBe('planned')
  })
})

describe('outlineChapterOrdinals / serializeOutlineForAI', () => {
  it('numbers chapters globally across volumes', () => {
    const map = outlineChapterOrdinals(store())
    expect(map.get('c1')).toBe(1)
    expect(map.get('c2')).toBe(2)
  })

  it('serializes a deterministic, ordered outline without notes/config noise', () => {
    const text = serializeOutlineForAI(store())
    expect(text).toContain('# Plot Outline')
    expect(text).toContain('全书总览')
    expect(text).toContain('## 1 · ·废铁砸门（第1-2章）')
    expect(text).toContain('本卷简介：陆小满的学徒日常被一块废铁打破。')
    expect(text).toContain('### 第01章｜咣当一声')
    expect(text).toContain('- 咣当一声：废铁砸在桌上。')
    expect(text).not.toContain('付费点') // 卷配置不注入 AI
    expect(text.indexOf('第01章')).toBeLessThan(text.indexOf('第02章'))
  })

  it('serializes chapter beats as bullet lines', () => {
    const ch = store().volumes[0].chapters[0]
    expect(serializeChapterBeats(ch)).toBe('- 咣当一声：废铁砸在桌上。')
    expect(serializeChapterBeats({ ...ch, beats: [] })).toBe('')
  })
})

describe('findOutlineChapter', () => {
  it('looks up chapters by id across volumes', () => {
    const s = store()
    expect(findOutlineChapter(s, 'c2')?.title).toBe('第02章｜夜半低语')
    expect(findOutlineChapter(s, 'missing')).toBeNull()
  })
})

describe('parseLegacyOutline', () => {
  const md = `## 四大大陆（四卷）大事件宏观规划

第一段宏观规划。

## 第一卷（北陆卷）

### 第一卷核心付费点分布图与商业节奏

严格锚定第1、5、10章为关键付费点。

### 第一章：穿越与惨案
*   **主要情节**：血月之夜，奥莉薇娅攻入温特城堡。
*   **本章爽点**：窒息式开局。

### 第二章：铁匠铺的学徒
- 陆小满被踹起来修锅。
- **章尾：** 废铁发出低语。
`

  it('extracts overview, volume config and chapter beats', () => {
    const parsed = parseLegacyOutline(md)
    expect(parsed.overview).toContain('四大大陆')
    expect(parsed.volumes).toHaveLength(1)
    const vol = parsed.volumes[0]
    expect(vol.title).toBe('第一卷（北陆卷）')
    // 首个章标题之前的 H3 小节并入卷简介（不再单独成为卷配置）
    expect(vol.summary).toContain('第一卷核心付费点分布图与商业节奏')
    expect(vol.summary).toContain('关键付费点')
    expect(vol.config).toBe('')
    expect(vol.chapters).toHaveLength(2)
    expect(vol.chapters[0].title).toBe('第一章：穿越与惨案')
    expect(vol.chapters[0].beats[0].title).toBe('主要情节')
    expect(vol.chapters[0].beats[0].summary).toContain('血月之夜')
    expect(vol.chapters[1].beats[1].title).toBe('章尾')
    expect(vol.chapters[1].beats[1].summary).toContain('废铁发出低语')
  })

  it('does not turn planning sections with sub-headings into volumes', () => {
    const parsed = parseLegacyOutline(
      '## 一、读者承诺\n\n正文A。\n\n### 承诺子节\n\n正文B。\n\n' +
        '## 二、六类核心爽点\n\n正文C。\n\n' +
        '## 四、逐章大纲\n\n#### 第01章｜开场\n- 事件发生。\n',
    )
    // 只有含章标题的 H2 成为卷；带子标题的规划段并入 overview
    expect(parsed.volumes).toHaveLength(1)
    expect(parsed.volumes[0].title).toBe('四、逐章大纲')
    expect(parsed.overview).toContain('一、读者承诺')
    expect(parsed.overview).toContain('承诺子节')
    expect(parsed.overview).toContain('二、六类核心爽点')
  })

  it('keeps non-chapter sub-headings inside an established volume as config text', () => {
    const parsed = parseLegacyOutline(
      '## 第一卷\n\n#### 第01章｜开场\n- 事件发生。\n\n### 本卷付费点\n\n第1、5章为关键付费点。\n',
    )
    expect(parsed.volumes).toHaveLength(1)
    expect(parsed.volumes[0].chapters).toHaveLength(1)
    // 章标题之后出现的非章 H3 小节 → 卷配置
    expect(parsed.volumes[0].config).toContain('本卷付费点')
    expect(parsed.volumes[0].config).toContain('关键付费点')
  })

  it('handles H4 chapter headings and bullets under them', () => {
    const parsed = parseLegacyOutline(
      '## 卷\n\n#### 第03章｜镜子里的人先动了\n\n- 留守骑士搜查书房。\n- 他补枪杀死骑士。\n',
    )
    expect(parsed.volumes[0].chapters[0].title).toBe('第03章｜镜子里的人先动了')
    expect(parsed.volumes[0].chapters[0].beats).toHaveLength(2)
  })

  it('keeps unparsed top-level text in overview and chapter body fallback as a single beat', () => {
    const parsed = parseLegacyOutline('## 卷\n\n### 第一章：开场\n\n一段没有 bullet 的正文。\n')
    expect(parsed.volumes[0].chapters[0].beats).toEqual([
      { title: '', summary: '一段没有 bullet 的正文。' },
    ])
  })
})

describe('outlineFromNovel / outlineFromLegacy / syncNovelFromOutline', () => {
  it('builds an outline from the novel structure with preserved ids', () => {
    const s = outlineFromNovel(meta)
    expect(s.volumes[0].id).toBe('v1')
    expect(s.volumes[0].chapters.map((c) => c.id)).toEqual(['c1', 'c2'])
    expect(s.volumes[0].chapters[0].beats).toEqual([])
  })

  it('merges a legacy plan, reusing matching chapter ids by ordinal', () => {
    const parsed = parseLegacyOutline(
      '## 第一卷\n\n### 第01章｜新标题\n- 要点：正文。\n\n### 第02章｜另一章\n- 要点：正文。\n',
    )
    const s = outlineFromLegacy(meta, parsed)
    expect(s.volumes).toHaveLength(1)
    // 第01章按序号匹配到 c1，复用 id；第02章无匹配（meta 里是「盘没有回答他」→ 序号相同 2 匹配 c2）
    expect(s.volumes[0].chapters[0].id).toBe('c1')
    expect(s.volumes[0].chapters[0].beats[0].summary).toBe('正文。')
  })

  it('syncs novel.json from the outline, preserving prose state and dropping absent entries', () => {
    const s = store()
    const synced = syncNovelFromOutline(meta, s)
    expect(synced.volumes.map((v) => v.id)).toEqual(['v1', 'v2'])
    const v1 = synced.volumes[0]
    expect(v1.title).toBe('·废铁砸门')
    const c1 = v1.chapters[0]
    expect(c1.id).toBe('c1')
    expect(c1.wordCount).toBe(100) // 正文状态保留
    expect(c1.status).toBe('done')
    expect(c1.file).toBe('v1_c1.md')
    const c2 = v1.chapters[1]
    expect(c2.id).toBe('c2')
    expect(c2.wordCount).toBe(200)
    expect(v1.chapters).toHaveLength(2)
    expect(synced.volumes[1].chapters).toEqual([])
    expect(synced.title).toBe('Star Tracker')
  })

  it('creates placeholder chapters for ids absent from novel.json', () => {
    const s: OutlineStore = {
      ...emptyOutlineStore(),
      volumes: [
        {
          id: 'v9',
          title: '新卷',
          summary: '',
          config: '',
          status: 'planning',
          chapters: [{ id: 'c9', title: '第01章｜新章', status: 'planned', beats: [] }],
        },
      ],
    }
    const synced = syncNovelFromOutline(meta, s)
    expect(synced.volumes).toHaveLength(1)
    const ch = synced.volumes[0].chapters[0]
    expect(ch.file).toBe('v9_c9.md')
    expect(ch.wordCount).toBe(0)
    expect(ch.status).toBe('draft')
  })

  it('is idempotent: syncing the synced result is a no-op', () => {
    const s = store()
    const once = syncNovelFromOutline(meta, s)
    const twice = syncNovelFromOutline(once, s)
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once))
  })
})

describe('serializeChapterOutline', () => {
  it('builds the outline layer around the chapter by id', () => {
    const text = serializeChapterOutline(store(), 'c1')
    expect(text).toContain('# Plot Outline')
    expect(text).toContain('全书总览') // overview 保留
    expect(text).toContain('·废铁砸门（第1-2章）') // 卷标题 + 全局章序区间
    expect(text).toContain('本卷简介：陆小满的学徒日常被一块废铁打破。')
    expect(text).toContain('### 第01章｜咣当一声')
    expect(text).toContain('- 咣当一声：废铁砸在桌上。') // 当前章要点全文
    expect(text).toContain('### 第02章｜夜半低语') // 相邻章标题
    expect(text).not.toContain('夜半低语：废铁夜里低语。') // 相邻章要点不注入
    expect(text).not.toContain('第1、5章为付费点') // 卷配置不注入
  })

  it('includes only chapters within the neighbor radius', () => {
    const s: OutlineStore = {
      ...emptyOutlineStore(),
      volumes: [
        {
          id: 'v1',
          title: '大卷',
          summary: '',
          config: '',
          status: 'planning',
          chapters: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({
            id: `c${n}`,
            title: `第${String(n).padStart(2, '0')}章｜章节${n}`,
            status: 'planned' as const,
            beats: [{ title: `beat${n}`, summary: `summary${n}` }],
          })),
        },
      ],
    }
    const text = serializeChapterOutline(s, 'c5', { neighborRadius: 1 })
    expect(text).toContain('### 第05章｜章节5')
    expect(text).toContain('- beat5：summary5') // 当前章要点保留
    expect(text).toContain('### 第04章｜章节4')
    expect(text).toContain('### 第06章｜章节6')
    expect(text).not.toContain('### 第03章｜章节3') // radius=1 边界外
    expect(text).not.toContain('### 第07章｜章节7')
  })

  it('clamps the radius at the volume edges', () => {
    const s = store()
    const first = serializeChapterOutline(s, 'c1', { neighborRadius: 5 })
    expect(first).toContain('### 第01章｜咣当一声')
    expect(first).toContain('### 第02章｜夜半低语')
    expect(first).not.toContain('·会走路的影城') // 其他卷不注入
  })

  it('falls back to the full serialized outline when the chapter id is unknown', () => {
    const text = serializeChapterOutline(store(), 'missing')
    expect(text).toContain('# Plot Outline')
    expect(text).toContain('·废铁砸门（第1-2章）') // 全量序列化风格
    expect(text).toContain('·会走路的影城')
  })

  it('includes the chapter-end hook beat as part of the chapter beats', () => {
    const s: OutlineStore = {
      ...emptyOutlineStore(),
      volumes: [
        {
          id: 'v1',
          title: '卷',
          summary: '',
          config: '',
          status: 'planning',
          chapters: [
            {
              id: 'c1',
              title: '第01章｜开头',
              status: 'planned',
              beats: [
                { title: '事件', summary: '发生了某事。' },
                { title: '章尾', summary: '短剑抵住后颈。' },
              ],
            },
          ],
        },
      ],
    }
    const text = serializeChapterOutline(s, 'c1')
    expect(text).toContain('- 章尾：短剑抵住后颈。')
  })
})
