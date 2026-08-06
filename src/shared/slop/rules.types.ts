// De-slop rules pack — shared shape.
// A rules pack is a maintainable, versioned, weighted set of *signals* (not a
// blacklist). Each entry contributes a signal score; it never triggers a
// "delete on sight" action. This keeps the detector robust when individual
// phrases go stale (a stale phrase only mis-weights, it doesn't break scoring).

/** Hard rules are a hard fail on their own; soft rules need human judgement. */
export type RuleSeverity = 'hard' | 'soft'

/** A phrase/pattern signal used by the local analyzer. */
export interface SlopRule {
  /** Regex source (global, multiline-safe) matched against the prose. */
  pattern: string
  /** Category this signal belongs to. */
  category: 'connective' | 'abstractNoun' | 'parallelism' | 'idiomHint' | 'pivot' | 'leftBranch'
  /** Relative strength of this individual signal (0–1). */
  weight: number
  /** Optional short note shown in explanations. */
  note?: string
  /**
   * 'hard' = the pattern is a hard fail on its own (e.g. a literal pivot
   * sentence); 'soft' = needs human judgement (e.g. a disguised pivot).
   * Defaults to 'soft'.
   */
  severity?: RuleSeverity
}

export interface RulesPack {
  version: string
  lang: 'zh' | 'en'
  rules: SlopRule[]
}

const RULE_CATEGORIES = new Set<SlopRule['category']>([
  'connective',
  'abstractNoun',
  'parallelism',
  'idiomHint',
  'pivot',
  'leftBranch',
])

/**
 * Validate and normalize a user-supplied rules pack (from a JSON import).
 * Throws with a descriptive message on any structural problem; weights are
 * clamped to [0, 1]. A pack is rejected as a whole rather than silently
 * dropping bad rules, so the author knows exactly what failed.
 */
export function validateRulesPack(value: unknown): RulesPack {
  if (!value || typeof value !== 'object') {
    throw new Error('Rules pack must be a JSON object.')
  }
  const v = value as Record<string, unknown>
  if (typeof v.version !== 'string' || !v.version.trim()) {
    throw new Error('Rules pack is missing a version string (e.g. "zh-v2").')
  }
  if (v.lang !== 'zh' && v.lang !== 'en') {
    throw new Error('Rules pack lang must be "zh" or "en".')
  }
  if (!Array.isArray(v.rules)) {
    throw new Error('Rules pack must contain a "rules" array.')
  }
  const lang = v.lang as 'zh' | 'en'
  const reFlags = lang === 'en' ? 'gi' : 'g'
  const rules: SlopRule[] = v.rules.map((r, i) => {
    if (!r || typeof r !== 'object') throw new Error(`Rule #${i + 1} is not an object.`)
    const rule = r as Record<string, unknown>
    if (typeof rule.pattern !== 'string' || !rule.pattern.trim()) {
      throw new Error(`Rule #${i + 1} is missing a pattern.`)
    }
    if (!RULE_CATEGORIES.has(rule.category as SlopRule['category'])) {
      throw new Error(`Rule #${i + 1} has unknown category "${String(rule.category)}".`)
    }
    if (typeof rule.weight !== 'number' || !Number.isFinite(rule.weight)) {
      throw new Error(`Rule #${i + 1} weight must be a number.`)
    }
    if (rule.note !== undefined && typeof rule.note !== 'string') {
      throw new Error(`Rule #${i + 1} note must be a string.`)
    }
    if (rule.severity !== undefined && rule.severity !== 'hard' && rule.severity !== 'soft') {
      throw new Error(`Rule #${i + 1} severity must be "hard" or "soft".`)
    }
    // 编译期校验：非法正则会在分析时抛 SyntaxError 卡死 UI。
    // 注意：本校验只保证可编译，不防御灾难性回溯（ReDoS）——导入包应来自可信来源。
    try {
      new RegExp(rule.pattern as string, reFlags)
    } catch {
      throw new Error(`Rule #${i + 1} has an invalid pattern: "${rule.pattern}".`)
    }
    const note = rule.note as string | undefined
    const severity = rule.severity as RuleSeverity | undefined
    return {
      pattern: rule.pattern as string,
      category: rule.category as SlopRule['category'],
      weight: Math.min(1, Math.max(0, rule.weight as number)),
      ...(note && note.trim() ? { note: note.trim() } : {}),
      ...(severity === 'hard' || severity === 'soft' ? { severity } : {}),
    }
  })
  return { version: v.version.trim(), lang, rules }
}
