import {
  answerPermission,
  applyEvents,
  type EnvelopedEvent,
  type PermissionMode,
  type SessionSummary,
} from '@dukebox/protocol'
import { useCallback, useEffect, useRef } from 'react'
import type { Connection } from '@/lib/connection'
import { resetLiveSession, useLiveSession } from '@/lib/liveSession'
import { SessionStream, isStreamConnected } from '@/lib/stream'
import {
  applyTerminalMessage,
  applyTerminalOutputs,
  drainTab,
  removeTab,
  renameTab,
} from '@/lib/useTerminals'

/**
 * One session, live.
 *
 * Holds the socket. Folded transcript and terminal buffers live in
 * `useLiveSession` so a token or a PTY chunk does not re-render columns that
 * do not draw them.
 *
 * The stream outlives any single session — one socket serves the whole app,
 * and switching sessions swaps a subscription rather than a connection.
 */

export interface LiveSession {
  send: (text: string, files?: { name: string; data: string }[]) => void
  interrupt: () => void
  respond: (id: string, allow: boolean) => void
  setPermissionMode: (mode: PermissionMode) => void
  setModel: (model: string, providerId?: string) => void
  openTerminal: (cols: number, rows: number) => void
  attachTerminal: (terminalId: string, cols: number, rows: number) => void
  detachTerminal: (terminalId: string) => void
  sendTerminalInput: (terminalId: string, data: string) => void
  resizeTerminal: (terminalId: string, cols: number, rows: number) => void
  closeTerminal: (terminalId: string) => void
  renameTerminal: (terminalId: string, title: string) => void
  /** Forget output already written to xterm, so it is not replayed. */
  drainTerminal: (terminalId: string, count: number) => void
}

export function useSession(
  connection: Connection,
  sessionId: string | null,
  onSessionUpdate?: (session: SessionSummary) => void,
  onRevoked?: () => void,
): LiveSession {
  // The socket is read by callbacks that must not re-run when it changes, and
  // the seq is read by the socket at reconnect time — both need a ref rather
  // than state.
  const streamRef = useRef<SessionStream | null>(null)
  const lastSeqRef = useRef(0)

  const updateRef = useRef(onSessionUpdate)
  updateRef.current = onSessionUpdate

  const revokedRef = useRef(onRevoked)
  revokedRef.current = onRevoked

  const eventsRef = useRef<EnvelopedEvent[]>([])
  const outputRef = useRef(new Map<string, string[]>())
  const frameRef = useRef<number | null>(null)

  const flushFrame = useCallback(() => {
    if (frameRef.current != null) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }

    const events = eventsRef.current
    if (events.length > 0) {
      eventsRef.current = []
      useLiveSession.setState((current) => {
        const transcript = applyEvents(current.transcript, events)
        lastSeqRef.current = transcript.lastSeq
        return transcript === current.transcript ? current : { transcript }
      })
    }

    const output = outputRef.current
    if (output.size > 0) {
      outputRef.current = new Map()
      useLiveSession.setState((current) => {
        const terminals = applyTerminalOutputs(current.terminals, output)
        return terminals === current.terminals ? current : { terminals }
      })
    }
  }, [])

  const scheduleFlush = useCallback(() => {
    if (frameRef.current != null) return
    frameRef.current = requestAnimationFrame(flushFrame)
  }, [flushFrame])

  const cancelFlush = useCallback(() => {
    if (frameRef.current != null) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
    eventsRef.current = []
    outputRef.current = new Map()
  }, [])

  useEffect(() => {
    const stream = new SessionStream(
      connection.address,
      connection.deviceToken,
      {
        onStatus: (next) => {
          useLiveSession.setState({ status: next })
          // A refused-connect error is only useful while we are down. Once the
          // socket is live it would sit under the composer as if the send failed.
          if (isStreamConnected(next)) useLiveSession.setState({ error: null })
        },
        onFailure: (reason) => {
          useLiveSession.setState({ error: reason })
        },
        onRevoked: () => revokedRef.current?.(),
        onMessage: (message) => {
          switch (message.type) {
            case 'event':
              eventsRef.current.push(message.event)
              scheduleFlush()
              return
            case 'session_update':
              updateRef.current?.(message.session)
              return
            case 'command_error':
              flushFrame()
              useLiveSession.setState({ error: message.message })
              return
            case 'subscription_closed':
              flushFrame()
              // The session is over. Reconnecting would resubscribe to
              // something that will never send again.
              useLiveSession.setState({ status: 'live' })
              return
            case 'caught_up':
              flushFrame()
              return
            case 'terminal_output':
              {
                const queued = outputRef.current.get(message.terminalId)
                if (queued) queued.push(message.data)
                else outputRef.current.set(message.terminalId, [message.data])
                scheduleFlush()
              }
              return
            case 'terminal_list':
            case 'terminal_opened':
            case 'terminal_exit':
              flushFrame()
              useLiveSession.setState((current) => {
                const terminals = applyTerminalMessage(current.terminals, message)
                return terminals === current.terminals ? current : { terminals }
              })
              return
          }
        },
      },
      () => lastSeqRef.current,
    )

    streamRef.current = stream
    stream.connect()

    return () => {
      cancelFlush()
      stream.close()
      streamRef.current = null
    }
  }, [
    connection.deviceToken,
    connection.address.host,
    connection.address.port,
    scheduleFlush,
    flushFrame,
    cancelFlush,
  ])

  // Switching sessions resets the transcript before subscribing, so the
  // previous session's messages never appear under the new one's header.
  // The stream is a new instance when the server changes, even if the
  // id is unchanged — without those deps the subscribe never re-fires.
  useEffect(() => {
    if (!sessionId) return

    cancelFlush()
    resetLiveSession(useLiveSession.getState().status)
    lastSeqRef.current = 0

    const stream = streamRef.current
    stream?.subscribe(sessionId)

    return () => {
      cancelFlush()
      stream?.unsubscribe(sessionId)
    }
  }, [
    sessionId,
    connection.deviceId,
    connection.deviceToken,
    connection.address.host,
    connection.address.port,
    cancelFlush,
  ])

  const send = useCallback(
    (text: string, files?: { name: string; data: string }[]) => {
      if (!sessionId) return

      useLiveSession.setState({ error: null })

      // The prompt comes back as a `user_prompt` event and is folded in like
      // anything else. Appending it here too would show it twice, and the local
      // copy is the one that would not survive a reload.
      streamRef.current?.prompt(sessionId, text, undefined, files)
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
      useLiveSession.setState((current) => ({
        transcript: answerPermission(current.transcript, id, allow),
      }))
    },
    [sessionId],
  )

  const setPermissionMode = useCallback(
    (mode: PermissionMode) => {
      if (!sessionId) return
      streamRef.current?.setPermissionMode(sessionId, mode)
    },
    [sessionId],
  )

  const setModel = useCallback(
    (model: string, providerId?: string) => {
      if (!sessionId) return
      streamRef.current?.setModel(sessionId, model, providerId)
    },
    [sessionId],
  )

  const openTerminal = useCallback(
    (cols: number, rows: number) => {
      if (!sessionId) return

      useLiveSession.setState({ error: null })
      streamRef.current?.openTerminal(sessionId, cols, rows)
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
      useLiveSession.setState((current) => ({
        terminals: removeTab(current.terminals, terminalId),
      }))
    },
    [sessionId],
  )

  const renameTerminal = useCallback(
    (terminalId: string, title: string) => {
      if (!sessionId) return

      // Applied locally first: a tab that waits for the round trip to change
      // its label feels like the input did nothing.
      useLiveSession.setState((current) => ({
        terminals: renameTab(current.terminals, terminalId, title),
      }))
      streamRef.current?.renameTerminal(sessionId, terminalId, title)
    },
    [sessionId],
  )

  const drainTerminal = useCallback((terminalId: string, count: number) => {
    useLiveSession.setState((current) => ({
      terminals: drainTab(current.terminals, terminalId, count),
    }))
  }, [])

  return {
    send,
    interrupt,
    respond,
    setPermissionMode,
    setModel,
    openTerminal,
    attachTerminal,
    detachTerminal,
    sendTerminalInput,
    resizeTerminal,
    closeTerminal,
    renameTerminal,
    drainTerminal,
  }
}
