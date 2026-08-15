import type { AgentEvent } from '@dukebox/protocol'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { JsonlReader } from '@/jsonl'
import { GrokBuildMapper } from '@/grok-build/mapper'

/**
 * Tests against documented-shape fixtures of `grok -p --output-format streaming-json`.
 *
 * Written from the headless-mode event table rather than a live recording: the
 * adapter is pinned to a CLI version, and these cover the variants the mapper
 * has to handle (text, tools, reasoning, errors, unknown types).
 */

function loadFixture(name: string): unknown[] {
  const path = fileURLToPath(new URL(`../../fixtures/${name}.jsonl`, import.meta.url))
  const reader = new JsonlReader()
  return [...reader.push(readFileSync(path, 'utf8')), ...reader.flush()]
}

function mapFixture(name: string): { events: AgentEvent[]; mapper: GrokBuildMapper } {
  const mapper = new GrokBuildMapper()
  const events = loadFixture(name).flatMap((message) => mapper.map(message))
  return { events, mapper }
}

function typesOf(events: AgentEvent[]): string[] {
  return events.map((event) => event.type)
}

describe('GrokBuildMapper', () => {
  describe('text', () => {
    it('opens with session_started and does not emit done', () => {
      const { events } = mapFixture('grok-build-text')

      expect(events[0]).toMatchObject({ type: 'session_started', agentId: 'grok-build' })
      expect(typesOf(events)).not.toContain('done')
    })

    it('emits the assistant text', () => {
      const { events } = mapFixture('grok-build-text')
      const text = events
        .filter((event) => event.type === 'assistant_text')
        .map((event) => event.delta)
        .join('')

      expect(text).toContain('Hello from Grok Build')
    })

    it('captures a session id from end for resuming', () => {
      const { mapper } = mapFixture('grok-build-text')
      expect(mapper.agentSessionId).toBe('ses_grok_text_1')
    })

    it('emits usage from the usage line', () => {
      const { events } = mapFixture('grok-build-text')
      expect(events).toContainEqual({ type: 'usage', inputTokens: 12, outputTokens: 8 })
    })
  })

  describe('tools', () => {
    it('pairs a tool_call with a later completed update of the same id', () => {
      const { events } = mapFixture('grok-build-tools')

      const call = events.find((event) => event.type === 'tool_call')
      const result = events.find((event) => event.type === 'tool_result')

      expect(call).toMatchObject({ type: 'tool_call', id: 'call_1', name: 'read_file' })
      expect(result).toMatchObject({
        type: 'tool_result',
        id: 'call_1',
        output: JSON.stringify({ lines: 42 }),
        isError: false,
      })
    })

    it('preserves tool input for the UI to render', () => {
      const { events } = mapFixture('grok-build-tools')
      const call = events.find((event) => event.type === 'tool_call')

      expect(call?.type === 'tool_call' && call.input).toMatchObject({ path: 'src/main.rs' })
    })

    it('folds cache and reasoning tokens into usage and carries cost from end', () => {
      const { events } = mapFixture('grok-build-tools')
      const usages = events.filter((event) => event.type === 'usage')

      expect(usages).toContainEqual({ type: 'usage', inputTokens: 52, outputTokens: 16 })
      expect(usages).toContainEqual({
        type: 'usage',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0.0127,
      })
    })
  })

  describe('reasoning and errors', () => {
    it('carries the reasoning text', () => {
      const { events } = mapFixture('grok-build-reasoning')
      expect(events).toContainEqual({ type: 'thinking', delta: 'considering the options' })
    })

    it('maps a provider error without ending the session', () => {
      const { events } = mapFixture('grok-build-reasoning')
      expect(events).toContainEqual({ type: 'error', message: 'rate limited', fatal: false })
      expect(typesOf(events)).not.toContain('done')
    })

    it('treats the headless unsigned message as a fatal re-auth error', () => {
      const mapper = new GrokBuildMapper()
      const events = mapper.map({
        type: 'error',
        message:
          'Not signed in. To authenticate without a browser, run:\n  grok login --device-code',
      })

      expect(events).toEqual([
        {
          type: 'error',
          message:
            'Grok is not signed in. Open Settings and sign in again with the device code. The saved session expired and could not be renewed.',
          fatal: true,
        },
      ])
    })
  })

  describe('malformed and unknown input', () => {
    it('reports an unparseable message without throwing', () => {
      const mapper = new GrokBuildMapper()
      const events = mapper.map({ type: 42 })

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ type: 'error', fatal: false })
    })

    it('ignores an unknown message type', () => {
      const mapper = new GrokBuildMapper()
      expect(mapper.map({ type: 'available_commands', tools: [] })).toEqual([])
    })

    it('skips empty text rather than emitting a blank bubble', () => {
      const mapper = new GrokBuildMapper()
      expect(mapper.map({ type: 'text', data: '' })).toEqual([])
    })

    it('does not emit a result for a still-running tool update', () => {
      const mapper = new GrokBuildMapper()
      const events = mapper.map({
        type: 'tool_call_update',
        toolCallId: 'call_1',
        status: 'in_progress',
      })

      expect(events).toEqual([])
    })

    it('unwraps Grok content-block tool output to the inner text', () => {
      const mapper = new GrokBuildMapper()
      const events = mapper.map({
        type: 'tool_call_update',
        toolCallId: 'call_1',
        status: 'failed',
        content: [
          {
            type: 'content',
            content: { type: 'text', text: 'file is locked' },
          },
        ],
      })

      expect(events.find((event) => event.type === 'tool_result')).toEqual({
        type: 'tool_result',
        id: 'call_1',
        output: 'file is locked',
        isError: true,
      })
    })

    it('does not report a denied tool as the user cancelling it', () => {
      const mapper = new GrokBuildMapper()
      const events = mapper.map({
        type: 'tool_call_update',
        toolCallId: 'call_write',
        status: 'failed',
        content: [
          {
            type: 'content',
            content: {
              type: 'text',
              text: 'User cancelled the execution for tool `write`',
            },
          },
        ],
      })

      const result = events.find((event) => event.type === 'tool_result')
      expect(result).toMatchObject({
        type: 'tool_result',
        id: 'call_write',
        isError: true,
      })
      expect(result?.type === 'tool_result' && result.output).toMatch(/did not cancel/i)
      expect(result?.type === 'tool_result' && result.output).not.toMatch(/user cancelled/i)
      expect(result?.type === 'tool_result' && result.output).not.toMatch(/plan mode/i)
      expect(result?.type === 'tool_result' && result.output).toContain('write')
    })
  })

  describe('resume', () => {
    it('does not emit a second session_started when more events arrive', () => {
      const mapper = new GrokBuildMapper()

      mapper.map({ type: 'text', data: 'first' })
      const second = mapper.map({ type: 'text', data: 'second' })

      expect(second).toEqual([{ type: 'assistant_text', delta: 'second' }])
    })

    it('can be seeded with a session id before any output', () => {
      const mapper = new GrokBuildMapper()
      mapper.rememberSession('ses_prior', 'grok-build')

      expect(mapper.agentSessionId).toBe('ses_prior')

      const events = mapper.map({ type: 'text', data: 'hi' })
      expect(events[0]).toMatchObject({
        type: 'session_started',
        agentId: 'grok-build',
        model: 'grok-build',
      })
    })
  })
})
