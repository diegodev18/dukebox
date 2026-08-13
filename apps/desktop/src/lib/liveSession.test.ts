import { emptyTranscript } from '@dukebox/protocol'
import { describe, expect, it } from 'vitest'
import { resetLiveSession, useLiveSession } from '@/lib/liveSession'
import { emptyTerminalState } from '@/lib/useTerminals'

describe('useLiveSession', () => {
  it('lets a terminal update leave the transcript identity alone', () => {
    resetLiveSession('live')
    const transcript = emptyTranscript()
    useLiveSession.setState({ transcript })

    useLiveSession.setState({
      terminals: { tabs: [{ terminalId: 't1', title: '1', exited: false, pending: ['a'] }] },
    })

    expect(useLiveSession.getState().transcript).toBe(transcript)
    expect(useLiveSession.getState().terminals.tabs).toHaveLength(1)
  })

  it('resets buffers without dropping a live socket status', () => {
    useLiveSession.setState({
      status: 'live',
      error: 'failed',
      terminals: { tabs: [{ terminalId: 't1', title: '1', exited: false, pending: [] }] },
    })
    resetLiveSession('live')

    expect(useLiveSession.getState()).toMatchObject({
      status: 'live',
      error: null,
      terminals: emptyTerminalState(),
    })
    expect(useLiveSession.getState().transcript.blocks).toEqual([])
  })
})
