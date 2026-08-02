import type {
  AppConfig,
  AgentPersona,
  ConsistencyConfig,
  WritingConfig,
  SlopConfig,
  NovelMeta,
  SettingCategory,
} from '../shared/types'
import { PROMPTS, PROMPT_LANG } from '../shared/prompts'
import { DEFAULT_SLOP_WEIGHTS } from '../shared/slop/analyze'

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
  systemPrompt: p.systemPrompt,
}))

/**
 * Default consistency-check config. providerId=null falls back to
 * ai.activeProviderId. {{material}} in userTemplate is replaced with the
 * selected settings/chapter content.
 */
export const DEFAULT_CONSISTENCY: ConsistencyConfig = {
  providerId: null,
  systemPrompt: PROMPTS.consistency.systemPrompt,
  userTemplate: PROMPTS.consistency.userTemplate,
}

export const DEFAULT_WRITING: WritingConfig = {
  providerId: null,
  outlineSystemPrompt: '',
  continueSystemPrompt: '',
  temperature: 0.8,
  topP: 0.9,
}

export const DEFAULT_SLOP: SlopConfig = {
  rewriteProviderId: null,
  // Defaults to the active prompt pack; user can override in Settings.
  rewriteSystemPrompt: PROMPTS.deslop.systemPrompt,
  weights: DEFAULT_SLOP_WEIGHTS,
  rulesPackVersion: PROMPT_LANG === 'zh' ? 'zh-v1' : 'en-v1',
}

export const DEFAULT_CONFIG: AppConfig = {
  ai: {
    providers: [
      {
        id: 'default-openai',
        name: 'DeepSeek (fill in API key)',
        baseUrl: 'https://api.deepseek.com',
        apiKey: '',
        model: 'deepseek-v4-flash',
        maxTokens: 8192,
      },
    ],
    activeProviderId: 'default-openai',
  },
  personas: DEFAULT_PERSONAS,
  consistency: DEFAULT_CONSISTENCY,
  writing: DEFAULT_WRITING,
  slop: DEFAULT_SLOP,
}

export const DEFAULT_NOVEL_META: NovelMeta = {
  title: 'Untitled Manuscript',
  author: '',
  synopsis: '',
  tags: [],
  volumes: [],
}

export const CATEGORY_LABELS: Record<SettingCategory, string> = {
  worldview: 'Worldview & Rules',
  character: 'Characters',
  geography: 'Geography & Map',
  economy: 'Society & Economy',
  outline: 'Plot Outline',
  misc: 'Misc',
}

/**
 * Category-specific templates for new codex documents.
 * Each template is a markdown string with {{title}} placeholder.
 */
export const CATEGORY_TEMPLATES: Record<SettingCategory, string> = {
  worldview: `# {{title}}

## Overview

Brief description of this aspect of the world.

## Core Principles

- Fundamental rule 1
- Fundamental rule 2
- Fundamental rule 3

## Boundaries & Limitations

What this rule/system cannot do, or where it breaks down.

## Cultural & Social Impact

How this worldview affects daily life, religion, philosophy, or power structures.

## Notable Expressions

- Example 1
- Example 2
- Example 3`,

  character: `# {{title}}

## Basic Information

- **Full Name**:
- **Alias / Titles**:
- **Age**:
- **Gender**:
- **Affiliation**:
- **Role**:

## Appearance

Physical description, distinctive features, typical attire.

## Personality

Core traits, motivations, fears, quirks. What drives them?

## Background

Key life events that shaped who they are.

## Abilities & Skills

- Notable talent or skill 1
- Notable talent or skill 2
- Notable talent or skill 3

## Relationships

Connections to other characters, factions, or locations.

## Arc & Development

Where they start, where they might end up.`,

  geography: `# {{title}}

## Location & Geography

Where is this place? Terrain, climate, natural features.

## Settlements & Population

Key towns, cities, or outposts. Who lives here?

## Economy & Resources

What is produced, traded, or scarce here?

## Points of Interest

- Landmark or notable site 1
- Landmark or notable site 2

## Strategic Importance

Why does this place matter in the larger world?`,

  economy: `# {{title}}

## Structure & Hierarchy

How is this society / organization / economy organized?

## Key Figures

- Leader or head
- Notable members

## Beliefs & Values

Core ideology, taboos, practices.

## Resources & Wealth

What do they control? What do they lack?

## Conflicts & Tensions

Internal or external friction points.

## Relationships

Allies, rivals, neutral parties.`,

  outline: `# {{title}}

## Purpose in the Story

What function does this element serve?

## Key Events (Chronological)

1. Event 1
2. Event 2
3. Event 3

## Dramatic Tension

What is at stake? What conflict drives this thread?

## Resolution / Payoff

How does this thread conclude or pay off?

## Connections

Links to other plot threads, characters, or setting elements.`,

  misc: `# {{title}}

## Description

## Notes

- Note 1
- Note 2
- Note 3

## References

Links or references to related codex documents.`,
}
