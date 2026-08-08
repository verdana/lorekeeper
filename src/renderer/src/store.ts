import { create } from 'zustand'
import type { AppConfig, NovelMeta, SettingDoc, VoiceProfile, WorldMeta } from '@shared/types'
import type { BatchWriteDeps, BatchWriteTask } from './batchWrite'
import { deleteEmptyChapter, resumeBatch, runBatchWrite } from './batchWrite'

export type ViewKey =
  | 'dashboard'
  | 'settings-docs'
  | 'characters'
  | 'timeline'
  | 'story-memory'
  | 'graph'
  | 'chapters'
  | 'discussion'
  | 'consistency'
  | 'review-queue'
  | 'history'
  | 'outline'
  | 'voice-profile'
  | 'preferences'
  | 'character-chat'

interface AppState {
  view: ViewKey
  setView: (v: ViewKey) => void
  storyMemoryFocusChapterId: string | null
  openStoryMemory: (chapterId?: string) => void
  chapterFocusId: string | null
  openChapter: (chapterId: string) => void
  clearChapterFocus: () => void
  settingFocusId: string | null
  openSetting: (settingId: string) => void
  clearSettingFocus: () => void
  timelineFocusId: string | null
  openTimelineEvent: (eventId: string) => void
  clearTimelineFocus: () => void
  discussionFocusId: string | null
  openDiscussion: (sessionId: string) => void
  clearDiscussionFocus: () => void
  snapshotFocusId: string | null
  openSnapshot: (snapshotId: string) => void
  clearSnapshotFocus: () => void

  // 多世界：入口页 / 世界列表 / 切换态
  atWorldGate: boolean
  worlds: WorldMeta[]
  currentWorldId: string | null
  switching: boolean
  enterWorldGate: () => void
  loadWorlds: () => Promise<void>
  enterWorld: (id: string) => Promise<void>

  novel: NovelMeta | null
  config: AppConfig | null
  settingDocs: SettingDoc[]

  loadAll: () => Promise<void>
  refreshSettings: () => Promise<void>
  refreshNovel: () => Promise<void>
  saveNovel: (meta: NovelMeta) => Promise<void>
  voiceProfile: VoiceProfile | null
  loadVoiceProfile: () => Promise<void>
  saveVoiceProfile: (profile: VoiceProfile) => Promise<void>
  saveConfig: (cfg: AppConfig) => Promise<void>

  // 批量写作（batch write）全局任务
  batchWriteTask: BatchWriteTask | null
  batchWriteAbort: AbortController | null
  batchWriteDeps: BatchWriteDeps | null
  startBatchWrite: (deps: BatchWriteDeps, task: BatchWriteTask) => void
  stopBatchWrite: () => void
  /** Resume a paused batch (attention/stopped) from the first recoverable chapter. */
  resumeBatchWrite: (startIndex: number) => void
  /** Delete one empty pre-created chapter (server-validated). */
  deleteBatchChapter: (chapterId: string) => Promise<void>
  /** Dismiss a finished task (terminal states only); disk artifacts stay for manual handling. */
  clearBatchTask: () => void
}

/**
 * Shared write-mutex selector: the batch owns the current world's chapter/
 * NovelMeta writes while a run is active (including paused attention/stopped,
 * which still guard the frozen targets until the user resumes/deletes/dismisses).
 * Never true for other worlds, so a run does not block other-world editing.
 */
export function isBatchWriteLocked(
  state: Pick<AppState, 'batchWriteTask' | 'currentWorldId'>,
): boolean {
  const task = state.batchWriteTask
  if (!task) return false
  if (task.worldId !== state.currentWorldId) return false
  return (
    task.status === 'preparing' ||
    task.status === 'running' ||
    task.status === 'retrying' ||
    task.status === 'attention' ||
    task.status === 'stopped'
  )
}

export const useStore = create<AppState>((set, get) => ({
  view: 'dashboard',
  setView: (v) => set({ view: v }),
  storyMemoryFocusChapterId: null,
  openStoryMemory: (chapterId) =>
    set({ view: 'story-memory', storyMemoryFocusChapterId: chapterId ?? null }),
  chapterFocusId: null,
  openChapter: (chapterId) => set({ view: 'chapters', chapterFocusId: chapterId }),
  clearChapterFocus: () => set({ chapterFocusId: null }),
  settingFocusId: null,
  openSetting: (settingId) => set({ view: 'settings-docs', settingFocusId: settingId }),
  clearSettingFocus: () => set({ settingFocusId: null }),
  timelineFocusId: null,
  openTimelineEvent: (eventId) => set({ view: 'timeline', timelineFocusId: eventId }),
  clearTimelineFocus: () => set({ timelineFocusId: null }),
  discussionFocusId: null,
  openDiscussion: (sessionId) => set({ view: 'discussion', discussionFocusId: sessionId }),
  clearDiscussionFocus: () => set({ discussionFocusId: null }),
  snapshotFocusId: null,
  openSnapshot: (snapshotId) => set({ view: 'history', snapshotFocusId: snapshotId }),
  clearSnapshotFocus: () => set({ snapshotFocusId: null }),

  atWorldGate: false,
  worlds: [],
  currentWorldId: null,
  switching: false,

  enterWorldGate: () => {
    const task = get().batchWriteTask
    if (
      task &&
      (task.status === 'preparing' || task.status === 'running' || task.status === 'retrying')
    ) {
      throw new Error('Batch write is running — stop or finish it before switching worlds.')
    }
    set({ atWorldGate: true })
  },

  loadWorlds: async () => {
    set({ worlds: await window.api.listWorlds() })
  },

  enterWorld: async (id) => {
    const task = get().batchWriteTask
    if (
      task &&
      (task.status === 'preparing' || task.status === 'running' || task.status === 'retrying')
    ) {
      throw new Error('Batch write is running — stop or finish it before switching worlds.')
    }
    set({ switching: true })
    try {
      await window.api.switchWorld(id)
      const [novel, config, settingDocs, worlds, voiceProfile] = await Promise.all([
        window.api.getNovelMeta(),
        window.api.getConfig(),
        window.api.listSettings(),
        window.api.listWorlds(),
        window.api.readVoiceProfile(),
      ])
      set({
        novel,
        config,
        settingDocs,
        worlds,
        voiceProfile,
        currentWorldId: id,
        view: 'dashboard',
        atWorldGate: false,
        switching: false,
      })
    } catch (e) {
      set({ switching: false })
      throw e
    }
  },

  novel: null,
  config: null,
  settingDocs: [],

  // 启动：有当前世界则加载它，否则停留在世界入口页
  loadAll: async () => {
    const currentWorldId = await window.api.getCurrentWorldId()
    if (!currentWorldId) {
      set({ atWorldGate: true, worlds: await window.api.listWorlds() })
      return
    }
    const [novel, config, settingDocs, worlds, voiceProfile] = await Promise.all([
      window.api.getNovelMeta(),
      window.api.getConfig(),
      window.api.listSettings(),
      window.api.listWorlds(),
      window.api.readVoiceProfile(),
    ])
    set({ novel, config, settingDocs, worlds, voiceProfile, currentWorldId, atWorldGate: false })
  },

  refreshSettings: async () => {
    set({ settingDocs: await window.api.listSettings() })
  },

  refreshNovel: async () => {
    set({ novel: await window.api.getNovelMeta() })
  },

  saveNovel: async (meta) => {
    await window.api.saveNovelMeta(meta)
    set({ novel: meta })
  },

  voiceProfile: null,
  loadVoiceProfile: async () => {
    set({ voiceProfile: await window.api.readVoiceProfile() })
  },
  saveVoiceProfile: async (profile) => {
    await window.api.writeVoiceProfile(profile)
    set({ voiceProfile: profile })
  },
  saveConfig: async (cfg) => {
    await window.api.saveConfig(cfg)
    set({ config: cfg })
  },

  batchWriteTask: null,
  batchWriteAbort: null,
  batchWriteDeps: null,
  startBatchWrite: (deps, task) => {
    const existing = get().batchWriteTask
    if (existing)
      throw new Error('A batch task already exists — dismiss it before starting a new one.')
    set({ batchWriteTask: task, batchWriteAbort: null, batchWriteDeps: deps })
    void runBatchWrite(deps, task).finally(() => {
      // The engine pushes every transition itself; here we only release the
      // abort handle once the run (or resume) is fully done.
      set({ batchWriteAbort: null })
    })
  },
  stopBatchWrite: () => {
    get().batchWriteAbort?.abort()
  },
  resumeBatchWrite: (startIndex) => {
    const task = get().batchWriteTask
    const deps = get().batchWriteDeps
    if (!task || !deps) return
    if (task.status === 'running' || task.status === 'retrying' || task.status === 'preparing')
      return
    set({ batchWriteAbort: null })
    void resumeBatch(deps, task, startIndex).finally(() => {
      set({ batchWriteAbort: null })
    })
  },
  deleteBatchChapter: async (chapterId) => {
    const task = get().batchWriteTask
    const deps = get().batchWriteDeps
    if (!task || !deps) return
    await deleteEmptyChapter(deps, task, chapterId)
  },
  clearBatchTask: () => {
    const task = get().batchWriteTask
    if (!task) return
    // Only refuse while a run is actually in progress. Terminal states
    // (attention/stopped/failed/done) are dismissible — the UI confirms
    // abandoning recovery first; disk artifacts stay for manual handling.
    if (task.status === 'preparing' || task.status === 'running' || task.status === 'retrying')
      return
    set({ batchWriteTask: null, batchWriteAbort: null, batchWriteDeps: null })
  },
}))
