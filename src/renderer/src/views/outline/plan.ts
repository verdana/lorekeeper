/**
 * Reading the plan: chapter ordinals across the whole book, the parser for what
 * the planning model returns, and the vocabulary a volume's status is shown in.
 *
 * The parser is tolerant and validates every field, because a truncated or
 * chatty answer must produce an empty draft rather than a corrupt outline.
 */

import type { ChapterContract, OutlineBeat, OutlineStore, OutlineVolumeStatus } from '@shared/types'
import { normalizeChapterContract } from '@shared/outlineStore'

/** 全局阅读序的章节编号（跨卷连续：卷1为第1-10章、卷2为第11-20章…）。 */
export function outlineOrdinalMap(store: OutlineStore): Map<string, number> {
  const map = new Map<string, number>()
  let n = 0
  for (const v of store.volumes) for (const c of v.chapters) map.set(c.id, ++n)
  return map
}

/** 规划模型返回的一章，尚未成为大纲数据。 */
export interface GeneratedChapter {
  title: string
  beats: OutlineBeat[]
  contract?: ChapterContract
}

/** 解析 AI 返回的章节 JSON，容错剥离代码围栏。 */
export function parseGeneratedChapters(raw: string): GeneratedChapter[] {
  let text = raw.trim()
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) text = fence[1].trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end !== -1) text = text.slice(start, end + 1)
  let obj: { chapters?: unknown }
  try {
    obj = JSON.parse(text) as { chapters?: unknown }
  } catch {
    throw new Error(
      'Failed to parse the generated outline — it may have been truncated. Retry, or switch to a more reliable model in Settings.',
    )
  }
  if (!Array.isArray(obj.chapters)) {
    throw new Error('The generated outline is incomplete (no chapters). Retry or switch models.')
  }
  return obj.chapters
    .map((raw) => {
      if (typeof raw !== 'object' || raw === null) return null
      const r = raw as Record<string, unknown>
      const title = typeof r.title === 'string' ? r.title.trim() : ''
      const beats = Array.isArray(r.beats)
        ? r.beats
            .map((b) => {
              if (typeof b !== 'object' || b === null) return null
              const br = b as Record<string, unknown>
              return {
                title: typeof br.title === 'string' ? br.title.trim() : '',
                summary: typeof br.summary === 'string' ? br.summary.trim() : '',
              }
            })
            .filter((b): b is OutlineBeat => b !== null)
        : []
      const contract = normalizeChapterContract(r.contract)
      if (!title) return null
      return { title, beats, ...(contract ? { contract } : {}) }
    })
    .filter((c): c is GeneratedChapter => c !== null)
}

export const STATUS_LABEL: Record<OutlineVolumeStatus, string> = {
  confirmed: 'Confirmed',
  planning: 'Planning',
  planned: 'Planned',
}

export const STATUS_STYLE: Record<
  OutlineVolumeStatus,
  { card: string; circle: string; badge: string; dot: string }
> = {
  confirmed: {
    card: 'border-star-success/60 bg-star-success/5',
    circle: 'bg-star-success text-white',
    badge: 'bg-star-success/15 text-star-success',
    dot: 'bg-star-success',
  },
  planning: {
    card: 'border-star-warm/40 bg-star-warm/5',
    circle: 'bg-star-warm text-white',
    badge: 'bg-star-warm/15 text-star-warm',
    dot: 'bg-star-warm',
  },
  planned: {
    card: 'border-ink-300 bg-white',
    circle: 'bg-ink-300 text-ink-600',
    badge: 'bg-ink-200/70 text-ink-500',
    dot: 'bg-ink-400',
  },
}

export const NEXT_STATUS: Record<OutlineVolumeStatus, OutlineVolumeStatus> = {
  planned: 'planning',
  planning: 'confirmed',
  confirmed: 'planned',
}
