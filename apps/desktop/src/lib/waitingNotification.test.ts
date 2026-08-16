import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  notifyWaitingInput,
  requestNotificationPermission,
  shouldNotifyWaiting,
} from '@/lib/waitingNotification'

describe('shouldNotifyWaiting', () => {
  it('notifies when a session transitions to waiting_input and is not on screen', () => {
    expect(
      shouldNotifyWaiting({
        previousStatus: 'running',
        nextStatus: 'waiting_input',
        lookingAtSession: false,
        enabled: true,
      }),
    ).toBe(true)
  })

  it('stays quiet when the person is looking at that session', () => {
    expect(
      shouldNotifyWaiting({
        previousStatus: 'running',
        nextStatus: 'waiting_input',
        lookingAtSession: true,
        enabled: true,
      }),
    ).toBe(false)
  })

  it('does not notify on another echo of the same waiting session', () => {
    expect(
      shouldNotifyWaiting({
        previousStatus: 'waiting_input',
        nextStatus: 'waiting_input',
        lookingAtSession: false,
        enabled: true,
      }),
    ).toBe(false)
  })

  it('does not notify when the setting is off', () => {
    expect(
      shouldNotifyWaiting({
        previousStatus: 'running',
        nextStatus: 'waiting_input',
        lookingAtSession: false,
        enabled: false,
      }),
    ).toBe(false)
  })
})

describe('requestNotificationPermission', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('asks when permission is still default', () => {
    const requestPermission = vi.fn().mockResolvedValue('granted')
    const NotificationMock = Object.assign(vi.fn(), {
      permission: 'default',
      requestPermission,
    })
    vi.stubGlobal('Notification', NotificationMock)

    requestNotificationPermission()
    expect(requestPermission).toHaveBeenCalled()
  })

  it('does not ask again once granted or denied', () => {
    const requestPermission = vi.fn()
    vi.stubGlobal(
      'Notification',
      Object.assign(vi.fn(), { permission: 'granted', requestPermission }),
    )
    requestNotificationPermission()
    expect(requestPermission).not.toHaveBeenCalled()
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
    const requestPermission = vi.fn()
    const NotificationMock = Object.assign(
      vi.fn(function Notification() {
        return notification
      }),
      { permission: 'granted', requestPermission },
    )
    vi.stubGlobal('Notification', NotificationMock)

    vi.spyOn(window, 'focus').mockImplementation(() => undefined)
    const onClick = vi.fn()
    notifyWaitingInput('Fix the demux bug', onClick)

    expect(NotificationMock).toHaveBeenCalledWith('Fix the demux bug', { body: 'Waiting for you' })
    expect(requestPermission).not.toHaveBeenCalled()
    notification.onclick?.()
    expect(onClick).toHaveBeenCalled()
    expect(notification.close).toHaveBeenCalled()
  })

  it('is a no-op when permission was denied', () => {
    const NotificationMock = Object.assign(vi.fn(), {
      permission: 'denied',
      requestPermission: vi.fn(),
    })
    vi.stubGlobal('Notification', NotificationMock)

    notifyWaitingInput('Fix the demux bug')
    expect(NotificationMock).not.toHaveBeenCalled()
    expect(NotificationMock.requestPermission).not.toHaveBeenCalled()
  })

  it('does not prompt from the socket path when permission is still default', () => {
    const NotificationMock = Object.assign(vi.fn(), {
      permission: 'default',
      requestPermission: vi.fn(),
    })
    vi.stubGlobal('Notification', NotificationMock)

    notifyWaitingInput('Fix the demux bug')
    expect(NotificationMock).not.toHaveBeenCalled()
    expect(NotificationMock.requestPermission).not.toHaveBeenCalled()
  })

  it('does not throw when Notification is missing', () => {
    vi.stubGlobal('Notification', undefined)
    expect(() => notifyWaitingInput('Fix the demux bug')).not.toThrow()
    expect(() => requestNotificationPermission()).not.toThrow()
  })
})
