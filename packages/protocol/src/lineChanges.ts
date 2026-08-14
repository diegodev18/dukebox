/**
 * Added and removed line counts for a before/after pair.
 *
 * The desktop badges need this on every file row. Computing it once when the
 * event is folded — rather than walking an LCS diff on every React render —
 * is what keeps the Changes list cheap while a turn is still streaming.
 *
 * A full LCS table is quadratic. Gaps past `MAX_LCS_LINES` are split on
 * unique matching lines so a large similar file still gets a real diff
 * instead of a full-file replacement.
 */

export const MAX_LCS_LINES = 1500

export type AlignedKind = 'added' | 'removed' | 'same'

export interface AlignedLine {
  kind: AlignedKind
  text: string
  oldLine: number | null
  newLine: number | null
}

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
  if (before === after) return { added: 0, removed: 0 }

  let added = 0
  let removed = 0
  for (const line of alignLines(before, after).lines) {
    if (line.kind === 'added') added += 1
    else if (line.kind === 'removed') removed += 1
  }
  return { added, removed }
}

/**
 * Line-by-line alignment of two file bodies.
 *
 * `simplified` is true only when a remaining gap was too large to LCS and had
 * no unique anchors — a real rewrite, not "the file has many lines".
 */
export function alignLines(
  before: string,
  after: string,
): { lines: AlignedLine[]; simplified: boolean } {
  return alignRange(linesOf(before), linesOf(after), 0, 0)
}

function alignRange(
  a: readonly string[],
  b: readonly string[],
  aOff: number,
  bOff: number,
): { lines: AlignedLine[]; simplified: boolean } {
  if (a.length === 0) {
    return {
      lines: b.map((text, index) => ({
        kind: 'added' as const,
        text,
        oldLine: null,
        newLine: bOff + index + 1,
      })),
      simplified: false,
    }
  }
  if (b.length === 0) {
    return {
      lines: a.map((text, index) => ({
        kind: 'removed' as const,
        text,
        oldLine: aOff + index + 1,
        newLine: null,
      })),
      simplified: false,
    }
  }

  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1

  let suffix = 0
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const head = a.slice(0, prefix).map((text, index) => ({
    kind: 'same' as const,
    text,
    oldLine: aOff + index + 1,
    newLine: bOff + index + 1,
  }))
  const tail = a.slice(a.length - suffix).map((text, index) => ({
    kind: 'same' as const,
    text,
    oldLine: aOff + a.length - suffix + index + 1,
    newLine: bOff + b.length - suffix + index + 1,
  }))

  const aMid = a.slice(prefix, a.length - suffix)
  const bMid = b.slice(prefix, b.length - suffix)
  const midOffA = aOff + prefix
  const midOffB = bOff + prefix

  if (aMid.length === 0 || bMid.length === 0) {
    const mid = alignRange(aMid, bMid, midOffA, midOffB)
    return { lines: [...head, ...mid.lines, ...tail], simplified: mid.simplified }
  }

  if (aMid.length <= MAX_LCS_LINES && bMid.length <= MAX_LCS_LINES) {
    return {
      lines: [...head, ...lcsAlign(aMid, bMid, midOffA, midOffB), ...tail],
      simplified: false,
    }
  }

  const anchors = uniqueAnchors(aMid, bMid)
  if (anchors.length === 0) {
    return {
      lines: [...head, ...replacement(aMid, bMid, midOffA, midOffB), ...tail],
      simplified: true,
    }
  }

  const lines: AlignedLine[] = [...head]
  let simplified = false
  let ai = 0
  let bi = 0

  for (const { i, j } of anchors) {
    const gap = alignRange(aMid.slice(ai, i), bMid.slice(bi, j), midOffA + ai, midOffB + bi)
    lines.push(...gap.lines)
    simplified = simplified || gap.simplified
    lines.push({
      kind: 'same',
      text: aMid[i]!,
      oldLine: midOffA + i + 1,
      newLine: midOffB + j + 1,
    })
    ai = i + 1
    bi = j + 1
  }

  const last = alignRange(aMid.slice(ai), bMid.slice(bi), midOffA + ai, midOffB + bi)
  lines.push(...last.lines, ...tail)
  return { lines, simplified: simplified || last.simplified }
}

function lcsAlign(
  a: readonly string[],
  b: readonly string[],
  aOff: number,
  bOff: number,
): AlignedLine[] {
  // lengths[i][j] is the LCS length of a[i:] and b[j:]. Built backwards so the
  // walk below can emit lines in order.
  const lengths: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  )

  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lengths[i]![j] =
        a[i] === b[j]
          ? lengths[i + 1]![j + 1]! + 1
          : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!)
    }
  }

  const lines: AlignedLine[] = []
  let i = 0
  let j = 0

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({
        kind: 'same',
        text: a[i]!,
        oldLine: aOff + i + 1,
        newLine: bOff + j + 1,
      })
      i += 1
      j += 1
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) {
      lines.push({
        kind: 'removed',
        text: a[i]!,
        oldLine: aOff + i + 1,
        newLine: null,
      })
      i += 1
    } else {
      lines.push({
        kind: 'added',
        text: b[j]!,
        oldLine: null,
        newLine: bOff + j + 1,
      })
      j += 1
    }
  }

  while (i < a.length) {
    lines.push({
      kind: 'removed',
      text: a[i]!,
      oldLine: aOff + i + 1,
      newLine: null,
    })
    i += 1
  }
  while (j < b.length) {
    lines.push({
      kind: 'added',
      text: b[j]!,
      oldLine: null,
      newLine: bOff + j + 1,
    })
    j += 1
  }

  return lines
}

function replacement(
  a: readonly string[],
  b: readonly string[],
  aOff: number,
  bOff: number,
): AlignedLine[] {
  return [
    ...a.map((text, index) => ({
      kind: 'removed' as const,
      text,
      oldLine: aOff + index + 1,
      newLine: null,
    })),
    ...b.map((text, index) => ({
      kind: 'added' as const,
      text,
      oldLine: null,
      newLine: bOff + index + 1,
    })),
  ]
}

/**
 * Lines that appear once on each side, in increasing order on both.
 *
 * Those are safe anchors: the same unique line cannot have been both moved
 * and duplicated, so the gaps between them can be aligned independently.
 */
function uniqueAnchors(a: readonly string[], b: readonly string[]): { i: number; j: number }[] {
  const countA = new Map<string, number>()
  const countB = new Map<string, number>()
  for (const line of a) countA.set(line, (countA.get(line) ?? 0) + 1)
  for (const line of b) countB.set(line, (countB.get(line) ?? 0) + 1)

  const posB = new Map<string, number>()
  for (let j = 0; j < b.length; j += 1) {
    const line = b[j]!
    if (countA.get(line) === 1 && countB.get(line) === 1) posB.set(line, j)
  }

  const matches: { i: number; j: number }[] = []
  for (let i = 0; i < a.length; i += 1) {
    const j = posB.get(a[i]!)
    if (j !== undefined) matches.push({ i, j })
  }

  return lisByJ(matches)
}

function lisByJ(matches: { i: number; j: number }[]): { i: number; j: number }[] {
  if (matches.length === 0) return []

  const tails: number[] = []
  const prev = new Array<number>(matches.length).fill(-1)

  for (let index = 0; index < matches.length; index += 1) {
    const value = matches[index]!.j
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (matches[tails[mid]!]!.j < value) lo = mid + 1
      else hi = mid
    }
    if (lo > 0) prev[index] = tails[lo - 1]!
    tails[lo] = index
  }

  const out: { i: number; j: number }[] = []
  for (let index = tails[tails.length - 1]!; index >= 0; index = prev[index]!) {
    out.push(matches[index]!)
  }
  return out.reverse()
}

function linesOf(value: string): string[] {
  if (value === '') return []
  // `git show` and working-tree `cat` can disagree on CR. GitHub does not.
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
}

function lineCount(value: string): number {
  return linesOf(value).length
}
