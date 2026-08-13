/**
 * Added and removed line counts for a before/after pair.
 *
 * The desktop badges need this on every file row. Computing it once when the
 * event is folded — rather than walking an LCS diff on every React render —
 * is what keeps the Changes list cheap while a turn is still streaming.
 *
 * LCS is quadratic, so files past a size count as a straight replacement,
 * matching the simplified diff the UI draws.
 */

export const MAX_LCS_LINES = 1500

export function countLineChanges(
  before: string | null,
  after: string | null,
): { added: number; removed: number } {
  if (before === null) {
    return { added: after ? lineCount(after) : 0, removed: 0 }
  }
  if (after === null) {
    return { added: 0, removed: before ? lineCount(before) : 0 }
  }

  const a = linesOf(before)
  const b = linesOf(after)

  if (a.length === 0) return { added: b.length, removed: 0 }
  if (b.length === 0) return { added: 0, removed: a.length }
  if (before === after) return { added: 0, removed: 0 }

  if (a.length > MAX_LCS_LINES || b.length > MAX_LCS_LINES) {
    return { added: b.length, removed: a.length }
  }

  const lcs = lcsLength(a, b)
  return { added: b.length - lcs, removed: a.length - lcs }
}

function linesOf(value: string): string[] {
  return value === '' ? [] : value.split('\n')
}

function lineCount(value: string): number {
  return linesOf(value).length
}

/** LCS length of `a` and `b`. Two rolling rows rather than the full matrix. */
function lcsLength(a: readonly string[], b: readonly string[]): number {
  let prev = new Array<number>(b.length + 1).fill(0)
  let curr = new Array<number>(b.length + 1).fill(0)

  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      curr[j] = a[i] === b[j] ? prev[j + 1]! + 1 : Math.max(prev[j]!, curr[j + 1]!)
    }
    const swap = prev
    prev = curr
    curr = swap
    curr.fill(0)
  }

  return prev[0]!
}
