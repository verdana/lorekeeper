import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  characterChatsDir,
  discussionsDir,
  ensureDir,
  ensureWorldSkeleton,
  initPaths,
  setCurrentWorldId,
  snapshotsDir,
  worldsFile,
  currentWorldDir,
} from '../../src/server/paths'
import {
  collectWorldFiles,
  deleteCharacterChat,
  deleteDiscussion,
  listSnapshots,
  readSnapshot,
  readWorldFile,
  restoreSnapshot,
  saveCharacterChat,
  saveDiscussion,
  saveNovelMeta,
  saveTimelineEvents,
  writeOutline,
  writeReviewQueue,
  writeVoiceProfile,
} from '../../src/server/store'
import { DEFAULT_NOVEL_META } from '../../src/server/defaults'
import type {
  CharacterChatSession,
  DiscussionSession,
  ReviewQueueStore,
  TimelineEvent,
  VoiceProfile,
} from '../../src/shared/types'

let dataRoot = ''
const worldId = 'w_test'

const novelMeta = (title: string): typeof DEFAULT_NOVEL_META => ({
  ...DEFAULT_NOVEL_META,
  title,
})

const timelineEvents = (n: number): TimelineEvent[] => [
  {
    id: `evt_${n}`,
    title: `Event ${n}`,
    dateLabel: `Year ${n}`,
    dateOrder: n,
    description: `Description ${n}`,
    docRefs: [],
  },
]

const voiceProfile = (note: string): VoiceProfile => ({
  generatedAt: Date.now(),
  sampleChapterIds: ['ch1'],
  traits: {
    sentenceLength: '12-25 words',
    verbStyle: 'concrete',
    narrativeDistance: 'close third',
    dialogueStyle: 'terse',
    rhetoricalPatterns: 'none',
    proseNotes: note,
  },
})

const discussion = (id: string, topic: string): DiscussionSession => ({
  id,
  topic,
  personaIds: ['p1'],
  rounds: 1,
  messages: [
    {
      id: 'm1',
      personaId: 'moderator',
      personaName: 'Moderator',
      content: 'conclusion text',
      round: 0,
      ts: 1,
    },
  ],
  conclusion: 'conclusion text',
  createdAt: Date.now(),
})

const characterChat = (characterId: string, title: string): CharacterChatSession => ({
  id: `chat_${characterId}`,
  characterId,
  characterTitle: title,
  messages: [{ id: 'm1', role: 'user', content: 'hello', ts: 1 }],
  createdAt: Date.now(),
  updatedAt: Date.now(),
})

const emptyQueue = (): ReviewQueueStore => ({ version: 1, items: [] })

const snapshotKeys = (): string[] => listSnapshots().map((s) => s.sourcePath)

beforeAll(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'lorekeeper-snapshots-'))
  process.env.ORBIT_DATA_DIR = dataRoot
  initPaths()
  ensureWorldSkeleton(worldId)
  setCurrentWorldId(worldId)
})

afterAll(() => {
  vi.useRealTimers()
  rmSync(dataRoot, { recursive: true, force: true })
})

beforeEach(() => {
  vi.useRealTimers()
  // Reset the world dir contents (keeps the skeleton), including snapshots.
  const base = currentWorldDir()
  for (const name of ['novel.json', 'timeline.json', 'voice-profile.json', 'review-queue.json']) {
    const f = join(base, name)
    if (existsSync(f)) rmSync(f)
  }
  for (const name of ['discussions', 'character-chats']) {
    const d = join(base, name)
    if (existsSync(d)) rmSync(d, { recursive: true, force: true })
  }
  const snap = snapshotsDir()
  if (existsSync(snap)) rmSync(snap, { recursive: true, force: true })
  ensureDir(discussionsDir())
  ensureDir(characterChatsDir())
})

describe('snapshot coverage for world data', () => {
  it('snapshots novel.json on saveNovelMeta', () => {
    saveNovelMeta(novelMeta('v1'))
    saveNovelMeta(novelMeta('v2')) // 第二次写入前给 v1 留底
    expect(snapshotKeys()).toContain('novel.json')
    const entries = listSnapshots().filter((s) => s.sourcePath === 'novel.json')
    expect(entries).toHaveLength(1)
    expect(readSnapshot(entries[0].id)).toContain('"title": "v1"')
  })

  it('snapshots timeline.json on saveTimelineEvents', () => {
    saveTimelineEvents(timelineEvents(1))
    saveTimelineEvents(timelineEvents(2))
    const entries = listSnapshots().filter((s) => s.sourcePath === 'timeline.json')
    expect(entries).toHaveLength(1)
    expect(readSnapshot(entries[0].id)).toContain('Event 1')
  })

  it('snapshots voice-profile.json on writeVoiceProfile', () => {
    writeVoiceProfile(voiceProfile('note-a'))
    writeVoiceProfile(voiceProfile('note-b'))
    const entries = listSnapshots().filter((s) => s.sourcePath === 'voice-profile.json')
    expect(entries).toHaveLength(1)
    expect(readSnapshot(entries[0].id)).toContain('note-a')
  })

  it('snapshots review-queue.json on writeReviewQueue', () => {
    writeReviewQueue(emptyQueue())
    writeReviewQueue({ version: 1, items: [] })
    expect(snapshotKeys()).toContain('review-queue.json')
  })

  it('snapshots discussion files on save and on delete', () => {
    saveDiscussion(discussion('d1', 'Topic A'))
    saveDiscussion(discussion('d1', 'Topic A updated'))
    const entries = listSnapshots().filter((s) => s.sourcePath === 'discussions/d1.json')
    expect(entries).toHaveLength(1)
    expect(readSnapshot(entries[0].id)).toContain('Topic A')

    // 删除前留底：删除后快照仍可恢复
    deleteDiscussion('d1')
    const afterDelete = listSnapshots().filter((s) => s.sourcePath === 'discussions/d1.json')
    expect(afterDelete.length).toBeGreaterThan(0)
  })

  it('snapshots character chat files on save and on delete', () => {
    saveCharacterChat(characterChat('c1', 'Aria'))
    saveCharacterChat(characterChat('c1', 'Aria updated'))
    const entries = listSnapshots().filter((s) => s.sourcePath === 'character-chats/c1.json')
    expect(entries).toHaveLength(1)
    expect(readSnapshot(entries[0].id)).toContain('Aria')

    deleteCharacterChat('c1')
    const afterDelete = listSnapshots().filter((s) => s.sourcePath === 'character-chats/c1.json')
    expect(afterDelete.length).toBeGreaterThan(0)
  })

  it('snapshots the legacy single-file outline', () => {
    writeOutline('# v1')
    writeOutline('# v2')
    const entries = listSnapshots().filter((s) => s.sourcePath === 'outline/outline.md')
    expect(entries).toHaveLength(1)
    expect(readSnapshot(entries[0].id)).toContain('# v1')
  })

  it('does not snapshot files outside the whitelist (worlds.json side effect)', () => {
    saveNovelMeta(novelMeta('v1'))
    saveNovelMeta(novelMeta('v2')) // saveNovelMeta 双源同步也会写 worlds.json
    const keys = snapshotKeys()
    expect(keys).toContain('novel.json')
    expect(keys.some((k) => k === 'worlds.json' || k.startsWith('worlds'))).toBe(false)
  })

  it('throttles consecutive saves within 3 minutes', () => {
    saveTimelineEvents(timelineEvents(1))
    saveTimelineEvents(timelineEvents(2))
    saveTimelineEvents(timelineEvents(3)) // 3 分钟内第三次保存 → 节流，不再留底
    const entries = listSnapshots().filter((s) => s.sourcePath === 'timeline.json')
    expect(entries).toHaveLength(1)
  })
})

describe('snapshot restore round-trip', () => {
  it('restores timeline.json to the snapshotted version', () => {
    saveTimelineEvents(timelineEvents(1))
    saveTimelineEvents(timelineEvents(2))
    const entry = listSnapshots().find((s) => s.sourcePath === 'timeline.json')!
    restoreSnapshot(entry.id)
    const current = JSON.parse(readFileSync(join(currentWorldDir(), 'timeline.json'), 'utf-8'))
    expect(current[0].title).toBe('Event 1')
  })

  it('leaves a new snapshot of the current version before restoring (undoable)', () => {
    saveTimelineEvents(timelineEvents(1))
    saveTimelineEvents(timelineEvents(2))
    const before = listSnapshots().filter((s) => s.sourcePath === 'timeline.json').length
    const entry = listSnapshots().find((s) => s.sourcePath === 'timeline.json')!
    restoreSnapshot(entry.id)
    const after = listSnapshots().filter((s) => s.sourcePath === 'timeline.json')
    expect(after.length).toBe(before + 1)
    // 新留底是 restore 前的当前版（Event 2），因此恢复动作本身可反悔
    expect(after.some((s) => readSnapshot(s.id).includes('Event 2'))).toBe(true)
  })

  it('re-syncs worlds.json title/genre after restoring a novel snapshot', () => {
    // worlds.json 是 store 私有读写，直接经 fs 注册/断言
    writeFileSync(
      worldsFile(),
      JSON.stringify([
        {
          id: worldId,
          title: 'Old',
          genre: '',
          coverColor: '#B8642E',
          createdAt: 1,
          lastOpenedAt: 1,
        },
      ]),
    )
    saveNovelMeta(novelMeta('v1')) // 双源同步 → worlds.json title 'v1'
    saveNovelMeta(novelMeta('v2')) // novel.json 的 v1 被快照
    const readWorldsTitle = (): string | undefined =>
      (JSON.parse(readFileSync(worldsFile(), 'utf-8')) as { id: string; title: string }[]).find(
        (w) => w.id === worldId,
      )?.title
    expect(readWorldsTitle()).toBe('v2')
    const entry = listSnapshots().find((s) => s.sourcePath === 'novel.json')!
    restoreSnapshot(entry.id) // novel.json → v1，worlds.json 镜像应同步为 'v1'
    expect(readWorldsTitle()).toBe('v1')
  })
})

describe('snapshot rolling window', () => {
  it('keeps only the most recent 15 snapshots per file', () => {
    vi.useFakeTimers()
    const base = new Date('2026-08-04T00:00:00Z').getTime()
    vi.setSystemTime(base)
    // 第一次写入无旧版可留底；之后每次前进 4 分钟（越过 3 分钟节流）
    for (let i = 1; i <= 17; i++) {
      saveTimelineEvents(timelineEvents(i))
      vi.setSystemTime(base + i * 4 * 60_000)
    }
    const entries = listSnapshots().filter((s) => s.sourcePath === 'timeline.json')
    expect(entries).toHaveLength(15)
    // 最早那份（i=2 写入前，Event 1 内容）被滚动清理；保留 Event 2..16 的旧版。
    // 用 JSON 字段精确匹配，避免 "Event 16".includes("Event 1") 误报。
    expect(entries.some((s) => readSnapshot(s.id).includes('"title": "Event 1"'))).toBe(false)
    expect(entries.some((s) => readSnapshot(s.id).includes('"title": "Event 16"'))).toBe(true)
  })
})

describe('snapshot describeSource mapping', () => {
  it('labels each data kind correctly', () => {
    saveNovelMeta(novelMeta('v1'))
    saveNovelMeta(novelMeta('v2'))
    saveTimelineEvents(timelineEvents(1))
    saveTimelineEvents(timelineEvents(2))
    writeVoiceProfile(voiceProfile('a'))
    writeVoiceProfile(voiceProfile('b'))
    saveDiscussion(discussion('d1', 'Topic A'))
    saveDiscussion(discussion('d1', 'Topic A2'))
    saveCharacterChat(characterChat('c1', 'Aria'))
    saveCharacterChat(characterChat('c1', 'Aria2'))
    writeReviewQueue(emptyQueue())
    writeReviewQueue(emptyQueue())
    writeOutline('# v1')
    writeOutline('# v2')

    const byPath = new Map(listSnapshots().map((s) => [s.sourcePath, s]))
    expect(byPath.get('novel.json')?.kind).toBe('novel')
    expect(byPath.get('novel.json')?.label).toBe('Novel Metadata')
    expect(byPath.get('timeline.json')?.kind).toBe('timeline')
    expect(byPath.get('timeline.json')?.label).toBe('Timeline')
    expect(byPath.get('voice-profile.json')?.kind).toBe('voice')
    expect(byPath.get('voice-profile.json')?.label).toBe('Voice Profile')
    expect(byPath.get('review-queue.json')?.kind).toBe('reviewQueue')
    expect(byPath.get('review-queue.json')?.label).toBe('Review Queue')
    expect(byPath.get('discussions/d1.json')?.kind).toBe('discussion')
    // label 来自当前文件（describeSource 读 live 文件），非快照内容
    expect(byPath.get('discussions/d1.json')?.label).toBe('Topic A2')
    expect(byPath.get('character-chats/c1.json')?.kind).toBe('characterChat')
    expect(byPath.get('character-chats/c1.json')?.label).toBe('Aria2')
    expect(byPath.get('outline/outline.md')?.kind).toBe('outline')
    expect(byPath.get('outline/outline.md')?.label).toBe('Outline')
  })
})

describe('world export and readWorldFile', () => {
  it('excludes .snapshots from world export', () => {
    saveTimelineEvents(timelineEvents(1))
    saveTimelineEvents(timelineEvents(2))
    const { files } = collectWorldFiles()
    expect(files.some((f) => f.path.includes('.snapshots'))).toBe(false)
    expect(files.some((f) => f.path === 'timeline.json')).toBe(true)
  })

  it('readWorldFile reads the current file content', () => {
    saveTimelineEvents(timelineEvents(1))
    expect(readWorldFile('timeline.json')).toContain('Event 1')
    expect(readWorldFile('no-such-file.json')).toBe('')
  })

  it('readWorldFile refuses path traversal', () => {
    expect(() => readWorldFile('../outside.json')).toThrow()
    expect(() => readWorldFile('timeline.json/../../worlds.json')).toThrow()
  })
})
