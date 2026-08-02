import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  characterChatsDir,
  ensureWorldSkeleton,
  initPaths,
  setCurrentWorldId,
} from '../../src/server/paths'
import { deleteCharacterChat, listCharacterChats, saveCharacterChat } from '../../src/server/store'
import type { CharacterChatSession } from '../../src/shared/types'

let dataRoot = ''
const worldId = 'w_test'

const session = (id: string, characterId: string, ts: number): CharacterChatSession => ({
  id,
  characterId,
  characterTitle: 'Ari',
  messages: [
    { id: 'm1', role: 'user', content: 'Why do you fear the sea?', ts },
    { id: 'm2', role: 'character', content: 'Because it took my brother.', ts },
  ],
  createdAt: ts,
  updatedAt: ts,
})

beforeAll(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'lorekeeper-character-chats-'))
  process.env.ORBIT_DATA_DIR = dataRoot
  initPaths()
  ensureWorldSkeleton(worldId)
  setCurrentWorldId(worldId)
})

afterAll(() => {
  rmSync(dataRoot, { recursive: true, force: true })
})

beforeEach(() => {
  for (const f of readdirSync(characterChatsDir())) {
    rmSync(join(characterChatsDir(), f), { force: true })
  }
})

describe('character chat persistence', () => {
  it('saves and lists sessions newest first', () => {
    saveCharacterChat(session('cc_a', 'character/ari.md', 100))
    saveCharacterChat(session('cc_b', 'character/kai.md', 200))
    const list = listCharacterChats()
    expect(list.map((s) => s.id)).toEqual(['cc_b', 'cc_a'])
    expect(
      existsSync(join(characterChatsDir(), `${encodeURIComponent('character/ari.md')}.json`)),
    ).toBe(true)
  })

  it('is idempotent per character: re-saving overwrites the same file', () => {
    saveCharacterChat(session('cc_a', 'character/ari.md', 100))
    saveCharacterChat({ ...session('cc_b', 'character/ari.md', 300), characterTitle: 'Ari (v2)' })
    const list = listCharacterChats()
    expect(list.length).toBe(1)
    expect(list[0].characterTitle).toBe('Ari (v2)')
    expect(list[0].updatedAt).toBe(300)
    // 同一角色只留一个文件。
    const files = readdirSync(characterChatsDir()).filter((f) => f.endsWith('.json'))
    expect(files.length).toBe(1)
  })

  it('deletes a session by character id', () => {
    saveCharacterChat(session('cc_a', 'character/ari.md', 100))
    deleteCharacterChat('character/ari.md')
    expect(listCharacterChats()).toEqual([])
    expect(
      existsSync(join(characterChatsDir(), `${encodeURIComponent('character/ari.md')}.json`)),
    ).toBe(false)
  })

  it('ignores non-JSON and corrupt files', () => {
    writeFileSync(join(characterChatsDir(), 'notes.txt'), 'x')
    writeFileSync(join(characterChatsDir(), 'broken.json'), '{oops')
    saveCharacterChat(session('cc_a', 'character/ari.md', 100))
    expect(listCharacterChats().length).toBe(1)
  })

  it('recreates the directory when missing (legacy world)', () => {
    rmSync(characterChatsDir(), { recursive: true, force: true })
    saveCharacterChat(session('cc_a', 'character/ari.md', 100))
    expect(existsSync(characterChatsDir())).toBe(true)
    expect(
      existsSync(join(characterChatsDir(), `${encodeURIComponent('character/ari.md')}.json`)),
    ).toBe(true)
  })
})
