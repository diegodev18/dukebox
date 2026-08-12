import type { FileChange } from '@dukebox/protocol'
import { useMemo, useState } from 'react'

/**
 * What changed in a file.
 *
 * A line diff computed here rather than sent by the server: the events carry
 * whole before and after contents, and shipping a rendered diff would mean the
 * app could never change how it displays one without a server release.
 */

export function Diff({ file }: { file: FileChange }) {
  const before = file.before ?? ''
  const after = file.after ?? ''
  const simplified = isSimplifiedDiff(before, after)
  const lines = useMemo(() => diffLines(before, after), [before, after])
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set())

  const toggleSkip = (index: number) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  return (
    <div>
      {simplified && (
        <p className="px-3 py-1.5 text-[12px] text-muted-foreground">
          Diff simplified (file too large)
        </p>
      )}
      {/* Wide enough for its longest line, so the row background spans the full
          scrolled width rather than stopping at the panel edge. */}
      <div className="inline-block min-w-full font-mono text-[12px] leading-[1.55]">
        {lines.map((line, index) =>
          line.kind === 'skip' ? (
            <SkipHunk
              key={index}
              line={line}
              open={expanded.has(index)}
              onToggle={() => toggleSkip(index)}
            />
          ) : (
            <DiffRow key={index} kind={line.kind} text={line.text} />
          ),
        )}
      </div>
    </div>
  )
}

function SkipHunk({
  line,
  open,
  onToggle,
}: {
  line: SkipLine
  open: boolean
  onToggle: () => void
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="block w-full px-1.5 py-0.5 text-left text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        {skipLabel(line.count)}
      </button>
      {open && line.hidden.map((text, index) => <DiffRow key={index} kind="same" text={text} />)}
    </div>
  )
}

function DiffRow({ kind, text }: { kind: 'added' | 'removed' | 'same'; text: string }) {
  return (
    <div
      className={
        kind === 'added'
          ? 'bg-added/12 text-added'
          : kind === 'removed'
            ? 'bg-removed/12 text-removed'
            : 'text-muted-foreground'
      }
    >
      <span className="inline-block w-4 flex-none select-none pl-1.5 opacity-60">
        {kind === 'added' ? '+' : kind === 'removed' ? '−' : ''}
      </span>
      {/* Code scrolls rather than wraps: a wrapped line reads as two
          lines, which is exactly the thing a diff must not blur. */}
      <span className="whitespace-pre pr-3">{text || ' '}</span>
    </div>
  )
}

export type SameLine = { kind: 'added' | 'removed' | 'same'; text: string }
export type SkipLine = { kind: 'skip'; count: number; hidden: string[] }
export type Line = SameLine | SkipLine

/**
 * A longest-common-subsequence diff, trimmed to the parts that changed.
 *
 * LCS is quadratic, so files past a size render as a straight replacement
 * rather than freezing the window. A diff nobody can read is not worth a
 * dropped frame.
 */
export const MAX_LCS_LINES = 1500

export function isSimplifiedDiff(before: string, after: string): boolean {
  if (before === '' || after === '') return false
  const a = before.split('\n').length
  const b = after.split('\n').length
  return a > MAX_LCS_LINES || b > MAX_LCS_LINES
}

export function skipLabel(count: number): string {
  return `⋯ ${count} unchanged line${count === 1 ? '' : 's'}`
}

/** Added and removed line counts for a file's before/after pair. */
export function changeCounts(
  before: string | null,
  after: string | null,
): { added: number; removed: number } {
  if (before === null) {
    return { added: after ? after.split('\n').length : 0, removed: 0 }
  }
  if (after === null) {
    return { added: 0, removed: before ? before.split('\n').length : 0 }
  }

  let added = 0
  let removed = 0
  for (const line of diffLines(before, after)) {
    if (line.kind === 'added') added += 1
    else if (line.kind === 'removed') removed += 1
  }
  return { added, removed }
}

export function diffLines(before: string, after: string): Line[] {
  const a = before === '' ? [] : before.split('\n')
  const b = after === '' ? [] : after.split('\n')

  if (a.length === 0) return b.map((text) => ({ kind: 'added', text }))
  if (b.length === 0) return a.map((text) => ({ kind: 'removed', text }))

  if (a.length > MAX_LCS_LINES || b.length > MAX_LCS_LINES) {
    return [
      ...a.map((text): Line => ({ kind: 'removed', text })),
      ...b.map((text): Line => ({ kind: 'added', text })),
    ]
  }

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

  const lines: SameLine[] = []
  let i = 0
  let j = 0

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ kind: 'same', text: a[i]! })
      i += 1
      j += 1
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) {
      lines.push({ kind: 'removed', text: a[i]! })
      i += 1
    } else {
      lines.push({ kind: 'added', text: b[j]! })
      j += 1
    }
  }

  while (i < a.length) lines.push({ kind: 'removed', text: a[i++]! })
  while (j < b.length) lines.push({ kind: 'added', text: b[j++]! })

  return collapse(lines)
}

/**
 * Hide long runs of unchanged lines.
 *
 * Three lines of context on each side of a change is enough to place it. A
 * whole unchanged file scrolled past to find one edit is not review, it is
 * searching.
 */
const CONTEXT = 3

function collapse(lines: SameLine[]): Line[] {
  const keep = new Set<number>()

  lines.forEach((line, index) => {
    if (line.kind === 'same') return
    for (let i = index - CONTEXT; i <= index + CONTEXT; i += 1) {
      if (i >= 0 && i < lines.length) keep.add(i)
    }
  })

  if (keep.size === lines.length) return lines

  const result: Line[] = []
  const skipped: string[] = []

  lines.forEach((line, index) => {
    if (keep.has(index)) {
      if (skipped.length > 0) {
        result.push({ kind: 'skip', count: skipped.length, hidden: [...skipped] })
        skipped.length = 0
      }
      result.push(line)
      return
    }
    skipped.push(line.text)
  })

  if (skipped.length > 0) {
    result.push({ kind: 'skip', count: skipped.length, hidden: [...skipped] })
  }

  return result
}
