import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  ensureWorldSkeleton,
  initPaths,
  outlineDir,
  outlineJsonFile,
  setCurrentWorldId,
} from '../../src/server/paths'
import {
  collectOutlineFiles,
  readOutline,
  readOutlineStore,
  writeOutlineStore,
} from '../../src/server/store'
import { saveNovelMeta } from '../../src/server/store'
import type { NovelMeta } from '../../src/shared/types'

let dataRoot = ''
const worldId = 'w_test'

const novel: NovelMeta = {
  title: 'Untitled Manuscript',
  author: '',
  synopsis: '',
  tags: [],
  volumes: [
    {
      id: 'v1',
      title: '第1卷',
      order: 0,
      chapters: [
        {
          id: 'c1',
          volumeId: 'v1',
          title: '第01章｜血月下的第二次心跳',
          order: 0,
          file: 'v1_c1.md',
          wordCount: 120,
          status: 'done',
          updatedAt: 1,
        },
      ],
    },
  ],
}

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
  rmSync(outlineDir(), { recursive: true, force: true })
  ensureWorldSkeleton(worldId)
  writeFileSync(join(currentWorldDirSafe(), 'novel.json'), JSON.stringify(novel, null, 2))
  writeFileSync(join(currentWorldDirSafe(), 'chapters', 'v1_c1.md'), '# 第01章\n\n正文。')
})

function currentWorldDirSafe(): string {
  // 测试里直接拼数据根下的世界目录
  return join(dataRoot, 'worlds', worldId)
}

describe('structured outline store', () => {
  it('builds the store from the existing novel.json structure on first read', () => {
    const store = readOutlineStore()
    expect(store.volumes).toHaveLength(1)
    expect(store.volumes[0].id).toBe('v1')
    expect(store.volumes[0].chapters[0].id).toBe('c1')
    expect(store.volumes[0].chapters[0].beats).toEqual([])
    // 迁移后落盘 outline.json
    expect(existsSync(outlineJsonFile())).toBe(true)
  })

  it('persists and re-syncs novel.json from the outline (id-keyed)', () => {
    const store = readOutlineStore()
    store.volumes[0].title = '·废铁砸门'
    store.volumes[0].chapters[0].beats = [{ title: '咣当一声', summary: '废铁砸在桌上。' }]
    store.volumes.push({
      id: 'v2',
      title: '·会走路的影城',
      summary: '',
      config: '',
      status: 'planned',
      chapters: [{ id: 'c2', title: '第01章｜钟楼指针', status: 'planned', beats: [] }],
    })
    const synced = writeOutlineStore(store)

    expect(synced.volumes.map((v) => v.id)).toEqual(['v1', 'v2'])
    expect(synced.volumes[0].title).toBe('·废铁砸门')
    // 已有章保留正文状态
    expect(synced.volumes[0].chapters[0].wordCount).toBe(120)
    expect(synced.volumes[0].chapters[0].status).toBe('done')
    // 新章建占位正文文件（幂等文件名）
    expect(synced.volumes[1].chapters[0].file).toBe('v2_c2.md')
    expect(existsSync(join(currentWorldDirSafe(), 'chapters', 'v2_c2.md'))).toBe(true)

    // 落盘后再次读取一致
    const reloaded = readOutlineStore()
    expect(reloaded.volumes[0].chapters[0].beats[0].title).toBe('咣当一声')
  })

  it('drops volumes absent from the outline on sync', () => {
    const store = readOutlineStore()
    store.volumes = store.volumes.filter((v) => v.id !== 'v1')
    const synced = writeOutlineStore(store)
    expect(synced.volumes).toEqual([])
  })

  it('readOutline returns the derived AI text, not the raw store', () => {
    const store = readOutlineStore()
    store.overview = '全书总览内容'
    store.volumes[0].chapters[0].beats = [{ title: '咣当一声', summary: '废铁砸在桌上。' }]
    writeOutlineStore(store)
    const text = readOutline()
    expect(text).toContain('# Plot Outline')
    expect(text).toContain('全书总览内容')
    expect(text).toContain('### 第01章｜血月下的第二次心跳')
    expect(text).toContain('- 咣当一声：废铁砸在桌上。')
    // 备注与卷配置不注入
    expect(text).not.toContain('notes')
  })

  it('migrates legacy outline/*.md files into the store on first read', () => {
    rmSync(outlineJsonFile(), { force: true })
    writeFileSync(
      join(outlineDir(), '01-总纲.md'),
      '## 第一卷\n\n### 第01章｜血月下的第二次心跳\n- 要点：奥莉薇娅攻入城堡。\n',
    )
    const store = readOutlineStore()
    // 按序号匹配到已有章 c1，复用 id 并挂上要点
    expect(store.volumes[0].chapters[0].id).toBe('c1')
    expect(store.volumes[0].chapters[0].beats[0].summary).toBe('奥莉薇娅攻入城堡。')
  })

  it('collectOutlineFiles exports outline.json plus the derived outline.md', () => {
    const store = readOutlineStore()
    writeOutlineStore(store)
    const { name, files } = collectOutlineFiles()
    expect(name).toBe('Untitled Manuscript')
    const paths = files.map((f) => f.path)
    expect(paths).toContain('outline/outline.json')
    expect(paths).toContain('outline/outline.md')
    const json = JSON.parse(
      files.find((f) => f.path === 'outline/outline.json')!.content.toString('utf-8'),
    )
    expect(json.version).toBe(1)
    const md = files.find((f) => f.path === 'outline/outline.md')!.content.toString('utf-8')
    expect(md).toContain('# Plot Outline')
  })

  it('saveNovelMeta still works after the structure moved to the outline', async () => {
    // 保持既有行为：novel.json 顶层字段可由其它视图保存
    await saveNovelMeta({ ...novel, title: 'Renamed' })
    const meta = JSON.parse(
      readFileSync(join(currentWorldDirSafe(), 'novel.json'), 'utf-8'),
    ) as NovelMeta
    expect(meta.title).toBe('Renamed')
  })
})
