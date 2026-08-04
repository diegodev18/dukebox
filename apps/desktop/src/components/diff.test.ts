import { describe, expect, it } from 'vitest'
import { diffLines } from './Diff.js'

const kinds = (before: string, after: string) => diffLines(before, after).map((line) => line.kind)
const texts = (before: string, after: string) => diffLines(before, after).map((line) => line.text)

describe('whole-file changes', () => {
  it('marks every line added when the file is new', () => {
    expect(kinds('', 'one\ntwo')).toEqual(['added', 'added'])
  })

  it('marks every line removed when the file is deleted', () => {
    expect(kinds('one\ntwo', '')).toEqual(['removed', 'removed'])
  })

  it('has nothing to show for an empty file that stayed empty', () => {
    expect(diffLines('', '')).toEqual([])
  })
})

describe('line changes', () => {
  it('finds the one line that changed', () => {
    const result = diffLines('a\nb\nc', 'a\nB\nc')

    expect(result).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'added', text: 'B' },
      { kind: 'same', text: 'c' },
    ])
  })

  it('reports an insertion without rewriting what surrounds it', () => {
    // A naive line-by-line comparison marks everything after an insertion as
    // changed. That is the difference between a readable diff and a useless one.
    expect(kinds('a\nb', 'a\nnew\nb')).toEqual(['same', 'added', 'same'])
  })

  it('reports a deletion in the middle', () => {
    expect(kinds('a\ngone\nb', 'a\nb')).toEqual(['same', 'removed', 'same'])
  })

  it('collapses a file with no changes to a single summary', () => {
    // With nothing changed there is no context to anchor, so the whole file
    // becomes one line saying so rather than a copy of itself.
    expect(diffLines('a\nb\nc', 'a\nb\nc')).toEqual([{ kind: 'same', text: '⋯ 3 unchanged lines' }])
  })
})

describe('collapsing context', () => {
  it('keeps a short file whole', () => {
    const result = diffLines('a\nb\nc', 'a\nB\nc')
    expect(result.some((line) => line.text.startsWith('⋯'))).toBe(false)
  })

  it('hides long runs of unchanged lines', () => {
    // Scrolling twenty identical lines to find one edit is searching, not
    // reviewing.
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
    const after = before.replace('line 10', 'CHANGED')
    const result = texts(before, after)

    expect(result.some((text) => text.startsWith('⋯'))).toBe(true)
    expect(result.length).toBeLessThan(20)
  })

  it('keeps context on both sides of a change', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
    const after = before.replace('line 10', 'CHANGED')
    const result = texts(before, after)

    expect(result).toContain('line 9')
    expect(result).toContain('CHANGED')
    expect(result).toContain('line 11')
  })

  it('counts what it hid', () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')
    const after = `${before}\nappended`
    const summary = texts(before, after).find((text) => text.startsWith('⋯'))

    expect(summary).toMatch(/\d+ unchanged lines/)
  })

  it('says "line" rather than "lines" for a single one', () => {
    // Nine lines with the first and last changed: three of context reaches in
    // from each side, leaving exactly the middle one hidden.
    const lines = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']
    const before = lines.join('\n')
    const after = ['CHANGED', ...lines.slice(1, -1), 'ALSO'].join('\n')
    const summary = texts(before, after).find((text) => text.startsWith('⋯'))

    expect(summary).toBe('⋯ 1 unchanged line')
  })
})

describe('large files', () => {
  it('falls back to a replacement rather than freezing the window', () => {
    // The LCS table is quadratic. A diff nobody can read is not worth a
    // dropped frame.
    const before = Array.from({ length: 1600 }, (_, i) => `a ${i}`).join('\n')
    const after = Array.from({ length: 1600 }, (_, i) => `b ${i}`).join('\n')
    const result = diffLines(before, after)

    expect(result).toHaveLength(3200)
    expect(result[0]).toEqual({ kind: 'removed', text: 'a 0' })
    expect(result.at(-1)).toEqual({ kind: 'added', text: 'b 1599' })
  })
})
