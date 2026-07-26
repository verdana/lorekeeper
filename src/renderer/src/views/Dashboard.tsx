import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { CATEGORY_LABELS, CATEGORY_ORDER } from '../lib'
import { Save, FolderOpen, Download } from 'lucide-react'
import type { NovelMeta, SettingCategory } from '@shared/types'
import { toastError, toastSuccess } from '../toast'

export default function Dashboard(): JSX.Element {
  const novel = useStore((s) => s.novel)!
  const saveNovel = useStore((s) => s.saveNovel)
  const settingDocs = useStore((s) => s.settingDocs)

  const [title, setTitle] = useState(novel.title)
  const [author, setAuthor] = useState(novel.author)
  const [synopsis, setSynopsis] = useState(novel.synopsis)
  const [tags, setTags] = useState(novel.tags.join(', '))
  const [projectPath, setProjectPath] = useState('')
  const [saved, setSaved] = useState(false)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    window.api.getProjectPath().then(setProjectPath)
  }, [])

  const buildMeta = (): NovelMeta => ({
    ...novel,
    title: title.trim() || 'Untitled',
    author,
    synopsis,
    tags: tags
      .split(/[、,，\s]+/)
      .map((t) => t.trim())
      .filter(Boolean)
  })

  // Holds latest form fields for flushing unsaved changes on unmount. Mirrors raw fields,
  // 卸载那一刻才构造 meta，避免每次Render.都白跑一遍 buildMeta。
  const flushRef = useRef({ title, author, synopsis, tags, dirty })
  flushRef.current = { title, author, synopsis, tags, dirty }
  useEffect(() => {
    return () => {
      const s = flushRef.current
      if (!s.dirty) return
      saveNovel({
        ...novel,
        title: s.title.trim() || 'Untitled',
        author: s.author,
        synopsis: s.synopsis,
        tags: s.tags
          .split(/[、,，\s]+/)
          .map((t) => t.trim())
          .filter(Boolean)
      })
    }
  }, [])

  const totalChapters = novel.volumes.reduce((n, v) => n + v.chapters.length, 0)
  const doneChapters = novel.volumes.reduce(
    (n, v) => n + v.chapters.filter((c) => c.status === 'done').length,
    0
  )
  const totalWords = novel.volumes.reduce(
    (n, v) => n + v.chapters.reduce((m, c) => m + c.wordCount, 0),
    0
  )

  const countByCat = (cat: SettingCategory): number =>
    settingDocs.filter((d) => d.category === cat).length

  const handleSave = async (): Promise<void> => {
    await saveNovel(buildMeta())
    setDirty(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  // 一键导出全书：走旁路端点下载 zip，浏览器原生保存。用 anchor + Content-Disposition 拿文件名。
  const [exporting, setExporting] = useState(false)
  const handleExport = async (): Promise<void> => {
    setExporting(true)
    try {
      const resp = await fetch('/api/exportWorld')
      if (!resp.ok) throw new Error(`Export failed (${resp.status})`)
      const blob = await resp.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${(title.trim() || 'world').replace(/[/\\:*?"<>|]/g, '_')}.zip`
      a.click()
      URL.revokeObjectURL(url)
      toastSuccess('World exported.')
    } catch (e) {
      toastError('Export failed: ' + (e as Error).message)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-8 py-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-semibold text-ink-deep">Overview</h1>
          <div className="flex items-center gap-2">
            {dirty && <span className="text-xs text-star-accent mr-1">● Unsaved</span>}
            <button onClick={handleExport} disabled={exporting} className="btn btn-secondary">
              <Download size={16} />
              {exporting ? 'Exporting…' : 'Export book'}
            </button>
            <button onClick={handleSave} disabled={!dirty && !saved} className="btn btn-primary">
              <Save size={16} />
              {saved && !dirty ? 'Saved' : 'Save'}
            </button>
          </div>
        </div>

        {/* 统计卡 */}
        <div className="grid grid-cols-3 gap-4 mb-8">
          <StatCard label="Volumes" value={novel.volumes.length} />
          <StatCard
            label="Chapters"
            value={totalChapters}
            sub={totalChapters > 0 ? `${doneChapters} finalized` : undefined}
          />
          <StatCard label="Words" value={totalWords.toLocaleString()} />
        </div>

        {/* 基本信息 */}
        <section className="card p-6 space-y-4 mb-6">
          <h2 className="text-sm font-medium text-ink-muted">Basic info</h2>
          <Field label="Title">
            <input
              className="input"
              value={title}
              onChange={(e) => {
                setTitle(e.target.value)
                setDirty(true)
              }}
            />
          </Field>
          <Field label="Author">
            <input
              className="input"
              value={author}
              placeholder="Pen name"
              onChange={(e) => {
                setAuthor(e.target.value)
                setDirty(true)
              }}
            />
          </Field>
          <Field label="Tags">
            <input
              className="input"
              value={tags}
              placeholder="Separate with commas"
              onChange={(e) => {
                setTags(e.target.value)
                setDirty(true)
              }}
            />
          </Field>
          <Field label="Synopsis">
            <textarea
              className="textarea min-h-30"
              value={synopsis}
              onChange={(e) => {
                setSynopsis(e.target.value)
                setDirty(true)
              }}
            />
          </Field>
        </section>

        {/* 设定库概览 */}
        <section className="card p-6 mb-6">
          <h2 className="text-sm font-medium text-ink-muted mb-4">Codex overview</h2>
          <div className="grid grid-cols-3 gap-3">
            {CATEGORY_ORDER.map((cat) => (
              <div
                key={cat}
                className="card-muted flex items-center justify-between"
              >
                <span className="text-sm text-ink-faint">{CATEGORY_LABELS[cat]}</span>
                <span className="text-sm font-semibold text-ink-body">{countByCat(cat)}</span>
              </div>
            ))}
          </div>
        </section>

        <div className="card-muted flex items-center gap-2 text-xs text-ink-500">
          <FolderOpen size={14} />
          <span className="truncate">Data directory: {projectPath}</span>
        </div>
      </div>
    </div>
  )
}

function StatCard({
  label,
  value,
  sub
}: {
  label: string
  value: string | number
  sub?: string
}): JSX.Element {
  return (
    <div className="card px-5 py-4">
      <div className="text-2xl font-semibold text-ink-deep">{value}</div>
      <div className="text-xs text-ink-500 mt-1">{label}</div>
      {sub && <div className="text-[11px] text-star-success mt-0.5">{sub}</div>}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="block">
      <span className="block text-xs text-ink-500 mb-1.5">{label}</span>
      {children}
    </label>
  )
}
