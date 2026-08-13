import type { FileChange } from '@dukebox/protocol'
import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { cn } from '@/lib/utils'
import { tokensForCode, type HighlightToken } from '@/lib/syntaxHighlight'

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
  const digits = useMemo(() => gutterDigits(lines), [lines])
  const highlight = useFileHighlight(file.path, before, after)
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
    <div data-selectable aria-busy={highlight.before == null || highlight.after == null}>
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
              digits={digits}
              highlight={highlight}
              open={expanded.has(index)}
              onToggle={() => toggleSkip(index)}
            />
          ) : (
            <DiffRow
              key={index}
              line={line}
              digits={digits}
              tokens={tokensForRow(line, highlight)}
            />
          ),
        )}
      </div>
    </div>
  )
}

function SkipHunk({
  line,
  digits,
  highlight,
  open,
  onToggle,
}: {
  line: SkipLine
  digits: number
  highlight: FileHighlight
  open: boolean
  onToggle: () => void
}) {
  const range = skipRange(line.hidden)
  const label = skipLabel(line.count, range)

  return (
    <div className="min-w-full">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={label}
        className="sticky left-0 z-[1] box-border block w-[var(--workspace-files-width)] bg-muted px-3 py-0.5 text-left text-muted-foreground hover:bg-border hover:text-foreground"
      >
        {label}
      </button>
      {open &&
        line.hidden.map((hidden, index) => (
          <DiffRow
            key={index}
            line={hidden}
            digits={digits}
            tokens={tokensForRow(hidden, highlight)}
          />
        ))}
    </div>
  )
}

function DiffRow({
  line,
  digits,
  tokens,
}: {
  line: SameLine
  digits: number
  tokens: HighlightToken[] | null
}) {
  const { kind, text, oldLine, newLine } = line
  const gutterTint =
    kind === 'added'
      ? 'border-added bg-[color-mix(in_oklch,var(--color-added)_12%,var(--color-surface))]'
      : kind === 'removed'
        ? 'border-removed bg-[color-mix(in_oklch,var(--color-removed)_12%,var(--color-surface))]'
        : 'border-transparent bg-surface'
  const codeTint = kind === 'added' ? 'bg-added/12' : kind === 'removed' ? 'bg-removed/12' : ''

  return (
    <div className="flex min-w-full">
      <span
        className={cn(
          'flex flex-none select-none items-center gap-2 border-l-2 py-0 pl-2 pr-3 tabular-nums text-muted-foreground',
          gutterTint,
        )}
      >
        <span className="inline-block text-right opacity-60" style={{ width: `${digits}ch` }}>
          {oldLine ?? ''}
        </span>
        <span className="inline-block text-right opacity-60" style={{ width: `${digits}ch` }}>
          {newLine ?? ''}
        </span>
      </span>
      {/* Code scrolls rather than wraps: a wrapped line reads as two
          lines, which is exactly the thing a diff must not blur. */}
      <span className={cn('flex-1 whitespace-pre pr-3 text-foreground', codeTint)}>
        <Code text={text} tokens={tokens} />
      </span>
    </div>
  )
}

function Code({ text, tokens }: { text: string; tokens: HighlightToken[] | null }) {
  if (!tokens || tokens.length === 0) return <>{text || ' '}</>
  return (
    <>
      {tokens.map((token, index) => (
        <span key={index} className="shiki-token" style={token.style as CSSProperties | undefined}>
          {token.content}
        </span>
      ))}
    </>
  )
}

type FileHighlight = {
  before: HighlightToken[][] | null
  after: HighlightToken[][] | null
}

function useFileHighlight(path: string, before: string, after: string): FileHighlight {
  const [tokens, setTokens] = useState<FileHighlight>({ before: null, after: null })

  useEffect(() => {
    let cancelled = false
    setTokens({ before: null, after: null })
    void Promise.all([tokensForCode(path, before), tokensForCode(path, after)]).then(
      ([beforeTokens, afterTokens]) => {
        if (!cancelled) setTokens({ before: beforeTokens, after: afterTokens })
      },
    )
    return () => {
      cancelled = true
    }
  }, [path, before, after])

  return tokens
}

function tokensForRow(line: SameLine, highlight: FileHighlight): HighlightToken[] | null {
  if (line.kind === 'removed') {
    return line.oldLine != null ? (highlight.before?.[line.oldLine - 1] ?? null) : null
  }
  return line.newLine != null ? (highlight.after?.[line.newLine - 1] ?? null) : null
}

function gutterDigits(lines: Line[]): number {
  let max = 0
  const consider = (n: number | null) => {
    if (n != null && n > max) max = n
  }
  for (const line of lines) {
    if (line.kind === 'skip') {
      for (const hidden of line.hidden) {
        consider(hidden.oldLine)
        consider(hidden.newLine)
      }
    } else {
      consider(line.oldLine)
      consider(line.newLine)
    }
  }
  return Math.max(2, String(max).length)
}

function skipRange(hidden: SameLine[]): { start: number; end: number } | undefined {
  const first = hidden[0]
  const last = hidden.at(-1)
  if (!first || !last) return undefined
  const start = first.oldLine ?? first.newLine
  const end = last.oldLine ?? last.newLine
  if (start == null || end == null) return undefined
  return { start, end }
}

export type SameLine = {
  kind: 'added' | 'removed' | 'same'
  text: string
  oldLine: number | null
  newLine: number | null
}
export type SkipLine = { kind: 'skip'; count: number; hidden: SameLine[] }
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

export function skipLabel(count: number, range?: { start: number; end: number }): string {
  const noun = `⋯ ${count} unchanged line${count === 1 ? '' : 's'}`
  if (!range) return noun
  if (range.start === range.end) return `${noun} · ${range.start}`
  return `${noun} · ${range.start}–${range.end}`
}

/**
 * The file paths a Changes or Pull request list should keep expanded.
 *
 * Diffs default to open — those tabs exist to review what changed — and a file
 * that arrives later is open too. Only missing paths are added, so a diff the
 * user collapsed stays collapsed.
 */
export function expandedPaths(open: ReadonlySet<string>, files: FileChange[]): ReadonlySet<string> {
  if (files.every((file) => open.has(file.path))) return open
  const next = new Set(open)
  for (const file of files) next.add(file.path)
  return next
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

  if (a.length === 0) {
    return b.map((text, index) => ({
      kind: 'added',
      text,
      oldLine: null,
      newLine: index + 1,
    }))
  }
  if (b.length === 0) {
    return a.map((text, index) => ({
      kind: 'removed',
      text,
      oldLine: index + 1,
      newLine: null,
    }))
  }

  if (a.length > MAX_LCS_LINES || b.length > MAX_LCS_LINES) {
    return [
      ...a.map((text, index): Line => ({
        kind: 'removed',
        text,
        oldLine: index + 1,
        newLine: null,
      })),
      ...b.map((text, index): Line => ({
        kind: 'added',
        text,
        oldLine: null,
        newLine: index + 1,
      })),
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
      lines.push({ kind: 'same', text: a[i]!, oldLine: i + 1, newLine: j + 1 })
      i += 1
      j += 1
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) {
      lines.push({ kind: 'removed', text: a[i]!, oldLine: i + 1, newLine: null })
      i += 1
    } else {
      lines.push({ kind: 'added', text: b[j]!, oldLine: null, newLine: j + 1 })
      j += 1
    }
  }

  while (i < a.length) {
    lines.push({ kind: 'removed', text: a[i]!, oldLine: i + 1, newLine: null })
    i += 1
  }
  while (j < b.length) {
    lines.push({ kind: 'added', text: b[j]!, oldLine: null, newLine: j + 1 })
    j += 1
  }

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
  const skipped: SameLine[] = []

  lines.forEach((line, index) => {
    if (keep.has(index)) {
      if (skipped.length > 0) {
        result.push({ kind: 'skip', count: skipped.length, hidden: [...skipped] })
        skipped.length = 0
      }
      result.push(line)
      return
    }
    skipped.push(line)
  })

  if (skipped.length > 0) {
    result.push({ kind: 'skip', count: skipped.length, hidden: [...skipped] })
  }

  return result
}
