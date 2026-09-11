/**
 * World store — every persisted file of a world, addressed through one module.
 *
 * Layout note: the data layer is split by domain, each module owning one kind of
 * file and importing the shared infrastructure from `./core`. `store.ts` is the
 * facade the RPC layer and the tests import, so callers see one module while the
 * implementation stays navigable:
 *
 *   core              atomic write, snapshot, damaged-file guards, safe paths
 *   worlds            the world index, world lifecycle, novel metadata
 *   config            app config (providers, personas, prompts) + API keys
 *   codex             codex documents and read-only external folder mappings
 *   manuscript        chapter files and manuscript prose search
 *   generation-runs   generation evidence
 *   history           version snapshots
 *   timeline          world events
 *   story             Story Memory, chapter summaries, the story-state archive
 *   outline           the structured outline (structure's source of truth)
 *   records           discussions, consistency reports, character chats, review queue
 *   voice             Voice Profile and style exemplars
 *   exports           whole-world zip, static codex wiki, epub
 *   forge-run         the Novel Forge run record (shape owned by the engine)
 *
 * Two rules hold across all of them: writes go through `atomicWrite` (temp file
 * → fsync → rename) and anything overwritten is snapshotted first, so a crash or
 * a bad AI response never costs the author unrecoverable text.
 */
/**
 * World events, ordered by their numeric sort key.
 */

import type { TimelineEvent } from '../../shared/types'
import { currentWorldDir } from '../paths'
import { assertWritable, readJSON, snapshot, writeJSON } from './core'
import { join } from 'path'

// ---- 时间线 ----
const timelineFile = (): string => join(currentWorldDir(), 'timeline.json')

export function listTimelineEvents(): TimelineEvent[] {
  try {
    return readJSON<TimelineEvent[]>(timelineFile(), [])
  } catch {
    return []
  }
}

export function saveTimelineEvents(events: TimelineEvent[]): void {
  assertWritable(timelineFile(), 'The timeline')
  snapshot(timelineFile())
  writeJSON(timelineFile(), events)
}
