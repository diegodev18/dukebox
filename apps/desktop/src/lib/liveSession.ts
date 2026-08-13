import { create } from 'zustand'
import { emptyTranscript, type Transcript } from '@dukebox/protocol'
import type { StreamStatus } from '@/lib/stream'
import { emptyTerminalState, type TerminalState } from '@/lib/useTerminals'

/**
 * Live session state, outside the Session screen's React tree.
 *
 * Transcript tokens and terminal bytes both arrive on the same socket. If they
 * lived in Session's useState, every chunk would re-render the sidebar, the
 * composer, and whichever workspace tab was not involved. Selectors here let
 * each column subscribe to only what it draws.
 */

export interface LiveSessionState {
  transcript: Transcript
  status: StreamStatus
  error: string | null
  terminals: TerminalState
}

export const useLiveSession = create<LiveSessionState>(() => ({
  transcript: emptyTranscript(),
  status: 'connecting',
  error: null,
  terminals: emptyTerminalState(),
}))

export function resetLiveSession(status: StreamStatus = 'connecting'): void {
  useLiveSession.setState({
    transcript: emptyTranscript(),
    status,
    error: null,
    terminals: emptyTerminalState(),
  })
}
