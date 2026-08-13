import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { PullRequestPanel } from '@/components/PullRequest'
import { ApiFailure } from '@/lib/client'
import type { SessionSummary } from '@dukebox/protocol'

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn(),
}))

const session: SessionSummary = {
  id: '11111111-1111-4111-8111-111111111111',
  projectId: '22222222-2222-4222-8222-222222222222',
  agentId: 'claude-code',
  status: 'done',
  purpose: 'coding',
  title: 'Add a health check',
  branch: 'duke/abc',
  baseBranch: 'main',
  changedFileCount: 1,
  createdAt: 1,
  updatedAt: 1,
  lastSeq: 1,
  pullRequestUrl: null,
  pullRequest: null,
  environmentId: null,
  permissionMode: 'bypass',
}

const openPr = {
  url: 'https://github.com/diego/dukebox/pull/1',
  title: 'Add a health check',
  isDraft: false,
  state: 'open' as const,
}

function sessionWithPr(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    ...session,
    pullRequestUrl: openPr.url,
    pullRequest: openPr,
    ...overrides,
  }
}

describe('PullRequestPanel', () => {
  it('offers to open a pull request when none exists', async () => {
    const client = {
      openPullRequest: vi.fn().mockResolvedValue({
        url: 'https://github.com/diego/dukebox/pull/1',
        title: 'Add a health check',
        isDraft: true,
        state: 'open',
      }),
    }
    const onUpdated = vi.fn()

    render(
      <PullRequestPanel
        client={client as never}
        session={session}
        files={[]}
        onUpdated={onUpdated}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Open pull request' }))
    expect(client.openPullRequest).toHaveBeenCalledWith(session.id)
    expect(onUpdated).toHaveBeenCalledWith({
      pullRequestUrl: 'https://github.com/diego/dukebox/pull/1',
      pullRequest: expect.objectContaining({ isDraft: true }),
    })
  })

  it('marks a draft ready for review', async () => {
    const client = {
      markPullRequestReady: vi.fn().mockResolvedValue({
        url: 'https://github.com/diego/dukebox/pull/1',
        title: 'Add a health check',
        isDraft: false,
        state: 'open',
      }),
    }

    render(
      <PullRequestPanel
        client={client as never}
        session={sessionWithPr({
          pullRequest: { ...openPr, isDraft: true },
        })}
        files={[]}
        onUpdated={vi.fn()}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Ready for review' }))
    expect(client.markPullRequestReady).toHaveBeenCalledWith(session.id)
  })

  it('checks mergeable before asking to confirm', async () => {
    const client = {
      getPullRequest: vi.fn().mockResolvedValue({ ...openPr, mergeable: 'MERGEABLE' }),
      mergePullRequest: vi.fn().mockResolvedValue({ ...openPr, state: 'merged' }),
    }

    render(
      <PullRequestPanel
        client={client as never}
        session={sessionWithPr()}
        files={[]}
        onUpdated={vi.fn()}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Merge' }))
    expect(client.mergePullRequest).not.toHaveBeenCalled()
    expect(client.getPullRequest).toHaveBeenCalledWith(session.id)

    await userEvent.click(screen.getByRole('button', { name: 'Confirm merge' }))
    expect(client.mergePullRequest).toHaveBeenCalledWith(session.id)
  })

  it('asks whether the agent should resolve conflicts', async () => {
    const client = {
      getPullRequest: vi.fn().mockResolvedValue({ ...openPr, mergeable: 'CONFLICTING' }),
      mergePullRequest: vi.fn(),
      resolvePullRequestConflicts: vi.fn().mockResolvedValue({
        status: 'resolving',
        conflictedFiles: ['README.md'],
      }),
    }

    render(
      <PullRequestPanel
        client={client as never}
        session={sessionWithPr()}
        files={[]}
        onUpdated={vi.fn()}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Merge' }))
    expect(client.mergePullRequest).not.toHaveBeenCalled()
    expect(
      screen.getByText(/This pull request conflicts with main/, { exact: false }),
    ).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(client.resolvePullRequestConflicts).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Merge' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Merge' }))
    await userEvent.click(screen.getByRole('button', { name: 'Resolve conflicts' }))
    expect(client.resolvePullRequestConflicts).toHaveBeenCalledWith(session.id)
    expect(screen.getByText(/The agent is resolving conflicts/)).toBeInTheDocument()
  })

  it('confirms merge after a clean conflict resolution', async () => {
    const client = {
      getPullRequest: vi.fn().mockResolvedValue({ ...openPr, mergeable: 'CONFLICTING' }),
      mergePullRequest: vi.fn().mockResolvedValue({ ...openPr, state: 'merged' }),
      resolvePullRequestConflicts: vi.fn().mockResolvedValue({ status: 'resolved' }),
    }

    render(
      <PullRequestPanel
        client={client as never}
        session={sessionWithPr()}
        files={[]}
        onUpdated={vi.fn()}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Merge' }))
    await userEvent.click(screen.getByRole('button', { name: 'Resolve conflicts' }))
    expect(screen.getByRole('button', { name: 'Confirm merge' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Confirm merge' }))
    expect(client.mergePullRequest).toHaveBeenCalledWith(session.id)
  })

  it('offers conflict resolution when merge itself reports conflicts', async () => {
    const client = {
      getPullRequest: vi.fn().mockResolvedValue({ ...openPr, mergeable: 'MERGEABLE' }),
      mergePullRequest: vi
        .fn()
        .mockRejectedValue(
          new ApiFailure(
            409,
            'merge_conflict',
            'this pull request has conflicts with the base branch',
          ),
        ),
      resolvePullRequestConflicts: vi.fn(),
    }

    render(
      <PullRequestPanel
        client={client as never}
        session={sessionWithPr()}
        files={[]}
        onUpdated={vi.fn()}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Merge' }))
    await userEvent.click(screen.getByRole('button', { name: 'Confirm merge' }))
    expect(screen.getByRole('button', { name: 'Resolve conflicts' })).toBeInTheDocument()
    expect(client.resolvePullRequestConflicts).not.toHaveBeenCalled()
  })
})
