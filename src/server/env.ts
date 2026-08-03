// Load .env.local for the tsx dev server / `pnpm start`.
//
// Must be imported *first* in src/server/index.ts: the prompt pack resolves its
// language at module-evaluation time (defaults.ts → prompts), so the language
// variables have to be in process.env before those modules are evaluated. ES
// import order is source order, so this side-effect import runs before the rest.
//
// Every key in .env.local is loaded, so both aliases — PROMPT_LANG and
// VITE_PROMPT_LANG — land in process.env; shared/prompts treats them as the
// same setting.
//
// In the packaged Electron app the main-process bundle bakes the language in
// at build time (electron/build.mjs), so this file is a dev/standalone
// convenience and never overrides an already-set variable.
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

function loadDotEnvLocal(): void {
  const file = join(process.cwd(), '.env.local')
  if (!existsSync(file)) return
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    if (!key || process.env[key] !== undefined) continue
    process.env[key] = line
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '')
  }
}

loadDotEnvLocal()
