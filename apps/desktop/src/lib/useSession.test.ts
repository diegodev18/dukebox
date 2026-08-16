import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamHandlers } from '@/lib/stream'
import { resetLiveSession, useLiveSession } from '@/lib/liveSession'
import type { Connection } from '@/lib/connection'

const { MockStream } = vi.hoisted(() => {
  class MockStream {
    static last: MockStream | undefined
    connect = vi.fn()
    close = vi.fn()
    subscribe = vi.fn()
    unsubscribe = vi.fn()
    prompt = vi.fn()
    interrupt = vi.fn()
    answerPermission = vi.fn()
    setPermissionMode = vi.fn()
    handlers!: StreamHandlers

    constructor(_address: unknown, _token: unknown, handlers: StreamHandlers, _resume?: unknown) {
      this.handlers = handlers
      MockStream.last = this
    }
  }
  return { MockStream }
})

vi.mock('@/lib/stream', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/stream')>()
  return { ...actual, SessionStream: MockStream }
})

import { useSession } from '@/lib/useSession'

const connection: Connection = {
  serverName: 'debian-01',
  address: { host: 'debian-01.tailnet.ts.net', port: 7777, tls: false },
  deviceId: 'device-1',
  deviceToken: 'token-1',
  pairedAt: 1,
}

const SESSION = '00000000-0000-4000-8000-000000000011'
const OTHER = '00000000-0000-4000-8000-000000000012'

let frames: FrameRequestCallback[] = []

beforeEach(() => {
  frames = []
  MockStream.last = undefined
  resetLiveSession('live')
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames[id - 1] = () => undefined
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function flushFrames() {
  const queued = frames
  frames = []
  for (const frame of queued) frame(0)
}

describe('useSession', () => {
  it('connects on mount and closes on unmount', () => {
    const { unmount } = renderHook(() => useSession(connection, SESSION))

    expect(MockStream.last?.connect).toHaveBeenCalled()
    unmount()
    expect(MockStream.last?.close).toHaveBeenCalled()
  })

  it('subscribes when a session is selected and swaps on change', () => {
    const { rerender } = renderHook(
      ({ sessionId }: { sessionId: string | null }) => useSession(connection, sessionId),
      { initialProps: { sessionId: SESSION } },
    )

    expect(MockStream.last?.subscribe).toHaveBeenCalledWith(SESSION)

    rerender({ sessionId: OTHER })
    expect(MockStream.last?.unsubscribe).toHaveBeenCalledWith(SESSION)
    expect(MockStream.last?.subscribe).toHaveBeenCalledWith(OTHER)
  })

  it('flushes events on the next animation frame', () => {
    renderHook(() => useSession(connection, SESSION))

    act(() => {
      MockStream.last?.handlers.onMessage({
        type: 'event',
        event: {
          seq: 1,
          sessionId: SESSION,
          ts: Date.now(),
          event: { type: 'assistant_text', delta: 'hello' },
        },
      })
    })

    expect(useLiveSession.getState().transcript.blocks).toHaveLength(0)

    act(() => flushFrames())

    expect(useLiveSession.getState().transcript.blocks).toContainEqual(
      expect.objectContaining({ kind: 'text', text: 'hello' }),
    )
  })

  it('surfaces a command error', () => {
    renderHook(() => useSession(connection, SESSION))

    act(() => {
      MockStream.last?.handlers.onMessage({
        type: 'command_error',
        message: 'session is not running',
      })
    })

    expect(useLiveSession.getState().error).toBe('session is not running')
  })

  it('surfaces a send failure as a live session error', () => {
    renderHook(() => useSession(connection, SESSION))

    act(() => {
      MockStream.last?.handlers.onFailure?.('the connection was refused before reaching the server')
    })

    expect(useLiveSession.getState().error).toBe(
      'the connection was refused before reaching the server',
    )
  })

  it('forwards revoke from the stream', () => {
    const onRevoked = vi.fn()
    renderHook(() => useSession(connection, SESSION, undefined, onRevoked))

    act(() => MockStream.last?.handlers.onRevoked?.())
    expect(onRevoked).toHaveBeenCalled()
  })

  it('sends a prompt with files only when a session is selected', () => {
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string | null }) => useSession(connection, sessionId),
      { initialProps: { sessionId: SESSION } },
    )

    act(() => {
      result.current.send('read this', [
        { name: 'notes.txt', data: 'data:text/plain;base64,aGVsbG8=' },
      ])
    })

    expect(MockStream.last?.prompt).toHaveBeenCalledWith(SESSION, 'read this', undefined, [
      { name: 'notes.txt', data: 'data:text/plain;base64,aGVsbG8=' },
    ])

    rerender({ sessionId: null })
    act(() => result.current.send('nope'))
    expect(MockStream.last?.prompt).toHaveBeenCalledTimes(1)
  })

  it('answers a permission locally and on the wire', () => {
    const { result } = renderHook(() => useSession(connection, SESSION))

    act(() => {
      result.current.respond('req-1', true)
    })

    expect(MockStream.last?.answerPermission).toHaveBeenCalledWith(SESSION, 'req-1', true)
  })
})
