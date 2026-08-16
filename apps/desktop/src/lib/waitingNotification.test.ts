import { afterEach, describe, expect, it, vi } from 'vitest'
import { notifyWaitingInput, shouldNotifyWaiting } from '@/lib/waitingNotification'

const SESSION = '00000000-0000-4000-8000-000000000011'
const OTHER = '00000000-0000-4000-8000-000000000012'

describe('shouldNotifyWaiting', () => {
  it('notifies when a non-selected session transitions to waiting_input', () => {
    expect(
      shouldNotifyWaiting({
        previousStatus: 'running',
        nextStatus: 'waiting_input',
        sessionId: OTHER,
        selectedId: SESSION,
        documentHidden: false,
        enabled: true,
      }),
    ).toBe(true)
  })

  it('stays quiet when the selected session is focused and the document is visible', () => {
    expect(
      shouldNotifyWaiting({
        previousStatus: 'running',
        nextStatus: 'waiting_input',
        sessionId: SESSION,
        selectedId: SESSION,
        documentHidden: false,
        enabled: true,
      }),
    ).toBe(false)
  })

  it('notifies when the selected session waits but the window is hidden', () => {
    expect(
      shouldNotifyWaiting({
        previousStatus: 'running',
        nextStatus: 'waiting_input',
        sessionId: SESSION,
        selectedId: SESSION,
        documentHidden: true,
        enabled: true,
      }),
    ).toBe(true)
  })

  it('does not notify on another echo of the same waiting session', () => {
    expect(
      shouldNotifyWaiting({
        previousStatus: 'waiting_input',
        nextStatus: 'waiting_input',
        sessionId: OTHER,
        selectedId: SESSION,
        documentHidden: false,
        enabled: true,
      }),
    ).toBe(false)
  })

  it('does not notify when the setting is off', () => {
    expect(
      shouldNotifyWaiting({
        previousStatus: 'running',
        nextStatus: 'waiting_input',
        sessionId: OTHER,
        selectedId: SESSION,
        documentHidden: false,
        enabled: false,
      }),
    ).toBe(false)
  })
})

describe('notifyWaitingInput', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('constructs a notification when permission is already granted', () => {
    const notification: { onclick: (() => void) | null; close: () => void } = {
      onclick: null,
      close: vi.fn(),
    }
    const NotificationMock = vi.fn(function Notification() {
      return notification
    })
    Object.defineProperty(NotificationMock, 'permission', { value: 'granted' })
    vi.stubGlobal('Notification', NotificationMock)

    vi.spyOn(window, 'focus').mockImplementation(() => undefined)
    const onClick = vi.fn()
    notifyWaitingInput('Fix the demux bug', onClick)

    expect(NotificationMock).toHaveBeenCalledWith('Fix the demux bug', { body: 'Waiting for you' })
    notification.onclick?.()
    expect(onClick).toHaveBeenCalled()
    expect(notification.close).toHaveBeenCalled()
  })

  it('is a no-op when permission was denied', () => {
    const NotificationMock = vi.fn()
    Object.defineProperty(NotificationMock, 'permission', { value: 'denied' })
    vi.stubGlobal('Notification', NotificationMock)

    notifyWaitingInput('Fix the demux bug')
    expect(NotificationMock).not.toHaveBeenCalled()
  })

  it('does not throw when Notification is missing', () => {
    vi.stubGlobal('Notification', undefined)
    expect(() => notifyWaitingInput('Fix the demux bug')).not.toThrow()
  })
})
