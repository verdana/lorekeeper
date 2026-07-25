import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import MarkdownEditor from '../components/MarkdownEditor'
import { List, Maximize2, Minimize2 } from 'lucide-react'

export default function Outline(): JSX.Element {
  const novel = useStore((s) => s.novel)!

  const [content, setContent] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [zen, setZen] = useState(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  // 加载Outline.内容；首次打开时若为空则自动生成骨架
  useEffect(() => {
    window.api.readOutline().then((text: string) => {
      if (text.trim()) {
        setContent(text)
      } else {
        setContent(buildSkeleton(novel))
      }
      setLoaded(true)
    })
  }, [])

  const save = (text: string): void => {
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      window.api.writeOutline(text)
    }, 2000)
  }

  const onChange = (v: string): void => {
    setContent(v)
    save(v)
  }

  // Ctrl+S 立即保存
  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        clearTimeout(saveTimer.current)
        window.api.writeOutline(content)
      }
      if (e.key === 'Escape' && zen) setZen(false)
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  })

  // 卸载前 flush
  useEffect(() => {
    return () => {
      clearTimeout(saveTimer.current)
    }
  }, [])

  if (!loaded) return <div className="h-full flex items-center justify-center text-ink-500">Loading…</div>

  // 禅模式：全屏只留编辑器
  if (zen) {
    return (
      <div className="h-full flex flex-col bg-ink-950">
        <div className="flex items-center justify-between px-6 py-2 text-xs text-ink-500">
          <span>Outline</span>
          <button
            onClick={() => setZen(false)}
            className="icon-btn flex items-center gap-1 hover:text-slate-800 text-xs"
            title="Exit zen mode"
          >
            <Minimize2 size={13} /> Exit Zen (Esc)
          </button>
        </div>
        <div className="flex-1 min-h-0">
          <MarkdownEditor value={content} onChange={onChange} defaultMode="read" zen />
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center px-6 py-3 border-b border-ink-800">
        <h2 className="text-sm font-semibold text-slate-800 flex items-center gap-2">
          <List size={16} /> Outline
        </h2>
        <div className="ml-auto flex items-center gap-3">
          <span className="text-[11px] text-ink-500">
            {content.length.toLocaleString()} chars
          </span>
          <button onClick={() => setZen(true)} className="btn btn-sm btn-ghost">
            <Maximize2 size={15} /> Zen
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0">
        <MarkdownEditor value={content} onChange={onChange} defaultMode="read" />
      </div>
    </div>
  )
}

/** 从Volume.章结构生成初始Outline.骨架：`# Volume` 下每个 `## Chapter`，中间空行留给概述。 */
function buildSkeleton(novel: { volumes: { title: string; chapters: { id: string; title: string }[] }[] }): string {
  const lines: string[] = []
  for (const vol of novel.volumes) {
    lines.push(`# ${vol.title}`)
    lines.push('')
    for (const ch of vol.chapters) {
      lines.push(`## ${ch.title}`)
      lines.push('')
    }
  }
  return lines.join('\n')
}
