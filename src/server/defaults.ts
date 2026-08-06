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
import { zhRules } from '../shared/slop/rules.zh'
import { enRules } from '../shared/slop/rules.en'

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
  rewriteSystemPrompt: '',
  temperature: 0.8,
  topP: 0.9,
}

export const DEFAULT_SLOP: SlopConfig = {
  rewriteProviderId: null,
  // Defaults to the active prompt pack; user can override in Settings.
  rewriteSystemPrompt: PROMPTS.deslop.systemPrompt,
  weights: DEFAULT_SLOP_WEIGHTS,
  // Derive from the shipped packs so the version tag never drifts from the
  // rules (a stale tag would show a permanent "rules updated" banner).
  rulesPackVersion: PROMPT_LANG === 'zh' ? zhRules.version : enRules.version,
  rewriteIntensity: 'balanced',
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
  '01-worldview': 'Worldview & Cosmic Laws',
  '02-magic': 'Magic & Supernatural Systems',
  '03-history': 'History & Timeline',
  '04-geography': 'Geography & Territories',
  '05-faction': 'Nations & Organizations',
  '06-religion': 'Religion & Mythology',
  '07-society': 'Society & Culture',
  '08-economy': 'Economy & Trade',
  '09-technology': 'Technology, Military & Productivity',
  '10-species': 'Species, Monsters & Ecology',
  '11-character': 'Characters',
  '12-item': 'Artifacts & Vehicles',
  '99-misc': 'Miscellaneous & Reference',
}

/**
 * Category-specific templates for new codex documents.
 * Each template is a markdown string with {{title}} placeholder.
 */
export const CATEGORY_TEMPLATES: Record<SettingCategory, string> = {
  '01-worldview': `# {{title}}

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

  '11-character': `# {{title}}

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

  '04-geography': `# {{title}}

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

  '08-economy': `# {{title}}

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

  '99-misc': `# {{title}}

## Description

## Notes

- Note 1
- Note 2
- Note 3

## References

Links or references to related codex documents.`,

  '02-magic': `# {{title}}

## Overview

What is this power / magical system, and how does it work?

## Sources & Costs

Where does the power come from? What does it cost to use?

## Mechanics

- Core rule 1
- Core rule 2
- Core rule 3

## Limitations

What this system cannot do, or where it breaks down.

## Practitioners & Institutions

Who wields it, and how is it organized?`,

  '03-history': `# {{title}}

## Overview

What period or chain of events does this cover?

## Timeline (Chronological)

1. Event 1 — date / consequence
2. Event 2 — date / consequence
3. Event 3 — date / consequence

## Key Figures

Figures who shaped these events.

## Legacy

How does this history still affect the present?`,

  '05-faction': `# {{title}}

## Overview

What is this nation / organization / group?

## Structure & Hierarchy

How is it organized? Who holds power?

## Key Figures

- Leader or head
- Notable members

## Goals & Ideology

What do they want? What do they believe?

## Resources & Territory

What do they control? What do they lack?

## Conflicts & Relations

Allies, rivals, and points of friction.`,

  '06-religion': `# {{title}}

## Overview

Core beliefs, myths, or divine powers associated with this tradition.

## Pantheon / Deities

- Deity or spirit 1
- Deity or spirit 2

## Practices & Rituals

Worship, festivals, taboos.

## Clergy & Organization

Who leads worship? How is the faith structured?

## Influence on the World

How does this religion shape society, politics, or magic?`,

  '07-society': `# {{title}}

## Overview

Culture, customs, or social structure of this people / region.

## Daily Life

Work, food, dress, festivals.

## Social Hierarchy

Classes, castes, or roles.

## Values & Taboos

What is honored? What is forbidden?

## Cross-Cultural Ties

Trades, marriages, rivalries with other cultures.`,

  '09-technology': `# {{title}}

## Overview

What technology, craft, or military capability is this?

## Principles

How does it work? What fuels it?

## Applications

- Use 1
- Use 2
- Use 3

## Limitations & Costs

Scarcity, failure modes, side effects.

## Producers & Users

Who builds it? Who wields it?`,

  '10-species': `# {{title}}

## Overview

Biology, ecology, or nature of this species / creature.

## Appearance & Physiology

Distinctive traits, life cycle, habitat.

## Behavior & Society

Instincts, culture, pack/tribe structure.

## Relations with Other Species

Allies, prey, predators, rivals.

## Notable Individuals or Strains

Examples that matter to the story.`,

  '12-item': `# {{title}}

## Overview

What is this artifact / tool / vehicle?

## Appearance

Materials, form, craftsmanship.

## Function & Use

What does it do? How is it used?

## Origin & History

Who made it? What is its story?

## Limitations & Risks

Conditions, costs, or dangers of use.`,
}
