import { describe, expect, it } from 'vitest'
import type { AgentEvent, EnvelopedEvent } from '@/events'
import {
  answerPermission,
  applyEvent,
  applyEvents,
  emptyTranscript,
  type ToolBlock,
} from '@/transcript'

const SESSION = '00000000-0000-4000-8000-000000000000'

/** Envelope a bare event, so tests read as the events they are about. */
function at(seq: number, event: AgentEvent): EnvelopedEvent {
  return { seq, sessionId: SESSION, ts: 1_700_000_000_000 + seq, event }
}

function fold(...events: EnvelopedEvent[]) {
  return applyEvents(emptyTranscript(), events)
}

describe('folding text', () => {
  it('joins consecutive deltas into one block', () => {
    const transcript = fold(
      at(1, { type: 'assistant_text', delta: 'Hello' }),
      at(2, { type: 'assistant_text', delta: ', ' }),
      at(3, { type: 'assistant_text', delta: 'world' }),
    )

    expect(transcript.blocks).toHaveLength(1)
    expect(transcript.blocks[0]).toMatchObject({ kind: 'text', text: 'Hello, world' })
  })

  it('starts a new block when something interrupts the prose', () => {
    const transcript = fold(
      at(1, { type: 'assistant_text', delta: 'before' }),
      at(2, { type: 'tool_call', id: 'a', name: 'Read', input: {} }),
      at(3, { type: 'assistant_text', delta: 'after' }),
    )

    expect(transcript.blocks.map((block) => block.kind)).toEqual(['text', 'tool', 'text'])
  })

  it('keeps thinking separate from prose', () => {
    const transcript = fold(
      at(1, { type: 'thinking', delta: 'hmm' }),
      at(2, { type: 'assistant_text', delta: 'answer' }),
    )

    expect(transcript.blocks.map((block) => block.kind)).toEqual(['thinking', 'text'])
  })
})

describe('pairing tools with their results', () => {
  it('attaches a result to its call', () => {
    const transcript = fold(
      at(1, { type: 'tool_call', id: 'a', name: 'Read', input: { path: 'x' } }),
      at(2, { type: 'tool_result', id: 'a', output: 'contents', isError: false }),
    )

    expect(transcript.blocks).toHaveLength(1)
    expect(transcript.blocks[0]).toMatchObject({
      kind: 'tool',
      name: 'Read',
      result: { output: 'contents', isError: false },
    })
  })

  it('leaves a running tool without a result', () => {
    const transcript = fold(at(1, { type: 'tool_call', id: 'a', name: 'Bash', input: {} }))
    expect((transcript.blocks[0] as ToolBlock).result).toBeUndefined()
  })

  it('matches by id when tools resolve out of order', () => {
    // Parallel calls are ordinary. Matching by position would attach each
    // output to the wrong call.
    const transcript = fold(
      at(1, { type: 'tool_call', id: 'first', name: 'Read', input: {} }),
      at(2, { type: 'tool_call', id: 'second', name: 'Grep', input: {} }),
      at(3, { type: 'tool_result', id: 'second', output: 'from grep', isError: false }),
      at(4, { type: 'tool_result', id: 'first', output: 'from read', isError: false }),
    )

    expect((transcript.blocks[0] as ToolBlock).result?.output).toBe('from read')
    expect((transcript.blocks[1] as ToolBlock).result?.output).toBe('from grep')
  })

  it('ignores a result for a call it never saw', () => {
    const transcript = fold(
      at(1, { type: 'tool_result', id: 'ghost', output: 'x', isError: false }),
    )
    expect(transcript.blocks).toHaveLength(0)
  })
})

describe('sequence handling', () => {
  it('drops events already folded in', () => {
    // Replay and live delivery overlap on reconnect: the same event can arrive
    // twice, and folding it twice would double the text.
    const transcript = fold(
      at(1, { type: 'assistant_text', delta: 'once' }),
      at(1, { type: 'assistant_text', delta: 'once' }),
    )

    expect(transcript.blocks[0]).toMatchObject({ text: 'once' })
    expect(transcript.lastSeq).toBe(1)
  })

  it('drops events older than what it has', () => {
    const transcript = fold(
      at(5, { type: 'assistant_text', delta: 'current' }),
      at(2, { type: 'assistant_text', delta: 'stale' }),
    )

    expect(transcript.blocks[0]).toMatchObject({ text: 'current' })
    expect(transcript.lastSeq).toBe(5)
  })

  it('returns the same object when an event changes nothing', () => {
    // Identity is what lets React skip a render.
    const first = fold(at(1, { type: 'assistant_text', delta: 'x' }))
    const second = applyEvent(first, at(1, { type: 'assistant_text', delta: 'x' }))

    expect(second).toBe(first)
  })

  it('tracks the highest seq for resuming', () => {
    const transcript = fold(
      at(1, { type: 'assistant_text', delta: 'a' }),
      at(9, { type: 'done', reason: 'completed' }),
    )

    expect(transcript.lastSeq).toBe(9)
  })
})

describe('files', () => {
  it('keeps only the latest state per path', () => {
    const transcript = fold(
      at(1, { type: 'file_diff', path: 'a.ts', before: null, after: 'v1' }),
      at(2, { type: 'file_diff', path: 'a.ts', before: null, after: 'v2' }),
    )

    expect(transcript.files).toEqual([
      { path: 'a.ts', before: null, after: 'v2', added: 1, removed: 0 },
    ])
  })

  it('sorts paths so the review panel does not reshuffle', () => {
    const transcript = fold(
      at(1, { type: 'file_diff', path: 'z.ts', before: null, after: '' }),
      at(2, { type: 'file_diff', path: 'a.ts', before: null, after: '' }),
    )

    expect(transcript.files.map((file) => file.path)).toEqual(['a.ts', 'z.ts'])
  })

  it('folds added and removed counts once', () => {
    const transcript = fold(
      at(1, { type: 'file_diff', path: 'a.ts', before: 'a\nb', after: 'a\nB' }),
    )

    expect(transcript.files[0]).toMatchObject({ added: 1, removed: 1 })
  })
})

describe('usage', () => {
  it('accumulates across turns', () => {
    // Each event reports one turn. A session's cost is all of them.
    const transcript = fold(
      at(1, { type: 'usage', inputTokens: 100, outputTokens: 50, costUsd: 0.01 }),
      at(2, { type: 'usage', inputTokens: 200, outputTokens: 80, costUsd: 0.02 }),
    )

    expect(transcript.usage).toEqual({
      inputTokens: 300,
      outputTokens: 130,
      costUsd: expect.closeTo(0.03, 10),
    })
  })

  it('treats a missing cost as zero', () => {
    const transcript = fold(at(1, { type: 'usage', inputTokens: 10, outputTokens: 5 }))
    expect(transcript.usage.costUsd).toBe(0)
  })
})

describe('running state', () => {
  it('is false before anything happens', () => {
    expect(emptyTranscript().running).toBe(false)
  })

  it('is true once the agent is producing output', () => {
    expect(fold(at(1, { type: 'assistant_text', delta: 'x' })).running).toBe(true)
  })

  it('clears on done', () => {
    const transcript = fold(
      at(1, { type: 'assistant_text', delta: 'x' }),
      at(2, { type: 'done', reason: 'completed' }),
    )

    expect(transcript.running).toBe(false)
  })

  it('closes tools that never got a result when the turn ends', () => {
    // After a restart the last event is often a tool_call with no result.
    // Leaving it open is what kept the UI spinning on a turn that cannot finish.
    const transcript = fold(
      at(1, { type: 'tool_call', id: 'a', name: 'Bash', input: { command: 'ls' } }),
      at(2, { type: 'done', reason: 'interrupted' }),
    )

    expect(transcript.running).toBe(false)
    expect(transcript.blocks[0]).toMatchObject({
      kind: 'tool',
      result: { output: 'Interrupted.', isError: true },
    })
  })

  it('settles an unanswered permission when the turn ends', () => {
    const transcript = fold(
      at(1, { type: 'permission_request', id: 'perm', action: 'write', detail: {} }),
      at(2, { type: 'done', reason: 'interrupted' }),
    )

    expect(transcript.blocks[0]).toMatchObject({ kind: 'permission', answered: true })
  })

  it('leaves a resolved tool alone when the turn ends', () => {
    const transcript = fold(
      at(1, { type: 'tool_call', id: 'a', name: 'Read', input: {} }),
      at(2, { type: 'tool_result', id: 'a', output: 'ok', isError: false }),
      at(3, { type: 'done', reason: 'completed' }),
    )

    expect(transcript.blocks[0]).toMatchObject({
      kind: 'tool',
      result: { output: 'ok', isError: false },
    })
  })

  it('clears on a fatal error but not a recoverable one', () => {
    const fatal = fold(
      at(1, { type: 'assistant_text', delta: 'x' }),
      at(2, { type: 'error', message: 'gone', fatal: true }),
    )
    const recoverable = fold(
      at(1, { type: 'assistant_text', delta: 'x' }),
      at(2, { type: 'error', message: 'retrying', fatal: false }),
    )

    expect(fatal.running).toBe(false)
    expect(recoverable.running).toBe(true)
  })

  it('closes open tools on a fatal error', () => {
    const transcript = fold(
      at(1, { type: 'tool_call', id: 'a', name: 'Bash', input: {} }),
      at(2, { type: 'error', message: 'gone', fatal: true }),
    )

    expect(transcript.blocks.find((block) => block.kind === 'tool')).toMatchObject({
      result: { output: 'Interrupted.', isError: true },
    })
  })
})

describe('user prompts', () => {
  it('shows the prompt and marks the session busy', () => {
    const transcript = fold(at(1, { type: 'user_prompt', text: 'fix the bug' }))

    expect(transcript.blocks[0]).toMatchObject({ kind: 'prompt', text: 'fix the bug' })
    expect(transcript.running).toBe(true)
  })

  it('keeps the opening prompt above the reply it produced', () => {
    // The case the transcript used to lose entirely: the first prompt is sent
    // while the session provisions, so nothing but the log can carry it.
    const transcript = fold(
      at(1, { type: 'user_prompt', text: 'tell me about this project' }),
      at(2, { type: 'assistant_text', delta: 'It is a ' }),
      at(3, { type: 'assistant_text', delta: 'monorepo.' }),
    )

    expect(transcript.blocks).toMatchObject([
      { kind: 'prompt', text: 'tell me about this project' },
      { kind: 'text', text: 'It is a monorepo.' },
    ])
  })

  it('starts a new block per prompt rather than extending the last one', () => {
    const transcript = fold(
      at(1, { type: 'user_prompt', text: 'first' }),
      at(2, { type: 'user_prompt', text: 'second' }),
    )

    expect(transcript.blocks).toHaveLength(2)
  })
})

describe('local additions', () => {
  it('marks a permission answered', () => {
    const asked = fold(
      at(1, { type: 'permission_request', id: 'perm', action: 'write', detail: {} }),
    )
    const answered = answerPermission(asked, 'perm')

    expect(answered.blocks[0]).toMatchObject({ kind: 'permission', answered: true })
  })

  it('ignores an answer to a permission it does not have', () => {
    const transcript = emptyTranscript()
    expect(answerPermission(transcript, 'nope')).toBe(transcript)
  })
})

describe('session metadata', () => {
  it('records the agent and model', () => {
    const transcript = fold(
      at(1, { type: 'session_started', agentId: 'claude-code', model: 'claude-opus-4' }),
    )

    expect(transcript.agentId).toBe('claude-code')
    expect(transcript.model).toBe('claude-opus-4')
  })

  it('records the permission mode without adding a block', () => {
    const transcript = fold(at(1, { type: 'permission_mode', mode: 'plan' }))

    expect(transcript.permissionMode).toBe('plan')
    expect(transcript.blocks).toHaveLength(0)
  })

  it('replaces the permission mode when it changes', () => {
    const transcript = fold(
      at(1, { type: 'permission_mode', mode: 'plan' }),
      at(2, { type: 'permission_mode', mode: 'auto' }),
    )

    expect(transcript.permissionMode).toBe('auto')
  })
})
