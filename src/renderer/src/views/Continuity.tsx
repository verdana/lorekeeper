import { useStore } from '../store'
import ChapterMemory from './ChapterMemory'
import StoryMemory from './StoryMemory'
import { Brain, BrainCircuit, ListTree } from 'lucide-react'
import clsx from 'clsx'

/**
 * Continuity workspace.
 *
 * Two sides of the same question — "what is true in this story right now?" —
 * used to live in two sidebar entries whose names did not tell you which to
 * open: **Story state** is what the AI derived chapter by chapter (summaries and
 * the accumulated state archive, rebuilt automatically), while **Facts** is
 * what the author confirmed and curated by hand. Both feed the writing prompts.
 *
 * They stay separate surfaces because they are edited differently, but they are
 * one destination now: the tabs reuse the old view keys, so every deep link
 * (`openStoryMemory(chapterId)`, `openChapterMemory(chapterId)`) still lands on
 * the right tab with its chapter selected.
 */
export default function Continuity({ tab }: { tab: 'facts' | 'state' }): JSX.Element {
  const setView = useStore((s) => s.setView)
  const storyFocusChapterId = useStore((s) => s.storyMemoryFocusChapterId)
  const chapterFocusChapterId = useStore((s) => s.chapterMemoryFocusChapterId)
  const focusChapterId = tab === 'facts' ? storyFocusChapterId : chapterFocusChapterId

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="shrink-0 px-8 pt-6 pb-3 border-b border-ink-800 bg-ink-900/40">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-xl font-semibold text-ink-deep flex items-center gap-2">
              <ListTree size={20} /> Continuity
            </h1>
            <p className="text-[13px] text-ink-500 mt-1">
              Everything the book must stay true to. Both tabs are fed into the writing prompts.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <TabButton
              active={tab === 'state'}
              icon={BrainCircuit}
              label="Story state"
              hint="Chapter summaries and the state archive — derived automatically after every chapter"
              onClick={() => setView('chapter-memory')}
            />
            <TabButton
              active={tab === 'facts'}
              icon={Brain}
              label="Facts"
              hint="Durable facts you have reviewed and confirmed by hand"
              onClick={() => setView('story-memory')}
            />
          </div>
        </div>
        {focusChapterId && (
          <p className="text-[11px] text-star-accent mt-2">Showing the selected chapter.</p>
        )}
      </div>
      <div className="flex-1 min-h-0">{tab === 'facts' ? <StoryMemory /> : <ChapterMemory />}</div>
    </div>
  )
}

function TabButton({
  active,
  icon: Icon,
  label,
  hint,
  onClick,
}: {
  active: boolean
  icon: React.ComponentType<{ size?: number }>
  label: string
  hint: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      title={hint}
      className={clsx(
        'flex items-center gap-2 rounded-md border px-3.5 py-2 text-[13px] font-medium transition-colors',
        active
          ? 'border-star-accent bg-star-accent/10 text-ink-deep'
          : 'border-ink-800 bg-ink-900 text-ink-subtle hover:border-ink-700 hover:text-ink-muted',
      )}
    >
      <Icon size={15} />
      {label}
    </button>
  )
}
