import type { AgentEvent } from '@dukebox/protocol'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { JsonlReader } from '@/jsonl'
import { OpenCodeMapper } from '@/opencode/mapper'

/**
 * Tests against recorded-shape fixtures of `opencode run --format json`.
 *
 * Written from the documented JSONL events rather than a live recording: the
 * adapter is pinned to a CLI version, and these cover the variants the mapper
 * has to handle (text, tools, reasoning, errors, unknown types).
 */

function loadFixture(name: string): unknown[] {
  const path = fileURLToPath(new URL(`../../fixtures/${name}.jsonl`, import.meta.url))
  const reader = new JsonlReader()
  return [...reader.push(readFileSync(path, 'utf8')), ...reader.flush()]
}

function mapFixture(name: string): { events: AgentEvent[]; mapper: OpenCodeMapper } {
  const mapper = new OpenCodeMapper()
  const events = loadFixture(name).flatMap((message) => mapper.map(message))
  return { events, mapper }
}

function typesOf(events: AgentEvent[]): string[] {
  return events.map((event) => event.type)
}

describe('OpenCodeMapper', () => {
  describe('text', () => {
    it('opens with session_started and does not emit done', () => {
      // done belongs to process lifetime, not to step_finish — a turn has
      // several steps when tools run.
      const { events } = mapFixture('opencode-text')

      expect(events[0]).toMatchObject({ type: 'session_started', agentId: 'opencode' })
      expect(typesOf(events)).not.toContain('done')
    })

    it('emits the assistant text', () => {
      const { events } = mapFixture('opencode-text')
      const text = events
        .filter((event) => event.type === 'assistant_text')
        .map((event) => event.delta)
        .join('')

      expect(text).toContain('Hello from OpenCode')
    })

    it('captures a session id for resuming', () => {
      const { mapper } = mapFixture('opencode-text')
      expect(mapper.agentSessionId).toBe('ses_494719016ffe85dkDMj0FPRbHK')
    })

    it('emits usage from step_finish tokens', () => {
      const { events } = mapFixture('opencode-text')
      expect(events).toContainEqual({ type: 'usage', inputTokens: 12, outputTokens: 8 })
    })
  })

  describe('tools', () => {
    it('pairs a completed tool_use with a result of the same id', () => {
      const { events } = mapFixture('opencode-tools')

      const call = events.find((event) => event.type === 'tool_call')
      const result = events.find((event) => event.type === 'tool_result')

      expect(call).toMatchObject({ type: 'tool_call', id: 'call_bash_1', name: 'bash' })
      expect(result).toMatchObject({
        type: 'tool_result',
        id: 'call_bash_1',
        output: 'README.md\n',
        isError: false,
      })
    })

    it('preserves tool input for the UI to render', () => {
      const { events } = mapFixture('opencode-tools')
      const call = events.find((event) => event.type === 'tool_call')

      expect(call?.type === 'tool_call' && call.input).toMatchObject({ command: 'ls' })
    })

    it('folds cache and reasoning tokens into usage', () => {
      const { events } = mapFixture('opencode-tools')
      const usage = events.find((event) => event.type === 'usage')

      expect(usage).toEqual({ type: 'usage', inputTokens: 52, outputTokens: 20 })
    })
  })

  describe('reasoning and errors', () => {
    it('carries the reasoning text', () => {
      const { events } = mapFixture('opencode-reasoning')
      expect(events).toContainEqual({ type: 'thinking', delta: 'considering the options' })
    })

    it('maps a provider error without ending the session', () => {
      const { events } = mapFixture('opencode-reasoning')
      expect(events).toContainEqual({ type: 'error', message: 'rate limited', fatal: false })
      expect(typesOf(events)).not.toContain('done')
    })
  })

  describe('malformed and unknown input', () => {
    it('reports an unparseable message without throwing', () => {
      const mapper = new OpenCodeMapper()
      const events = mapper.map({ type: 42 })

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ type: 'error', fatal: false })
    })

    it('ignores an unknown message type', () => {
      const mapper = new OpenCodeMapper()
      expect(mapper.map({ type: 'something_new', data: 1 })).toEqual([])
    })

    it('skips empty text rather than emitting a blank bubble', () => {
      const mapper = new OpenCodeMapper()
      expect(mapper.map({ type: 'text', part: { text: '' } })).toEqual([])
    })

    it('does not emit a result for a still-running tool', () => {
      const mapper = new OpenCodeMapper()
      const events = mapper.map({
        type: 'tool_use',
        part: {
          callID: 'call_1',
          tool: 'bash',
          state: { status: 'running', input: { command: 'sleep 1' } },
        },
      })

      expect(events).toEqual([
        { type: 'tool_call', id: 'call_1', name: 'bash', input: { command: 'sleep 1' } },
      ])
    })
  })

  describe('resume', () => {
    it('does not emit a second session_started when step_start repeats', () => {
      const mapper = new OpenCodeMapper()

      mapper.map({ type: 'step_start', sessionID: 'ses_a' })
      const second = mapper.map({ type: 'step_start', sessionID: 'ses_a' })

      expect(second).toEqual([])
    })

    it('tracks the latest session id', () => {
      const mapper = new OpenCodeMapper()

      mapper.map({ type: 'step_start', sessionID: 'ses_first' })
      expect(mapper.agentSessionId).toBe('ses_first')

      mapper.map({ type: 'text', sessionID: 'ses_second', part: { text: 'hi' } })
      expect(mapper.agentSessionId).toBe('ses_second')
    })

    it('can be seeded with a session id before any output', () => {
      const mapper = new OpenCodeMapper()
      mapper.rememberSession('ses_prior', 'anthropic/claude-sonnet-4-5')

      expect(mapper.agentSessionId).toBe('ses_prior')

      const events = mapper.map({ type: 'step_start', sessionID: 'ses_prior' })
      expect(events[0]).toMatchObject({
        type: 'session_started',
        model: 'anthropic/claude-sonnet-4-5',
      })
    })
  })
})
