import type { AgentEvent } from '@dukebox/protocol'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { JsonlReader } from '../jsonl.js'
import { ClaudeCodeMapper } from './mapper.js'

/**
 * Tests against real recordings of `claude --output-format stream-json`.
 *
 * Recorded with the version pinned in images/base-node. Written from what the
 * agent actually emits rather than from documentation: the real stream carries
 * message types no published schema mentions, and fields that are nullable in
 * practice but not in theory.
 */

function loadFixture(name: string): unknown[] {
  const path = fileURLToPath(new URL(`../../fixtures/${name}.jsonl`, import.meta.url))
  const reader = new JsonlReader()
  return [...reader.push(readFileSync(path, 'utf8')), ...reader.flush()]
}

function mapFixture(name: string): { events: AgentEvent[]; mapper: ClaudeCodeMapper } {
  const mapper = new ClaudeCodeMapper()
  const events = loadFixture(name).flatMap((message) => mapper.map(message))
  return { events, mapper }
}

function typesOf(events: AgentEvent[]): string[] {
  return events.map((event) => event.type)
}

describe('ClaudeCodeMapper', () => {
  describe('text-only', () => {
    it('opens with session_started and ends with done', () => {
      const { events } = mapFixture('text-only')

      expect(events[0]).toMatchObject({ type: 'session_started', agentId: 'claude-code' })
      expect(events.at(-1)).toEqual({ type: 'done', reason: 'completed' })
    })

    it('reports the model so the UI can show it', () => {
      const { events } = mapFixture('text-only')
      expect(events[0]).toMatchObject({ model: expect.stringContaining('claude') })
    })

    it('emits the assistant text', () => {
      const { events } = mapFixture('text-only')
      const text = events
        .filter((event) => event.type === 'assistant_text')
        .map((event) => event.delta)
        .join('')

      expect(text.toLowerCase()).toContain('hello')
    })

    it('emits the permission mode recorded on init', () => {
      const { events } = mapFixture('text-only')
      expect(events).toContainEqual({ type: 'permission_mode', mode: 'acceptEdits' })
    })

    it('emits no tool calls', () => {
      const { events } = mapFixture('text-only')
      expect(typesOf(events)).not.toContain('tool_call')
    })

    it('captures a session id for resuming', () => {
      const { mapper } = mapFixture('text-only')
      expect(mapper.agentSessionId).toMatch(/^[0-9a-f-]{36}$/)
    })

    it('discards hook lifecycle noise', () => {
      // Six hook messages precede init in every recording. They describe the
      // agent's own internals and mean nothing to a session.
      const { events } = mapFixture('text-only')
      expect(events.filter((event) => event.type === 'session_started')).toHaveLength(1)
    })

    it('emits exactly one done event', () => {
      const { events } = mapFixture('text-only')
      expect(events.filter((event) => event.type === 'done')).toHaveLength(1)
    })
  })

  describe('tool-calls', () => {
    it('pairs every tool_call with a tool_result carrying the same id', () => {
      const { events } = mapFixture('tool-calls')

      const callIds = events.filter((event) => event.type === 'tool_call').map((event) => event.id)
      const resultIds = events
        .filter((event) => event.type === 'tool_result')
        .map((event) => event.id)

      expect(callIds.length).toBeGreaterThan(0)
      expect(resultIds).toEqual(callIds)
    })

    it('names the tools that ran', () => {
      const { events } = mapFixture('tool-calls')
      const names = events.filter((event) => event.type === 'tool_call').map((event) => event.name)

      expect(names).toContain('Read')
    })

    it('preserves tool input for the UI to render', () => {
      const { events } = mapFixture('tool-calls')
      const read = events.find((event) => event.type === 'tool_call' && event.name === 'Read')

      expect(read).toBeDefined()
      expect(read?.type === 'tool_call' && read.input).toMatchObject({
        file_path: expect.any(String),
      })
    })

    it('treats a null is_error as success', () => {
      // Recorded successful results carry null as often as false. A parser
      // expecting a boolean would report every one of them as a failure.
      const { events } = mapFixture('tool-calls')
      const results = events.filter((event) => event.type === 'tool_result')

      expect(results.length).toBeGreaterThan(0)
      expect(results.every((event) => event.type === 'tool_result' && !event.isError)).toBe(true)
    })

    it('emits a tool_call before its result', () => {
      const { events } = mapFixture('tool-calls')
      const order = typesOf(events)

      expect(order.indexOf('tool_call')).toBeLessThan(order.indexOf('tool_result'))
    })

    it('captures tool output', () => {
      const { events } = mapFixture('tool-calls')
      const result = events.find((event) => event.type === 'tool_result')

      expect(result?.type === 'tool_result' && result.output.length).toBeGreaterThan(0)
    })
  })

  describe('file-edit', () => {
    it('records the Edit tool call', () => {
      const { events } = mapFixture('file-edit')
      const names = events.filter((event) => event.type === 'tool_call').map((event) => event.name)

      expect(names).toContain('Edit')
    })

    it('keeps calls and results in order across several tools', () => {
      const { events } = mapFixture('file-edit')

      // The UI pairs these visually, so a reordering would attach output to
      // the wrong call.
      const pairs = events.filter(
        (event) => event.type === 'tool_call' || event.type === 'tool_result',
      )

      for (let index = 0; index < pairs.length; index += 2) {
        const call = pairs[index]
        const result = pairs[index + 1]
        if (!call || !result) break

        expect(call.type).toBe('tool_call')
        expect(result.type).toBe('tool_result')
        expect(call.type === 'tool_call' && result.type === 'tool_result' && result.id).toBe(
          call.type === 'tool_call' ? call.id : '',
        )
      }
    })

    it('completes successfully', () => {
      const { events } = mapFixture('file-edit')
      expect(events.at(-1)).toEqual({ type: 'done', reason: 'completed' })
    })
  })

  describe('tool-error fixture', () => {
    it('still terminates the turn', () => {
      const { events } = mapFixture('tool-error')
      expect(events.at(-1)).toMatchObject({ type: 'done' })
    })

    it('produces assistant text explaining the problem', () => {
      const { events } = mapFixture('tool-error')
      const text = events
        .filter((event) => event.type === 'assistant_text')
        .map((event) => event.delta)
        .join('')

      expect(text).not.toBe('')
    })
  })

  describe('failed tool results', () => {
    it('marks an explicit is_error tool result as failed', () => {
      const mapper = new ClaudeCodeMapper()
      const events = mapper.map({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              is_error: true,
              content: 'ENOENT: no such file',
            },
          ],
        },
      })

      expect(events).toEqual([
        { type: 'tool_result', id: 'toolu_1', output: 'ENOENT: no such file', isError: true },
      ])
    })

    it('flattens a block-array tool result into text', () => {
      const mapper = new ClaudeCodeMapper()
      const events = mapper.map({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_2',
              is_error: false,
              content: [
                { type: 'text', text: 'first line' },
                { type: 'text', text: 'second line' },
              ],
            },
          ],
        },
      })

      expect(events).toEqual([
        { type: 'tool_result', id: 'toolu_2', output: 'first line\nsecond line', isError: false },
      ])
    })
  })

  describe('usage accounting', () => {
    it('reports usage exactly once per turn', () => {
      // Every assistant message carries a running count for the same turn.
      // Forwarding each one would leave the UI with several overlapping
      // numbers and no way to tell which is current.
      const { events } = mapFixture('file-edit')
      expect(events.filter((event) => event.type === 'usage')).toHaveLength(1)
    })

    it('reports the authoritative total, not an intermediate count', () => {
      const { events } = mapFixture('file-edit')
      const usage = events.find((event) => event.type === 'usage')

      expect(usage).toMatchObject({
        inputTokens: expect.any(Number),
        outputTokens: expect.any(Number),
      })
      expect(usage?.type === 'usage' && usage.outputTokens).toBeGreaterThan(0)
    })

    it('folds cache tokens into the input total', () => {
      // Cache reads are real consumption. Excluding them would under-report
      // usage by an order of magnitude on a long session.
      const { events } = mapFixture('tool-calls')
      const usage = events.find((event) => event.type === 'usage')

      expect(usage?.type === 'usage' && usage.inputTokens).toBeGreaterThan(100)
    })

    it('reports cost alongside the totals', () => {
      const { events } = mapFixture('text-only')
      const usage = events.find((event) => event.type === 'usage')

      expect(usage?.type === 'usage' && usage.costUsd).toBeGreaterThan(0)
    })

    it('emits usage before done, so the UI has totals when the turn closes', () => {
      const { events } = mapFixture('text-only')
      const types = typesOf(events)

      expect(types.indexOf('usage')).toBeLessThan(types.indexOf('done'))
    })
  })

  describe('thinking', () => {
    function thinkingFrom(block: unknown): AgentEvent[] {
      return new ClaudeCodeMapper().map({
        type: 'assistant',
        message: { role: 'assistant', content: [block] },
      })
    }

    it('carries the reasoning text', () => {
      const events = thinkingFrom({ type: 'thinking', thinking: 'considering the options' })
      expect(events[0]).toEqual({ type: 'thinking', delta: 'considering the options' })
    })

    it('says so when reasoning is withheld rather than showing a blank bubble', () => {
      // A redacted block means the model reasoned but the content is not
      // available. An empty delta would render as an empty message.
      const events = thinkingFrom({ type: 'redacted_thinking', data: 'encrypted' })

      expect(events[0]).toMatchObject({ type: 'thinking' })
      expect(events[0]?.type === 'thinking' && events[0].delta).not.toBe('')
    })

    it('handles a thinking block with no text at all', () => {
      // Observed in a real session: the block arrived, the field did not.
      const events = thinkingFrom({ type: 'thinking' })

      expect(events).toHaveLength(1)
      expect(events[0]?.type === 'thinking' && events[0].delta).not.toBe('')
    })
  })

  describe('malformed and unknown input', () => {
    it('reports an unparseable message without throwing', () => {
      const mapper = new ClaudeCodeMapper()
      const events = mapper.map({ type: 42 })

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ type: 'error', fatal: false })
    })

    it('ignores an unknown message type', () => {
      // A future agent release adding a message type must not break sessions.
      const mapper = new ClaudeCodeMapper()
      expect(mapper.map({ type: 'something_new', data: 1 })).toEqual([])
    })

    it('ignores rate limit notices', () => {
      const mapper = new ClaudeCodeMapper()
      expect(mapper.map({ type: 'rate_limit_event', status: 'ok' })).toEqual([])
    })

    it('ignores an unknown content block', () => {
      const mapper = new ClaudeCodeMapper()
      const events = mapper.map({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'future_block', data: 1 }] },
      })

      expect(events).toEqual([])
    })

    it('survives a stream that ends without a result message', () => {
      // What a killed agent process leaves behind.
      const mapper = new ClaudeCodeMapper()
      const events = loadFixture('text-only')
        .slice(0, -1)
        .flatMap((message) => mapper.map(message))

      expect(typesOf(events)).not.toContain('done')
      expect(typesOf(events)).toContain('session_started')
    })
  })

  describe('error results', () => {
    it('emits an error and a done when the agent reports failure', () => {
      const mapper = new ClaudeCodeMapper()
      const events = mapper.map({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: 'something broke',
      })

      expect(events).toEqual([
        { type: 'error', message: 'something broke', fatal: false },
        { type: 'done', reason: 'error' },
      ])
    })

    it('marks a failed turn as non-fatal, since a follow-up can continue', () => {
      const mapper = new ClaudeCodeMapper()
      const events = mapper.map({ type: 'result', subtype: 'error', is_error: true })
      const error = events.find((event) => event.type === 'error')

      expect(error).toMatchObject({ fatal: false })
    })
  })

  describe('resume', () => {
    it('does not emit a second session_started when init repeats', () => {
      const mapper = new ClaudeCodeMapper()

      mapper.map({ type: 'system', subtype: 'init', session_id: 'a', model: 'claude-opus-5' })
      const second = mapper.map({ type: 'system', subtype: 'init', session_id: 'a' })

      // A resumed session is one conversation to the user.
      expect(second).toEqual([])
    })

    it('emits permission_mode from init', () => {
      const mapper = new ClaudeCodeMapper()
      const events = mapper.map({
        type: 'system',
        subtype: 'init',
        session_id: 's',
        permissionMode: 'plan',
      })

      expect(events).toContainEqual({ type: 'permission_mode', mode: 'plan' })
    })

    it('maps Claude bypassPermissions onto bypass', () => {
      const mapper = new ClaudeCodeMapper()
      const events = mapper.map({
        type: 'system',
        subtype: 'init',
        session_id: 's',
        permissionMode: 'bypassPermissions',
      })

      expect(events).toContainEqual({ type: 'permission_mode', mode: 'bypass' })
    })
  })

  describe('control requests', () => {
    it('turns can_use_tool into a permission_request', () => {
      const mapper = new ClaudeCodeMapper()
      const events = mapper.map({
        type: 'control_request',
        request_id: 'req-1',
        request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } },
      })

      expect(events).toEqual([
        {
          type: 'permission_request',
          id: 'req-1',
          action: 'Bash',
          detail: { command: 'ls' },
        },
      ])
    })

    it('maps ExitPlanMode onto the plan-approval action', () => {
      const mapper = new ClaudeCodeMapper()
      const events = mapper.map({
        type: 'control_request',
        request_id: 'req-plan',
        request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: {} },
      })

      expect(events).toEqual([
        {
          type: 'permission_request',
          id: 'req-plan',
          action: 'exit_plan_mode',
          detail: {},
        },
      ])
    })

    it('ignores control requests that are not tool prompts', () => {
      const mapper = new ClaudeCodeMapper()
      expect(
        mapper.map({
          type: 'control_request',
          request_id: 'x',
          request: { subtype: 'interrupt' },
        }),
      ).toEqual([])
    })
  })

  describe('session id', () => {
    it('tracks the latest session id', () => {
      const mapper = new ClaudeCodeMapper()

      mapper.map({ type: 'system', subtype: 'init', session_id: 'first' })
      expect(mapper.agentSessionId).toBe('first')

      mapper.map({ type: 'result', subtype: 'success', session_id: 'second' })
      expect(mapper.agentSessionId).toBe('second')
    })
  })
})
