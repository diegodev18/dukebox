import { type ProjectSummary, type SessionSummary } from '@dukebox/protocol'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SearchPalette } from '@/components/SearchPalette'

const dukebox: ProjectSummary = {
  id: '00000000-0000-4000-8000-000000000001',
  repoFullName: 'acme/app',
  defaultBranch: 'main',
  environmentCount: 1,
  createdAt: Date.now(),
  sessionCount: 1,
}

const notes: ProjectSummary = {
  id: '00000000-0000-4000-8000-000000000002',
  repoFullName: 'acme/notes',
  defaultBranch: 'main',
  environmentCount: 0,
  createdAt: Date.now(),
  sessionCount: 0,
}

const session = (
  overrides: Partial<SessionSummary> & Pick<SessionSummary, 'id' | 'title'>,
): SessionSummary => ({
  projectId: dukebox.id,
  agentId: 'claude-code',
  status: 'done',
  purpose: 'coding',
  branch: 'duke/abc',
  baseBranch: 'main',
  changedFileCount: 0,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  lastSeq: 0,
  pullRequestUrl: null,
  pullRequest: null,
  environmentId: null,
  permissionMode: 'bypass',
  ...overrides,
})

const demux = session({
  id: '00000000-0000-4000-8000-000000000011',
  title: 'Fix the demux bug',
  updatedAt: Date.now(),
})

const health = session({
  id: '00000000-0000-4000-8000-000000000012',
  title: 'Add a health check',
  updatedAt: Date.now() - 60_000,
})

function renderPalette({
  onSelect = vi.fn(),
  onNewSession = vi.fn(),
  onManageEnvironments = vi.fn(),
  onArchive = vi.fn(),
  onOpenSettings = vi.fn(),
  onDismiss = vi.fn(),
  selectedSessionId = null as string | null,
  selectedProjectId = null as string | null,
}: {
  onSelect?: ReturnType<typeof vi.fn>
  onNewSession?: ReturnType<typeof vi.fn>
  onManageEnvironments?: ReturnType<typeof vi.fn>
  onArchive?: ReturnType<typeof vi.fn>
  onOpenSettings?: ReturnType<typeof vi.fn>
  onDismiss?: ReturnType<typeof vi.fn>
  selectedSessionId?: string | null
  selectedProjectId?: string | null
} = {}) {
  render(
    <SearchPalette
      sessions={[demux, health]}
      projects={[dukebox, notes]}
      role="owner"
      selectedSessionId={selectedSessionId}
      selectedProjectId={selectedProjectId}
      onSelect={onSelect}
      onNewSession={onNewSession}
      onManageEnvironments={onManageEnvironments}
      onArchive={onArchive}
      onOpenSettings={onOpenSettings}
      onDismiss={onDismiss}
    />,
  )
  return { onSelect, onNewSession, onManageEnvironments, onArchive, onOpenSettings, onDismiss }
}

describe('SearchPalette', () => {
  it('lists recent sessions, repos, and actions', () => {
    renderPalette()

    const dialog = screen.getByRole('dialog', { name: 'Search' })
    expect(within(dialog).getByText('Recent sessions')).toBeInTheDocument()
    expect(within(dialog).getByRole('option', { name: /fix the demux bug/i })).toBeInTheDocument()
    expect(within(dialog).getByRole('option', { name: 'acme/notes' })).toBeInTheDocument()
    expect(within(dialog).getByRole('option', { name: 'New session' })).toBeInTheDocument()
  })

  it('filters by typed query', async () => {
    renderPalette()

    await userEvent.type(
      screen.getByRole('searchbox', { name: /search sessions, repos, actions/i }),
      'health',
    )

    expect(screen.getByRole('option', { name: /add a health check/i })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /fix the demux bug/i })).not.toBeInTheDocument()
  })

  it('restricts results to the selected filter tab', async () => {
    renderPalette()

    await userEvent.click(screen.getByRole('tab', { name: 'Repos' }))

    expect(screen.queryByRole('option', { name: /fix the demux bug/i })).not.toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'acme/app' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'acme/notes' })).toBeInTheDocument()
  })

  it('shows archived sessions on the archived tab', async () => {
    const archived = session({
      id: '00000000-0000-4000-8000-000000000099',
      title: 'Old work',
    })
    render(
      <SearchPalette
        sessions={[demux, health]}
        archivedSessions={[archived]}
        projects={[dukebox, notes]}
        role="owner"
        onSelect={vi.fn()}
        onNewSession={vi.fn()}
        onOpenSettings={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )

    expect(screen.queryByRole('option', { name: /old work/i })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: 'Archived' }))
    expect(screen.getByRole('option', { name: /old work/i })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /fix the demux bug/i })).not.toBeInTheDocument()
  })

  it('opens the highlighted session with Enter', async () => {
    const { onSelect, onDismiss } = renderPalette()

    await userEvent.keyboard('{Enter}')

    expect(onSelect).toHaveBeenCalledWith(demux.id)
    expect(onDismiss).toHaveBeenCalled()
  })

  it('moves the highlight with arrow keys', async () => {
    const { onSelect } = renderPalette()

    await userEvent.keyboard('{ArrowDown}{Enter}')

    expect(onSelect).toHaveBeenCalledWith(health.id)
  })

  it('closes on Escape', async () => {
    const { onDismiss } = renderPalette()

    await userEvent.keyboard('{Escape}')
    expect(onDismiss).toHaveBeenCalled()
  })

  it('starts a session for a repo that has none', async () => {
    const { onNewSession } = renderPalette()

    await userEvent.click(screen.getByRole('option', { name: 'acme/notes' }))
    expect(onNewSession).toHaveBeenCalledWith(notes.id)
  })

  it('lists session verbs when a session is selected', () => {
    renderPalette({ selectedSessionId: demux.id, selectedProjectId: dukebox.id })

    expect(screen.getByRole('option', { name: 'New session on this repo' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Manage environments' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Archive current session' })).toBeInTheDocument()
  })

  it('starts a session on the selected repo', async () => {
    const { onNewSession, onDismiss } = renderPalette({
      selectedSessionId: demux.id,
      selectedProjectId: dukebox.id,
    })

    await userEvent.click(screen.getByRole('option', { name: 'New session on this repo' }))
    expect(onNewSession).toHaveBeenCalledWith(dukebox.id)
    expect(onDismiss).toHaveBeenCalled()
  })

  it('opens environments for the selected repo', async () => {
    const { onManageEnvironments } = renderPalette({
      selectedSessionId: demux.id,
      selectedProjectId: dukebox.id,
    })

    await userEvent.click(screen.getByRole('option', { name: 'Manage environments' }))
    expect(onManageEnvironments).toHaveBeenCalledWith(dukebox.id)
  })

  it('asks to archive the current session', async () => {
    const { onArchive } = renderPalette({
      selectedSessionId: demux.id,
      selectedProjectId: dukebox.id,
    })

    await userEvent.click(screen.getByRole('option', { name: 'Archive current session' }))
    expect(onArchive).toHaveBeenCalledWith(demux.id)
  })
})
