import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { configFile, initPaths } from '../../src/server/paths'
import { getConfig, saveConfig } from '../../src/server/store'
import { DEFAULT_SLOP_WEIGHTS } from '../../src/shared/slop/analyze'
import { PROMPT_LANG } from '../../src/shared/prompts'
import type { AppConfig } from '../../src/shared/types'

// Per-language prompt slots: saveConfig archives the active prompt into the
// current locale's slot (fieldEn / fieldZh) without touching the other
// locale's, and getConfig restores the current locale's slot back into the
// active field. PROMPT_LANG is resolved at module load (and may be 'zh' when a
// local .env.local sets VITE_PROMPT_LANG, as vitest loads it), so assertions
// use the dynamically-resolved current/other slot suffixes.
let dataRoot = ''

const langIsZh = PROMPT_LANG === 'zh'
const current = langIsZh ? 'Zh' : 'En'
const other = langIsZh ? 'En' : 'Zh'

beforeAll(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'lorekeeper-config-lang-'))
  process.env.ORBIT_DATA_DIR = dataRoot
  initPaths()
  writeFileSync(configFile(), '{}')
})

afterAll(() => {
  rmSync(dataRoot, { recursive: true, force: true })
})

/** A config carrying both language slots, with distinct values per locale. */
const bilingual = (): AppConfig => ({
  ai: {
    providers: [
      { id: 'p1', name: 'p1', baseUrl: 'http://x', apiKey: '', model: 'm', maxTokens: 100 },
    ],
    activeProviderId: 'p1',
  },
  personas: [
    {
      id: 'a1',
      name: 'Vera · Editor',
      role: 'Editor',
      color: '#000',
      systemPrompt: 'system-current',
      systemPromptEn: 'system-en',
      systemPromptZh: 'system-zh',
    },
  ],
  consistency: {
    providerId: null,
    systemPrompt: 'cons-sp-current',
    systemPromptEn: 'cons-sp-en',
    systemPromptZh: 'cons-sp-zh',
    userTemplate: 'cons-ut-current',
    userTemplateEn: 'cons-ut-en',
    userTemplateZh: 'cons-ut-zh',
  },
  writing: {
    providerId: null,
    outlineSystemPrompt: 'outline-current',
    outlineSystemPromptEn: 'outline-en',
    outlineSystemPromptZh: 'outline-zh',
    continueSystemPrompt: 'cont-current',
    continueSystemPromptEn: 'cont-en',
    continueSystemPromptZh: 'cont-zh',
    temperature: 0.8,
    topP: 0.9,
  },
  slop: {
    rewriteProviderId: null,
    rewriteSystemPrompt: 'rewrite-current',
    rewriteSystemPromptEn: 'rewrite-en',
    rewriteSystemPromptZh: 'rewrite-zh',
    weights: DEFAULT_SLOP_WEIGHTS,
    rulesPackVersion: 'en-v1',
  },
})

const readConfigFile = (): AppConfig => JSON.parse(readFileSync(configFile(), 'utf8'))

describe('per-language prompt slots', () => {
  it('saveConfig archives the active prompt into the current locale slot, leaving the other locale untouched', () => {
    const cfg = bilingual()
    cfg.writing.outlineSystemPrompt = 'outline-edited'
    cfg.consistency.systemPrompt = 'cons-sp-edited'
    cfg.slop!.rewriteSystemPrompt = 'rewrite-edited'
    cfg.personas[0].systemPrompt = 'system-edited'
    saveConfig(cfg)

    const saved = readConfigFile()
    // Current locale slot reflects the new active value.
    expect(saved.writing[`outlineSystemPrompt${current}`]).toBe('outline-edited')
    expect(saved.consistency[`systemPrompt${current}`]).toBe('cons-sp-edited')
    expect(saved.slop![`rewriteSystemPrompt${current}`]).toBe('rewrite-edited')
    expect(saved.personas[0][`systemPrompt${current}`]).toBe('system-edited')
    // The other locale's slots are never overwritten.
    expect(saved.writing[`outlineSystemPrompt${other}`]).toBe(`outline-${other.toLowerCase()}`)
    expect(saved.consistency[`systemPrompt${other}`]).toBe(`cons-sp-${other.toLowerCase()}`)
    expect(saved.consistency[`userTemplate${other}`]).toBe(`cons-ut-${other.toLowerCase()}`)
    expect(saved.slop![`rewriteSystemPrompt${other}`]).toBe(`rewrite-${other.toLowerCase()}`)
    expect(saved.personas[0][`systemPrompt${other}`]).toBe(`system-${other.toLowerCase()}`)
  })

  it('getConfig restores the current locale slot into the active fields', () => {
    const loaded = getConfig()
    expect(loaded.writing.outlineSystemPrompt).toBe('outline-edited')
    expect(loaded.consistency.systemPrompt).toBe('cons-sp-edited')
    expect(loaded.slop!.rewriteSystemPrompt).toBe('rewrite-edited')
    expect(loaded.personas[0].systemPrompt).toBe('system-edited')
    expect(loaded.consistency.userTemplate).toBe('cons-ut-current')
  })

  it('legacy configs without slots keep their plain fields untouched', () => {
    const legacy: AppConfig = {
      ai: {
        providers: [
          { id: 'p1', name: 'p1', baseUrl: 'http://x', apiKey: '', model: 'm', maxTokens: 100 },
        ],
        activeProviderId: 'p1',
      },
      personas: [
        {
          id: 'a1',
          name: 'Vera · Editor',
          role: 'Editor',
          color: '#000',
          systemPrompt: 'legacy-persona',
        },
      ],
      consistency: {
        providerId: null,
        systemPrompt: 'legacy-cons-sp',
        userTemplate: 'legacy-cons-ut',
      },
      writing: {
        providerId: null,
        outlineSystemPrompt: 'legacy-outline',
        continueSystemPrompt: 'legacy-continue',
        temperature: 0.8,
        topP: 0.9,
      },
      slop: {
        rewriteProviderId: null,
        rewriteSystemPrompt: 'legacy-rewrite',
        weights: DEFAULT_SLOP_WEIGHTS,
        rulesPackVersion: 'en-v1',
      },
    }
    writeFileSync(configFile(), JSON.stringify(legacy))

    const loaded = getConfig()
    expect(loaded.writing.outlineSystemPrompt).toBe('legacy-outline')
    expect(loaded.consistency.systemPrompt).toBe('legacy-cons-sp')
    expect(loaded.slop!.rewriteSystemPrompt).toBe('legacy-rewrite')
    expect(loaded.personas[0].systemPrompt).toBe('legacy-persona')
  })

  it('legacy configs get both slots written on first save, keeping custom prompts reachable across languages', () => {
    const legacy: AppConfig = {
      ai: {
        providers: [
          { id: 'p1', name: 'p1', baseUrl: 'http://x', apiKey: '', model: 'm', maxTokens: 100 },
        ],
        activeProviderId: 'p1',
      },
      personas: [
        {
          id: 'a1',
          name: 'Vera · Editor',
          role: 'Editor',
          color: '#000',
          systemPrompt: 'legacy-persona',
        },
      ],
      consistency: {
        providerId: null,
        systemPrompt: 'legacy-cons-sp',
        userTemplate: 'legacy-cons-ut',
      },
      writing: {
        providerId: null,
        outlineSystemPrompt: 'legacy-outline',
        continueSystemPrompt: 'legacy-continue',
        temperature: 0.8,
        topP: 0.9,
      },
      slop: {
        rewriteProviderId: null,
        rewriteSystemPrompt: 'legacy-rewrite',
        weights: DEFAULT_SLOP_WEIGHTS,
        rulesPackVersion: 'en-v1',
      },
    }
    writeFileSync(configFile(), JSON.stringify(legacy))
    saveConfig(legacy)

    const saved = readConfigFile()
    expect(saved.writing.outlineSystemPromptEn).toBe('legacy-outline')
    expect(saved.writing.outlineSystemPromptZh).toBe('legacy-outline')
    expect(saved.writing.continueSystemPromptEn).toBe('legacy-continue')
    expect(saved.writing.continueSystemPromptZh).toBe('legacy-continue')
    expect(saved.slop!.rewriteSystemPromptEn).toBe('legacy-rewrite')
    expect(saved.slop!.rewriteSystemPromptZh).toBe('legacy-rewrite')
    expect(saved.personas[0].systemPromptEn).toBe('legacy-persona')
    expect(saved.personas[0].systemPromptZh).toBe('legacy-persona')

    const loaded = getConfig()
    expect(loaded.writing.outlineSystemPrompt).toBe('legacy-outline')
    expect(loaded.slop!.rewriteSystemPrompt).toBe('legacy-rewrite')
  })

  it('getConfig with no config.json returns built-in defaults without crashing or mutating them', () => {
    rmSync(configFile(), { force: true })
    const loaded = getConfig()
    expect(loaded.personas.length).toBeGreaterThan(0)
    expect(loaded.personas[0].systemPrompt.trim().length).toBeGreaterThan(0)
    expect(loaded.consistency.userTemplate).toContain('{{material}}')
    expect(loaded.writing.outlineSystemPrompt).toBe('')
    expect(loaded.slop!.rewriteSystemPrompt.trim().length).toBeGreaterThan(0)
    // A second read must not be affected by the first (no shared-state mutation).
    const again = getConfig()
    expect(again.personas[0].systemPrompt).toBe(loaded.personas[0].systemPrompt)
  })
})
