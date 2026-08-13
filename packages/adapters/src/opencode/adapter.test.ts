import type { AgentEvent } from '@dukebox/protocol'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { SessionContext } from '../types.js'
import { buildRunArgs, OpenCodeAdapter } from './adapter.js'

/**
 * These cover the parts that do not need a running agent: how the process is
 * invoked, and how the event stream behaves across turns. Driving a real
 * OpenCode needs credentials and is what the end-to-end verification covers.
 */

describe('buildRunArgs', () => {
  it('requests json output and auto-approves permissions', () => {
    const args = buildRunArgs({ text: 'hello' })

    expect(args[0]).toBe('run')
    expect(args).toContain('--format')
    expect(args[args.indexOf('--format') + 1]).toBe('json')
    expect(args).toContain('--auto')
    expect(args.at(-1)).toBe('hello')
  })

  it('omits --session for a new conversation', () => {
    expect(buildRunArgs({ text: 'hello' })).not.toContain('--session')
  })

  it('resumes a previous conversation when given an id', () => {
    const args = buildRunArgs({ text: 'again', sessionId: 'ses_abc' })
    expect(args[args.indexOf('--session') + 1]).toBe('ses_abc')
  })

  it('passes --model when the caller picks one', () => {
    const args = buildRunArgs({ text: 'hello', model: 'anthropic/claude-sonnet-4-5' })
    expect(args[args.indexOf('--model') + 1]).toBe('anthropic/claude-sonnet-4-5')
  })

  it('omits --model when none was chosen', () => {
    expect(buildRunArgs({ text: 'hello' })).not.toContain('--model')
  })

  it('attaches files before the prompt, so the prompt stays the last argument', () => {
    const args = buildRunArgs({ text: 'what is this', files: ['/tmp/a.png'] })

    expect(args[args.indexOf('--file') + 1]).toBe('/tmp/a.png')
    expect(args.at(-1)).toBe('what is this')
  })

  it('passes every staged upload as its own --file', () => {
    const args = buildRunArgs({
      text: 'review these',
      files: ['/tmp/imgs/image-0.png', '/tmp/imgs/spec.pdf'],
    })

    expect(args.filter((arg) => arg === '--file')).toHaveLength(2)
    expect(args).toContain('/tmp/imgs/image-0.png')
    expect(args).toContain('/tmp/imgs/spec.pdf')
    expect(args.at(-1)).toBe('review these')
  })

  it('keeps a multi-line prompt as a single argument', () => {
    const args = buildRunArgs({ text: 'first\nsecond' })
    expect(args.filter((arg) => arg.includes('first'))).toEqual(['first\nsecond'])
  })
})

describe('OpenCodeAdapter', () => {
  function adapterWithStream() {
    const stream = new PassThrough()
    const adapter = new OpenCodeAdapter()
    const consume = (
      adapter as unknown as { consumeTurn: (s: PassThrough, turnId: number) => void }
    ).consumeTurn.bind(adapter)

    consume(stream, 1)
    ;(adapter as unknown as { turn: number }).turn = 1
    ;(adapter as unknown as { stream: PassThrough }).stream = stream

    return { adapter, stream }
  }

  async function collectUntil(adapter: OpenCodeAdapter, count: number): Promise<AgentEvent[]> {
    const events: AgentEvent[] = []
    for await (const event of adapter.events()) {
      events.push(event)
      if (events.length >= count) break
    }
    return events
  }

  async function collect(adapter: OpenCodeAdapter): Promise<AgentEvent[]> {
    const events: AgentEvent[] = []
    for await (const event of adapter.events()) events.push(event)
    return events
  }

  it('reports capabilities the UI degrades on', () => {
    const adapter = new OpenCodeAdapter()

    expect(adapter.capabilities.resume).toBe(true)
    expect(adapter.capabilities.thinking).toBe(true)
    expect(adapter.capabilities.interrupt).toBe(true)
    expect(adapter.capabilities.permissions).toBe(false)
    expect(adapter.capabilities.permissionModes).toBe(false)
  })

  it('yields events parsed from the process output', async () => {
    const { adapter, stream } = adapterWithStream()

    stream.write(`${JSON.stringify({ type: 'step_start', sessionID: 'ses_1' })}\n`)
    stream.write(`${JSON.stringify({ type: 'text', sessionID: 'ses_1', part: { text: 'hi' } })}\n`)
    stream.end()

    const events = await collectUntil(adapter, 3)

    expect(events[0]).toMatchObject({ type: 'session_started', agentId: 'opencode' })
    expect(events).toContainEqual({ type: 'assistant_text', delta: 'hi' })
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'completed' })
  })

  it('exposes the agent session id for resuming', async () => {
    const { adapter, stream } = adapterWithStream()

    stream.write(`${JSON.stringify({ type: 'step_start', sessionID: 'ses_9' })}\n`)
    stream.end()
    await collectUntil(adapter, 2)

    expect(adapter.agentSessionId()).toBe('ses_9')
  })

  it('keeps the event stream open after a turn so a follow-up can run', async () => {
    const { adapter, stream } = adapterWithStream()
    const collected: AgentEvent[] = []
    const consuming = (async () => {
      for await (const event of adapter.events()) collected.push(event)
    })()

    stream.write(`${JSON.stringify({ type: 'step_start', sessionID: 'ses_1' })}\n`)
    stream.end()
    await vi.waitFor(() => expect(collected.at(-1)).toEqual({ type: 'done', reason: 'completed' }))

    const second = new PassThrough()
    const consume = (
      adapter as unknown as { consumeTurn: (s: PassThrough, turnId: number) => void }
    ).consumeTurn.bind(adapter)
    ;(adapter as unknown as { turn: number }).turn = 2
    ;(adapter as unknown as { sawDone: boolean }).sawDone = false
    consume(second, 2)

    second.write(
      `${JSON.stringify({ type: 'text', sessionID: 'ses_1', part: { text: 'again' } })}\n`,
    )
    second.end()
    await vi.waitFor(() =>
      expect(collected).toContainEqual({ type: 'assistant_text', delta: 'again' }),
    )

    await adapter.stop()
    await consuming
  })

  it('emits done with interrupted when the current run is cancelled', async () => {
    const { adapter } = adapterWithStream()
    const collected: AgentEvent[] = []
    const consuming = (async () => {
      for await (const event of adapter.events()) collected.push(event)
    })()

    await adapter.interrupt()
    await vi.waitFor(() =>
      expect(collected.at(-1)).toEqual({ type: 'done', reason: 'interrupted' }),
    )

    await adapter.stop()
    await consuming
  })

  it('reports malformed output without ending the session', async () => {
    const { adapter, stream } = adapterWithStream()

    stream.write('this is not json\n')
    stream.write(`${JSON.stringify({ type: 'step_start', sessionID: 'ses_1' })}\n`)
    stream.end()

    const events = await collectUntil(adapter, 3)

    expect(events[0]).toMatchObject({ type: 'error', fatal: false })
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'session_started', agentId: 'opencode' }),
    )
  })

  it('ends the turn when the process dies mid-stream', async () => {
    const { adapter, stream } = adapterWithStream()

    stream.write(`${JSON.stringify({ type: 'step_start', sessionID: 's' })}\n`)
    stream.end()

    const events = await collectUntil(adapter, 2)
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'completed' })
  })

  it('surfaces a stream error as fatal', async () => {
    const { adapter, stream } = adapterWithStream()

    stream.emit('error', new Error('connection lost'))

    const events = await collectUntil(adapter, 2)
    expect(events[0]).toMatchObject({ type: 'error', message: 'connection lost', fatal: true })
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'error' })
  })

  it('rejects send before start', async () => {
    await expect(new OpenCodeAdapter().send({ text: 'hi' })).rejects.toThrow('not started')
  })

  it('treats a permission response as a no-op', async () => {
    await expect(new OpenCodeAdapter().respondToPermission('id', true)).resolves.toBeUndefined()
  })

  it('ends the event stream on stop', async () => {
    const { adapter } = adapterWithStream()

    await adapter.stop()
    expect(await collect(adapter)).toEqual([])
  })

  it('does not attach stdin, so OpenCode does not wait for EOF before starting', async () => {
    const execStream = vi.fn(async () => new PassThrough())
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    const adapter = new OpenCodeAdapter()

    await adapter.start({
      sessionId: 'session-1',
      workingDir: '/workspace/repo',
      container: { exec, execStream } as unknown as SessionContext['container'],
    })

    await adapter.send({ text: 'hello' })

    expect(execStream.mock.calls[0]?.[1]).toEqual({ cwd: '/workspace/repo', stdin: false })
  })

  it('invokes opencode run with the prompt and model', async () => {
    const execStream = vi.fn(async () => new PassThrough())
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    const adapter = new OpenCodeAdapter()

    await adapter.start({
      sessionId: 'session-1',
      workingDir: '/workspace/repo',
      model: 'anthropic/claude-sonnet-4-5',
      container: { exec, execStream } as unknown as SessionContext['container'],
    })

    await adapter.send({ text: 'hello' })

    expect(execStream).toHaveBeenCalledWith(
      [
        'opencode',
        'run',
        '--format',
        'json',
        '--auto',
        '--model',
        'anthropic/claude-sonnet-4-5',
        'hello',
      ],
      { cwd: '/workspace/repo', stdin: false },
    )
  })

  it('passes --session on a follow-up after the id is known', async () => {
    const first = new PassThrough()
    const second = new PassThrough()
    const execStream = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    const adapter = new OpenCodeAdapter()

    await adapter.start({
      sessionId: 'session-1',
      workingDir: '/workspace/repo',
      container: { exec, execStream } as unknown as SessionContext['container'],
    })

    await adapter.send({ text: 'first' })
    first.write(`${JSON.stringify({ type: 'step_start', sessionID: 'ses_live' })}\n`)
    first.end()
    await collectUntil(adapter, 2)

    await adapter.send({ text: 'second' })

    const [command] = execStream.mock.calls[1] as unknown as [string[], unknown]
    expect(command).toEqual(expect.arrayContaining(['--session', 'ses_live', 'second']))
  })

  it('resumes with the stored session id on the first send', async () => {
    const execStream = vi.fn(async () => new PassThrough())
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    const adapter = new OpenCodeAdapter()

    await adapter.start({
      sessionId: 'session-1',
      workingDir: '/workspace/repo',
      resumeFrom: 'ses_prior',
      container: { exec, execStream } as unknown as SessionContext['container'],
    })

    await adapter.send({ text: 'continue' })

    expect(execStream.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining(['--session', 'ses_prior', 'continue']),
    )
  })

  it('stages images and files into /tmp/imgs and passes them as --file', async () => {
    const stream = new PassThrough()
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    const execStream = vi.fn(async () => stream)
    const adapter = new OpenCodeAdapter()

    await adapter.start({
      sessionId: 'session-1',
      workingDir: '/workspace/repo',
      container: { exec, execStream } as unknown as SessionContext['container'],
    })

    await adapter.send({
      text: 'review these',
      images: ['data:image/png;base64,QUFB'],
      files: [{ name: 'spec.pdf', data: 'data:application/pdf;base64,REVF' }],
    })

    expect(exec).toHaveBeenCalledWith(
      [
        'sh',
        '-c',
        'mkdir -p /tmp/imgs && printf \'%s\' "$DUKEBOX_FILE" | base64 -d > /tmp/imgs/image-0.png',
      ],
      { env: { DUKEBOX_FILE: 'QUFB' } },
    )
    expect(exec).toHaveBeenCalledWith(
      [
        'sh',
        '-c',
        'mkdir -p /tmp/imgs && printf \'%s\' "$DUKEBOX_FILE" | base64 -d > /tmp/imgs/spec.pdf',
      ],
      { env: { DUKEBOX_FILE: 'REVF' } },
    )

    const [command] = execStream.mock.calls[0] as unknown as [string[], unknown]
    expect(command).toEqual(
      expect.arrayContaining(['--file', '/tmp/imgs/image-0.png', '--file', '/tmp/imgs/spec.pdf']),
    )
  })

  it('writes auth.json into the container on start', async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    const adapter = new OpenCodeAdapter()

    await adapter.start({
      sessionId: 'session-1',
      workingDir: '/workspace/repo',
      instructions: 'Always typecheck.',
      container: { exec, execStream: vi.fn() } as unknown as SessionContext['container'],
    })

    expect(exec).toHaveBeenCalled()
    const first = exec.mock.calls[0]?.[0] as string[]
    expect(first.join(' ')).toContain('DUKEBOX_OPENCODE_AUTH_JSON')
    expect(first.join(' ')).toContain('/home/node/.local/share/opencode/auth.json')

    const second = exec.mock.calls[1]
    expect(second?.[0]).toEqual(
      expect.arrayContaining([expect.stringContaining('DUKEBOX_OPENCODE_INSTRUCTIONS')]),
    )
  })
})
