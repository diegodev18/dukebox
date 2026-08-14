import { describe, expect, it } from 'vitest'
import { MAX_LCS_LINES, countLineChanges } from '@/lineChanges'

describe('countLineChanges', () => {
  it('counts a created file by its line count', () => {
    expect(countLineChanges(null, 'one\ntwo')).toEqual({ added: 2, removed: 0 })
  })

  it('counts a deleted file by its line count', () => {
    expect(countLineChanges('one\ntwo', null)).toEqual({ added: 0, removed: 2 })
  })

  it('counts an LCS edit', () => {
    expect(countLineChanges('a\nb\nc', 'a\nB\nc')).toEqual({ added: 1, removed: 1 })
  })

  it('treats empty strings as no lines', () => {
    expect(countLineChanges('', '')).toEqual({ added: 0, removed: 0 })
  })

  it('counts a simplified replacement past the LCS cap', () => {
    const before = Array.from({ length: MAX_LCS_LINES + 1 }, (_, i) => `a ${i}`).join('\n')
    const after = Array.from({ length: MAX_LCS_LINES + 1 }, (_, i) => `b ${i}`).join('\n')
    expect(countLineChanges(before, after)).toEqual({
      added: MAX_LCS_LINES + 1,
      removed: MAX_LCS_LINES + 1,
    })
  })
})
