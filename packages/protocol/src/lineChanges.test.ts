import { describe, expect, it } from 'vitest'
import { MAX_LCS_LINES, alignLines, countLineChanges } from '@/lineChanges'

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
    expect(alignLines(before, after).simplified).toBe(true)
  })

  it('counts the real edit in a large file instead of rewriting it', () => {
    // A 1900-line test file with twenty new cases used to badge as
    // +1900 −1880 because the LCS table gave up. GitHub still showed the
    // twenty lines. The pull request preview has to match that.
    const before = Array.from({ length: 1882 }, (_, i) => `line ${i}`).join('\n')
    const after = [
      ...Array.from({ length: 900 }, (_, i) => `line ${i}`),
      ...Array.from({ length: 20 }, (_, i) => `added ${i}`),
      ...Array.from({ length: 982 }, (_, i) => `line ${900 + i}`),
    ].join('\n')

    expect(countLineChanges(before, after)).toEqual({ added: 20, removed: 0 })
    expect(alignLines(before, after).simplified).toBe(false)
  })

  it('counts scattered edits in a large file', () => {
    const lines = Array.from({ length: 1800 }, (_, i) => `line ${i}`)
    const after = [...lines]
    after[10] = 'CHANGED top'
    after[1700] = 'CHANGED bottom'

    expect(countLineChanges(lines.join('\n'), after.join('\n'))).toEqual({
      added: 2,
      removed: 2,
    })
  })

  it('counts twenty new cases in a large test file full of duplicate lines', () => {
    // manager.test.ts in the screenshot: ~1900 lines, twenty added, GitHub
    // showed +20. Unique `line ${i}` fixtures hide that a real test file is
    // mostly `  })` and `expect(...)` — those still have to align.
    const names = Array.from({ length: 280 }, (_, i) => `does thing ${i}`)
    const extra = Array.from({ length: 20 }, (_, i) => `forwards attached files ${i}`)
    const before = vitestFile(names)
    const after = vitestFile([...names.slice(0, 80), ...extra, ...names.slice(80)])

    expect(countLineChanges(before, after)).toEqual({ added: 100, removed: 0 })
    expect(alignLines(before, after).simplified).toBe(false)
  })

  it('ignores CR so a checkout does not rewrite every line', () => {
    expect(countLineChanges('a\r\nb\r\nc', 'a\nb\nC')).toEqual({ added: 1, removed: 1 })
    expect(alignLines('a\r\nb\r\nc', 'a\nb\nC').simplified).toBe(false)
  })
})

/** A Vitest file whose bodies repeat, the way a 1900-line suite does. */
function vitestFile(cases: readonly string[]): string {
  const tests = cases
    .map(
      (name) =>
        `  it('${name}', async () => {\n    const running = await start()\n    expect(running).toBeTruthy()\n  })`,
    )
    .join('\n\n')
  return `import { describe, expect, it } from 'vitest'\n\ndescribe('suite', () => {\n${tests}\n})\n`
}
