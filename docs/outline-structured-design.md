# Structured Outline — Design (rev 3)

Status: Implemented (P1–P3 landed 2026-08-16; see Implementation notes)
Owner: Project maintainer
Date: 2026-08-16

## 1. Background

The outline ("大纲") is currently stored as Markdown files under each world's
`outline/` directory (with a legacy single-file fallback at `<world>/outline.md`).
Every AI feature that needs the outline calls `readOutline()`, which concatenates
all Markdown files into one text blob. The Outline view is a generic multi-document
Markdown editor.

Problems:

- **The outline blob is unstructured.** AI consumers receive one big text dump and
  must re-parse it with regex (`outlineBeats.ts` matches `^#### 第XX章｜标题`
  headings to find a chapter's beats). The real-world file used `### 第一章：…`
  headings, so the extraction silently missed.
- **Unrelated information lives in the outline.** Volume-level commercial rhythm
  ("付费点分布"), macro arc planning ("大事件规划"), and appended discussion
  conclusions were mixed into the same files. AI context therefore carried junk,
  and the budget allocator truncated the long outline (28% share) before the
  per-chapter beats that matter were reached.
- **The module is not simpler.** The UI is a bare Markdown editor; nothing
  enforces structure, volume/chapter semantics, or status.

Goal: store the outline as structured JSON, keep only outline information in the
outline module, give the view the card-based 分卷-章节大纲 UI (per the reference
HTML), and make every AI consumer receive clean, derived text instead of raw files.

## 2. Design decisions

| #   | Decision                                                                                                                                                                                                                                                                               | Rationale                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Single structured store per world: `outline/outline.json`, versioned.                                                                                                                                                                                                                  | Matches the existing `timeline.json` / `story-memory.json` pattern; atomic writes + snapshots already exist.                              |
| D2  | **The outline is the single source of truth for structure. Its ids are authoritative.** Volume/chapter ids and titles are created and owned by the outline store; `novel.json` is a **synced mirror** (same ids, titles, order) plus prose state (file, wordCount, status, updatedAt). | Author's feedback: outline ids win (第一卷 id1, 第二卷 id2, …); Manuscript auto-syncs to them. One canonical structure, no id divergence. |
| D3  | **Manuscript stops creating volumes/chapters.** The Manuscript view is prose-only: edit body, toggle draft/final, watch word counts. All structure operations (create / rename / reorder / delete volume & chapter) move to the Outline view.                                          | Author's feedback: prevents ids diverging and losing the association.                                                                     |
| D4  | `writeOutlineStore` persists the store **and re-syncs `novel.json` in the same call**, returning the updated `NovelMeta`.                                                                                                                                                              | One call = one consistent state; the Outline view refreshes the app's `novel` from the returned meta.                                     |
| D5  | The AI-facing outline text is **derived** from the store by `serializeOutlineForAI()`, never the source of truth.                                                                                                                                                                      | Consumers keep one clean entry point; junk-free, deterministic, ordered; regex extraction is deleted.                                     |
| D6  | Legacy cleanup (author deleted their `outline.md`): remove all single-file `outline.md` support code. Multi-file `outline/*.md` migration is best-effort and non-destructive.                                                                                                          | Nothing lost; obsolete compatibility code cleaned up as requested.                                                                        |
| D7  | Unrelated content moves out: macro arc plan → structured `overview` field; volume rhythm/configuration → volume config fields; discussion conclusions stop appending to the outline.                                                                                                   | The outline module keeps only outline information; the feature gets simpler.                                                              |
| D8  | `readOutline()` stays in the API contract, reimplemented on the store, so Discussion and Consistency views keep working unchanged.                                                                                                                                                     | Lowest-risk compatibility path for AI consumers that only need text.                                                                      |
| D9  | New RPC surface: `readOutlineStore` / `writeOutlineStore`. Legacy per-doc outline APIs and `writeOutline` are removed.                                                                                                                                                                 | Whole-store save matches `saveTimelineEvents`; the legacy APIs are only used by the old view and the deleted discussion-append path.      |

## 3. Data model

New types in `src/shared/types.ts`:

```ts
/** Structured outline store — the single source of truth for structure, per world. */
export interface OutlineStore {
  version: 1
  updatedAt: number
  /** 全书总览 / 宏观规划（原「大事件规划」等顶层内容）。 */
  overview: string
  /** 大纲模块自身的备注（不被 AI 序列化注入）。 */
  notes: string
  volumes: OutlineVolumeData[]
}

export type OutlineVolumeStatus = 'planned' | 'planning' | 'confirmed'
// 未配置（slate）：仅标题，无章节
// 规划中（violet）：卷配置已设置，章节要点在生成/编辑中
// 已确认（green）：章节要点已写定并锁定

export interface OutlineVolumeData {
  /** 大纲权威 id（uid('v_')）。同步到 novel.json Volume.id。 */
  id: string
  /** 卷标题（如「·废铁砸门」）。大纲为权威，同步到 novel.json。 */
  title: string
  /** 本卷简介（原「本卷简介」块）。 */
  summary: string
  /** 卷配置：目标、爽点、商业节奏等（原散落在大纲 md 里的付费点/节奏内容）。 */
  config: string
  status: OutlineVolumeStatus
  chapters: OutlineChapterData[]
}

export interface OutlineChapterData {
  /** 大纲权威 id（uid('c_')）。同步到 novel.json Chapter.id。 */
  id: string
  /** 章标题（第XX章｜标题）。大纲为权威，同步到 novel.json。 */
  title: string
  status: 'planned' | 'confirmed'
  beats: OutlineBeat[]
}

export interface OutlineBeat {
  title: string // 要点名，如「咣当一声」
  summary: string // 要点正文（原每章 block 的正文）
}
```

`novel.json` stays the view-model every existing view already reads: its
`Volume`/`Chapter` entries mirror the outline store's ids, titles, and order, and
additionally carry prose state (`file`, `wordCount`, `status: 'draft' | 'done'`,
`updatedAt`). Prose state is **not** in the outline store.

Semantics:

- **Lookup is by id.** `findOutlineChapter(store, chapterId)` is a direct key
  lookup — no title/ordinal matching needed anywhere.
- **Display range** "第1-10章（共10章）" is computed from the volume's chapter list.
- **Volume status** can be derived on load when unset: no chapters → `planned`;
  chapters present but not all confirmed → `planning`; all confirmed →
  `confirmed`. An explicit `status` wins.
- New chapter body files use deterministic names `${volumeId}_${chapterId}.md`
  so re-sync is idempotent; existing chapters keep their current file paths.

## 4. Storage and file layout

- New path: `outlineJsonFile() = <world>/outline/outline.json` (add to
  `src/server/paths.ts`; the `outline/` dir already exists via
  `ensureWorldSkeleton`).
- Writes go through `atomicWrite` + `snapshot()`. `snapshot()` already covers the
  `outline/` prefix, so `outline/outline.json` gets version history for free.
- **Legacy cleanup (as requested):** remove `outlineFile()` (`<world>/outline.md`),
  the legacy fallbacks in `outlineDocPath` / `listOutlineDocs` /
  `collectOutlineFiles`, and `writeOutline()`.
- `collectWorldFiles()` walks every file, so the JSON is included in world exports
  automatically. `collectOutlineFiles()` (the `exportOutline` zip) is updated
  explicitly (see §7).

## 5. Migration

`readOutlineStore()` (server) resolves the store in this order:

1. `outline/outline.json` exists → load, normalize, then **re-sync `novel.json`
   from it** (repairs any drift), return.
2. `novel.json` has volumes → **build the outline store from the manuscript
   structure** (each volume/chapter becomes an outline entry with empty beats;
   ids and titles preserved). The outline owns structure from then on.
3. Legacy `outline/*.md` files exist → parse and merge: match chapters to
   existing `novel.json` entries by title/ordinal (attach beats under their ids),
   create outline entries for unmatched ones, then sync.
4. Else → return the empty store.

Migration is best-effort and lossless-by-default: unparsed md content goes to
`volume.config` / `store.notes`; legacy md files are left untouched on disk as a
read-only archive.

## 6. Shared module: `src/shared/outlineStore.ts`

New shared module (server + renderer import it, like `storyMemory.ts` /
`chapterMemory.ts`):

- `emptyOutlineStore(): OutlineStore`
- `normalizeOutlineStore(raw: unknown): OutlineStore` — version/field validation,
  default filling; unknown fields tolerated.
- `parseLegacyOutline(text: string): { overview, volumes: {title, summary, config, chapters: {title, beats}[]}[] }`
  (pure parse; structure creation happens server-side against `novel.json`).
- `serializeOutlineForAI(store: OutlineStore): string` — the derived text all AI
  consumers receive:

```
# 全书大纲

## 卷1 · 废铁砸门（第1-10章）｜已确认

本卷简介：……

### 第01章｜咣当一声
- 咣当一声：陆小满正懒洋洋趴在柜台上……
- 夜半低语：半夜，陆小满被一阵嗡嗡低语吵醒……

### 第02章｜夜半低语
……
```

Deterministic, ordered, junk-free (no discussion appendices, no raw notes).

- `findOutlineChapter(store, chapterId): OutlineChapterData | null` — direct id
  lookup, used by drafting.
- `syncNovelFromOutline(meta: NovelMeta, store: OutlineStore): NovelMeta` —
  rebuild `volumes` from the store (ids/titles/order), preserving `file`,
  `wordCount`, `status`, `updatedAt` for matching ids, creating placeholder
  entries (`file: ${volumeId}_${chapterId}.md`, wordCount 0, status 'draft') for
  new ones, dropping volumes/chapters absent from the store. Top-level
  `title/author/synopsis/tags` are preserved.

`outlineBeats.ts` (renderer) is deleted; `extractChapterOutline` is replaced by
`findOutlineChapter` against the store.

## 7. Server API changes (`src/server/store.ts`, `index.ts`, `types.ts`)

New API methods (added to `Api` + handlers table):

```ts
readOutlineStore: () => Promise<OutlineStore>
/** Persists the store, re-syncs novel.json from it, returns the synced meta. */
writeOutlineStore: (store: OutlineStore) => Promise<NovelMeta>
```

`readOutline()` reimplemented as `serializeOutlineForAI(readOutlineStore())` —
Discussion, Consistency, and the AiAssistPanel context loader keep working with
zero view changes and immediately receive clean derived text.

Removed from the contract: `writeOutline`, `listOutlineDocs`, `readOutlineDoc`,
`writeOutlineDoc`, `createOutlineDoc`, `deleteOutlineDoc`, and the
`OutlineDoc`/`OutlineDocContent` types. History restore of old `outline/*.md`
snapshots keeps working through the generic `restoreSnapshot` path.

`collectOutlineFiles()`: zip now contains `outline/outline.json` plus a generated
human-readable `outline/outline.md` (the `serializeOutlineForAI` output), plus any
legacy `outline/*.md` archives still on disk.

`describeSource()`: special-case `outline/outline.json` → label `Outline`.

`writeOutlineStore` validation: ids must be non-empty strings; duplicate ids are
rejected. Since `novel.json` is rebuilt from the store, orphan data cannot exist.

## 8. What moves out of the outline module

| Content                        | Current home                          | New home                                                                                                                                          |
| ------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 全书大事件宏观规划             | first block of outline.md             | `store.overview` (structured field, editable in the view header)                                                                                  |
| 卷付费点 / 商业节奏 / 爽点     | `### 第一卷核心付费点…` sections      | `volume.config` (editable via Set Volume Config)                                                                                                  |
| 讨论室结论 appended to outline | Discussion `distributeConclusion`     | **Removed (confirmed)**; Timeline and Story Memory distribution remain. Conclusions that belong in the outline are added manually via the editor. |
| 长文参考资料 / 样章            | occasionally pasted into outline docs | Codex settings docs (existing feature)                                                                                                            |
| 卷规划 + 章细纲                | md headings                           | Structured `OutlineVolumeData` / `OutlineChapterData` / `OutlineBeat`                                                                             |

The outline module after this change holds exactly: overview, volumes, chapters,
beats, and volume configuration. Nothing else.

## 9. AI consumer integration

| Consumer                          | Change                                                                                                                                                                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AiAssistPanel.useOutlineContext` | `readOutline()` unchanged (server-side serialized); `extractChapterOutline(...)` → `findOutlineChapter(await readOutlineStore(), chapterId)`; beats stay their own high-priority context layer. Context-budget allocator unchanged (input strings). |
| `Consistency.buildContext`        | No change (`readOutline()` reimplemented).                                                                                                                                                                                                          |
| `Discussion.buildContext`         | No change (`readOutline()` reimplemented).                                                                                                                                                                                                          |
| `Discussion.distributeConclusion` | Outline distribute option removed (confirmed); `writeOutline` usage deleted.                                                                                                                                                                        |
| `contextBudget.ts`                | Interface unchanged; cleaner outline text makes the 28% share go further.                                                                                                                                                                           |
| `Chapters.tsx` (Manuscript)       | Structure creation removed (D3): delete New Volume / New Chapter / rename / reorder / delete UI and handlers; keep prose editing, draft/final toggle, word counts, autosave, generation evidence.                                                   |

New prompts in `src/shared/prompts` (`en.ts` / `zh.ts` / `types.ts`):
`outline.generateChapters` — given the volume summary/config, confirmed neighbor
chapters, and relevant codex, propose N chapter records each with beats, returned
as JSON. Result is a **draft** the author reviews in the UI before applying; on
confirm the chapters are written to the outline store and `novel.json` is
re-synced.

## 10. UI design (per the reference HTML, adapted to the dark theme, English labels)

The Outline view becomes a single scrollable structured page (no sidebar, no
Markdown editor). Static labels are **English** (per feedback; the app's UI
language is English), with `i18n.ts` entries so zh can be switched later.

### 10.1 Layout

- **Card shell**: one `bg-ink-900 border border-ink-800 rounded-xl shadow-warm-lg`
  card with a `card-header` row: `BookOpen` icon (violet) + title
  "Volume · Chapter Outline".
- **Header actions**: Overview (expand/collapse overview editor), New Volume,
  AI Generate, Export (reuses `/api/exportOutline`).
- **Volume cards** stack inside the card body (`space-y-3`), following the
  reference status colors:
  - `confirmed` → green border (`border-star-success/60 bg-star-success/5`),
    ✓ badge "Confirmed";
  - `planning` → violet (`border-violet-500/60 bg-violet-500/5`), numbered badge,
    actions Edit / Set Volume Config / AI Generate / Manual Edit;
  - `planned` → slate (`border-ink-700 bg-transparent`), numbered badge, no
    actions.
- **Volume header row**: status circle (✓ / number), title, derived range
  "Ch. 1-10 (10 total)", status badge, chevron toggle, edit + reorder
  (up/down) + delete buttons.
- **Volume summary block**: "Summary:" + summary text (the reference's
  `bg-white/50` block mapped to `bg-ink-850/60`).
- **Chapter list** (expandable per volume): each chapter is a
  `bg-ink-850/60 rounded-lg p-3` row with a numbered circle (green when
  `confirmed`, slate otherwise), chapter title, reorder (up/down) + delete
  buttons, and a collapsible beats body. Beats render as `title` + `summary`
  (one beat per line), matching the reference's per-chapter layout.
- **Empty state** for volumes without chapters (reference vol 2): centered
  `Sparkles` icon + button row Set Volume Config / AI Generate / Manual Edit.

### 10.2 Editing surfaces

- **New Volume**: creates an `OutlineVolumeData` (uid) with a placeholder title
  and immediately syncs `novel.json`.
- **Set Volume Config modal**: title, summary, config (goals/beats per
  volume/commercial rhythm, multiline), status cycle.
- **Manual Edit (chapter/beat editor)**: chapter-level form — status toggle,
  beats list (add/remove/reorder, each beat = title input + summary textarea).
  Adding a chapter here creates an `OutlineChapterData` (uid) and syncs.
- **AI Generate modal**: pick target volume (or new volume), optional
  instructions; streams a proposed chapter+beat list; author edits and confirms;
  on apply the chapters are written with `planning`/`confirmed` status per the
  author's choice and `novel.json` is re-synced.
- **Status interaction**: clicking a status badge cycles planned → planning →
  confirmed (with undo via the same click).
- Every mutating action calls `writeOutlineStore` and refreshes the app's
  `novel` from the returned meta (the Manuscript view therefore always sees the
  synced tree).

### 10.3 Relationship to the Manuscript view

The outline owns structure; Manuscript is prose-only. Chapters planned in
Outline appear in Manuscript as empty drafts; Manuscript's saves update only
word counts / draft-final status and never the structure. The Manuscript tree is
refreshed whenever the Outline view syncs.

## 11. Compatibility and rollout

### Phase 1 — Data + compatibility (no visible UI change)

1. Types in `shared/types.ts`; new shared module `shared/outlineStore.ts`
   (empty/normalize/parse/serialize/find/sync).
2. `paths.ts` `outlineJsonFile()` + legacy `outlineFile()` removal; server
   `readOutlineStore` / `writeOutlineStore` with migration + novel.json re-sync;
   `readOutline()` reimplemented; legacy doc APIs and `writeOutline` removed from
   the contract.
3. New Api methods + handlers. `AiAssistPanel` beats lookup switched to the
   store. `Discussion` distribute-to-outline removed. `Chapters.tsx` structure
   creation removed (D3).
4. Tests: `parseLegacyOutline`, `serializeOutlineForAI`,
   `findOutlineChapter` (by id), `syncNovelFromOutline` (preserve prose state,
   idempotent), server migration + `readOutline`, handler contract updates.

### Phase 2 — View rewrite

5. `views/Outline.tsx` replaced by the structured card UI (§10); `outlineBeats.ts`
   deleted; `collectOutlineFiles` + `describeSource` updated; i18n entries added.

### Phase 3 — AI generation

6. Outline generation prompts (`en.ts`/`zh.ts`/`types.ts`), AI Generate wizard,
   volume-config and chapter-editor polish.

Phase 1 is safe to land alone (existing UI unaffected except Manuscript losing
structure buttons; AI context improves immediately). Phases 2 and 3 are the
user-visible change.

## 12. Files touched

- `src/shared/types.ts` — OutlineStore types; Api contract changes
  (add `readOutlineStore`/`writeOutlineStore`, remove legacy outline doc APIs).
- `src/shared/outlineStore.ts` — new shared module.
- `src/shared/prompts/{types,en,zh}.ts` — outline generation prompts.
- `src/server/paths.ts` — add `outlineJsonFile()`, remove `outlineFile()`.
- `src/server/store.ts` — store RPCs, migration, novel.json re-sync,
  `readOutline` reimplementation, `collectOutlineFiles`, `describeSource`,
  legacy cleanup.
- `src/server/index.ts` — handlers.
- `src/renderer/src/views/Outline.tsx` — full rewrite.
- `src/renderer/src/views/Chapters.tsx` — remove structure creation (D3).
- `src/renderer/src/components/AiAssistPanel.tsx` — beats lookup.
- `src/renderer/src/views/Discussion.tsx` — distribute change.
- `src/renderer/src/outlineBeats.ts` — deleted.
- `src/renderer/src/i18n.ts` — outline view labels.
- `tests/outlineStore.test.ts` (new), `tests/outlineDocs.test.ts` (replaced),
  `tests/api.test.ts` (updated).

## 14. Implementation notes (P1–P3 landed 2026-08-16)

- All phases implemented in one pass: structured store, migration, novel.json
  re-sync, Manuscript structure lock, card-based Outline view, and the AI
  Generate wizard with `outline.generateChapters` prompts (`en`/`zh`).
- The Outline view's static labels are hardcoded English like the rest of the
  app UI (the `i18n.ts` dictionary was not extended; the design's per-view i18n
  entries were dropped for consistency with the app convention).
- Legacy tests `tests/renderer/outlineBeats.test.ts` and
  `tests/server/outlineDocs.test.ts` were deleted; replacements are
  `tests/shared/outlineStore.test.ts` and `tests/server/outlineStore.test.ts`.
- `typecheck`, `lint`, and the full test suite (218 tests) pass.

## 13. Risks and mitigations

| Risk                                                        | Mitigation                                                                                                                                                                           |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Migration misparses a real outline                          | Tolerant, lossless-by-default parser (unparsed → config/notes); legacy files stay on disk; snapshots cover `outline/`; History restore works.                                        |
| Long outlines still exceed AI budget                        | Serialization is compact and ordered; beats are a separate high-priority layer; the allocator can later lower the outline share without contract changes.                            |
| Manuscript saves a stale `novel.json` after an outline sync | `writeOutlineStore` returns the synced meta and the Outline view refreshes the app store; Manuscript saves whole-novel copies of the refreshed tree (same pattern as today's views). |
| Deleting a chapter removes its prose from the tree          | Mirror of today's delete behavior: the prose file stays on disk and remains recoverable; removal is also undoable via History/snapshots.                                             |
| AI-generated beats conflict with the author's plan          | Generation is draft-only, previewed and editable; nothing is written without confirmation.                                                                                           |
| Whole-store save races with the UI                          | Same pattern as timeline/story-memory (whole-list save); snapshots before every write.                                                                                               |
