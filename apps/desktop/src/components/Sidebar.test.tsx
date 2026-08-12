import {
  DEFAULT_COMMIT_IDENTITY,
  type ProjectSummary,
  type SessionSummary,
} from '@dukebox/protocol'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
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
  environmentId: null,
  permissionMode: 'bypass',
}

function renderSidebar(onArchive = vi.fn()) {
  render(
    <Sidebar
      projects={[project]}
      sessions={[session]}
      selectedId={session.id}
      identity={DEFAULT_COMMIT_IDENTITY}
      onOpenSettings={vi.fn()}
      onSelect={vi.fn()}
      onNewSession={vi.fn()}
      onConfigureEnvironment={vi.fn()}
      onManageEnvironments={vi.fn()}
      onArchive={onArchive}
    />,
  )
  return onArchive
}

describe('Sidebar', () => {
  it('archives from the row actions menu after confirming', async () => {
    const onArchive = renderSidebar()

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
})
