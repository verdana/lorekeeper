// De-slop rules pack — shared shape.
// A rules pack is a maintainable, versioned, weighted set of *signals* (not a
// blacklist). Each entry contributes a signal score; it never triggers a
// "delete on sight" action. This keeps the detector robust when individual
// phrases go stale (a stale phrase only mis-weights, it doesn't break scoring).

/** A phrase/pattern signal used by the local analyzer. */
export interface SlopRule {
  /** Regex source (global, multiline-safe) matched against the prose. */
  pattern: string
  /** Category this signal belongs to. */
  category: 'connective' | 'abstractNoun' | 'parallelism' | 'idiomHint'
  /** Relative strength of this individual signal (0–1). */
  weight: number
  /** Optional short note shown in explanations. */
  note?: string
}

export interface RulesPack {
  version: string
  lang: 'zh' | 'en'
  rules: SlopRule[]
}
