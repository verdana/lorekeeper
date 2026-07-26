## ✨ New Features

- **AI Provider max_tokens** — Each provider now has a configurable max output
  token limit. The input accepts human-friendly formats: `128k`, `128,000`, or
  plain numbers. Leave empty to let the model use its own default.
- **World editing from WorldGate** — Hover over a world card to reveal an edit
  button. Change the title, genre, and cover color inline without entering the
  world.
- **Fade-in view transitions** — Page switches now animate with a subtle 120 ms
  fade-in, respecting `prefers-reduced-motion`.
- **CJK-friendly font stack** — The editor and reader now use system CJK fonts
  (Noto Sans SC, PingFang SC) alongside Space Grotesk for Latin, with a bumped
  minimum font size of 11 px.

## 🔧 Improvements

- **Unified semantic color tokens** — Replaced ad-hoc slate overrides and raw
  hex values with a consistent `ink-*` / `star-*` palette (`ink-deep`,
  `ink-body`, `ink-muted`, `star-accent`, etc.), making theming and future dark
  mode tractable.
- **Dashboard auto-save** — The Overview page now auto-saves 2 seconds after the
  last keystroke. Also saves on view switch and attempts a `sendBeacon` save on
  tab/window close. Ctrl+S / Cmd+S works everywhere.
- **Consolidated AI toolbar** — Outline writing, continuation, and polish
  actions are now grouped into a single dropdown in the Chapters toolbar,
  reducing clutter.
- **Consistent content width** — All non-editor views now share `max-w-4xl` for
  a more uniform reading layout.
- **Card & alert polish** — Hover borders on interactive cards, a "Recommended"
  badge on the one-line prompt mode card, and strengthened error alert styling.
- **Error Boundary** — Each view is now wrapped in a React Error Boundary. A
  render crash in one view no longer takes down the sidebar or other views.

## 🏗️ Infrastructure

- **Lint / Format pipeline** — Added ESLint (flat config), Prettier, husky,
  lint-staged, and commitlint. Pre-commit hooks auto-format staged files and
  validate commit messages against conventional commits.
- **Build clean** — `pnpm build` and `pnpm dist` now clean `out/` and `dist/`
  before starting, eliminating incremental-build artifacts.
- **Version snapshots** — Snapshot failures now log a `console.warn` so
  disk/permission issues don't go unnoticed.

## 🐛 Fixes

- **max_tokens no longer hardcoded** — `max_tokens: 16384` was baked into every
  AI request regardless of model. Now reads from the per-provider config, and is
  omitted entirely when unset (model default applies).
- **Electron second-instance** — If the main window has been destroyed (macOS
  close, crash), a second launch attempt now recreates it instead of silently
  doing nothing.
- **React 19 useRef compatibility** — Fixed a type error where `useRef<T>()`
  without an initial value failed under React 19 + TypeScript 7.

---

**Full Changelog**: https://github.com/verdana/lorekeeper/compare/v0.1.0...v0.1.1
