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

export {
  addExternalMapping,
  createSetting,
  deleteSetting,
  listSettings,
  readExternalMappings,
  readSetting,
  removeExternalMapping,
  writeSetting,
} from './store/codex'
export { getConfig, saveConfig } from './store/config'
export { collectWorldFiles, exportEpub, exportWikiHtml } from './store/exports'
export { writeForgeRunFile } from './store/forge-run'
export {
  createGenerationRun,
  listGenerationRuns,
  pruneGenerationRuns,
  readGenerationRun,
  saveGenerationAuthorResult,
  saveGenerationStage,
  selectGenerationResult,
} from './store/generation-runs'
export { listSnapshots, readSnapshot, readWorldFile, restoreSnapshot } from './store/history'
export { readChapter, searchManuscriptProse, writeChapter } from './store/manuscript'
export {
  collectOutlineFiles,
  readOutline,
  readOutlineStore,
  writeOutlineStore,
} from './store/outline'
export {
  deleteCharacterChat,
  deleteConsistencyReport,
  deleteDiscussion,
  listCharacterChats,
  listConsistencyReports,
  listDiscussions,
  readReviewQueue,
  saveCharacterChat,
  saveConsistencyReport,
  saveDiscussion,
  writeReviewQueue,
} from './store/records'
export {
  deleteChapterSummary,
  listChapterSummaries,
  listStoryMemoryBackups,
  mergeStoryMemory,
  readStoryMemory,
  readStoryState,
  restoreStoryMemoryBackup,
  writeChapterSummary,
  writeStoryMemory,
  writeStoryState,
} from './store/story'
export { listTimelineEvents, saveTimelineEvents } from './store/timeline'
export { readExemplars, readVoiceProfile, writeExemplars, writeVoiceProfile } from './store/voice'
export {
  bootstrap,
  createBlankWorld,
  createWorldWithData,
  deleteWorld,
  getCurrentWorldId,
  getNovelMeta,
  listWorlds,
  saveNovelMeta,
  switchWorld,
  updateWorldMeta,
} from './store/worlds'
