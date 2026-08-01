import { describe, expect, it } from 'vitest'
import { buildSceneCardContext } from '../../src/shared/sceneCard'
import type { SceneCard, SettingDoc, TimelineEvent } from '../../src/shared/types'

const scene: SceneCard = {
  pov: 'Mira',
  dateLabel: 'Year 1240, First Moon',
  locationId: 'geography/harbor.md',
  participantIds: ['character/mira.md', 'character/ren.md'],
  purpose: 'Secure passage before dawn.',
  conflict: 'Ren refuses to leave his crew.',
  unresolvedThreads: ['Who sabotaged the ship?'],
  writingTarget: 'End with the bell tower collapsing.',
  timelineEventId: 'evt-departure',
}

const settings: SettingDoc[] = [
  { id: 'geography/harbor.md', title: 'Ash Harbor', category: 'geography', updatedAt: 1 },
  { id: 'character/mira.md', title: 'Mira', category: 'character', updatedAt: 1 },
  { id: 'character/ren.md', title: 'Ren', category: 'character', updatedAt: 1 },
]

const events: TimelineEvent[] = [
  {
    id: 'evt-departure',
    title: 'The midnight departure',
    dateLabel: 'Year 1240',
    dateOrder: 1240,
    description: '',
    docRefs: [],
  },
]

describe('Scene card context', () => {
  it('returns no context for an absent scene card', () => {
    expect(buildSceneCardContext(undefined, settings, events)).toBe('')
  })

  it('resolves linked codex documents and timeline events', () => {
    const context = buildSceneCardContext(scene, settings, events)

    expect(context).toContain('## Scene card')
    expect(context).toContain('POV: Mira')
    expect(context).toContain('Location: Ash Harbor')
    expect(context).toContain('Participants: Mira, Ren')
    expect(context).toContain('Timeline event: The midnight departure')
    expect(context).toContain('Open threads: Who sabotaged the ship?')
  })
})
