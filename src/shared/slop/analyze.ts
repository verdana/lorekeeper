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
  pivot: 0.15,
  leftBranch: 0.1,
}

/**
 * Merge stored weights over the defaults so every dimension always has a
 * value (older stored configs predate newer dimensions). Unknown extra keys
 * in the stored weights are dropped.
 */
export function mergeSlopWeights(weights?: SlopWeights | null): SlopWeights {
  const out = { ...DEFAULT_SLOP_WEIGHTS }
  if (!weights) return out
  for (const d of Object.keys(DEFAULT_SLOP_WEIGHTS) as SlopDimId[]) {
    const v = weights[d]
    if (typeof v === 'number' && Number.isFinite(v)) out[d] = v
  }
  return out
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

/**
 * Metaphor fields a model tends to borrow to dress up abstract ideas
 * (仓储/温度/战争/建筑/道路/机器/航海). Mixing several of these in a short
 * window is a tell: the prose is changing worlds instead of staying concrete.
 */
const METAPHOR_FIELDS: Record<string, string[]> = {
  温度: ['降温', '升温', '冷却', '余温', '温度最高'],
  生死战争: ['杀死', '死因', '枪响', '开火', '战场', '引爆', '弹药'],
  建筑灾害: ['坍塌', '崩塌', '地基', '砖头', '支柱', '废墟'],
  仓储租赁: ['仓库', '库房', '租金', '取货', '入库', '库存'],
  道路竞赛: ['赛道', '跑道', '岔路', '十字路口', '终点线', '门票'],
  机器器官: ['齿轮', '引擎', '发动机', '血管', '骨架', '肌肉'],
  海洋航行: ['蓝海', '浪潮', '潮水', '航船', '灯塔', '彼岸'],
}

interface MetaphorHit {
  start: number
  field: string
  word: string
}

/**
 * Find a window of `distance` chars containing hits from 3+ metaphor fields.
 * Returns the full in-span hit list of the first such window (so every related
 * sentence can be flagged), or null.
 */
function metaphorCluster(text: string, distance = 800): MetaphorHit[] | null {
  const hits: MetaphorHit[] = []
  for (const [field, words] of Object.entries(METAPHOR_FIELDS)) {
    for (const word of words) {
      // All field words are plain CJK; no escaping needed.
      const re = new RegExp(word, 'g')
      let m: RegExpExecArray | null
      while ((m = re.exec(text)) !== null) {
        hits.push({ start: m.index, field, word })
        if (m.index === re.lastIndex) re.lastIndex++
      }
    }
  }
  hits.sort((a, b) => a.start - b.start)
  for (let i = 0; i < hits.length; i++) {
    const window: MetaphorHit[] = []
    const fields = new Set<string>()
    for (let j = i; j < hits.length && hits[j].start - hits[i].start <= distance; j++) {
      window.push(hits[j])
      fields.add(hits[j].field)
    }
    if (fields.size >= 3) return window
  }
  return null
}

/**
 * Lyric words a model favors to dress up abstractions (安放/微光/滚烫…).
 * A single occurrence is usually literal ("他剥开橘子"), so the detector only
 * fires when the whole piece carries 2+ of them — matching human-writing's
 * "出现两处以上才提醒" rule.
 */
const LYRIC_WORDS = ['安放', '抵达', '微光', '褶皱', '丰盈', '滚烫', '轻盈', '赤裸', '剥开']

function lyricWordHits(text: string): number[] {
  const out: number[] = []
  for (const word of LYRIC_WORDS) {
    const re = new RegExp(word, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      out.push(m.index)
      if (m.index === re.lastIndex) re.lastIndex++
    }
  }
  return out.sort((a, b) => a - b)
}

/** A sentence whose head is crushed under many 的 (≥38 content units, ≥4 的). */
function heavyDeSentence(text: string): boolean {
  return contentLength(text) >= 38 && (text.match(/的/g) ?? []).length >= 4
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
  const weights = mergeSlopWeights(opts?.weights)
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
  const maxLen = lens.length ? Math.max(...lens) : 0
  // A piece with no sentence longer than ~55 content units reads flat even when
  // its CV looks human — staccato fragments (“焦。烫。”) inflate the variance
  // while the body of the prose stays one uniform mid-length register.
  const longGap = clamp01((55 - Math.min(maxLen, 55)) / 55)
  const burstiness = clamp01(Math.max((0.55 - cv) / 0.55, longGap * 0.9))

  // ---- 2) Connectives density ----
  const conn = ruleHits(text, pack.rules, ['connective'], reFlags)
  // Normalize per ~100 content units; ~2/100 already strong.
  const connectives = clamp01(((conn.weighted / totalContent) * 100) / 2.2)

  // ---- 3) Parallelism / three-part scaffolding ----
  const par = ruleHits(text, pack.rules, ['parallelism'], reFlags)
  const parallelism = clamp01(((par.weighted / totalContent) * 100) / 1.4)

  // ---- 4) Abstract-noun fog ----
  const abs = ruleHits(text, pack.rules, ['abstractNoun'], reFlags)
  // Scene-tell templates (身体做出了反应 / X从…涌上来 / 某种·一种X) are rare but
  // strong: normalize by hit count, not density, so a few instances carry real
  // weight instead of being diluted by the prose length.
  let abstractNouns = clamp01(
    Math.max(((abs.weighted / totalContent) * 100) / 3, abs.weighted / 3.2),
  )
  // Lyric words fire only on 2+ hits across the piece (a single "剥开橘子"
  // is literal). When they do, bump the dimension and flag those sentences.
  const lyricHits = lang === 'zh' ? lyricWordHits(text) : []
  const lyricActive = lyricHits.length >= 2
  if (lyricActive) abstractNouns = Math.max(abstractNouns, 0.45)

  // ---- 5) Sentence-head repetition ----
  // Only *adjacent* sentences sharing the first two chars are a visible beat:
  // scattered repeats (句1 和句8 都以「他说」开头) are normal Chinese prose,
  // and counting them made the dimension impossible to lower by editing.
  const headList = sentences.map((s) => s.text.replace(/^["'“”‘’(（]+/, '').slice(0, 2))
  const nonEmptyHeads = headList.filter(Boolean).length
  let repeatedAdjacent = 0
  const headFlagSentences = new Set<number>()
  for (let i = 1; i < headList.length; i++) {
    const head = headList[i]
    if (head && head === headList[i - 1]) {
      repeatedAdjacent++
      headFlagSentences.add(i - 1)
      headFlagSentences.add(i)
    }
  }
  // ~15% of sentences running straight off the previous one's opening is the
  // point where a reader starts to hear the beat.
  const sentenceHeadRepetition = clamp01(
    nonEmptyHeads ? repeatedAdjacent / nonEmptyHeads / 0.15 : 0,
  )

  // ---- 6) Punctuation monotony: AI rarely uses …—— ？！ variety. ----
  const allPunct = (text.match(/[，。！？；：、…—,.!?;:]/g) ?? []).length || 1
  const richPunct = (text.match(/[…—！？!?]/g) ?? []).length
  const variety = richPunct / allPunct
  // Human prose ~>0.08 varied punctuation; near 0 => monotone.
  const punctuationMonotony = clamp01((0.08 - variety) / 0.08)

  // ---- 7) Idiom / four-char stacking ----
  // Driven by the idiomHint rules (a real idiom wordlist, not any 4-char
  // block — counting "任意 4 字片段" like 了这座城 made the dimension sit at
  // 100 forever and carry no signal). A couple of idioms are normal; heavy
  // stacking of model-favored four-char phrases is the tell.
  const idiomHits = ruleHits(text, pack.rules, ['idiomHint'], reFlags)
  const idiomRaw =
    ((idiomHits.weighted + (lang === 'zh' ? idiomHits.count * 0.15 : 0)) / totalContent) * 100
  let idiomDensity = clamp01(idiomRaw / 3)
  // A metaphor cluster (3+ borrowed fields inside a short window) is a strong
  // tell even when the individual words are rare; bump the dimension.
  const metaphor = lang === 'zh' ? metaphorCluster(text) : null
  if (metaphor) idiomDensity = Math.max(idiomDensity, 0.6)

  // ---- 8) Pivot sentences (翻案腔) ----
  // 禁的是“先立一个读者没有的误解，再推翻它抬价”这个动作。命中一次就是
  // 强信号，因此按加权命中数归一化（约 1.4 加权分即满分），而不是按密度。
  const pivot = ruleHits(text, pack.rules, ['pivot'], reFlags)
  const pivotScore = clamp01(pivot.weighted / 1.4)

  // ---- 9) Left branching / heavy-的 heads (zh) ----
  // 主干被一长串前置成分或“的”字定语压到句子末尾。低频强信号，按命中数
  // 归一化；规则命中 + 重“的”句合并计分。
  const leftBranch = ruleHits(text, pack.rules, ['leftBranch'], reFlags)
  const heavyDeSet = new Set<number>()
  if (lang === 'zh') {
    sentences.forEach((s, i) => {
      if (heavyDeSentence(s.text)) heavyDeSet.add(i)
    })
  }
  const leftBranchScore = clamp01((leftBranch.weighted + heavyDeSet.size * 0.5) / 1.8)

  // Count of severity-marked abstractNoun rules that fire (nominalization and
  // scene-tell templates): rare but strong, kept separate for the detail text.
  const sceneTellCount = pack.rules.reduce((n, r) => {
    if (r.category !== 'abstractNoun' || !r.severity) return n
    return n + (new RegExp(r.pattern, reFlags).test(text) ? 1 : 0)
  }, 0)

  // ---- 10) Paragraph-length uniformity ----
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
    pivot: pivotScore,
    leftBranch: leftBranchScore,
  }

  const detailCtx: SlopDetailCtx = {
    cv,
    maxLen,
    connCount: conn.count,
    parCount: par.count,
    absCount: abs.count,
    sceneTellCount,
    repeatedHeads: repeatedAdjacent,
    headTotal: nonEmptyHeads,
    variety,
    idiomCount: idiomHits.count,
    paraCv,
    pivotCount: pivot.count,
    leftBranchCount: leftBranch.count + heavyDeSet.size,
    metaphorCount: metaphor?.length ?? 0,
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
    pivot: dimDetail('pivot', uiLang, detailCtx),
    leftBranch: dimDetail('leftBranch', uiLang, detailCtx),
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

  // Pivot shells often span sentence boundaries ("不是A。而是B"), so the
  // per-sentence category test alone would miss them. Pre-scan the whole text
  // for pivot rules and map every hit to the sentence that contains it.
  const pivotHits = new Map<number, Set<'hard' | 'soft'>>()
  for (const rule of pack.rules) {
    if (rule.category !== 'pivot') continue
    const re = new RegExp(rule.pattern, reFlags)
    const severity = rule.severity ?? 'soft'
    let m: RegExpExecArray | null
    let cursor = 0
    while ((m = re.exec(text)) !== null) {
      const pos = m.index
      while (cursor < sentences.length - 1 && sentences[cursor + 1].end <= pos) cursor++
      if (pos >= sentences[cursor].start && pos < sentences[cursor].end) {
        let set = pivotHits.get(cursor)
        if (!set) {
          set = new Set()
          pivotHits.set(cursor, set)
        }
        set.add(severity)
      }
      if (m.index === re.lastIndex) re.lastIndex++
    }
  }

  // Metaphor-cluster window: mark every sentence that contains a field word so
  // the whole mixed-metaphor passage surfaces in flags, not just the score.
  const metaphorSentences = new Set<number>()
  if (metaphor) {
    let cursor = 0
    for (const hit of metaphor) {
      const pos = hit.start
      while (cursor < sentences.length - 1 && sentences[cursor + 1].end <= pos) cursor++
      if (pos >= sentences[cursor].start && pos < sentences[cursor].end) {
        metaphorSentences.add(cursor)
      }
    }
  }

  // Lyric words, when 2+ occur across the piece, flag the sentences carrying them.
  const lyricSentences = new Set<number>()
  if (lyricActive) {
    let cursor = 0
    for (const pos of lyricHits) {
      while (cursor < sentences.length - 1 && sentences[cursor + 1].end <= pos) cursor++
      if (pos >= sentences[cursor].start && pos < sentences[cursor].end) {
        lyricSentences.add(cursor)
      }
    }
  }

  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i]
    const cats = sentenceCategories(s.text, pack.rules, singleFlags)
    const reasons: SlopDimId[] = []
    if (cats.has('connective')) reasons.push('connectives')
    if (cats.has('parallelism')) reasons.push('parallelism')
    if (cats.has('abstractNoun')) reasons.push('abstractNouns')
    if (cats.has('idiomHint')) reasons.push('idiomDensity')
    if (cats.has('leftBranch') || heavyDeSet.has(i)) {
      reasons.push('leftBranch')
      cats.add('leftBranch')
    }
    if (metaphorSentences.has(i)) {
      if (!reasons.includes('idiomDensity')) reasons.push('idiomDensity')
      cats.add('idiomHint')
    }
    if (lyricSentences.has(i)) {
      if (!reasons.includes('abstractNouns')) reasons.push('abstractNouns')
      cats.add('abstractNoun')
    }
    if (headFlagSentences.has(i)) reasons.push('sentenceHeadRepetition')
    // Structural: sentence length very close to the mean and mean itself long.
    const len = contentLength(s.text)
    const evenness = 1 - Math.min(1, Math.abs(len - avgLen) / (avgLen || 1))
    if (len > 18 && evenness > 0.8) reasons.push('burstiness')
    const pivotSeverities = pivotHits.get(i)
    if (cats.has('pivot') || pivotSeverities) {
      reasons.push('pivot')
      cats.add('pivot')
    }
    if (reasons.length === 0) continue
    // Severity comes from the pre-scanned pivot rules only: a literal shell is
    // 'hard'; a disguised variant stays 'soft' (it may be a real self-correction).
    const severity: 'hard' | 'soft' = pivotSeverities?.has('hard') ? 'hard' : 'soft'
    let risk = clamp01(reasons.length / 3 + (cats.size >= 2 ? 0.2 : 0))
    if (severity === 'hard') risk = Math.max(risk, 0.7)
    flags.push({
      start: s.start,
      end: s.end,
      text: s.text,
      risk,
      reasons,
      severity,
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
