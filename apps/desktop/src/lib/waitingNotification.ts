import type { SessionStatus } from '@dukebox/protocol'

/**
 * Whether a sidebar session_update should fire the waiting-input alert.
 *
 * Only a transition onto `waiting_input` counts — reconnects echo the same
 * summary and must not toast again. The focused selected session while this
 * window is visible is already on screen, so it stays quiet.
 */
export function shouldNotifyWaiting(input: {
  previousStatus: SessionStatus | undefined
  nextStatus: SessionStatus
  sessionId: string
  selectedId: string | null
  documentHidden: boolean
  enabled: boolean
}): boolean {
  if (!input.enabled) return false
  if (input.nextStatus !== 'waiting_input') return false
  if (input.previousStatus === 'waiting_input') return false
  const focusedAndVisible = input.sessionId === input.selectedId && !input.documentHidden
  return !focusedAndVisible
}

/**
 * OS notification that a session needs the user.
 *
 * Uses `window.Notification` when the browser has allowed it. Denied or
 * missing support is a no-op — throwing here would take down the session
 * update path that drives the sidebar.
 */
export function notifyWaitingInput(title: string, onClick?: () => void): void {
  try {
    if (typeof Notification === 'undefined') return
    if (Notification.permission === 'denied') return

    const show = () => {
      try {
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
        // The constructor can still throw after a grant (unsupported options).
      }
    }

    if (Notification.permission === 'granted') {
      show()
      return
    }

    void Notification.requestPermission()
      .then((permission) => {
        if (permission === 'granted') show()
      })
      .catch(() => undefined)
  } catch {
    // Never throw: session updates must keep applying.
  }
}
