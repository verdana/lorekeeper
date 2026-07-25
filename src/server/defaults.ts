import type { AppConfig, AgentPersona, ConsistencyConfig, WritingConfig, NovelMeta, SettingCategory } from '../shared/types'
import { PROMPTS } from '../shared/prompts'

/**
 * Default writers' room personas. Text comes from the active prompt pack
 * (English by default; Chinese when PROMPT_LANG=zh). Users can override these
 * in Settings; this is only the seed for a fresh config.
 */
export const DEFAULT_PERSONAS: AgentPersona[] = PROMPTS.personas.map((p) => ({
  id: p.id,
  name: p.name,
  role: p.role,
  color: p.color,
  systemPrompt: p.systemPrompt
}))

/**
 * Default consistency-check config. providerId=null falls back to
 * ai.activeProviderId. {{material}} in userTemplate is replaced with the
 * selected settings/chapter content.
 */
export const DEFAULT_CONSISTENCY: ConsistencyConfig = {
  providerId: null,
  systemPrompt: PROMPTS.consistency.systemPrompt,
  userTemplate: PROMPTS.consistency.userTemplate
}

export const DEFAULT_WRITING: WritingConfig = {
  providerId: null,
  outlineSystemPrompt: '',
  continueSystemPrompt: '',
  temperature: 0.8,
  topP: 0.9
}

export const DEFAULT_CONFIG: AppConfig = {
  ai: {
    providers: [
      {
        id: 'default-openai',
        name: 'OpenAI-compatible (fill in)',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: '',
        model: 'gpt-4o-mini'
      }
    ],
    activeProviderId: 'default-openai'
  },
  personas: DEFAULT_PERSONAS,
  consistency: DEFAULT_CONSISTENCY,
  writing: DEFAULT_WRITING
}

export const DEFAULT_NOVEL_META: NovelMeta = {
  title: 'Untitled Manuscript',
  author: '',
  synopsis: '',
  tags: [],
  volumes: []
}

export const CATEGORY_LABELS: Record<SettingCategory, string> = {
  worldview: 'Worldview & Rules',
  character: 'Characters',
  geography: 'Geography & Map',
  economy: 'Society & Economy',
  outline: 'Plot Outline',
  misc: 'Misc'
}
