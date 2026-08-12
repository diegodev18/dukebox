import { useCallback, useEffect, useState } from 'react'
import { checkForUpdate, installUpdate, type DownloadProgress, type Update } from './updater.js'

/**
 * The app's relationship with its own version, as a state machine.
 *
 * `checking` is transient, `up-to-date` is the state most launches end in,
 * and the interesting ones — an update on offer, one being downloaded, or a
 * download that failed — are what the banner renders. The distinction between
 * "no update" and "could not check" is deliberately erased here: neither is
 * something the user can act on, so both arrive as `up-to-date`.
 *
 * Dismissing an update only lasts until the next check; the launch check on
 * the next start asks again, and a manual check revives a dismissed banner if
 * the update is still there.
 */

export type UpdateState =
  | { status: 'checking' }
  | { status: 'up-to-date' }
  | { status: 'available'; update: Update }
  | { status: 'downloading'; version: string; progress: DownloadProgress }
  | { status: 'error'; message: string }

export interface UseUpdate {
  state: UpdateState
  /**
   * Whether the first launch check has resolved. The banner uses this to skip
   * the initial `checking` state, which would otherwise flash on every start
   * before the feed answers.
   */
  checked: boolean
  /** True after the user told a found update to go away for now. */
  dismissed: boolean
  /**
   * True briefly after a manual check that found nothing, so the "Check for
   * updates" button can answer "You're up to date" instead of doing nothing.
   */
  announcing: boolean
  /** Ask the feed again; also revives a dismissed banner if the update remains. */
  check: (manual?: boolean) => void
  /** Download, install, and relaunch into the given update. */
  install: (update: Update) => void
  /** Hide the current notification until the next check. */
  dismiss: () => void
}

export function useUpdate(): UseUpdate {
  const [state, setState] = useState<UpdateState>({ status: 'checking' })
  const [checked, setChecked] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [announcing, setAnnouncing] = useState(false)

  useEffect(() => {
    if (!announcing) return
    const timer = setTimeout(() => setAnnouncing(false), 4000)
    return () => clearTimeout(timer)
  }, [announcing])

  const check = useCallback((manual = false) => {
    // A fresh check is a fresh chance to be told: dismissing last week's
    // update must not swallow this week's.
    setDismissed(false)
    setState({ status: 'checking' })

    void checkForUpdate().then((update) => {
      setChecked(true)
      if (update) {
        setState({ status: 'available', update })
      } else {
        setState({ status: 'up-to-date' })
        if (manual) setAnnouncing(true)
      }
    })
  }, [])

  useEffect(() => {
    check()
  }, [check])

  const install = useCallback((update: Update) => {
    setState({
      status: 'downloading',
      version: update.version,
      progress: { received: 0, total: null },
    })

    void installUpdate(update, (progress) =>
      setState({ status: 'downloading', version: update.version, progress }),
    )
      // Installing ends in a relaunch, so this line runs only when the relaunch
      // was skipped — the app is as new as it is going to get either way.
      .then(() => setState({ status: 'up-to-date' }))
      .catch((error: unknown) => {
        // The download or install failed; the update is still on offer, so the
        // error state offers a way back to it (via a fresh check).
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      })
  }, [])

  const dismiss = useCallback(() => setDismissed(true), [])

  return { state, checked, dismissed, announcing, check, install, dismiss }
}
