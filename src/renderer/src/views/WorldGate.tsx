import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { formatTime } from '../lib'
import { toastError, toastSuccess, parseAiError } from '../toast'
import { Orbit, Sparkles, Upload, Plus, Trash2, Loader2, type LucideIcon } from 'lucide-react'
import clsx from 'clsx'
import type { WorldMeta } from '@shared/types'

// New world card cover colour from the star palette.
const COVER_COLORS = ['#B8642E', '#6B8E4E', '#7A5C4E', '#A64A3F', '#A89676']
const pickColor = (): string => COVER_COLORS[Math.floor(Math.random() * COVER_COLORS.length)]

// 种子资料软上限：超出截断，避免撑爆上下文
const SEED_LIMIT = 30000

export default function WorldGate(): JSX.Element {
  const worlds = useStore((s) => s.worlds)
  const loadWorlds = useStore((s) => s.loadWorlds)
  const enterWorld = useStore((s) => s.enterWorld)
  const switching = useStore((s) => s.switching)

  const [mode, setMode] = useState<'prompt' | 'seed' | 'blank'>('prompt')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState('') // 非空时为遮罩文案
  const [error, setError] = useState('')
  const [enteringId, setEnteringId] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    loadWorlds()
  }, [loadWorlds])

  const generate = async (input: { prompt?: string; seedText?: string }): Promise<void> => {
    setError('')
    setBusy('Generating your world, please wait…')
    try {
      const g = await window.api.generateWorld(input)
      const world = await window.api.createWorldWithData(
        { title: g.title, genre: g.genre, coverColor: pickColor() },
        g
      )
      await enterWorld(world.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      toastError(parseAiError(e))
    } finally {
      setBusy('')
    }
  }

  const onGeneratePrompt = (): void => {
    const p = prompt.trim()
    if (!p) return
    generate({ prompt: p })
  }

  const onPickSeed = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = '' // 允许重选同一文件
    if (files.length === 0) return
    setError('')
    setBusy('Reading files…')
    try {
      const parts: string[] = []
      for (const f of files) parts.push(`# ${f.name}\n\n${await f.text()}`)
      let seedText = parts.join('\n\n---\n\n')
      if (seedText.length > SEED_LIMIT) {
        seedText = seedText.slice(0, SEED_LIMIT)
        setError('Material was too long; only the first part was used for generation.')
      }
      await generate({ seedText })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      toastError(parseAiError(e))
      setBusy('')
    }
  }

  const onCreateBlank = async (): Promise<void> => {
    setError('')
    setBusy('Creating blank world…')
    try {
      const world = await window.api.createBlankWorld('Untitled World', '', pickColor())
      await enterWorld(world.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy('')
    }
  }

  const onEnter = async (id: string): Promise<void> => {
    setEnteringId(id)
    try {
      await enterWorld(id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      toastError('Failed to enter world.')
      setEnteringId('')
    }
  }

  const onDelete = async (e: React.MouseEvent, w: WorldMeta): Promise<void> => {
    e.stopPropagation()
    if (!confirm(`Delete the world "${w.title}"? This cannot be undone and removes all its codex and prose.`)) return
    setError('')
    try {
      await window.api.deleteWorld(w.id)
      await loadWorlds()
      toastSuccess(`"${w.title}" deleted.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      toastError('Failed to delete world.')
    }
  }

  return (
    <div className="h-full overflow-y-auto bg-ink-950">
      <div className="max-w-3xl mx-auto px-8 py-16">
        {/* 标题 */}
        <div className="flex flex-col items-center gap-3 mb-10">
          <Orbit className="text-star-accent" size={40} />
          <h1 className="text-2xl font-mono font-bold uppercase tracking-wider text-ink-deep">Lorekeeper</h1>
          <p className="text-sm text-ink-500">Choose how to begin a new world</p>
        </div>

        {/* 三选一：三张平级卡片 */}
        <div className="grid grid-cols-3 gap-3 mb-4">
          <ModeCard
            active={mode === 'prompt'}
            disabled={!!busy}
            icon={Sparkles}
            title="One-line prompt"
            desc="Describe it in a sentence, AI builds the whole codex"
            onClick={() => setMode('prompt')}
          />
          <ModeCard
            active={mode === 'seed'}
            disabled={!!busy}
            icon={Upload}
            title="From seed files"
            desc="Upload existing notes, AI distills and fills in"
            onClick={() => setMode('seed')}
          />
          <ModeCard
            active={mode === 'blank'}
            disabled={!!busy}
            icon={Plus}
            title="Blank"
            desc="Start from scratch, build it by hand"
            onClick={() => setMode('blank')}
          />
        </div>

        {/* 选中模式对应的操作区 */}
        <div className="card p-5 mb-12">
          {mode === 'prompt' && (
            <div className="flex items-center gap-2">
              <input
                className="input flex-1"
                placeholder="Describe your world in a sentence, e.g. 'a steampunk world where magic is dying'"
                value={prompt}
                disabled={!!busy}
                autoFocus
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onGeneratePrompt()
                }}
              />
              <button
                onClick={onGeneratePrompt}
                disabled={!!busy || !prompt.trim()}
                className="btn btn-primary shrink-0"
              >
                Generate world
              </button>
            </div>
          )}

          {mode === 'seed' && (
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm text-ink-500">
                Supports txt / md, multiple files; the AI distills and fills them into a complete codex.
              </p>
              <button
                onClick={() => fileRef.current?.click()}
                disabled={!!busy}
                className="btn btn-primary shrink-0"
              >
                <Upload size={16} />
                Choose files
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".txt,.md,text/plain,text/markdown"
                multiple
                hidden
                onChange={onPickSeed}
              />
            </div>
          )}

          {mode === 'blank' && (
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm text-ink-500">Create a blank world, then build it out in the Codex and Manuscript.</p>
              <button onClick={onCreateBlank} disabled={!!busy} className="btn btn-primary shrink-0">
                <Plus size={16} />
                Create blank world
              </button>
            </div>
          )}
        </div>

        {error && (
          <div className="mb-6 text-sm text-star-danger bg-star-danger/10 rounded-sm px-4 py-2.5">
            {error}
          </div>
        )}

        {/* 已有世界 */}
        <div className="flex items-center gap-3 mb-4">
          <div className="h-px flex-1 bg-ink-800" />
          <span className="text-xs text-ink-500">Your worlds</span>
          <div className="h-px flex-1 bg-ink-800" />
        </div>

        {worlds.length === 0 ? (
          <p className="text-center text-sm text-ink-400 py-8">No worlds yet — generate one to begin</p>
        ) : (
          <div className="grid grid-cols-3 gap-4">
            {worlds.map((w) => (
              <button
                key={w.id}
                onClick={() => onEnter(w.id)}
                disabled={switching || !!busy}
                className="card p-4 text-left relative group hover:border-star-accent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-star-accent/40 focus-visible:ring-inset"
              >
                <div
                  className="w-full h-1.5 rounded-full mb-3"
                  style={{ backgroundColor: w.coverColor }}
                />
                <div className="text-sm font-semibold text-ink-deep truncate">{w.title}</div>
                <div className="text-[11px] text-ink-500 mt-1">{w.genre || 'Untitled genre'}</div>
                <div className="text-[11px] text-ink-400 mt-2">{formatTime(w.lastOpenedAt)}</div>

                {enteringId === w.id && switching && (
                  <div className="absolute inset-0 bg-ink-900/60 rounded-lg flex items-center justify-center">
                    <Loader2 className="text-star-accent animate-spin" size={20} />
                  </div>
                )}

                <span
                  onClick={(e) => onDelete(e, w)}
                  className="absolute top-2 right-2 p-1 rounded-sm text-ink-400 opacity-0 group-hover:opacity-100 hover:text-star-danger hover:bg-ink-800 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-star-accent/40 transition-all"
                  title="Delete world"
                >
                  <Trash2 size={14} />
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 生成中遮罩 */}
      {busy && (
        <div className="fixed inset-0 bg-ink-950/70 flex flex-col items-center justify-center gap-4 z-50">
          <Loader2 className="text-star-accent animate-spin" size={36} />
          <p className="text-sm text-ink-muted">{busy}</p>
        </div>
      )}
    </div>
  )
}

function ModeCard({
  active,
  disabled,
  icon: Icon,
  title,
  desc,
  onClick
}: {
  active: boolean
  disabled: boolean
  icon: LucideIcon
  title: string
  desc: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        'card p-4 text-left flex flex-col gap-2 transition-colors',
        active ? 'border-star-accent ring-1 ring-star-accent' : 'hover:border-ink-700'
      )}
    >
      <Icon className={active ? 'text-star-accent' : 'text-ink-500'} size={20} />
      <div className="text-sm font-semibold text-ink-deep">{title}</div>
      <div className="text-[11px] text-ink-500 leading-relaxed">{desc}</div>
    </button>
  )
}
