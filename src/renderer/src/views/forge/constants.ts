/**
 * Static choices and small formatters for the Forge view.
 *
 * The theme ideas are examples, not templates: the whole pipeline keys off the
 * author's theme, so the presets and genre/tone lists exist to make the empty
 * form less blank, never to constrain what can be forged.
 */

import type { ForgeRun } from '@shared/types'

export const THEME_IDEAS: { label: string; theme: string; genre: string }[] = [
  {
    label: 'Memory market',
    genre: 'Science fiction',
    theme:
      'A city where memories are bought and sold. A broker who has sold every memory of her own past must recover one she never sold — because someone else is living it.',
  },
  {
    label: 'Letters that come true',
    genre: 'Historical fantasy',
    theme:
      'The boy who writes other people’s last letters discovers that every letter he finishes comes true within the week — and the army has just hired him.',
  },
  {
    label: 'Dying magic',
    genre: 'Western fantasy',
    theme:
      'Magic is dying because the gods who granted it are being murdered one by one. The last living god wants the killer found before the killer reaches him.',
  },
  {
    label: 'Debt of the dead',
    genre: 'Mystery',
    theme:
      'Debts are inherited in this town, along with the dead. A clerk who catalogues inheritances finds her own name in a ledger dated thirty years before she was born.',
  },
  {
    label: 'The quiet invasion',
    genre: 'Literary science fiction',
    theme:
      'The invasion did not arrive with ships. It arrived as a convenience everyone chose, and the only person who remembers what the city was like before is a night-shift archivist.',
  },
  {
    label: 'Cultivation without a sect',
    genre: 'Xianxia',
    theme:
      'A cook in a cultivator’s inn learns the art by watching guests eat — until a dying swordsman leaves her a debt that the whole mountain wants paid in blood.',
  },
  {
    label: 'Weather witch',
    genre: 'Folk fantasy',
    theme:
      'Every storm over the valley is the temper of the woman who lives in the lighthouse. When she falls in love, the valley has to decide whether it can survive twelve months of calm.',
  },
  {
    label: 'The last translator',
    genre: 'Dying-earth',
    theme:
      'Language is failing globally, one grammar at a time. A translator who still dreams in two tongues is the last person able to negotiate with whatever is doing it.',
  },
]

export const GENRE_PRESETS = [
  'Fantasy',
  'Science fiction',
  'Mystery',
  'Romance',
  'Historical',
  'Wuxia / Xianxia',
  'Horror',
  'Literary',
]

export const TONE_PRESETS = [
  'Dark and literary',
  'Hopeful',
  'Melancholy',
  'Epic and sweeping',
  'Wry and comic',
  'Bleak and clinical',
]

export const statusStyle: Record<ForgeRun['status'], { label: string; className: string }> = {
  running: { label: 'Running', className: 'bg-star-info/10 text-star-info border-star-info/30' },
  paused: {
    label: 'Paused',
    className: 'bg-star-accent/10 text-star-accent border-star-accent/30',
  },
  completed: {
    label: 'Complete',
    className: 'bg-star-success/10 text-star-success border-star-success/30',
  },
  failed: {
    label: 'Failed',
    className: 'bg-star-danger/10 text-star-danger border-star-danger/30',
  },
  cancelled: { label: 'Cancelled', className: 'bg-ink-850 text-ink-500 border-ink-700' },
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`
  return `${s}s`
}

export const nf = (n: number): string => n.toLocaleString('en-US')
