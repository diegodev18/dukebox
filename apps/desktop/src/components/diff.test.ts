import { describe, expect, it } from 'vitest'
import { changeCounts, diffLines, isSimplifiedDiff, skipLabel } from '@/components/Diff'

const kinds = (before: string, after: string) => diffLines(before, after).map((line) => line.kind)
const texts = (before: string, after: string) =>
  diffLines(before, after).map((line) => (line.kind === 'skip' ? skipLabel(line.count) : line.text))

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
      { kind: 'same', text: 'a', oldLine: 1, newLine: 1 },
      { kind: 'removed', text: 'b', oldLine: 2, newLine: null },
      { kind: 'added', text: 'B', oldLine: null, newLine: 2 },
      { kind: 'same', text: 'c', oldLine: 3, newLine: 3 },
    ])
  })

  it('reports an insertion without rewriting what surrounds it', () => {
    // A naive line-by-line comparison marks everything after an insertion as
    // changed. That is the difference between a readable diff and a useless one.
    expect(kinds('a\nb', 'a\nnew\nb')).toEqual(['same', 'added', 'same'])
  })

  it('numbers an insertion against the new file only', () => {
    expect(diffLines('a\nb', 'a\nnew\nb')).toEqual([
      { kind: 'same', text: 'a', oldLine: 1, newLine: 1 },
      { kind: 'added', text: 'new', oldLine: null, newLine: 2 },
      { kind: 'same', text: 'b', oldLine: 2, newLine: 3 },
    ])
  })

  it('reports a deletion in the middle', () => {
    expect(kinds('a\ngone\nb', 'a\nb')).toEqual(['same', 'removed', 'same'])
  })

  it('collapses a file with no changes to a single summary', () => {
    // With nothing changed there is no context to anchor, so the whole file
    // becomes one line saying so rather than a copy of itself.
    expect(diffLines('a\nb\nc', 'a\nb\nc')).toEqual([
      {
        kind: 'skip',
        count: 3,
        hidden: [
          { kind: 'same', text: 'a', oldLine: 1, newLine: 1 },
          { kind: 'same', text: 'b', oldLine: 2, newLine: 2 },
          { kind: 'same', text: 'c', oldLine: 3, newLine: 3 },
        ],
      },
    ])
  })
})

describe('collapsing context', () => {
  it('keeps a short file whole', () => {
    const result = diffLines('a\nb\nc', 'a\nB\nc')
    expect(result.some((line) => line.kind === 'skip')).toBe(false)
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

  it('keeps the hidden lines so a skip can be expanded', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
    const after = before.replace('line 10', 'CHANGED')
    const skip = diffLines(before, after).find((line) => line.kind === 'skip')

    expect(skip?.kind).toBe('skip')
    if (skip?.kind !== 'skip') return
    expect(skip.hidden.map((line) => line.text)).toContain('line 0')
    expect(skip.count).toBe(skip.hidden.length)
    expect(skip.hidden[0]).toMatchObject({ kind: 'same', oldLine: 1, newLine: 1 })
  })
})

describe('large files', () => {
  it('falls back to a replacement rather than freezing the window', () => {
    // Two unrelated 1600-line files have nothing unique in common, so the
    // table never runs. A rewrite is the honest picture.
    const before = Array.from({ length: 1600 }, (_, i) => `a ${i}`).join('\n')
    const after = Array.from({ length: 1600 }, (_, i) => `b ${i}`).join('\n')
    const result = diffLines(before, after)

    expect(result).toHaveLength(3200)
    expect(result[0]).toEqual({ kind: 'removed', text: 'a 0', oldLine: 1, newLine: null })
    expect(result.at(-1)).toEqual({ kind: 'added', text: 'b 1599', oldLine: null, newLine: 1600 })
    expect(isSimplifiedDiff(before, after)).toBe(true)
  })

  it('does not flag a small file as simplified', () => {
    expect(isSimplifiedDiff('a\nb', 'a\nB')).toBe(false)
  })

  it('keeps a large similar file as a real hunk, not a rewrite', () => {
    const before = Array.from({ length: 1882 }, (_, i) => `line ${i}`).join('\n')
    const after = [
      ...Array.from({ length: 900 }, (_, i) => `line ${i}`),
      ...Array.from({ length: 20 }, (_, i) => `added ${i}`),
      ...Array.from({ length: 982 }, (_, i) => `line ${900 + i}`),
    ].join('\n')

    const result = diffLines(before, after)
    const kinds = result.map((line) => line.kind)

    expect(isSimplifiedDiff(before, after)).toBe(false)
    expect(kinds).toContain('skip')
    expect(kinds.filter((kind) => kind === 'added')).toHaveLength(20)
    expect(kinds.filter((kind) => kind === 'removed')).toHaveLength(0)
    expect(texts(before, after)).toContain('added 0')
  })
})

describe('changeCounts', () => {
  it('counts every line of a new file as added', () => {
    expect(changeCounts(null, 'one\ntwo')).toEqual({ added: 2, removed: 0 })
  })

  it('counts every line of a deleted file as removed', () => {
    expect(changeCounts('one\ntwo', null)).toEqual({ added: 0, removed: 2 })
  })

  it('counts only the lines that changed in an edit', () => {
    expect(changeCounts('a\nb\nc', 'a\nB\nc')).toEqual({ added: 1, removed: 1 })
  })
})

describe('skipLabel', () => {
  it('names a range so a collapsed hunk can be placed without opening it', () => {
    expect(skipLabel(19, { start: 1, end: 19 })).toBe('⋯ 19 unchanged lines · 1–19')
  })

  it('uses a single number when the hidden run is one line', () => {
    expect(skipLabel(1, { start: 5, end: 5 })).toBe('⋯ 1 unchanged line · 5')
  })
})
