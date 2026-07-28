## ✨ New Features

- **Bidirectional wikilinks** - `[[Title]]` syntax now links Codex documents
  together. Wikilinks render as clickable elements in read mode, navigate to the
  target document on click, and a backlinks panel shows incoming references in
  the Codex sidebar.
- **Static HTML wiki export** - A server-side endpoint generates a
  self-contained HTML wiki from all Codex documents, with sidebar navigation and
  warm-toned responsive styling. Triggered from a new "Export wiki" button on the
  Dashboard.
- **Codex health stats** - A collapsible stats panel in the sidebar shows
  per-category document counts (color-coded), a total word count, and flags
  under-developed docs below 50% of the average word count with quick-access
  buttons to open them with the AI assist panel.
- **Timeline view** - A new page for chronological world-event management: create,
  edit, and delete events with date labels and sort order, associate them with
  Codex document references, and browse a visual timeline with dot markers and
  hover-action cards. Events persist per world as `timeline.json`.
- **Codex graph view** - An interactive force-directed graph visualizes all Codex
  documents as nodes connected by wikilink references, using a ForceAtlas2-based
  layout with category-colored nodes and double-click navigation.
- **Category-specific document templates** - Each of the 6 Codex categories
  (worldview, character, geography, economy, outline, misc) now seeds a rich
  Markdown template so new docs start with a structured scaffold.

## 🔧 Improvements

- **Sidebar nav ordering** - The Graph nav item is placed between Codex and
  Timeline for a more logical reading flow.

## 🏗️ Infrastructure

- **`publish.ps1` release script** - A new publish script runs pre-flight checks
  for node/pnpm, warns on uncommitted changes, runs typecheck and lint before
  building, cleans previous artifacts, forces English prompts
  (`PROMPT_LANG=en` / `VITE_PROMPT_LANG=en`), and runs `pnpm dist --publish`.

## 🐛 Fixes

- **Graph view node disappearance** - Hovering graph nodes caused physics
  re-layouts and dimmed non-highlighted nodes to 30% opacity, making the graph
  appear to vanish. Physics is now frozen after initial stabilization, hover
  dimming is disabled, and the problematic hover interaction is turned off
  entirely.
- **Wiki export ESM import** - `require('marked')` failed under ESM; the export
  path now uses an async dynamic `import('marked')`.
- **Wiki export table styling** - Exported tables were unstyled. Added bordered
  table CSS with alternating row colors and an explicit `gfm: true` parse option.
- **Wikilink HTML in read mode** - Added the `rehype-raw` plugin so the HTML
  produced by wikilink resolution renders correctly in Codex read mode.
- **World card accent bar overlap** - The color accent bar overlapped the
  top-right edit/delete buttons. It is now absolutely positioned at the card's
  top edge with `overflow-hidden` so it clips cleanly at the border-radius.

---

**Full Changelog**: https://github.com/verdana/lorekeeper/compare/v0.1.1...v0.1.2
