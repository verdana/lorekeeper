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
 * Author voice data: the analysed Voice Profile and the style exemplars the
 * writing prompts imitate.
 */

import type { ExemplarStore, VoiceProfile } from '../../shared/types'
import { currentWorldDir, exemplarsFile } from '../paths'
import { assertWritable, readJSON, snapshot, writeJSON } from './core'
import { existsSync } from 'fs'
import { join } from 'path'

// ---- Voice profile ----

const voiceProfileFile = (): string => join(currentWorldDir(), 'voice-profile.json')

export function readVoiceProfile(): VoiceProfile | null {
  const f = voiceProfileFile()
  return existsSync(f) ? readJSON<VoiceProfile | null>(f, null) : null
}

export function writeVoiceProfile(profile: VoiceProfile): void {
  snapshot(voiceProfileFile())
  writeJSON(voiceProfileFile(), profile)
}

// ---- 文风范例（exemplars，按世界存储）----

const DEFAULT_EXEMPLARS: ExemplarStore = { version: 1, texts: [] }

export function readExemplars(): ExemplarStore {
  const f = exemplarsFile()
  if (!existsSync(f)) return { version: 1, texts: [] }
  const store = readJSON<ExemplarStore>(f, DEFAULT_EXEMPLARS)
  // 防御：损坏/缺字段时回退到空列表，绝不阻塞写作面板。
  if (!store || !Array.isArray(store.texts)) return { version: 1, texts: [] }
  return { version: 1, texts: store.texts.filter((t) => typeof t === 'string') }
}

export function writeExemplars(store: ExemplarStore): void {
  assertWritable(exemplarsFile(), 'Style exemplars')
  snapshot(exemplarsFile())
  writeJSON(exemplarsFile(), { version: 1, texts: store.texts.filter((t) => t.trim()) })
}
