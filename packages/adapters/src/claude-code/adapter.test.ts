import type { AgentEvent } from '@dukebox/protocol'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { SessionContext } from '../types.js'
import { buildArgs, ClaudeCodeAdapter, encodeUserMessage } from './adapter.js'

/**
 * These cover the parts that do not need a running agent: how the process is
 * invoked, how input is encoded, and how the event stream behaves when the
 * process misbehaves. Driving a real agent needs credentials and is what the
 * end-to-end verification covers.
 */

function contextWith(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    sessionId: 'session-1',
    workingDir: '/workspace/repo',
    container: {} as SessionContext['container'],
    ...overrides,
  }
}

describe('buildArgs', () => {
  it('requests stream-json in both directions', () => {
    const args = buildArgs(contextWith())

    expect(args).toContain('--print')
    expect(args.join(' ')).toContain('--output-format stream-json')
    expect(args.join(' ')).toContain('--input-format stream-json')
  })

  it('passes --verbose, without which tool calls are omitted', () => {
    // The entire UI is built around tool calls and results; stream-json drops
    // them unless this is set.
    expect(buildArgs(contextWith())).toContain('--verbose')
  })

  it('runs in acceptEdits mode, since the container is the safety boundary', () => {
    const args = buildArgs(contextWith())
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits')
  })

  it('omits --resume for a new session', () => {
    expect(buildArgs(contextWith())).not.toContain('--resume')
  })

  it('resumes a previous conversation when given an id', () => {
    const args = buildArgs(contextWith({ resumeFrom: 'abc-123' }))
    expect(args[args.indexOf('--resume') + 1]).toBe('abc-123')
  })

  it('appends project instructions to the system prompt', () => {
    const args = buildArgs(contextWith({ instructions: 'Always run typecheck.' }))
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('Always run typecheck.')
  })

  it('omits the system prompt flag when there are no instructions', () => {
    expect(buildArgs(contextWith())).not.toContain('--append-system-prompt')
  })
})

describe('encodeUserMessage', () => {
  it('encodes text as a single JSON line', () => {
    const encoded = encodeUserMessage({ text: 'hello' })

    expect(encoded.endsWith('\n')).toBe(true)
    expect(JSON.parse(encoded)).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    })
  })

  it('emits exactly one line, so multi-line text cannot split the message', () => {
    const encoded = encodeUserMessage({ text: 'first\nsecond' })
    expect(encoded.trimEnd().split('\n')).toHaveLength(1)
  })

  it('attaches images alongside the text', () => {
    const encoded = encodeUserMessage({
      text: 'what is this',
      images: ['data:image/png;base64,AAAA'],
    })

    expect(JSON.parse(encoded).message.content).toEqual([
      { type: 'text', text: 'what is this' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ])
  })

  it('skips an image that is not a data URI rather than sending garbage', () => {
    const encoded = encodeUserMessage({
      text: 'look',
      images: ['https://example.com/image.png'],
    })

    expect(JSON.parse(encoded).message.content).toHaveLength(1)
  })
})

describe('ClaudeCodeAdapter', () => {
  /** Drive the adapter from a stream we control, standing in for the process. */
  function adapterWithStream() {
    const stream = new PassThrough()
    const adapter = new ClaudeCodeAdapter()

    // start() needs a container; feeding the stream directly exercises the
    // same consume path without one.
    const consume = (adapter as unknown as { consume: (s: PassThrough) => void }).consume.bind(
      adapter,
    )
    consume(stream)

    return { adapter, stream }
  }

  async function collect(adapter: ClaudeCodeAdapter): Promise<AgentEvent[]> {
    const events: AgentEvent[] = []
    for await (const event of adapter.events()) events.push(event)
    return events
  }

  it('reports capabilities the UI degrades on', () => {
    const adapter = new ClaudeCodeAdapter()

    expect(adapter.capabilities.resume).toBe(true)
    expect(adapter.capabilities.thinking).toBe(true)
    // acceptEdits means the agent never asks, so no approval card is shown.
    expect(adapter.capabilities.permissions).toBe(false)
  })

  it('yields events parsed from the process output', async () => {
    const { adapter, stream } = adapterWithStream()

    stream.write(
      `${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-opus-5' })}\n`,
    )
    stream.write(`${JSON.stringify({ type: 'result', subtype: 'success' })}\n`)
    stream.end()

    const events = await collect(adapter)

    expect(events[0]).toMatchObject({ type: 'session_started', model: 'claude-opus-5' })
    expect(events).toContainEqual({ type: 'done', reason: 'completed' })
  })

  it('exposes the agent session id for resuming', async () => {
    const { adapter, stream } = adapterWithStream()

    stream.write(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-9' })}\n`)
    stream.end()
    await collect(adapter)

    expect(adapter.agentSessionId()).toBe('sess-9')
  })

  it('reassembles a message split across chunks', async () => {
    const { adapter, stream } = adapterWithStream()

    stream.write('{"type":"system","subtype":"init","sess')
    stream.write('ion_id":"sess-2"}\n')
    stream.end()

    const events = await collect(adapter)
    expect(events[0]).toMatchObject({ type: 'session_started' })
  })

  it('reports malformed output without ending the session', async () => {
    const { adapter, stream } = adapterWithStream()

    stream.write('this is not json\n')
    stream.write(`${JSON.stringify({ type: 'result', subtype: 'success' })}\n`)
    stream.end()

    const events = await collect(adapter)

    expect(events[0]).toMatchObject({ type: 'error', fatal: false })
    // The session carried on and still finished.
    expect(events).toContainEqual({ type: 'done', reason: 'completed' })
  })

  it('ends the turn when the process dies mid-stream', async () => {
    const { adapter, stream } = adapterWithStream()

    stream.write(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' })}\n`)
    // No result message: the process was killed. Without a synthesized done,
    // the consumer would wait forever for a turn that is already over.
    stream.end()

    const events = await collect(adapter)
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'error' })
  })

  it('surfaces a stream error as fatal', async () => {
    const { adapter, stream } = adapterWithStream()

    stream.emit('error', new Error('connection lost'))

    const events = await collect(adapter)
    expect(events[0]).toMatchObject({ type: 'error', message: 'connection lost', fatal: true })
  })

  it('buffers events emitted before anyone is listening', async () => {
    const { adapter, stream } = adapterWithStream()

    // The process starts producing output the moment it launches, which is
    // before the caller has begun iterating.
    stream.write(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' })}\n`)
    stream.write(`${JSON.stringify({ type: 'result', subtype: 'success' })}\n`)
    stream.end()

    await new Promise((resolve) => setTimeout(resolve, 10))

    const events = await collect(adapter)
    expect(events.map((event) => event.type)).toEqual(['session_started', 'done'])
  })

  it('emits done exactly once when the agent reports it', async () => {
    const { adapter, stream } = adapterWithStream()

    // The stream also ends after a result message. Synthesizing a second done
    // there would have the UI close the same turn twice.
    stream.write(`${JSON.stringify({ type: 'result', subtype: 'success' })}\n`)
    stream.end()

    const events = await collect(adapter)
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1)
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'completed' })
  })

  it('rejects send before start', async () => {
    await expect(new ClaudeCodeAdapter().send({ text: 'hi' })).rejects.toThrow('not started')
  })

  it('treats a permission response as a no-op', async () => {
    // Callers should not have to branch on capabilities to answer a prompt
    // that this agent never sends.
    await expect(new ClaudeCodeAdapter().respondToPermission('id', true)).resolves.toBeUndefined()
  })

  it('ends the event stream on stop', async () => {
    const { adapter } = adapterWithStream()

    await adapter.stop()
    expect(await collect(adapter)).toEqual([])
  })
})
