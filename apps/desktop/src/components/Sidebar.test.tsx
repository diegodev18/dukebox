import {
  DEFAULT_COMMIT_IDENTITY,
  type ProjectSummary,
  type SessionSummary,
} from '@dukebox/protocol'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}))

import { openUrl } from '@tauri-apps/plugin-opener'
import { Sidebar } from '@/components/Sidebar'

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
  changedFileCount: 1,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  lastSeq: 4,
  pullRequestUrl: null,
  pullRequest: null,
  environmentId: null,
  permissionMode: 'bypass',
}

function renderSidebar({
  onArchive = vi.fn(),
  onNewSession = vi.fn(),
  onConfigureEnvironment = vi.fn(),
  onManageEnvironments = vi.fn(),
  onRemoveProject = vi.fn(),
  projectOverride = {},
  sessionOverride = {},
  disabled = false,
}: {
  onArchive?: ReturnType<typeof vi.fn>
  onNewSession?: ReturnType<typeof vi.fn>
  onConfigureEnvironment?: ReturnType<typeof vi.fn>
  onManageEnvironments?: ReturnType<typeof vi.fn>
  onRemoveProject?: ReturnType<typeof vi.fn>
  projectOverride?: Partial<ProjectSummary>
  sessionOverride?: Partial<SessionSummary>
  disabled?: boolean
} = {}) {
  const row = { ...session, ...sessionOverride }
  render(
    <Sidebar
      projects={[{ ...project, ...projectOverride }]}
      sessions={[row]}
      selectedId={row.id}
      identity={DEFAULT_COMMIT_IDENTITY}
      role="owner"
      onOpenSettings={vi.fn()}
      onSelect={vi.fn()}
      onNewSession={onNewSession}
      onConfigureEnvironment={onConfigureEnvironment}
      onManageEnvironments={onManageEnvironments}
      onArchive={onArchive}
      onRemoveProject={onRemoveProject}
      disabled={disabled}
    />,
  )
  return {
    onArchive,
    onNewSession,
    onConfigureEnvironment,
    onManageEnvironments,
    onRemoveProject,
  }
}

function openProjectMenu() {
  fireEvent.contextMenu(screen.getByText('acme/app'))
  return screen.getByRole('menu', { name: 'Project' })
}

describe('Sidebar', () => {
  it('archives from the row actions menu after confirming', async () => {
    const { onArchive } = renderSidebar()

    await userEvent.click(screen.getByRole('button', { name: /session actions/i }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Archive' }))
    expect(onArchive).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('menuitem', { name: 'Archive' }))
    expect(onArchive).toHaveBeenCalledWith(session.id)
  })

  it('opens the archive menu from Delete on a focused row', async () => {
    renderSidebar()

    screen.getByRole('button', { name: /fix the demux bug/i, current: true }).focus()
    await userEvent.keyboard('{Delete}')

    expect(screen.getByRole('menu', { name: 'Session' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Archive' })).toBeInTheDocument()
  })

  it('opens a project menu on right-click of the repository', () => {
    renderSidebar()

    const menu = openProjectMenu()
    expect(within(menu).getByRole('menuitem', { name: 'New session' })).toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: 'Environments' })).toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: 'Open on GitHub' })).toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: 'Remove' })).toBeInTheDocument()
  })

  it('offers Set up when the project has no environments', () => {
    renderSidebar({ projectOverride: { environmentCount: 0 } })

    const menu = openProjectMenu()
    expect(within(menu).getByRole('menuitem', { name: 'Set up' })).toBeInTheDocument()
    expect(within(menu).queryByRole('menuitem', { name: 'Environments' })).not.toBeInTheDocument()
  })

  it('starts a new session for the project from the menu', async () => {
    const { onNewSession } = renderSidebar()

    openProjectMenu()
    await userEvent.click(screen.getByRole('menuitem', { name: 'New session' }))
    expect(onNewSession).toHaveBeenCalledWith(project.id)
  })

  it('starts an unscoped session from the sidebar action', async () => {
    const { onNewSession } = renderSidebar()

    await userEvent.click(screen.getByRole('button', { name: 'New session' }))
    expect(onNewSession).toHaveBeenCalledWith()
  })

  it('opens environments from the project menu', async () => {
    const { onManageEnvironments } = renderSidebar()

    openProjectMenu()
    await userEvent.click(screen.getByRole('menuitem', { name: 'Environments' }))
    expect(onManageEnvironments).toHaveBeenCalledWith(project.id)
  })

  it('opens setup from the project menu when nothing is configured', async () => {
    const { onConfigureEnvironment } = renderSidebar({
      projectOverride: { environmentCount: 0 },
    })

    openProjectMenu()
    await userEvent.click(screen.getByRole('menuitem', { name: 'Set up' }))
    expect(onConfigureEnvironment).toHaveBeenCalledWith(project.id)
  })

  it('opens the repository on GitHub', async () => {
    renderSidebar()

    openProjectMenu()
    await userEvent.click(screen.getByRole('menuitem', { name: 'Open on GitHub' }))
    expect(openUrl).toHaveBeenCalledWith('https://github.com/acme/app')
  })

  it('does not remove a project until the repository name is typed', async () => {
    const { onRemoveProject } = renderSidebar()

    openProjectMenu()
    await userEvent.click(screen.getByRole('menuitem', { name: 'Remove' }))

    const dialog = screen.getByRole('dialog', { name: /remove acme\/app/i })
    const confirm = within(dialog).getByRole('button', { name: 'Remove' })
    expect(confirm).toBeDisabled()

    await userEvent.type(within(dialog).getByRole('textbox'), 'acme/other')
    expect(confirm).toBeDisabled()
    expect(onRemoveProject).not.toHaveBeenCalled()

    await userEvent.clear(within(dialog).getByRole('textbox'))
    await userEvent.type(within(dialog).getByRole('textbox'), 'acme/app')
    expect(confirm).toBeEnabled()

    await userEvent.click(confirm)
    expect(onRemoveProject).toHaveBeenCalledWith(project.id)
  })

  it('blocks starting a session while disconnected', async () => {
    const { onNewSession } = renderSidebar({ disabled: true })

    expect(screen.getByRole('button', { name: 'New session' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'New session' }))
    expect(onNewSession).not.toHaveBeenCalled()
  })

  it('does not show a pull request mark when none exists', () => {
    renderSidebar()

    expect(screen.queryByRole('img', { name: /pull request/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('img', { name: 'Ready for review' })).not.toBeInTheDocument()
  })

  it('shows a draft pull request mark next to the time', () => {
    renderSidebar({
      sessionOverride: {
        pullRequestUrl: 'https://github.com/acme/app/pull/4',
        pullRequest: {
          url: 'https://github.com/acme/app/pull/4',
          title: 'Fix the demux bug',
          isDraft: true,
          state: 'open',
        },
      },
    })

    expect(screen.getByRole('img', { name: 'Draft pull request' })).toBeInTheDocument()
  })

  it('shows ready, merged, and closed marks from the pull request state', () => {
    const cases = [
      {
        isDraft: false,
        state: 'open' as const,
        name: 'Ready for review',
      },
      {
        isDraft: false,
        state: 'merged' as const,
        name: 'Merged pull request',
      },
      {
        isDraft: false,
        state: 'closed' as const,
        name: 'Closed pull request',
      },
    ]

    for (const { isDraft, state, name } of cases) {
      const { unmount } = render(
        <Sidebar
          projects={[project]}
          sessions={[
            {
              ...session,
              pullRequestUrl: 'https://github.com/acme/app/pull/4',
              pullRequest: {
                url: 'https://github.com/acme/app/pull/4',
                title: 'Fix the demux bug',
                isDraft,
                state,
              },
            },
          ]}
          selectedId={session.id}
          identity={DEFAULT_COMMIT_IDENTITY}
          role="owner"
          onOpenSettings={vi.fn()}
          onSelect={vi.fn()}
          onNewSession={vi.fn()}
          onConfigureEnvironment={vi.fn()}
          onManageEnvironments={vi.fn()}
          onArchive={vi.fn()}
          onRemoveProject={vi.fn()}
        />,
      )

      expect(screen.getByRole('img', { name })).toBeInTheDocument()
      unmount()
    }
  })
})
