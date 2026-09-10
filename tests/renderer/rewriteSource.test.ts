import { describe, expect, it } from 'vitest'
import {
  planPolishSource,
  planRewriteSource,
  POLISH_SOURCE_LIMIT,
  REWRITE_SOURCE_LIMIT,
} from '../../src/renderer/src/lib'

/**
 * A rewrite replaces the text it was derived from. These cases pin the
 * invariant that protects the author's prose: whenever the source is longer
 * than the cap, the plan reports `truncated` so the caller refuses to apply
 * the answer instead of inserting a prefix-only rewrite over the whole source.
 */
describe('planRewriteSource', () => {
  it('passes a source within the cap through untouched', () => {
    const source = '马停在山道边。'
    expect(planRewriteSource(source)).toEqual({ target: source, truncated: false })
  })

  it('accepts a source exactly at the cap', () => {
    const source = 'a'.repeat(REWRITE_SOURCE_LIMIT)
    const plan = planRewriteSource(source)
    expect(plan.truncated).toBe(false)
    expect(plan.target).toHaveLength(REWRITE_SOURCE_LIMIT)
  })

  it('flags a source one character past the cap', () => {
    const plan = planRewriteSource('a'.repeat(REWRITE_SOURCE_LIMIT + 1))
    expect(plan.truncated).toBe(true)
    expect(plan.target).toHaveLength(REWRITE_SOURCE_LIMIT)
  })

  it('flags a chapter long enough to lose its tail', () => {
    // The author's chapter 2 is 8,327 characters — over the cap.
    const chapter = '字'.repeat(8327)
    const plan = planRewriteSource(chapter)
    expect(plan.truncated).toBe(true)
    expect(plan.target).toHaveLength(REWRITE_SOURCE_LIMIT)
    expect(chapter.length - plan.target.length).toBe(327)
  })

  it('handles an empty source', () => {
    expect(planRewriteSource('')).toEqual({ target: '', truncated: false })
  })
})

/**
 * Polish revises the text it was given and presents the result as a revision of
 * that text. Its cap is lower than the rewrite cap, so a document between the
 * two limits is polish-blocked while still rewrite-eligible.
 */
describe('planPolishSource', () => {
  it('passes a source within the cap through untouched', () => {
    const source = 'Ari waits by the gate.'
    expect(planPolishSource(source)).toEqual({ target: source, truncated: false })
  })

  it('accepts a source exactly at the cap', () => {
    const plan = planPolishSource('a'.repeat(POLISH_SOURCE_LIMIT))
    expect(plan.truncated).toBe(false)
    expect(plan.target).toHaveLength(POLISH_SOURCE_LIMIT)
  })

  it('flags a document one character past the cap', () => {
    const plan = planPolishSource('a'.repeat(POLISH_SOURCE_LIMIT + 1))
    expect(plan.truncated).toBe(true)
    expect(plan.target).toHaveLength(POLISH_SOURCE_LIMIT)
  })

  it('blocks a document the rewrite cap would still allow', () => {
    const source = 'a'.repeat(POLISH_SOURCE_LIMIT + 1)
    expect(planPolishSource(source).truncated).toBe(true)
    expect(planRewriteSource(source).truncated).toBe(false)
  })

  it('handles an empty source', () => {
    expect(planPolishSource('')).toEqual({ target: '', truncated: false })
  })
})
