// Shape of a full prompt pack. Both en.ts and zh.ts implement this so the two
// locales stay structurally identical; adding a key in one forces the other.

import type { RewriteIntensity } from '../types'

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
    /** Built-in system prompt for rewriting an existing chapter (add/cut plot). */
    rewritePrompt: string

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
      /** Rewrite-writing user-message block (labels unique to rewrite). */
      rewrite: {
        chapter: string
        selectedChapter: string
        instructions: string
        defaultInstruction: string
      }
      /** Workshop-report block (batch writing only). */
      discussion: {
        label: string
        empty: string
      }
    }

    /**
     * Batch writing (N chapters in one run). Dedicated system prompts —
     * the single-chapter continue/rewrite prompts forbid chapter headings and
     * are therefore unsuitable for batch runs. All user-message fragments are
     * localized here; engine code must never hardcode them.
     */
    batch: {
      /** Batch continue system prompt (write one complete chapter per turn). */
      continueSystemPrompt: string
      /** Batch rewrite system prompt (revise one complete chapter per turn). */
      rewriteSystemPrompt: string
      /** Default continuation direction when the user leaves it blank. */
      defaultDirection: string
      /** Label of the injected workshop-report section. */
      workshopReport: string
      /** Label for the report-derived, chapter-specific revision checklist. */
      workshopChecklist: string
      /** Non-negotiable instruction used when a rewrite has a workshop report. */
      workshopComplianceGate: (retry: boolean) => string
      /** Convert a report into concrete requirements for one selected chapter. */
      workshopPlanSystemPrompt: string
      workshopPlanUser: (input: { title: string; report: string; chapter: string }) => string
      /** Batch-instruction block for the i-th of n continue chapters. */
      batchInstructionContinue: (i: number, n: number, title: string) => string
      /** Batch-instruction block for the i-th of n rewrite chapters. */
      batchInstructionRewrite: (i: number, n: number, title: string) => string
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
    userTemplate: (params: {
      sample: string
      voice: string
      intensity: RewriteIntensity
      /** Optional instruction when the sample is a group of related sentences. */
      groupNote?: string
    }) => string
  }
}
