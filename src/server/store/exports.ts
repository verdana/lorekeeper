/**
 * World store — every persisted file of a world, addressed through one module.
 *
 * Layout note: the data layer is split by domain, each module owning one kind of
 * file and importing the shared infrastructure from `./core`. `store.ts` is the
 * facade the RPC layer and the tests import, so callers see one module while the
 * implementation stays navigable:
 *
 *   core              atomic write, snapshot, damaged-file guards, safe paths
 *   worlds            the world index, world lifecycle, novel metadata
 *   config            app config (providers, personas, prompts) + API keys
 *   codex             codex documents and read-only external folder mappings
 *   manuscript        chapter files and manuscript prose search
 *   generation-runs   generation evidence
 *   history           version snapshots
 *   timeline          world events
 *   story             Story Memory, chapter summaries, the story-state archive
 *   outline           the structured outline (structure's source of truth)
 *   records           discussions, consistency reports, character chats, review queue
 *   voice             Voice Profile and style exemplars
 *   exports           whole-world zip, static codex wiki, epub
 *   forge-run         the Novel Forge run record (shape owned by the engine)
 *
 * Two rules hold across all of them: writes go through `atomicWrite` (temp file
 * → fsync → rename) and anything overwritten is snapshotted first, so a crash or
 * a bad AI response never costs the author unrecoverable text.
 */
/**
 * Exports: the whole world as a zip, the codex as a standalone HTML wiki, and
 * the manuscript as an epub.
 *
 * These read the same on-disk layout the app writes, so an export is always a
 * faithful copy of what the author has rather than a rendering of cached state.
 */

import type { NovelMeta } from '../../shared/types'
import { currentWorldDir, novelFile, projectRoot } from '../paths'
import { CATEGORY_LABELS, DEFAULT_NOVEL_META } from '../defaults'

import { readJSON } from './core'

import { listSettings, readSetting } from './codex'
import { readChapter } from './manuscript'

import JSZip from 'jszip'
import { readFileSync, readdirSync } from 'fs'
import { join, relative } from 'path'

// ---- 导出全书 ----
/**
 * 收集当前世界目录下的所有文件（跳过 .snapshots 等点目录），
 * 返回 zip 内相对路径 + 内容。供 index.ts 的导出端点打包。
 */
export function collectWorldFiles(): { name: string; files: { path: string; content: Buffer }[] } {
  const base = currentWorldDir()
  const files: { path: string; content: Buffer }[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue // 跳过 .snapshots 等
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) walk(abs)
      else if (entry.isFile()) {
        files.push({ path: relative(base, abs).replace(/\\/g, '/'), content: readFileSync(abs) })
      }
    }
  }
  walk(base)
  const novel = readJSON<NovelMeta>(novelFile(), DEFAULT_NOVEL_META)
  const name = (novel.title || 'world').replace(/[/\\:*?"<>|]/g, '_').trim() || 'world'
  return { name, files }
}

/**
 * Generate a self-contained static wiki HTML from all codex documents.
 * Converts markdown to HTML and embeds styling + sidebar navigation.
 */
export async function exportWikiHtml(): Promise<{ name: string; html: string }> {
  const novel = readJSON<NovelMeta>(novelFile(), DEFAULT_NOVEL_META)
  const name = (novel.title || 'world').replace(/[/\\:*?"<>|]/g, '_').trim() || 'world'
  const docs = listSettings()
    .reverse()
    .map((d) => ({ ...readSetting(d.id), category: d.category }))

  // Group by category for sidebar
  const groups: Record<string, { id: string; title: string }[]> = {}
  for (const d of docs) {
    const catLabel = CATEGORY_LABELS[d.category] || d.category
    if (!groups[catLabel]) groups[catLabel] = []
    groups[catLabel].push({ id: d.id, title: d.title })
  }

  // Convert markdown to HTML with wikilink handling
  const { Marked } = await import('marked')
  const marked = new Marked({ gfm: true })
  const mdToHtml = (md: string): string => {
    // Convert [[Title]] wikilinks to anchor links before markdown processing
    const withLinks = md.replace(/\[\[([^\]]+)\]\]/g, (_, title: string) => {
      // Find matching doc by title
      const match = docs.find(
        (dd) =>
          dd.title.toLowerCase() === title.toLowerCase() ||
          dd.id.split('/').pop()?.replace(/\.md$/i, '').toLowerCase() === title.toLowerCase(),
      )
      const anchorId = match ? `doc-${match.id.replace(/[/.]/g, '-')}` : ''
      return `<a href="#${anchorId}" class="wiki-link">${title}</a>`
    })
    return marked.parse(withLinks) as string
  }

  // Build sidebar HTML
  const sidebarHtml = Object.entries(groups)
    .map(
      ([cat, items]) => `
    <div class="wiki-group">
      <div class="wiki-group-title">${cat}</div>
      ${items
        .map(
          (item) =>
            `<a href="#doc-${item.id.replace(/[/.]/g, '-')}" class="wiki-nav-item">${item.title}</a>`,
        )
        .join('\n')}
    </div>`,
    )
    .join('\n')

  // Build content HTML
  const contentHtml = docs
    .map(
      (d) => `
    <div id="doc-${d.id.replace(/[/.]/g, '-')}" class="wiki-doc">
      <h1 class="wiki-doc-title">${d.title}</h1>
      <div class="wiki-doc-meta">Category: ${CATEGORY_LABELS[d.category] || d.category}</div>
      <div class="wiki-doc-body">${mdToHtml(d.content)}</div>
    </div>`,
    )
    .join('\n')

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${novel.title || 'Untitled'} — Codex Wiki</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html { font-size: 15px; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  color: #3B2F24; background: #F5F0EA; display: flex; min-height: 100vh;
}
.wiki-sidebar {
  width: 260px; min-width: 260px; background: #E8E0D6; border-right: 1px solid #D4C8B8;
  overflow-y: auto; padding: 20px 0;
}
.wiki-sidebar h2 {
  font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;
  color: #8A7A62; padding: 0 16px 12px; border-bottom: 1px solid #D4C8B8; margin-bottom: 12px;
}
.wiki-group { margin-bottom: 8px; }
.wiki-group-title {
  font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px;
  color: #A89676; padding: 6px 16px 2px; cursor: default;
}
.wiki-nav-item {
  display: block; font-size: 13px; padding: 4px 16px 4px 20px;
  color: #6B5B47; text-decoration: none; border-left: 2px solid transparent;
  transition: background 120ms, border-color 120ms; border-radius: 0 4px 4px 0;
}
.wiki-nav-item:hover { background: #D4C8B8; border-left-color: #B8642E; color: #3B2F24; }
.wiki-content { flex: 1; overflow-y: auto; padding: 40px 48px; max-width: 900px; }
.wiki-doc { margin-bottom: 60px; }
.wiki-doc-title { font-size: 24px; font-weight: 700; color: #2A2018; margin-bottom: 4px; }
.wiki-doc-meta { font-size: 12px; color: #A89676; margin-bottom: 20px; }
.wiki-doc-body { line-height: 1.75; color: #4E3E30; }
.wiki-doc-body h2 { font-size: 18px; margin: 24px 0 12px; color: #2A2018; }
.wiki-doc-body h3 { font-size: 15px; margin: 20px 0 8px; color: #3B2F24; }
.wiki-doc-body p { margin-bottom: 12px; }
.wiki-doc-body ul, .wiki-doc-body ol { margin-bottom: 12px; padding-left: 24px; }
.wiki-doc-body li { margin-bottom: 4px; }
.wiki-doc-body pre { background: #E8E0D6; padding: 12px 16px; border-radius: 6px; overflow-x: auto; margin-bottom: 12px; }
.wiki-doc-body code { font-family: 'JetBrains Mono', 'Fira Code', monospace; font-size: 13px; }
.wiki-doc-body blockquote { border-left: 3px solid #B8642E; padding: 4px 16px; margin: 0 0 12px; color: #8A7A62; }
.wiki-doc-body table { border-collapse: collapse; width: 100%; margin-bottom: 12px; font-size: 13px; }
.wiki-doc-body th, .wiki-doc-body td { border: 1px solid #D4C8B8; padding: 8px 12px; text-align: left; }
.wiki-doc-body th { background: #E8E0D6; font-weight: 600; color: #3B2F24; }
.wiki-doc-body td { background: #F5F0EA; }
.wiki-doc-body tr:nth-child(even) td { background: #EDE6DC; }
.wiki-doc-body a { color: #B8642E; text-decoration: underline; }
.wiki-link { color: #B8642E; text-decoration: underline; text-decoration-style: dotted; }
.wiki-link:hover { text-decoration-style: solid; }
@media (max-width: 720px) {
  body { flex-direction: column; }
  .wiki-sidebar { width: 100%; min-width: unset; max-height: 40vh; border-right: none; border-bottom: 1px solid #D4C8B8; }
  .wiki-content { padding: 24px 20px; }
}
</style>
</head>
<body>
<nav class="wiki-sidebar">
  <h2>${novel.title || 'Untitled'}</h2>
  ${sidebarHtml}
</nav>
<main class="wiki-content">
  <div class="wiki-doc">
    <h1 style="font-size:28px;margin-bottom:8px;">${novel.title || 'Untitled'}</h1>
    ${novel.author ? `<p style="color:#8A7A62;margin-bottom:4px;">by ${novel.author}</p>` : ''}
    ${novel.synopsis ? `<p style="color:#6B5B47;line-height:1.7;margin-top:12px;">${novel.synopsis}</p>` : ''}
    <hr style="border:none;border-top:1px solid #D4C8B8;margin:24px 0;">
  </div>
  ${contentHtml}
</main>
</body>
</html>`

  return { name, html }
}

// ---- Epub export ----

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function mdToXhtml(md: string): string {
  let html = md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>')
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>')
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>')
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>')
  html = html.replace(/^(?!<[hH]|\s*$)(.+)$/gm, '<p>$1</p>')
  html = html.replace(/\n\n/g, '\n')
  return html
}

export async function exportEpub(): Promise<{ name: string; buffer: Buffer }> {
  const novel = readJSON<NovelMeta>(novelFile(), DEFAULT_NOVEL_META)
  const name = (novel.title || 'world').replace(/[/\\:*?"<>|]/g, '_').trim() || 'world'

  const zip = new JSZip()

  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })

  const containerXml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '\n' +
    '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
    '\n' +
    '  <rootfiles>' +
    '\n' +
    '    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>' +
    '\n' +
    '  </rootfiles>' +
    '\n' +
    '</container>'
  zip.file('META-INF/container.xml', containerXml)

  const chapters: Array<{ title: string; file: string; content: string }> = []
  for (const vol of novel.volumes) {
    for (const ch of vol.chapters) {
      const text = readChapter(ch.file)
      if (text.trim()) {
        chapters.push({ title: ch.title, file: ch.file, content: text })
      }
    }
  }

  const now = new Date().toISOString()
  const bookId = 'urn:uuid:' + crypto.randomUUID()

  const manifestItems: string[] = []
  const spineItems: string[] = []
  const navPoints: string[] = []

  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i]
    const id = 'chapter-' + (i + 1)
    const fname = 'chapter-' + (i + 1) + '.xhtml'
    const bodyHtml = mdToXhtml(ch.content)
    const xhtml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '\n' +
      '<!DOCTYPE html>' +
      '\n' +
      '<html xmlns="http://www.w3.org/1999/xhtml">' +
      '\n' +
      '<head>' +
      '\n' +
      '  <title>' +
      escapeXml(ch.title) +
      '</title>' +
      '\n' +
      '</head>' +
      '\n' +
      '<body>' +
      '\n' +
      '  <h1>' +
      escapeXml(ch.title) +
      '</h1>' +
      '\n' +
      bodyHtml +
      '\n' +
      '</body>' +
      '\n' +
      '</html>'
    zip.file('OEBPS/' + fname, xhtml)
    manifestItems.push(
      '    <item id="' + id + '" href="' + fname + '" media-type="application/xhtml+xml"/>',
    )
    spineItems.push('    <itemref idref="' + id + '"/>')
    navPoints.push(
      '      <navPoint id="navpoint-' +
        (i + 1) +
        '" playOrder="' +
        (i + 1) +
        '">' +
        '\n' +
        '        <navLabel><text>' +
        escapeXml(ch.title) +
        '</text></navLabel>' +
        '\n' +
        '        <content src="' +
        fname +
        '"/>' +
        '\n' +
        '      </navPoint>',
    )
  }

  const ncxParts = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">',
    '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">',
    '  <head>',
    '    <meta name="dtb:uid" content="' + bookId + '"/>',
    '    <meta name="dtb:depth" content="1"/>',
    '    <meta name="dtb:totalPageCount" content="0"/>',
    '    <meta name="dtb:maxPageNumber" content="0"/>',
    '  </head>',
    '  <docTitle><text>' + escapeXml(novel.title) + '</text></docTitle>',
    '  <navMap>',
    navPoints.join('\n'),
    '  </navMap>',
    '</ncx>',
  ]
  zip.file('OEBPS/toc.ncx', ncxParts.join('\n'))

  const opfParts = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="book-id">',
    '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">',
    '    <dc:identifier id="book-id">' + bookId + '</dc:identifier>',
    '    <dc:title>' + escapeXml(novel.title) + '</dc:title>',
    novel.author ? '    <dc:creator>' + escapeXml(novel.author) + '</dc:creator>' : '',
    '    <dc:language>zh-CN</dc:language>',
    '    <dc:date>' + now + '</dc:date>',
    novel.synopsis ? '    <dc:description>' + escapeXml(novel.synopsis) + '</dc:description>' : '',
    '  </metadata>',
    '  <manifest>',
    '    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
    manifestItems.join('\n'),
    '  </manifest>',
    '  <spine toc="ncx">',
    spineItems.join('\n'),
    '  </spine>',
    '</package>',
  ].filter(Boolean)
  zip.file('OEBPS/content.opf', opfParts.join('\n'))

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  return { name, buffer }
}

export { CATEGORY_LABELS, projectRoot }
