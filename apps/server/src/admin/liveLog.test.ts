import { describe, expect, it } from 'vitest'
import { createLiveLog, LIVE_LOG_LINES, stripAnsi } from './liveLog.js'

class FakeTty {
  isTTY = true
  columns: number
  chunks: string[] = []

  constructor(columns = 80) {
    this.columns = columns
  }

  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
    return true
  }

  output(): string {
    return this.chunks.join('')
  }
}

/** Interpret cursor-up / erase-to-end so tests can assert the on-screen block. */
function screen(output: string): string[] {
  const rows: string[] = ['']
  let row = 0
  let col = 0
  let i = 0
  while (i < output.length) {
    if (output.startsWith('\x1b[', i)) {
      const match = /^\x1b\[(\d*)([A-Za-z])/.exec(output.slice(i))
      if (match) {
        const count = match[1] ? Number(match[1]) : 1
        if (match[2] === 'A') {
          row = Math.max(0, row - count)
          col = 0
        } else if (match[2] === 'J') {
          rows[row] = (rows[row] ?? '').slice(0, col)
          rows.length = row + 1
        }
        i += match[0].length
        continue
      }
    }
    const ch = output[i]!
    if (ch === '\n') {
      row++
      col = 0
      if (rows[row] === undefined) rows[row] = ''
      i++
      continue
    }
    const line = rows[row] ?? ''
    rows[row] = line.slice(0, col) + ch + line.slice(col + 1)
    col++
    i++
  }
  while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop()
  return rows
}

describe('createLiveLog', () => {
  it('rewrites in place and keeps only the last four lines', () => {
    const tty = new FakeTty()
    const log = createLiveLog({ stream: tty })
    log.write('one\ntwo\nthree\nfour\nfive\n')
    log.finish()

    expect(LIVE_LOG_LINES).toBe(4)
    expect(screen(tty.output())).toEqual(['two', 'three', 'four', 'five'])
    expect(tty.output()).toContain('\x1b[')
  })

  it('treats CR as an in-place line replace, not a new row', () => {
    const tty = new FakeTty()
    const log = createLiveLog({ stream: tty })
    log.write('Downloading... 10%\rDownloading... 50%\rDownloading... 100%\n')
    log.finish()

    expect(screen(tty.output())).toEqual(['Downloading... 100%'])
  })

  it('does not split CRLF across chunks into a blank line', () => {
    const tty = new FakeTty()
    const log = createLiveLog({ stream: tty })
    log.write('hello\r')
    log.write('\nworld\n')
    log.finish()

    expect(screen(tty.output())).toEqual(['hello', 'world'])
  })

  it('truncates to the terminal width', () => {
    const tty = new FakeTty(10)
    const log = createLiveLog({ stream: tty, columns: 10 })
    log.write('abcdefghijklmnop\n')
    log.finish()

    expect(screen(tty.output())).toEqual(['abcdefghij'])
  })

  it('strips ANSI before measuring and drawing', () => {
    expect(stripAnsi('\x1b[32mgreen\x1b[0m')).toBe('green')

    const tty = new FakeTty()
    const log = createLiveLog({ stream: tty })
    log.write('\x1b[32mgreen\x1b[0m\n')
    log.finish()

    expect(screen(tty.output())).toEqual(['green'])
  })

  it('paints nothing when the destination is not a TTY', () => {
    const sink = new FakeTty()
    sink.isTTY = false
    const log = createLiveLog({ stream: sink, isTTY: false })
    log.write('one\ntwo\nthree\nfour\nfive\n')
    log.finish()

    expect(sink.output()).toBe('')
  })

  it('leaves the final block on screen after finish', () => {
    const tty = new FakeTty()
    const log = createLiveLog({ stream: tty })
    log.write('a\nb\n')
    log.finish()
    const afterFinish = tty.output()
    log.write('should be ignored\n')
    log.finish()

    expect(tty.output()).toBe(afterFinish)
    expect(screen(afterFinish)).toEqual(['a', 'b'])
  })
})
