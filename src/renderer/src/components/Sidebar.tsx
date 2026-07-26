import { useStore, type ViewKey } from '../store'
import {
  BookMarked,
  Library,
  ScrollText,
  Users,
  ShieldCheck,
  History,
  Settings,
  Orbit,
  ChevronLeft,
  List
} from 'lucide-react'
import clsx from 'clsx'

const NAV: { key: ViewKey; label: string; icon: React.ComponentType<{ size?: number }> }[] = [
  { key: 'dashboard', label: 'Overview', icon: BookMarked },
  { key: 'settings-docs', label: 'Codex', icon: Library },
  { key: 'discussion', label: "Writers Room", icon: Users },
  { key: 'consistency', label: 'Consistency', icon: ShieldCheck },
  { key: 'outline', label: 'Outline', icon: List },
  { key: 'chapters', label: 'Manuscript', icon: ScrollText },
  { key: 'history', label: 'History', icon: History },
  { key: 'preferences', label: 'Settings', icon: Settings }
]

export default function Sidebar(): JSX.Element {
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const novel = useStore((s) => s.novel)
  const enterWorldGate = useStore((s) => s.enterWorldGate)

  return (
    <nav className="w-52 shrink-0 bg-ink-900 border-r border-ink-800 flex flex-col">
      <div className="px-4 py-3 flex items-center gap-2.5 border-b border-ink-800 bg-ink-850">
        <Orbit className="text-star-accent" size={22} />
        <div className="leading-tight">
          <div className="text-sm font-mono font-bold uppercase tracking-wider text-ink-deep">Lorekeeper</div>
          <div className="text-[11px] text-ink-500">Writing Studio</div>
        </div>
      </div>

      <button
        onClick={enterWorldGate}
        className="group mx-2 mt-2 flex items-center gap-2 px-3 py-2 rounded-md text-xs text-ink-faint hover:bg-ink-850 hover:text-ink-body transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-star-accent/40"
      >
        <ChevronLeft size={15} className="transition-transform group-hover:-translate-x-0.5" />
        All worlds
      </button>

      <div className="flex-1 py-3 px-2 space-y-0.5">
        {NAV.map(({ key, label, icon: Icon }) => {
          const active = view === key
          return (
            <button
              key={key}
              onClick={() => setView(key)}
              className={clsx(
                // 左侧 3px 竖条指示 active,用 pseudo-like padding + before,不改 gap
                'group relative w-full flex items-center gap-3 pl-4 pr-3 py-2.5 rounded-md text-sm',
                'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-star-accent/40',
                active
                  ? 'bg-ink-body text-white shadow-[0_2px_8px_rgba(59,47,36,0.12)]'
                  : 'text-ink-faint hover:bg-ink-850 hover:text-ink-body'
              )}
            >
              {/* active 指示条:左侧暖橙细线;非 active 时透明,不占布局 */}
              <span
                aria-hidden
                className={clsx(
                  'absolute left-0 top-1.5 bottom-1.5 w-0.75 rounded-r-full transition-colors',
                  active ? 'bg-star-accent' : 'bg-transparent'
                )}
              />
              <Icon size={17} />
              {label}
            </button>
          )
        })}
      </div>

      <div className="px-4 py-3 border-t border-ink-800 text-[11px] text-ink-500 truncate">
        {novel?.title ?? 'Untitled'}
      </div>
    </nav>
  )
}
