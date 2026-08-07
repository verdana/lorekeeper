import { useEffect } from 'react'
import { useStore } from './store'
import Sidebar from './components/Sidebar'
import ErrorBoundary from './components/ErrorBoundary'
import Toaster from './components/Toast'
import { isElectron } from './i18n'
import Dashboard from './views/Dashboard'
import SettingsDocs from './views/SettingsDocs'
import Chapters from './views/Chapters'
import Discussion from './views/Discussion'
import Consistency from './views/Consistency'
import History from './views/History'
import Timeline from './views/Timeline'
import Graph from './views/Graph'
import Outline from './views/Outline'
import VoiceProfile from './views/VoiceProfile'
import Preferences from './views/Preferences'
import WorldGate from './views/WorldGate'
import CharacterChat from './views/CharacterChat'
import StoryMemory from './views/StoryMemory'
import ReviewQueue from './views/ReviewQueue'
import CommandPalette from './components/CommandPalette'
import BatchWriteProgress from './components/BatchWriteProgress'

// The custom title bar / drag region only exists in the Electron desktop app
// (which hides the native title bar). In the browser (pnpm dev / web build)
// the OS/browser chrome handles the window, so we skip it.

function DragBar(): JSX.Element | null {
  if (!isElectron) return null
  return <div className="drag h-[40px] shrink-0 bg-ink-850 border-b border-ink-800" />
}

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
        <DragBar />
        <div className="flex-1 min-h-0 overflow-y-auto">
          <ErrorBoundary label="WorldGate">
            <WorldGate />
          </ErrorBoundary>
        </div>
      </div>
    )
  }

  if (!novel) {
    return (
      <div className="h-full flex flex-col">
        <DragBar />
        <div className="flex-1 flex items-center justify-center text-ink-500">Loading project…</div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      {/* Full-width window drag region (Electron only) */}
      <DragBar />
      <div className="flex flex-1 min-h-0">
        <Sidebar />
        <main className="flex-1 min-w-0 h-full overflow-hidden">
          <ErrorBoundary label={view}>
            {view === 'dashboard' && <Dashboard />}
            {view === 'settings-docs' && <SettingsDocs />}
            {view === 'chapters' && <Chapters />}
            {view === 'discussion' && <Discussion />}
            {view === 'consistency' && <Consistency />}
            {view === 'review-queue' && <ReviewQueue />}
            {view === 'history' && <History />}
            {view === 'timeline' && <Timeline />}
            {view === 'story-memory' && <StoryMemory />}
            {view === 'graph' && <Graph />}
            {view === 'outline' && <Outline />}
            {view === 'voice-profile' && <VoiceProfile />}
            {view === 'preferences' && <Preferences />}
            {view === 'character-chat' && <CharacterChat />}
          </ErrorBoundary>
        </main>
        <CommandPalette />
        <Toaster />
        <BatchWriteProgress />
      </div>
    </div>
  )
}
