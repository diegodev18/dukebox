import type { AgentEvent } from '@dukebox/protocol'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { SessionContext } from '@/types'
import {
  buildGrokRunArgs,
  grokBuildContainerEnv,
  GrokBuildAdapter,
  GROK_AUTH_ENV,
  GROK_HOME_DIR,
  GROK_PLAN_DISALLOWED_TOOLS,
  GROK_PLAN_RULES,
} from '@/grok-build/adapter'

/**
 * These cover the parts that do not need a running agent: how the process is
 * invoked, and how the event stream behaves across turns. Driving a real
 * Grok Build needs credentials and is what the end-to-end verification covers.
 */

describe('buildGrokRunArgs', () => {
  it('requests streaming-json output and auto-approves permissions', () => {
    const args = buildGrokRunArgs({ text: 'hello' })

    expect(args[0]).toBe('-p')
    expect(args[1]).toBe('hello')
    expect(args).toContain('--output-format')
    expect(args[args.indexOf('--output-format') + 1]).toBe('streaming-json')
    expect(args).toContain('--yolo')
    expect(args).toContain('--no-plan')
    expect(args).toContain('--no-auto-update')
  })

  it('omits --resume for a new conversation', () => {
    expect(buildGrokRunArgs({ text: 'hello' })).not.toContain('--resume')
  })

  it('resumes a previous conversation when given an id', () => {
    const args = buildGrokRunArgs({ text: 'again', sessionId: 'ses_abc' })
    expect(args[args.indexOf('--resume') + 1]).toBe('ses_abc')
  })

  it('passes -m when the caller picks a model', () => {
    const args = buildGrokRunArgs({ text: 'hello', model: 'grok-4.6' })
    expect(args[args.indexOf('-m') + 1]).toBe('grok-4.6')
  })

  it('omits -m when none was chosen', () => {
    expect(buildGrokRunArgs({ text: 'hello' })).not.toContain('-m')
  })

  it('keeps a multi-line prompt as a single argument', () => {
    const args = buildGrokRunArgs({ text: 'first\nsecond' })
    expect(args.filter((arg) => arg.includes('first'))).toEqual(['first\nsecond'])
  })

  it('keeps --yolo in plan and blocks edit tools instead of --permission-mode plan', () => {
    const args = buildGrokRunArgs({ text: 'hello', permissionMode: 'plan' })

    expect(args).toContain('--yolo')
    expect(args).toContain('--no-plan')
    expect(args).not.toContain('--permission-mode')
    expect(args[args.indexOf('--disallowed-tools') + 1]).toBe(GROK_PLAN_DISALLOWED_TOOLS)
    expect(args[args.indexOf('--rules') + 1]).toBe(GROK_PLAN_RULES)
  })

  it('prepends the plan rule ahead of session instructions', () => {
    const args = buildGrokRunArgs({
      text: 'hello',
      permissionMode: 'plan',
      instructions: 'Always typecheck.',
    })

    expect(args[args.indexOf('--rules') + 1]).toBe(`${GROK_PLAN_RULES}\n\nAlways typecheck.`)
  })

  it('does not select plan for the other modes', () => {
    for (const mode of ['bypass', 'auto', 'acceptEdits'] as const) {
      const args = buildGrokRunArgs({ text: 'hello', permissionMode: mode })
      expect(args).toContain('--yolo')
      expect(args).not.toContain('--permission-mode')
      expect(args).not.toContain('--disallowed-tools')
    }
  })

  it('passes --rules when the session has instructions', () => {
    const args = buildGrokRunArgs({ text: 'hello', instructions: 'Always typecheck.' })
    expect(args[args.indexOf('--rules') + 1]).toBe('Always typecheck.')
  })
})

describe('grokBuildContainerEnv', () => {
  it('sets HOME and GROK_HOME so grok can find auth.json without a login shell', () => {
    const env = grokBuildContainerEnv({})

    expect(env.HOME).toBe('/home/node')
    expect(env.GROK_HOME).toBe(GROK_HOME_DIR)
    expect(env.GROK_DISABLE_AUTOUPDATER).toBe('1')
  })

  it('injects a subscription session and an API key when both exist', () => {
    const env = grokBuildContainerEnv({
      apiKey: 'xai-test',
      authJson: '{"https://auth.x.ai":{"key":"sess"}}',
    })

    expect(env.XAI_API_KEY).toBe('xai-test')
    expect(env[GROK_AUTH_ENV]).toBe('{"https://auth.x.ai":{"key":"sess"}}')
  })

  it('omits credentials that were never set', () => {
    const env = grokBuildContainerEnv({ apiKey: null, authJson: null })

    expect(env.XAI_API_KEY).toBeUndefined()
    expect(env[GROK_AUTH_ENV]).toBeUndefined()
  })
})

describe('GrokBuildAdapter', () => {
  function adapterWithStream() {
    const stream = new PassThrough()
    const adapter = new GrokBuildAdapter()
    const consume = (
      adapter as unknown as { consumeTurn: (s: PassThrough, turnId: number) => void }
    ).consumeTurn.bind(adapter)

    consume(stream, 1)
    ;(adapter as unknown as { turn: number }).turn = 1
    ;(adapter as unknown as { stream: PassThrough }).stream = stream

    return { adapter, stream }
  }

  async function collectUntil(adapter: GrokBuildAdapter, count: number): Promise<AgentEvent[]> {
    const events: AgentEvent[] = []
    for await (const event of adapter.events()) {
      events.push(event)
      if (events.length >= count) break
    }
    return events
  }

  async function collect(adapter: GrokBuildAdapter): Promise<AgentEvent[]> {
    const events: AgentEvent[] = []
    for await (const event of adapter.events()) events.push(event)
    return events
  }

  it('reports capabilities the UI degrades on', () => {
    const adapter = new GrokBuildAdapter()

    expect(adapter.id).toBe('grok-build')
    expect(adapter.capabilities.resume).toBe(true)
    expect(adapter.capabilities.thinking).toBe(true)
    expect(adapter.capabilities.interrupt).toBe(true)
    expect(adapter.capabilities.permissions).toBe(false)
    expect(adapter.capabilities.permissionModes).toBe(true)
  })

  it('yields events parsed from the process output', async () => {
    const { adapter, stream } = adapterWithStream()

    stream.write(`${JSON.stringify({ type: 'text', data: 'hi' })}\n`)
    stream.write(`${JSON.stringify({ type: 'end', sessionId: 'ses_1' })}\n`)
    stream.end()

    const events = await collectUntil(adapter, 3)

    expect(events[0]).toMatchObject({ type: 'session_started', agentId: 'grok-build' })
    expect(events).toContainEqual({ type: 'assistant_text', delta: 'hi' })
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'completed' })
  })

  it('exposes the agent session id for resuming', async () => {
    const { adapter, stream } = adapterWithStream()

    stream.write(`${JSON.stringify({ type: 'end', sessionId: 'ses_9' })}\n`)
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

    stream.write(`${JSON.stringify({ type: 'text', data: 'first' })}\n`)
    stream.end()
    await vi.waitFor(() => expect(collected.at(-1)).toEqual({ type: 'done', reason: 'completed' }))

    const second = new PassThrough()
    const consume = (
      adapter as unknown as { consumeTurn: (s: PassThrough, turnId: number) => void }
    ).consumeTurn.bind(adapter)
    ;(adapter as unknown as { turn: number }).turn = 2
    ;(adapter as unknown as { sawDone: boolean }).sawDone = false
    consume(second, 2)

    second.write(`${JSON.stringify({ type: 'text', data: 'again' })}\n`)
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
    stream.write(`${JSON.stringify({ type: 'text', data: 'ok' })}\n`)
    stream.end()

    const events = await collectUntil(adapter, 3)

    expect(events[0]).toMatchObject({ type: 'error', fatal: false })
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'session_started', agentId: 'grok-build' }),
    )
  })

  it('surfaces a stream error as fatal', async () => {
    const { adapter, stream } = adapterWithStream()

    stream.emit('error', new Error('connection lost'))

    const events = await collectUntil(adapter, 2)
    expect(events[0]).toMatchObject({ type: 'error', message: 'connection lost', fatal: true })
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'error' })
  })

  it('rejects send before start', async () => {
    await expect(new GrokBuildAdapter().send({ text: 'hi' })).rejects.toThrow('not started')
  })

  it('surfaces a failed credential refresh as a fatal error instead of starting grok', async () => {
    const execStream = vi.fn(async () => new PassThrough())
    const adapter = new GrokBuildAdapter()
    const expired =
      'Grok is not signed in. Open Settings and sign in again with the device code. The saved session expired and could not be renewed.'
    let loads = 0

    await adapter.start({
      sessionId: 'session-1',
      workingDir: '/workspace/repo',
      container: {
        exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
        execStream,
      } as unknown as SessionContext['container'],
      grokAuth: {
        load: async () => {
          loads += 1
          if (loads > 1) throw new Error(expired)
          return '{"https://auth.x.ai":{"key":"ok"}}'
        },
        persist: async () => {},
      },
    })

    await adapter.send({ text: 'hello' })

    expect(execStream).not.toHaveBeenCalled()
    const events = await collectUntil(adapter, 3)
    expect(events).toContainEqual({ type: 'error', message: expired, fatal: true })
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'error' })
  })

  it('treats a permission response as a no-op', async () => {
    await expect(new GrokBuildAdapter().respondToPermission('id', true)).resolves.toBeUndefined()
  })

  it('ends the event stream on stop', async () => {
    const { adapter } = adapterWithStream()

    await adapter.stop()
    expect(await collect(adapter)).toEqual([])
  })

  it('writes auth.json into the container on start', async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    const adapter = new GrokBuildAdapter()

    await adapter.start({
      sessionId: 'session-1',
      workingDir: '/workspace/repo',
      container: { exec, execStream: vi.fn() } as unknown as SessionContext['container'],
    })

    expect(exec).toHaveBeenCalled()
    const first = exec.mock.calls[0]?.[0] as string[]
    expect(first.join(' ')).toContain('DUKEBOX_GROK_AUTH_JSON')
    expect(first.join(' ')).toContain('GROK_HOME')
    expect(first.join(' ')).toContain(GROK_HOME_DIR)
  })

  it('writes the latest stored auth.json via stdin when grokAuth is provided', async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    const load = vi.fn(async () => '{"https://auth.x.ai":{"key":"fresh","refresh_token":"r"}}')
    const persist = vi.fn(async () => {})
    const adapter = new GrokBuildAdapter()

    await adapter.start({
      sessionId: 'session-1',
      workingDir: '/workspace/repo',
      container: { exec, execStream: vi.fn() } as unknown as SessionContext['container'],
      grokAuth: { load, persist },
    })

    expect(load).toHaveBeenCalled()
    expect(exec).toHaveBeenCalledWith(
      ['sh', '-c', expect.stringContaining('cat > "$home/auth.json"')],
      { stdin: '{"https://auth.x.ai":{"key":"fresh","refresh_token":"r"}}' },
    )
    expect(persist).not.toHaveBeenCalled()
  })

  it('persists a newer auth.json Grok wrote during the turn', async () => {
    const store =
      '{"https://auth.x.ai::cli":{"key":"old","refresh_token":"keep","expires_at":"2026-08-15T10:00:00Z"}}'
    const rotated =
      '{"https://auth.x.ai::cli":{"key":"new","refresh_token":"next","expires_at":"2026-08-15T16:00:00Z"}}'
    let turnStarted = false
    const stream = new PassThrough()
    const exec = vi.fn(async (cmd: string[]) => {
      const joined = cmd.join(' ')
      if (joined.includes('auth.json') && !joined.includes('cat >') && turnStarted) {
        return { exitCode: 0, stdout: rotated, stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    })
    const execStream = vi.fn(async () => {
      turnStarted = true
      return stream
    })
    const persist = vi.fn(async () => {})
    const adapter = new GrokBuildAdapter()

    await adapter.start({
      sessionId: 'session-1',
      workingDir: '/workspace/repo',
      container: { exec, execStream } as unknown as SessionContext['container'],
      grokAuth: { load: async () => store, persist },
    })

    await adapter.send({ text: 'hello' })
    stream.end()

    await vi.waitFor(() => expect(persist).toHaveBeenCalled())
    const written = persist.mock.calls[0]?.[0] as string
    expect(written).toContain('"key":"new"')
    expect(written).toContain('"refresh_token":"next"')
  })

  it('does not attach stdin', async () => {
    const execStream = vi.fn(async () => new PassThrough())
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    const adapter = new GrokBuildAdapter()

    await adapter.start({
      sessionId: 'session-1',
      workingDir: '/workspace/repo',
      container: { exec, execStream } as unknown as SessionContext['container'],
    })

    await adapter.send({ text: 'hello' })

    expect(execStream.mock.calls[0]?.[1]).toEqual({ cwd: '/workspace/repo', stdin: false })
  })

  it('invokes grok -p with the prompt and model', async () => {
    const execStream = vi.fn(async () => new PassThrough())
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    const adapter = new GrokBuildAdapter()

    await adapter.start({
      sessionId: 'session-1',
      workingDir: '/workspace/repo',
      model: 'grok-4.6',
      container: { exec, execStream } as unknown as SessionContext['container'],
    })

    await adapter.send({ text: 'hello' })

    expect(execStream).toHaveBeenCalledWith(
      [
        'grok',
        '-p',
        'hello',
        '--output-format',
        'streaming-json',
        '--no-auto-update',
        '--yolo',
        '--no-plan',
        '-m',
        'grok-4.6',
      ],
      { cwd: '/workspace/repo', stdin: false },
    )
  })

  it('passes --resume on a follow-up after the id is known', async () => {
    const first = new PassThrough()
    const second = new PassThrough()
    const execStream = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    const adapter = new GrokBuildAdapter()

    await adapter.start({
      sessionId: 'session-1',
      workingDir: '/workspace/repo',
      container: { exec, execStream } as unknown as SessionContext['container'],
    })

    await adapter.send({ text: 'first' })
    first.write(`${JSON.stringify({ type: 'end', sessionId: 'ses_live' })}\n`)
    first.end()
    await collectUntil(adapter, 2)

    await adapter.send({ text: 'second' })

    const [command] = execStream.mock.calls[1] as unknown as [string[], unknown]
    expect(command).toEqual(expect.arrayContaining(['--resume', 'ses_live']))
    expect(command).toContain('second')
  })

  it('resumes with the stored session id on the first send', async () => {
    const execStream = vi.fn(async () => new PassThrough())
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    const adapter = new GrokBuildAdapter()

    await adapter.start({
      sessionId: 'session-1',
      workingDir: '/workspace/repo',
      resumeFrom: 'ses_prior',
      container: { exec, execStream } as unknown as SessionContext['container'],
    })

    await adapter.send({ text: 'continue' })

    expect(execStream.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining(['--resume', 'ses_prior', 'continue']),
    )
  })

  it('stages images and files into /tmp/imgs and names them in the prompt', async () => {
    const stream = new PassThrough()
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    const execStream = vi.fn(async () => stream)
    const adapter = new GrokBuildAdapter()

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
      ['sh', '-c', 'mkdir -p /tmp/imgs && base64 -d > /tmp/imgs/image-0.png'],
      { stdin: 'QUFB' },
    )
    expect(exec).toHaveBeenCalledWith(
      ['sh', '-c', 'mkdir -p /tmp/imgs && base64 -d > /tmp/imgs/spec.pdf'],
      { stdin: 'REVF' },
    )

    const [command] = execStream.mock.calls[0] as unknown as [string[], unknown]
    const prompt = command[2]
    expect(prompt).toContain('review these')
    expect(prompt).toContain('[Attached file: /tmp/imgs/image-0.png]')
    expect(prompt).toContain('[Attached file: /tmp/imgs/spec.pdf]')
  })

  it('passes --rules from session instructions', async () => {
    const execStream = vi.fn(async () => new PassThrough())
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    const adapter = new GrokBuildAdapter()

    await adapter.start({
      sessionId: 'session-1',
      workingDir: '/workspace/repo',
      instructions: 'Always typecheck.',
      container: { exec, execStream } as unknown as SessionContext['container'],
    })

    await adapter.send({ text: 'hello' })

    expect(execStream.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining(['--rules', 'Always typecheck.']),
    )
  })

  it('emits the session permission mode on start, defaulting to bypass', async () => {
    const adapter = new GrokBuildAdapter()

    await adapter.start({
      sessionId: 'session-1',
      workingDir: '/workspace/repo',
      permissionMode: 'plan',
      container: {
        exec: vi.fn(),
        execStream: vi.fn(),
      } as unknown as SessionContext['container'],
    })

    const events = await collectUntil(adapter, 1)
    expect(events[0]).toEqual({ type: 'permission_mode', mode: 'plan' })
  })

  it('runs the first send under the mode from start', async () => {
    const execStream = vi.fn(async () => new PassThrough())
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    const adapter = new GrokBuildAdapter()

    await adapter.start({
      sessionId: 'session-1',
      workingDir: '/workspace/repo',
      permissionMode: 'plan',
      container: { exec, execStream } as unknown as SessionContext['container'],
    })

    await adapter.send({ text: 'hello' })

    expect(execStream.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining(['--yolo', '--disallowed-tools', GROK_PLAN_DISALLOWED_TOOLS, 'hello']),
    )
  })

  it('applies a mid-session mode change to the next run', async () => {
    const first = new PassThrough()
    const second = new PassThrough()
    const execStream = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    const adapter = new GrokBuildAdapter()
    const collected: AgentEvent[] = []
    const consuming = (async () => {
      for await (const event of adapter.events()) collected.push(event)
    })()

    await adapter.start({
      sessionId: 'session-1',
      workingDir: '/workspace/repo',
      container: { exec, execStream } as unknown as SessionContext['container'],
    })

    await adapter.send({ text: 'first' })
    first.write(`${JSON.stringify({ type: 'end', sessionId: 'ses_live' })}\n`)
    first.end()
    await vi.waitFor(() =>
      expect(collected).toContainEqual({ type: 'permission_mode', mode: 'bypass' }),
    )

    await adapter.setPermissionMode('plan')
    await adapter.send({ text: 'second' })

    const [command] = execStream.mock.calls[1] as unknown as [string[], unknown]
    expect(command).toEqual(
      expect.arrayContaining(['--yolo', '--disallowed-tools', GROK_PLAN_DISALLOWED_TOOLS]),
    )
    expect(command).toContain('second')

    second.end()
    await adapter.stop()
    await consuming
  })
})
