/**
 * What the AI assist panel takes and what it hands back.
 *
 * Kept apart from the component so the panel's parts can be typed without
 * importing the component module itself.
 */
import type { AssistPreset } from './prompts'

export type AiMode = 'polish' | 'outline-write' | 'rewrite'

export interface Props {
  mode: AiMode
  content: string
  /** User’s text selection; when set, polish only the selection. */
  selectedText?: string
  chapterId: string
  chapterTitle: string
  /** Optionally override the preset in polish mode; defaults to SETTING_ASSIST. */
  polishPreset?: AssistPreset
  onInsert: (text: string, evidence?: GenerationInsertEvidence) => void
  onClose: () => void
}

export interface GenerationInsertEvidence {
  runId: string
  editingStartedAt: number
}
