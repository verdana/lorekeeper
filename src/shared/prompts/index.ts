import type { PromptPack } from './types'
import { en } from './en'
import { zh } from './zh'

export type { PromptPack, PromptPersona } from './types'

/**
 * Prompt language selection.
 *
 * - Renderer (Vite): reads import.meta.env.VITE_PROMPT_LANG
 * - Server (tsx/Node / Electron main): reads process.env.PROMPT_LANG
 *
 * Default is English (for public release). Set the env var to `zh` for the
 * Chinese pack (personal use). Put both in a local .env.local (gitignored):
 *   VITE_PROMPT_LANG=zh
 *   PROMPT_LANG=zh
 *
 * Both reads are baked in at build time: Vite statically replaces
 * `import.meta.env.VITE_PROMPT_LANG` in the renderer bundle, and
 * electron/build.mjs `define`s `process.env.PROMPT_LANG` for the main-process
 * bundle (.env.local is not shipped, so runtime reads always fail there).
 */
function resolveLang(): 'en' | 'zh' {
  // Direct member access on purpose: Vite only inlines static
  // `import.meta.env.X` access — an aliased/optional-chained read silently
  // stays dynamic and always yields undefined in the production bundle.
  try {
    if (import.meta.env.VITE_PROMPT_LANG === 'zh') return 'zh'
  } catch {
    // import.meta.env does not exist outside Vite (tsx / esbuild CJS bundle).
  }
  // Plain `process.env.X` access so esbuild `define` can bake the value in.
  if (typeof process !== 'undefined' && process.env && process.env.PROMPT_LANG === 'zh') {
    return 'zh'
  }
  return 'en'
}

export const PROMPT_LANG = resolveLang()

export const PROMPTS: PromptPack = PROMPT_LANG === 'zh' ? zh : en
