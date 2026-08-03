import type { PromptPack } from './types'
import { en } from './en'
import { zh } from './zh'

export type { PromptPack, PromptPersona } from './types'

/**
 * Prompt language selection.
 *
 * `PROMPT_LANG` and `VITE_PROMPT_LANG` are aliases of the same setting — set
 * either one (shell env, .env.local, or both) and the pack switches:
 *
 * - Renderer (Vite): reads import.meta.env.VITE_PROMPT_LANG (inlined by Vite)
 *   and import.meta.env.PROMPT_LANG (inlined via vite.config.ts `define`).
 * - Server (tsx/Node / Electron main): reads process.env.PROMPT_LANG and
 *   process.env.VITE_PROMPT_LANG (src/server/env.ts loads .env.local into
 *   process.env, so both keys are present when set there).
 *
 * Default is English (for public release). Set either variable to `zh` for
 * the Chinese pack (personal use). .env.local is gitignored:
 *   VITE_PROMPT_LANG=zh
 *   PROMPT_LANG=zh
 *
 * Both reads are baked in at build time: Vite statically replaces
 * `import.meta.env.VITE_PROMPT_LANG` (and `import.meta.env.PROMPT_LANG` via
 * `define`) in the renderer bundle, and electron/build.mjs `define`s
 * `process.env.PROMPT_LANG` for the main-process bundle (.env.local is not
 * shipped, so runtime reads always fail there).
 */
function resolveLang(): 'en' | 'zh' {
  // Direct member access on purpose: Vite only inlines static
  // `import.meta.env.X` access — an aliased/optional-chained read silently
  // stays dynamic and always yields undefined in the production bundle.
  try {
    if (import.meta.env.VITE_PROMPT_LANG === 'zh') return 'zh'
    // Inlined by vite.config.ts `define` so PROMPT_LANG alone also switches the
    // renderer pack (process.env is unreachable in the browser bundle).
    if (import.meta.env.PROMPT_LANG === 'zh') return 'zh'
  } catch {
    // import.meta.env does not exist outside Vite (tsx / esbuild CJS bundle).
  }
  // Plain `process.env.X` access so esbuild `define` can bake the value in.
  if (typeof process !== 'undefined' && process.env) {
    if (process.env.PROMPT_LANG === 'zh' || process.env.VITE_PROMPT_LANG === 'zh') return 'zh'
  }
  return 'en'
}

export const PROMPT_LANG = resolveLang()

export const PROMPTS: PromptPack = PROMPT_LANG === 'zh' ? zh : en
