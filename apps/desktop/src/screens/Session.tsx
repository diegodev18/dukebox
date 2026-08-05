import type { ProjectSummary, SessionSummary } from '@dukebox/protocol'
import { useEffect, useMemo, useState } from 'react'
import { DukeboxClient } from '../lib/client.js'
import type { Connection } from '../lib/connection.js'
import { AgentIcon, hasAgentIcon } from '../components/AgentIcon.js'
import { Composer } from '../components/Composer.js'
import { PullRequest } from '../components/PullRequest.js'
import { Sidebar } from '../components/Sidebar.js'
import { Transcript } from '../components/Transcript.js'
import { Workspace } from '../components/Workspace.js'
import { useSession, type LiveSession } from '../lib/useSession.js'
import { NewSession } from './NewSession.js'

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
  // Memoised because it is passed to effects: a new client every render would
  // re-run them forever.
  const client = useMemo(
    () => new DukeboxClient(connection.address, connection.deviceToken),
    [connection.address.host, connection.address.port, connection.deviceToken],
  )

  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)

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
  }, [client])

  // Session summaries arrive over the socket too, so the sidebar's status dots
  // follow a running agent without polling.
  const live = useSession(connection, selected, (updated) => {
    setSessions((current) =>
      current.map((session) => (session.id === updated.id ? updated : session)),
    )
  })

  const current = sessions.find((session) => session.id === selected) ?? null

  return (
    // `h-full` fills the locked `#root`; `overflow-hidden` keeps any column
    // that still misbehaves from scrolling the window itself. Internal
    // panels (`Transcript`, sidebar list, workspace files) own their scroll.
    <div className="grid h-full grid-cols-[236px_minmax(0,1fr)_clamp(340px,30vw,460px)] overflow-hidden has-[[data-collapsed]]:grid-cols-[236px_minmax(0,1fr)_244px]">
      <Sidebar
        connection={connection}
        projects={projects}
        sessions={sessions}
        selectedId={creating ? null : selected}
        onSelect={(sessionId) => {
          setCreating(false)
          setSelected(sessionId)
        }}
        onNewSession={() => setCreating(true)}
        onArchive={(sessionId) => {
          void (async () => {
            try {
              await client.archiveSession(sessionId)
            } catch {
              // Leave the row where it is: a failed archive that vanishes
              // from the list looks like the session was deleted.
              return
            }

            let fallback: string | null = null
            setSessions((current) => {
              const next = current.filter((session) => session.id !== sessionId)
              fallback = next[0]?.id ?? null
              return next
            })
            setSelected((currentSelected) =>
              currentSelected === sessionId ? fallback : currentSelected,
            )
          })()
        }}
      />

      {loading ? (
        <div />
      ) : creating || !current ? (
        <NewSession
          client={client}
          projects={projects}
          onCreated={(session, project) => {
            // Added locally rather than refetched: the session exists but its
            // container is still building, and a list that only updates on the
            // next poll makes a started session look like it failed.
            if (project) setProjects((current) => [project, ...current])
            setSessions((current) => [session, ...current])
            setSelected(session.id)
            setCreating(false)
          }}
        />
      ) : (
        <SessionColumn
          session={current}
          live={live}
          client={client}
          onPullRequest={(url) =>
            setSessions((sessions) =>
              sessions.map((session) =>
                session.id === selected ? { ...session, pullRequestUrl: url } : session,
              ),
            )
          }
        />
      )}

      <Workspace
        session={creating ? null : current}
        files={creating ? [] : live.transcript.files}
      />
    </div>
  )
}

function SessionColumn({
  session,
  live,
  client,
  onPullRequest,
}: {
  session: SessionSummary
  live: LiveSession
  client: DukeboxClient
  onPullRequest: (url: string) => void
}) {
  return (
    // `min-h-0` is what makes the transcript scroll instead of the window
    // growing. A flex item defaults to `min-height: auto`, which refuses to
    // shrink below its content, so the child's `overflow-y-auto` never has a
    // bounded height to scroll within and the column pushes the grid open.
    <div className="flex min-h-0 min-w-0 flex-col">
      <header className="flex items-center gap-2.5 border-b border-border px-4.5 py-2.5">
        <h1 className="truncate font-medium">{session.title}</h1>
        <span className="flex-1" />

        <PullRequest
          client={client}
          session={session}
          changedFiles={live.transcript.files.length}
          onOpened={onPullRequest}
        />

        <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
          <StatusDot status={session.status} />
          {hasAgentIcon(session.agentId) ? (
            <AgentIcon agentId={session.agentId} />
          ) : (
            session.agentId
          )}
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
