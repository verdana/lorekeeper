import { create } from 'zustand'
import type { AppConfig, NovelMeta, SettingDoc, VoiceProfile, WorldMeta } from '@shared/types'

export type ViewKey =
  | 'dashboard'
  | 'settings-docs'
  | 'timeline'
  | 'graph'
  | 'chapters'
  | 'discussion'
  | 'consistency'
  | 'history'
  | 'outline'
  | 'voice-profile'
  | 'preferences'
  | 'character-chat'
  | 'deslop'

interface AppState {
  view: ViewKey
  setView: (v: ViewKey) => void

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
}

export const useStore = create<AppState>((set, get) => ({
  view: 'dashboard',
  setView: (v) => set({ view: v }),

  atWorldGate: false,
  worlds: [],
  currentWorldId: null,
  switching: false,

  enterWorldGate: () => set({ atWorldGate: true }),

  loadWorlds: async () => {
    set({ worlds: await window.api.listWorlds() })
  },

  enterWorld: async (id) => {
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
}))
