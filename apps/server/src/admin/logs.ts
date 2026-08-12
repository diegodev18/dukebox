import { sessions, type Database } from '@dukebox/db'
import type { AgentEvent, EnvelopedEvent } from '@dukebox/protocol'
import { desc, eq, isNull, or, sql } from 'drizzle-orm'
import { spawn } from 'node:child_process'
import { ConfigError } from '../config.js'

/** Lines journalctl / docker logs show when the operator does not pass `-n`. */
export const DEFAULT_LOG_LINES = 50

export const LOGS_USAGE =
  'usage: duke logs [-f] [-n <lines>] [session|docker [id]] [--after <seq>] [--json]'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type LogsTarget = 'service' | 'session' | 'docker'

export interface LogsArgs {
  target: LogsTarget
  sessionId: string | undefined
  follow: boolean
  lines: number
  /** True when the operator passed `-n` / `--lines`, so session replay can honour it. */
  linesSpecified: boolean
  afterSeq: number
  afterSpecified: boolean
  json: boolean
}

function usageError(): never {
  throw new ConfigError(LOGS_USAGE)
}

function parsePositiveInt(value: string, label: string): number {
  if (!/^\d+$/.test(value)) {
    throw new ConfigError(`invalid ${label}: ${value}`)
  }
  const parsed = Number(value)
  if (parsed < 1) {
    throw new ConfigError(`invalid ${label}: ${value}`)
  }
  return parsed
}

function parseAfter(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new ConfigError(`invalid --after: ${value}`)
  }
  return Number(value)
}

/**
 * Parse `duke logs` argv after the command name.
 *
 *   duke logs
 *   duke logs -f -n 200
 *   duke logs session
 *   duke logs session <id> --after 42 --json
 *   duke logs docker <id> -f
 */
export function parseLogsArgs(args: string[]): LogsArgs {
  let target: LogsTarget = 'service'
  let sessionId: string | undefined
  let follow = false
  let lines = DEFAULT_LOG_LINES
  let linesSpecified = false
  let afterSeq = 0
  let afterSpecified = false
  let json = false
  let sawTarget = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!

    if (arg === '-f' || arg === '--follow') {
      follow = true
      continue
    }
    if (arg === '--json') {
      json = true
      continue
    }
    if (arg === '-n' || arg === '--lines') {
      const next = args[i + 1]
      if (!next || next.startsWith('-')) usageError()
      lines = parsePositiveInt(next, '-n')
      linesSpecified = true
      i++
      continue
    }
    if (/^-n\d+$/.test(arg)) {
      lines = parsePositiveInt(arg.slice(2), '-n')
      linesSpecified = true
      continue
    }
    if (arg.startsWith('--lines=')) {
      lines = parsePositiveInt(arg.slice('--lines='.length), '--lines')
      linesSpecified = true
      continue
    }
    if (arg === '--after') {
      const next = args[i + 1]
      if (next === undefined) usageError()
      afterSeq = parseAfter(next)
      afterSpecified = true
      i++
      continue
    }
    if (arg.startsWith('--after=')) {
      afterSeq = parseAfter(arg.slice('--after='.length))
      afterSpecified = true
      continue
    }
    if (arg.startsWith('-')) usageError()

    if (!sawTarget && (arg === 'session' || arg === 'docker')) {
      target = arg
      sawTarget = true
      continue
    }
    if (sawTarget && sessionId === undefined) {
      sessionId = arg
      continue
    }

    usageError()
  }

  if ((json || afterSpecified) && target !== 'session') usageError()

  return {
    target,
    sessionId,
    follow,
    lines,
    linesSpecified,
    afterSeq,
    afterSpecified,
    json,
  }
}

export function journalctlArgs(
  options: { follow: boolean; lines: number },
  service = 'dukebox',
): string[] {
  const args = ['--no-pager', '-u', service, '-n', String(options.lines)]
  if (options.follow) args.push('-f')
  return args
}

export function dockerLogsArgs(
  containerId: string,
  options: { follow: boolean; lines: number },
): string[] {
  const args = ['logs', '-t', '--tail', String(options.lines)]
  if (options.follow) args.push('-f')
  args.push(containerId)
  return args
}

/**
 * Run a command with the operator's terminal attached.
 *
 * `runCommand` buffers stdout, which cannot follow a log. Inherit stdio so
 * journalctl / docker logs stream the same way they would if typed by hand.
 */
export async function runInherited(
  command: string,
  args: string[],
  spawnImpl: typeof spawn = spawn,
): Promise<number> {
  const child = spawnImpl(command, args, { stdio: 'inherit' })
  return await new Promise((resolve, reject) => {
    child.once('error', (error) => {
      reject(new ConfigError(`cannot run ${command}`, error.message))
    })
    child.once('close', (code, signal) => {
      resolve(signal ? 1 : (code ?? 1))
    })
  })
}

/** Compact one-line view of an event, for `duke logs session` without `--json`. */
export function formatEvent(enveloped: EnvelopedEvent): string {
  const summary = eventSummary(enveloped.event)
  return summary === undefined
    ? `${enveloped.seq}  ${enveloped.event.type}`
    : `${enveloped.seq}  ${enveloped.event.type}  ${summary}`
}

function collapse(text: string, max = 80): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= max) return oneLine
  return `${oneLine.slice(0, max - 1)}…`
}

function eventSummary(event: AgentEvent): string | undefined {
  switch (event.type) {
    case 'user_prompt':
      return collapse(event.text)
    case 'assistant_text':
    case 'thinking':
      return collapse(event.delta)
    case 'tool_call':
      return event.name
    case 'tool_result':
      return event.isError ? 'error' : collapse(event.output)
    case 'file_diff':
      return event.path
    case 'permission_request':
      return event.action
    case 'permission_mode':
      return event.mode
    case 'usage':
      return `${event.inputTokens} in / ${event.outputTokens} out`
    case 'session_started':
      return event.model ? `${event.agentId} ${event.model}` : event.agentId
    case 'error':
      return collapse(event.message)
    case 'done':
      return event.reason
    case 'terminal_opened':
      return event.terminalId
    case 'terminal_closed':
      return event.exitCode === undefined
        ? event.terminalId
        : `${event.terminalId} exit ${event.exitCode}`
  }
}

export interface SessionLogRow {
  id: string
  status: string
  branch: string
  title: string
}

export function formatSessionRow(row: SessionLogRow): string {
  return `${row.id}  ${row.status.padEnd(14)} ${row.branch.padEnd(16)} ${row.title}`
}

/** Non-archived sessions, newest first — the same set the sidebar shows. */
export async function listActiveSessions(db: Database): Promise<SessionLogRow[]> {
  return db
    .select({
      id: sessions.id,
      status: sessions.status,
      branch: sessions.branch,
      title: sessions.title,
    })
    .from(sessions)
    .where(isNull(sessions.archivedAt))
    .orderBy(desc(sessions.createdAt))
}

function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, '\\$&')
}

/**
 * Resolve a session token to its UUID.
 *
 * Accepts a full id, a unique prefix of the id, the git branch (`duke/<8 hex>`),
 * or that 8-character prefix alone. Ambiguous prefixes fail with the matches
 * rather than picking one.
 */
export async function resolveSessionId(db: Database, token: string): Promise<string> {
  const trimmed = token.trim()
  if (trimmed.length === 0) {
    throw new ConfigError('usage: duke logs session <id>')
  }

  if (UUID_RE.test(trimmed)) {
    const [row] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.id, trimmed))
    if (!row) throw new ConfigError(`no session ${trimmed}`)
    return row.id
  }

  const pattern = `${escapeLike(trimmed)}%`
  const matches = await db
    .select({ id: sessions.id, branch: sessions.branch })
    .from(sessions)
    .where(
      or(
        sql`${sessions.id}::text like ${pattern} escape '\\'`,
        eq(sessions.branch, trimmed),
        eq(sessions.branch, `duke/${trimmed}`),
      ),
    )

  if (matches.length === 0) {
    throw new ConfigError(`no session matching ${trimmed}`)
  }
  if (matches.length > 1) {
    const list = matches.map((row) => `${row.id}  ${row.branch}`).join('\n')
    throw new ConfigError(`multiple sessions match ${trimmed}:\n${list}`)
  }
  return matches[0]!.id
}

/** Last `count` items, or the whole list when the operator did not pass `-n`. */
export function takeLast<T>(items: readonly T[], count: number | undefined): T[] {
  if (count === undefined) return [...items]
  return items.slice(-count)
}

/**
 * Wait until the operator hits Ctrl-C (or the process is terminated).
 *
 * Used after attaching to a live session event stream, where there is no child
 * process to inherit the signal.
 */
export function untilInterrupted(
  emitter: NodeJS.EventEmitter = process,
  signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'],
): Promise<void> {
  return new Promise((resolve) => {
    const stop = () => {
      for (const signal of signals) emitter.off(signal, stop)
      resolve()
    }
    for (const signal of signals) emitter.on(signal, stop)
  })
}
