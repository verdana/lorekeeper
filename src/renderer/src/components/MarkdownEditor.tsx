import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react'
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { search } from '@codemirror/search'
import { tags as t } from '@lezer/highlight'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkCjkFriendly from 'remark-cjk-friendly'
import { Pencil, BookOpen, ArrowUpRight } from 'lucide-react'
import clsx from 'clsx'
import { replaceWikilinks } from '../lib'

export interface EditorSelection {
  text: string
  from: number
  to: number
}

export interface MarkdownEditorHandle {
  getSelection: () => EditorSelection | null
}

interface Props {
  value: string
  onChange: (v: string) => void
  zen?: boolean
  placeholder?: string
  defaultMode?: Mode
  onWikilinkClick?: (title: string) => void
}

const lightTheme = EditorView.theme(
  {
    // #3B2F24 ≡ ink-body（主要文字色）——CodeMirror 的 theme 在 JS 里生成,
    // 不能直接读 CSS var,只能同步维护。改主题色阶时记得同步这几处 hex。
    '&': { color: '#3B2F24', backgroundColor: 'transparent' },
    '.cm-line': { padding: '0 12px' },
  },
  { dark: false },
)

// Markdown 源码语法高亮：让标题/加粗/引用/链接在编辑态就有视觉层次
// 每处 hex 后面标注对应的 tailwind token,和主题色阶保持一致
const mdHighlight = HighlightStyle.define([
  { tag: t.heading1, color: '#2A2018' /* ink-deep */, fontWeight: '700', fontSize: '1.25em' },
  { tag: t.heading2, color: '#2A2018' /* ink-deep */, fontWeight: '700', fontSize: '1.15em' },
  {
    tag: [t.heading3, t.heading4, t.heading5, t.heading6],
    color: '#4E3E30' /* ink-muted */,
    fontWeight: '600',
  },
  { tag: t.strong, color: '#2A2018' /* ink-deep */, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic', color: '#6B5B47' /* ink-faint */ },
  { tag: t.strikethrough, textDecoration: 'line-through', color: '#A89676' /* ink-600 */ },
  { tag: [t.link, t.url], color: '#B8642E' /* star-accent */, textDecoration: 'underline' },
  { tag: t.quote, color: '#8A7A62' /* ink-500 */, fontStyle: 'italic' },
  {
    tag: t.monospace,
    color: '#A64A3F' /* star-danger */,
    fontFamily: "'JetBrains Mono', monospace",
  },
  { tag: t.list, color: '#B8642E' /* star-accent */ },
  { tag: t.contentSeparator, color: '#A89676' /* ink-600 */ },
  // 标记符号本身（#、*、> 等）淡化，减少干扰
  { tag: t.processingInstruction, color: '#A89676' /* ink-600 */ },
])

type Mode = 'edit' | 'read'

const MarkdownEditor = forwardRef<MarkdownEditorHandle, Props>(function MarkdownEditor(
  { value, onChange, zen, placeholder, defaultMode = 'edit', onWikilinkClick }: Props,
  ref,
): JSX.Element {
  const [mode, setMode] = useState<Mode>(defaultMode)
  const cmRef = useRef<ReactCodeMirrorRef>(null)
  const readRef = useRef<HTMLDivElement>(null)

  useImperativeHandle(ref, () => ({
    getSelection: () => {
      const view = cmRef.current?.view
      if (!view) return null
      const sel = view.state.selection.main
      if (sel.empty) return null
      return {
        text: view.state.sliceDoc(sel.from, sel.to),
        from: sel.from,
        to: sel.to,
      }
    },
  }))

  const extensions = useMemo(
    () => [
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      EditorView.lineWrapping,
      syntaxHighlighting(mdHighlight),
      search({ top: true }),
      lightTheme,
    ],
    [],
  )

  // 阅读态把"每行 = 一段"的语义还给用户:围栏代码块外的单个 \n 补成 \n\n,
  // 让 Markdown 引擎把每一行都Render.成独立 <p>,段间自然分开。
  // 代码块内换行必须保留原样,否则代码格式全乱。
  // 表格同理:GFM 表格要求各行连续,一旦插入空行就不再被识别为表格,
  // 所以整块表格也原样透传。
  const previewSource = useMemo(() => {
    const lines = value.split('\n')
    const out: string[] = []
    let inFence = false
    // GFM 表格的分隔行,如 | :--- | ---: |
    const isDelimiter = (l?: string): boolean =>
      l !== undefined && /^\s*\|?[\s:|-]+\|?\s*$/.test(l) && l.includes('-') && l.includes('|')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (/^\s*```/.test(line)) inFence = !inFence
      // 表头行 + 紧邻的分隔行 => 进入表格块,连续的含 | 行整体透传,不补空行
      if (!inFence && line.includes('|') && isDelimiter(lines[i + 1])) {
        while (i < lines.length && lines[i].includes('|')) {
          out.push(lines[i])
          i++
        }
        i-- // 抵消外层循环的 i++
        continue
      }
      out.push(line)
      // 围栏外、当前非空、下一行也非空 => 补一个空行让它们成为独立段落
      if (!inFence && line.trim() && lines[i + 1] !== undefined && lines[i + 1].trim()) {
        out.push('')
      }
    }
    return out.join('\n')
  }, [value])

  // 预处理：在 previewSource 基础上替换 wikilinks
  const previewWithWikilinks = useMemo(() => {
    if (!onWikilinkClick) return previewSource
    return replaceWikilinks(previewSource)
  }, [previewSource, onWikilinkClick])

  const handleReadClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (!onWikilinkClick) return
    const target = (e.target as HTMLElement).closest('a.wikilink')
    if (!target) return
    const title = target.getAttribute('data-wikilink')
    if (title) {
      e.preventDefault()
      onWikilinkClick(title)
    }
  }

  return (
    <div className={clsx('relative h-full', zen && 'zen')}>
      {/* 顶部工具条:Outline. + 模式切换。禅模式下整条隐藏,追求纯净写作。 */}
      <div className={clsx('absolute top-2 right-3 z-10 flex items-center gap-2', zen && 'hidden')}>
        <div className="flex items-center rounded-md bg-ink-850/80 backdrop-blur border border-ink-800 p-0.5">
          <button
            onClick={() => setMode('edit')}
            className={clsx(
              'flex items-center gap-1 px-2.5 py-1 rounded-sm text-xs transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-star-accent/40',
              mode === 'edit'
                ? 'bg-ink-950 text-ink-body shadow-sm'
                : 'text-ink-500 hover:text-ink-muted',
            )}
            title="Edit mode: Markdown source"
          >
            <Pencil size={13} /> Edit
          </button>
          <button
            onClick={() => setMode('read')}
            className={clsx(
              'flex items-center gap-1 px-2.5 py-1 rounded-sm text-xs transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-star-accent/40',
              mode === 'read'
                ? 'bg-ink-950 text-ink-body shadow-sm'
                : 'text-ink-500 hover:text-ink-muted',
            )}
            title="Read mode: rendered preview"
          >
            <BookOpen size={13} /> Read
          </button>
        </div>
      </div>

      {mode === 'edit' ? (
        <CodeMirror
          ref={cmRef}
          value={value}
          onChange={onChange}
          extensions={extensions}
          placeholder={placeholder}
          theme="light"
          basicSetup={{
            lineNumbers: !zen,
            foldGutter: false,
            highlightActiveLine: !zen,
            highlightActiveLineGutter: false,
            bracketMatching: false,
            closeBrackets: false,
            autocompletion: false,
            searchKeymap: true,
          }}
          height="100%"
          style={{ height: '100%' }}
        />
      ) : (
        <div ref={readRef} className="h-full overflow-y-auto" onClick={handleReadClick}>
          <div className="markdown-body mx-auto max-w-4xl px-6 py-8">
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkCjkFriendly]}>
              {previewWithWikilinks}
            </ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  )
})

export default MarkdownEditor
