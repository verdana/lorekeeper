import { Globe2, Users, Map, Coins, ListTree, FileText, type LucideIcon } from 'lucide-react'
import type { SettingCategory } from '@shared/types'

export const CATEGORY_LABELS: Record<SettingCategory, string> = {
  worldview: 'Worldview & Rules',
  character: 'Characters',
  geography: 'Geography & Map',
  economy: 'Society & Economy',
  outline: 'Plot Outline',
  misc: 'Misc'
}

export const CATEGORY_ORDER: SettingCategory[] = [
  'worldview',
  'character',
  'geography',
  'economy',
  'outline',
  'misc'
]

/** Each setting category maps to a warm-wood colour. */
export const CATEGORY_COLORS: Record<SettingCategory, string> = {
  worldview: '#7A5C4E',
  character: '#B8642E',
  geography: '#6B8E4E',
  economy: '#8A6E3A',
  outline: '#A64A3F',
  misc: '#A89676'
}

/** Each setting category’s icon. */
export const CATEGORY_ICONS: Record<SettingCategory, LucideIcon> = {
  worldview: Globe2,
  character: Users,
  geography: Map,
  economy: Coins,
  outline: ListTree,
  misc: FileText
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
