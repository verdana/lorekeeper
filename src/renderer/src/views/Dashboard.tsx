import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { CATEGORY_LABELS, CATEGORY_ORDER } from '../lib'
import {
  Save,
  FolderOpen,
  Download,
  Globe,
  BookOpen,
  Image,
  ChevronDown,
  Plus,
  Trash2,
} from 'lucide-react'
import type { NovelMeta, SettingCategory } from '@shared/types'
import { toastError, toastSuccess, toastInfo } from '../toast'
import { PROMPTS } from '@shared/prompts'

export default function Dashboard(): JSX.Element {
  const novel = useStore((s) => s.novel)!
  const saveNovel = useStore((s) => s.saveNovel)
  const settingDocs = useStore((s) => s.settingDocs)
  const config = useStore((s) => s.config)
  const worlds = useStore((s) => s.worlds)
  const currentWorldId = useStore((s) => s.currentWorldId)
  const updateWorldMeta = useStore((s) => s.updateWorldMeta)
  const exemplars = useStore((s) => s.exemplars)
  const saveExemplars = useStore((s) => s.saveExemplars)

  const [title, setTitle] = useState(novel.title)
  const [author, setAuthor] = useState(novel.author)
  const [synopsis, setSynopsis] = useState(novel.synopsis)
  const [tags, setTags] = useState(novel.tags.slice(1).join(', '))
  // 题材单选：novel.tags[0] 与 world meta.genre 双向同步（AI 写作用它锚定语域）。
  // 优先以 world meta 为准——WorldGate 改过题材后 tags[0] 可能还是旧值。
  const [genre, setGenre] = useState(
    worlds.find((w) => w.id === currentWorldId)?.genre ?? novel.tags?.[0] ?? '',
  )
  const [exemplarDrafts, setExemplarDrafts] = useState<string[]>(exemplars.texts)
  const [projectPath, setProjectPath] = useState('')
  const [saved, setSaved] = useState(false)
  const [dirty, setDirty] = useState(false)

  // 外部加载/保存后同步 exemplar 草稿（编辑中不覆盖）。
  useEffect(() => {
    setExemplarDrafts(exemplars.texts)
  }, [exemplars])

  useEffect(() => {
    window.api.getProjectPath().then(setProjectPath)
  }, [])

  const buildMeta = useCallback((): NovelMeta => {
    const otherTags = tags
      .split(/[、,，\s]+/)
      .map((t) => t.trim())
      .filter(Boolean)
    return {
      ...novel,
      title: title.trim() || 'Untitled',
      author,
      synopsis,
      tags: genre ? [genre, ...otherTags.filter((t) => t !== genre)] : otherTags,
    }
  }, [novel, title, author, synopsis, tags, genre])

  // 一次性落盘：novel（含 genre→tags[0]）+ world meta（genre 同步）+ exemplars。
  const persistAll = useCallback(async (): Promise<void> => {
    const meta = buildMeta()
    await saveNovel(meta)
    const world = worlds.find((w) => w.id === currentWorldId)
    if (currentWorldId && world) {
      await updateWorldMeta({ title: meta.title, genre, coverColor: world.coverColor })
    }
    const nextExemplars = exemplarDrafts.map((t) => t.trim()).filter(Boolean)
    if (nextExemplars.join('\u0000') !== exemplars.texts.join('\u0000')) {
      await saveExemplars({ version: 1, texts: nextExemplars })
    }
  }, [
    buildMeta,
    worlds,
    currentWorldId,
    genre,
    exemplarDrafts,
    exemplars,
    saveNovel,
    updateWorldMeta,
    saveExemplars,
  ])

  // Mirror latest form state into a ref for async operations (debounce, beforeunload, unmount).
  // This lets effects read the most current values without adding render-cycle dependencies.
  const flushRef = useRef({ title, author, synopsis, tags, genre, exemplarDrafts, dirty })
  flushRef.current = { title, author, synopsis, tags, genre, exemplarDrafts, dirty }
  // beforeunload 闭包是首次渲染快照，用 ref 读取最新的 exemplars 以便对比。
  const exemplarsTextsRef = useRef(exemplars.texts)
  exemplarsTextsRef.current = exemplars.texts
  const persistAllRef = useRef(persistAll)
  persistAllRef.current = persistAll

  // Debounced auto-save: persist to disk 2 s after the last keystroke.
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    if (!dirty) return
    autoSaveTimer.current = setTimeout(async () => {
      try {
        await persistAll()
        setDirty(false)
        setSaved(true)
        setTimeout(() => setSaved(false), 1500)
      } catch {
        // auto-save failures are non-fatal; user can retry via the Save button
      }
    }, 2000)
    return () => clearTimeout(autoSaveTimer.current)
  }, [dirty, persistAll])

  // Flush unsaved changes on unmount (SPA view switch). Also clears the
  // pending auto-save to avoid saving stale data after the component is gone.
  useEffect(() => {
    return () => {
      clearTimeout(autoSaveTimer.current)
      if (flushRef.current.dirty) persistAllRef.current()
    }
  }, [])

  // Warn when closing the tab/window with unsaved changes and attempt a
  // last save via keepalive beacon (fire-and-forget).
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const s = flushRef.current
      if (!s.dirty) return
      const otherTags = s.tags
        .split(/[、,，\s]+/)
        .map((t) => t.trim())
        .filter(Boolean)
      const meta: NovelMeta = {
        ...novel,
        title: s.title.trim() || 'Untitled',
        author: s.author,
        synopsis: s.synopsis,
        tags: s.genre ? [s.genre, ...otherTags.filter((t) => t !== s.genre)] : otherTags,
      }
      // Fire-and-forget: the browser sends the request even after the page unloads.
      navigator.sendBeacon(
        '/api/saveNovelMeta',
        new Blob([JSON.stringify([meta])], { type: 'application/json' }),
      )
      // Exemplars ride along on a second beacon so close-time edits are not
      // lost (SPA navigation is covered by the unmount flush instead).
      const nextExemplars = s.exemplarDrafts.map((t) => t.trim()).filter(Boolean)
      if (nextExemplars.join('\u0000') !== exemplarsTextsRef.current.join('\u0000')) {
        navigator.sendBeacon(
          '/api/saveExemplars',
          new Blob([JSON.stringify([[{ version: 1, texts: nextExemplars }]])], {
            type: 'application/json',
          }),
        )
      }
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  const handleSave = async (): Promise<void> => {
    await persistAll()
    setDirty(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  // ---- Genre ----
  const genreOptions = PROMPTS.assist.genreOptions
  // 自定义模式显式跟踪：点「自定义」只进入编辑态（不提交占位值），
  // 输入框出现后由用户输入真正题材，避免把「自定义」三字存进设定。
  const [customMode, setCustomMode] = useState(genre !== '' && !genreOptions.includes(genre))
  const isCustomGenre = customMode || (genre !== '' && !genreOptions.includes(genre))
  const onGenreChange = (g: string): void => {
    const prev = flushRef.current.genre
    setGenre(g)
    setDirty(true)
    if (g !== prev && prev !== '') {
      toastInfo(`题材已切换为「${g}」。建议更新下方文风范例，让 AI 贴近新题材的语域。`)
    }
  }
  const selectPresetGenre = (g: string): void => {
    setCustomMode(false)
    onGenreChange(g)
  }
  const selectCustomGenre = (): void => setCustomMode(true)

  // ---- Style exemplars ----
  // Exemplar edits must mark the form dirty: all save paths (auto-save,
  // unmount flush, beforeunload, Save button) gate on `dirty`.
  const addExemplar = (): void => {
    setExemplarDrafts((d) => [...d, ''])
    setDirty(true)
  }
  const removeExemplar = (i: number): void => {
    setExemplarDrafts((d) => d.filter((_, idx) => idx !== i))
    setDirty(true)
  }
  const updateExemplar = (i: number, text: string): void => {
    setExemplarDrafts((d) => d.map((t, idx) => (idx === i ? text : t)))
    setDirty(true)
  }

  // Ctrl+S / Cmd+S keyboard shortcut to trigger an immediate save.
  const handleSaveRef = useRef(handleSave)
  handleSaveRef.current = handleSave
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        handleSaveRef.current()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const totalChapters = novel.volumes.reduce((n, v) => n + v.chapters.length, 0)
  const doneChapters = novel.volumes.reduce(
    (n, v) => n + v.chapters.filter((c) => c.status === 'done').length,
    0,
  )
  const totalWords = novel.volumes.reduce(
    (n, v) => n + v.chapters.reduce((m, c) => m + c.wordCount, 0),
    0,
  )

  const countByCat = (cat: SettingCategory): number =>
    settingDocs.filter((d) => d.category === cat).length

  // 一键导出全书：走旁路端点下载 zip，浏览器原生保存。用 anchor + Content-Disposition 拿文件名。
  const [exporting, setExporting] = useState(false)
  const [exportingWiki, setExportingWiki] = useState(false)
  const [exportingEpub, setExportingEpub] = useState(false)
  const [generatingCover, setGeneratingCover] = useState(false)
  const [coverPrompt, setCoverPrompt] = useState('')
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const exportMenuRef = useRef<HTMLDivElement>(null)
  const anyExporting = exporting || exportingWiki || exportingEpub

  // Close the export dropdown on outside click or Escape.
  useEffect(() => {
    if (!exportMenuOpen) return
    const onPointerDown = (e: MouseEvent): void => {
      if (!exportMenuRef.current?.contains(e.target as Node)) setExportMenuOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setExportMenuOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [exportMenuOpen])
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

  const handleExportWiki = async (): Promise<void> => {
    setExportingWiki(true)
    try {
      const resp = await fetch('/api/exportWiki')
      if (!resp.ok) throw new Error(`Wiki export failed (${resp.status})`)
      const blob = await resp.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${(title.trim() || 'world').replace(/[/\\:*?"<>|]/g, '_')}-wiki.html`
      a.click()
      URL.revokeObjectURL(url)
      toastSuccess('Codex wiki exported.')
    } catch (e) {
      toastError('Wiki export failed: ' + (e as Error).message)
    } finally {
      setExportingWiki(false)
    }
  }

  const handleExportEpub = async (): Promise<void> => {
    setExportingEpub(true)
    try {
      const resp = await fetch('/api/exportEpub')
      if (!resp.ok) throw new Error(`Epub export failed (${resp.status})`)
      const blob = await resp.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${(title.trim() || 'world').replace(/[/\\:*?"<>|]/g, '_')}.epub`
      a.click()
      URL.revokeObjectURL(url)
      toastSuccess('Epub exported.')
    } catch (e) {
      toastError('Epub export failed: ' + (e as Error).message)
    } finally {
      setExportingEpub(false)
    }
  }
  const handleGenerateCover = async (): Promise<void> => {
    if (generatingCover) return
    setGeneratingCover(true)
    setCoverPrompt('')
    try {
      const raw = await window.api.chat(
        [
          { role: 'system', content: PROMPTS.cover.systemPrompt },
          {
            role: 'user',
            content: PROMPTS.cover.userTemplate({
              title: title.trim() || 'Untitled',
              genre: novel.tags[0] || '',
              synopsis: synopsis.trim(),
              tags: novel.tags,
            }),
          },
        ],
        config?.ai.activeProviderId ?? undefined,
      )
      setCoverPrompt(raw.trim())
    } catch (e) {
      toastError('Cover prompt failed: ' + (e as Error).message)
    } finally {
      setGeneratingCover(false)
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-8 py-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-semibold text-ink-deep">Overview</h1>
          <div className="flex items-center gap-2">
            {dirty && <span className="text-xs text-star-accent mr-1">● Unsaved</span>}
            <div className="relative" ref={exportMenuRef}>
              <button
                onClick={() => setExportMenuOpen((o) => !o)}
                disabled={anyExporting}
                className="btn btn-secondary"
                aria-haspopup="menu"
                aria-expanded={exportMenuOpen}
              >
                <Download size={16} />
                {anyExporting ? 'Exporting…' : 'Export'}
                <ChevronDown
                  size={14}
                  className={`transition-transform ${exportMenuOpen ? 'rotate-180' : ''}`}
                />
              </button>
              {exportMenuOpen && (
                <div
                  role="menu"
                  className="absolute right-0 z-20 mt-1 w-48 overflow-hidden rounded-md border border-ink-800 bg-ink-850 py-1 shadow-lg"
                >
                  <button
                    role="menuitem"
                    onClick={() => {
                      setExportMenuOpen(false)
                      handleExport()
                    }}
                    disabled={anyExporting}
                    className="flex w-full items-center gap-2 px-3 py-2 text-sm text-ink-muted hover:bg-ink-800 disabled:opacity-45 disabled:cursor-not-allowed"
                  >
                    <Download size={15} />
                    {exporting ? 'Exporting…' : 'Export book'}
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => {
                      setExportMenuOpen(false)
                      handleExportWiki()
                    }}
                    disabled={anyExporting}
                    className="flex w-full items-center gap-2 px-3 py-2 text-sm text-ink-muted hover:bg-ink-800 disabled:opacity-45 disabled:cursor-not-allowed"
                  >
                    <Globe size={15} />
                    {exportingWiki ? 'Exporting…' : 'Export wiki'}
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => {
                      setExportMenuOpen(false)
                      handleExportEpub()
                    }}
                    disabled={anyExporting}
                    className="flex w-full items-center gap-2 px-3 py-2 text-sm text-ink-muted hover:bg-ink-800 disabled:opacity-45 disabled:cursor-not-allowed"
                  >
                    <BookOpen size={15} />
                    {exportingEpub ? 'Exporting…' : 'Export epub'}
                  </button>
                </div>
              )}
            </div>
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
              className="input disabled:opacity-60"
              value={title}
              onChange={(e) => {
                setTitle(e.target.value)
                setDirty(true)
              }}
            />
          </Field>
          <Field label="Author">
            <input
              className="input disabled:opacity-60"
              value={author}
              placeholder="Pen name"
              onChange={(e) => {
                setAuthor(e.target.value)
                setDirty(true)
              }}
            />
          </Field>
          <Field label="Genre">
            <div className="flex flex-wrap gap-2">
              {genreOptions.map((g) => (
                <label
                  key={g}
                  className={`px-3 py-1.5 rounded-md border text-xs cursor-pointer transition-colors ${
                    !customMode && genre === g
                      ? 'bg-star-accent/10 border-star-accent/40 text-star-accent'
                      : 'bg-ink-850 border-ink-800 text-ink-muted hover:bg-ink-800'
                  }`}
                >
                  <input
                    type="radio"
                    name="genre"
                    className="sr-only"
                    checked={!customMode && genre === g}
                    onChange={() => selectPresetGenre(g)}
                  />
                  {g}
                </label>
              ))}
              <label
                className={`px-3 py-1.5 rounded-md border text-xs cursor-pointer transition-colors ${
                  isCustomGenre
                    ? 'bg-star-accent/10 border-star-accent/40 text-star-accent'
                    : 'bg-ink-850 border-ink-800 text-ink-muted hover:bg-ink-800'
                }`}
              >
                <input
                  type="radio"
                  name="genre"
                  className="sr-only"
                  checked={isCustomGenre}
                  onChange={selectCustomGenre}
                />
                自定义
              </label>
            </div>
            {isCustomGenre && (
              <input
                className="input mt-2"
                value={genre}
                placeholder="输入自定义题材"
                onChange={(e) => onGenreChange(e.target.value)}
              />
            )}
            <p className="text-[11px] text-ink-500 mt-1.5">
              Genre is injected as a key signal into every AI writing and calibration prompt to
              anchor the prose register (e.g. Western fantasy stays Western, not wuxia).
            </p>
          </Field>
          <Field label="Tags">
            <input
              className="input disabled:opacity-60"
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
              className="textarea min-h-30 disabled:opacity-60"
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
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-medium text-ink-muted">Codex overview</h2>
            <button
              onClick={handleGenerateCover}
              disabled={generatingCover}
              className="btn btn-secondary btn-sm"
            >
              <Image size={15} />
              {generatingCover ? 'Generating…' : 'Cover prompt'}
            </button>
          </div>
          {coverPrompt && (
            <div className="mb-4 p-3 bg-ink-850 rounded border border-ink-800">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-ink-muted">Generated cover prompt</span>
                <button
                  onClick={() =>
                    navigator.clipboard.writeText(coverPrompt).then(() => toastSuccess('Copied'))
                  }
                  className="text-[11px] text-star-info hover:underline"
                >
                  Copy
                </button>
              </div>
              <p className="text-xs text-ink-body leading-relaxed whitespace-pre-wrap">
                {coverPrompt}
              </p>
            </div>
          )}
          <div className="grid grid-cols-3 gap-3">
            {CATEGORY_ORDER.map((cat) => (
              <div key={cat} className="card-muted flex items-center justify-between">
                <span className="text-sm text-ink-faint">{CATEGORY_LABELS[cat]}</span>
                <span className="text-sm font-semibold text-ink-body">{countByCat(cat)}</span>
              </div>
            ))}
          </div>
        </section>

        {/* 文风范例：作者挑选的散文样本，注入写作 prompt 锚定文风 */}
        <section className="card p-6 mb-6">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-sm font-medium text-ink-muted">Style exemplars</h2>
            <button onClick={addExemplar} className="btn btn-secondary btn-sm shrink-0">
              <Plus size={14} /> Add exemplar
            </button>
          </div>
          <p className="text-xs text-ink-500 mb-4 max-w-xl">{PROMPTS.assist.exemplar.emptyHint}</p>
          {exemplarDrafts.length === 0 ? (
            <p className="text-xs text-ink-500 py-6 text-center border border-dashed border-ink-800 rounded">
              Add your first exemplar above to anchor the AI's prose register.
            </p>
          ) : (
            <div className="space-y-3">
              {exemplarDrafts.map((t, i) => (
                <div key={i} className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-ink-500">
                      Exemplar {i + 1}
                      <span className="ml-2 text-ink-600">
                        {t.trim().length.toLocaleString()} chars
                      </span>
                      {t.trim().length >= 200 && t.trim().length < 800 && (
                        <span className="ml-2 text-star-accent">within 200–800 range</span>
                      )}
                    </span>
                    <button
                      onClick={() => removeExemplar(i)}
                      className="icon-btn hover:text-star-danger"
                      title="Remove exemplar"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  <textarea
                    className="textarea min-h-28 text-sm"
                    value={t}
                    placeholder="Paste a passage of human-written fiction that matches this genre (200–800 chars per exemplar recommended)"
                    onChange={(e) => updateExemplar(i, e.target.value)}
                  />
                </div>
              ))}
            </div>
          )}
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
  sub,
}: {
  label: string
  value: string | number
  sub?: string
}): JSX.Element {
  return (
    <div className="card px-5 py-4">
      <div className="text-2xl font-semibold text-ink-deep tabular-nums">{value}</div>
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
