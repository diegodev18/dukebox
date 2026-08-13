import { describe, expect, it } from 'vitest'
import {
  applyTerminalMessage,
  applyTerminalOutputs,
  drainTab,
  emptyTerminalState,
  removeTab,
  renameTab,
} from '@/lib/useTerminals'

const sessionId = '11111111-1111-4111-8111-111111111111'

/** A state holding one open terminal, which most cases start from. */
function withOneTerminal() {
  return applyTerminalMessage(emptyTerminalState(), {
    type: 'terminal_opened',
    sessionId,
    terminalId: 't1',
    title: '1',
    cols: 80,
    rows: 24,
  })
}

describe('applyTerminalMessage', () => {
  it('adds a tab when a terminal opens', () => {
    const state = withOneTerminal()

    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0]?.title).toBe('1')
  })

  it('ignores a terminal it already knows about', () => {
    const state = applyTerminalMessage(withOneTerminal(), {
      type: 'terminal_opened',
      sessionId,
      terminalId: 't1',
      title: '1',
      cols: 80,
      rows: 24,
    })

    expect(state.tabs).toHaveLength(1)
  })

  it('replaces the tab list when the server sends one', () => {
    const state = applyTerminalMessage(withOneTerminal(), {
      type: 'terminal_list',
      sessionId,
      terminals: [{ terminalId: 't2', title: '1' }],
    })

    // The server is authoritative: a tab left over from a previous connection
    // is one nothing can be typed into.
    expect(state.tabs.map((tab) => tab.terminalId)).toEqual(['t2'])
  })

  it('queues output for the tab it belongs to', () => {
    const state = applyTerminalMessage(withOneTerminal(), {
      type: 'terminal_output',
      sessionId,
      terminalId: 't1',
      data: 'aGk=',
    })

    expect(state.tabs[0]?.pending).toEqual(['aGk='])
  })

  it('keeps queued output in arrival order', () => {
    const first = applyTerminalMessage(withOneTerminal(), {
      type: 'terminal_output',
      sessionId,
      terminalId: 't1',
      data: 'Zmlyc3Q=',
    })

    const state = applyTerminalMessage(first, {
      type: 'terminal_output',
      sessionId,
      terminalId: 't1',
      data: 'c2Vjb25k',
    })

    expect(state.tabs[0]?.pending).toEqual(['Zmlyc3Q=', 'c2Vjb25k'])
  })

  it('ignores output for a terminal it does not know about', () => {
    const state = applyTerminalMessage(emptyTerminalState(), {
      type: 'terminal_output',
      sessionId,
      terminalId: 'ghost',
      data: 'aGk=',
    })

    expect(state.tabs).toHaveLength(0)
  })

  it('marks a tab exited rather than removing it', () => {
    const state = applyTerminalMessage(withOneTerminal(), {
      type: 'terminal_exit',
      sessionId,
      terminalId: 't1',
      exitCode: 0,
    })

    // A shell's exit is information. A tab that vanishes leaves the user
    // wondering what happened.
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0]?.exited).toBe(true)
  })

  it('leaves unrelated messages alone', () => {
    const before = emptyTerminalState()
    const after = applyTerminalMessage(before, {
      type: 'caught_up',
      sessionId,
      lastSeq: 3,
    })

    expect(after).toBe(before)
  })
})

describe('drainTab', () => {
  it('clears what has been written to the terminal', () => {
    const queued = applyTerminalMessage(withOneTerminal(), {
      type: 'terminal_output',
      sessionId,
      terminalId: 't1',
      data: 'aGk=',
    })

    expect(drainTab(queued, 't1', 1).tabs[0]?.pending).toEqual([])
  })

  it('keeps chunks that arrived after the ones just written', () => {
    const first = applyTerminalMessage(withOneTerminal(), {
      type: 'terminal_output',
      sessionId,
      terminalId: 't1',
      data: 'Zmlyc3Q=',
    })
    const queued = applyTerminalMessage(first, {
      type: 'terminal_output',
      sessionId,
      terminalId: 't1',
      data: 'c2Vjb25k',
    })

    // The effect wrote one chunk, then a second arrived before drain ran.
    // Clearing the whole queue would drop `ls` output and look like a hang.
    expect(drainTab(queued, 't1', 1).tabs[0]?.pending).toEqual(['c2Vjb25k'])
  })

  it('returns the same state when there is nothing queued', () => {
    const state = withOneTerminal()

    // Identity matters: React skips a render when the state is unchanged, and
    // draining runs after every write.
    expect(drainTab(state, 't1', 1)).toBe(state)
  })
})

describe('removeTab', () => {
  it('drops the tab', () => {
    expect(removeTab(withOneTerminal(), 't1').tabs).toHaveLength(0)
  })

  it('returns the same state when the tab is unknown', () => {
    const state = withOneTerminal()

    expect(removeTab(state, 'ghost')).toBe(state)
  })
})

describe('renameTab', () => {
  it('changes the title', () => {
    expect(renameTab(withOneTerminal(), 't1', 'build').tabs[0]?.title).toBe('build')
  })

  it('trims whitespace', () => {
    expect(renameTab(withOneTerminal(), 't1', '  build  ').tabs[0]?.title).toBe('build')
  })

  it('ignores an empty title so a tab never goes blank', () => {
    const state = withOneTerminal()

    expect(renameTab(state, 't1', '   ')).toBe(state)
  })

  it('returns the same state when the title is unchanged', () => {
    const state = withOneTerminal()

    expect(renameTab(state, 't1', '1')).toBe(state)
  })
})

describe('applyTerminalOutputs', () => {
  it('appends several chunks for one terminal in a single update', () => {
    const state = applyTerminalOutputs(
      withOneTerminal(),
      new Map([['t1', ['Zmlyc3Q=', 'c2Vjb25k']]]),
    )

    expect(state.tabs[0]?.pending).toEqual(['Zmlyc3Q=', 'c2Vjb25k'])
  })

  it('returns the same state when every terminal is unknown', () => {
    const start = withOneTerminal()
    const next = applyTerminalOutputs(start, new Map([['ghost', ['aGk=']]]))

    expect(next).toBe(start)
  })
})
