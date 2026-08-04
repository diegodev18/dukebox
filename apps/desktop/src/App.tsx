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
      const connection = await activeConnection()

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
        await removeConnection(connection.deviceId)
        if (!cancelled) setState({ kind: 'unpaired' })
      }
    }

    void restore()
    return () => {
      cancelled = true
    }
  }, [])

  if (state.kind === 'checking') {
    // Deliberately blank. The check takes a moment, and a spinner that flashes
    // for 200ms is noise rather than feedback.
    return <div className="min-h-svh" />
  }

  if (state.kind === 'unpaired') {
    return <Pairing onPaired={(connection) => setState({ kind: 'ready', connection })} />
  }

  return (
    <Session connection={state.connection} onDisconnected={() => setState({ kind: 'unpaired' })} />
  )
}
