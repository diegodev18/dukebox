import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { PullRequestPanel } from '@/components/PullRequest'
import { ApiFailure } from '@/lib/client'
import type { SessionSummary } from '@dukebox/protocol'

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn(),
}))

vi.mock('@/lib/syntaxHighlight', () => ({
  tokensForCode: async (_path: string, code: string) =>
    code.split('\n').map((content) => [{ content: content || ' ' }]),
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
    expect(screen.queryByRole('button', { name: 'Merge' })).not.toBeInTheDocument()
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

  it('refreshes the pull request from the server when the tab opens', async () => {
    const client = {
      getPullRequest: vi.fn().mockResolvedValue({
        ...openPr,
        isDraft: false,
        state: 'merged',
      }),
    }
    const onUpdated = vi.fn()

    render(
      <PullRequestPanel
        client={client as never}
        session={sessionWithPr()}
        files={[]}
        onUpdated={onUpdated}
      />,
    )

    await waitFor(() =>
      expect(onUpdated).toHaveBeenCalledWith({
        pullRequestUrl: openPr.url,
        pullRequest: expect.objectContaining({ state: 'merged' }),
      }),
    )
    expect(client.getPullRequest).toHaveBeenCalledWith(session.id)
  })

  it('refuses merge when status checks have not passed', async () => {
    const client = {
      getPullRequest: vi.fn().mockResolvedValue({
        ...openPr,
        mergeable: 'MERGEABLE',
        checks: 'failing',
      }),
      mergePullRequest: vi.fn(),
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
    expect(screen.getByRole('alert')).toHaveTextContent(/status checks have not passed/)
  })

  it('hides merge while the agent is running', async () => {
    const client = {
      getPullRequest: vi.fn().mockResolvedValue({ ...openPr, mergeable: 'MERGEABLE' }),
    }

    render(
      <PullRequestPanel
        client={client as never}
        session={sessionWithPr({ status: 'running' })}
        files={[]}
        onUpdated={vi.fn()}
      />,
    )

    await waitFor(() => expect(client.getPullRequest).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: 'Merge' })).not.toBeInTheDocument()
  })

  it('offers a new session from the base branch after a merge', async () => {
    const onContinue = vi.fn()
    const client = {
      getPullRequest: vi.fn().mockResolvedValue({ ...openPr, state: 'merged' as const }),
    }

    render(
      <PullRequestPanel
        client={client as never}
        session={sessionWithPr({
          baseBranch: 'develop',
          pullRequest: { ...openPr, state: 'merged' },
        })}
        files={[]}
        onUpdated={vi.fn()}
        onContinue={onContinue}
      />,
    )

    expect(screen.queryByRole('button', { name: 'Merge' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Ready for review' })).not.toBeInTheDocument()
    expect(screen.getByText(/This pull request was merged/, { exact: false })).toBeInTheDocument()
    expect(screen.getByText(/start from develop/, { exact: false })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'New session from develop' }))
    expect(onContinue).toHaveBeenCalledOnce()
  })

  it('keeps the pull request chrome still and scrolls only the diff', async () => {
    const client = {
      getPullRequest: vi.fn().mockResolvedValue({ ...openPr, mergeable: 'MERGEABLE' }),
    }

    render(
      <PullRequestPanel
        client={client as never}
        session={sessionWithPr()}
        files={[
          {
            path: 'packages/sandbox/src/container.ts',
            before: 'return raw',
            after: 'return demuxed',
          },
        ]}
        onUpdated={vi.fn()}
      />,
    )

    const panel = document.getElementById('workspace-panel-pr')
    expect(panel?.className).toMatch(/overflow-hidden/)

    const merge = screen.getByRole('button', { name: 'Merge' })
    expect(merge.closest('.overflow-auto')).toBeNull()
    expect(screen.getByText('Add a health check').closest('.overflow-auto')).toBeNull()

    const file = screen.getByRole('button', { name: 'container.ts' })
    expect(file.className).toMatch(/\bsticky\b/)
    expect(file.closest('.overflow-auto')).not.toBeNull()
    await waitFor(() => {
      expect(screen.getByText('return demuxed').closest('[aria-busy="false"]')).not.toBeNull()
    })
  })

  it('shows why merge is blocked and opens the checks panel', async () => {
    const client = {
      getPullRequest: vi.fn().mockResolvedValue({
        ...openPr,
        mergeable: 'MERGEABLE',
        checks: 'pending',
        checkRuns: [{ name: 'ci', state: 'pending' }],
      }),
      mergePullRequest: vi.fn(),
    }

    render(
      <PullRequestPanel
        client={client as never}
        session={sessionWithPr()}
        files={[]}
        onUpdated={vi.fn()}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('Checks are still running')).toBeInTheDocument()
    })

    await userEvent.click(screen.getByRole('button', { name: 'Merge' }))
    expect(client.mergePullRequest).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(/still running/)
    expect(screen.getByRole('tab', { name: /Checks/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('ci')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'See checks' })).toBeInTheDocument()
  })

  it('renders description, commits, checks, and reviews', async () => {
    const client = {
      getPullRequest: vi.fn().mockResolvedValue({
        ...openPr,
        body: 'Adds /health.',
        checks: 'passing',
        commits: [{ sha: 'abc1234ffff', title: 'Wire /health into the server', author: 'diego' }],
        checkRuns: [{ name: 'ci', state: 'passing' }],
        reviews: [{ author: 'ada', state: 'APPROVED', body: 'Nice.' }],
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

    await waitFor(() => expect(client.getPullRequest).toHaveBeenCalled())
    expect(screen.getByRole('tab', { name: 'Changes' })).toHaveAttribute('aria-selected', 'true')

    await userEvent.click(screen.getByRole('tab', { name: 'Description' }))
    expect(screen.getByText('Adds /health.')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('tab', { name: 'Commits' }))
    expect(screen.getByText('Wire /health into the server')).toBeInTheDocument()
    expect(screen.getByText('abc1234')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('tab', { name: /Checks/ }))
    expect(screen.getByText('ci')).toBeInTheDocument()
    expect(screen.getByText('Passed')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('tab', { name: 'Reviews' }))
    expect(screen.getByText('ada')).toBeInTheDocument()
    expect(screen.getByText(/Approved/)).toBeInTheDocument()
    expect(screen.getByText('Nice.')).toBeInTheDocument()
  })

  it('explains a refused merge instead of a generic refusal', async () => {
    const client = {
      getPullRequest: vi.fn().mockResolvedValue({ ...openPr, mergeable: 'MERGEABLE' }),
      mergePullRequest: vi
        .fn()
        .mockRejectedValue(
          new ApiFailure(409, 'conflict', 'GitHub status checks are still running'),
        ),
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
    expect(screen.getByRole('alert')).toHaveTextContent(/still running/)
    expect(screen.getByRole('alert')).not.toHaveTextContent(/refused/)
    expect(screen.getByRole('button', { name: 'See checks' })).toBeInTheDocument()
  })
})
