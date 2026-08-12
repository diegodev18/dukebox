import { useEffect, useState } from 'react'
import { UpdateBanner } from './components/UpdateBanner.js'
import { DukeboxClient } from './lib/client.js'
import { activeConnection, removeConnection, type Connection } from './lib/connection.js'
import type { Settings } from './lib/settings.js'
import { useSettings } from './lib/useSettings.js'
import { useUpdate } from './lib/useUpdate.js'
import { Pairing } from './screens/Pairing.js'
import { Session } from './screens/Session.js'

/**
 * What the window shows.
 *
 * Three states, in the order a person meets them: checking a stored pairing,
 * pairing for the first time, and using the app. There is no route for "no
 * server" beyond pairing, because without one there is nothing to show.
 */

type State = { kind: 'checking' } | { kind: 'unpaired' } | { kind: 'ready'; connection: Connection }

export function App() {
  // Settings gate the app's behaviour (theme, the launch update check), so the
  // real UI waits for the store file rather than starting with defaults and
  // correcting itself a frame later.
  const { settings, save } = useSettings()

  if (settings === null) return <div className="h-full" />

  return <Loaded settings={settings} onSaveSettings={save} />
}

function Loaded({
  settings,
  onSaveSettings,
}: {
  settings: Settings
  onSaveSettings: (patch: Partial<Settings>) => void
}) {
  const [state, setState] = useState<State>({ kind: 'checking' })

  // Self-updates are app-level: whether an update exists does not depend on
  // which server this copy is paired to, so the check lives here rather than
  // inside a screen. Whether it runs at launch is the setting that owns it.
  const update = useUpdate(settings.checkForUpdatesOnLaunch)

  useEffect(() => {
    let cancelled = false

    const restore = async () => {
      let connection: Connection | null = null

      try {
        connection = await activeConnection()
      } catch (error) {
        // Reading stored credentials can fail — a keychain that denies access,
        // a store file written by a newer version. Left unhandled this
        // rejected before any state was set, and the window stayed on the
        // blank checking screen with nothing to say why.
        console.error('could not read saved connections:', error)
        if (!cancelled) setState({ kind: 'unpaired' })
        return
      }

      if (!connection) {
        if (!cancelled) setState({ kind: 'unpaired' })
        return
      }

      // The token is verified rather than trusted: it may have been revoked
      // from another device, and finding that out at launch is better than
      // finding it out when a session fails to start.
      const client = new DukeboxClient(connection.address, connection.deviceToken)

      try {
        await client.whoami()
        if (!cancelled) setState({ kind: 'ready', connection })
      } catch {
        // A revoked or unreachable server sends the user back to pairing with
        // the stale entry cleared, rather than to a screen that cannot load.
        await removeConnection(connection.deviceId).catch(() => undefined)
        if (!cancelled) setState({ kind: 'unpaired' })
      }
    }

    // Nothing below may reject: an unhandled rejection here is a blank window.
    void restore().catch((error: unknown) => {
      console.error('startup failed:', error)
      if (!cancelled) setState({ kind: 'unpaired' })
    })
    return () => {
      cancelled = true
    }
  }, [])

  // The settings panel picks an already-paired server as the active one. The
  // connection object is in hand — the token was stored at pairing — so the
  // switch is local; if the server has since revoked it, the session screen's
  // first load fails and lands back on pairing.
  const switchServer = (connection: Connection) => setState({ kind: 'ready', connection })

  // Which screen. `checking` is blank on purpose for the moment the check
  // takes — a spinner that flashes for 200ms is noise rather than feedback.
  let screen: React.ReactNode
  if (state.kind === 'checking') {
    screen = <Checking />
  } else if (state.kind === 'unpaired') {
    screen = <Pairing onPaired={(connection) => setState({ kind: 'ready', connection })} />
  } else {
    screen = (
      <Session
        connection={state.connection}
        settings={settings}
        update={update}
        onSaveSettings={onSaveSettings}
        onSwitchServer={switchServer}
        onDisconnected={() => setState({ kind: 'unpaired' })}
      />
    )
  }

  // The update notification is a toast: it floats over the corner of whatever
  // screen is up, so nothing below has to know it exists. Each screen keeps
  // its own full-height layout.
  return (
    <div className="flex h-full flex-col">
      <UpdateBanner
        state={update.state}
        checked={update.checked}
        dismissed={update.dismissed}
        announcing={update.announcing}
        onInstall={update.install}
        onRecheck={update.check}
        onDismiss={update.dismiss}
      />
      <div className="min-h-0 flex-1">{screen}</div>
    </div>
  )
}

/**
 * The gap before the app knows where it is connected.
 *
 * Silent for the first moment, then it speaks. A window that stays black
 * looks like a crash, and the difference between "still working" and "broken"
 * is the only thing a person can act on here.
 */
function Checking() {
  const [slow, setSlow] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 1200)
    return () => clearTimeout(timer)
  }, [])

  return (
    <div className="grid h-full place-items-center">
      {slow && <p className="text-muted-foreground">Checking your connection…</p>}
    </div>
  )
}
