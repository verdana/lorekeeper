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

    /** Built-in system prompt for voice profile analysis. */
    voiceAnalysis: {
      systemPrompt: string
      userTemplate: (samples: string) => string
    }

    /**
     * Prompt fragments used to assemble the writing-mode user messages
     * (outline-write / continue) and the polish selection label. Localized
     * with the rest of the pack so a Chinese pack never leaks Chinese
     * headings into an English session (and vice versa).
     */
    context: {
      /** Label shown instead of contextLabel when a text selection is polished. */
      selectedLabel: string
      /** Suffix appended to the polish title when a selection is active. */
      selectedTitleSuffix: string
      /** Generic "nothing here" placeholder used across the writing-mode blocks. */
      empty: string
      /** Outline-write user-message block. */
      outline: {
        codex: string
        timeline: string
        memories: string
        outline: string
        prevChapters: string
        chapter: string
        chapterTitlePrefix: string
        instructions: string
        defaultInstruction: string
      }
      /** Continue-writing user-message block. */
      continue: {
        prevTail: string
        direction: string
        defaultDirection: string
        codex: string
        timeline: string
        memories: string
        outline: string
        prevChapters: string
        emptyCodex: string
        emptyOutline: string
        emptyPrev: string
      }
    }
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
    mergeUser: (parts: {
      title: string
      original: string
      topic: string
      conclusion: string
    }) => string
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

  /** Cover prompt generation (image-generation prompt, not the image itself). */
  cover: {
    systemPrompt: string
    userTemplate: (params: {
      title: string
      genre: string
      synopsis: string
      tags: string[]
    }) => string
  }

  /** In-character character chat: turn a codex character entry into a persona. */
  characterChat: {
    systemPrompt: (params: { name: string; content: string }) => string
  }
  /** Extract reviewable, durable continuity facts from a saved chapter. */
  storyMemory: {
    systemPrompt: string
    userTemplate: (params: {
      chapterTitle: string
      prose: string
      entities: string
      timeline: string
      /** 场景卡关联事件提示;空串时不渲染该节。 */
      sceneHint: string
    }) => string
  }
  /** De-slop rewrite: anchor AI-text to human-like prose, guided by voice profile. */
  deslop: {
    systemPrompt: string
    userTemplate: (params: { sample: string; voice: string }) => string
  }
}
