import type { ProjectSummary, SessionSummary } from '@dukebox/protocol'
import { useEffect, useState } from 'react'
import { DukeboxClient } from '../lib/client.js'
import type { Connection } from '../lib/connection.js'
import { Composer } from '../components/Composer.js'
import { Sidebar } from '../components/Sidebar.js'
import { Transcript } from '../components/Transcript.js'
import { Workspace } from '../components/Workspace.js'
import { useSession, type LiveSession } from '../lib/useSession.js'

/**
 * The session view.
 *
 * Three columns: the sessions a person has, the conversation with one of them,
 * and the workspace that session is changing.
 */

interface Props {
  connection: Connection
  onDisconnected: () => void
}

export function Session({ connection, onDisconnected }: Props) {
  const client = new DukeboxClient(connection.address, connection.deviceToken)

  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        const [loadedProjects, loadedSessions] = await Promise.all([
          client.listProjects(),
          client.listSessions(),
        ])

        if (cancelled) return

        setProjects(loadedProjects)
        setSessions(loadedSessions)
        setSelected((current) => current ?? loadedSessions[0]?.id ?? null)
        setLoading(false)
      } catch {
        // The token worked at launch, so a failure here means the server went
        // away rather than that the pairing is bad.
        if (!cancelled) onDisconnected()
      }
    }

    void load()
    return () => {
      cancelled = true
    }
    // The client is derived from the connection, so this reruns when the user
    // switches servers.
  }, [connection.deviceToken])

  // Session summaries arrive over the socket too, so the sidebar's status dots
  // follow a running agent without polling.
  const live = useSession(connection, selected, (updated) => {
    setSessions((current) =>
      current.map((session) => (session.id === updated.id ? updated : session)),
    )
  })

  const current = sessions.find((session) => session.id === selected) ?? null

  return (
    <div className="grid h-svh grid-cols-[236px_minmax(0,1fr)_clamp(340px,30vw,460px)] has-[[data-collapsed]]:grid-cols-[236px_minmax(0,1fr)_244px]">
      <Sidebar
        connection={connection}
        projects={projects}
        sessions={sessions}
        selectedId={selected}
        onSelect={setSelected}
      />

      <SessionColumn session={current} loading={loading} live={live} />

      <Workspace session={current} />
    </div>
  )
}

function SessionColumn({
  session,
  loading,
  live,
}: {
  session: SessionSummary | null
  loading: boolean
  live: LiveSession
}) {
  if (loading) return <div />

  if (!session) {
    return (
      <div className="grid place-items-center px-6">
        <div className="measure text-center">
          <h2 className="font-medium">No sessions yet</h2>
          <p className="mt-2 text-muted-foreground">
            Start one from a project in the sidebar. It runs on your server, so you can close this
            window and come back to it.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-w-0 flex-col">
      <header className="flex items-center gap-2.5 border-b border-border px-4.5 py-2.5">
        <h1 className="truncate font-medium">{session.title}</h1>
        <span className="flex-1" />
        <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
          <StatusDot status={session.status} />
          {session.agentId}
        </span>
      </header>

      {live.status === 'offline' && (
        <p className="border-b border-border bg-surface px-4.5 py-2 text-[12.5px] text-muted-foreground">
          Reconnecting… the session keeps running on your server.
        </p>
      )}

      {live.error && (
        <p className="border-b border-border bg-destructive/10 px-4.5 py-2 text-[12.5px] text-destructive">
          {live.error}
        </p>
      )}

      <Transcript transcript={live.transcript} onRespond={live.respond} />

      <Composer
        onSend={live.send}
        onInterrupt={live.interrupt}
        running={live.transcript.running}
        disabled={live.status === 'offline'}
      />
    </div>
  )
}

export function StatusDot({ status }: { status: SessionSummary['status'] }) {
  const tone = {
    provisioning: 'bg-running',
    running: 'bg-running',
    waiting_input: 'bg-waiting',
    done: 'bg-done opacity-50',
    failed: 'bg-destructive',
    stopped: 'bg-muted-foreground opacity-50',
  }[status]

  // Only a working session animates. It is the difference between "still
  // going" and "stuck", and nothing else on screen says which.
  const live = status === 'running' || status === 'provisioning'

  return (
    <span
      className={`size-1.5 flex-none rounded-full ${tone} ${live ? 'motion-safe:animate-pulse' : ''}`}
    />
  )
}
