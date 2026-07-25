import type { PromptPack } from './types'
import { en } from './en'
import { zh } from './zh'

export type { PromptPack, PromptPersona } from './types'

/**
 * Prompt language selection.
 *
 * - Renderer (Vite): reads import.meta.env.VITE_PROMPT_LANG
 * - Server (tsx/Node): reads process.env.PROMPT_LANG
 *
 * Default is English (for public release). Set the env var to `zh` for the
 * Chinese pack (personal use). Put both in a local .env.local (gitignored):
 *   VITE_PROMPT_LANG=zh
 *   PROMPT_LANG=zh
 */
function resolveLang(): 'en' | 'zh' {
  // Renderer (Vite): import.meta.env.VITE_PROMPT_LANG
  // Server (tsx/Node): process.env.PROMPT_LANG
  const meta = import.meta as unknown as { env?: Record<string, string | undefined> }
  const fromVite = meta.env?.VITE_PROMPT_LANG
  const fromNode = typeof process !== 'undefined' ? process?.env?.PROMPT_LANG : undefined
  return (fromVite ?? fromNode) === 'zh' ? 'zh' : 'en'
}

export const PROMPT_LANG = resolveLang()

export const PROMPTS: PromptPack = PROMPT_LANG === 'zh' ? zh : en
