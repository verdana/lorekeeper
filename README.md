# Lorekeeper — a local-first writing studio for novelists

Lorekeeper is a self-hosted writing tool for long-form fiction. It keeps your
codex (worldbuilding, characters, geography, plot outlines), your manuscript,
and an AI writers' room in one place — and stores **everything as plain
Markdown + JSON files on your own disk**. No database, no cloud, no account.
Your work is yours: open it in any editor, back it up, or put it under version
control.

Bring your own API key from any OpenAI-compatible provider (OpenAI, DeepSeek,
Kimi, Qwen, a local Ollama…). The app talks directly to the provider you
configure; nothing routes through us.

## Features

| Module | What it does |
| --- | --- |
| **Overview** | Title, author, synopsis, tags; volume/chapter/word-count stats; codex overview; one-click **export** of the whole book as a `.zip`. |
| **Codex** | Worldbuilding, characters, geography, society & economy, plot outline, misc — Markdown docs with an inline AI assistant (polish, expand, find gaps, suggest hooks). |
| **Manuscript** | Volume → chapter tree, a full Markdown editor, **Zen mode**, autosave, and live word counts. |
| **Writers' Room** | Assemble AI personas and discuss a story problem — diverge for broad exploration, converge to drill one point. Moderator summarizes; merge conclusions into the codex. Export transcripts. Preset templates for plot holes, character arcs, pacing. |
| **Consistency Check** | AI reads your codex and chapters to surface contradictions — name drift, timeline conflicts, system violations, forgotten setups. |
| **History** | Automatic version snapshots taken before every save or deletion. Recover a chapter or codex entry if the AI garbled it or you deleted it by mistake. |
| **Multi-world** | Create worlds from a one-line AI prompt, seed files, or start blank. Switch between them freely. Each world has its own complete codex and manuscript. |

## Quick start

Requires [Node.js](https://nodejs.org/) and [pnpm](https://pnpm.io/).

```bash
pnpm install
pnpm dev              # dev server (hot reload) → http://localhost:5173
```

Build and serve the production site:

```bash
pnpm build
pnpm start            # serves built app + API → http://localhost:5178
```

### Build the desktop app (Electron)

Pre-built binaries are available on the
[Releases](https://github.com/verdana/lorekeeper/releases) page — download the
installer for your platform and run it directly. No Node.js or build tools needed.

To build from source:

On Windows:

```bash
pnpm dist
```

On Linux / WSL (cross-build for Windows):

```bash
pnpm dist --win
```

Build for Linux (requires native dependencies):

```bash
pnpm dist --linux
```

Outputs a portable zip (`dist/Lorekeeper-0.1.0-win.zip`). Unzip and double-click
`Lorekeeper.exe` — no Node.js or install needed.

On first launch you get a small example world ("The Emberwright's Covenant") so
you can explore every feature immediately. Open **Settings → AI Providers**, add
your API key, and click **Test connection** to get started.

## Where your data lives

By default everything is stored under `~/.lorekeeper`:

```
worlds.json         index of your worlds
config.json         AI providers + personas (shared across worlds)
worlds/<id>/
  novel.json          volume/chapter structure
  settings/           codex documents (Markdown, grouped by category)
  chapters/           chapter prose (Markdown)
  discussions/        writers' room sessions (JSON)
  .snapshots/         automatic version history
```

Override the location with the `ORBIT_DATA_DIR` environment variable.

## AI providers

Any service that implements the OpenAI `POST {baseUrl}/chat/completions` API
 works:

 - OpenAI — `https://api.openai.com/v1` (append `/v1`)
 - DeepSeek — `https://api.deepseek.com` (no `/v1` suffix)
 - Kimi / Moonshot — `https://api.moonshot.cn/v1` (append `/v1`)
 - Local Ollama — `http://localhost:11434/v1` (append `/v1`)

## Privacy & security

- **Local-first.** Your manuscript never leaves your machine except in the
  requests you make to the AI provider you configured.
- The local API only accepts requests from the app itself; other websites in
  your browser cannot reach it to read your API keys.
- Your API keys are encrypted on disk using your OS secure storage
  (Windows DPAPI / macOS Keychain).

## License

[Source Available — Non-Commercial](./LICENSE) © 2026 Verdana Mu

