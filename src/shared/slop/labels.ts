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
  repeatedHeads: number
  headTotal: number
  variety: number
  idiomCount: number
  paraCv: number
}

const DIM_DETAIL: Record<SlopUiLang, Record<SlopDimId, (ctx: SlopDetailCtx) => string>> = {
  zh: {
    burstiness: (c) => `句长变异系数 ${c.cv.toFixed(2)}（越低越均匀，人类通常 0.5+）`,
    connectives: (c) => `命中套话连接词 ${c.connCount} 处`,
    parallelism: (c) => `命中排比/三段式 ${c.parCount} 处`,
    abstractNouns: (c) => `命中抽象名词 ${c.absCount} 处`,
    sentenceHeadRepetition: (c) => `重复句首 ${c.repeatedHeads} 处 / 共 ${c.headTotal} 句`,
    punctuationMonotony: (c) => `丰富标点占比 ${(c.variety * 100).toFixed(1)}%（越低越单一）`,
    idiomDensity: (c) => `四字格/成语式表达约 ${c.idiomCount} 处`,
    paragraphUniformity: (c) => `段落长度变异系数 ${c.paraCv.toFixed(2)}`,
  },
  en: {
    burstiness: (c) =>
      `Sentence-length CV ${c.cv.toFixed(2)} (lower is more uniform; humans usually 0.5+)`,
    connectives: (c) => `${c.connCount} cliché-connective hits`,
    parallelism: (c) => `${c.parCount} parallelism / triadic hits`,
    abstractNouns: (c) => `${c.absCount} abstract-noun hits`,
    sentenceHeadRepetition: (c) =>
      `${c.repeatedHeads} repeated sentence heads / ${c.headTotal} sentences`,
    punctuationMonotony: (c) =>
      `Rich-punctuation share ${(c.variety * 100).toFixed(1)}% (lower is more monotone)`,
    idiomDensity: (c) => `~${c.idiomCount} idiom / four-char expressions`,
    paragraphUniformity: (c) => `Paragraph-length CV ${c.paraCv.toFixed(2)}`,
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
    burstiness: string
    structure: string
  }
> = {
  zh: {
    connective: '套话连接词',
    parallelism: '排比/三段式',
    abstractNoun: '抽象名词',
    idiomHint: '套式比喻',
    burstiness: '句长平均化',
    structure: '结构均匀',
  },
  en: {
    connective: 'cliché connective',
    parallelism: 'parallelism / triadic',
    abstractNoun: 'abstract noun',
    idiomHint: 'formulaic metaphor',
    burstiness: 'flattened sentence length',
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
  if (reasons.includes('burstiness')) parts.push(w.burstiness)
  const sep = lang === 'zh' ? '、' : ', '
  return parts.join(sep) || w.structure
}

export interface ChecklistCtx {
  worldTitle?: string
  date: string
  count: number
}

const CHECKLIST: Record<
  SlopUiLang,
  {
    title: (ctx: ChecklistCtx) => string
    rule1: string
    rule2: string
    header: string
    footer: (ctx: ChecklistCtx) => string
  }
> = {
  zh: {
    title: (ctx) => (ctx.worldTitle ? `朱雀自测清单 · ${ctx.worldTitle}` : '朱雀自测清单'),
    rule1: '说明：将每章正文复制到 zhuque.tencent.com 检测，把「AI 疑似度 %」填回下表。',
    rule2: '回填后在「去 AI 味 · 校准」面板逐条录入，即可校准本地权重。',
    header: '章节 | 本地机器味 | 朱雀疑似度 %',
    footer: (ctx) => `生成于 ${ctx.date}，共 ${ctx.count} 章`,
  },
  en: {
    title: (ctx) =>
      ctx.worldTitle
        ? `Zhuque self-test checklist · ${ctx.worldTitle}`
        : 'Zhuque self-test checklist',
    rule1:
      'Instructions: copy each chapter to zhuque.tencent.com, then backfill the "AI suspicion %" into the table below.',
    rule2:
      'After backfilling, enter the scores in the De-slop · Calibration panel to fit local weights.',
    header: 'Chapter | Local slop score | Zhuque suspicion %',
    footer: (ctx) => `Generated ${ctx.date}, ${ctx.count} chapters`,
  },
}

export function checklistText(lang: SlopUiLang): (typeof CHECKLIST)['en'] {
  return CHECKLIST[lang]
}
