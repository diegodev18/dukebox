import type { ProjectSummary, SessionSummary } from '@dukebox/protocol'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '@/lib/settings'
import { resetLiveSession, useLiveSession } from '@/lib/liveSession'
import { ApiFailure } from '@/lib/client'

const listProjects = vi.fn()
const listSessions = vi.fn()
const whoami = vi.fn()
const archiveSession = vi.fn()
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

vi.mock('@/lib/useSession', () => ({
  useSession: () => ({
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
  }),
}))

vi.mock('@/lib/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/client')>()
  return {
    ...actual,
    DukeboxClient: class {
      listProjects = listProjects
      listSessions = listSessions
      whoami = whoami
      archiveSession = archiveSession
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
  whoami.mockResolvedValue({
    deviceId: 'device-1',
    deviceName: 'Mac',
    role: 'owner',
    capabilities: { manageDevices: true, manageAgents: true, deleteProjects: true },
  })
  archiveSession.mockResolvedValue(undefined)
  removeConnection.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.clearAllMocks()
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

    expect(
      await screen.findByRole('button', { name: 'Done, Fix the demux bug' }, { timeout: 3000 }),
    ).toBeInTheDocument()
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
})
