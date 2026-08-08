// The UI is English by default for public release. Prompt packs
// (shared/prompts) follow PROMPT_LANG / VITE_PROMPT_LANG instead; the UI is
// deliberately decoupled from those variables.
const isElectron = navigator.userAgent.includes('Electron')
export { isElectron }
export type UiLang = 'en' | 'zh'
export const uiLang: UiLang = 'en'

type Params = Record<string, string | number>

const dict: Record<string, { en: string; zh: string }> = {
  'band.green': { en: 'Near-human writing', zh: '接近人类写作' },
  'band.yellow': { en: 'Some AI tone', zh: '有一定机器味' },
  'band.red': { en: 'Strongly AI-sounding', zh: '机器味明显' },

  'voice.sentenceLength': { en: 'Sentence length', zh: '句长' },
  'voice.verbStyle': { en: 'Verb style', zh: '动词风格' },
  'voice.narrativeDistance': { en: 'Narrative distance', zh: '叙事距离' },
  'voice.dialogueStyle': { en: 'Dialogue style', zh: '对话' },
  'voice.rhetoricalPatterns': { en: 'Rhetorical patterns', zh: '修辞习惯' },
  'voice.notes': { en: 'Notes', zh: '备注' },
}

/** Translate a key, optionally interpolating `{name}` placeholders. */
export function t(key: string, params?: Params): string {
  const entry = dict[key]
  let s = entry ? entry[uiLang] : key
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.replaceAll(`{${k}}`, String(v))
    }
  }
  return s
}
