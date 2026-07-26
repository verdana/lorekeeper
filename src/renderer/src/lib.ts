import { Globe2, Users, Map, Coins, ListTree, FileText, type LucideIcon } from 'lucide-react'
import type { SettingCategory } from '@shared/types'

export const CATEGORY_LABELS: Record<SettingCategory, string> = {
  worldview: 'Worldview & Rules',
  character: 'Characters',
  geography: 'Geography & Map',
  economy: 'Society & Economy',
  outline: 'Plot Outline',
  misc: 'Misc',
}

export const CATEGORY_ORDER: SettingCategory[] = [
  'worldview',
  'character',
  'geography',
  'economy',
  'outline',
  'misc',
]

/** Each setting category maps to a warm-wood colour. */
export const CATEGORY_COLORS: Record<SettingCategory, string> = {
  worldview: '#7A5C4E',
  character: '#B8642E',
  geography: '#6B8E4E',
  economy: '#8A6E3A',
  outline: '#A64A3F',
  misc: '#A89676',
}

/** Each setting category’s icon. */
export const CATEGORY_ICONS: Record<SettingCategory, LucideIcon> = {
  worldview: Globe2,
  character: Users,
  geography: Map,
  economy: Coins,
  outline: ListTree,
  misc: FileText,
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
