import type { TerminalHandle } from '@dukebox/sandbox'
import { randomUUID } from 'node:crypto'
import { RingBuffer } from './ringBuffer.js'

/**
 * The interactive shells running inside session containers.
 *
 * The registry owns the PTY rather than the WebSocket connection that opened
 * it, which is what makes a terminal survive a client disconnect: the socket
 * attaches and detaches, the process keeps running. A terminal ends when
 * someone closes it or when its session does.
 */

/**
 * Terminals allowed per session.
 *
 * A cap because a client-side retry bug would otherwise create PTYs until it
 * hits the container's PidsLimit and takes the whole session down with it.
 */
export const MAX_TERMINALS_PER_SESSION = 4

/** Scrollback kept per terminal, so a reattaching client can redraw. */
export const SCROLLBACK_BYTES = 128 * 1024

export interface TerminalInfo {
  terminalId: string
  title: string
}

export type TerminalListener = (chunk: Buffer) => void
export type TerminalExitListener = (exitCode?: number) => void

export interface TerminalRegistryDeps {
  /** Opens a PTY in a session's container. Throws if the session is not running. */
  openTerminal: (sessionId: string, size: { cols: number; rows: number }) => Promise<TerminalHandle>
}

export class TerminalError extends Error {}

interface LiveTerminal {
  terminalId: string
  title: string
  handle: TerminalHandle
  scrollback: RingBuffer
  listeners: Set<TerminalListener>
  exitListeners: Set<TerminalExitListener>
}

export class TerminalRegistry {
  private readonly sessions = new Map<string, Map<string, LiveTerminal>>()

  constructor(private readonly deps: TerminalRegistryDeps) {}

  async open(sessionId: string, size: { cols: number; rows: number }): Promise<TerminalInfo> {
    const existing = this.sessions.get(sessionId) ?? new Map<string, LiveTerminal>()

    if (existing.size >= MAX_TERMINALS_PER_SESSION) {
      throw new TerminalError(`a session may have at most ${MAX_TERMINALS_PER_SESSION} terminals`)
    }

    const handle = await this.deps.openTerminal(sessionId, size)

    const terminal: LiveTerminal = {
      terminalId: randomUUID(),
      // Numbered by how many are already open. Titles are for telling tabs
      // apart, and a uuid on a tab tells nobody anything.
      title: String(existing.size + 1),
      handle,
      scrollback: new RingBuffer(SCROLLBACK_BYTES),
      listeners: new Set(),
      exitListeners: new Set(),
    }

    handle.stream.on('data', (chunk: Buffer) => {
      terminal.scrollback.append(chunk)
      for (const listener of terminal.listeners) listener(chunk)
    })

    // 'close' as well as 'end': a destroyed stream never emits 'end', and a
    // terminal whose container died would otherwise linger in the registry
    // forever, holding a slot against the cap.
    const finish = () => this.forget(sessionId, terminal)
    handle.stream.on('close', finish)
    handle.stream.on('end', finish)
    handle.stream.on('error', finish)

    existing.set(terminal.terminalId, terminal)
    this.sessions.set(sessionId, existing)

    return { terminalId: terminal.terminalId, title: terminal.title }
  }

  list(sessionId: string): TerminalInfo[] {
    const session = this.sessions.get(sessionId)
    if (!session) return []

    return [...session.values()].map(({ terminalId, title }) => ({ terminalId, title }))
  }

  /** Start receiving output. Returns the scrollback to redraw from. */
  attach(
    sessionId: string,
    terminalId: string,
    listener: TerminalListener,
    onExit: TerminalExitListener,
  ): Buffer {
    const terminal = this.require(sessionId, terminalId)
    terminal.listeners.add(listener)
    terminal.exitListeners.add(onExit)

    return terminal.scrollback.contents()
  }

  detach(sessionId: string, terminalId: string, listener: TerminalListener): void {
    // Deliberately tolerant of an unknown terminal: detach races with a shell
    // exiting, and turning that into an error would surface as a spurious
    // failure every time a client closes a tab at the wrong moment.
    const terminal = this.sessions.get(sessionId)?.get(terminalId)
    terminal?.listeners.delete(listener)
  }

  write(sessionId: string, terminalId: string, data: Buffer): void {
    this.require(sessionId, terminalId).handle.stream.write(data)
  }

  async resize(sessionId: string, terminalId: string, cols: number, rows: number): Promise<void> {
    await this.require(sessionId, terminalId).handle.resize(cols, rows)
  }

  async close(sessionId: string, terminalId: string): Promise<void> {
    const terminal = this.sessions.get(sessionId)?.get(terminalId)
    if (!terminal) return

    this.forget(sessionId, terminal)
    await terminal.handle.close().catch(() => undefined)
  }

  /**
   * End every terminal in a session.
   *
   * Called when a session stops. A PTY outliving its container is a guaranteed
   * leak: the process is gone, but the registry entry holds a scrollback buffer
   * and a slot against the cap forever.
   */
  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return

    const terminals = [...session.values()]
    this.sessions.delete(sessionId)

    for (const terminal of terminals) {
      this.notifyExit(terminal)
    }

    await Promise.all(terminals.map((terminal) => terminal.handle.close().catch(() => undefined)))
  }

  private require(sessionId: string, terminalId: string): LiveTerminal {
    const terminal = this.sessions.get(sessionId)?.get(terminalId)
    if (!terminal) throw new TerminalError('no such terminal')

    return terminal
  }

  /** Drop a terminal and tell whoever was watching. Safe to call twice. */
  private forget(sessionId: string, terminal: LiveTerminal): void {
    const session = this.sessions.get(sessionId)
    if (!session?.delete(terminal.terminalId)) return

    if (session.size === 0) this.sessions.delete(sessionId)
    this.notifyExit(terminal)
  }

  private notifyExit(terminal: LiveTerminal): void {
    for (const listener of terminal.exitListeners) listener(undefined)
    terminal.listeners.clear()
    terminal.exitListeners.clear()
  }
}
