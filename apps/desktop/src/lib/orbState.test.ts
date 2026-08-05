import { describe, expect, it } from 'vitest'
import type { Block } from '@dukebox/protocol'
import { activityBlock, mapOrbState, orbStateForTool } from './orbState.js'

describe('orbStateForTool', () => {
  it('maps search-like tools to searching', () => {
    expect(orbStateForTool('Grep')).toBe('searching')
    expect(orbStateForTool('Glob')).toBe('searching')
    expect(orbStateForTool('Read')).toBe('searching')
    expect(orbStateForTool('search_files')).toBe('searching')
  })

  it('maps edit-like tools to shaping', () => {
    expect(orbStateForTool('Write')).toBe('shaping')
    expect(orbStateForTool('Edit')).toBe('shaping')
    expect(orbStateForTool('ApplyPatch')).toBe('shaping')
    expect(orbStateForTool('str_replace')).toBe('shaping')
  })

  it('maps shell tools to working', () => {
    expect(orbStateForTool('Bash')).toBe('working')
    expect(orbStateForTool('Shell')).toBe('working')
    expect(orbStateForTool('run_command')).toBe('working')
  })

  it('maps network tools to connecting', () => {
    expect(orbStateForTool('WebFetch')).toBe('connecting')
    expect(orbStateForTool('http_request')).toBe('connecting')
  })

  it('falls back to weaving for unknown tools', () => {
    expect(orbStateForTool('Todo')).toBe('weaving')
    expect(orbStateForTool('mcp_custom')).toBe('weaving')
    expect(orbStateForTool('Task')).toBe('weaving')
  })
})

describe('mapOrbState', () => {
  it('defaults to working when there is no block', () => {
    expect(mapOrbState(null)).toBe('working')
    expect(mapOrbState(undefined)).toBe('working')
  })

  it('maps thinking to solving and text to composing', () => {
    expect(mapOrbState({ kind: 'thinking', id: '1', text: '…' })).toBe('solving')
    expect(mapOrbState({ kind: 'text', id: '1', text: '…' })).toBe('composing')
  })

  it('maps unanswered permissions to listening', () => {
    expect(
      mapOrbState({ kind: 'permission', id: '1', action: 'bash', detail: null }),
    ).toBe('listening')
    expect(
      mapOrbState({
        kind: 'permission',
        id: '1',
        action: 'bash',
        detail: null,
        answered: true,
      }),
    ).toBe('working')
  })

  it('maps running tools by name and finished tools to working', () => {
    expect(
      mapOrbState({ kind: 'tool', id: '1', name: 'Grep', input: { pattern: 'x' } }),
    ).toBe('searching')
    expect(
      mapOrbState({
        kind: 'tool',
        id: '1',
        name: 'Grep',
        input: {},
        result: { output: 'ok', isError: false },
      }),
    ).toBe('working')
  })

  it('maps prompts and errors to working', () => {
    expect(mapOrbState({ kind: 'prompt', id: '1', text: 'hi' })).toBe('working')
    expect(mapOrbState({ kind: 'error', id: '1', message: 'x', fatal: false })).toBe('working')
  })
})

describe('activityBlock', () => {
  it('returns the latest meaningful block', () => {
    const blocks: Block[] = [
      { kind: 'prompt', id: 'p', text: 'fix it' },
      { kind: 'thinking', id: 't', text: 'hmm' },
      { kind: 'tool', id: 'g', name: 'Grep', input: {} },
    ]
    expect(activityBlock(blocks)?.kind).toBe('tool')
  })

  it('skips finished tools, answered permissions, prompts and errors', () => {
    const blocks: Block[] = [
      { kind: 'text', id: 'a', text: 'done' },
      {
        kind: 'tool',
        id: 'g',
        name: 'Grep',
        input: {},
        result: { output: 'ok', isError: false },
      },
      { kind: 'permission', id: 'p', action: 'bash', detail: null, answered: true },
      { kind: 'prompt', id: 'u', text: 'again' },
      { kind: 'error', id: 'e', message: 'blip', fatal: false },
    ]
    expect(activityBlock(blocks)?.kind).toBe('text')
  })

  it('returns null for an empty or inert transcript', () => {
    expect(activityBlock([])).toBeNull()
    expect(activityBlock([{ kind: 'prompt', id: 'p', text: 'hi' }])).toBeNull()
  })
})
