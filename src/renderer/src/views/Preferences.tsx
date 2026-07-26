import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { uid, parseMaxTokens } from '../lib'
import { toastError, toastSuccess, parseAiError } from '../toast'
import type {
  AIProvider,
  AgentPersona,
  AppConfig,
  ConsistencyConfig,
  WritingConfig,
} from '@shared/types'
import { BUILTIN_OUTLINE_PROMPT, BUILTIN_CONTINUE_PROMPT } from '../components/AiAssistPanel'
import {
  Plus,
  Trash2,
  Save,
  Loader2,
  CheckCircle2,
  XCircle,
  Cpu,
  Users,
  RotateCcw,
  Copy,
  ShieldCheck,
  Edit3,
} from 'lucide-react'
import clsx from 'clsx'

const PERSONA_COLORS = ['#B8642E', '#6B8E4E', '#7A5C4E', '#A64A3F', '#8A6E3A', '#A89676']

/**
 * 保存时归一化：空白或与内置一致 → 存空串（运行时回退到内置提示词）。
 * 编辑态不做这个判断，textarea 始终绑定草稿原值，删除/清空不会回弹。
 */
function normalizeWritingPrompt(value: string, builtin: string): string {
  return !value.trim() || value === builtin ? '' : value
}

/** 生成要写入 config.json 的配置：两个写作提示词归一化。 */
function toSaveable(cfg: AppConfig): AppConfig {
  return {
    ...cfg,
    writing: {
      ...cfg.writing,
      outlineSystemPrompt: normalizeWritingPrompt(
        cfg.writing.outlineSystemPrompt,
        BUILTIN_OUTLINE_PROMPT,
      ),
      continueSystemPrompt: normalizeWritingPrompt(
        cfg.writing.continueSystemPrompt,
        BUILTIN_CONTINUE_PROMPT,
      ),
    },
  }
}

export default function Preferences(): JSX.Element {
  const config = useStore((s) => s.config)!
  const saveConfig = useStore((s) => s.saveConfig)

  const [tab, setTab] = useState<'ai' | 'personas' | 'consistency' | 'writing'>('ai')
  // 编辑态把「空 = 用内置」物化为内置文本，保证提示词可任意删改；
  // 若直接绑定 `saved || 内置`，删空时 value 会回弹成完整内置提示词。
  const [draft, setDraft] = useState<AppConfig>(() => ({
    ...config,
    writing: {
      ...config.writing,
      outlineSystemPrompt: config.writing.outlineSystemPrompt || BUILTIN_OUTLINE_PROMPT,
      continueSystemPrompt: config.writing.continueSystemPrompt || BUILTIN_CONTINUE_PROMPT,
    },
  }))
  const [saved, setSaved] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<Record<string, boolean>>({})

  const commit = async (next = draft): Promise<void> => {
    setDraft(next) // 编辑态保留原值（清空的框保持空白，不回弹）
    await saveConfig(toSaveable(next))
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  // ---- AI providers. ----
  const updateProvider = (id: string, patch: Partial<AIProvider>): void => {
    setDraft((d) => ({
      ...d,
      ai: { ...d.ai, providers: d.ai.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)) },
    }))
  }

  const addProvider = (): void => {
    const p: AIProvider = {
      id: uid('p_'),
      name: 'New provider',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-4o-mini',
    }
    setDraft((d) => ({ ...d, ai: { ...d.ai, providers: [...d.ai.providers, p] } }))
  }

  const cloneProvider = (id: string): void => {
    setDraft((d) => {
      const idx = d.ai.providers.findIndex((p) => p.id === id)
      if (idx === -1) return d
      const src = d.ai.providers[idx]
      const copy: AIProvider = { ...src, id: uid('p_'), name: `${src.name} copy` }
      const providers = [...d.ai.providers]
      providers.splice(idx + 1, 0, copy)
      return { ...d, ai: { ...d.ai, providers } }
    })
  }

  const removeProvider = (id: string): void => {
    setDraft((d) => {
      const providers = d.ai.providers.filter((p) => p.id !== id)
      return {
        ...d,
        ai: {
          providers,
          activeProviderId:
            d.ai.activeProviderId === id ? (providers[0]?.id ?? null) : d.ai.activeProviderId,
        },
      }
    })
  }

  const testProvider = async (p: AIProvider): Promise<void> => {
    setTesting(p.id)
    setTestResult((r) => ({ ...r, [p.id]: false }))
    // 先保存，确保主进程读取到最新配置
    await saveConfig(toSaveable(draft))
    try {
      await window.api.chat(
        [{ role: 'user', content: 'Hello, please reply "connection successful".' }],
        p.id,
      )
      setTestResult((r) => ({ ...r, [p.id]: true }))
      toastSuccess(`"${p.name}" connected successfully.`)
    } catch (e) {
      toastError(parseAiError(e))
      setTestResult((r) => ({ ...r, [p.id]: false }))
    } finally {
      setTesting(null)
    }
  }

  // ---- Agent 人设 ----
  const updatePersona = (id: string, patch: Partial<AgentPersona>): void => {
    setDraft((d) => ({
      ...d,
      personas: d.personas.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    }))
  }

  const addPersona = (): void => {
    const p: AgentPersona = {
      id: uid('a_'),
      name: 'New persona',
      role: 'Role description',
      systemPrompt: 'You are…',
      color: PERSONA_COLORS[draft.personas.length % PERSONA_COLORS.length],
    }
    setDraft((d) => ({ ...d, personas: [...d.personas, p] }))
  }

  const removePersona = (id: string): void => {
    setDraft((d) => ({ ...d, personas: d.personas.filter((p) => p.id !== id) }))
  }

  // ---- 一致性巡检 ----
  const updateConsistency = (patch: Partial<ConsistencyConfig>): void => {
    setDraft((d) => ({ ...d, consistency: { ...d.consistency, ...patch } }))
  }

  // ---- 正文编写 ----
  const updateWriting = (patch: Partial<WritingConfig>): void => {
    setDraft((d) => ({ ...d, writing: { ...d.writing, ...patch } }))
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-8 py-4 border-b border-ink-800">
        <div className="flex gap-1">
          <TabBtn active={tab === 'ai'} onClick={() => setTab('ai')} icon={Cpu}>
            AI Providers
          </TabBtn>
          <TabBtn active={tab === 'personas'} onClick={() => setTab('personas')} icon={Users}>
            Personas
          </TabBtn>
          <TabBtn
            active={tab === 'consistency'}
            onClick={() => setTab('consistency')}
            icon={ShieldCheck}
          >
            Consistency
          </TabBtn>
          <TabBtn active={tab === 'writing'} onClick={() => setTab('writing')} icon={Edit3}>
            Writing
          </TabBtn>
        </div>
        <button onClick={() => commit()} className="btn btn-sm btn-primary">
          <Save size={16} />
          {saved ? 'Saved' : 'Save settings'}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-8 py-8">
          {tab === 'ai' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-xs text-ink-500 leading-relaxed max-w-lg">
                  Works with any OpenAI-compatible API (OpenAI / DeepSeek / Kimi / Qwen / local
                  Ollama, etc.). Set the Base URL down to the{' '}
                  <code className="text-star-warm">/v1</code> level.
                </p>
                <button onClick={addProvider} className="btn btn-sm btn-secondary shrink-0">
                  <Plus size={15} /> Add
                </button>
              </div>

              {draft.ai.providers.map((p) => (
                <div
                  key={p.id}
                  className={clsx(
                    'card space-y-3',
                    draft.ai.activeProviderId === p.id && 'border-star-accent/40 bg-star-accent/5',
                  )}
                >
                  <div className="flex items-center gap-3">
                    <input
                      className="input flex-1 font-medium"
                      value={p.name}
                      onChange={(e) => updateProvider(p.id, { name: e.target.value })}
                    />
                    <label className="flex items-center gap-1.5 text-xs text-ink-faint shrink-0">
                      <input
                        type="radio"
                        name="active"
                        checked={draft.ai.activeProviderId === p.id}
                        onChange={() =>
                          setDraft((d) => ({ ...d, ai: { ...d.ai, activeProviderId: p.id } }))
                        }
                        className="accent-star-accent"
                      />
                      Default
                    </label>
                    <button
                      onClick={() => cloneProvider(p.id)}
                      className="icon-btn hover:text-star-accent shrink-0"
                      title="Clone this provider"
                    >
                      <Copy size={16} />
                    </button>
                    <button
                      onClick={() => removeProvider(p.id)}
                      className="icon-btn hover:text-star-danger shrink-0"
                      title="Remove this provider"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <LabeledInput
                      label="Base URL"
                      value={p.baseUrl}
                      onChange={(v) => updateProvider(p.id, { baseUrl: v })}
                      placeholder="https://api.deepseek.com/v1"
                    />
                    <LabeledInput
                      label="Model"
                      value={p.model}
                      onChange={(v) => updateProvider(p.id, { model: v })}
                      placeholder="deepseek-chat"
                    />
                  </div>
                  <MaxTokensInput
                    value={p.maxTokens}
                    onChange={(v) => updateProvider(p.id, { maxTokens: v })}
                  />
                  <LabeledInput
                    label="API Key"
                    type="password"
                    value={p.apiKey}
                    onChange={(v) => updateProvider(p.id, { apiKey: v })}
                    placeholder="sk-..."
                  />
                  <button
                    onClick={() => testProvider(p)}
                    disabled={testing === p.id}
                    className="btn btn-sm btn-secondary"
                  >
                    {testing === p.id ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : testResult[p.id] ? (
                      <CheckCircle2 size={13} className="text-star-success" />
                    ) : (
                      <XCircle size={13} className="text-ink-500" />
                    )}
                    Test connection
                  </button>
                </div>
              ))}
            </div>
          )}

          {tab === 'personas' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-xs text-ink-500 max-w-lg">
                  Create different AI personas for the writers room. The system prompt defines each
                  one's stance and voice in discussion.
                </p>
                <button onClick={addPersona} className="btn btn-sm btn-secondary shrink-0">
                  <Plus size={15} /> Add persona
                </button>
              </div>

              {draft.personas.map((p) => (
                <div key={p.id} className="card space-y-3">
                  <div className="flex items-center gap-3">
                    <input
                      type="color"
                      value={p.color}
                      onChange={(e) => updatePersona(p.id, { color: e.target.value })}
                      className="w-8 h-8 rounded-sm cursor-pointer bg-transparent border-none shrink-0"
                    />
                    <input
                      className="input flex-1 font-medium"
                      value={p.name}
                      placeholder="Persona name"
                      onChange={(e) => updatePersona(p.id, { name: e.target.value })}
                    />
                    <input
                      className="input flex-1"
                      value={p.role}
                      placeholder="One-line role"
                      onChange={(e) => updatePersona(p.id, { role: e.target.value })}
                    />
                    <button
                      onClick={() => removePersona(p.id)}
                      className="icon-btn hover:text-star-danger shrink-0"
                      title="Remove this persona"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                  <div>
                    <label className="block text-xs text-ink-500 mb-1.5">
                      System prompt (persona)
                    </label>
                    <textarea
                      className="textarea min-h-22.5 text-sm"
                      value={p.systemPrompt}
                      onChange={(e) => updatePersona(p.id, { systemPrompt: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-ink-500 mb-1.5">
                      Provider (optional, defaults to the active one)
                    </label>
                    <select
                      className="input"
                      value={p.providerId ?? ''}
                      onChange={(e) =>
                        updatePersona(p.id, { providerId: e.target.value || undefined })
                      }
                    >
                      <option value="">(use default provider)</option>
                      {draft.ai.providers.map((pr) => (
                        <option key={pr.id} value={pr.id}>
                          {pr.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              ))}
            </div>
          )}

          {tab === 'consistency' && (
            <div className="space-y-4">
              <p className="text-xs text-ink-500 leading-relaxed max-w-lg">
                Configure the model and prompt used by Consistency Check. This runs over the full
                codex and chapters, so prefer a long-context, non-reasoning model — a pure reasoning
                model may spend its whole budget "thinking" and return an empty report.
              </p>

              <div className="card space-y-4">
                <div>
                  <label className="block text-xs text-ink-500 mb-1.5">Model</label>
                  <select
                    className="input"
                    value={draft.consistency.providerId ?? ''}
                    onChange={(e) => updateConsistency({ providerId: e.target.value || null })}
                  >
                    <option value="">(use default provider)</option>
                    {draft.ai.providers.map((pr) => (
                      <option key={pr.id} value={pr.id}>
                        {pr.name} · {pr.model}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs text-ink-500 mb-1.5">System prompt</label>
                  <textarea
                    className="textarea min-h-20 text-sm"
                    value={draft.consistency.systemPrompt}
                    onChange={(e) => updateConsistency({ systemPrompt: e.target.value })}
                  />
                </div>

                <div>
                  <label className="block text-xs text-ink-500 mb-1.5">
                    Prompt template — use <code className="text-star-warm">{'{{material}}'}</code>{' '}
                    where the selected codex and chapters should be inserted.
                  </label>
                  <textarea
                    className="textarea min-h-65 text-sm"
                    value={draft.consistency.userTemplate}
                    onChange={(e) => updateConsistency({ userTemplate: e.target.value })}
                  />
                </div>
              </div>
            </div>
          )}

          {tab === 'writing' && (
            <div className="space-y-4">
              <p className="text-xs text-ink-500 leading-relaxed max-w-lg">
                Configure the model and system prompts used by Outline Write and Continue Writing in
                the Manuscript editor. The prompts below are fully editable — if a prompt is blank
                or unchanged when you save, the built-in default is used.
              </p>

              <div className="card space-y-4">
                <div>
                  <label className="block text-xs text-ink-500 mb-1.5">Model</label>
                  <select
                    className="input"
                    value={draft.writing.providerId ?? ''}
                    onChange={(e) => updateWriting({ providerId: e.target.value || null })}
                  >
                    <option value="">(use default provider)</option>
                    {draft.ai.providers.map((pr) => (
                      <option key={pr.id} value={pr.id}>
                        {pr.name} · {pr.model}
                      </option>
                    ))}
                  </select>
                  <p className="text-[11px] text-ink-500 mt-1">
                    If left on default, uses the provider with "Default" selected in the AI
                    Providers tab.
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs text-ink-500 mb-1.5">Temperature</label>
                    <input
                      type="number"
                      className="input"
                      min={0}
                      max={2}
                      step={0.1}
                      value={draft.writing.temperature}
                      onChange={(e) =>
                        updateWriting({ temperature: Number(e.target.value) || 0.8 })
                      }
                    />
                    <p className="text-[11px] text-ink-500 mt-1">0–2, default 0.8</p>
                  </div>
                  <div>
                    <label className="block text-xs text-ink-500 mb-1.5">Top-P</label>
                    <input
                      type="number"
                      className="input"
                      min={0}
                      max={1}
                      step={0.05}
                      value={draft.writing.topP}
                      onChange={(e) => updateWriting({ topP: Number(e.target.value) || 0.9 })}
                    />
                    <p className="text-[11px] text-ink-500 mt-1">0–1, default 0.9</p>
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-ink-500 mb-1.5">
                    Outline Write — System Prompt
                    <span className="ml-2 text-ink-500 font-normal">
                      {!draft.writing.outlineSystemPrompt.trim() ||
                      draft.writing.outlineSystemPrompt === BUILTIN_OUTLINE_PROMPT
                        ? '(built-in)'
                        : '(custom)'}
                    </span>
                    {draft.writing.outlineSystemPrompt !== BUILTIN_OUTLINE_PROMPT && (
                      <button
                        onClick={() =>
                          updateWriting({ outlineSystemPrompt: BUILTIN_OUTLINE_PROMPT })
                        }
                        className="icon-btn ml-2 text-ink-500 hover:text-ink-muted"
                        title="Reset to default"
                      >
                        <RotateCcw size={13} />
                      </button>
                    )}
                  </label>
                  <textarea
                    className="textarea min-h-36 text-sm"
                    value={draft.writing.outlineSystemPrompt}
                    onChange={(e) => updateWriting({ outlineSystemPrompt: e.target.value })}
                  />
                </div>

                <div>
                  <label className="block text-xs text-ink-500 mb-1.5">
                    Continue Writing — System Prompt
                    <span className="ml-2 text-ink-500 font-normal">
                      {!draft.writing.continueSystemPrompt.trim() ||
                      draft.writing.continueSystemPrompt === BUILTIN_CONTINUE_PROMPT
                        ? '(built-in)'
                        : '(custom)'}
                    </span>
                    {draft.writing.continueSystemPrompt !== BUILTIN_CONTINUE_PROMPT && (
                      <button
                        onClick={() =>
                          updateWriting({ continueSystemPrompt: BUILTIN_CONTINUE_PROMPT })
                        }
                        className="icon-btn ml-2 text-ink-500 hover:text-ink-muted"
                        title="Reset to default"
                      >
                        <RotateCcw size={13} />
                      </button>
                    )}
                  </label>
                  <textarea
                    className="textarea min-h-36 text-sm"
                    value={draft.writing.continueSystemPrompt}
                    onChange={(e) => updateWriting({ continueSystemPrompt: e.target.value })}
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function TabBtn({
  active,
  onClick,
  icon: Icon,
  children,
}: {
  active: boolean
  onClick: () => void
  icon: React.ComponentType<{ size?: number }>
  children: React.ReactNode
}): JSX.Element {
  return (
    <button onClick={onClick} className={clsx('tab-btn', active && 'active')}>
      <Icon size={16} />
      {children}
    </button>
  )
}

/**
 * Max tokens input with human-friendly parsing.
 * Accepts "128k", "128000", "128,000", or empty (unlimited).
 * Shows the resolved numeric value and inline validation.
 */
function MaxTokensInput({
  value,
  onChange,
}: {
  value?: number
  onChange: (v: number | undefined) => void
}): JSX.Element {
  const [raw, setRaw] = useState(value != null ? String(value) : '')
  const [focused, setFocused] = useState(false)

  // Sync raw text when the provider config changes externally (e.g. undo, clone)
  useEffect(() => {
    if (!focused) setRaw(value != null ? String(value) : '')
  }, [value, focused])

  const parsed = parseMaxTokens(raw)
  const isValid = raw.trim() === '' || parsed.value != null

  return (
    <label className="block">
      <span className="block text-xs text-ink-500 mb-1.5">Max tokens</span>
      <input
        type="text"
        className="input"
        value={raw}
        placeholder="4096, 128k, or leave empty for model default"
        onChange={(e) => {
          const next = e.target.value
          setRaw(next)
          const result = parseMaxTokens(next)
          if (result.value != null) onChange(result.value)
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false)
          // On blur, if the input is empty, commit null (use model default)
          if (raw.trim() === '') onChange(undefined)
          // If invalid, revert to stored value
          if (!isValid) setRaw(value != null ? String(value) : '')
        }}
      />
      {/* Hint line: show resolved value or error */}
      {raw.trim() && !focused ? (
        parsed.error ? (
          <span className="block text-[11px] text-star-danger mt-1">{parsed.error}</span>
        ) : parsed.value != null ? (
          <span className="block text-[11px] text-ink-500 mt-1">
            = {parsed.value.toLocaleString()} tokens
          </span>
        ) : null
      ) : null}
    </label>
  )
}

function LabeledInput({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: string
}): JSX.Element {
  return (
    <label className="block">
      <span className="block text-xs text-ink-500 mb-1.5">{label}</span>
      <input
        type={type}
        className="input"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  )
}
