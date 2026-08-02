import { describe, expect, it } from 'vitest'
import { linkifyDocRefs } from '../../src/renderer/src/lib'
import type { SettingDoc } from '../../src/shared/types'

const docs: SettingDoc[] = [
  { id: 'character/ari.md', title: 'Ari', category: '11-character', updatedAt: 1 },
  {
    id: 'geography/地理与版图设定.md',
    title: '地理与版图设定',
    category: '04-geography',
    updatedAt: 1,
  },
  { id: 'worldview/魔法体系.md', title: '魔法体系', category: '01-worldview', updatedAt: 1 },
]

describe('linkifyDocRefs', () => {
  it('turns [[docId]] into a wikilink anchored to the document title', () => {
    const out = linkifyDocRefs('- 🔴 Name drift [[character/ari.md]]', docs)
    expect(out).toContain('<a class="wikilink" data-wikilink="character/ari.md">Ari</a>')
  })

  it('handles [docId] single-bracket and Chinese filenames', () => {
    const out = linkifyDocRefs('- 🔴 地名错误 [geography/地理与版图设定.md]', docs)
    expect(out).toContain(
      '<a class="wikilink" data-wikilink="geography/地理与版图设定.md">地理与版图设定</a>',
    )
  })

  it('handles (docs: a.md, b.md) multi-doc form', () => {
    const out = linkifyDocRefs('- 🔴 矛盾 (docs: worldview/魔法体系.md, character/ari.md)', docs)
    expect(out).toContain('data-wikilink="worldview/魔法体系.md">魔法体系</a>')
    expect(out).toContain('data-wikilink="character/ari.md">Ari</a>')
    expect(out).not.toContain('(docs:')
  })

  it('falls back to the id as label for unknown docs and leaves plain text alone', () => {
    const out = linkifyDocRefs('- 🟢 note [[ghost/ghost.md]] and plain text', docs)
    expect(out).toContain('data-wikilink="ghost/ghost.md">ghost/ghost.md</a>')
    expect(out).toContain('plain text')
  })
})
