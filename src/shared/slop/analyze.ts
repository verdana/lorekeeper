import type { SlopReport, SlopDimId, SlopDimScore, SlopFlag, SlopWeights } from '../types'
import type { RulesPack, SlopRule } from './rules.types'
import { dimLabel, dimDetail, flagNote, type SlopDetailCtx, type SlopUiLang } from './labels'
import { zhRules } from './rules.zh'
import { enRules } from './rules.en'

/**
 * Local, deterministic, zero-token AI-writing-smell ("slop") analyzer.
 *
 * Design notes:
 * - Everything here is pure and offline. No network, no LLM, no side effects.
 * - Structural signals (sentence-length variance, punctuation variety, head
 *   repetition, paragraph uniformity) do most of the work; the rules packs add
 *   lexical signals. This makes the detector resilient when individual phrases
 *   go stale — a stale phrase only mis-weights, it never breaks scoring.
 * - Output is explainable: every flagged sentence carries the dimension ids
 *   that fired on it, mirroring the "quote the exact line" UX used elsewhere.
 */

/** Default weights. Kept here so the analyzer is usable without app config. */
export const DEFAULT_SLOP_WEIGHTS: SlopWeights = {
  burstiness: 0.2,
  connectives: 0.18,
  parallelism: 0.12,
  abstractNouns: 0.12,
  sentenceHeadRepetition: 0.1,
  punctuationMonotony: 0.1,
  idiomDensity: 0.08,
  paragraphUniformity: 0.1,
}

function pickPack(lang: 'zh' | 'en', custom?: RulesPack | null): RulesPack {
  return custom ?? (lang === 'en' ? enRules : zhRules)
}

/** Public accessor for the active rules pack (used by config/version checks). */
export function getRulesPack(lang: 'zh' | 'en', custom?: RulesPack | null): RulesPack {
  return pickPack(lang, custom)
}

/**
 * Whether a stored rules-pack version tag lags behind the pack shipped with
 * this build. Versions are simple `lang-vN` tags; only the numeric suffix is
 * compared. Used to surface a "rules updated" hint in the UI. When a custom
 * pack is active it is the reference instead of the built-in pack.
 */
export function isRulesPackOutdated(
  stored: string | undefined,
  lang: 'zh' | 'en',
  custom?: RulesPack | null,
): boolean {
  const current = pickPack(lang, custom).version
  const parse = (v: string): number => {
    const m = v.match(/-v(\d+)$/)
    return m ? Number(m[1]) : 0
  }
  // 单值 rulesPackVersion 是跨语言共享的：只有当存储标签的语言前缀与当前
  // 语言一致时才比较，否则视为该语言尚无版本记录，避免导入 zh 包后误抑制
  // en 语言的更新提示。
  if (stored && !stored.startsWith(`${lang}-`)) return false
  return parse(stored ?? '') < parse(current)
}

/** Detect whether text is predominantly CJK (used to auto-pick the rules pack). */
export function detectLang(text: string): 'zh' | 'en' {
  const cjk = (text.match(/[\u4E00-\u9FFF]/g) ?? []).length
  const latin = (text.match(/[A-Za-z]/g) ?? []).length
  return cjk >= latin ? 'zh' : 'en'
}

interface Sentence {
  text: string
  start: number
  end: number
}

/** Split text into sentences by CJK + Latin terminators, keeping offsets. */
export function splitSentences(text: string): Sentence[] {
  const out: Sentence[] = []
  let start = 0
  const terminators = /[。！？!?…]+["'”’)）]?|\n{2,}/g
  let m: RegExpExecArray | null
  while ((m = terminators.exec(text)) !== null) {
    const end = m.index + m[0].length
    const slice = text.slice(start, end).trim()
    if (slice) out.push({ text: slice, start, end })
    start = end
  }
  if (start < text.length) {
    const slice = text.slice(start).trim()
    if (slice) out.push({ text: slice, start, end: text.length })
  }
  return out
}

/** Effective content length: CJK chars + Latin words (rough token proxy). */
function contentLength(s: string): number {
  const cjk = (s.match(/[\u4E00-\u9FFF\u3400-\u4DBF]/g) ?? []).length
  const words = (s.match(/[A-Za-z]+/g) ?? []).length
  return cjk + words
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0
  const mu = mean(xs)
  return Math.sqrt(mean(xs.map((x) => (x - mu) ** 2)))
}

/** Map a raw value through a soft threshold into 0–1 (higher = more AI-like). */
function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

/** Count total weighted rule hits in a string for a given category set. */
function ruleHits(
  text: string,
  rules: SlopRule[],
  categories: SlopRule['category'][],
  flags: string,
): { weighted: number; count: number } {
  let weighted = 0
  let count = 0
  for (const rule of rules) {
    if (!categories.includes(rule.category)) continue
    const re = new RegExp(rule.pattern, flags)
    const matches = text.match(re)
    if (matches) {
      count += matches.length
      weighted += matches.length * rule.weight
    }
  }
  return { weighted, count }
}

/** Which rule categories fired inside a single sentence (for flag reasons). */
function sentenceCategories(
  text: string,
  rules: SlopRule[],
  flags: string,
): Set<SlopRule['category']> {
  const cats = new Set<SlopRule['category']>()
  for (const rule of rules) {
    if (cats.has(rule.category)) continue
    if (new RegExp(rule.pattern, flags).test(text)) cats.add(rule.category)
  }
  return cats
}

/** Split into paragraphs by blank lines / single newlines. */
function splitParagraphs(text: string): string[] {
  return text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
}

/** Main entry: analyze prose and produce a SlopReport. */
export function analyzeSlop(
  text: string,
  opts?: {
    weights?: SlopWeights
    lang?: 'zh' | 'en'
    uiLang?: SlopUiLang
    /** Custom rules pack override; null/undefined falls back to the built-in pack. */
    rulesPack?: RulesPack | null
  },
): SlopReport {
  const lang = opts?.lang ?? detectLang(text)
  const weights = opts?.weights ?? DEFAULT_SLOP_WEIGHTS
  const pack = pickPack(lang, opts?.rulesPack)
  const uiLang = opts?.uiLang ?? 'zh'
  const reFlags = lang === 'en' ? 'gi' : 'g'
  const singleFlags = lang === 'en' ? 'i' : ''

  const sentences = splitSentences(text)
  const paragraphs = splitParagraphs(text)
  const totalContent = contentLength(text) || 1
  const lens = sentences.map((s) => contentLength(s.text)).filter((n) => n > 0)

  // ---- 1) Burstiness: humans vary sentence length; AI is uniform. ----
  // Coefficient of variation (stdev/mean). Low CV => AI-like.
  const cv = lens.length >= 2 ? stdev(lens) / (mean(lens) || 1) : 0
  // Human prose typically CV ~0.5–0.9; <0.35 is suspiciously even.
  const burstiness = clamp01((0.55 - cv) / 0.55)

  // ---- 2) Connectives density ----
  const conn = ruleHits(text, pack.rules, ['connective'], reFlags)
  // Normalize per ~100 content units; ~2/100 already strong.
  const connectives = clamp01(((conn.weighted / totalContent) * 100) / 2.2)

  // ---- 3) Parallelism / three-part scaffolding ----
  const par = ruleHits(text, pack.rules, ['parallelism'], reFlags)
  const parallelism = clamp01(((par.weighted / totalContent) * 100) / 1.4)

  // ---- 4) Abstract-noun fog ----
  const abs = ruleHits(text, pack.rules, ['abstractNoun'], reFlags)
  const abstractNouns = clamp01(((abs.weighted / totalContent) * 100) / 3)

  // ---- 5) Sentence-head repetition ----
  const heads = sentences
    .map((s) => s.text.replace(/^["'“”‘’(（]+/, '').slice(0, 2))
    .filter(Boolean)
  const headCounts = new Map<string, number>()
  for (const h of heads) headCounts.set(h, (headCounts.get(h) ?? 0) + 1)
  const repeatedHeads = [...headCounts.values()]
    .filter((n) => n > 1)
    .reduce((a, b) => a + (b - 1), 0)
  const sentenceHeadRepetition = clamp01(heads.length ? repeatedHeads / heads.length / 0.4 : 0)

  // ---- 6) Punctuation monotony: AI rarely uses …—— ？！ variety. ----
  const allPunct = (text.match(/[，。！？；：、…—,.!?;:]/g) ?? []).length || 1
  const richPunct = (text.match(/[…—！？!?]/g) ?? []).length
  const variety = richPunct / allPunct
  // Human prose ~>0.08 varied punctuation; near 0 => monotone.
  const punctuationMonotony = clamp01((0.08 - variety) / 0.08)

  // ---- 7) Idiom / four-char density (zh) or figurative idiom hints ----
  const idiomHits = ruleHits(text, pack.rules, ['idiomHint'], reFlags)
  const fourChar =
    lang === 'zh' ? (text.match(/[\u4E00-\u9FFF]{4}(?![\u4E00-\u9FFF])/g) ?? []).length : 0
  const idiomRaw = ((idiomHits.weighted + fourChar * 0.35) / totalContent) * 100
  const idiomDensity = clamp01(idiomRaw / 4)

  // ---- 8) Paragraph-length uniformity ----
  const paraLens = paragraphs.map((p) => contentLength(p)).filter((n) => n > 0)
  const paraCv = paraLens.length >= 2 ? stdev(paraLens) / (mean(paraLens) || 1) : 0.5
  const paragraphUniformity = clamp01((0.5 - paraCv) / 0.5)

  const rawScores: Record<SlopDimId, number> = {
    burstiness,
    connectives,
    parallelism,
    abstractNouns,
    sentenceHeadRepetition,
    punctuationMonotony,
    idiomDensity,
    paragraphUniformity,
  }

  const detailCtx: SlopDetailCtx = {
    cv,
    connCount: conn.count,
    parCount: par.count,
    absCount: abs.count,
    repeatedHeads,
    headTotal: heads.length,
    variety,
    idiomCount: fourChar + idiomHits.count,
    paraCv,
  }
  const details: Record<SlopDimId, string> = {
    burstiness: dimDetail('burstiness', uiLang, detailCtx),
    connectives: dimDetail('connectives', uiLang, detailCtx),
    parallelism: dimDetail('parallelism', uiLang, detailCtx),
    abstractNouns: dimDetail('abstractNouns', uiLang, detailCtx),
    sentenceHeadRepetition: dimDetail('sentenceHeadRepetition', uiLang, detailCtx),
    punctuationMonotony: dimDetail('punctuationMonotony', uiLang, detailCtx),
    idiomDensity: dimDetail('idiomDensity', uiLang, detailCtx),
    paragraphUniformity: dimDetail('paragraphUniformity', uiLang, detailCtx),
  }

  const dimensions: SlopDimScore[] = (Object.keys(rawScores) as SlopDimId[]).map((id) => ({
    id,
    label: dimLabel(id, uiLang),
    score: rawScores[id],
    weight: weights[id],
    detail: details[id],
  }))

  const weightSum = dimensions.reduce((a, d) => a + d.weight, 0) || 1
  const total = dimensions.reduce((a, d) => a + d.score * d.weight, 0) / weightSum
  const score = Math.round(clamp01(total) * 100)
  const band: SlopReport['band'] = score <= 30 ? 'green' : score <= 60 ? 'yellow' : 'red'

  // ---- Per-sentence flags ----
  const avgLen = mean(lens) || 1
  const flags: SlopFlag[] = []
  for (const s of sentences) {
    const cats = sentenceCategories(s.text, pack.rules, singleFlags)
    const reasons: SlopDimId[] = []
    if (cats.has('connective')) reasons.push('connectives')
    if (cats.has('parallelism')) reasons.push('parallelism')
    if (cats.has('abstractNoun')) reasons.push('abstractNouns')
    if (cats.has('idiomHint')) reasons.push('idiomDensity')
    // Structural: sentence length very close to the mean and mean itself long.
    const len = contentLength(s.text)
    const evenness = 1 - Math.min(1, Math.abs(len - avgLen) / (avgLen || 1))
    if (len > 18 && evenness > 0.8) reasons.push('burstiness')
    if (reasons.length === 0) continue
    const risk = clamp01(reasons.length / 3 + (cats.size >= 2 ? 0.2 : 0))
    flags.push({
      start: s.start,
      end: s.end,
      text: s.text,
      risk,
      reasons,
      note: flagNote(reasons, cats, uiLang),
    })
  }
  flags.sort((a, b) => b.risk - a.risk)

  return {
    score,
    band,
    dimensions,
    flags,
    stats: { sentences: sentences.length, chars: text.length, paragraphs: paragraphs.length },
  }
}
