import type { StoryMemoryKind } from '@shared/types'

/**
 * Types shared by the Writers' Room view and its parts.
 *
 * They describe one discussion's shape — which mode it is in, where its rounds
 * start in the transcript, and what a pending codex merge carries — so they live
 * beside the view rather than in the shared data contract.
 */

export type Mode = 'diverge' | 'converge'

export interface RoundAnchor {
  round: number
  messageId: string
  isUser: boolean
  userText: string | null
}

export interface MergeState {
  conclusion: string
  topic: string
  docId: string
  providerId?: string
  original: string
  merged: string
  phase: 'pick' | 'generating' | 'preview'
  /** 结论的附加分发目标(除写入 codex 外)。 */
  distribute: {
    timeline: boolean
    timelineTitle: string
    timelineDate: string
    memory: boolean
    memoryKind: StoryMemoryKind
    memoryStatement: string
  }
}
