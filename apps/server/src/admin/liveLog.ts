/**
 * Last-N-line TTY viewport, in the spirit of Docker BuildKit's progress UI.
 *
 * Long install/build logs (pnpm, tsc) would otherwise scroll the operator's
 * terminal away. Four lines that rewrite in place keep the signal without the
 * flood. Non-TTY destinations (CI, journald) stay silent — callers still
 * buffer the full output for error messages.
 */

export const LIVE_LOG_LINES = 4

const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g

export interface LiveLogWriter {
  write(chunk: string | Uint8Array): unknown
  isTTY?: boolean
  columns?: number
}

export interface LiveLogOptions {
  stream?: LiveLogWriter
  lines?: number
  isTTY?: boolean
  columns?: number
}

export interface LiveLog {
  write(chunk: string | Uint8Array): void
  finish(): void
}

export function stripAnsi(value: string): string {
  return value.replace(ANSI_RE, '')
}

export function createLiveLog(options: LiveLogOptions = {}): LiveLog {
  const stream = options.stream ?? process.stderr
  const isTTY = options.isTTY ?? Boolean(stream.isTTY)
  const lineCount = options.lines ?? LIVE_LOG_LINES
  const columns = () => {
    const width = options.columns ?? stream.columns ?? 80
    return width > 0 ? width : 80
  }

  const completed: string[] = []
  let current = ''
  let leftover = ''
  let drawn = 0
  let finished = false

  function visible(): string[] {
    const lines = current.length > 0 ? [...completed, current] : completed
    return lines.slice(-lineCount)
  }

  function commit(line: string): void {
    if (stripAnsi(line).trim().length === 0) return
    completed.push(line)
    if (completed.length > lineCount) completed.shift()
  }

  function redraw(): void {
    if (!isTTY || finished) return
    const lines = visible().map((line) => truncate(stripAnsi(line), columns()))
    if (drawn > 0) stream.write(`\x1b[${drawn}A\x1b[J`)
    for (const line of lines) stream.write(`${line}\n`)
    drawn = lines.length
  }

  function consume(text: string): void {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!
      if (ch === '\n') {
        commit(current)
        current = ''
        redraw()
        continue
      }
      if (ch === '\r') {
        current = ''
        redraw()
        continue
      }
      current += ch
    }
    redraw()
  }

  return {
    write(chunk: string | Uint8Array): void {
      if (finished) return
      let text = leftover + (typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
      leftover = ''
      // A trailing CR might be the first half of CRLF arriving in the next chunk.
      if (text.endsWith('\r')) {
        leftover = '\r'
        text = text.slice(0, -1)
      }
      consume(text.replace(/\r\n/g, '\n'))
    },
    finish(): void {
      if (finished) return
      if (leftover) {
        consume(leftover)
        leftover = ''
      }
      redraw()
      finished = true
    },
  }
}

function truncate(value: string, width: number): string {
  const plain = value.replace(/\t/g, ' ')
  return plain.length <= width ? plain : plain.slice(0, width)
}
