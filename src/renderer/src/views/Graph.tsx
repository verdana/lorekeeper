import { useEffect, useRef } from 'react'
import { useStore } from '../store'
import { extractWikilinks, resolveWikilink, CATEGORY_COLORS, CATEGORY_LABELS } from '../lib'
import { GitFork } from 'lucide-react'

export default function Graph(): JSX.Element {
  const settingDocs = useStore((s) => s.settingDocs)
  const containerRef = useRef<HTMLDivElement>(null)
  const networkRef = useRef<any>(null)

  useEffect(() => {
    if (!containerRef.current || settingDocs.length === 0) return

    let cancelled = false

    ;(async () => {
      const visNetwork = await import('vis-network')
      const visData = await import('vis-data')
      const { Network } = visNetwork
      const { DataSet } = visData

      if (cancelled || !containerRef.current) return

      // Read all docs and extract wikilinks
      const docContents = new Map<string, string>()
      for (const doc of settingDocs) {
        try {
          const { content } = await window.api.readSetting(doc.id)
          docContents.set(doc.id, content)
        } catch {
          docContents.set(doc.id, '')
        }
      }

      // Build nodes
      const nodes = new (DataSet as any)(
        settingDocs.map((doc: any) => {
          const cat = doc.category as keyof typeof CATEGORY_COLORS
          const color = CATEGORY_COLORS[cat] || '#A89676'
          return {
            id: doc.id,
            label: doc.title,
            color: {
              background: color,
              border: color,
            },
            borderWidthSelected: 2,
            font: { color: '#3B2F24', size: 12 },
            size: 24,
            shape: 'dot',
            group: cat,
          }
        }),
      )

      // Build edges from wikilinks
      const edgeSet = new Set<string>()
      const edges = new (DataSet as any)()
      for (const [docId, content] of docContents) {
        const refs = extractWikilinks(content)
        for (const refTitle of refs) {
          const target = resolveWikilink(refTitle, settingDocs)
          if (target && target.id !== docId) {
            const key = [docId, target.id].sort().join('::')
            if (!edgeSet.has(key)) {
              edgeSet.add(key)
              edges.add({ from: docId, to: target.id, color: '#D4C8B8', width: 1 })
            }
          }
        }
      }

      const data: any = { nodes, edges }
      const options: any = {
        physics: {
          solver: 'forceAtlas2Based',
          forceAtlas2Based: {
            gravitationalConstant: -40,
            centralGravity: 0.005,
            springLength: 200,
            springConstant: 0.02,
          },
          stabilization: { iterations: 100 },
        },
        interaction: {
          hover: false,
          zoomView: true,
          dragView: true,
        },
        nodes: {
          font: {
            color: '#3B2F24',
            size: 12,
            face: '-apple-system, BlinkMacSystemFont, sans-serif',
          },
          borderWidth: 1,
          borderWidthSelected: 2,
        },
        groups: Object.fromEntries(
          (['worldview', 'character', 'geography', 'economy', 'outline', 'misc'] as const).map(
            (cat) => [
              cat,
              { color: { background: CATEGORY_COLORS[cat], border: CATEGORY_COLORS[cat] } },
            ],
          ),
        ),
      }

      const network = new (Network as any)(containerRef.current!, data, options)
      networkRef.current = network

      // Freeze physics after initial stabilization to prevent hover-induced re-layout
      network.once('stabilizationIterationsDone', () => {
        network.setOptions({ physics: { enabled: false } })
      })

      network.on('doubleClick', (params: any) => {
        if (params.nodes.length > 0) {
          const nodeId = params.nodes[0]
          useStore.getState().setView('settings-docs')
          window.dispatchEvent(new CustomEvent('codex-navigate', { detail: { docId: nodeId } }))
        }
      })
    })()

    return () => {
      networkRef.current?.destroy()
      networkRef.current = null
      cancelled = true
    }
  }, [settingDocs])

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-6 py-3 border-b border-ink-800 shrink-0">
        <GitFork size={16} className="text-ink-muted" />
        <h2 className="text-sm font-semibold text-ink-body">Codex Graph</h2>
        <span className="ml-auto text-[11px] text-ink-500">
          {settingDocs.length} nodes · Double-click a node to open
        </span>
      </div>
      <div ref={containerRef} className="flex-1 bg-ink-950" />
    </div>
  )
}
