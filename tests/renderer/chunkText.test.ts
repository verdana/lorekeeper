import { describe, expect, it } from 'vitest'
import { chunkText } from '../../src/renderer/src/chunkText'

describe('chunkText', () => {
  it('returns the text as one chunk when it fits', () => {
    expect(chunkText('abc', 10)).toEqual(['abc'])
  })

  it('returns an empty list for empty input', () => {
    expect(chunkText('', 10)).toEqual([])
  })

  it('splits at paragraph boundaries, keeping each chunk within the cap', () => {
    const text = 'AAAA\n\nBBBB\n\nCCCC'
    const chunks = chunkText(text, 10)
    expect(chunks).toEqual(['AAAA\n\nBBBB', '\n\nCCCC'])
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(10)
  })

  it('reconstructs the original text losslessly when chunks are rejoined', () => {
    const text = '一二三。\n\n四五。\n\n六七。\n\n八九。'
    const chunks = chunkText(text, 8)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe(text)
  })

  it('never emits a chunk larger than the cap', () => {
    const text = '段'.repeat(100) + '\n\n' + '落'.repeat(100)
    const chunks = chunkText(text, 40)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(40)
    expect(chunks.join('')).toBe(text)
  })

  it('hard-splits an oversized single paragraph', () => {
    const long = 'x'.repeat(25)
    expect(chunkText(long, 10)).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)])
  })

  it('keeps a non-blank-line paragraph boundary as one unit when possible', () => {
    // Single newline (not blank-line) separators are kept inside paragraphs.
    const text = 'AAA\nBBB\nCCC'
    expect(chunkText(text, 20)).toEqual([text])
    expect(chunkText(text, 8)).toEqual(['AAA\nBBB\n', 'CCC'])
  })
})
