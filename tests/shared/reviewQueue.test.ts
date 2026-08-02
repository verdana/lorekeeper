import { describe, expect, it } from 'vitest'
import {
  applyReviewItemStatus,
  buildManualReviewItem,
  buildReviewItemsFromReport,
  countOpenReviewItems,
  isReviewQueueItem,
  markReviewItemFixed,
  parseReportIssues,
  removeReviewItems,
} from '../../src/shared/reviewQueue'
import type { ReviewQueueItem, ReviewQueueStore } from '../../src/shared/types'

const item = (id: string, status: ReviewQueueItem['status'] = 'open'): ReviewQueueItem => ({
  id,
  reportId: null,
  reportLabel: '',
  severity: 'moderate',
  text: `Issue ${id}`,
  relatedDocIds: [],
  status,
  fixedIn: null,
  note: '',
  createdAt: 1,
  updatedAt: 1,
})

const store = (items: ReviewQueueItem[]): ReviewQueueStore => ({ version: 1, items })

describe('parseReportIssues', () => {
  it('extracts severity-marked lines and strips markers', () => {
    const report = [
      '# Report',
      '',
      '- 🔴 Name drift: "Aria" vs "Ari"',
      '- 🟡 Timeline conflict in chapter 3',
      '- 严重: 魔法体系矛盾',
      '2. Moderate: pacing issue',
      '',
      '- normal bullet without marker',
    ].join('\n')
    const issues = parseReportIssues(report)
    expect(issues).toEqual([
      { severity: 'critical', text: 'Name drift: "Aria" vs "Ari"', docIds: [] },
      { severity: 'moderate', text: 'Timeline conflict in chapter 3', docIds: [] },
      { severity: 'critical', text: '魔法体系矛盾', docIds: [] },
      { severity: 'moderate', text: 'pacing issue', docIds: [] },
    ])
  })

  it('captures valid doc IDs attributed by the report and strips the annotation', () => {
    const report = [
      '- 🔴 Name drift (docs: character/ari.md)',
      '- 🟡 Timeline conflict [[worldview/magic.md]] [[character/ari.md]]',
      '- 🔴 unknown doc (docs: ghost/ghost.md)',
      '- 🟢 minor [character/ari.md] trailing',
      '- 🔴 法则矛盾 (docs: 世界观/法则.md)',
    ].join('\n')
    const valid = new Set(['character/ari.md', 'worldview/magic.md', '世界观/法则.md'])
    const issues = parseReportIssues(report, valid)
    expect(issues[0].docIds).toEqual(['character/ari.md'])
    expect(issues[0].text).toBe('Name drift')
    // [[...]] 与 [id] 形式也能提取并剥离。
    expect(issues[1].docIds).toEqual(['worldview/magic.md', 'character/ari.md'])
    expect(issues[1].text).toBe('Timeline conflict')
    // 无效 ID 被丢弃。
    expect(issues[2].docIds).toEqual([])
    expect(issues[3].docIds).toEqual(['character/ari.md'])
    expect(issues[3].text).toBe('minor trailing')
    // 中文文件名 ID 也能提取。
    expect(issues[4].docIds).toEqual(['世界观/法则.md'])
    expect(issues[4].text).toBe('法则矛盾')
  })

  it('handles empty and marker-free reports', () => {
    expect(parseReportIssues('')).toEqual([])
    expect(parseReportIssues('# All clear\n\nNo issues found.')).toEqual([])
  })
})

describe('buildReviewItemsFromReport', () => {
  it('creates open items with the report back-link', () => {
    const items = buildReviewItemsFromReport(
      { id: 'c_1', label: '08/12 14:30', content: '- 🔴 broken name\n- 🟢 minor doubt' },
      undefined,
      1000,
    )
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      reportId: 'c_1',
      reportLabel: '08/12 14:30',
      severity: 'critical',
      status: 'open',
      relatedDocIds: [],
      fixedIn: null,
      createdAt: 1000,
    })
    expect(items[0].id).toMatch(/^rq_/)
  })

  it('carries attributed doc IDs into the items', () => {
    const items = buildReviewItemsFromReport(
      { id: 'c_1', label: '08/12 14:30', content: '- 🔴 broken name (docs: character/ari.md)' },
      new Set(['character/ari.md']),
      1000,
    )
    expect(items[0].relatedDocIds).toEqual(['character/ari.md'])
  })
})

describe('applyReviewItemStatus', () => {
  it('allows the happy-path chain open -> fixing -> verified -> resolved', () => {
    const s = store([item('a'), item('b', 'fixing'), item('c', 'verified')])
    const r1 = applyReviewItemStatus(s, new Set(['a']), 'fixing', 5)
    expect(r1.changed).toBe(1)
    expect(r1.store.items.find((i) => i.id === 'a')?.status).toBe('fixing')
    expect(r1.store.items.find((i) => i.id === 'a')?.updatedAt).toBe(5)

    const r2 = applyReviewItemStatus(r1.store, new Set(['a', 'b']), 'verified', 6)
    expect(r2.changed).toBe(2)
    expect(r2.store.items.every((i) => i.status === 'verified')).toBe(true)

    const r3 = applyReviewItemStatus(r2.store, new Set(['a', 'b', 'c']), 'resolved', 7)
    expect(r3.changed).toBe(3)
    expect(r3.store.items.every((i) => i.status === 'resolved')).toBe(true)
  })

  it('rejects disallowed transitions and no-ops on same status', () => {
    const s = store([item('a', 'fixing'), item('b', 'verified'), item('c', 'resolved')])
    // fixing -> open and verified -> fixing are invalid; resolved -> open invalid? no, allowed.
    const result = applyReviewItemStatus(s, new Set(['a', 'b', 'c']), 'open', 5)
    expect(result.changed).toBe(1) // only c: resolved -> open (reopen)
    expect(result.skipped).toBe(2) // a, b rejected
    expect(result.store.items.find((i) => i.id === 'a')?.status).toBe('fixing')
    expect(result.store.items.find((i) => i.id === 'b')?.status).toBe('verified')
    expect(result.store.items.find((i) => i.id === 'c')?.status).toBe('open')

    const same = applyReviewItemStatus(s, new Set(['a']), 'fixing')
    expect(same.changed).toBe(0)
    expect(same.skipped).toBe(1)
  })

  it('clears fixedIn when a resolved item is reopened', () => {
    const fixed = {
      ...item('a', 'resolved'),
      fixedIn: { kind: 'doc' as const, id: 'x.md', title: 'X' },
    }
    const next = applyReviewItemStatus(store([fixed]), new Set(['a']), 'open', 6)
    expect(next.store.items[0].status).toBe('open')
    expect(next.store.items[0].fixedIn).toBeNull()
  })

  it('markReviewItemFixed only affects actionable (open/fixing) items', () => {
    const s = store([item('a', 'verified'), item('b', 'open')])
    const next = markReviewItemFixed(s, 'a', { kind: 'doc', id: 'x.md', title: 'X' }, 7)
    // verified 不能被修复动作回退到 fixing。
    expect(next.items.find((i) => i.id === 'a')?.status).toBe('verified')
    expect(next.items.find((i) => i.id === 'a')?.fixedIn).toBeNull()
    const next2 = markReviewItemFixed(s, 'b', { kind: 'doc', id: 'x.md', title: 'X' }, 7)
    expect(next2.items.find((i) => i.id === 'b')?.status).toBe('fixing')
  })
})

describe('markReviewItemFixed / removeReviewItems / countOpenReviewItems', () => {
  it('backfills the fixed target and switches to fixing', () => {
    const s = store([item('a')])
    const next = markReviewItemFixed(
      s,
      'a',
      { kind: 'doc', id: 'character/ari.md', title: 'Ari' },
      9,
    )
    expect(next.items[0]).toMatchObject({
      status: 'fixing',
      fixedIn: { kind: 'doc', id: 'character/ari.md', title: 'Ari' },
      updatedAt: 9,
    })
  })

  it('removes selected items and counts open ones', () => {
    const s = store([item('a', 'open'), item('b', 'resolved'), item('c', 'open')])
    expect(countOpenReviewItems(s)).toBe(2)
    const after = removeReviewItems(s, new Set(['a', 'b']))
    expect(after.items.map((i) => i.id)).toEqual(['c'])
    expect(countOpenReviewItems(after)).toBe(1)
  })
})

describe('buildManualReviewItem', () => {
  it('creates an author-added item without a report link', () => {
    const item = buildManualReviewItem({ text: '  Forgot the key rule  ', severity: 'critical' }, 5)
    expect(item).toMatchObject({
      reportId: null,
      reportLabel: '',
      severity: 'critical',
      text: 'Forgot the key rule',
      relatedDocIds: [],
      status: 'open',
      createdAt: 5,
    })
  })
})

describe('isReviewQueueItem', () => {
  it('accepts valid items and rejects malformed ones', () => {
    expect(isReviewQueueItem(item('a'))).toBe(true)
    expect(isReviewQueueItem(null)).toBe(false)
    expect(isReviewQueueItem({ ...item('a'), severity: 'nope' })).toBe(false)
    expect(isReviewQueueItem({ ...item('a'), status: 'nope' })).toBe(false)
    expect(isReviewQueueItem({ ...item('a'), text: 42 })).toBe(false)
  })
})
