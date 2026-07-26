
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

