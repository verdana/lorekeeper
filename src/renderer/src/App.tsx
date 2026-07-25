import { useEffect } from 'react'
import { useStore } from './store'
import Sidebar from './components/Sidebar'
import Toaster from './components/Toast'
import Dashboard from './views/Dashboard'
import SettingsDocs from './views/SettingsDocs'
import Chapters from './views/Chapters'
import Discussion from './views/Discussion'
import Consistency from './views/Consistency'
import History from './views/History'
import Outline from './views/Outline'
import Preferences from './views/Preferences'
import WorldGate from './views/WorldGate'

export default function App(): JSX.Element {
  const view = useStore((s) => s.view)
  const loadAll = useStore((s) => s.loadAll)
  const novel = useStore((s) => s.novel)
  const atWorldGate = useStore((s) => s.atWorldGate)

  useEffect(() => {
    loadAll()
  }, [loadAll])

  if (atWorldGate) {
    return (
      <div className="h-full flex flex-col">
        <div className="drag h-[40px] shrink-0 bg-ink-850 border-b border-ink-800" />
        <div className="flex-1 min-h-0 overflow-y-auto">
          <WorldGate />
        </div>
      </div>
    )
  }

  if (!novel) {
    return (
      <div className="h-full flex flex-col">
        <div className="drag h-[40px] shrink-0 bg-ink-850 border-b border-ink-800" />
        <div className="flex-1 flex items-center justify-center text-ink-500">Loading project…</div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      {/* Full-width window drag region */}
      <div className="drag h-[40px] shrink-0 bg-ink-850 border-b border-ink-800" />
      <div className="flex flex-1 min-h-0">
        <Sidebar />
        <main className="flex-1 min-w-0 h-full overflow-hidden">
          {view === 'dashboard' && <Dashboard />}
          {view === 'settings-docs' && <SettingsDocs />}
          {view === 'chapters' && <Chapters />}
          {view === 'discussion' && <Discussion />}
          {view === 'consistency' && <Consistency />}
          {view === 'history' && <History />}
          {view === 'outline' && <Outline />}
          {view === 'preferences' && <Preferences />}
        </main>
        <Toaster />
      </div>
    </div>
  )
}
