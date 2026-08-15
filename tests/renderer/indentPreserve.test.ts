import { describe, expect, it } from 'vitest'
import { applyParagraphIndent } from '../../src/renderer/src/lib'

describe('applyParagraphIndent', () => {
  it('prepends the dominant 4-space indent to every non-empty replacement line', () => {
    const original = '    第一章\n    他推开门。\n    风从走廊尽头灌进来。'
    const replacement = '她走进房间。\n灯还亮着。'
    expect(applyParagraphIndent(original, replacement)).toBe('    她走进房间。\n    灯还亮着。')
  })

  it('leaves lines that already carry the indent untouched (no double indent)', () => {
    const original = '    甲\n    乙'
    const replacement = '    甲\n    丙'
    expect(applyParagraphIndent(original, replacement)).toBe(replacement)
  })

  it('returns the replacement unchanged when the original has no indentation', () => {
    const original = '甲\n乙'
    const replacement = '丙\n丁'
    expect(applyParagraphIndent(original, replacement)).toBe(replacement)
  })

  it('keeps blank lines blank', () => {
    const original = '    甲\n    乙'
    const replacement = '丙\n\n丁'
    expect(applyParagraphIndent(original, replacement)).toBe('    丙\n\n    丁')
  })

  it('prefers the more frequent indent and breaks ties with the longer one', () => {
    const mixed = '  甲\n  乙\n    丙\n    丁'
    // 4 spaces and 2 spaces both appear twice -> longer (4) wins.
    expect(applyParagraphIndent(mixed, '戊')).toBe('    戊')
    const mostlyTwo = '  甲\n  乙\n  丙\n    丁'
    expect(applyParagraphIndent(mostlyTwo, '戊')).toBe('  戊')
  })

  it('handles tabs as the indent convention', () => {
    const original = '\t甲\n\t乙'
    expect(applyParagraphIndent(original, '丙')).toBe('\t丙')
  })

  it('returns an empty replacement unchanged', () => {
    expect(applyParagraphIndent('    甲', '')).toBe('')
  })
})
