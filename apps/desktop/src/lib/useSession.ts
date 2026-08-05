import {
  answerPermission,
  appendPrompt,
  applyEvent,
  emptyTranscript,
  type SessionSummary,
  type Transcript,
} from '@dukebox/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DukeboxClient } from './client.js'
import type { Connection } from './connection.js'
import { SessionStream, type StreamStatus } from './stream.js'
import {
  applyTerminalMessage,
  drainTab,
  emptyTerminalState,
  removeTab,
  type TerminalState,
} from './useTerminals.js'

/**
 * One session, live.
 *
 * Holds the socket and the folded transcript together, because they are only
 * useful as a pair: the transcript's `lastSeq` is what the socket resumes from,
 * and the socket's events are what advance it.
 *
 * The stream outlives any single session — one socket serves the whole app,
 * and switching sessions swaps a subscription rather than a connection.
 */

export interface LiveSession {
  transcript: Transcript
  status: StreamStatus
  /** Set when a command the app sent came back rejected. */
  error: string | null
  send: (text: string) => void
  interrupt: () => void
  respond: (id: string, allow: boolean) => void
  /** The shells open in this session's container. */
  terminals: TerminalState
  openTerminal: (cols: number, rows: number) => void
  attachTerminal: (terminalId: string, cols: number, rows: number) => void
  detachTerminal: (terminalId: string) => void
  sendTerminalInput: (terminalId: string, data: string) => void
  resizeTerminal: (terminalId: string, cols: number, rows: number) => void
  closeTerminal: (terminalId: string) => void
  /** Forget output already written to xterm, so it is not replayed. */
  drainTerminal: (terminalId: string) => void
}

export function useSession(
  connection: Connection,
  sessionId: string | null,
  onSessionUpdate?: (session: SessionSummary) => void,
): LiveSession {
  const [transcript, setTranscript] = useState<Transcript>(emptyTranscript)
  const [status, setStatus] = useState<StreamStatus>('connecting')
  const [error, setError] = useState<string | null>(null)
  const [terminals, setTerminals] = useState<TerminalState>(emptyTerminalState)

  // The socket is read by callbacks that must not re-run when it changes, and
  // the seq is read by the socket at reconnect time — both need a ref rather
  // than state.
  const streamRef = useRef<SessionStream | null>(null)
  const lastSeqRef = useRef(0)

  // Kept in sync so a reconnect resumes from what is actually rendered.
  lastSeqRef.current = transcript.lastSeq

  const updateRef = useRef(onSessionUpdate)
  updateRef.current = onSessionUpdate

  useEffect(() => {
    const stream = new SessionStream(
      connection.address,
      connection.deviceToken,
      {
        onStatus: setStatus,
        // A socket that never connected is worth saying out loud. Left to the
        // status alone it reads as "Reconnecting…" forever, which is what a
        // working connection looks like during a blip.
        onFailure: setError,
        onMessage: (message) => {
          switch (message.type) {
            case 'event':
              setTranscript((current) => applyEvent(current, message.event))
              return
            case 'session_update':
              updateRef.current?.(message.session)
              return
            case 'command_error':
              setError(message.message)
              return
            case 'subscription_closed':
              // The session is over. Reconnecting would resubscribe to
              // something that will never send again.
              setStatus('live')
              return
            case 'caught_up':
              return
            case 'terminal_list':
            case 'terminal_opened':
            case 'terminal_output':
            case 'terminal_exit':
              setTerminals((current) => applyTerminalMessage(current, message))
              return
          }
        },
      },
      () => lastSeqRef.current,
    )

    streamRef.current = stream
    stream.connect()

    return () => {
      stream.close()
      streamRef.current = null
    }
  }, [connection.deviceToken, connection.address.host, connection.address.port])

  // Switching sessions resets the transcript before subscribing, so the
  // previous session's messages never appear under the new one's header.
  useEffect(() => {
    if (!sessionId) return

    setTranscript(emptyTranscript())
    lastSeqRef.current = 0
    setError(null)

    // Terminals belong to the session that owns them. Left in place, the new
    // session would show tabs whose ids mean nothing to it.
    setTerminals(emptyTerminalState())

    const stream = streamRef.current
    stream?.subscribe(sessionId)

    return () => {
      stream?.unsubscribe(sessionId)
    }
  }, [sessionId])

  const send = useCallback(
    (text: string) => {
      if (!sessionId) return

      setError(null)
      streamRef.current?.prompt(sessionId, text)

      // Shown immediately rather than waiting for the server to echo it back —
      // a composer that clears with nothing to show for it reads as a failure.
      setTranscript((current) => appendPrompt(current, text, `prompt-${Date.now()}`))
    },
    [sessionId],
  )

  const interrupt = useCallback(() => {
    if (sessionId) streamRef.current?.interrupt(sessionId)
  }, [sessionId])

  const respond = useCallback(
    (id: string, allow: boolean) => {
      if (!sessionId) return

      streamRef.current?.answerPermission(sessionId, id, allow)
      setTranscript((current) => answerPermission(current, id))
    },
    [sessionId],
  )

  const openTerminal = useCallback(
    (cols: number, rows: number) => {
      if (sessionId) streamRef.current?.openTerminal(sessionId, cols, rows)
    },
    [sessionId],
  )

  const attachTerminal = useCallback(
    (terminalId: string, cols: number, rows: number) => {
      if (sessionId) streamRef.current?.attachTerminal(sessionId, terminalId, cols, rows)
    },
    [sessionId],
  )

  const detachTerminal = useCallback(
    (terminalId: string) => {
      if (sessionId) streamRef.current?.detachTerminal(sessionId, terminalId)
    },
    [sessionId],
  )

  const sendTerminalInput = useCallback(
    (terminalId: string, data: string) => {
      if (sessionId) streamRef.current?.sendTerminalInput(sessionId, terminalId, data)
    },
    [sessionId],
  )

  const resizeTerminal = useCallback(
    (terminalId: string, cols: number, rows: number) => {
      if (sessionId) streamRef.current?.resizeTerminal(sessionId, terminalId, cols, rows)
    },
    [sessionId],
  )

  const closeTerminal = useCallback(
    (terminalId: string) => {
      if (!sessionId) return

      streamRef.current?.closeTerminal(sessionId, terminalId)

      // Removed here rather than waiting for the server to confirm: the tab was
      // closed deliberately, and leaving it on screen makes the X feel broken.
      setTerminals((current) => removeTab(current, terminalId))
    },
    [sessionId],
  )

  const drainTerminal = useCallback((terminalId: string) => {
    setTerminals((current) => drainTab(current, terminalId))
  }, [])

  return {
    transcript,
    status,
    error,
    send,
    interrupt,
    respond,
    terminals,
    openTerminal,
    attachTerminal,
    detachTerminal,
    sendTerminalInput,
    resizeTerminal,
    closeTerminal,
    drainTerminal,
  }
}
