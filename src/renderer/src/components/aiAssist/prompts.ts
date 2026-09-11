/**
 * The panel's prompt plumbing: the built-in prompts, the author's overrides kept
 * in localStorage (keyed by prompt language, so a Chinese override never
 * shadows the English one), and the message builders that assemble a request.
 */

import { PROMPTS, PROMPT_LANG } from '@shared/prompts'

import { REWRITE_SOURCE_LIMIT, POLISH_SOURCE_LIMIT } from '../../lib'

/** AI assistant presets: same panel reused for settings and prose, swapping title and prompts. */
export interface AssistPreset {
  title: string
  systemPrompt: string
  contextLabel: string // 上下文在 prompt 里的标签，如「当前设定文档」
  quickPrompts: string[]
}

/** Codex scene: polish / expand / find gaps / suggest hooks. */
export const SETTING_ASSIST: AssistPreset = PROMPTS.assist.setting

// ---- Default system prompts (also exported to Preferences as templates). ----

export const BUILTIN_OUTLINE_PROMPT = PROMPTS.assist.outlinePrompt

export const BUILTIN_REWRITE_PROMPT = PROMPTS.assist.rewritePrompt

// ---- Custom prompts persisted to localStorage. ----
//
// Keyed by prompt language so a Chinese custom prompt never shadows the
// English one (and vice versa). The legacy language-less key is still read as
// a fallback so pre-slot custom prompts are not lost on upgrade.

export function loadCustomPrompt(mode: string): string | null {
  try {
    return (
      localStorage.getItem(`ai-prompt:${mode}:${PROMPT_LANG}`) ??
      localStorage.getItem(`ai-prompt:${mode}`)
    )
  } catch {
    return null
  }
}

export function saveCustomPrompt(mode: string, prompt: string): void {
  try {
    localStorage.setItem(`ai-prompt:${mode}:${PROMPT_LANG}`, prompt)
  } catch {
    // Fail silently.
  }
}

/** Remove the current locale's custom prompt (plus the legacy language-less key). */
export function clearCustomPrompt(mode: string): void {
  try {
    localStorage.removeItem(`ai-prompt:${mode}:${PROMPT_LANG}`)
    localStorage.removeItem(`ai-prompt:${mode}`)
  } catch {
    // Fail silently.
  }
}

export function getDefaultPrompt(mode: string): string {
  if (mode === 'outline-write') return BUILTIN_OUTLINE_PROMPT
  if (mode === 'rewrite') return BUILTIN_REWRITE_PROMPT
  return ''
}

/**
 * Why a rewrite of an over-long source was refused, and what to do instead.
 * Shared by the request guard and the insertion guard so both report the same
 * reason for the same condition.
 */
export function rewriteTooLongMessage(scope: 'chapter' | 'selection'): string {
  return (
    `This ${scope} is longer than ${REWRITE_SOURCE_LIMIT} characters, so only its first ` +
    `${REWRITE_SOURCE_LIMIT} would reach the model — applying the rewrite would delete the ` +
    `rest of it. Rewrite a selected passage instead, or ${scope === 'chapter' ? 'split the chapter' : 'select less text'}.`
  )
}

/**
 * Why a polish pass over an over-long source was refused. Polishing revises the
 * text it is given, so revising only the opening would present a partial
 * revision as if it covered the whole document.
 */
export function polishTooLongMessage(scope: 'document' | 'selection'): string {
  return (
    `This ${scope} is longer than ${POLISH_SOURCE_LIMIT} characters, so only its first ` +
    `${POLISH_SOURCE_LIMIT} would reach the model — the revision would cover only that part. ` +
    `Polish a selected passage instead, or ${scope === 'document' ? 'split the document' : 'select less text'}.`
  )
}

/** Read custom prompts from config if set, otherwise use hardcoded defaults. */
export function getConfigPrompt(
  mode: string,
  config: {
    writing?: {
      outlineSystemPrompt?: string
      rewriteSystemPrompt?: string
    }
  } | null,
): string {
  if (!config?.writing) return getDefaultPrompt(mode)
  if (mode === 'outline-write' && config.writing.outlineSystemPrompt?.trim())
    return config.writing.outlineSystemPrompt
  if (mode === 'rewrite' && config.writing.rewriteSystemPrompt?.trim())
    return config.writing.rewriteSystemPrompt
  return getDefaultPrompt(mode)
}
