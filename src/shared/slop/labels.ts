import type { SlopDimId } from '../types'
import type { SlopRule } from './rules.types'

/** UI language for slop labels, independent of the prose language. */
export type SlopUiLang = 'zh' | 'en'

const DIM_LABELS: Record<SlopUiLang, Record<SlopDimId, string>> = {
  zh: {
    burstiness: '句长节奏 (burstiness)',
    connectives: '套话连接词',
    parallelism: '排比/三段式',
    abstractNouns: '抽象名词密度',
    sentenceHeadRepetition: '句首同质度',
    punctuationMonotony: '标点单一度',
    idiomDensity: '成语/四字格堆叠',
    paragraphUniformity: '段落长度均匀度',
    pivot: '翻案句/翻案腔',
    leftBranch: '长前置/重定语',
  },
  en: {
    burstiness: 'Sentence-length rhythm (burstiness)',
    connectives: 'Cliché connectives',
    parallelism: 'Parallelism / triads',
    abstractNouns: 'Abstract-noun density',
    sentenceHeadRepetition: 'Sentence-head uniformity',
    punctuationMonotony: 'Punctuation monotony',
    idiomDensity: 'Idiom / four-char stacking',
    paragraphUniformity: 'Paragraph-length uniformity',
    pivot: 'Pivot sentences (X, not Y)',
    leftBranch: 'Left-branching / heavy modifiers',
  },
}

export function dimLabel(id: SlopDimId, lang: SlopUiLang): string {
  return DIM_LABELS[lang][id]
}

/** Numeric context shared by all dimension detail templates. */
export interface SlopDetailCtx {
  cv: number
  connCount: number
  parCount: number
  absCount: number
  sceneTellCount: number
  maxLen: number
  repeatedHeads: number
  headTotal: number
  variety: number
  idiomCount: number
  paraCv: number
  pivotCount: number
  leftBranchCount: number
  metaphorCount: number
}

const DIM_DETAIL: Record<SlopUiLang, Record<SlopDimId, (ctx: SlopDetailCtx) => string>> = {
  zh: {
    burstiness: (c) =>
      `句长变异系数 ${c.cv.toFixed(2)}，最长句 ${c.maxLen} 字（人类常出现 55+ 字长句）`,
    connectives: (c) => `命中套话连接词 ${c.connCount} 处`,
    parallelism: (c) => `命中排比/三段式 ${c.parCount} 处`,
    abstractNouns: (c) =>
      `命中抽象表达 ${c.absCount} 处，其中套路模板 ${c.sceneTellCount} 处（“身体做出了反应”“X从…涌上来”“某种/一种X”）`,
    sentenceHeadRepetition: (c) =>
      `相邻句首重复 ${c.repeatedHeads} 处 / 共 ${c.headTotal} 句（只算连续句子）`,
    punctuationMonotony: (c) => `丰富标点占比 ${(c.variety * 100).toFixed(1)}%（越低越单一）`,
    idiomDensity: (c) =>
      `成语/惯用四字表达 ${c.idiomCount} 处${
        c.metaphorCount > 0 ? `，短距离混用 ${c.metaphorCount} 处借喻` : ''
      }`,
    paragraphUniformity: (c) => `段落长度变异系数 ${c.paraCv.toFixed(2)}`,
    pivot: (c) => `命中翻案句 ${c.pivotCount} 处（先立误解再推翻抬价）`,
    leftBranch: (c) => `长前置/重“的”句 ${c.leftBranchCount} 处`,
  },
  en: {
    burstiness: (c) =>
      `Sentence-length CV ${c.cv.toFixed(2)}; longest ${c.maxLen} (humans usually run one 55+ sentence)`,
    connectives: (c) => `${c.connCount} cliché-connective hits`,
    parallelism: (c) => `${c.parCount} parallelism / triadic hits`,
    abstractNouns: (c) =>
      `${c.absCount} abstract-expression hits (${c.sceneTellCount} formulaic templates: “身体做出了反应” / “X从…涌上来” / “某种·一种X”)`,
    sentenceHeadRepetition: (c) =>
      `${c.repeatedHeads} adjacent repeated heads / ${c.headTotal} sentences (consecutive only)`,
    punctuationMonotony: (c) =>
      `Rich-punctuation share ${(c.variety * 100).toFixed(1)}% (lower is more monotone)`,
    idiomDensity: (c) =>
      `${c.idiomCount} idiom / four-char hits${
        c.metaphorCount > 0 ? `, ${c.metaphorCount} mixed-metaphor hits in a short window` : ''
      }`,
    paragraphUniformity: (c) => `Paragraph-length CV ${c.paraCv.toFixed(2)}`,
    pivot: (c) => `${c.pivotCount} pivot-sentence hits (straw-man then flip)`,
    leftBranch: (c) => `${c.leftBranchCount} left-branching / heavy-modifier sentences`,
  },
}

export function dimDetail(id: SlopDimId, lang: SlopUiLang, ctx: SlopDetailCtx): string {
  return DIM_DETAIL[lang][id](ctx)
}

const NOTE_WORDS: Record<
  SlopUiLang,
  {
    connective: string
    parallelism: string
    abstractNoun: string
    idiomHint: string
    pivot: string
    leftBranch: string
    burstiness: string
    sentenceHeadRepetition: string
    structure: string
  }
> = {
  zh: {
    connective: '套话连接词',
    parallelism: '排比/三段式',
    abstractNoun: '抽象名词',
    idiomHint: '套式比喻',
    pivot: '翻案腔',
    leftBranch: '长前置/重“的”',
    burstiness: '句长平均化',
    sentenceHeadRepetition: '句首重复',
    structure: '结构均匀',
  },
  en: {
    connective: 'cliché connective',
    parallelism: 'parallelism / triadic',
    abstractNoun: 'abstract noun',
    idiomHint: 'formulaic metaphor',
    pivot: 'pivot cliché',
    leftBranch: 'left-branching / heavy modifiers',
    burstiness: 'flattened sentence length',
    sentenceHeadRepetition: 'repeated sentence head',
    structure: 'uniform structure',
  },
}

/** Build the short human-readable note for a flagged sentence. */
export function flagNote(
  reasons: SlopDimId[],
  cats: Set<SlopRule['category']>,
  lang: SlopUiLang,
): string {
  const w = NOTE_WORDS[lang]
  const parts: string[] = []
  if (cats.has('connective')) parts.push(w.connective)
  if (cats.has('parallelism')) parts.push(w.parallelism)
  if (cats.has('abstractNoun')) parts.push(w.abstractNoun)
  if (cats.has('idiomHint')) parts.push(w.idiomHint)
  if (cats.has('pivot')) parts.push(w.pivot)
  if (cats.has('leftBranch')) parts.push(w.leftBranch)
  if (reasons.includes('burstiness')) parts.push(w.burstiness)
  if (reasons.includes('sentenceHeadRepetition')) parts.push(w.sentenceHeadRepetition)
  const sep = lang === 'zh' ? '、' : ', '
  return parts.join(sep) || w.structure
}
