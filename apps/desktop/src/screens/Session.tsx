import {
  DEFAULT_COMMIT_IDENTITY,
  isTerminal,
  type DeviceRole,
  type ProjectSummary,
  type SessionSummary,
} from '@dukebox/protocol'
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
} from 'react'
import { DukeboxClient, isAuthFailure } from '@/lib/client'
import type { SessionCommands } from '@/lib/commands'
import { removeConnection, type Connection } from '@/lib/connection'
import { lastNewSessionFromSummary, type LastNewSession, type Settings } from '@/lib/settings'
import { notifyWaitingInput, shouldNotifyWaiting } from '@/lib/waitingNotification'
import type { SettingsCategory } from '@/lib/settingsCategories'
import { INITIAL_RETRY_MS, MAX_RETRY_MS, isStreamConnected } from '@/lib/stream'
import { NAV_DEFAULT, NAV_MIN, WORKSPACE_MIN } from '@/lib/columnWidths'
import { useColumnWidths } from '@/lib/useColumnWidths'
import { useLiveSession } from '@/lib/liveSession'
import { planTabs } from '@/lib/plans'
import type { UseUpdate } from '@/lib/useUpdate'
import { AgentIcon, hasAgentIcon } from '@/components/AgentIcon'
import { DukeHero } from '@/components/Duke'
import { Composer, type ComposerHandle } from '@/components/Composer'
import { AttachIcon } from '@/components/icons'
import { useFileDrop } from '@/lib/useFileDrop'
import { ResizeHandle } from '@/components/ResizeHandle'
import { SessionInfo } from '@/components/SessionInfo'
import { SearchPalette } from '@/components/SearchPalette'
import { Sidebar } from '@/components/Sidebar'
import { Transcript } from '@/components/Transcript'
import { Workspace } from '@/components/Workspace'
import { useSession, type LiveSession } from '@/lib/useSession'
import { useOpenPullRequestRefresh } from '@/lib/usePullRequestRefresh'

/**
 * The session view.
 *
 * Three columns: the sessions a person has, the conversation with one of them,
 * and the workspace that session is changing.
 */

const SettingsScreen = lazy(() =>
  import('@/screens/Settings').then((module) => ({ default: module.Settings })),
)
const SettingsNav = lazy(() =>
  import('@/screens/Settings').then((module) => ({ default: module.SettingsNav })),
)
const NewSession = lazy(() =>
  import('@/screens/NewSession').then((module) => ({ default: module.NewSession })),
)
const EnvironmentsPanel = lazy(() =>
  import('@/components/EnvironmentsPanel').then((module) => ({
    default: module.EnvironmentsPanel,
  })),
)

interface Props {
  connection: Connection
  settings: Settings
  update: UseUpdate
  onSaveSettings: (patch: Partial<Settings>) => void
  onSwitchServer: (connection: Connection) => void
  onDisconnected: () => void
  onSessionCommands?: (commands: SessionCommands | null) => void
}

export function Session({
  connection,
  settings,
  update,
  onSaveSettings,
  onSwitchServer,
  onDisconnected,
  onSessionCommands,
}: Props) {
  // Memoised because it is passed to effects: a new client every render would
  // re-run them forever.
  const client = useMemo(
    () => new DukeboxClient(connection.address, connection.deviceToken),
    [connection.address.host, connection.address.port, connection.deviceToken],
  )

  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [archivedSessions, setArchivedSessions] = useState<SessionSummary[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>('account')
  const [setupProjectId, setSetupProjectId] = useState<string | null>(null)
  const [setupEnvironmentId, setSetupEnvironmentId] = useState<string | null>(null)
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
  const [pendingArchive, setPendingArchive] = useState<string | null>(null)
  // Prefill New Session from a merged PR, even before settings persist.
  const [continueFrom, setContinueFrom] = useState<LastNewSession | null>(null)

  // Kept in sync so a session_update can compare against the last status
  // without waiting for the next render — reconnects echo the same waiting
  // row and must not toast again.
  const sessionsRef = useRef<SessionSummary[]>([])
  const focusedSessionRef = useRef<string | null>(null)
  const selectSessionRef = useRef<(sessionId: string) => void>(() => undefined)
  const notifyWhenWaitingRef = useRef(settings.notifyWhenWaiting)
  sessionsRef.current = sessions
  // Settings / New Session / Environments cover the transcript; leftover
  // `selected` is not "looking at" that session.
  focusedSessionRef.current =
    creating || settingsOpen || managingProjectId !== null ? null : selected
  notifyWhenWaitingRef.current = settings.notifyWhenWaiting

  const refreshProjects = async () => {
    try {
      setProjects(await client.listProjects())
    } catch {
      // Leave the local list alone; a failed refresh should not wipe the UI.
    }
  }

  const refreshSessions = async () => {
    try {
      const [active, archived] = await Promise.all([
        client.listSessions(),
        client.listArchivedSessions(),
      ])
      setSessions(active)
      setArchivedSessions(archived)
    } catch {
      // Same as projects: a blip must not empty the sidebar.
    }
  }

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let delay = INITIAL_RETRY_MS

    // A leftover selection from the previous server would keep its UUID
    // after the switch, so the new stream never subscribes and the
    // sidebar still lists the old sessions.
    setProjects([])
    setSessions([])
    setSelected(null)
    setLoading(true)
    setLoadError(null)

    const load = async () => {
      try {
        const [loadedProjects, loadedSessions, loadedArchived, me] = await Promise.all([
          client.listProjects(),
          client.listSessions(),
          client.listArchivedSessions(),
          client.whoami(),
        ])

        if (cancelled) return

        setProjects(loadedProjects)
        setSessions(loadedSessions)
        setArchivedSessions(loadedArchived)
        setRole(me.role)
        setSelected((current) => current ?? loadedSessions[0]?.id ?? null)
        setLoadError(null)
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

        // A failed first list must not look like a first-run empty server.
        setLoadError('Couldn’t load sessions. Retrying…')
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
    // switches servers. deviceId is the pairing identity even if host/token
    // happen to match another entry.
  }, [client, connection.deviceId])

  // Session summaries arrive over the socket too, so the sidebar's status dots
  // follow a running agent without polling.
  const applySessionPatch = (sessionId: string, patch: Partial<SessionSummary>) => {
    const apply = (rows: SessionSummary[]) =>
      rows.map((session) => (session.id === sessionId ? { ...session, ...patch } : session))
    setSessions(apply)
    setArchivedSessions(apply)
  }

  const live = useSession(
    connection,
    selected,
    (updated) => {
      const previous = sessionsRef.current.find((session) => session.id === updated.id)
      applySessionPatch(updated.id, updated)
      sessionsRef.current = sessionsRef.current.map((session) =>
        session.id === updated.id ? updated : session,
      )

      if (
        shouldNotifyWaiting({
          previousStatus: previous?.status,
          nextStatus: updated.status,
          lookingAtSession:
            focusedSessionRef.current === updated.id && document.visibilityState !== 'hidden',
          enabled: notifyWhenWaitingRef.current,
        })
      ) {
        notifyWaitingInput(updated.title, () => selectSessionRef.current(updated.id))
      }
    },
    () => {
      void removeConnection(connection.deviceId)
        .catch(() => undefined)
        .then(() => onDisconnected())
    },
  )

  const streamStatus = useLiveSession((state) => state.status)
  const disconnected = !isStreamConnected(streamStatus)

  // After a drop, the sidebar's HTTP snapshot can be stale. Refresh once the
  // socket is live again rather than polling while it is down.
  const wasOffline = useRef(false)
  useEffect(() => {
    if (disconnected) {
      if (streamStatus === 'offline') wasOffline.current = true
      return
    }
    if (!wasOffline.current) return
    wasOffline.current = false
    void refreshProjects()
    void refreshSessions()
  }, [disconnected, streamStatus])

  const current =
    sessions.find((session) => session.id === selected) ??
    archivedSessions.find((session) => session.id === selected) ??
    null

  // A merge or close on GitHub does not arrive over the socket. Refresh the
  // selected session, and every open PR when the window is focused again.
  useOpenPullRequestRefresh(
    client,
    [...sessions, ...archivedSessions],
    selected,
    !disconnected,
    (sessionId, patch) => {
      applySessionPatch(sessionId, patch)
    },
  )

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

  const {
    containerRef,
    navWidth,
    workspaceWidth,
    navMax,
    workspaceMax,
    setNavWidth,
    setWorkspaceWidth,
  } = useColumnWidths(composing)

  const onSessionCreated = (session: SessionSummary, project: ProjectSummary | null) => {
    // Added locally rather than refetched: the session exists but its
    // container is still building, and a list that only updates on the
    // next poll makes a started session look like it failed.
    if (project) setProjects((current) => [project, ...current])
    setSessions((current) => [session, ...current])
    setSelected(session.id)
    setCreating(false)
    setSetupProjectId(null)
    setSetupEnvironmentId(null)
    setPreferProjectId(null)
    setManagingProjectId(null)
    setPreferAgentId(null)
    setContinueFrom(null)
  }

  const openSettings = (category: SettingsCategory) => {
    setCreating(false)
    setSetupProjectId(null)
    setSetupEnvironmentId(null)
    setPreferProjectId(null)
    setManagingProjectId(null)
    setPreferAgentId(null)
    setSearchOpen(false)
    setContinueFrom(null)
    setSettingsCategory(category)
    setSettingsOpen(true)
    if (category === 'updates') update.check(true)
  }

  const selectSession = (sessionId: string) => {
    setCreating(false)
    setSettingsOpen(false)
    setSetupProjectId(null)
    setSetupEnvironmentId(null)
    setPreferProjectId(null)
    setManagingProjectId(null)
    setPreferAgentId(null)
    setSearchOpen(false)
    setContinueFrom(null)
    setSelected(sessionId)

    // Opening an archived row puts it back. A follow-up would resume the
    // container; leaving the hide flag set would drop that turn on restart.
    if (!archivedSessions.some((session) => session.id === sessionId)) return

    void (async () => {
      try {
        await client.unarchiveSession(sessionId)
        setArchiveError(null)
      } catch (error) {
        setArchiveError(error instanceof Error ? error.message : 'Could not restore the session.')
        return
      }

      const moved = archivedSessions.find((session) => session.id === sessionId) ?? null
      setArchivedSessions((current) => current.filter((session) => session.id !== sessionId))
      if (moved) {
        setSessions((current) =>
          [moved, ...current.filter((session) => session.id !== moved.id)].sort(
            (left, right) => right.createdAt - left.createdAt,
          ),
        )
      }
    })()
  }
  selectSessionRef.current = selectSession

  const startNewSession = (projectId?: string) => {
    setSetupProjectId(null)
    setSetupEnvironmentId(null)
    setPreferProjectId(projectId ?? null)
    setManagingProjectId(null)
    setPreferAgentId(null)
    setSettingsOpen(false)
    setSearchOpen(false)
    setContinueFrom(null)
    setCreating(true)
  }

  const openEnvironments = (projectId: string) => {
    setCreating(false)
    setSettingsOpen(false)
    setSetupProjectId(null)
    setPreferProjectId(null)
    setPreferAgentId(null)
    setSearchOpen(false)
    setContinueFrom(null)
    setManagingProjectId(projectId)
  }

  const archiveById = (sessionId: string) => {
    void (async () => {
      try {
        await client.archiveSession(sessionId)
        setArchiveError(null)
      } catch (error) {
        // Leave the row where it is: a failed archive that vanishes
        // from the list looks like the session was deleted.
        setArchiveError(error instanceof Error ? error.message : 'Could not archive the session.')
        return
      }

      const moved = sessions.find((session) => session.id === sessionId) ?? null
      const fallback = sessions.find((session) => session.id !== sessionId)?.id ?? null
      setSessions((current) => current.filter((session) => session.id !== sessionId))
      if (moved) {
        setArchivedSessions((current) =>
          [moved, ...current.filter((session) => session.id !== moved.id)].sort(
            (left, right) => right.updatedAt - left.updatedAt,
          ),
        )
      }
      setSelected((currentSelected) => (currentSelected === sessionId ? fallback : currentSelected))
    })()
  }

  const stopById = useCallback(
    async (sessionId: string) => {
      try {
        await client.stopSession(sessionId)
        setArchiveError(null)
      } catch (error) {
        setArchiveError(error instanceof Error ? error.message : 'Could not stop the session.')
        return
      }

      const markStopped = (rows: SessionSummary[]) =>
        rows.map((session) =>
          session.id === sessionId ? { ...session, status: 'stopped' as const } : session,
        )
      setSessions(markStopped)
      setArchivedSessions(markStopped)
    },
    [client],
  )

  const continueAfterMerge = (session: SessionSummary) => {
    const last = lastNewSessionFromSummary(session, projects)
    setSetupProjectId(null)
    setSetupEnvironmentId(null)
    setPreferProjectId(session.projectId)
    setManagingProjectId(null)
    setPreferAgentId(session.agentId)
    setSettingsOpen(false)
    setSearchOpen(false)
    setContinueFrom(last)
    setCreating(true)
  }

  const actionSession = creating || !current ? null : current
  const actionSessionActive = actionSession
    ? sessions.some((session) => session.id === actionSession.id)
    : false
  const actionProjectId =
    current?.projectId ?? preferProjectId ?? setupProjectId ?? managingProjectId ?? null

  useEffect(() => {
    if (!onSessionCommands) return
    onSessionCommands({
      selectedId: actionSession?.id ?? null,
      status: actionSession?.status ?? null,
      stopSession: stopById,
    })
  }, [onSessionCommands, actionSession?.id, actionSession?.status, stopById])

  useEffect(() => {
    return () => onSessionCommands?.(null)
  }, [onSessionCommands])

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
      <ConnectionBanner />
      {/* Widths are variables so a drag updates them without rebuilding the
          template. Collapsing the workspace still snaps to the 244px rail. */}
      <div
        ref={containerRef}
        className={`grid min-h-0 flex-1 overflow-hidden ${
          composing
            ? 'grid-cols-[var(--nav-width)_minmax(0,1fr)]'
            : 'grid-cols-[var(--nav-width)_minmax(0,1fr)_var(--workspace-width)] has-[[data-collapsed]]:grid-cols-[var(--nav-width)_minmax(0,1fr)_244px]'
        }`}
        style={
          {
            '--nav-width': `${navWidth}px`,
            '--workspace-width': `${workspaceWidth}px`,
          } as CSSProperties
        }
      >
        <div className="relative z-10 flex min-h-0 min-w-0 flex-col">
          {settingsOpen ? (
            <Suspense fallback={<NavFallback />}>
              <SettingsNav
                category={settingsCategory}
                role={role}
                onCategoryChange={setSettingsCategory}
                onBack={() => setSettingsOpen(false)}
              />
            </Suspense>
          ) : (
            <Sidebar
              projects={projects}
              sessions={sessions}
              archivedSessions={archivedSessions}
              selectedId={creating ? null : selected}
              identity={settings.commitIdentity ?? DEFAULT_COMMIT_IDENTITY}
              serverName={connection.serverName}
              role={role}
              disabled={disconnected}
              loading={loading}
              onOpenSettings={openSettings}
              onSelect={selectSession}
              onNewSession={startNewSession}
              onSearch={() => setSearchOpen(true)}
              onConfigureEnvironment={(projectId) => {
                setSetupProjectId(projectId)
                setSetupEnvironmentId(null)
                setPreferProjectId(null)
                setManagingProjectId(null)
                setPreferAgentId(null)
                setSettingsOpen(false)
                setCreating(true)
              }}
              onManageEnvironments={openEnvironments}
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
                  setArchivedSessions((current) =>
                    current.filter((session) => session.id !== sessionId),
                  )
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
                  const remainingArchived = archivedSessions.filter(
                    (session) => session.projectId !== projectId,
                  )
                  setProjects((current) => current.filter((project) => project.id !== projectId))
                  setSessions(remaining)
                  setArchivedSessions(remainingArchived)
                  setSelected((currentSelected) => {
                    if (!currentSelected) return currentSelected
                    if (remaining.some((session) => session.id === currentSelected)) {
                      return currentSelected
                    }
                    // An archived selection is not in `remaining`. Keep it
                    // unless this project owned that row.
                    if (remainingArchived.some((session) => session.id === currentSelected)) {
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
                    setSetupEnvironmentId(null)
                    setCreating(false)
                  }
                })()
              }}
              onRestore={selectSession}
              onArchive={archiveById}
            />
          )}
          <ResizeHandle
            value={navWidth}
            min={NAV_MIN}
            max={navMax}
            defaultValue={NAV_DEFAULT}
            edge="end"
            label="Resize sessions"
            onChange={setNavWidth}
          />
        </div>

        {loading ? (
          <p role="status" className="grid place-items-center text-[13px] text-muted-foreground">
            {loadError ?? 'Loading sessions…'}
          </p>
        ) : settingsOpen ? (
          <Suspense fallback={<PaneFallback />}>
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
          </Suspense>
        ) : managingProjectId ? (
          <Suspense fallback={<PaneFallback />}>
            <EnvironmentsPanel
              client={client}
              projectId={managingProjectId}
              disabled={disconnected}
              onRunSetup={(environmentId) => {
                setSetupProjectId(null)
                setSetupEnvironmentId(environmentId)
                setPreferProjectId(managingProjectId)
                setPreferAgentId(null)
                setContinueFrom(null)
                setSettingsOpen(false)
                setManagingProjectId(null)
                setCreating(true)
              }}
            />
          </Suspense>
        ) : creating ? (
          <Suspense fallback={<PaneFallback />}>
            <NewSession
              client={client}
              connection={connection}
              projects={projects}
              identity={settings.commitIdentity}
              gitPreferences={settings.git}
              onCreated={onSessionCreated}
              preferSetupProjectId={setupProjectId}
              preferSetupEnvironmentId={setupEnvironmentId}
              preferProjectId={preferProjectId}
              preferAgentId={preferAgentId}
              lastNewSession={
                continueFrom ??
                settings.lastNewSession ??
                lastNewSessionFromSummary(sessions[0], projects)
              }
              onRemember={(last) => onSaveSettings({ lastNewSession: last })}
              disabled={disconnected}
              role={role}
              onConfigureProviders={() => {
                if (role !== 'owner') return
                setPreferAgentId('opencode')
                setSettingsCategory('agents')
                setSettingsOpen(true)
              }}
            />
          </Suspense>
        ) : current ? (
          <>
            <SessionColumn
              key={current.id}
              session={current}
              live={live}
              connection={connection}
              onContinueAfterMerge={() => continueAfterMerge(current)}
            />
            <ConnectedWorkspace
              session={current}
              width={workspaceWidth}
              onWidthChange={setWorkspaceWidth}
              widthMin={WORKSPACE_MIN}
              widthMax={workspaceMax}
              client={client}
              disabled={disconnected}
              onOpenTerminal={live.openTerminal}
              onAttachTerminal={live.attachTerminal}
              onDetachTerminal={live.detachTerminal}
              onTerminalInput={live.sendTerminalInput}
              onTerminalResize={live.resizeTerminal}
              onCloseTerminal={live.closeTerminal}
              onRenameTerminal={live.renameTerminal}
              onDrainTerminal={live.drainTerminal}
              onRespond={live.respond}
              pullRequest={
                current.purpose === 'coding'
                  ? {
                      client,
                      onUpdated: (patch) => {
                        if (!selected) return
                        applySessionPatch(selected, patch)
                      },
                      onContinue: () => continueAfterMerge(current),
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
          archivedSessions={archivedSessions}
          projects={projects}
          role={role}
          selectedSessionId={actionSession && actionSessionActive ? actionSession.id : null}
          selectedProjectId={actionProjectId}
          onSelect={selectSession}
          onNewSession={startNewSession}
          onManageEnvironments={openEnvironments}
          onArchive={(sessionId) => setPendingArchive(sessionId)}
          onOpenSettings={openSettings}
          onDismiss={() => setSearchOpen(false)}
        />
      )}

      {pendingArchive && (
        <ConfirmArchive
          onConfirm={() => {
            const sessionId = pendingArchive
            setPendingArchive(null)
            archiveById(sessionId)
          }}
          onDismiss={() => setPendingArchive(null)}
        />
      )}
    </div>
  )
}

function ConfirmArchive({
  onConfirm,
  onDismiss,
}: {
  onConfirm: () => void
  onDismiss: () => void
}) {
  const panel = useRef<HTMLDivElement>(null)
  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss

  useEffect(() => {
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        dismiss.current()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-6"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onDismiss()
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-archive-title"
        tabIndex={-1}
        className="w-full max-w-sm overflow-hidden rounded-[calc(var(--radius)*1.1)] border border-border bg-background shadow-lg outline-none"
      >
        <div className="border-b border-border px-4 py-3">
          <h2 id="confirm-archive-title" className="font-medium">
            Archive this session?
          </h2>
        </div>
        <div className="px-4 py-3">
          <p className="text-[13px] text-muted-foreground">
            Hide from the sidebar. You can restore it later.
          </p>
          <div className="mt-3 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onDismiss}
              className="rounded-[calc(var(--radius)*0.6)] px-2.5 py-1 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className="rounded-[calc(var(--radius)*0.6)] border border-border px-2.5 py-1 text-[12px] font-medium hover:bg-muted"
            >
              Archive
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function SessionColumn({
  session,
  live,
  connection,
  onContinueAfterMerge,
}: {
  session: SessionSummary
  live: LiveSession
  connection: Connection
  onContinueAfterMerge: () => void
}) {
  const transcript = useLiveSession((state) => state.transcript)
  const streamStatus = useLiveSession((state) => state.status)
  const error = useLiveSession((state) => state.error)
  // A transcript can still look mid-turn after a restart — the last events
  // never got a `done`. The session status is what actually knows whether an
  // agent is running, and a Stop button that cannot interrupt anything is how
  // that used to read as "stuck processing".
  const working = transcript.running && !isTerminal(session.status)
  const [composerDraft, setComposerDraft] = useState<{ text: string; key: number } | null>(null)
  const composer = useRef<ComposerHandle>(null)
  const onEdit = useCallback((text: string) => {
    setComposerDraft({ text, key: Date.now() })
  }, [])
  const connected = isStreamConnected(streamStatus)
  const { dragging, onDragEnter, onDragOver, onDragLeave, onDrop } = useFileDrop({
    disabled: !connected,
    onFiles: (files) => composer.current?.attachFiles(files),
  })

  return (
    // `min-h-0` is what makes the transcript scroll instead of the window
    // growing. A flex item defaults to `min-height: auto`, which refuses to
    // shrink below its content, so the child's `overflow-y-auto` never has a
    // bounded height to scroll within and the column pushes the grid open.
    <div
      className="relative flex min-h-0 min-w-0 flex-col"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
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

      {session.status === 'stopped' && isStreamConnected(streamStatus) && (
        <p className="border-b border-border bg-surface px-4.5 py-2 text-[12.5px] text-muted-foreground">
          This session stopped when the server restarted. Send a message or open a terminal to
          continue in the same workspace.
        </p>
      )}

      {session.pullRequest?.state === 'merged' && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-surface px-4.5 py-2 text-[12.5px] text-muted-foreground">
          <p>
            This pull request was merged. A message here stays on this branch. For new work, start
            from {session.baseBranch}.
          </p>
          <button
            type="button"
            onClick={onContinueAfterMerge}
            className="rounded-[calc(var(--radius)*0.6)] border border-border px-2 py-0.5 text-[12px] font-medium text-foreground hover:bg-muted"
          >
            New session from {session.baseBranch}
          </button>
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="border-b border-border bg-destructive/10 px-4.5 py-2 text-[12.5px] text-destructive"
        >
          {error}
        </p>
      )}

      <Transcript
        transcript={transcript}
        onRespond={live.respond}
        onEdit={onEdit}
        purpose={session.purpose}
        running={working}
        status={session.status}
        streamStatus={streamStatus}
        disabled={!isStreamConnected(streamStatus)}
      />

      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center bg-background/80">
          <p className="flex items-center gap-2 rounded-[var(--radius)] border-2 border-dashed border-primary/60 bg-background px-4 py-3 text-[13px] font-medium">
            <AttachIcon size={16} />
            Drop to attach
          </p>
        </div>
      )}

      <Composer
        ref={composer}
        captureDrop={false}
        onSend={live.send}
        onInterrupt={live.interrupt}
        running={working}
        disabled={!isStreamConnected(streamStatus)}
        error={error}
        agentId={session.agentId}
        {...(composerDraft ? { draft: composerDraft } : {})}
        {...(session.purpose !== 'environment_setup' && session.permissionMode
          ? {
              permissionMode: transcript.permissionMode ?? session.permissionMode,
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

function ConnectedWorkspace(
  props: Omit<ComponentProps<typeof Workspace>, 'files' | 'terminals' | 'error' | 'plans'>,
) {
  const files = useLiveSession((state) => state.transcript.files)
  const terminals = useLiveSession((state) => state.terminals)
  const error = useLiveSession((state) => state.error)
  const blocks = useLiveSession((state) => state.transcript.blocks)
  // Folded here rather than in the panel: blocks change on every token, and
  // the tabs only change when a plan is asked for or answered.
  const plans = useMemo(() => planTabs(blocks), [blocks])
  return <Workspace files={files} terminals={terminals} error={error} plans={plans} {...props} />
}

function PaneFallback() {
  return (
    <p role="status" className="grid place-items-center text-[13px] text-muted-foreground">
      Loading…
    </p>
  )
}

function NavFallback() {
  return <div className="h-full border-r border-border bg-surface" />
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
        <DukeHero size={180} className="mx-auto" />
        <p className="mt-4 text-[14px] font-medium">No session selected</p>
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

function ConnectionBanner() {
  const status = useLiveSession((state) => state.status)
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
