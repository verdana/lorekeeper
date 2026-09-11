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
 * Application config: AI providers, personas and the user-editable prompts, plus
 * the API keys inside them.
 *
 * Most of this module is compatibility: configs saved by earlier builds carry
 * fields that no longer exist (per-token pricing, a calibration provider, a
 * prompt slot frozen with wording that was replaced), and loading one must clean
 * it rather than reject it.
 */

import type { AppConfig, AIProvider, WritingConfig } from '../../shared/types'
import { configFile } from '../paths'
import { DEFAULT_CONFIG, DEFAULT_WRITING } from '../defaults'
import { PROMPT_LANG, PROMPTS } from '../../shared/prompts'
import { decryptSecret, encryptSecret } from '../secrets'
import { assertWritable, readJSON, writeJSON } from './core'

// ---- 配置 ----
/** Exported for the generation-evidence module, which strips the same legacy fields. */
export type LegacyPricedProvider = AIProvider & {
  inputPriceCnyPerMillionTokens?: number
  outputPriceCnyPerMillionTokens?: number
}

export const withoutProviderPricing = (provider: AIProvider): AIProvider => {
  const current: LegacyPricedProvider = { ...provider }
  delete current.inputPriceCnyPerMillionTokens
  delete current.outputPriceCnyPerMillionTokens
  return current
}

type LegacyCalibratedWritingConfig = WritingConfig & {
  calibrateProviderId?: unknown
  calibrationEnabled?: unknown
  calibrateSystemPrompt?: unknown
  calibrateTemperature?: unknown
  calibrateTopP?: unknown
  calibrateSystemPromptEn?: unknown
  calibrateSystemPromptZh?: unknown
}

const withoutCalibrationConfig = (writing: WritingConfig): WritingConfig => {
  const current: LegacyCalibratedWritingConfig = { ...writing }
  delete current.calibrateProviderId
  delete current.calibrationEnabled
  delete current.calibrateSystemPrompt
  delete current.calibrateTemperature
  delete current.calibrateTopP
  delete current.calibrateSystemPromptEn
  delete current.calibrateSystemPromptZh
  return current
}

/**
 * The pre-P1 outline prompt told the model that prose polish was deferred to a
 * dedicated calibration step that no longer exists. Configs saved while that
 * template was current froze it into the per-language slot, so the
 * strengthened source-draft prompt ("no later cleanup pass; this output owns
 * plot and prose") never reached real runs. Such slots are refreshed to the
 * current built-in at load time.
 */
const SUPERSEDED_OUTLINE_MARKERS = [
  '由后续的专门校准步骤统一处理',
  'handled by a dedicated calibration step afterwards',
]

const isSupersededOutlinePrompt = (text: string): boolean =>
  SUPERSEDED_OUTLINE_MARKERS.some((marker) => text.includes(marker))

export const getConfig = (): AppConfig => {
  // Clone the loaded config so the per-language slot block below never mutates
  // the module-level defaults (getConfig is called per chat request, and
  // readJSON hands back the DEFAULT_CONFIG singleton when no config.json
  // exists). DEFAULT_CONFIG and the section defaults are plain data, so
  // structuredClone is safe.
  const cfg = structuredClone(readJSON(configFile(), DEFAULT_CONFIG))
  cfg.ai.providers = cfg.ai.providers.map(withoutProviderPricing)
  // 若用户配置里 personas 为空，回落到默认
  if (!cfg.personas || cfg.personas.length === 0)
    cfg.personas = structuredClone(DEFAULT_CONFIG.personas)
  // 旧版 config.json 无 consistency 块，回落到默认
  if (!cfg.consistency) cfg.consistency = structuredClone(DEFAULT_CONFIG.consistency)
  // 旧版 config.json 无 writing 块，回落到默认
  if (!cfg.writing) cfg.writing = structuredClone(DEFAULT_WRITING)
  cfg.writing = withoutCalibrationConfig(cfg.writing)
  // 旧版 writing 块缺少 temperature / topP / rewriteSystemPrompt 时补齐默认值
  if (cfg.writing.temperature == null) cfg.writing.temperature = DEFAULT_WRITING.temperature
  if (cfg.writing.topP == null) cfg.writing.topP = DEFAULT_WRITING.topP
  if (cfg.writing.rewriteSystemPrompt == null)
    cfg.writing.rewriteSystemPrompt = DEFAULT_WRITING.rewriteSystemPrompt

  // ---- Per-language prompt slots ----
  // saveConfig archives each editable prompt into a <field>En / <field>Zh slot
  // for the current PROMPT_LANG. Once a config carries any such slot, the
  // active field is resolved from the current locale's slot (falling back to
  // the built-in default), so saving Chinese prompts never overwrites English
  // ones and vice versa. Legacy configs without slots are left untouched.
  const langIsZh = PROMPT_LANG === 'zh'
  const hasLangSlots =
    cfg.personas.some((p) => p.systemPromptEn !== undefined || p.systemPromptZh !== undefined) ||
    cfg.consistency.systemPromptEn !== undefined ||
    cfg.consistency.systemPromptZh !== undefined ||
    cfg.consistency.userTemplateEn !== undefined ||
    cfg.consistency.userTemplateZh !== undefined ||
    cfg.writing.outlineSystemPromptEn !== undefined ||
    cfg.writing.outlineSystemPromptZh !== undefined ||
    cfg.writing.rewriteSystemPromptEn !== undefined ||
    cfg.writing.rewriteSystemPromptZh !== undefined
  if (hasLangSlots) {
    for (const p of cfg.personas) {
      const slot = langIsZh ? p.systemPromptZh : p.systemPromptEn
      if (slot !== undefined) p.systemPrompt = slot
      else {
        // Slot missing for the current locale: fall back to the built-in
        // persona (same id) or keep the legacy value for user-created ones.
        const builtin = DEFAULT_CONFIG.personas.find((bp) => bp.id === p.id)
        p.systemPrompt = builtin?.systemPrompt ?? p.systemPrompt
      }
    }
    const cons = cfg.consistency
    const consSp = langIsZh ? cons.systemPromptZh : cons.systemPromptEn
    cons.systemPrompt = consSp !== undefined ? consSp : DEFAULT_CONFIG.consistency.systemPrompt
    const consUt = langIsZh ? cons.userTemplateZh : cons.userTemplateEn
    cons.userTemplate = consUt !== undefined ? consUt : DEFAULT_CONFIG.consistency.userTemplate
    const w = cfg.writing
    let wO = langIsZh ? w.outlineSystemPromptZh : w.outlineSystemPromptEn
    // Slots that froze the superseded two-pass outline prompt are refreshed to
    // the current built-in so the source-draft contract actually takes effect.
    if (wO !== undefined && isSupersededOutlinePrompt(wO)) wO = PROMPTS.assist.outlinePrompt
    w.outlineSystemPrompt = wO !== undefined ? wO : PROMPTS.assist.outlinePrompt
    const wR = langIsZh ? w.rewriteSystemPromptZh : w.rewriteSystemPromptEn
    w.rewriteSystemPrompt = wR !== undefined ? wR : PROMPTS.assist.rewritePrompt
  }

  // Move the untouched legacy default to the selected DeepSeek writing model.
  const legacyDefaultProvider = cfg.ai.providers.find(
    (provider) =>
      provider.id === 'default-openai' &&
      provider.baseUrl.toLowerCase().includes('api.deepseek.com') &&
      provider.model === 'deepseek-v4-pro',
  )
  if (legacyDefaultProvider) legacyDefaultProvider.model = 'deepseek-v4-flash'

  // 旧版明文 API Key 自动迁移：只要有 key 还没被加密且当前环境支持加密，
  // 就回写一次密文。这样用户升级后第一次启动即可把旧明文 key 转为密文。
  const needsMigrate = cfg.ai.providers.some((p) => p.apiKey && !p.apiKey.startsWith('enc:v1:'))
  if (needsMigrate) {
    const encrypted: AppConfig = {
      ...cfg,
      ai: {
        ...cfg.ai,
        providers: cfg.ai.providers.map((p) => ({
          ...p,
          apiKey: encryptSecret(p.apiKey) ?? '',
        })),
      },
    }
    // This is a read-time write, so it must respect the same rule as saveConfig:
    // never persist a config built from a file that could not be read.
    assertWritable(configFile(), 'Settings')
    writeJSON(configFile(), encrypted)
  }

  // 解密 API Key 供内存使用（旧版无前缀的明文会直接透传）。
  for (const p of cfg.ai.providers) {
    p.apiKey = decryptSecret(p.apiKey) ?? ''
  }

  return cfg
}

export const saveConfig = (cfg: AppConfig): void => {
  // Archive every editable prompt into the per-language slot matching the
  // current PROMPT_LANG. The other locale's slot is left untouched, so saving
  // English prompts never overwrites the Chinese ones (and vice versa).
  //
  // Legacy configs (no slots at all) get both slots written on their first
  // save: the plain field may hold a custom prompt written before the slot
  // system existed, and we cannot know its language — writing it to both
  // locales keeps it reachable whichever language is active later.
  const langIsZh = PROMPT_LANG === 'zh'
  const writing = withoutCalibrationConfig(cfg.writing)
  const hasAnySlot =
    cfg.personas.some((p) => p.systemPromptEn !== undefined || p.systemPromptZh !== undefined) ||
    cfg.consistency.systemPromptEn !== undefined ||
    cfg.consistency.systemPromptZh !== undefined ||
    cfg.consistency.userTemplateEn !== undefined ||
    cfg.consistency.userTemplateZh !== undefined ||
    writing.outlineSystemPromptEn !== undefined ||
    writing.outlineSystemPromptZh !== undefined ||
    writing.rewriteSystemPromptEn !== undefined ||
    writing.rewriteSystemPromptZh !== undefined
  const archive = (field: string, value: string): Record<string, string> =>
    hasAnySlot
      ? langIsZh
        ? { [`${field}Zh`]: value }
        : { [`${field}En`]: value }
      : { [`${field}En`]: value, [`${field}Zh`]: value }

  const localized: AppConfig = {
    ...cfg,
    personas: cfg.personas.map((p) => ({ ...p, ...archive('systemPrompt', p.systemPrompt) })),
    consistency: {
      ...cfg.consistency,
      ...archive('systemPrompt', cfg.consistency.systemPrompt),
      ...archive('userTemplate', cfg.consistency.userTemplate),
    },
    writing: {
      ...writing,
      ...archive('outlineSystemPrompt', writing.outlineSystemPrompt),
      ...archive('rewriteSystemPrompt', writing.rewriteSystemPrompt),
    },
  }
  const encrypted: AppConfig = {
    ...localized,
    ai: {
      ...localized.ai,
      providers: localized.ai.providers.map((p) => {
        const current = withoutProviderPricing(p)
        return { ...current, apiKey: encryptSecret(current.apiKey) ?? '' }
      }),
    },
  }
  // An unreadable config.json reads as the built-in defaults, so saving over it
  // would discard every provider, API key, persona and prompt slot the author
  // configured. Refuse and keep the damaged file for repair.
  assertWritable(configFile(), 'Settings')
  writeJSON(configFile(), encrypted)
}
