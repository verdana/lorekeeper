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
    /** Built-in system prompt for outline-driven chapter writing. */
    outlinePrompt: string
    /** Built-in system prompt for rewriting an existing chapter (add/cut plot). */
    rewritePrompt: string

    /** Built-in system prompt for voice profile analysis. */
    voiceAnalysis: {
      systemPrompt: string
      userTemplate: (samples: string) => string
    }

    /**
     * Genre anchoring: maps the world's genre tag to a prose-register
     * directive injected into every writing-mode system prompt. Anchors the
     * model's role and vocabulary to the genre so a "Western fantasy" world
     * does not drift into wuxia phrasing. Empty genre returns ''.
     */
    genreAnchor: (genre: string) => string
    /** Preset genre choices offered on the Overview page (custom allowed). */
    genreOptions: string[]

    /** Style-exemplar block labels used to inject author-picked prose models. */
    exemplar: {
      /** Section heading, e.g. "Style exemplars". */
      header: string
      /** Instruction telling the model to imitate rhythm, not copy content. */
      instruction: string
      /** Hint shown in the editor when no exemplars exist yet. */
      emptyHint: string
    }

    /**
     * Prompt fragments used to assemble the writing-mode user messages
     * (outline-write / rewrite) and the polish selection label. Localized
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
        /** Author-written per-chapter beats, injected ahead of the long outline. */
        chapterBeats: string
        outline: string
        prevChapters: string
        chapter: string
        chapterTitlePrefix: string
        instructions: string
        defaultInstruction: string
      }
      /** Rewrite-writing user-message block (labels unique to rewrite). */
      rewrite: {
        chapter: string
        selectedChapter: string
        instructions: string
        defaultInstruction: string
      }
    }

    /**
     * Layered-memory section labels (current story state + recent/distant
     * chapter summaries) injected into the writing-mode user messages.
     */
    memory: {
      /** Section heading of the hard-constraint story-state block. */
      state: string
      /** One-line rule stating the state block is binding physical fact. */
      stateHint: string
      /** Per-character physical condition label (injuries, stamina, health). */
      condition: string
      /** Per-character location label. */
      location: string
      /** Per-character carried possessions / equipment label. */
      possessions: string
      /** Per-character goals label. */
      goals: string
      /** Per-character relations label. */
      relations: string
      /** Per-character knowledge label (what they know / must not know yet). */
      knows: string
      /** World-state label. */
      worldState: string
      /** Open-thread (unresolved foreshadowing) label. */
      openThreads: string
      /** Scene label for the end-of-chapter scene description. */
      currentScene: string
      /** Recent-chapter summaries section heading. */
      recent: string
      /** Distant-chapter one-line condensations section heading. */
      distant: string
      /** "Nothing here" placeholder for an empty memory section. */
      empty: string
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

  /** Structured-outline chapter/beat generation (Outline view "AI Generate"). */
  outline: {
    system: string
    /** Propose a chapter list (with beats) for a volume; returns JSON. */
    generateChapters: (params: {
      volumeTitle: string
      summary: string
      config: string
      /** Serialized beats of already-confirmed chapters, to stay consistent with. */
      confirmedContext: string
      instructions: string
      count: number
    }) => string
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
    }) => string
  }

  /** Extract a structured per-chapter summary for layered long-term memory. */
  chapterSummary: {
    systemPrompt: string
    userTemplate: (params: { chapterTitle: string; prose: string }) => string
  }

  /**
   * Novel Forge — the theme-driven whole-book pipeline. Every stage returns
   * JSON except `chapter`, which returns prose carrying a node-landing list
   * before the 【正文】 marker (the same convention the manuscript writer uses,
   * so beat coverage is anchored while drafting rather than reviewed after).
   */
  forge: {
    /** Language directive injected into every stage. `auto` = the pack's language. */
    languageDirective: Record<'auto' | 'zh' | 'en', string>
    /** Chapter-title shape for the chosen language, e.g. "第12章｜标题". */
    chapterTitleFormat: Record<'auto' | 'zh' | 'en', string>

    /** Stage 1 — theme → story concept. */
    concept: {
      system: string
      user: (params: ForgeConceptParams) => string
    }
    /** Stage 2 — concept → codex documents. */
    codex: {
      system: string
      user: (params: ForgeCodexParams) => string
    }
    /** Stage 3 — concept + codex → volumes, chapters and beats. */
    outline: {
      system: string
      user: (params: ForgeOutlineParams) => string
    }
    /**
     * Stage 3b — plan the next arc of an existing book. Used when the author
     * keeps going past the chapters the run started with.
     */
    expand: {
      system: string
      user: (params: ForgeExpandParams) => string
    }
    /**
     * Stage 3c — propose the scene blueprint for one chapter, just before it is
     * drafted: three to five scenes, each a causal step with a turn.
     */
    blueprint: {
      system: string
      user: (params: ForgeBlueprintParams) => string
    }
    /** Stage 4 — one chapter of prose. */
    chapter: {
      system: (params: ForgeChapterSystemParams) => string
      user: (params: ForgeChapterParams) => string
    }
    /** Stage 4b — one scene of a chapter, drafted on its own. */
    scene: {
      system: (params: ForgeSceneSystemParams) => string
      user: (params: ForgeSceneParams) => string
    }
    /** Stage 5 — non-destructive continuity review of the drafted chapters. */
    review: {
      system: string
      user: (params: ForgeReviewParams) => string
    }
  }
}

/** Parameters shared by the Forge planning stages. */
export interface ForgeBriefParams {
  theme: string
  /** Already-resolved output language directive (see `forge.languageDirective`). */
  languageDirective: string
  genre: string
  tone: string
  pov: string
  chapters: number
  wordsPerChapter: number
  constraints: string
  /** Chapter-title shape for the chosen language. */
  titleFormat: string
}

export type ForgeConceptParams = ForgeBriefParams

export interface ForgeCodexParams extends ForgeBriefParams {
  /** Serialized concept JSON. */
  concept: string
}

export interface ForgeOutlineParams extends ForgeCodexParams {
  /** Codex digest the outline must stay consistent with. */
  codex: string
}

export interface ForgeExpandParams {
  /** Serialized concept JSON. */
  concept: string
  /** Codex digest the new chapters must stay consistent with. */
  codex: string
  /** The last planned chapters (titles and beats), to continue from. */
  planTail: string
  /** What actually happened in the drafted prose, newest last. */
  storySoFar: string
  /** How many chapters to add. */
  count: number
  /** 1-based number the first new chapter must carry. */
  firstNumber: number
  titleFormat: string
  constraints: string
  languageDirective: string
}

export interface ForgeChapterSystemParams {
  chapterNumber: number
  totalChapters: number
  wordsPerChapter: number
  languageDirective: string
}

export interface ForgeChapterParams {
  /** Serialized concept (title, logline, tone, style guide). */
  concept: string
  chapterNumber: number
  totalChapters: number
  chapterTitle: string
  /** The chapter's beats plus its volume context and neighbour titles. */
  chapterPlan: string
  /** The scene blueprint as a numbered list, when the chapter has one. */
  scenes: string
  codex: string
  /** Hard-constraint story state carried over from earlier chapters. */
  storyState: string
  /** Condensed summaries of the immediately preceding chapters. */
  storySoFar: string
  /** Tail of the previous chapter's prose, for voice and continuity. */
  previousEnding: string
  /** Author voice profile / style exemplars, when the world has them. */
  voice: string
  /**
   * Author instructions that apply to this chapter ("stop resolving her memory
   * loss", "the sister appears here"). Binding: they override the plan where
   * the two disagree.
   */
  direction: string
  constraints: string
  languageDirective: string
  wordsPerChapter: number
}

export interface ForgeBlueprintParams {
  /** Serialized concept (title, logline, tone, style guide). */
  concept: string
  chapterNumber: number
  chapterTitle: string
  /** The chapter's beats, its volume context and its contract. */
  chapterPlan: string
  codex: string
  /** Hard-constraint story state carried over from earlier chapters. */
  storyState: string
  /** How the previous chapter ended, so the blueprint opens where it left off. */
  previousEnding: string
  /** Author instructions that apply to this chapter. */
  direction: string
  constraints: string
  languageDirective: string
  /** How many beats the chapter must land, so scenes can be told which ones. */
  beatCount: number
}

export interface ForgeSceneSystemParams {
  chapterNumber: number
  sceneNumber: number
  sceneCount: number
  wordsPerScene: number
  languageDirective: string
}

export interface ForgeSceneParams {
  concept: string
  chapterTitle: string
  chapterNumber: number
  /** 1-based position of this scene in the chapter. */
  sceneNumber: number
  /** The scene's own blueprint, in full. */
  scene: string
  /** The whole chapter's scene list, so the scene knows where it sits. */
  sceneList: string
  /** The chapter's beats and contract. */
  chapterPlan: string
  /** The previous scene's actual ending, or the previous chapter's if first. */
  previousEnding: string
  codex: string
  storyState: string
  voice: string
  direction: string
  constraints: string
  languageDirective: string
  wordsPerScene: number
}

export interface ForgeReviewParams {
  concept: string
  /** Chapter titles with their planned beats, in order. */
  chapterPlans: string
  /** Drafted prose, one block per chapter, truncated for budget. */
  prose: string
  constraints: string
  languageDirective: string
}
