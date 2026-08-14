import type { AgentEvent, EnvelopedEvent } from '@dukebox/protocol'
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { ConfigError } from '@/config'
import {
  DEFAULT_LOG_LINES,
  dockerLogsArgs,
  formatEvent,
  formatSessionRow,
  journalctlArgs,
  LOGS_USAGE,
  parseLogsArgs,
  runInherited,
  takeLast,
  untilInterrupted,
} from '@/admin/logs'

const SESSION_ID = '00000000-0000-4000-8000-000000000000'

function envelope(event: AgentEvent, seq = 1): EnvelopedEvent {
  return { seq, sessionId: SESSION_ID, ts: 1_700_000_000_000, event }
}

describe('parseLogsArgs', () => {
  it('defaults to the service journal, last 50 lines', () => {
    expect(parseLogsArgs([])).toEqual({
      target: 'service',
      sessionId: undefined,
      follow: false,
      lines: DEFAULT_LOG_LINES,
      linesSpecified: false,
      afterSeq: 0,
      afterSpecified: false,
      json: false,
    })
  })

  it('accepts -f / --follow and -n / --lines forms', () => {
    expect(parseLogsArgs(['-f'])).toMatchObject({ follow: true })
    expect(parseLogsArgs(['--follow'])).toMatchObject({ follow: true })
    expect(parseLogsArgs(['-n', '200'])).toMatchObject({ lines: 200, linesSpecified: true })
    expect(parseLogsArgs(['-n200'])).toMatchObject({ lines: 200, linesSpecified: true })
    expect(parseLogsArgs(['--lines', '10'])).toMatchObject({ lines: 10, linesSpecified: true })
    expect(parseLogsArgs(['--lines=10'])).toMatchObject({ lines: 10, linesSpecified: true })
  })

  it('parses session and docker targets, including flags around the id', () => {
    expect(parseLogsArgs(['session'])).toMatchObject({
      target: 'session',
      sessionId: undefined,
    })
    expect(parseLogsArgs(['session', SESSION_ID, '-f', '--json', '--after', '42'])).toEqual({
      target: 'session',
      sessionId: SESSION_ID,
      follow: true,
      lines: DEFAULT_LOG_LINES,
      linesSpecified: false,
      afterSeq: 42,
      afterSpecified: true,
      json: true,
    })
    expect(parseLogsArgs(['-f', 'docker', 'abc12345', '-n', '20'])).toMatchObject({
      target: 'docker',
      sessionId: 'abc12345',
      follow: true,
      lines: 20,
      linesSpecified: true,
    })
    expect(parseLogsArgs(['session', '--after=0'])).toMatchObject({
      target: 'session',
      afterSeq: 0,
      afterSpecified: true,
    })
  })

  it('rejects unknown flags, stray positionals, and session-only flags on other targets', () => {
    expect(() => parseLogsArgs(['--bogus'])).toThrow(ConfigError)
    expect(() => parseLogsArgs(['--bogus'])).toThrow(LOGS_USAGE)
    expect(() => parseLogsArgs(['nope'])).toThrow(LOGS_USAGE)
    expect(() => parseLogsArgs(['session', 'a', 'b'])).toThrow(LOGS_USAGE)
    expect(() => parseLogsArgs(['--json'])).toThrow(LOGS_USAGE)
    expect(() => parseLogsArgs(['docker', '--after', '1'])).toThrow(LOGS_USAGE)
    expect(() => parseLogsArgs(['-n'])).toThrow(LOGS_USAGE)
    expect(() => parseLogsArgs(['-n', '-f'])).toThrow(LOGS_USAGE)
    expect(() => parseLogsArgs(['-n', '0'])).toThrow(/invalid -n/)
    expect(() => parseLogsArgs(['--after', 'nope'])).toThrow(/invalid --after/)
  })
})

describe('journalctlArgs / dockerLogsArgs', () => {
  it('always disables the pager and pins the dukebox unit', () => {
    expect(journalctlArgs({ follow: false, lines: 50 })).toEqual([
      '--no-pager',
      '-u',
      'dukebox',
      '-n',
      '50',
    ])
    expect(journalctlArgs({ follow: true, lines: 200 }, 'dukebox')).toEqual([
      '--no-pager',
      '-u',
      'dukebox',
      '-n',
      '200',
      '-f',
    ])
  })

  it('asks docker for timestamps, a tail, and the container id last', () => {
    expect(dockerLogsArgs('abc', { follow: false, lines: 50 })).toEqual([
      'logs',
      '-t',
      '--tail',
      '50',
      'abc',
    ])
    expect(dockerLogsArgs('abc', { follow: true, lines: 10 })).toEqual([
      'logs',
      '-t',
      '--tail',
      '10',
      '-f',
      'abc',
    ])
  })
})

describe('formatEvent', () => {
  it('renders the main event types as seq, type, and a short summary', () => {
    expect(formatEvent(envelope({ type: 'user_prompt', text: 'Fix the login bug' }))).toBe(
      '1  user_prompt  Fix the login bug',
    )
    expect(formatEvent(envelope({ type: 'assistant_text', delta: 'Looking at auth.ts' }))).toBe(
      '1  assistant_text  Looking at auth.ts',
    )
    expect(
      formatEvent(envelope({ type: 'tool_call', id: 't1', name: 'Read', input: { path: 'a.ts' } })),
    ).toBe('1  tool_call  Read')
    expect(formatEvent(envelope({ type: 'error', message: 'agent exited', fatal: true }, 9))).toBe(
      '9  error  agent exited',
    )
    expect(formatEvent(envelope({ type: 'done', reason: 'completed' }, 12))).toBe(
      '12  done  completed',
    )
  })

  it('collapses whitespace and truncates long summaries', () => {
    const long = 'x'.repeat(100)
    const formatted = formatEvent(envelope({ type: 'user_prompt', text: `hello\n${long}` }))
    expect(formatted.startsWith('1  user_prompt  hello x')).toBe(true)
    expect(formatted.endsWith('…')).toBe(true)
    expect(formatted.length).toBeLessThan(120)
  })
})

describe('formatSessionRow / takeLast', () => {
  it('pads status and branch so columns line up', () => {
    const line = formatSessionRow({
      id: SESSION_ID,
      status: 'running',
      branch: 'duke/00000000',
      title: 'Fix login',
    })
    expect(line.startsWith(`${SESSION_ID}  running`)).toBe(true)
    expect(line).toContain('duke/00000000')
    expect(line.endsWith('Fix login')).toBe(true)
  })

  it('slices from the end only when a count is given', () => {
    expect(takeLast([1, 2, 3, 4], undefined)).toEqual([1, 2, 3, 4])
    expect(takeLast([1, 2, 3, 4], 2)).toEqual([3, 4])
  })
})

describe('runInherited / untilInterrupted', () => {
  it('spawns with inherited stdio and returns the exit code', async () => {
    const child = new EventEmitter()
    let spawned: { command: string; args: string[]; options: unknown } | undefined

    const code = await runInherited('journalctl', ['-n', '50'], ((command, args, options) => {
      spawned = { command, args, options }
      queueMicrotask(() => child.emit('close', 0, null))
      return child
    }) as typeof import('node:child_process').spawn)

    expect(code).toBe(0)
    expect(spawned).toEqual({
      command: 'journalctl',
      args: ['-n', '50'],
      options: { stdio: 'inherit' },
    })
  })

  it('resolves when the emitter fires an interrupt signal', async () => {
    const emitter = new EventEmitter()
    const done = untilInterrupted(emitter, ['SIGINT'])
    emitter.emit('SIGINT')
    await done
  })
})
