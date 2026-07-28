# Changelog Generation Guide (Lorekeeper)

This guide is the single source of truth for producing release changelogs.
It works both as a **human runbook** and as an **AI skill prompt**: an agent
can read this file and follow the workflow to produce a polished changelog.

## Goal

Turn the conventional commits between two git refs into a polished,
user-facing `scripts/release-notes-<version>.md` file that matches the
house style established by `scripts/release-notes-v0.1.1.md`.

## Two-stage workflow (draft -> polish)

The mechanical script cannot write good prose. Treat generation as two stages:

### Stage 1 - Mechanical draft (deterministic)

Run the generator to bucket commits by type:

```bash
pnpm changelog                 # auto: latest two tags
pnpm changelog v0.1.1 v0.1.2   # explicit range
pnpm changelog v0.1.2          # v0.1.2..HEAD
node scripts/gen-changelog.mjs v0.1.1 v0.1.2 --stdout   # print, don't write
```

This writes `scripts/release-notes-<toRef>.md` with commits grouped into
sections. It is intentionally raw: one bullet per commit, no polish.

### Stage 2 - AI/human polish (judgement)

Refine the draft to match house style. This is where the value is added:

1. **Merge related commits.** Multiple `fix:` commits tackling the same
   symptom (e.g. three graph-view hover fixes) collapse into ONE bullet that
   describes the end-state, not the debugging journey.
2. **Rewrite as user value, not commit log.** Describe what the user gets, not
   what the developer did. Read the commit body for context.
3. **Apply the house bullet style** seen in v0.1.1:
   `- **Feature name** - one to three lines explaining the change.`
   Use an en-dash-like `-` separator after the bold lead-in.
4. **Drop noise.** Release/version-bump chores, lockfile-only changes, and
   pure-internal churn do not belong in user-facing notes.
5. **Order by impact** within each section (most notable first).
6. **Keep the compare link** at the bottom:
   `**Full Changelog**: https://github.com/verdana/lorekeeper/compare/<from>...<to>`

## Section mapping

| Conventional type        | Section                 |
| ------------------------ | ----------------------- |
| `feat`                   | ✨ New Features         |
| `refactor`/`style`/`perf`| 🔧 Improvements       |
| `chore`/`build`/`ci`     | 🏗️ Infrastructure     |
| `docs`                   | 📝 Documentation        |
| `test`                   | 🧪 Tests                |
| `fix`                    | 🐛 Fixes                |

Edit `SECTIONS` in `scripts/gen-changelog.mjs` to change mapping or order.

## Language rule

Per project policy, changelog content is developer/release-facing and must be
written in **English**, consistent with commit messages and code comments.

## Checklist before publishing

- [ ] Ran the generator for the correct ref range.
- [ ] Merged duplicate/iterative commits into single outcome-focused bullets.
- [ ] Rewrote bullets as user value with the `**Name** - desc` style.
- [ ] Removed release-chore / lockfile / internal-only noise.
- [ ] Verified the compare link resolves on GitHub.
- [ ] Filename is `scripts/release-notes-<version>.md`.
