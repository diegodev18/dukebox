import type { SessionStatus } from '@dukebox/protocol'

/**
 * Whether a sidebar session_update should fire the waiting-input alert.
 *
 * Only a transition onto `waiting_input` counts — reconnects echo the same
 * summary and must not toast again. Quiet only when the person is actually
 * looking at that session (selected, transcript on screen, window visible).
 */
export function shouldNotifyWaiting(input: {
  previousStatus: SessionStatus | undefined
  nextStatus: SessionStatus
  lookingAtSession: boolean
  enabled: boolean
}): boolean {
  if (!input.enabled) return false
  if (input.nextStatus !== 'waiting_input') return false
  if (input.previousStatus === 'waiting_input') return false
  return !input.lookingAtSession
}

/**
 * Ask the OS for notification permission.
 *
 * Must run from a user gesture (the Appearance toggle). WebKit ignores or
 * auto-denies the same call from a socket callback.
 */
export function requestNotificationPermission(): void {
  try {
    if (typeof Notification === 'undefined') return
    if (Notification.permission !== 'default') return
    void Notification.requestPermission().catch(() => undefined)
  } catch {
    // Missing or broken Notification must not break Settings.
  }
}

/**
 * OS notification that a session needs the user.
 *
 * Uses `window.Notification` when permission is already granted. Denied or
 * still-default is a no-op — the prompt has to come from a click, and
 * throwing here would take down the session update path.
 */
export function notifyWaitingInput(title: string, onClick?: () => void): void {
  try {
    if (typeof Notification === 'undefined') return
    if (Notification.permission !== 'granted') return

    const notification = new Notification(title, { body: 'Waiting for you' })
    notification.onclick = () => {
      try {
        window.focus()
      } catch {
        // Focusing the window is best-effort; selecting the session still helps.
      }
      onClick?.()
      notification.close()
    }
  } catch {
    // Never throw: session updates must keep applying.
  }
}
