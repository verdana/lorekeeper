/**
 * The durable-fact kinds a memory can be, in the order the review list shows
 * them. The stored type is the source of truth; this only adds display labels.
 */

import type { StoryMemoryKind } from '@shared/types'

export const KINDS: Array<{ id: StoryMemoryKind; label: string }> = [
  { id: 'character-state', label: 'Character state' },
  { id: 'relationship', label: 'Relationship' },
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'location', label: 'Location' },
  { id: 'object', label: 'Object' },
  { id: 'world-state', label: 'World state' },
  { id: 'open-thread', label: 'Open thread' },
]
