import { useEffect, useState } from 'react'
import { DukeboxClient } from './lib/client.js'
import { activeConnection, removeConnection, type Connection } from './lib/connection.js'
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
  const [state, setState] = useState<State>({ kind: 'checking' })

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

  if (state.kind === 'checking') {
    // Blank on purpose for the moment the check takes — a spinner that flashes
    // for 200ms is noise rather than feedback. If it lasts, `Checking` says so
    // instead of leaving a black window that looks like a crash.
    return <Checking />
  }

  if (state.kind === 'unpaired') {
    return <Pairing onPaired={(connection) => setState({ kind: 'ready', connection })} />
  }

  return (
    <Session connection={state.connection} onDisconnected={() => setState({ kind: 'unpaired' })} />
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
