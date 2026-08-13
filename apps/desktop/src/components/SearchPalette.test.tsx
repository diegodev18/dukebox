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
  onOpenSettings = vi.fn(),
  onDismiss = vi.fn(),
}: {
  onSelect?: ReturnType<typeof vi.fn>
  onNewSession?: ReturnType<typeof vi.fn>
  onOpenSettings?: ReturnType<typeof vi.fn>
  onDismiss?: ReturnType<typeof vi.fn>
} = {}) {
  render(
    <SearchPalette
      sessions={[demux, health]}
      projects={[dukebox, notes]}
      role="owner"
      onSelect={onSelect}
      onNewSession={onNewSession}
      onOpenSettings={onOpenSettings}
      onDismiss={onDismiss}
    />,
  )
  return { onSelect, onNewSession, onOpenSettings, onDismiss }
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
})
