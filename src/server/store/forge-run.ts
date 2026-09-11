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
 * The Novel Forge run record.
 *
 * The forge engine owns the shape of this file and normalizes it on read, so the
 * store only provides the atomic write that keeps a crash from leaving a
 * half-written run behind.
 */

import { forgeDir, forgeRunFile } from '../paths'
import { atomicWrite, ensureDir } from './core'

// ---- Novel Forge（整书自动创作流水线的运行状态）----

/**
 * Persist the forge run record.
 *
 * The forge engine owns the shape of this file and normalizes it on read, so
 * the store only provides the atomic write (temp file + fsync + rename) that
 * keeps a crash from leaving a half-written run behind.
 */
export function writeForgeRunFile(content: string): void {
  ensureDir(forgeDir())
  atomicWrite(forgeRunFile(), content)
}
