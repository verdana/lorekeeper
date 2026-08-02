import { useEffect, useState } from 'react'
import { useStore, type ViewKey } from '../store'
import {
  BookMarked,
  Library,
  GitFork,
  ScrollText,
  Users,
  ShieldCheck,
  History,
  Settings,
  Orbit,
  ChevronLeft,
  List,
  Clock,
  Mic,
  MessageCircle,
  Sparkles,
  Brain,
  PanelLeftClose,
  PanelLeftOpen,
  ClipboardList,
} from 'lucide-react'
import clsx from 'clsx'

const NAV: { key: ViewKey; label: string; icon: React.ComponentType<{ size?: number }> }[] = [
  { key: 'dashboard', label: 'Overview', icon: BookMarked },
  { key: 'settings-docs', label: 'Codex', icon: Library },
  { key: 'graph', label: 'Graph', icon: GitFork },
  { key: 'timeline', label: 'Timeline', icon: Clock },
  { key: 'story-memory', label: 'Story Memory', icon: Brain },
  { key: 'outline', label: 'Outline', icon: List },
  { key: 'chapters', label: 'Manuscript', icon: ScrollText },
  { key: 'deslop', label: 'De-slop', icon: Sparkles },
  { key: 'consistency', label: 'Consistency', icon: ShieldCheck },
  { key: 'review-queue', label: 'Review Queue', icon: ClipboardList },
  { key: 'discussion', label: 'Writers Room', icon: Users },
  { key: 'history', label: 'History', icon: History },
  { key: 'voice-profile', label: 'Voice', icon: Mic },
  { key: 'character-chat', label: 'Characters', icon: MessageCircle },
  { key: 'preferences', label: 'Settings', icon: Settings },
]

export default function Sidebar(): JSX.Element {
  const [collapsed, setCollapsed] = useState(false)
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const novel = useStore((s) => s.novel)
  const enterWorldGate = useStore((s) => s.enterWorldGate)

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') {
        event.preventDefault()
        setCollapsed((current) => !current)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  return (
    <nav
      className={clsx(
        'shrink-0 bg-ink-900 border-r border-ink-800 flex flex-col overflow-hidden transition-[width] duration-200',
        collapsed ? 'w-14' : 'w-52',
      )}
    >
      <div
        className={clsx(
          'relative h-[47px] shrink-0 px-4 py-3 flex items-center border-b border-ink-800 bg-ink-850',
          collapsed ? 'justify-center px-2' : 'gap-2.5',
        )}
      >
        <Orbit className={clsx('text-star-accent', collapsed && 'hidden')} size={22} />
        <div className={clsx('leading-tight min-w-0', collapsed && 'hidden')}>
          <div className="text-sm font-mono font-bold uppercase tracking-wider text-ink-deep">
            Lorekeeper
          </div>
          <div className="text-[11px] text-ink-500">Writing Studio</div>
        </div>
        <button
          onClick={() => setCollapsed((current) => !current)}
          className={clsx(
            'icon-btn text-ink-500 hover:text-star-accent',
            collapsed
              ? 'absolute left-3 top-1/2 -translate-y-1/2'
              : 'absolute right-2 top-1/2 -translate-y-1/2',
          )}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar (Ctrl+B)' : 'Collapse sidebar (Ctrl+B)'}
        >
          {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </button>
      </div>

      <button
        onClick={enterWorldGate}
        className={clsx(
          'group mx-2 mt-2 flex items-center rounded-md text-xs text-ink-faint hover:bg-ink-850 hover:text-ink-body transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-star-accent/40',
          collapsed ? 'justify-center px-0 py-2' : 'gap-2 px-3 py-2',
        )}
        aria-label="All worlds"
        title={collapsed ? 'All worlds' : undefined}
      >
        <ChevronLeft size={15} className="transition-transform group-hover:-translate-x-0.5" />
        <span className={clsx(collapsed && 'hidden')}>All worlds</span>
      </button>

      <div className="flex-1 py-3 px-2 space-y-0.5">
        {NAV.map(({ key, label, icon: Icon }) => {
          const active = view === key
          return (
            <button
              key={key}
              onClick={() => setView(key)}
              aria-label={label}
              title={collapsed ? label : undefined}
              className={clsx(
                // Keep the active indicator independent from the item content spacing.
                'group relative w-full flex items-center rounded-md text-sm',
                collapsed ? 'justify-center px-0 py-2.5' : 'gap-3 pl-4 pr-3 py-2.5',
                'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-star-accent/40',
                active
                  ? 'bg-ink-body text-white shadow-[0_2px_8px_rgba(59,47,36,0.12)]'
                  : 'text-ink-faint hover:bg-ink-850 hover:text-ink-body',
              )}
            >
              {/* Warm orange active indicator; transparent when inactive. */}
              <span
                aria-hidden
                className={clsx(
                  'absolute left-0 top-1.5 bottom-1.5 w-0.75 rounded-r-full transition-colors',
                  active ? 'bg-star-accent' : 'bg-transparent',
                )}
              />
              <Icon size={17} />
              <span className={clsx('truncate', collapsed && 'hidden')}>{label}</span>
            </button>
          )
        })}
      </div>

      <div
        className={clsx(
          'border-t border-ink-800 text-[11px] text-ink-500 truncate',
          collapsed ? 'px-2 py-3 text-center' : 'px-4 py-3',
        )}
        title={collapsed ? (novel?.title ?? 'Untitled') : undefined}
      >
        <span className={clsx(collapsed && 'hidden')}>{novel?.title ?? 'Untitled'}</span>
      </div>
    </nav>
  )
}
