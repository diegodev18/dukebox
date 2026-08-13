import {
  DEFAULT_COMMIT_IDENTITY,
  isTerminal,
  type DeviceRole,
  type ProjectSummary,
  type SessionSummary,
} from '@dukebox/protocol'
import { useEffect, useMemo, useRef, useState } from 'react'
import { DukeboxClient, isAuthFailure } from '@/lib/client'
import { removeConnection, type Connection } from '@/lib/connection'
import { lastNewSessionFromSummary, type Settings } from '@/lib/settings'
import { INITIAL_RETRY_MS, MAX_RETRY_MS, isStreamConnected } from '@/lib/stream'
import type { UseUpdate } from '@/lib/useUpdate'
import { AgentIcon, hasAgentIcon } from '@/components/AgentIcon'
import { Composer } from '@/components/Composer'
import { EnvironmentsPanel } from '@/components/EnvironmentsPanel'
import { SessionInfo } from '@/components/SessionInfo'
import { SearchPalette } from '@/components/SearchPalette'
import { Sidebar } from '@/components/Sidebar'
import { Transcript } from '@/components/Transcript'
import { Workspace } from '@/components/Workspace'
import { useSession, type LiveSession } from '@/lib/useSession'
import { NewSession } from '@/screens/NewSession'
import { Settings as SettingsScreen, SettingsNav, type SettingsCategory } from '@/screens/Settings'

/**
 * The session view.
 *
 * Three columns: the sessions a person has, the conversation with one of them,
 * and the workspace that session is changing.
 */

interface Props {
  connection: Connection
  settings: Settings
  update: UseUpdate
  onSaveSettings: (patch: Partial<Settings>) => void
  onSwitchServer: (connection: Connection) => void
  onDisconnected: () => void
}

export function Session({
  connection,
  settings,
  update,
  onSaveSettings,
  onSwitchServer,
  onDisconnected,
}: Props) {
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
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>('account')
  const [setupProjectId, setSetupProjectId] = useState<string | null>(null)
  const [preferProjectId, setPreferProjectId] = useState<string | null>(null)
  // Remember OpenCode when new session opens provider settings, so Back
  // restores the form with that agent still selected.
  const [preferAgentId, setPreferAgentId] = useState<string | null>(null)
  const [managingProjectId, setManagingProjectId] = useState<string | null>(null)
  // Only to name the environment a review session belongs to. The summary
  // carries the id; the name lives on the environment row.
  const [environmentNames, setEnvironmentNames] = useState<Record<string, string>>({})
  const [archiveError, setArchiveError] = useState<string | null>(null)
  const [role, setRole] = useState<DeviceRole | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)

  const refreshProjects = async () => {
    try {
      setProjects(await client.listProjects())
    } catch {
      // Leave the local list alone; a failed refresh should not wipe the UI.
    }
  }

  const refreshSessions = async () => {
    try {
      setSessions(await client.listSessions())
    } catch {
      // Same as projects: a blip must not empty the sidebar.
    }
  }

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let delay = INITIAL_RETRY_MS

    const load = async () => {
      try {
        const [loadedProjects, loadedSessions, me] = await Promise.all([
          client.listProjects(),
          client.listSessions(),
          client.whoami(),
        ])

        if (cancelled) return

        setProjects(loadedProjects)
        setSessions(loadedSessions)
        setRole(me.role)
        setSelected((current) => current ?? loadedSessions[0]?.id ?? null)
        setLoading(false)
        delay = INITIAL_RETRY_MS
      } catch (error) {
        // The token worked at launch, or the server was merely down. A 401
        // means the pairing is dead; anything else is retried until it is not.
        if (cancelled) return

        if (isAuthFailure(error)) {
          await removeConnection(connection.deviceId).catch(() => undefined)
          onDisconnected()
          return
        }

        setLoading(false)
        const jitter = Math.random() * delay * 0.3
        timer = setTimeout(() => {
          timer = null
          void load()
        }, delay + jitter)
        delay = Math.min(delay * 2, MAX_RETRY_MS)
      }
    }

    void load()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
    // The client is derived from the connection, so this reruns when the user
    // switches servers.
  }, [client])

  // Session summaries arrive over the socket too, so the sidebar's status dots
  // follow a running agent without polling.
  const live = useSession(
    connection,
    selected,
    (updated) => {
      setSessions((current) =>
        current.map((session) => (session.id === updated.id ? updated : session)),
      )
    },
    () => {
      void removeConnection(connection.deviceId)
        .catch(() => undefined)
        .then(() => onDisconnected())
    },
  )

  const disconnected = !isStreamConnected(live.status)

  // After a drop, the sidebar's HTTP snapshot can be stale. Refresh once the
  // socket is live again rather than polling while it is down.
  const wasOffline = useRef(false)
  useEffect(() => {
    if (disconnected) {
      if (live.status === 'offline') wasOffline.current = true
      return
    }
    if (!wasOffline.current) return
    wasOffline.current = false
    void refreshProjects()
    void refreshSessions()
  }, [disconnected, live.status])

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
  // The environments panel and settings are forms too, and want the same width.
  const composing =
    !loading && (creating || managingProjectId !== null || settingsOpen || current === null)

  const onSessionCreated = (session: SessionSummary, project: ProjectSummary | null) => {
    // Added locally rather than refetched: the session exists but its
    // container is still building, and a list that only updates on the
    // next poll makes a started session look like it failed.
    if (project) setProjects((current) => [project, ...current])
    setSessions((current) => [session, ...current])
    setSelected(session.id)
    setCreating(false)
    setSetupProjectId(null)
    setPreferProjectId(null)
    setManagingProjectId(null)
    setPreferAgentId(null)
  }

  const openSettings = (category: SettingsCategory) => {
    setCreating(false)
    setSetupProjectId(null)
    setPreferProjectId(null)
    setManagingProjectId(null)
    setPreferAgentId(null)
    setSearchOpen(false)
    setSettingsCategory(category)
    setSettingsOpen(true)
    if (category === 'updates') update.check(true)
  }

  const selectSession = (sessionId: string) => {
    setCreating(false)
    setSettingsOpen(false)
    setSetupProjectId(null)
    setPreferProjectId(null)
    setManagingProjectId(null)
    setPreferAgentId(null)
    setSearchOpen(false)
    setSelected(sessionId)
  }

  const startNewSession = (projectId?: string) => {
    setSetupProjectId(null)
    setPreferProjectId(projectId ?? null)
    setManagingProjectId(null)
    setPreferAgentId(null)
    setSettingsOpen(false)
    setSearchOpen(false)
    setCreating(true)
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return
      if (event.key.toLowerCase() !== 'k') return
      event.preventDefault()
      setSearchOpen((open) => !open)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    // `h-full` fills the locked `#root`; `overflow-hidden` keeps any column
    // that still misbehaves from scrolling the window itself. Internal
    // panels (`Transcript`, sidebar list, workspace files) own their scroll.
    <div className="flex h-full flex-col overflow-hidden">
      <ConnectionBanner status={live.status} />
      <div
        className={`grid min-h-0 flex-1 overflow-hidden ${
          composing
            ? 'grid-cols-[236px_minmax(0,1fr)]'
            : 'grid-cols-[236px_minmax(0,1fr)_clamp(340px,30vw,460px)] has-[[data-collapsed]]:grid-cols-[236px_minmax(0,1fr)_244px]'
        }`}
      >
        {settingsOpen ? (
          <SettingsNav
            category={settingsCategory}
            role={role}
            onCategoryChange={setSettingsCategory}
            onBack={() => setSettingsOpen(false)}
          />
        ) : (
          <Sidebar
            projects={projects}
            sessions={sessions}
            selectedId={creating ? null : selected}
            identity={settings.commitIdentity ?? DEFAULT_COMMIT_IDENTITY}
            role={role}
            disabled={disconnected}
            onOpenSettings={openSettings}
            onSelect={selectSession}
            onNewSession={startNewSession}
            onSearch={() => setSearchOpen(true)}
            onConfigureEnvironment={(projectId) => {
              setSetupProjectId(projectId)
              setPreferProjectId(null)
              setManagingProjectId(null)
              setPreferAgentId(null)
              setSettingsOpen(false)
              setCreating(true)
            }}
            onManageEnvironments={(projectId) => {
              setCreating(false)
              setSettingsOpen(false)
              setSetupProjectId(null)
              setPreferProjectId(null)
              setPreferAgentId(null)
              setManagingProjectId(projectId)
            }}
            archiveError={archiveError}
            onDelete={(sessionId) => {
              void (async () => {
                try {
                  await client.deleteSession(sessionId)
                  setArchiveError(null)
                } catch (error) {
                  // Same as archive: a failed delete that vanishes from the
                  // list looks like the session was removed when it was not.
                  setArchiveError(
                    error instanceof Error ? error.message : 'Could not delete the session.',
                  )
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
            onRemoveProject={(projectId) => {
              void (async () => {
                try {
                  await client.deleteProject(projectId)
                  setArchiveError(null)
                } catch (error) {
                  setArchiveError(
                    error instanceof Error ? error.message : 'Could not remove the project.',
                  )
                  return
                }

                const remaining = sessions.filter((session) => session.projectId !== projectId)
                setProjects((current) => current.filter((project) => project.id !== projectId))
                setSessions(remaining)
                setSelected((currentSelected) => {
                  if (!currentSelected) return currentSelected
                  if (remaining.some((session) => session.id === currentSelected)) {
                    return currentSelected
                  }
                  return remaining[0]?.id ?? null
                })
                if (managingProjectId === projectId) setManagingProjectId(null)
                if (setupProjectId === projectId) {
                  setSetupProjectId(null)
                  setCreating(false)
                }
                if (preferProjectId === projectId) {
                  setPreferProjectId(null)
                  setCreating(false)
                }
              })()
            }}
            onArchive={(sessionId) => {
              void (async () => {
                try {
                  await client.archiveSession(sessionId)
                  setArchiveError(null)
                } catch (error) {
                  // Leave the row where it is: a failed archive that vanishes
                  // from the list looks like the session was deleted.
                  setArchiveError(
                    error instanceof Error ? error.message : 'Could not archive the session.',
                  )
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
        )}

        {loading ? (
          <p role="status" className="grid place-items-center text-[13px] text-muted-foreground">
            Loading sessions…
          </p>
        ) : settingsOpen ? (
          <SettingsScreen
            client={client}
            connection={connection}
            settings={settings}
            update={update}
            category={settingsCategory}
            role={role}
            onSaveSettings={onSaveSettings}
            onSwitchServer={onSwitchServer}
            onClose={() => setSettingsOpen(false)}
            onDisconnected={onDisconnected}
          />
        ) : managingProjectId ? (
          <EnvironmentsPanel
            client={client}
            projectId={managingProjectId}
            disabled={disconnected}
          />
        ) : creating ? (
          <NewSession
            client={client}
            connection={connection}
            projects={projects}
            identity={settings.commitIdentity}
            gitPreferences={settings.git}
            onCreated={onSessionCreated}
            preferSetupProjectId={setupProjectId}
            preferProjectId={preferProjectId}
            preferAgentId={preferAgentId}
            lastNewSession={
              settings.lastNewSession ?? lastNewSessionFromSummary(sessions[0], projects)
            }
            onRemember={(last) => onSaveSettings({ lastNewSession: last })}
            disabled={disconnected}
            onConfigureProviders={() => {
              if (role !== 'owner') return
              setPreferAgentId('opencode')
              setSettingsCategory('agents')
              setSettingsOpen(true)
            }}
          />
        ) : current ? (
          <>
            <SessionColumn session={current} live={live} connection={connection} />
            <Workspace
              session={current}
              files={live.transcript.files}
              client={client}
              terminals={live.terminals}
              disabled={disconnected}
              onOpenTerminal={live.openTerminal}
              onAttachTerminal={live.attachTerminal}
              onDetachTerminal={live.detachTerminal}
              onTerminalInput={live.sendTerminalInput}
              onTerminalResize={live.resizeTerminal}
              onCloseTerminal={live.closeTerminal}
              onRenameTerminal={live.renameTerminal}
              onDrainTerminal={live.drainTerminal}
              error={live.error}
              pullRequest={
                current.purpose === 'coding'
                  ? {
                      client,
                      onUpdated: (patch) =>
                        setSessions((sessions) =>
                          sessions.map((session) =>
                            session.id === selected ? { ...session, ...patch } : session,
                          ),
                        ),
                    }
                  : null
              }
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
                      disabled: disconnected,
                    }
                  : null
              }
            />
          </>
        ) : (
          <EmptySession onNewSession={() => setCreating(true)} disabled={disconnected} />
        )}
      </div>

      {searchOpen && (
        <SearchPalette
          sessions={sessions}
          projects={projects}
          role={role}
          onSelect={selectSession}
          onNewSession={startNewSession}
          onOpenSettings={openSettings}
          onDismiss={() => setSearchOpen(false)}
        />
      )}
    </div>
  )
}

function SessionColumn({
  session,
  live,
  connection,
}: {
  session: SessionSummary
  live: LiveSession
  connection: Connection
}) {
  // A transcript can still look mid-turn after a restart — the last events
  // never got a `done`. The session status is what actually knows whether an
  // agent is running, and a Stop button that cannot interrupt anything is how
  // that used to read as "stuck processing".
  const working = live.transcript.running && !isTerminal(session.status)

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

        <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
          <StatusDot status={session.status} />
          <span>{statusLabel(session.status)}</span>
          {hasAgentIcon(session.agentId) ? (
            <AgentIcon agentId={session.agentId} />
          ) : (
            session.agentId
          )}
        </span>
      </header>

      {session.status === 'stopped' && isStreamConnected(live.status) && (
        <p className="border-b border-border bg-surface px-4.5 py-2 text-[12.5px] text-muted-foreground">
          This session stopped when the server restarted. Send a message or open a terminal to
          continue in the same workspace.
        </p>
      )}

      {live.error && (
        <p
          role="alert"
          className="border-b border-border bg-destructive/10 px-4.5 py-2 text-[12.5px] text-destructive"
        >
          {live.error}
        </p>
      )}

      <Transcript
        transcript={live.transcript}
        onRespond={live.respond}
        purpose={session.purpose}
        running={working}
        status={session.status}
        streamStatus={live.status}
        disabled={!isStreamConnected(live.status)}
      />

      <Composer
        onSend={live.send}
        onInterrupt={live.interrupt}
        running={working}
        disabled={!isStreamConnected(live.status)}
        error={live.error}
        {...(session.purpose !== 'environment_setup' && session.permissionMode
          ? {
              permissionMode: live.transcript.permissionMode ?? session.permissionMode,
              onPermissionModeChange: live.setPermissionMode,
            }
          : {})}
        {...(session.purpose === 'environment_setup'
          ? { placeholder: 'Add context for the setup agent…' }
          : {})}
      />
    </div>
  )
}

function EmptySession({
  onNewSession,
  disabled = false,
}: {
  onNewSession: () => void
  disabled?: boolean
}) {
  return (
    <div className="grid h-full min-h-0 min-w-0 place-items-center px-6">
      <div className="max-w-sm text-center">
        <p className="text-[14px] font-medium">No session selected</p>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Pick one from the sidebar, or start a new one.
        </p>
        <button
          type="button"
          onClick={onNewSession}
          disabled={disabled}
          className="mt-4 rounded-[calc(var(--radius)*0.6)] bg-foreground px-3.5 py-1.5 text-[12.5px] font-medium text-background disabled:opacity-40"
        >
          New session
        </button>
      </div>
    </div>
  )
}

function ConnectionBanner({ status }: { status: LiveSession['status'] }) {
  if (isStreamConnected(status)) return null

  return (
    <p
      role="status"
      className="border-b border-border bg-surface px-4.5 py-2 text-[12.5px] text-muted-foreground"
    >
      {status === 'connecting'
        ? 'Connecting to the server…'
        : 'Reconnecting… the session keeps running on your server.'}
    </p>
  )
}

export function statusLabel(status: SessionSummary['status']): string {
  return {
    provisioning: 'Starting',
    running: 'Running',
    waiting_input: 'Waiting for you',
    done: 'Done',
    failed: 'Failed',
    stopped: 'Stopped',
  }[status]
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
      role="img"
      aria-label={statusLabel(status)}
      className={`size-1.5 flex-none rounded-full ${tone} ${live ? 'motion-safe:animate-pulse' : ''}`}
    />
  )
}
