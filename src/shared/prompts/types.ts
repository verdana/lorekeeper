// Shape of a full prompt pack. Both en.ts and zh.ts implement this so the two
// locales stay structurally identical; adding a key in one forces the other.

/** A discussion persona's identity fields (id/color are locale-agnostic; text differs). */
export interface PromptPersona {
  id: string
  name: string
  role: string
  color: string
  systemPrompt: string
}

export interface PromptPack {
  /** Default writers' room personas. */
  personas: PromptPersona[]

  /** Consistency check. */
  consistency: {
    systemPrompt: string
    /** User message template. Must contain the {{material}} placeholder. */
    userTemplate: string
  }

  /** Inline AI assistant presets (Codex + Manuscript panels). */
  assist: {
    setting: {
      title: string
      systemPrompt: string
      contextLabel: string
      quickPrompts: string[]
    }
    chapter: {
      title: string
      systemPrompt: string
      contextLabel: string
      quickPrompts: string[]
    }
    /** Built-in system prompt for outline-driven chapter writing. */
    outlinePrompt: string
    /** Built-in system prompt for continuation writing. */
    continuePrompt: string
  }

  /** Writers' room orchestration prompts (not user-configurable). */
  discussion: {
    /** Agent-driven relevant-doc selection. `topic` and `docList` are interpolated. */
    selectDocs: (topic: string, docList: string) => string
    /** First-round hint (focus vs open). */
    roundHintFirst: { focus: string; open: string }
    /** Later-round hint. */
    roundHintLater: string
    /** Closing instruction for a speaking turn (focus vs open). `name` interpolated. */
    speakClosing: { focus: (name: string) => string; open: (name: string) => string }
    /** Assemble the user message for a speaking turn. */
    speakUser: (parts: {
      context?: string
      focus?: string
      topic: string
      priorBlock: string
      roundHint: string
      closing: string
    }) => string
    /** Proposal-round user message. `name` interpolated. */
    proposalUser: (parts: { context?: string; topic: string; name: string }) => string
    /** Moderator summary system prompt (focus vs open). */
    summarySystem: { focus: string; open: string }
    /** Moderator summary user message. */
    summaryUser: (parts: { focus?: string; topic: string; transcript: string }) => string
    /** Merge-into-codex system prompt. */
    mergeSystem: string
    /** Merge-into-codex user message. */
    mergeUser: (parts: { title: string; original: string; topic: string; conclusion: string }) => string
    /** Label shown as the empty-doc placeholder inside merge/other prompts. */
    emptyDoc: string
    /** Preset topic templates shown as quick-start buttons in the Writers' Room. */
    topicTemplates: Array<{ id: string; label: string; icon: string; prompt: string }>
  }

  /** World generation (one-line prompt or seed files). */
  world: {
    system: string
    fromPrompt: (prompt: string) => string
    fromSeed: (seed: string) => string
  }
}
