import {
  Building2,
  Coins,
  Cpu,
  FileText,
  Flag,
  Globe2,
  History,
  Map,
  Moon,
  Package,
  PawPrint,
  Sparkles,
  Users,
  type LucideIcon,
} from 'lucide-react'
import type { SettingCategory } from '@shared/types'

export const CATEGORY_LABELS: Record<SettingCategory, string> = {
  '01-worldview': 'Worldview & Cosmic Laws',
  '02-magic': 'Magic & Supernatural Systems',
  '03-history': 'History & Timeline',
  '04-geography': 'Geography & Territories',
  '05-faction': 'Nations & Organizations',
  '06-religion': 'Religion & Mythology',
  '07-society': 'Society & Culture',
  '08-economy': 'Economy & Trade',
  '09-technology': 'Technology, Military & Productivity',
  '10-species': 'Species, Monsters & Ecology',
  '11-character': 'Characters',
  '12-item': 'Artifacts & Vehicles',
  '99-misc': 'Miscellaneous & Reference',
}

export const CATEGORY_ORDER: SettingCategory[] = [
  '01-worldview',
  '02-magic',
  '03-history',
  '04-geography',
  '05-faction',
  '06-religion',
  '07-society',
  '08-economy',
  '09-technology',
  '10-species',
  '11-character',
  '12-item',
  '99-misc',
]

/** Each setting category maps to a warm-wood colour. */
export const CATEGORY_COLORS: Record<SettingCategory, string> = {
  '01-worldview': '#7A5C4E',
  '02-magic': '#7D5BA6',
  '03-history': '#9C7A3C',
  '04-geography': '#6B8E4E',
  '05-faction': '#A0453C',
  '06-religion': '#8E6F8E',
  '07-society': '#5E7D8A',
  '08-economy': '#8A6E3A',
  '09-technology': '#6E7B8B',
  '10-species': '#7A8B4E',
  '11-character': '#B8642E',
  '12-item': '#A87E4A',
  '99-misc': '#A89676',
}

/** Each setting category’s icon. */
export const CATEGORY_ICONS: Record<SettingCategory, LucideIcon> = {
  '01-worldview': Globe2,
  '02-magic': Sparkles,
  '03-history': History,
  '04-geography': Map,
  '05-faction': Flag,
  '06-religion': Moon,
  '07-society': Building2,
  '08-economy': Coins,
  '09-technology': Cpu,
  '10-species': PawPrint,
  '11-character': Users,
  '12-item': Package,
  '99-misc': FileText,
}

/**
 * Parse a user-entered max tokens value.
 * Supports "128k", "128K", "128000", "128,000", or empty/blank.
 * Returns the parsed number (null = use model default) and an optional error.
 */
export function parseMaxTokens(input: string): { value: number | null; error?: string } {
  const trimmed = input.trim()
  if (!trimmed) return { value: null }

  // Strip thousands separators
  const cleaned = trimmed.replace(/,/g, '')

  // "128k" / "128K" / "1.5k" → 128000 / 1500
  const kMatch = cleaned.match(/^(\d+(?:\.\d+)?)\s*k$/i)
  if (kMatch) {
    const num = Math.round(parseFloat(kMatch[1]) * 1000)
    if (num < 1) return { value: null, error: 'Must be at least 1' }
    if (num > 10_000_000) return { value: null, error: 'Value too large (max 10,000,000)' }
    return { value: num }
  }

  // Plain integer
  const num = parseInt(cleaned, 10)
  if (isNaN(num) || num < 1)
    return { value: null, error: 'Enter a positive number, e.g. 4096 or 128k' }
  if (num > 10_000_000) return { value: null, error: 'Value too large (max 10,000,000)' }
  return { value: num }
}

export function wordCount(text: string): number {
  // 中文按字符计，英文按单词计的粗略估算
  const cjk = (text.match(/[一-鿿]/g) || []).length
  const words = (text.replace(/[一-鿿]/g, ' ').match(/\b\w+\b/g) || []).length
  return cjk + words
}

// Minimum body words below which a document is considered a stub.
// Absolute threshold: short-but-complete entries (e.g. minor characters,
// small locations) are legitimate, so we only flag near-empty drafts.
export const STUB_WORD_THRESHOLD = 20

// Matches common placeholder markers left in unfinished drafts.
const PLACEHOLDER_PATTERN = /\b(?:TODO|FIXME|TBD|WIP|XXX)\b|待补充|待完善|待填写|占位|placeholder/i

/**
 * Count words in the document body only, excluding Markdown headings,
 * blank lines, and horizontal rules. Headings inflate raw word counts
 * and can hide otherwise empty documents, so they are stripped here.
 */
export function bodyWordCount(text: string): number {
  const body = text
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim()
      if (trimmed === '') return false
      if (trimmed.startsWith('#')) return false // heading
      if (/^[-*_]{3,}$/.test(trimmed)) return false // horizontal rule
      return true
    })
    .join('\n')
  return wordCount(body)
}

export type DocDevelopmentLevel = 'ok' | 'stub'

export interface DocDevelopmentInfo {
  level: DocDevelopmentLevel
  bodyWords: number
  /** Reason the doc was flagged, for surfacing in the UI. */
  reason?: 'empty' | 'stub' | 'placeholder'
}

/**
 * Assess whether a document is under-developed using absolute, per-document
 * signals instead of a relative average. A doc is flagged when its body is
 * empty, contains only unfinished placeholders, or has fewer than
 * STUB_WORD_THRESHOLD body words.
 */
export function assessDocDevelopment(text: string): DocDevelopmentInfo {
  const bodyWords = bodyWordCount(text)
  if (bodyWords === 0) {
    return { level: 'stub', bodyWords, reason: 'empty' }
  }
  if (PLACEHOLDER_PATTERN.test(text) && bodyWords < STUB_WORD_THRESHOLD) {
    return { level: 'stub', bodyWords, reason: 'placeholder' }
  }
  if (bodyWords < STUB_WORD_THRESHOLD) {
    return { level: 'stub', bodyWords, reason: 'stub' }
  }
  return { level: 'ok', bodyWords }
}

export function uid(prefix = ''): string {
  return prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
}

export function formatTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 本地日期键，如 "2026-07-15"，用于按天记录字数基线 */
export function todayKey(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

import type { SettingDoc } from '@shared/types'

/**
 * Extract all [[wikilink]] titles from a markdown string.
 * Duplicates are kept; deduplicate at the call site if needed.
 */
export function extractWikilinks(text: string): string[] {
  const matches = text.match(/\[\[([^\]]+)\]\]/g)
  if (!matches) return []
  return matches.map((m) => m.slice(2, -2))
}

/**
 * Replace all [[Title]] references in markdown with
 * `<a class="wikilink" data-wikilink="Title">Title</a>`.
 */
export function replaceWikilinks(text: string): string {
  return text.replace(
    /\[\[([^\]]+)\]\]/g,
    (_, title: string) =>
      `<a class="wikilink" data-wikilink="${title.replace(/"/g, '&quot;')}">${title}</a>`,
  )
}

/**
 * Resolve a wikilink title to a SettingDoc by title or fallback to id basename.
 */
export function resolveWikilink(title: string, docs: SettingDoc[]): SettingDoc | undefined {
  return docs.find(
    (d) =>
      d.title.toLowerCase() === title.toLowerCase() ||
      d.id.split('/').pop()?.replace(/\.md$/i, '').toLowerCase() === title.toLowerCase(),
  )
}

/**
 * Turn codex document references inside a consistency report into clickable
 * wikilink anchors. Handles `[[docId]]` (with or without the .md suffix),
 * `[docId]`, and `(docs: a.md, b.md)` forms. The label is the document title
 * when resolvable, else the id.
 */
export function linkifyDocRefs(text: string, docs: SettingDoc[]): string {
  // Resolve a raw reference to a doc: full id, id missing the .md suffix,
  // bare file name, or title (via resolveWikilink). Case-insensitive.
  const resolveRef = (raw: string): SettingDoc | undefined => {
    const id = raw.trim()
    if (!id) return undefined
    const norm = (s: string): string => s.toLowerCase()
    return (
      docs.find((d) => norm(d.id) === norm(id)) ??
      docs.find((d) => norm(d.id) === norm(`${id}.md`)) ??
      docs.find((d) => norm(d.id.split('/').pop() ?? '') === norm(id)) ??
      docs.find((d) => norm(d.id.split('/').pop() ?? '') === norm(`${id}.md`)) ??
      resolveWikilink(id, docs)
    )
  }
  const link = (raw: string): string => {
    const id = raw.trim()
    if (!id) return ''
    const doc = resolveRef(id)
    const targetId = doc?.id ?? id
    const label = doc?.title ?? id
    return `<a class="wikilink" data-wikilink="${targetId.replace(/"/g, '&quot;')}">${label}</a>`
  }
  // (docs: a.md, b.md) — process first so inner ids are not re-processed.
  const withDocs = text.replace(/\(docs?:?\s*([^)]*)\)/gi, (_m, inner: string) =>
    inner
      .split(/[,，;]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map(link)
      .join(', '),
  )
  // [[docId]] and [docId]
  return withDocs.replace(
    /\[\[([^\[\]]+)\]\]|\[([^\[\]()\s]+\.md)\]/gi,
    (_m, double: string, single: string) => link(double ?? single ?? ''),
  )
}
