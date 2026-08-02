// Persistent Review Queue: pure helpers shared by the renderer and tests.
// The queue turns one-off consistency reports into durable, trackable
// review items with explicit author-controlled state transitions.

import type {
  ReviewItemSeverity,
  ReviewItemStatus,
  ReviewQueueItem,
  ReviewQueueStore,
} from './types'

/** Severity markers as they appear in consistency report markdown. */
const SEVERITY_ORDER: Record<ReviewItemSeverity, number> = {
  critical: 0,
  moderate: 1,
  unsure: 2,
}

/** Allowed state transitions. Any other move is rejected (skipped). */
export const REVIEW_TRANSITIONS: Record<ReviewItemStatus, ReviewItemStatus[]> = {
  open: ['fixing', 'verified', 'resolved'],
  fixing: ['verified', 'resolved'],
  verified: ['resolved'],
  resolved: ['open'],
}

export const REVIEW_STATUS_ORDER: ReviewItemStatus[] = ['open', 'fixing', 'verified', 'resolved']

export function severityOrder(severity: ReviewItemSeverity): number {
  return SEVERITY_ORDER[severity]
}

/** A single issue line parsed out of a report. */
export interface ReportIssue {
  severity: ReviewItemSeverity
  text: string
  /** Codex document IDs the report attributed to this issue. */
  docIds: string[]
}

function detectSeverity(line: string): ReviewItemSeverity | null {
  if (/🔴|Critical|严重/i.test(line)) return 'critical'
  if (/🟡|Moderate|中等/i.test(line)) return 'moderate'
  if (/🟢|Unsure|存疑/i.test(line)) return 'unsure'
  return null
}

/** Strip list markers and the severity prefix from an issue line. */
function cleanIssueLine(line: string): string {
  return line
    .replace(/^[-*+]\s*/, '')
    .replace(/^\d+[.)]\s*/, '')
    .replace(/^(🔴|🟡|🟢)\s*/, '')
    .replace(/^(Critical|Moderate|Unsure|严重|中等|存疑)\s*[:：-]?\s*/i, '')
    .trim()
}

/**
 * Parse a consistency report's markdown into candidate issues. Only lines
 * carrying a severity marker are kept; the marker and list syntax are
 * stripped so the item text is the actionable statement. When a set of
 * valid document IDs is given, any doc ID appearing on the issue line is
 * captured as the issue's related documents (the AI attributes them via
 * the report format, e.g. "- 🔴 <issue> (docs: character/ari.md)").
 */
export function parseReportIssues(
  report: string,
  validDocIds?: ReadonlySet<string>,
): ReportIssue[] {
  const issues: ReportIssue[] = []
  for (const raw of report.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const severity = detectSeverity(line)
    if (!severity) continue
    // 匹配非空白/括号/引号的连续串 + .md 后缀(支持中文文件名),再过滤有效 ID。
    const docIds = validDocIds
      ? Array.from(
          new Set(
            (line.match(/[^\s(),;:\[\]"']+\.md\b/gu) ?? []).filter((id) => validDocIds.has(id)),
          ),
        )
      : []
    // 剥离行内的 [[docId]] / [docId] 与行尾的 (docs: ...) 标注,
    // 文档信息单独存于 docIds,不污染 issue 正文。
    const text = cleanIssueLine(line)
      .replace(/\[\[?[^[\]()\s]+\.md\]\]?/gi, '')
      .replace(/\s*\(docs?:[^)]*\)\s*$/i, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 400)
    if (!text) continue
    issues.push({ severity, text, docIds })
  }
  return issues
}

const newReviewItemId = (): string =>
  `rq_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

/** Build open review items from a report. Report content is parsed once. */
export function buildReviewItemsFromReport(
  report: { id: string | null; label: string; content: string },
  validDocIds?: ReadonlySet<string>,
  now = Date.now(),
): ReviewQueueItem[] {
  return parseReportIssues(report.content, validDocIds).map((issue) => ({
    id: newReviewItemId(),
    reportId: report.id,
    reportLabel: report.label,
    severity: issue.severity,
    text: issue.text,
    relatedDocIds: issue.docIds,
    status: 'open',
    fixedIn: null,
    note: '',
    createdAt: now,
    updatedAt: now,
  }))
}

/** Create a single manually-added review item. */
export function buildManualReviewItem(
  input: {
    text: string
    severity: ReviewItemSeverity
    note?: string
    relatedDocIds?: string[]
  },
  now = Date.now(),
): ReviewQueueItem {
  return {
    id: newReviewItemId(),
    reportId: null,
    reportLabel: '',
    severity: input.severity,
    text: input.text.trim().slice(0, 400),
    relatedDocIds: input.relatedDocIds ?? [],
    status: 'open',
    fixedIn: null,
    note: input.note?.trim() ?? '',
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * Apply a status change to the selected items, enforcing the transition
 * table. Returns how many changed and how many were skipped (already in the
 * target status, or a disallowed transition). Reopening a resolved item
 * clears its fixedIn back-link, since the previous fix no longer stands.
 */
export function applyReviewItemStatus(
  store: ReviewQueueStore,
  selectedIds: ReadonlySet<string>,
  status: ReviewItemStatus,
  now = Date.now(),
): { store: ReviewQueueStore; changed: number; skipped: number } {
  let changed = 0
  let skipped = 0
  const items = store.items.map((item) => {
    if (!selectedIds.has(item.id)) return item
    if (item.status === status) {
      skipped++
      return item
    }
    if (!REVIEW_TRANSITIONS[item.status].includes(status)) {
      skipped++
      return item
    }
    changed++
    return {
      ...item,
      status,
      fixedIn: status === 'open' ? null : item.fixedIn,
      updatedAt: now,
    }
  })
  return { store: { ...store, items }, changed, skipped }
}

/**
 * Backfill the fixed target after a fix has been applied. Only moves an
 * item that is still actionable (open/fixing) into 'fixing'; anything
 * already resolved/verified is left untouched.
 */
export function markReviewItemFixed(
  store: ReviewQueueStore,
  id: string,
  fixedIn: { kind: 'doc' | 'chapter'; id: string; title: string },
  now = Date.now(),
): ReviewQueueStore {
  return {
    ...store,
    items: store.items.map((item) =>
      item.id === id && (item.status === 'open' || item.status === 'fixing')
        ? { ...item, fixedIn, status: 'fixing', updatedAt: now }
        : item,
    ),
  }
}

const REVIEW_SEVERITIES = new Set<ReviewItemSeverity>(['critical', 'moderate', 'unsure'])
const REVIEW_STATUSES = new Set<ReviewItemStatus>(['open', 'fixing', 'verified', 'resolved'])

/** Guard used when loading the queue file: drop malformed/hand-edited items. */
export function isReviewQueueItem(value: unknown): value is ReviewQueueItem {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.id === 'string' &&
    (typeof v.reportId === 'string' || v.reportId === null) &&
    typeof v.reportLabel === 'string' &&
    typeof v.text === 'string' &&
    REVIEW_SEVERITIES.has(v.severity as ReviewItemSeverity) &&
    REVIEW_STATUSES.has(v.status as ReviewItemStatus) &&
    (v.relatedDocIds === undefined ||
      (Array.isArray(v.relatedDocIds) &&
        (v.relatedDocIds as unknown[]).every((id) => typeof id === 'string')))
  )
}

/** Remove items by id. */
export function removeReviewItems(
  store: ReviewQueueStore,
  ids: ReadonlySet<string>,
): ReviewQueueStore {
  return { ...store, items: store.items.filter((item) => !ids.has(item.id)) }
}

/** Count active (not resolved) items per severity, for badges. */
export function countOpenReviewItems(store: ReviewQueueStore): number {
  return store.items.filter((item) => item.status !== 'resolved').length
}
