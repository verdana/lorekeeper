import type { SceneCard, SettingDoc, TimelineEvent } from './types'

export const EMPTY_SCENE_CARD: SceneCard = {
  pov: '',
  dateLabel: '',
  locationId: null,
  participantIds: [],
  purpose: '',
  conflict: '',
  unresolvedThreads: [],
  writingTarget: '',
  timelineEventId: null,
}

/** Render concise author-authored scene direction for context and relevance matching. */
export function buildSceneCardContext(
  scene: SceneCard | undefined,
  settings: SettingDoc[],
  events: TimelineEvent[],
): string {
  if (!scene) return ''
  const titleFor = (id: string | null): string => settings.find((doc) => doc.id === id)?.title ?? ''
  const participants = scene.participantIds.map((id) => titleFor(id)).filter(Boolean)
  const event = events.find((item) => item.id === scene.timelineEventId)
  const lines = [
    scene.pov && `POV: ${scene.pov}`,
    scene.dateLabel && `Story date: ${scene.dateLabel}`,
    titleFor(scene.locationId) && `Location: ${titleFor(scene.locationId)}`,
    participants.length > 0 && `Participants: ${participants.join(', ')}`,
    scene.purpose && `Purpose: ${scene.purpose}`,
    scene.conflict && `Conflict: ${scene.conflict}`,
    scene.unresolvedThreads.length > 0 && `Open threads: ${scene.unresolvedThreads.join('; ')}`,
    scene.writingTarget && `Writing target: ${scene.writingTarget}`,
    event && `Timeline event: ${event.title}`,
  ].filter(Boolean)
  return lines.length > 0 ? `## Scene card\n${lines.map((line) => `- ${line}`).join('\n')}` : ''
}
