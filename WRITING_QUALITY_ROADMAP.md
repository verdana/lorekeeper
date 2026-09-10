# Writing Quality Roadmap

Status: Closed — shelved 2026-09-10; not an active workstream
Owner: Project maintainer
Last reviewed: 2026-08-14
Current phase: None — P1 was abandoned mid-slice; the gate below is not pursued

## Purpose

This document is the single source of truth for Lorekeeper's writing-quality work.
It exists to prevent the project from drifting back into feature accumulation,
prompt patching, or unmeasured model experiments.

Before starting writing-quality work:

1. Read the current phase and its exit gate.
2. Confirm the proposed work is allowed in that phase.
3. Record any strategy change in the decision log.
4. Do not enter the next phase until the current exit gate is met.

## Product decision

Lorekeeper is designed for its maintainer's real writing workflow first.

The immediate user is a new fiction writer who:

- plans complex settings and long-running plots;
- prioritizes continuity and causal logic;
- writes Chinese western-fantasy web fiction;
- targets 3,000–4,500 Chinese characters for a main-plot chapter;
- can spend about three hours per chapter;
- needs a draft worth editing, not a draft that must be rewritten line by line.

Commercial positioning is deferred until the workflow succeeds on a real novel.

## North-star outcome

Lorekeeper should help complete a publishable working chapter within the following
budget:

| Constraint                     | Target                                           |
| ------------------------------ | ------------------------------------------------ |
| Main-plot chapter length       | 3,000–4,500 Chinese characters                   |
| Total author time              | At most 3–4 hours                                |
| Manual editing time            | At most 1 hour                                   |
| Draft retention                | At least 60%, then improve toward 75%            |
| Severe canon or causal errors  | 0                                                |
| Missing required outline beats | 0                                                |
| Generation telemetry           | Per-stage token use and latency remain available |
| Stability gate                 | Meet all targets for 5 consecutive real chapters |

A single good generation is not success. Detector scores are not success. Passing the
stability gate is success.

## Non-goals

The current roadmap does not optimize for:

- one-click novel generation;
- AI-detector evasion;
- exact imitation of a named author;
- generating many candidates for the author to rank;
- making manual scoring a required step in chapter production;
- serving beginners and professional authors equally;
- adding more worldbuilding or management views;
- fixing prose by adding more forbidden phrases;
- full-chapter rewriting as the default cleanup mechanism;
- expanding the provider catalog before the pipeline is measurable.

## Operating principles

1. **Evidence before optimization.** Preserve the exact inputs and outputs before
   changing prompts or models.
2. **Decisions before prose.** Resolve scene intent and high-impact story choices before
   drafting.
3. **Style starts in the draft.** A cleanup pass cannot restore personality, viewpoint,
   or lived detail that the draft never contained.
4. **Critics report; authors decide.** Review stages identify evidenced problems and do
   not silently rewrite the whole chapter.
5. **One owner per rule.** Stable behavior, story facts, style references, and task-local
   instructions remain separate prompt layers.
6. **High-impact inventions require approval.** New rules, clues, foreshadowing,
   irreversible state changes, and named characters cannot enter canon silently.
7. **Internal complexity must not become interaction burden.** Scene-by-scene generation
   may happen internally while the default UI remains one-click after plan approval.
8. **One or two causal changes per experiment.** Do not change model, prompt, context,
   sampling, and workflow at the same time.
9. **Stop when the bottleneck is not prompting.** Prompt work stops on plateau,
   oscillation, overfitting, or unjustified token and latency growth.
10. **Evaluation stays outside the writing loop.** Development diagnostics may compare
    pipelines, but the author never has to score each chapter before continuing.

## Creative authority contract

| Story element                                | Authority                                       |
| -------------------------------------------- | ----------------------------------------------- |
| Chapter core events                          | Author decides                                  |
| Viewpoint character's immediate goal         | Author decides                                  |
| Entry and exit states                        | Author decides                                  |
| Required information and protected reveals   | Author decides                                  |
| Scene decomposition                          | AI proposes; author may edit                    |
| Conflict and obstacles                       | AI proposes; author approves                    |
| Key clues and long-term foreshadowing        | AI proposes; author approves and registers      |
| High-impact turns                            | AI proposes; author approves                    |
| Chapter-end hook                             | Derived from outline; author approves direction |
| Dialogue intent, subtext, and required facts | Author decides                                  |
| Dialogue wording                             | AI drafts                                       |
| Temporary reactions and low-impact details   | AI drafts within character constraints          |
| Environment and sensory details              | AI drafts                                       |
| New rules, powers, or irreversible facts     | Never added silently                            |

## Target chapter workflow

The target workflow is a product contract, not the current implementation.

### 1. Chapter contract

The author provides only:

- required chapter event;
- viewpoint character's immediate goal;
- entry state;
- exit state;
- facts that must not change or be revealed early.

Optional inputs include dialogue intent, emotional mode, a required image, and length.

### 2. Scene blueprint

Lorekeeper proposes three to five scenes. Each scene records:

- purpose;
- entry state;
- viewpoint goal;
- obstacle;
- known and unknown information;
- turn;
- exit state;
- required outline beats;
- invention boundary;
- continuity risks;
- prose mode;
- character budget.

The complete blueprint is editable. The application interrupts only for high-impact
ambiguity or unauthorized invention.

### 3. Internal scene drafting

The author may start the whole chapter with one action, while Lorekeeper drafts scenes
internally. A scene receives only:

- its locked blueprint;
- the previous scene's actual ending and state delta;
- directly relevant canon;
- viewpoint knowledge and physical state;
- the active positive style contract.

The drafter does not receive the entire merged project context by default.

### 4. Review

Two non-destructive critics report issues:

- a continuity and causal-logic critic;
- a prose and character-authenticity critic.

Only author-selected issues may trigger targeted rewrites. Full-chapter automatic
calibration is not the target workflow.

### 5. Finalization and learning

Saving the final chapter records the author edits, updates reviewed story state, and
produces metrics for the run. Repeated edit preferences may later update the style
contract, but no single edit changes it automatically.

## Quality evaluation contract

Quality evaluation is development instrumentation, not a required author task. The
daily writing loop records what the author actually does instead of asking for weighted
scores:

- whether a generated draft is inserted;
- how much of that draft remains in the saved chapter;
- how much generated material is removed;
- elapsed editing time;
- generation token use and latency;
- severe continuity, causality, or outline failures observed during normal review.

When a model, prompt, or pipeline changes, compare it against preserved Generation
Evidence on a small set of real chapters. A temporary blind comparison is allowed only
when it answers one concrete development decision. It must not live in the chapter
production UI or become a per-chapter form.

Automatic counts may include repeated correction patterns, similes, short paragraphs,
sentence-head repetition, explanatory perception verbs, token use, latency, and
retention. These are diagnostic signals, not a composite quality score.

### Automatic rejection gates

Reject a candidate when it:

- contradicts canon or the previous end state;
- omits a required event;
- gives a character unsupported knowledge or expertise;
- silently creates a high-impact rule, clue, or irreversible fact;
- requires a whole-scene rewrite;
- exceeds the configured context or output limit without explicit approval.

## Generation evidence record

Every run must eventually preserve:

- run and chapter IDs;
- effective prompt text, version, and hash;
- injected context by layer;
- scene-blueprint version;
- provider and model;
- sampling parameters;
- start time, duration, and completion state;
- input and output tokens;
- raw model output;
- critic reports;
- targeted repair outputs;
- final author text;
- editing duration;
- text-retention ratio;
- derived removal ratio.

Reported usage and estimated usage must be distinguishable.

## Scope decisions

### Keep and strengthen

- Codex and relevant-context selection
- Multi-file outline
- Story Memory and Chapter Memory
- Consistency checks and Review Queue
- Version history and diff review
- Local Markdown and JSON storage
- Multi-provider support for existing providers

### Refactor when its phase begins

- AI Assist into a chapter-run workflow
- Voice Profile into a scene-aware style contract
- outline generation into a rolling, reviewable plan

### Freeze

- Graph enhancements
- Character Chat expansion
- static-wiki enhancements
- additional AI personas
- detector-score calibration
- new management views
- new provider presets unless required by an evaluation

Freezing means no new investment. It does not require deleting working features.

## Roadmap gates

| Phase | Status        | Objective                                           | Exit gate                                                                                                                                  |
| ----- | ------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| P0    | Complete      | Preserve and reproduce generation evidence          | A run can be restored and compared with its exact effective prompt, context, model, parameters, output, usage, and author result           |
| P1    | In progress   | Make the first draft own prose quality              | Calibration and composite scoring are removed; direct drafts preserve passive adoption, removal, editing-time, usage, and latency evidence |
| P2    | Blocked by P1 | Add chapter contracts and editable scene blueprints | A blueprint covers every required beat and exposes all high-impact inventions before prose generation                                      |
| P3    | Blocked by P2 | Draft internally by scene with targeted context     | Preserved chapters show better adoption, lower removal and editing time, and no continuity regression versus the direct-draft baseline     |
| P4    | Blocked by P3 | Add non-destructive critics and targeted repair     | Critics cite useful evidence; repairs remain local; no default whole-chapter rewrite occurs                                                |
| P5    | Blocked by P4 | Learn from author edits and enforce usage budgets   | The system reports token use, latency, and retention, and repeated preferences can be reviewed before entering the style contract          |
| P6    | Blocked by P5 | Run a real five-chapter pilot                       | Five consecutive chapters meet the north-star outcome                                                                                      |

## Phase details

### P0 — Evidence foundation

Allowed work:

- persist raw draft and calibration output separately;
- persist the final effective prompt instead of only its template name;
- record prompt version and hash;
- record model, provider, parameters, timing, completion, and usage;
- preserve the final author version and calculate retention;
- expose a reproducible run history;
- capture the current two-pass behavior as a baseline;
- add a switch that allows calibration to be disabled after the baseline is captured.

Not allowed:

- scene-blueprint implementation;
- another Voice schema expansion;
- new de-slop rules;
- broad prompt rewrites;
- model ranking based on unmatched inputs;
- unrelated feature work.

Implementation progress:

- 2026-08-14: completed the first vertical slice for the existing outline-writing path.
  Each draft and calibration model call now creates or updates a world-local JSON run
  record before and after the request. The record preserves exact messages, layered
  context, prompt version and hash, provider/model parameters, status, duration, raw
  output, and provider-reported usage when available.
- This slice intentionally does not add a history UI, usage estimation,
  final-author-text linkage, retention calculation, or baseline reproduction controls.
  Those remain P0 work.
- 2026-08-14: completed the second vertical slice. The outline-writing sidebar now
  exposes chapter-scoped run history without adding another management view. An author
  can inspect exact messages, context layers, prompt hashes, provider/model parameters,
  usage, timing, status, and raw stage outputs. Applying a draft or calibrated result
  records the exact inserted text and its source stage IDs before changing the chapter.
- 2026-08-14: completed the author-result slice. Applying a recorded result starts an
  evidence-linked editing session. Every subsequent chapter save in that session stores
  the latest full author text, elapsed editing duration, and a whitespace-insensitive
  ordered-token retention ratio. The ratio measures how much of the selected model text
  remains and does not penalize chapter titles, pre-existing prose, or later additions.
- 2026-08-14: completed usage evidence. Missing provider token usage is estimated locally
  and remains labelled as estimated.
- 2026-08-14: completed baseline and reproduction controls. The first successful complete
  legacy two-pass run in a world is automatically marked as the baseline; an eligible
  record created by an earlier P0 slice is promoted when global history is next read.
  Calibration remains enabled by default and cannot be disabled in the writing panel
  before that baseline exists. Any completed run can be replayed from its exact stored
  messages and sampling parameters; replay is refused if provider, model, base URL, or
  max-token configuration has changed, and the new run links back to its source.
- During this slice, the chapter autosave callback was corrected to flush the latest
  pending editor value instead of a stale render value. Without this correction, author
  evidence and the chapter file could disagree after applying a generated result.
- 2026-08-14: completed the P0 pre-commit audit. Truncated provider responses no longer
  count as completed runs or baselines; stage inputs become immutable after the request
  starts; calibrated selections must cite every completed calibration stage; and the
  server enforces the baseline gate for draft-only runs. Chapter loading and saving now
  resist stale async completions, author linkage is restored after an application
  restart, and aborted reproductions retain partial output and expose a stop action.

P0 exit checklist:

- [x] Raw draft is always recoverable.
- [x] Calibration result is stored separately.
- [x] Final author text is linked to the run.
- [x] Effective prompts and injected context are inspectable.
- [x] Provider, model, parameters, and completion state are stored.
- [x] Token usage is reported or estimated.
- [x] Run duration is stored.
- [x] Retention can be calculated.
- [x] One current-pipeline run can be reproduced closely enough for comparison.

### P1 — Source-draft correction

- Remove the default whole-chapter Calibration pass and its configuration surface.
- Remove Fixed Blind Evaluation and the six-dimension composite score.
- Make outline-driven drafting responsible for publishable working prose in one pass.
- Put physical state, immediate goals, obstacles, choices, and consequences into the
  source-draft contract instead of trying to repair human behavior afterwards.
- Allow breathing room, ordinary friction, and character texture when they serve the
  scene; do not force every paragraph into uniform information delivery.
- Preserve exact generation inputs, output, author adoption, retention/removal, editing
  time, token use, and latency as passive evidence.

Implementation progress:

- 2026-08-14: the initial P1 blind-scoring implementation exposed a category mismatch.
  Calibration was explicitly forbidden to change facts, character relationships, plot,
  or setting, so five of the six weighted dimensions were structurally unchanged. Manual
  scoring added author work without producing a decision-quality signal.
- Direct comparison and detector checks found that surface paraphrasing did not produce
  a meaningful improvement over the draft. The Calibration hypothesis is rejected; the
  four-case blind-scoring gate is cancelled rather than completed for its own sake.
- The corrective slice removes the failed second pass and composite score, strengthens
  the source prompt, and keeps Generation Evidence as the passive measurement layer.
- 2026-08-14: completed the corrective code slice. New outline-writing runs use one
  source-draft stage; Calibration prompts, settings, chunking, execution, and result
  selection are removed. Historical two-pass evidence remains inspectable, but it
  cannot create new Calibration stages or selections. Reproduction replays only the
  completed source draft. The writing sidebar no longer contains a mandatory scoring
  surface, and Generation Evidence reports adoption, derived removal, elapsed editing
  time, usage, and latency without combining them into a grade.
- 2026-08-14: reviewed the first real source-draft evidence (ch3). The run still used
  the pre-slice system prompt because the per-language config slot froze the old
  template, and the per-chapter outline (outline/06) was truncated out of context by
  the outline budget, so none of the chapter's four planned beats reached the
  drafter. Retention 1.0 with a 14-second session recorded apply-and-save, not an
  author edit. The corrective slice refreshes superseded outline prompt slots at
  load and injects the author's own per-chapter beats as a dedicated context layer
  before the long outline is budgeted.
- The P1 exit gate remains open until the corrected path is exercised on real
  chapters and its adoption, removal, editing-time, usage, latency, and severe-error
  evidence is reviewed.
- 2026-08-15: completed the structured-outline slice (D-018). The outline is now a
  structured store (outline/outline.json) that is the single source of truth for
  volumes, chapters, and beats; novel.json mirrors ids, titles, and order, and legacy
  outline/*.md files migrate into the store on first read (id-keyed merge). The Outline
  view gained volume/chapter/beat editing, statuses, and AI-assisted chapter planning;
  the Chapters tree became read-only for structure; AI Assist now looks up the active
  chapter's beats by id from the store (no regex over merged text) and still records
  them as the chapter-beats evidence layer. Export ships outline.json plus a derived
  outline.md. Note: planning sections that lived in the legacy md files (promises, beat
  rhythm, power waterlines) no longer reach the drafter through readOutline() unless
  carried into the store overview or a volume summary/config.
- 2026-08-15: completed the targeted-outline slice (D-019). AI Assist's plot-outline
  layer is now rebuilt around the active chapter id from outline.json (overview + its
  volume + its beats + adjacent chapter titles) instead of the head-truncated merged
  serialization, so the chapter's own outline always reaches the drafter. The legacy md
  migration bug that misclassified planning H2 sections as volumes and orphaned the
  ch1-6 prose files is recorded but not yet fixed.
- 2026-08-16: completed the migration-parser fix (D-020). Only a 第N章 heading can
  establish a volume in parseLegacyOutline; non-chapter sub-headings merge into overview
  before a volume exists and into volume config afterwards. Real-input parse dropped
  from 10 volumes (6 empty phantoms) to 4 real ones (50/20/20/20 chapters).
- 2026-08-16: reviewed the first real-chapter evidence on the corrected path (ch5).
  The strengthened prompt (source-outline-draft-v2, no calibration-deferral line), the
  id-keyed chapter-beats layer (all 5 ch5 nodes), and the targeted plot-outline layer
  all reached the drafter; usage was provider-reported (13130/2247) and latency 24.8s.
  The draft covered beats 1-2 and kept the hook image, but omitted beat 3 entirely
  (克莱门特 seals the sewer drain, the seal-paper appraisal, crawling the narrow
  channel) — the same required-beat omission class as ch3, this time with complete
  injection. Retention 0.9997 with a 4.4s editing session records apply-and-save, not
  an author edit. The chapter-end hook was adapted (sewer mouth -> carted corpses at
  the town gate). ch5's outline beats also carry a stray "第二幕：账外的人（6—10章）"
  line from the migration.
- 2026-08-16: completed the ch5 evidence series (D-021). Three rewrites of ch5 were
  reviewed against the four outline nodes. v1 (gr_ngvuakl46u59) omitted beat 3 with
  complete injection — the model, not the context, dropped the node. The targeted
  rewrite (gr_yir5zk3hddrb) landed beat 3 and the hook but replaced the whole chapter,
  losing beat 2. v3 (gr_hz8l25dy09x3) with the instruction "strictly follow the nodes,
  no new props, do not enter the vault" covered all nodes: three-part pact, the vault
  refusal (injuries/stamina), the sewer seal appraisal (pre-cut paper, iron-rust ink,
  3-5 day lead), the crawl, and the corpseless-name hook, with no new props and the
  ch4 military-order thread continued. Deviations: 5110 CJK chars (>4500 target),
  weakened chapter-end hook (corpses moved mid-sewer, no closing suspense), and the
  seal executor changed from 克莱门特 to an unknown party. All three runs recorded
  apply-and-save editing (retention ~1.0, <5s), so no real editing evidence exists yet.
  Model-execution failure pattern: with complete injection, the drafter still omits or
  rewrites required beats (ch3 seal, ch5-v1 beat 3, ch5-v2 reversed beat 2).
- 2026-08-16: reviewed ch6 (gr_taxg4cyd7xbo) — the first chapter with real editing
  evidence (25-minute session, retention 0.9904, saved text differs from the draft).
  All four nodes landed: cleanliness obsession and trauma obstructing escape (rapid
  breathing, stiff limbs, repeated wiping reopening the wound), Valeria stating only
  the consequences (stay/turn back/die) with Yang Yu's segment counting through the
  corpse water, the corpses traced to villages not yet hit by plague (evacuation and
  cleansing already underway), and the chapter-end hook (a six-wheeled expedition
  carriage sealed with crossed church seals, a horse battering the walls inside).
  Length 3175 CJK (in target). One unregistered invention: the destination name
  药王谷 appears in the draft but nowhere in the outline or prior chapters — it must
  be registered in the outline or renamed before later chapters rely on it.
- 2026-08-16: reviewed ch7 (gr_xfvhqcusggcf). Nodes 1, 3, 4 landed (seized property,
  hinge-pin door removal that keeps church seals intact, unloading the overweight
  boxes, naming 寻星号 with the "mud before stars" line), but node 2 (Valeria's
  employ contract asserting a lien for unpaid military funds; Yang Yu's procedural
  challenge via the seal date) was omitted again under the strict-instruction regime —
  the second consecutive omission after ch6 passed. The author manually inserted a
  ~440-char passage restoring node 2 (fourteen-year contract, unpaid 3/10 of military
  funds, lien, seal-date print discrepancy), and the hinge solution then follows with
  procedural legitimacy. Final length 4481 CJK (in target); editing was real (6 min,
  retention 0.9326). One typo (问到 -> 问道) fixed in the saved text.
- 2026-08-16: reviewed ch8 and ch9 (both author-written, no generation runs). ch8
  covered the safe-interlude and chapter-end hook but missed beat 2 (cup fixed at
  second-right slot, sealed envelopes set aside) and beat 4 (copper-disk name mirror,
  double-ledger), skipped the bed-split and feed/medicine accounting, used the
  protagonist's own coat button instead of Ailos's, and was short (2473 CJK after the
  eastern-content purge). ch9 covered the dumping, the wheel-rut bridge judgment, the
  coin box, and the checkpoint, but adapted the bridge damage to natural decay (no
  pre-cut sabotage), softened the beat-2 confrontation (protagonist proposes food/meds
  himself), dropped the misjudgment correction, and the checkpoint guard let them
  through. Per the author's choice, the ch9 ending was rewritten so the guard reads the
  wanted notice ("injured young man, possibly armed") and stops the carriage, leaving
  the checkpoint confrontation to ch10; the ending now closes on "they stopped at the
  checkpoint" instead of passing through. ch9 is 3427 CJK after the fix.
- 2026-08-16: reviewed ch10 (gr_l9vbrwmj2f48, generated). The procedural duel landed
  completely: the quarantine-certificate bribery (3 then 5 silver coins), the
  certificate-time contradiction (last winter's rule vs this spring's enforcement), the
  private toll-vs-application-fee gap, and the bluff using the church seal of
  Clemente's seized carriage — all in the "strictly follow the nodes" regime. The
  checkpoint officer lets them through after Yang Yu states his name. Adaptations: no
  merchant witnesses and no officer admission (the trap ends in a silent retreat), no
  forced breakout via guard rotation, and the phase reward lacks the officer's
  demotion and the merchant-testimony chain that lets Clemente hear "杨羽" — instead
  the chapter closes with pursuers closing in. Length 4074 CJK (in target); editing was
  apply-and-save again (5.5s, retention 0.9998) — only ch6 currently carries real
  editing evidence.
- 2026-08-16: reviewed ch11 (gr_crrbbpi1qhfx). The run is marked promptVersion v3 but
  actually used the author's custom outline prompt (1631 chars, saved 15:07, built on
  v2 with added diction constraints: no rare words, no "不是…是…" constructions,
  restrained adjectives/similes, plus "output only the title and body") — the custom
  slot overrides the built-in v3, so the node-landing-list experiment has not run yet.
  Under the custom prompt the chapter landed 4.5/5 nodes: the shim correction (Yang Yu
  misreads scratches, Valeria swaps the worn shim and shows he can only read current
  anomalies), the copper disk's dual north-west/south deflection, the evacuation-post
  date predating the wheel ruts, and the chapter-end hook (bell-like tapping in the
  fog; the mirror image became a copper-disk image showing two rescue parties in
  opposite directions). Missing: the leaking seam / vent-hole beat. Editing was
  apply-and-save again (5.3s). The custom prompt's restraint may help node focus, but
  one chapter is not a sample; the v3 experiment awaits the author's choice on the
  custom slot.

### P2 — Chapter contract and blueprint

- Add the minimal five-field chapter contract.
- Generate three to five structured scene records.
- Display the complete plan for editing.
- Flag high-impact inventions and ambiguity.
- Lock a reviewed blueprint before drafting.
- Treat the next one to five chapters as a rolling horizon; keep the longer outline
  provisional.

### P3 — Scene drafting

- Draft one scene per internal request.
- Carry the actual previous ending and state delta forward.
- Retrieve only scene-relevant canon.
- Replace the current generic Voice injection with a provisional positive style contract.
- Keep provider-independent behavior stable and add small adapters only for measured
  family-specific failures.

### P4 — Critics and targeted repair

- Separate continuity criticism from prose criticism.
- Require evidence spans and severity.
- Never auto-apply critic output.
- Repair only selected spans or scenes.
- Preserve before-and-after diffs.

### P5 — Preference learning and budget control

- Aggregate repeated author edits.
- Require at least three consistent observations before proposing a preference.
- Let the author accept or reject style-contract changes.
- Track per-stage token use and latency.
- Warn before configured context or output limits are exceeded and require an override.

### P6 — Five-chapter pilot

- Freeze writing-quality features during the pilot.
- Write five consecutive real chapters.
- Record time, token use, retention/removal, logic failures, and rejected scenes.
- Decide the next roadmap only after reviewing all five chapters.

## Prompt optimization protocol

For every prompt experiment:

1. Capture the current prompt and representative failures.
2. State one concrete hypothesis.
3. Produce a low-risk repair and, when justified, one structure-first alternative.
4. Compare them on the same preserved real-chapter inputs when comparison is necessary.
5. Keep an optimization log with the hypothesis, edit, result, and keep/reject decision.
6. Validate the winner on later real chapters without adding a mandatory scoring step.
7. Stop on plateau, oscillation, overfit, model limitation, or unjustified resource growth.

Do not add instructions without identifying which measured failure they address.

## Writing and development discipline

- Complete the planned writing session before changing the generation system.
- Record problems during writing instead of fixing them immediately.
- Batch development decisions at most once per week.
- Require the same failure in at least three samples before creating a general rule.
- Change at most two causal variables in an experiment.
- Keep at least one day per week free of product development.
- Freeze product work during the five-chapter pilot.

## Decision log

| ID    | Date       | Decision                                                                               | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----- | ---------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-001 | 2026-08-14 | Design for the maintainer's workflow first                                             | External one-click demand is not a credible near-term quality target                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| D-002 | 2026-08-14 | Prefer readable prose over detector performance                                        | Detector avoidance is fourth priority and not a proxy for reader quality                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| D-003 | 2026-08-14 | Treat full-chapter calibration as a baseline, not the target (superseded)              | In the reviewed sample it preserved all 29 correction patterns and all 19 similes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| D-004 | 2026-08-14 | Generate internally by scene without requiring per-scene clicks                        | Scene control is needed, but interaction burden must remain low                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| D-005 | 2026-08-14 | Require approval for high-impact story inventions                                      | Continuity and foreshadowing cannot remain reliable under silent AI autonomy                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| D-006 | 2026-08-14 | Replace author imitation with transferable style contracts                             | Abstract Voice summaries overfit sample mood and conflict with cleanup rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| D-007 | 2026-08-14 | Build evidence infrastructure before prompt or workflow rewrites                       | The current system cannot reliably attribute improvement to a specific change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| D-008 | 2026-08-14 | Measure retention as ordered non-whitespace token preservation                         | Existing chapter text and author additions must not count as deletion of the draft                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| D-009 | 2026-08-14 | Require captured prices for numeric cost estimates (superseded)                        | A false built-in price is worse evidence than an explicit unavailable value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| D-010 | 2026-08-14 | Auto-capture the first successful legacy two-pass run as baseline (superseded)         | Calibration had to be preserved before its value could be tested                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| D-011 | 2026-08-14 | Lock both blind ratings before revealing candidate identity (superseded)               | The composite blind score was later removed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| D-012 | 2026-08-14 | Enforce one pipeline fingerprint across the fixed evaluation set (superseded)          | The fixed scoring set was later removed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| D-013 | 2026-08-14 | Remove per-token price inputs and per-run currency estimates                           | Most configured providers are monthly plans, so marginal CNY estimates mislead                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| D-014 | 2026-08-14 | Remove Calibration and composite manual scoring                                        | Surface paraphrasing did not improve detector or author judgment enough to justify the extra pass and interaction burden                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| D-015 | 2026-08-14 | Make the source draft responsible for final prose quality                              | Structural AI flavor begins in scene logic, information order, character behavior, and paragraph rhythm, not isolated vocabulary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| D-016 | 2026-08-14 | Refresh stale prompt slots and inject the author's per-chapter outline beats           | The first source-draft run on ch3 still used the pre-slice prompt (calibration-deferral line frozen in the config slot) and never received the ch3 nodes from the 50-chapter outline; its retention 1.0 recorded apply-and-save, not an author edit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| D-017 | 2026-08-15 | Keep the P1 exit gate open after the ch1-4 rewrite review                              | The corrected path worked (strengthened prompt, beats injected, reported usage) and ch1 showed a real 92-minute editing session, but ch3 omitted the evidence-seal beat (a ch5/ch7/ch10 dependency), the copper-disk location chain is inconsistent across ch2-4, and ch2 uses a glove never established in ch1                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| D-018 | 2026-08-15 | Restructure the outline into a structured store (outline/outline.json)                 | Chapter nodes were matched by fragile heading regex over merged markdown and the long outline was head-truncated by budget, so later chapters lost their beats and beat coverage could not be checked; a structured store (outline is the single source of truth, novel.json mirrors ids/titles/order) fixes injection and enables passive coverage tracking without entering P2                                                                                                                                                                                                                                                                                                                                                                                                            |
| D-019 | 2026-08-15 | Inject the outline layer targeted at the active chapter, keyed by id from outline.json | The merged serialization was still head-truncated by the outline budget, so any chapter past about chapter 9 lost its own beats in the plot-outline layer; rebuilding that layer around the active chapter (overview + its volume + its beats + adjacent chapter titles) guarantees the chapter's outline reaches the drafter. Also recorded: the legacy md migration (19:54) misclassified every H2 planning section as a volume, and novel.json sync then dropped the old prose file links (v_lw31oa4eb67c_*); existing prose for ch1-6 sits in old files no longer referenced                                                                                                                                                                                                            |
| D-020 | 2026-08-16 | Restrict legacy md migration so only chapter headings can establish a volume           | parseLegacyOutline promoted the current H2 candidate to a volume on any non-chapter H3/H4 sub-heading, so planning documents with sub-sections produced phantom zero-chapter volumes (real input yielded 10 volumes, 6 empty) and the old novel.json sync then orphaned prose files; now only a 第N章 heading promotes the H2, and non-chapter sub-headings merge into overview or volume config. Real-input parse now yields 4 real volumes (50/20/20/20 chapters)                                                                                                                                                                                                                                                                                                                         |
| D-022 | 2026-08-16 | Rename the invented destination 药王谷 to 灰泉镇 in ch6                                | 药王谷 is an eastern wuxia/xianxia place name that clashes with the western-fantasy setting, and the outline's ch7-13 arc has no such medical destination; 灰泉镇 is a neutral northern-town name. The ch6 prose file was updated (one occurrence, backed up) and the decision recorded so later chapters stay consistent                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| D-023 | 2026-08-16 | Purge foreign eastern-fantasy content from chapter memory                              | ch8's manuscript referenced 谢青云/鹿灵犀/阿毛/药王谷 with no provenance. Tracing found the source: chapter-memory summaries c_wep0w3m1vam1 (ch11, 08-15 20:05) and c_djsleth3vam1 (ch17, 08-15 20:11) contained an unrelated eastern wuxia/xianxia story (谢青云 escorting 鹿灵犀 to 药王谷; 沈眠/钱万贯 court case) that was folded into story-state.json and injected into every chapter's context. Both summaries were backed up to TEMP and removed, story-state.json was rebuilt from the remaining 23 clean summaries, and the eastern passage in ch8's manuscript was removed with the destination renamed to 灰泉镇 (ch8 backed up to TEMP). listChapterSummaries also admits summaries for chapters with no prose yet, which is how unwritten-chapter summaries reached the state |
| D-024 | 2026-08-16 | Require a node-landing list before the source-draft body (prompt v3)                   | Four to five model-execution failures (ch3 seal, ch5-v1 beat 3, ch5-v2 reversed beat 2, ch7 beat 2, ch10 beat 3/4 adaptations) persisted even with complete injection and the "self-check every node" instruction — post-hoc review does not anchor nodes during long output. The v3 prompt makes the model print a 【节点落地清单】(each node -> where it lands) before the body, then write the body after 【正文】; the applied text strips everything before the marker (extractBodyFromAnswer). One causal variable. Also implemented the D-023 code defense: listChapterSummaries now drops summaries whose chapter body is absent or placeholder-sized (<=100 bytes), so unwritten-chapter summaries cannot pollute story state again                                                |

## Current next action

Use the corrected direct-draft path on the next real chapter: verify the run's system
prompt is the strengthened source-draft prompt (no calibration-deferral line), confirm
the chapter's outline beats are present in the injected context, and review whether the
draft covers every beat and leaves a hook matching the outline. Review the saved
Generation Evidence, retention/removal, editing time, token use, latency, and any severe
continuity or causal failure. Record concrete failures without adding a per-chapter
score form.

The structured-outline slice (D-018), the targeted-outline slice (D-019), and the
migration-parser fix (D-020) are committed. The orphaned ch1-6 prose files were
restored from disk and from run evidence; the next real chapter run will validate
id-keyed beats lookup, the never-truncated chapter-beats layer, and the targeted
plot-outline layer.

Do not reintroduce a cleanup rewrite, composite score, or scene-blueprint implementation
until the direct-draft corrective slice has real-chapter evidence.
