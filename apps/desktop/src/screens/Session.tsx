import type { ProjectSummary, SessionSummary } from '@dukebox/protocol'
import { useEffect, useMemo, useState } from 'react'
import { DukeboxClient } from '../lib/client.js'
import type { Connection } from '../lib/connection.js'
import { AgentIcon, hasAgentIcon } from '../components/AgentIcon.js'
import { Composer } from '../components/Composer.js'
import { EnvironmentsPanel } from '../components/EnvironmentsPanel.js'
import { PullRequest } from '../components/PullRequest.js'
import { SessionInfo } from '../components/SessionInfo.js'
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
  /** Asks the app to re-check its own update feed (from the account menu). */
  onCheckForUpdates: () => void
}

export function Session({ connection, onDisconnected, onCheckForUpdates }: Props) {
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
  const [setupProjectId, setSetupProjectId] = useState<string | null>(null)
  const [managingProjectId, setManagingProjectId] = useState<string | null>(null)
  // Only to name the environment a review session belongs to. The summary
  // carries the id; the name lives on the environment row.
  const [environmentNames, setEnvironmentNames] = useState<Record<string, string>>({})

  const refreshProjects = async () => {
    try {
      setProjects(await client.listProjects())
    } catch {
      // Leave the local list alone; a failed refresh should not wipe the UI.
    }
  }

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

  // Names for the environment a review session belongs to. Fetched only when a
  // review is on screen, and best-effort: failing to name an environment must
  // not stop the proposal being reviewed.
  const reviewProjectId =
    current?.purpose === 'environment_setup' && current.environmentId ? current.projectId : null

  useEffect(() => {
    if (!reviewProjectId) return
    let cancelled = false

    client
      .listEnvironments(reviewProjectId)
      .then((found) => {
        if (cancelled) return
        setEnvironmentNames((names) => ({
          ...names,
          ...Object.fromEntries(found.map((one) => [one.id, one.name])),
        }))
      })
      .catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [client, reviewProjectId])

  // New session has no diffs to show — drop the workspace column so the
  // composer centres in the whole main pane rather than in a squeezed middle.
  // The environments panel is a form too, and wants the same width.
  const composing = !loading && (creating || managingProjectId !== null || current === null)

  const onSessionCreated = (session: SessionSummary, project: ProjectSummary | null) => {
    // Added locally rather than refetched: the session exists but its
    // container is still building, and a list that only updates on the
    // next poll makes a started session look like it failed.
    if (project) setProjects((current) => [project, ...current])
    setSessions((current) => [session, ...current])
    setSelected(session.id)
    setCreating(false)
    setSetupProjectId(null)
    setManagingProjectId(null)
  }

  return (
    // `h-full` fills the locked `#root`; `overflow-hidden` keeps any column
    // that still misbehaves from scrolling the window itself. Internal
    // panels (`Transcript`, sidebar list, workspace files) own their scroll.
    <div
      className={`grid h-full overflow-hidden ${
        composing
          ? 'grid-cols-[236px_minmax(0,1fr)]'
          : 'grid-cols-[236px_minmax(0,1fr)_clamp(340px,30vw,460px)] has-[[data-collapsed]]:grid-cols-[236px_minmax(0,1fr)_244px]'
      }`}
    >
      <Sidebar
        projects={projects}
        sessions={sessions}
        selectedId={creating ? null : selected}
        onCheckForUpdates={onCheckForUpdates}
        onSelect={(sessionId) => {
          setCreating(false)
          setSetupProjectId(null)
          setManagingProjectId(null)
          setSelected(sessionId)
        }}
        onNewSession={() => {
          setSetupProjectId(null)
          setManagingProjectId(null)
          setCreating(true)
        }}
        onConfigureEnvironment={(projectId) => {
          setSetupProjectId(projectId)
          setManagingProjectId(null)
          setCreating(true)
        }}
        onManageEnvironments={(projectId) => {
          setCreating(false)
          setSetupProjectId(null)
          setManagingProjectId(projectId)
        }}
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
      ) : managingProjectId ? (
        <EnvironmentsPanel client={client} projectId={managingProjectId} />
      ) : composing ? (
        <NewSession
          client={client}
          connection={connection}
          projects={projects}
          onCreated={onSessionCreated}
          preferSetupProjectId={setupProjectId}
        />
      ) : current ? (
        <>
          <SessionColumn
            session={current}
            live={live}
            client={client}
            connection={connection}
            onPullRequest={(url) =>
              setSessions((sessions) =>
                sessions.map((session) =>
                  session.id === selected ? { ...session, pullRequestUrl: url } : session,
                ),
              )
            }
          />
          <Workspace
            session={current}
            files={live.transcript.files}
            terminals={live.terminals}
            onOpenTerminal={live.openTerminal}
            onAttachTerminal={live.attachTerminal}
            onDetachTerminal={live.detachTerminal}
            onTerminalInput={live.sendTerminalInput}
            onTerminalResize={live.resizeTerminal}
            onCloseTerminal={live.closeTerminal}
            onDrainTerminal={live.drainTerminal}
            environmentReview={
              current.purpose === 'environment_setup' &&
              (current.status === 'done' || current.status === 'failed')
                ? {
                    client,
                    projectId: current.projectId,
                    sessionId: current.id,
                    environmentId: current.environmentId,
                    environmentName: current.environmentId
                      ? (environmentNames[current.environmentId] ?? null)
                      : null,
                    onSaved: () => {
                      void refreshProjects()
                    },
                  }
                : null
            }
          />
        </>
      ) : (
        <div />
      )}
    </div>
  )
}

function SessionColumn({
  session,
  live,
  client,
  connection,
  onPullRequest,
}: {
  session: SessionSummary
  live: LiveSession
  client: DukeboxClient
  connection: Connection
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
        <SessionInfo session={session} connection={connection} />
        <span className="flex-1" />

        {session.purpose !== 'environment_setup' && (
          <PullRequest
            client={client}
            session={session}
            changedFiles={live.transcript.files.length}
            onOpened={onPullRequest}
          />
        )}

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

      <Transcript
        transcript={live.transcript}
        onRespond={live.respond}
        purpose={session.purpose}
        running={live.transcript.running}
        status={session.status}
      />

      <Composer
        onSend={live.send}
        onInterrupt={live.interrupt}
        running={live.transcript.running}
        disabled={live.status === 'offline'}
        {...(session.purpose === 'environment_setup'
          ? { placeholder: 'Add context for the setup agent…' }
          : {})}
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
