# Novel Forge — Design Notes

Status: Implemented (v0.3.0)
Scope: `src/shared/forge.ts`, `src/server/forge.ts` + `src/server/forge/*`,
`src/renderer/src/views/Forge.tsx`, `forge` section of the prompt packs,
`Api` contract + handlers.
Related: `docs/outline-structured-design.md` (structured outline),
`WRITING_QUALITY_ROADMAP.md` (generation-evidence discipline).

## 0. Module map

The engine is layered so that a question can be answered by reading one file:
"what is persisted, and when" is `forge/state.ts`, "what does a prompt receive"
is `forge/context.ts`, "what runs next" is `forgeNextWork` in `shared/forge.ts`
driven by the loop in `forge.ts`.

| Module                            | Owns                                                                                                 |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `shared/forge.ts`                 | Pure logic: stage parsers, run normalization, the work scheduler, progress, context budgets. No I/O. |
| `server/forge/limits.ts`          | Types and tunables shared by every stage (timeouts, per-prompt budgets).                             |
| `server/forge/state.ts`           | Live-run registry (`ActiveRun`), run-file I/O, logging, world guards.                                |
| `server/forge/model-call.ts`      | One recorded, retried, usage-accounted model call.                                                   |
| `server/forge/context.ts`         | Prompt context: concept digest, beats, codex digest, voice, outline construction.                    |
| `server/forge/planning-stages.ts` | concept, codex, outline, next arc.                                                                   |
| `server/forge/chapter-stages.ts`  | blueprint, prose, memory, review, finalize.                                                          |
| `server/forge.ts`                 | Public control surface (start/pause/resume/cancel/directives/re-draft/continue) and the loop.        |

## 1. Purpose

Lorekeeper's earlier workflow assumed an author who already had a world and a
plan: the tool helped build the codex, plan chapters, and draft one chapter at a
time from an outline the author wrote. Novel Forge adds the missing entry point
— **a theme in, a whole novel out** — without giving up the properties that make
the rest of the tool trustworthy: plain files on disk, snapshots before every
write, resumable long-running work, and recorded evidence for every model call.

The writing-quality roadmap deliberately excluded "one-click novel generation"
as a near-term quality goal. That roadmap is closed (2026-09-10). Forge is an
experimental, opt-in path: it never runs unless the author starts it, it writes
into the ordinary world layout (so every existing view, review tool and export
works on its output unchanged), and it keeps the roadmap's evidence discipline.
It does not replace the manual chapter workflow and does not run automatically.

## 2. Pipeline

One stage at a time, each committed to disk before the next starts.

| #   | Stage      | Input                                                                                                                              | Output                                                                                              |
| --- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1   | `concept`  | theme, optional genre / tone / POV / constraints, length targets                                                                   | `ForgeConcept` (title, genre, logline, synopsis, themes, tone, pov, style guide, cast, world notes) |
| 2   | `codex`    | concept                                                                                                                            | 6–10 codex documents → `settings/<category>/<title>.md`                                             |
| 3   | `outline`  | concept + codex digest + chapter count                                                                                             | `OutlineStore` → `outline/outline.json`, mirrored into `novel.json`                                 |
| 4   | `draft`    | concept, chapter beats + contract, scene blueprint, codex digest, story state, story-so-far, previous chapter tail, voice material | `chapters/<volume>_<chapter>.md` + word count in `novel.json`                                       |
| 5   | `memory`   | the chapter's saved prose                                                                                                          | `chapter-memory/summaries/<id>.json` → rebuilt `story-state.json`                                   |
| 6   | `review`   | concept, planned beats and contract, drafted prose                                                                                 | Review Queue items + a saved consistency report                                                     |
| 7   | `finalize` | concept                                                                                                                            | book title / synopsis / tags committed to `novel.json` (and `worlds.json`)                          |

`memory` always runs before the next `draft`: chapter N+1 is prompted with
chapter N's summary and end state already in hand. In `plan` scope the pipeline
stops after `outline` and skips `draft` / `memory` / `review`.

The `draft` unit is itself two things. It first proposes the chapter's **scene
blueprint** — one `blueprint` call, written into the outline so the author can
edit it — and then drafts the chapter from that blueprint: a chapter with two or
more scenes is written one call per scene, each from its own scene plus the tail
of what the scene before it actually wrote, while a single-scene chapter keeps
the one-pass draft because a second call would buy nothing. A blueprint that
cannot be proposed, or a scene that keeps failing, falls back to the one-pass
draft with the blueprint still in the prompt — a chapter is never lost to a
blueprint problem.

## 3. State machine and resumability

The run record is `<world>/forge/run.json` (written atomically: temp file →
fsync → rename). It holds the brief, the concept, the per-chapter state, every
model-call step, and a bounded log.

The next unit of work is **derived from persisted state alone**
(`forgeNextWork(run)` in `src/shared/forge.ts`), not from an in-memory cursor:

1. no completed `concept` step → concept;
2. no completed `codex` step → codex;
3. no completed `outline` step → outline;
4. first drafted chapter whose memory is missing → memory;
5. first undrafted chapter inside the draft limit → draft;
6. `review`, when the number of drafted chapters exceeds `reviewedUpTo`;
7. `finalize` once.

Consequences:

- **Resume is free.** A pause, a crash, or an app restart resumes at the last
  incomplete unit; completed stages are never paid for twice.
- **A step that fails cannot loop.** Each chapter unit has its own attempt
  budget (`attempts` for prose, `memoryAttempts` for the summary). When the
  budget is spent the unit is skipped, the book continues, and the failure is
  recorded on the chapter and in the log. `Resume` resets those budgets and
  retries — which is exactly what an author does after fixing a provider.
- **The review never blocks the book, and stays current.** It records how many
  drafted chapters it covered (`reviewedUpTo`) on the attempt rather than on
  success, so a failed pass ends the stage with a warning instead of retrying
  forever — and writing more chapters later makes it due again.
- **Interrupted runs are visible.** A `running` record with no live loop is
  reported as `paused` on read, and its in-flight step is marked failed.

### 3.1 Author steering

The author edits the _run_, not a copy of it: while a loop is live, mutations go
through `currentRunForWrite()`, which returns the in-memory run the loop owns.
Writing to the on-disk copy instead would be silently overwritten by the loop's
next step, so this indirection is what makes mid-run editing trustworthy (it is
covered by a test that edits a run while a model call is in flight).

| Action                  | Effect                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direction (standing)    | A `ForgeDirective` with `fromOrder = N` is injected into every draft of chapter N and later, as a binding block that overrides the plan on conflict.                                                                                                                                                                                                      |
| Direction (one chapter) | `onlyOrder = N` scopes an instruction to a single chapter; a re-draft replaces the previous one so attempts cannot stack contradictory notes.                                                                                                                                                                                                             |
| Write a chapter again   | The chapter's prose and summary are reset (`pending`, attempts cleared), `reviewedUpTo` is clamped to just before it, and the loop re-drafts that chapter before anything else. Later chapters are untouched, and the log names how many still follow the previous version.                                                                               |
| Keep going              | `forgeMoreChapters(n)` raises `brief.draftCount` (switching a plan-only run to drafting) and resumes; chapters that are still "given up" become retryable first via `Resume`.                                                                                                                                                                             |
| Act on a finding        | The reviewer's findings are kept on the run (`findings`) as well as queued, so the author can resolve one where it was reported: the view matches the finding's chapter title to a chapter and re-drafts it with the finding text as that chapter's instruction. No new model surface — it reuses the re-draft path and the chapter-only direction layer. |
| Plan the next arc       | `forgeExtendPlan(n)` sets `planRequest` on the run; the loop serves it with one `expand` call that plans N further chapters _from what actually happened_ (plan tail + chapter summaries) and appends them to the outline's last volume. The draft limit grows by the same amount, so the pipeline drafts them next and the review covers them.           |

Directions are prompt-layer input only: they never rewrite prose that already
exists. Changing the course of written chapters is the re-draft action's job.
`planRequest` is deliberately a persisted request rather than an immediate model
call, so expanding a plan works while a run is mid-flight and survives a
restart.

Only one run per world is allowed at a time, enforced against both the live loop
and the on-disk record.

## 4. Safety properties

| Risk                                              | Mitigation                                                                                                                                                                               |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Writing into the wrong world after a world switch | Every write is gated on `getCurrentWorldId() === run.worldId`. Switching or deleting a world pauses the run first (`server/index.ts` handlers) and the loop stops before its next write. |
| Destroying prose the author already wrote         | Starting a run over a world that has chapters with word counts is refused unless `replaceExisting` is set; the check runs again before the outline is written.                           |
| A crash leaving a half-written run or chapter     | All content writes use the store's atomic write, and snapshot the previous version first (recoverable from History).                                                                     |
| A model answer that is not the expected shape     | Each stage has a tolerant parser that validates and caps its input, and throws an actionable error rather than writing garbage.                                                          |
| A truncated chapter answer                        | The draft parser strips the node-landing list before `【正文】`, and an empty body is treated as a failure.                                                                              |
| Path traversal through model-authored titles      | Document titles and chapter ids are sanitized (`/\\:*?"<>\|` → `_`) before they become file names.                                                                                       |
| A misleading cost figure                          | Token usage is estimated locally and labelled `estimated`; no per-run currency estimate is shown (see decision D-013).                                                                   |

## 5. Context assembly (the quality lever)

The draft prompt is layered, each layer with its own budget:

| Layer            | Source                                                                                                                                         | Budget     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Concept          | run state (logline, synopsis, tone, style guide, cast)                                                                                         | ~2k chars  |
| Chapter plan     | the chapter's beats + its **contract** + volume + neighbour titles                                                                             | ~2k chars  |
| Scene blueprint  | the chapter's scenes (purpose, goal, obstacle, turn, exit state, beats landed)                                                                 | —          |
| Story bible      | codex digest, character/world documents first                                                                                                  | 12k chars  |
| Story state      | `story-state.json` formatted as hard constraints: location, condition, possessions, goals, relations, **knowledge**, world state, open threads | 4k chars   |
| Story so far     | the previous three chapter summaries + end states                                                                                              | 3k chars   |
| Previous ending  | tail of the previous chapter's prose                                                                                                           | 1.5k chars |
| Author voice     | Voice Profile (manual text wins) + style exemplars                                                                                             | 2.5k chars |
| Author direction | standing and per-chapter instructions covering this chapter                                                                                    | 2k chars   |
| Output contract  | node-landing list, then `【正文】`, then prose, length target ±15%                                                                             | —          |

The manuscript writer shares the story-state layer, so knowledge tracking is not
Forge-specific: the same summary schema and the same formatter feed it.

Knowledge has its own slot instead of a line inside "condition", because "a
character acts on information the chapter never gave them" is a failure mode no
other dimension can catch. The review prompt already asked the critic to look
for it, which is too late — by then the prose exists. The summary stage now
records it (`aspect: "knowledge"`), `rebuildStoryState` files it under
`StoryCharacterState.knows`, and the drafter receives it as a viewpoint
constraint: a character acts only on what that line lists, and anything marked as
not yet known must not be used, hinted at, or reacted to.

The manuscript writer's hard-won lesson (D-024) is reused: the drafter prints a
node-landing list before the prose, so planned beats are anchored during
generation instead of being checked afterwards. The list is stripped before the
prose is saved.

Scene drafting reuses the same layers rather than inventing a narrower set: a
scene call carries every layer above (with the scene list instead of a whole
chapter to imagine), plus its own scene and a `previousEnding` that is the tail
of what the scene before it actually wrote — the previous chapter's ending, for
the first scene. Continuity between scenes therefore comes from prose that
exists, not from a prediction of it in the plan.

## 6. Evidence and cost

Each model call becomes a `ForgeStep`: kind, label, chapter, provider, model,
input/output characters, duration, token usage, error, and the output — capped
inline for planning stages, with chapter prose living in its own file. Usage is
the provider's reported figure when it sends one and a local estimate otherwise
(`source: 'reported' | 'estimated'`, never conflated; see decision D-013 for why
no currency figure is derived from it). The Forge view shows the concept,
per-chapter status and word counts, a live log, and the last few calls;
`forgeProgress(run)` derives the phase and a percentage.

A run's cost is therefore inspectable after the fact without re-running it, and
`resumeForgeRun` guarantees that already-completed stages are not re-billed.

## 7. Known limits / next steps

- **Every scene call carries the whole context.** A chapter with two or more
  scenes is drafted one call per scene, and each call is a full draft prompt:
  the codex, story state, voice and direction layers are not narrowed to what
  that scene needs. The roadmap's P3 wanted scene-relevant canon retrieval
  instead, which is not built, so a long book pays the full context cost per
  scene rather than per chapter.
- **Review findings are not auto-fixed.** By design: critics report, the author
  decides. Targeted repair, if added, belongs behind the Review Queue items.
- **Timeline events are not generated.** The concept's history could seed
  `timeline.json`; it is left to the author for now.
- **Chapter summary ordering (pre-existing).** `listChapterSummaries` sorts by
  file name, and `rebuildStoryState` folds the list in that order with
  last-write-wins per field, so character, world-state, open-thread and
  end-state values can be decided by an arbitrary id order rather than by
  reading order. `upToChapterId` is the visible symptom, not the only one: the
  rebuilt state is injected into every draft. Sorting the summaries by the
  outline's chapter order is the fix.
- **Budget knobs are constants.** `BUDGET` in `src/server/forge/limits.ts` is not
  user-configurable yet; a long context model could take larger layers.
