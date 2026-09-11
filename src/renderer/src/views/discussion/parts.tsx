/**
 * Presentational pieces of the Writers' Room: the converge header, message copy
 * buttons, the reasoning drawer and the round timeline.
 *
 * They take everything they need as props, which is what lets them sit outside
 * the session state machine.
 */

import { useState } from 'react'

import { type Proposal } from '../../discussion'

import { Loader2, Check, Brain, ArrowRight, Copy, Type, Crosshair } from 'lucide-react'
import clsx from 'clsx'
import type { RoundAnchor } from './types'

export function ConvergeHeader({
  proposing,
  proposals,
  focus,
  running,
  onPick,
  onBackToProposals,
}: {
  proposing: boolean
  proposals: Proposal[] | null
  focus: string | null
  running: boolean
  onPick: (point: string) => void
  onBackToProposals: () => void
}): JSX.Element | null {
  const [custom, setCustom] = useState('')

  // 已锁定深钻点：横幅 + 可回到清单
  if (focus) {
    return (
      <div className="flex items-start gap-3 px-4 py-3 rounded-md bg-star-accent/5 border border-star-accent/30 mb-2">
        <Crosshair size={16} className="text-star-accent shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-[11px] text-star-accent uppercase tracking-wider mb-0.5">Focus</div>
          <div className="text-sm text-ink-body">{focus}</div>
        </div>
        {proposals && proposals.length > 0 && (
          <button
            onClick={onBackToProposals}
            disabled={running}
            className="btn btn-ghost btn-sm shrink-0"
            title="Discard this drill-down and pick another point"
          >
            Pick another
          </button>
        )}
      </div>
    )
  }

  // 提案生成中
  if (proposing) {
    return (
      <div className="flex items-center gap-2 text-ink-500 text-sm px-4 py-3">
        <Loader2 size={15} className="animate-spin" />
        Each persona is naming the one point they'd most want to drill…
      </div>
    )
  }

  // 提案已就绪:可点选清单 + 自定义输入
  if (proposals) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-xs text-ink-500 px-1">
          <Crosshair size={13} />
          Pick one point to drill. The others get set aside.
        </div>
        <div className="space-y-1.5">
          {proposals.map((p) => (
            <button
              key={p.personaId}
              onClick={() => onPick(p.reason ? `${p.point} — ${p.reason}` : p.point)}
              disabled={running}
              className="w-full flex items-start gap-3 px-4 py-3 rounded-md text-left bg-ink-900 hover:bg-ink-800 border border-transparent hover:border-star-accent/30 transition-colors group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-star-accent/40 focus-visible:ring-inset"
            >
              <span className="text-[11px] text-ink-500 shrink-0 mt-0.5 w-20 truncate">
                {p.personaName}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-sm text-ink-body">{p.point}</span>
                {p.reason && (
                  <span className="block text-[12px] text-ink-500 mt-0.5">{p.reason}</span>
                )}
              </span>
              <ArrowRight
                size={14}
                className="text-ink-500 group-hover:text-star-accent shrink-0 mt-1"
              />
            </button>
          ))}
        </div>
        <div className="flex items-stretch gap-2 pt-1">
          <input
            className="input flex-1 text-sm"
            placeholder="Or type your own point to drill…"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            disabled={running}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && custom.trim()) onPick(custom.trim())
            }}
          />
          <button
            onClick={() => custom.trim() && onPick(custom.trim())}
            disabled={running || !custom.trim()}
            className="btn btn-primary btn-sm shrink-0"
          >
            <ArrowRight size={14} /> Drill
          </button>
        </div>
      </div>
    )
  }

  return null
}

/**
 * 发言正文的复制按钮组：一个复制 Markdown 原文，一个复制去掉标记的纯文本。
 * 只作用于正文，不含思考过程。复制成功后短暂显示对勾反馈。
 * 输出为 fragment，交给父容器统一管布局（与 Regenerate 按钮并排）。
 */
export function CopyButtons({ text }: { text: string }): JSX.Element {
  const [copied, setCopied] = useState<'md' | 'txt' | null>(null)

  const copy = async (kind: 'md' | 'txt'): Promise<void> => {
    const payload = kind === 'md' ? text : stripMarkdown(text)
    await navigator.clipboard.writeText(payload)
    setCopied(kind)
    setTimeout(() => setCopied(null), 1500)
  }

  return (
    <>
      <button
        onClick={() => copy('txt')}
        title="Copy as plain text (Markdown stripped)"
        className="icon-btn gap-1 px-2 text-[11px] hover:text-ink-muted hover:bg-ink-850"
      >
        {copied === 'txt' ? <Check size={12} className="text-star-success" /> : <Type size={12} />}
        Plain text
      </button>
      <button
        onClick={() => copy('md')}
        title="Copy Markdown source"
        className="icon-btn gap-1 px-2 text-[11px] hover:text-ink-muted hover:bg-ink-850"
      >
        {copied === 'md' ? <Check size={12} className="text-star-success" /> : <Copy size={12} />}
        Markdown
      </button>
    </>
  )
}

/**
 * 把 LLM 输出的 LaTeX 数学符号转成对应的 Unicode 字符。
 * 推理模型常输出 $\rightarrow$ 之类，ReactMarkdown 不认识它。
 */
export function replaceLatexMath(text: string): string {
  return text
    .replace(/\$\\rightarrow\$/g, '→')
    .replace(/\$\\to\$/g, '→')
    .replace(/\$\\leftarrow\$/g, '←')
    .replace(/\$\\Rightarrow\$/g, '⇒')
    .replace(/\$\\Leftarrow\$/g, '⇐')
    .replace(/\$\\leftrightarrow\$/g, '↔')
    .replace(/\$\\longrightarrow\$/g, '⟶')
    .replace(/\$\\longleftarrow\$/g, '⟵')
    .replace(/\$\\implies\$/g, '⟹')
    .replace(/\$\\iff\$/g, '⟺')
}

/** 把常见 Markdown 标记剥成纯文本（用于复制）。够用即可，不追求完备解析。 */
export function stripMarkdown(md: string): string {
  return md
    .replace(/^\s*```.*$/gm, '') // 代码块围栏行
    .replace(/`([^`]+)`/g, '$1') // 行内代码
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // 图片留 alt
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // 链接留文字
    .replace(/^#{1,6}\s+/gm, '') // 标题符号
    .replace(/^\s*>\s?/gm, '') // 引用符号
    .replace(/^\s*([-*+])\s+/gm, '') // 无序列表符号
    .replace(/(\*\*|__)(.*?)\1/g, '$2') // 粗体
    .replace(/(\*|_)(.*?)\1/g, '$2') // 斜体
    .replace(/~~(.*?)~~/g, '$1') // 删除线
    .replace(/^\s*[-*_]{3,}\s*$/gm, '') // 分隔线
    .replace(/\n{3,}/g, '\n\n') // 收敛多余空行
    .trim()
}

/**
 * 思考文本仅实时展示，不并入正文、不随会话存档。
 * onToggle：details 展开/收起会改变消息高度，父组件借此重测时间轴锚点位置。
 */
export function ReasoningBlock({
  text,
  done,
  onToggle,
}: {
  text: string
  done: boolean
  onToggle?: () => void
}): JSX.Element {
  return (
    <details open={!done} onToggle={onToggle} className="mb-2 group">
      <summary className="flex items-center gap-1.5 cursor-pointer text-[11px] text-ink-500 hover:text-ink-faint select-none list-none">
        <Brain size={12} className={clsx(!done && 'animate-pulse text-star-success')} />
        {done ? 'View reasoning' : 'Thinking…'}
      </summary>
      <div className="mt-1.5 pl-3 border-l-2 border-ink-800 text-[13px] leading-relaxed text-ink-500 whitespace-pre-wrap">
        {text}
      </div>
    </details>
  )
}

/**
 * 右侧 Round 时间轴（滚动条语义）：轨道高度固定为滚动区可视高度，不随内容伸缩。
 * 每个圆点按钮按锚点在内容总高度中的比例映射到轨道位置（类似滚动条刻度，始终可见）；
 * hover 显示 Round 号与（若有）用户插话摘要；点击跳转到该轮起始消息。
 */
export function RoundTimeline({
  anchors,
  timeline,
  activeId,
  onJump,
}: {
  anchors: RoundAnchor[]
  timeline: { rail: number; content: number; tops: Record<string, number> } | null
  activeId: string | null
  onJump: (messageId: string) => void
}): JSX.Element | null {
  if (anchors.length === 0 || !timeline) return null
  const rail = timeline.rail
  return (
    <div className="absolute right-3.5 top-0 bottom-0 w-6 pointer-events-none">
      {/* 轨道线 */}
      <div className="absolute left-1/2 top-2 bottom-2 w-px -translate-x-1/2 bg-ink-700/40 rounded-full" />
      {anchors.map((a) => {
        const contentPos = timeline.tops[a.messageId] ?? 0
        // 内容可滚动时按比例压缩进轨道；不足一屏时直接按实际位置排布。
        const ratio = timeline.content > rail ? rail / timeline.content : 1
        const top = Math.min(Math.max(contentPos * ratio, 8), Math.max(rail - 8, 8))
        const active = activeId === a.messageId
        return (
          <button
            key={a.messageId}
            type="button"
            onClick={() => onJump(a.messageId)}
            aria-label={`Jump to round ${a.round}`}
            title={`Round ${a.round}${
              a.isUser && a.userText ? ` — You: ${stripMarkdown(a.userText).slice(0, 80)}` : ''
            }`}
            className="group/rail absolute left-1/2 -translate-x-1/2 -translate-y-1/2 p-1.5 pointer-events-auto cursor-pointer rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-star-accent/40"
            style={{ top }}
          >
            <span
              className={clsx(
                'block h-1.5 w-1.5 rounded-full transition-all duration-150',
                active
                  ? 'bg-star-accent scale-150'
                  : 'bg-ink-600 group-hover/rail:bg-star-accent group-hover/rail:scale-150',
              )}
            />
            {/* hover 提示卡片：Round 号 + 用户插话摘要（若有） */}
            <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 whitespace-nowrap rounded-md border border-ink-800 bg-ink-900 px-2.5 py-1.5 text-left opacity-0 shadow-[var(--shadow-warm-md)] transition-opacity duration-150 group-hover/rail:opacity-100">
              <span className="block text-[11px] font-semibold text-ink-body">Round {a.round}</span>
              {a.isUser && a.userText && (
                <span className="block max-w-60 truncate text-[10px] text-ink-500">
                  You: {stripMarkdown(a.userText).replace(/\s+/g, ' ').trim()}
                </span>
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
}
