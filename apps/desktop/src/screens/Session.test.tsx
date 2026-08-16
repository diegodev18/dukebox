import type { ProjectSummary, SessionSummary } from '@dukebox/protocol'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '@/lib/settings'
import { resetLiveSession, useLiveSession } from '@/lib/liveSession'
import { ApiFailure } from '@/lib/client'

const listProjects = vi.fn()
const listSessions = vi.fn()
const listArchivedSessions = vi.fn()
const whoami = vi.fn()
const archiveSession = vi.fn()
const unarchiveSession = vi.fn()
const stopSession = vi.fn()
const deleteSession = vi.fn()
const deleteProject = vi.fn()
const getPullRequest = vi.fn()
const removeConnection = vi.fn()

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/connection', () => ({
  removeConnection: (...args: unknown[]) => removeConnection(...args),
}))

vi.mock('@/components/Transcript', () => ({
  Transcript: () => <div>transcript</div>,
}))

vi.mock('@/components/Composer', () => ({
  Composer: () => <div>composer</div>,
}))

vi.mock('@/components/Workspace', () => ({
  Workspace: () => <div>workspace</div>,
}))

vi.mock('@/screens/NewSession', () => ({
  NewSession: ({ preferProjectId }: { preferProjectId?: string | null }) => (
    <div>new session for {preferProjectId ?? 'none'}</div>
  ),
}))

vi.mock('@/components/EnvironmentsPanel', () => ({
  EnvironmentsPanel: ({ projectId }: { projectId: string }) => (
    <div>environments for {projectId}</div>
  ),
}))

const { lastOnSessionUpdate, notifyWaitingInput } = vi.hoisted(() => ({
  lastOnSessionUpdate: {
    current: undefined as ((session: SessionSummary) => void) | undefined,
  },
  notifyWaitingInput: vi.fn(),
}))

vi.mock('@/lib/waitingNotification', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/waitingNotification')>()
  return {
    ...actual,
    notifyWaitingInput,
  }
})

vi.mock('@/lib/useSession', () => ({
  useSession: (
    _connection: unknown,
    _sessionId: unknown,
    onSessionUpdate?: (session: SessionSummary) => void,
  ) => {
    lastOnSessionUpdate.current = onSessionUpdate
    return {
      send: vi.fn(),
      interrupt: vi.fn(),
      respond: vi.fn(),
      setPermissionMode: vi.fn(),
      openTerminal: vi.fn(),
      attachTerminal: vi.fn(),
      detachTerminal: vi.fn(),
      sendTerminalInput: vi.fn(),
      resizeTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      drainTerminal: vi.fn(),
    }
  },
}))

vi.mock('@/lib/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/client')>()
  return {
    ...actual,
    DukeboxClient: class {
      listProjects = listProjects
      listSessions = listSessions
      listArchivedSessions = listArchivedSessions
      whoami = whoami
      archiveSession = archiveSession
      unarchiveSession = unarchiveSession
      stopSession = stopSession
      deleteSession = deleteSession
      deleteProject = deleteProject
      getPullRequest = getPullRequest
      listEnvironments = vi.fn().mockResolvedValue([])
    },
  }
})

import { Session } from '@/screens/Session'

const project: ProjectSummary = {
  id: '00000000-0000-4000-8000-000000000001',
  repoFullName: 'acme/app',
  defaultBranch: 'main',
  environmentCount: 1,
  createdAt: Date.now(),
  sessionCount: 1,
}

const session: SessionSummary = {
  id: '00000000-0000-4000-8000-000000000011',
  projectId: project.id,
  agentId: 'claude-code',
  status: 'done',
  purpose: 'coding',
  title: 'Fix the demux bug',
  branch: 'duke/abc',
  baseBranch: 'main',
  baseCommit: null,
  changedFileCount: 1,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  lastSeq: 4,
  pullRequestUrl: null,
  pullRequest: null,
  environmentId: null,
  permissionMode: 'bypass',
}

const other: SessionSummary = {
  ...session,
  id: '00000000-0000-4000-8000-000000000012',
  title: 'Add a health check',
}

const connection = {
  serverName: 'debian-01',
  address: { host: 'debian-01.tailnet.ts.net', port: 7777, tls: false },
  deviceId: 'device-1',
  deviceToken: 'token-1',
  pairedAt: 1,
}

const update = {
  state: { status: 'up-to-date' as const },
  checked: true,
  dismissed: false,
  announcing: false,
  check: vi.fn(),
  install: vi.fn(),
  dismiss: vi.fn(),
}

function renderSession() {
  return render(
    <Session
      connection={connection}
      settings={defaultSettings()}
      update={update}
      onSaveSettings={vi.fn()}
      onSwitchServer={vi.fn()}
      onDisconnected={vi.fn()}
    />,
  )
}

beforeEach(() => {
  resetLiveSession('live')
  useLiveSession.setState({ status: 'live', error: null })
  listProjects.mockResolvedValue([project])
  listSessions.mockResolvedValue([session, other])
  listArchivedSessions.mockResolvedValue([])
  whoami.mockResolvedValue({
    deviceId: 'device-1',
    deviceName: 'Mac',
    role: 'owner',
    capabilities: { manageDevices: true, manageAgents: true, deleteProjects: true },
  })
  archiveSession.mockResolvedValue(undefined)
  unarchiveSession.mockResolvedValue(undefined)
  deleteProject.mockResolvedValue(undefined)
  stopSession.mockResolvedValue(undefined)
  removeConnection.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.clearAllMocks()
  lastOnSessionUpdate.current = undefined
})

describe('Session', () => {
  it('loads sessions and selects the first', async () => {
    renderSession()

    expect(await screen.findByRole('button', { name: 'Done, Fix the demux bug' })).toHaveAttribute(
      'aria-current',
      'true',
    )
    expect(screen.getByRole('button', { name: /Done, Add a health check/ })).toBeInTheDocument()
  })

  it('unpairs when the token is revoked', async () => {
    const onDisconnected = vi.fn()
    whoami.mockRejectedValueOnce(new ApiFailure(401, 'unauthorized', 'missing device token'))
    render(
      <Session
        connection={connection}
        settings={defaultSettings()}
        update={update}
        onSaveSettings={vi.fn()}
        onSwitchServer={vi.fn()}
        onDisconnected={onDisconnected}
      />,
    )

    await waitFor(() => expect(removeConnection).toHaveBeenCalledWith('device-1'))
    expect(onDisconnected).toHaveBeenCalled()
  })

  it('keeps a row when archive fails', async () => {
    archiveSession.mockRejectedValueOnce(new Error('container is gone'))
    renderSession()

    await screen.findByRole('button', { name: 'Done, Fix the demux bug' })
    await userEvent.click(
      screen.getByRole('button', { name: 'Session actions for Fix the demux bug' }),
    )
    await userEvent.click(screen.getByRole('menuitem', { name: 'Archive' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Archive' }))

    expect(await screen.findByText('container is gone')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Done, Fix the demux bug' })).toBeInTheDocument()
  })

  it('selects the next session after a successful archive', async () => {
    renderSession()

    await screen.findByRole('button', { name: 'Done, Fix the demux bug' })
    await userEvent.click(
      screen.getByRole('button', { name: 'Session actions for Fix the demux bug' }),
    )
    await userEvent.click(screen.getByRole('menuitem', { name: 'Archive' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Archive' }))

    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Done, Fix the demux bug' }),
      ).not.toBeInTheDocument(),
    )
    expect(screen.getByRole('button', { name: /Done, Add a health check/ })).toHaveAttribute(
      'aria-current',
      'true',
    )
  })

  it('puts an archived session back in the list after restore', async () => {
    listSessions.mockResolvedValueOnce([other])
    listArchivedSessions.mockResolvedValueOnce([session])
    renderSession()

    await screen.findByRole('button', { name: /Done, Add a health check/ })
    expect(
      screen.queryByRole('button', { name: 'Done, Fix the demux bug' }),
    ).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Archived' }))
    expect(screen.getByRole('button', { name: 'Done, Fix the demux bug' })).toBeInTheDocument()

    await userEvent.click(
      screen.getByRole('button', { name: 'Session actions for Fix the demux bug' }),
    )
    await userEvent.click(screen.getByRole('menuitem', { name: 'Restore' }))

    await waitFor(() => expect(unarchiveSession).toHaveBeenCalledWith(session.id))
    expect(screen.getByRole('button', { name: 'Done, Fix the demux bug' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Archived' })).not.toBeInTheDocument()
  })

  it('unarchives when an archived row is opened', async () => {
    listSessions.mockResolvedValueOnce([other])
    listArchivedSessions.mockResolvedValueOnce([session])
    renderSession()

    await screen.findByRole('button', { name: /Done, Add a health check/ })
    await userEvent.click(screen.getByRole('button', { name: 'Archived' }))
    await userEvent.click(screen.getByRole('button', { name: 'Done, Fix the demux bug' }))

    await waitFor(() => expect(unarchiveSession).toHaveBeenCalledWith(session.id))
    expect(screen.getByRole('button', { name: 'Done, Fix the demux bug' })).toHaveAttribute(
      'aria-current',
      'true',
    )
    expect(screen.queryByRole('button', { name: 'Archived' })).not.toBeInTheDocument()
  })

  it('shows the restored session instead of New Session', async () => {
    listSessions.mockResolvedValueOnce([other])
    listArchivedSessions.mockResolvedValueOnce([session])
    renderSession()

    await screen.findByRole('button', { name: /Done, Add a health check/ })
    await userEvent.click(screen.getByRole('button', { name: 'New session' }))
    expect(await screen.findByText('new session form')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Archived' }))
    await userEvent.click(
      screen.getByRole('button', { name: 'Session actions for Fix the demux bug' }),
    )
    await userEvent.click(screen.getByRole('menuitem', { name: 'Restore' }))

    await waitFor(() => expect(unarchiveSession).toHaveBeenCalledWith(session.id))
    expect(screen.queryByText('new session form')).not.toBeInTheDocument()
    expect(screen.getByText('transcript')).toBeInTheDocument()
  })

  it('keeps an archived selection when another project is removed', async () => {
    const otherProject: ProjectSummary = {
      ...project,
      id: '00000000-0000-4000-8000-000000000002',
      repoFullName: 'acme/other',
    }
    const archived: SessionSummary = {
      ...session,
      id: '00000000-0000-4000-8000-000000000013',
      projectId: otherProject.id,
      title: 'Old work',
    }
    listProjects.mockResolvedValueOnce([project, otherProject])
    listSessions.mockResolvedValueOnce([other])
    listArchivedSessions.mockResolvedValueOnce([archived])
    unarchiveSession.mockImplementationOnce(() => new Promise(() => {}))
    renderSession()

    await screen.findByRole('button', { name: /Done, Add a health check/ })
    await userEvent.click(screen.getByRole('button', { name: 'Archived' }))
    await userEvent.click(screen.getByRole('button', { name: /Done, Old work/ }))
    expect(screen.getByRole('button', { name: /Done, Old work/ })).toHaveAttribute(
      'aria-current',
      'true',
    )

    fireEvent.contextMenu(screen.getByText('acme/app'))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Remove' }))
    const dialog = screen.getByRole('dialog', { name: /remove acme\/app/i })
    await userEvent.type(within(dialog).getByRole('textbox'), 'acme/app')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))

    await waitFor(() => expect(deleteProject).toHaveBeenCalledWith(project.id))
    expect(screen.getByRole('button', { name: /Done, Old work/ })).toHaveAttribute(
      'aria-current',
      'true',
    )
  })

  it('shows the empty chrome when there are no sessions', async () => {
    listSessions.mockResolvedValueOnce([])
    renderSession()

    expect(await screen.findByText('No session selected')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Duke' })).toBeInTheDocument()
  })

  it('shows a retrying status when the first load fails', async () => {
    listProjects.mockRejectedValueOnce(new TypeError('network error'))
    listSessions.mockRejectedValueOnce(new TypeError('network error'))
    whoami.mockRejectedValueOnce(new TypeError('network error'))
    renderSession()

    expect(await screen.findByText('Couldn’t load sessions. Retrying…')).toBeInTheDocument()
    expect(screen.queryByText('No session selected')).not.toBeInTheDocument()
    expect(screen.queryByText(/No projects yet/)).not.toBeInTheDocument()

    expect(
      await screen.findByRole('button', { name: 'Done, Fix the demux bug' }, { timeout: 3000 }),
    ).toBeInTheDocument()
  })

  it('drops the previous server’s sessions when the active server changes', async () => {
    const connectionB = {
      serverName: 'debian-02',
      address: { host: 'debian-02.tailnet.ts.net', port: 7777, tls: false },
      deviceId: 'device-2',
      deviceToken: 'token-2',
      pairedAt: 2,
    }
    const sessionB: SessionSummary = {
      ...session,
      id: '00000000-0000-4000-8000-000000000021',
      title: 'Ship the dashboard',
    }

    const onSwitchServer = vi.fn()
    const { rerender } = render(
      <Session
        connection={connection}
        settings={defaultSettings()}
        update={update}
        onSaveSettings={vi.fn()}
        onSwitchServer={onSwitchServer}
        onDisconnected={vi.fn()}
      />,
    )

    expect(await screen.findByRole('button', { name: 'Done, Fix the demux bug' })).toHaveAttribute(
      'aria-current',
      'true',
    )
    expect(screen.getByRole('button', { name: /Done, Add a health check/ })).toBeInTheDocument()

    listProjects.mockResolvedValue([project])
    listSessions.mockResolvedValue([sessionB])

    // App switches by replacing the connection prop after Settings calls onSwitchServer.
    onSwitchServer(connectionB)
    rerender(
      <Session
        connection={connectionB}
        settings={defaultSettings()}
        update={update}
        onSaveSettings={vi.fn()}
        onSwitchServer={onSwitchServer}
        onDisconnected={vi.fn()}
      />,
    )

    expect(
      screen.queryByRole('button', { name: 'Done, Fix the demux bug' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /Done, Add a health check/ }),
    ).not.toBeInTheDocument()

    expect(await screen.findByRole('button', { name: 'Done, Ship the dashboard' })).toHaveAttribute(
      'aria-current',
      'true',
    )
    expect(
      screen.queryByRole('button', { name: 'Done, Fix the demux bug' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('No session selected')).not.toBeInTheDocument()
  })

  it('notifies once when a non-selected session starts waiting', async () => {
    renderSession()
    await screen.findByRole('button', { name: 'Done, Fix the demux bug' })
    notifyWaitingInput.mockClear()

    act(() => {
      lastOnSessionUpdate.current?.({ ...other, status: 'waiting_input' })
    })
    act(() => {
      lastOnSessionUpdate.current?.({ ...other, status: 'waiting_input' })
    })

    expect(notifyWaitingInput).toHaveBeenCalledTimes(1)
    expect(notifyWaitingInput).toHaveBeenCalledWith('Add a health check', expect.any(Function))
  })

  it('does not notify when the selected session is focused and visible', async () => {
    renderSession()
    await screen.findByRole('button', { name: 'Done, Fix the demux bug' })
    notifyWaitingInput.mockClear()

    act(() => {
      lastOnSessionUpdate.current?.({ ...session, status: 'waiting_input' })
    })

    expect(notifyWaitingInput).not.toHaveBeenCalled()
  })

  it('notifies when the selected session waits while Settings is open', async () => {
    renderSession()
    await screen.findByRole('button', { name: 'Done, Fix the demux bug' })
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(await screen.findByRole('heading', { name: 'Account' })).toBeInTheDocument()
    notifyWaitingInput.mockClear()

    act(() => {
      lastOnSessionUpdate.current?.({ ...session, status: 'waiting_input' })
    })

    expect(notifyWaitingInput).toHaveBeenCalledTimes(1)
  })

  it('notifies when the selected session waits while New Session is open', async () => {
    renderSession()
    await screen.findByRole('button', { name: 'Done, Fix the demux bug' })
    await userEvent.click(screen.getByRole('button', { name: 'New session' }))
    expect(screen.getByRole('button', { name: 'Done, Fix the demux bug' })).not.toHaveAttribute(
      'aria-current',
      'true',
    )
    notifyWaitingInput.mockClear()

    act(() => {
      lastOnSessionUpdate.current?.({ ...session, status: 'waiting_input' })
    })

    expect(notifyWaitingInput).toHaveBeenCalledTimes(1)
  })

  it('selects the waiting session when the notification is clicked', async () => {
    renderSession()
    await screen.findByRole('button', { name: 'Done, Fix the demux bug' })

    act(() => {
      lastOnSessionUpdate.current?.({ ...other, status: 'waiting_input' })
    })

    const onClick = notifyWaitingInput.mock.calls[0]?.[1] as (() => void) | undefined
    act(() => {
      onClick?.()
    })

    expect(
      screen.getByRole('button', { name: /Waiting for you, Add a health check/ }),
    ).toHaveAttribute('aria-current', 'true')
  })

  it('reflects a pull request that was merged on GitHub', async () => {
    const url = 'https://github.com/acme/app/pull/8'
    listSessions.mockResolvedValueOnce([
      {
        ...session,
        pullRequestUrl: url,
        pullRequest: { url, title: 'Fix the demux bug', isDraft: false, state: 'open' },
      },
    ])
    getPullRequest.mockResolvedValue({
      url,
      title: 'Fix the demux bug',
      isDraft: false,
      state: 'merged',
    })

    renderSession()

    expect(await screen.findByText(/This pull request was merged/)).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Merged pull request' })).toBeInTheDocument()
    expect(getPullRequest).toHaveBeenCalledWith(session.id)
  })

  it('archives the current session from search after confirm', async () => {
    renderSession()

    await screen.findByRole('button', { name: 'Done, Fix the demux bug' })
    await userEvent.click(screen.getByRole('button', { name: 'Search' }))
    await userEvent.click(screen.getByRole('option', { name: 'Archive current session' }))

    expect(archiveSession).not.toHaveBeenCalled()
    expect(screen.getByText('Hide from the sidebar. You can restore it later.')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Archive' }))
    await waitFor(() => expect(archiveSession).toHaveBeenCalledWith(session.id))
  })

  it('stops the selected session through the bound command', async () => {
    const onSessionCommands = vi.fn()
    render(
      <Session
        connection={connection}
        settings={defaultSettings()}
        update={update}
        onSaveSettings={vi.fn()}
        onSwitchServer={vi.fn()}
        onDisconnected={vi.fn()}
        onSessionCommands={onSessionCommands}
      />,
    )

    await screen.findByRole('button', { name: 'Done, Fix the demux bug' })
    const bound = onSessionCommands.mock.calls.at(-1)?.[0] as {
      selectedId: string
      stopSession: (sessionId: string) => Promise<void>
    }
    expect(bound.selectedId).toBe(session.id)
    await act(async () => {
      await bound.stopSession(session.id)
    })
    expect(stopSession).toHaveBeenCalledWith(session.id)
  })

  it('targets the on-screen repo from search, not the last session', async () => {
    const site: ProjectSummary = {
      ...project,
      id: '00000000-0000-4000-8000-000000000002',
      repoFullName: 'acme/site',
    }
    listProjects.mockResolvedValueOnce([project, site])
    renderSession()

    await screen.findByRole('button', { name: 'Done, Fix the demux bug' })
    await userEvent.click(screen.getByRole('button', { name: 'Environments for acme/site' }))
    expect(await screen.findByText(`environments for ${site.id}`)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Search' }))
    await userEvent.click(screen.getByRole('option', { name: 'New session on this repo' }))
    expect(await screen.findByText(`new session for ${site.id}`)).toBeInTheDocument()
  })

  it('keeps Tab inside the archive confirm', async () => {
    renderSession()

    await screen.findByRole('button', { name: 'Done, Fix the demux bug' })
    await userEvent.click(screen.getByRole('button', { name: 'Search' }))
    await userEvent.click(screen.getByRole('option', { name: 'Archive current session' }))

    const dialog = screen.getByRole('dialog', { name: 'Archive this session?' })
    within(dialog).getByRole('button', { name: 'Archive' }).focus()
    await userEvent.tab()

    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()
  })
})
