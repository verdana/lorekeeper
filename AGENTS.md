# Lorekeeper — Development Guidelines

## Language

- **Commit messages**: must be written in English only.
- **Code comments**: must be written in English only. Inline comments, doc blocks, TODO/FIXME markers — all English.
- **User-facing text** in the UI may use any language appropriate for the audience; this rule applies to developer-facing content (commits, comments, variable names, documentation).

## Commit style

Follow conventional commits:

```
<type>: <short summary>

<optional body with additional context>
```

Types: `feat`, `fix`, `refactor`, `docs`, `style`, `test`, `chore`, `perf`.

The summary line should be imperative, <= 72 characters, and capitalized.

Enforced by commitlint (`@commitlint/config-conventional`) via husky `commit-msg` hook. Key rules to respect:

- **body-max-line-length**: every line in the body must be <= 100 characters. Split long sentences across multiple `-m` flags or blank-line-separated paragraphs; do not write a single long line.
- **type-enum**: only the types listed above are allowed.
- **subject-case**: subject must be lower-case (the summary after `type:`).
- **header-max-length**: the header (first line) must be <= 100 characters (keep the summary <= 72 to stay safe).

Pre-commit runs `lint-staged` -> `prettier --write` on staged files; formatting is auto-applied.
Run `pnpm run typecheck` before committing to catch type errors early.

Commit body example (each line short):

```
feat: add import manuscript mode

Add Import manuscript mode to WorldGate.

Each file becomes a chapter kept verbatim.

createWorldWithData persists chapters under an Imported volume.
```
