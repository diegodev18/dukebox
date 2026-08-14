import { MAX_LCS_LINES, alignLines, countLineChanges, type FileChange } from '@dukebox/protocol'
import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { cn } from '@/lib/utils'
import { VirtualRows } from '@/components/VirtualRows'
import { tokensForCode, type HighlightToken } from '@/lib/syntaxHighlight'

export { MAX_LCS_LINES }

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
  const { lines, simplified } = useMemo(() => {
    const aligned = alignLines(before, after)
    return { lines: collapse(aligned.lines), simplified: aligned.simplified }
  }, [before, after])
  const digits = useMemo(() => gutterDigits(lines), [lines])
  const root = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLElement | null>(null)
  const inView = useInView(root)
  const highlight = useFileHighlight(file.path, before, after, inView)
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set())

  const setRoot = (node: HTMLDivElement | null) => {
    root.current = node
    scrollRef.current = node?.closest('.overflow-auto') ?? null
  }

  const toggleSkip = (index: number) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  const rows = useMemo(() => flattenDiffRows(lines, expanded), [lines, expanded])

  return (
    <div
      ref={setRoot}
      data-selectable
      aria-busy={highlight.before == null || highlight.after == null}
    >
      {simplified && (
        <p className="px-3 py-1.5 text-[12px] text-muted-foreground">
          Diff simplified (file too large)
        </p>
      )}
      {/* Wide enough for its longest line, so the row background spans the full
          scrolled width rather than stopping at the panel edge. */}
      <div className="inline-block min-w-full font-mono text-[12px] leading-[1.55]">
        <VirtualRows
          count={rows.length}
          scrollRef={scrollRef as RefObject<HTMLElement | null>}
          estimateSize={20}
          after={80}
          wide
        >
          {(index) => {
            const row = rows[index]!
            if (row.kind === 'skip') {
              return (
                <SkipHeader
                  line={row.line}
                  open={expanded.has(row.index)}
                  onToggle={() => toggleSkip(row.index)}
                />
              )
            }
            return (
              <DiffRow line={row.line} digits={digits} tokens={tokensForRow(row.line, highlight)} />
            )
          }}
        </VirtualRows>
      </div>
    </div>
  )
}

function SkipHeader({
  line,
  open,
  onToggle,
}: {
  line: SkipLine
  open: boolean
  onToggle: () => void
}) {
  const range = skipRange(line.hidden)
  const label = skipLabel(line.count, range)

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={label}
      className="sticky left-0 z-[1] box-border block w-[var(--workspace-files-width)] bg-muted px-3 py-0.5 text-left text-muted-foreground hover:bg-border hover:text-foreground"
    >
      {label}
    </button>
  )
}

type FlatRow = { kind: 'skip'; line: SkipLine; index: number } | { kind: 'line'; line: SameLine }

function flattenDiffRows(lines: Line[], expanded: ReadonlySet<number>): FlatRow[] {
  const rows: FlatRow[] = []
  lines.forEach((line, index) => {
    if (line.kind === 'skip') {
      rows.push({ kind: 'skip', line, index })
      if (expanded.has(index)) {
        for (const hidden of line.hidden) rows.push({ kind: 'line', line: hidden })
      }
      return
    }
    rows.push({ kind: 'line', line })
  })
  return rows
}

function useInView(ref: RefObject<HTMLElement | null>): boolean {
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined')

  useEffect(() => {
    const element = ref.current
    if (!element || typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) setVisible(true)
      },
      { rootMargin: '240px' },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])

  return visible
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

function useFileHighlight(
  path: string,
  before: string,
  after: string,
  enabled: boolean,
): FileHighlight {
  const [tokens, setTokens] = useState<FileHighlight>({ before: null, after: null })

  useEffect(() => {
    if (!enabled) return
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
  }, [path, before, after, enabled])

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
 * Whether the alignment gave up on a gap and drew a straight replacement.
 *
 * Size alone is not enough: a 1900-line file with twenty new cases is still
 * a real diff. The banner is only for a remaining hunk too large to LCS
 * and with nothing unique to split on.
 */
export function isSimplifiedDiff(before: string, after: string): boolean {
  return alignLines(before, after).simplified
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
  return countLineChanges(before, after)
}

/** Prefer counts folded into the file; fall back to computing them. */
export function fileChangeCounts(file: FileChange): { added: number; removed: number } {
  if (file.added != null && file.removed != null) {
    return { added: file.added, removed: file.removed }
  }
  return countLineChanges(file.before, file.after)
}

export function diffLines(before: string, after: string): Line[] {
  return collapse(alignLines(before, after).lines)
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
