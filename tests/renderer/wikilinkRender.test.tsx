/**
 * @vitest-environment jsdom
 *
 * The wikilink anchor must survive rendering.
 *
 * `[[Ari]]` is rendered by injecting `<a class="wikilink" data-wikilink="…">`
 * into the markdown and parsing it with rehypeRaw, which means it has to pass
 * through rehypeSanitize unharmed. That round trip is easy to break silently —
 * the click handlers find the anchor by `a.wikilink` and read `data-wikilink`,
 * so losing either attribute leaves every document reference inert with no
 * error anywhere — and the sanitizer must still strip scripts, event handlers
 * and dangerous URLs while allowing the anchor.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import MarkdownEditor from '../../src/renderer/src/components/MarkdownEditor'
import { linkifyDocRefs, markdownRehypePlugins, replaceWikilinks } from '../../src/renderer/src/lib'
import type { SettingDoc } from '../../src/shared/types'

const docs: SettingDoc[] = [
  { id: 'character/ari.md', title: 'Ari', category: '11-character', updatedAt: 1 },
]

// Vitest runs without globals, so testing-library does not clean up on its own.
afterEach(cleanup)

function renderMarkdown(markdown: string): HTMLElement {
  const { container } = render(
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={markdownRehypePlugins}>
      {markdown}
    </ReactMarkdown>,
  )
  return container
}

describe('rendering a wikilink', () => {
  it('keeps the class and target of a [[Title]] reference', () => {
    const container = renderMarkdown(replaceWikilinks('See [[Ari]] for the rank.'))

    const link = container.querySelector('a')
    expect(link).not.toBeNull()
    expect(link).toHaveClass('wikilink')
    expect(link).toHaveAttribute('data-wikilink', 'Ari')
    expect(link).toHaveTextContent('Ari')
  })

  it('keeps the class and target of a report doc reference, labelled by title', () => {
    const container = renderMarkdown(
      linkifyDocRefs('- 🔴 The rank is wrong (docs: character/ari.md)', docs),
    )

    const link = container.querySelector('a')
    expect(link).toHaveClass('wikilink')
    expect(link).toHaveAttribute('data-wikilink', 'character/ari.md')
    expect(link).toHaveTextContent('Ari')
  })

  it('still strips scripts, event handlers and javascript: URLs', () => {
    const container = renderMarkdown(
      [
        '<script>window.__pwned = 1</script>',
        '<img src="x" onerror="window.__pwned = 1">',
        '[click](javascript:alert(1))',
        '<a href="https://example.com" onclick="window.__pwned = 1">ok</a>',
      ].join('\n\n'),
    )

    expect(container.querySelector('script')).toBeNull()
    expect(container.innerHTML).not.toContain('onerror')
    expect(container.innerHTML).not.toContain('onclick')

    // A javascript: href is dropped; a real one is kept.
    const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'))
    expect(hrefs).not.toContain('javascript:alert(1)')
    expect(hrefs).toContain('https://example.com')
  })
})

describe('clicking a wikilink in a read-mode editor', () => {
  it('hands the referenced title to the caller', () => {
    const onWikilinkClick = vi.fn()
    render(
      <MarkdownEditor
        value={'See [[Ari]] for the rank, and [[The Ledger]] for the debt.'}
        onChange={() => {}}
        defaultMode="read"
        onWikilinkClick={onWikilinkClick}
      />,
    )

    fireEvent.click(screen.getByText('Ari'))
    expect(onWikilinkClick).toHaveBeenCalledWith('Ari')

    fireEvent.click(screen.getByText('The Ledger'))
    expect(onWikilinkClick).toHaveBeenLastCalledWith('The Ledger')
  })
})
