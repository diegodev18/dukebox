import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_TERMINALS_PER_SESSION, TerminalRegistry, randomTerminalTitle } from './terminals.js'

const sessionId = 'session-1'

/**
 * A stand-in for a container PTY.
 *
 * A PassThrough is enough: the registry only writes to the stream, reads from
 * it, and destroys it. A real container here would be testing Docker.
 */
function fakeTerminal() {
  const stream = new PassThrough()
  return {
    stream,
    resize: vi.fn(async () => {}),
    close: vi.fn(async () => {
      stream.destroy()
    }),
  }
}

/** Let stream events settle. The registry forwards output on the next tick. */
async function flush() {
  await new Promise((resolve) => setImmediate(resolve))
}

describe('TerminalRegistry', () => {
  let terminals: ReturnType<typeof fakeTerminal>[]
  let registry: TerminalRegistry

  beforeEach(() => {
    terminals = []
    registry = new TerminalRegistry({
      openTerminal: async () => {
        const terminal = fakeTerminal()
        terminals.push(terminal)
        return terminal
      },
    })
  })

  it('opens a terminal and lists it', async () => {
    const info = await registry.open(sessionId, { cols: 80, rows: 24 })

    expect(registry.list(sessionId)).toEqual([info])
  })

  it('names terminals with a unique three-digit label', async () => {
    const first = await registry.open(sessionId, { cols: 80, rows: 24 })
    const second = await registry.open(sessionId, { cols: 80, rows: 24 })

    expect(first.title).toMatch(/^\d{3}$/)
    expect(second.title).toMatch(/^\d{3}$/)
    expect(first.title).not.toBe(second.title)
  })

  it('renames a terminal and lists the new title', async () => {
    const info = await registry.open(sessionId, { cols: 80, rows: 24 })
    const renamed = registry.rename(sessionId, info.terminalId, 'build')

    expect(renamed.title).toBe('build')
    expect(registry.list(sessionId)).toEqual([renamed])
  })

  it('refuses to open more than the cap', async () => {
    for (let index = 0; index < MAX_TERMINALS_PER_SESSION; index += 1) {
      await registry.open(sessionId, { cols: 80, rows: 24 })
    }

    await expect(registry.open(sessionId, { cols: 80, rows: 24 })).rejects.toThrow(
      /at most 4 terminals/,
    )
  })

  it('counts the cap per session, not globally', async () => {
    for (let index = 0; index < MAX_TERMINALS_PER_SESSION; index += 1) {
      await registry.open(sessionId, { cols: 80, rows: 24 })
    }

    await expect(registry.open('session-2', { cols: 80, rows: 24 })).resolves.toBeDefined()
  })

  it('delivers output to an attached listener', async () => {
    const info = await registry.open(sessionId, { cols: 80, rows: 24 })

    const received: Buffer[] = []
    registry.attach(
      sessionId,
      info.terminalId,
      (chunk) => received.push(chunk),
      () => {},
    )

    terminals[0]!.stream.write('hello')
    await flush()

    expect(Buffer.concat(received).toString()).toBe('hello')
  })

  it('buffers output while nobody is attached, and replays it on attach', async () => {
    const info = await registry.open(sessionId, { cols: 80, rows: 24 })

    terminals[0]!.stream.write('while detached')
    await flush()

    const scrollback = registry.attach(
      sessionId,
      info.terminalId,
      () => {},
      () => {},
    )

    expect(scrollback.toString()).toBe('while detached')
  })

  it('stops delivering after detach but keeps the process alive', async () => {
    const info = await registry.open(sessionId, { cols: 80, rows: 24 })

    const received: Buffer[] = []
    const listener = (chunk: Buffer) => received.push(chunk)
    registry.attach(sessionId, info.terminalId, listener, () => {})
    registry.detach(sessionId, info.terminalId, listener)

    terminals[0]!.stream.write('after detach')
    await flush()

    expect(received).toHaveLength(0)
    expect(terminals[0]!.close).not.toHaveBeenCalled()
    expect(registry.list(sessionId)).toHaveLength(1)
  })

  it('keeps buffering after a detach, so reattaching shows what was missed', async () => {
    const info = await registry.open(sessionId, { cols: 80, rows: 24 })

    const listener = () => {}
    registry.attach(sessionId, info.terminalId, listener, () => {})
    registry.detach(sessionId, info.terminalId, listener)

    terminals[0]!.stream.write('ran while away')
    await flush()

    const scrollback = registry.attach(
      sessionId,
      info.terminalId,
      () => {},
      () => {},
    )

    expect(scrollback.toString()).toContain('ran while away')
  })

  it('writes input straight through to the PTY', async () => {
    const info = await registry.open(sessionId, { cols: 80, rows: 24 })

    const written: Buffer[] = []
    terminals[0]!.stream.on('data', (chunk: Buffer) => written.push(chunk))

    registry.write(sessionId, info.terminalId, Buffer.from('ls -la\n'))
    await flush()

    expect(Buffer.concat(written).toString()).toBe('ls -la\n')
  })

  it('forwards a resize to the container', async () => {
    const info = await registry.open(sessionId, { cols: 80, rows: 24 })
    await registry.resize(sessionId, info.terminalId, 120, 40)

    expect(terminals[0]!.resize).toHaveBeenCalledWith(120, 40)
  })

  it('closes the PTY and forgets the terminal', async () => {
    const info = await registry.open(sessionId, { cols: 80, rows: 24 })
    await registry.close(sessionId, info.terminalId)

    expect(terminals[0]!.close).toHaveBeenCalled()
    expect(registry.list(sessionId)).toHaveLength(0)
  })

  it('notifies attached listeners when the stream ends on its own', async () => {
    const info = await registry.open(sessionId, { cols: 80, rows: 24 })

    const exits: (number | undefined)[] = []
    registry.attach(
      sessionId,
      info.terminalId,
      () => {},
      (code) => exits.push(code),
    )

    terminals[0]!.stream.end()
    await flush()

    expect(exits).toHaveLength(1)
    expect(registry.list(sessionId)).toHaveLength(0)
  })

  it('closes every terminal in a session at once', async () => {
    await registry.open(sessionId, { cols: 80, rows: 24 })
    await registry.open(sessionId, { cols: 80, rows: 24 })

    await registry.closeSession(sessionId)

    expect(registry.list(sessionId)).toHaveLength(0)
    expect(terminals.every((terminal) => terminal.close.mock.calls.length > 0)).toBe(true)
  })

  it('leaves other sessions alone when one closes', async () => {
    await registry.open(sessionId, { cols: 80, rows: 24 })
    await registry.open('session-2', { cols: 80, rows: 24 })

    await registry.closeSession(sessionId)

    expect(registry.list('session-2')).toHaveLength(1)
  })

  it('reports an unknown terminal rather than failing silently', () => {
    expect(() => registry.write(sessionId, 'nope', Buffer.from('x'))).toThrow(/no such terminal/)
  })

  it('tolerates detaching from a terminal that already exited', async () => {
    const info = await registry.open(sessionId, { cols: 80, rows: 24 })

    terminals[0]!.stream.end()
    await flush()

    // Detach races with a shell exiting. Throwing here would surface as a
    // spurious error every time a client closes a tab at the wrong moment.
    expect(() => registry.detach(sessionId, info.terminalId, () => {})).not.toThrow()
  })

  it('frees a slot when a terminal closes, so the cap is not permanent', async () => {
    const first = await registry.open(sessionId, { cols: 80, rows: 24 })
    for (let index = 1; index < MAX_TERMINALS_PER_SESSION; index += 1) {
      await registry.open(sessionId, { cols: 80, rows: 24 })
    }

    await registry.close(sessionId, first.terminalId)

    await expect(registry.open(sessionId, { cols: 80, rows: 24 })).resolves.toBeDefined()
  })
})

describe('randomTerminalTitle', () => {
  it('returns a three-digit label', () => {
    expect(randomTerminalTitle([])).toMatch(/^\d{3}$/)
  })

  it('skips titles already in use', () => {
    const taken = Array.from({ length: 999 }, (_, index) => String(index).padStart(3, '0'))

    expect(randomTerminalTitle(taken)).toBe('999')
  })
})
