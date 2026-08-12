import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { PullRequestPanel } from '@/components/PullRequest'
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
        session={{
          ...session,
          pullRequestUrl: 'https://github.com/diego/dukebox/pull/1',
          pullRequest: {
            url: 'https://github.com/diego/dukebox/pull/1',
            title: 'Add a health check',
            isDraft: true,
            state: 'open',
          },
        }}
        files={[]}
        onUpdated={vi.fn()}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Ready for review' }))
    expect(client.markPullRequestReady).toHaveBeenCalledWith(session.id)
  })

  it('asks before merging', async () => {
    const client = {
      mergePullRequest: vi.fn().mockResolvedValue({
        url: 'https://github.com/diego/dukebox/pull/1',
        title: 'Add a health check',
        isDraft: false,
        state: 'merged',
      }),
    }

    render(
      <PullRequestPanel
        client={client as never}
        session={{
          ...session,
          pullRequestUrl: 'https://github.com/diego/dukebox/pull/1',
          pullRequest: {
            url: 'https://github.com/diego/dukebox/pull/1',
            title: 'Add a health check',
            isDraft: false,
            state: 'open',
          },
        }}
        files={[]}
        onUpdated={vi.fn()}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Merge' }))
    expect(client.mergePullRequest).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'Confirm merge' }))
    expect(client.mergePullRequest).toHaveBeenCalledWith(session.id)
  })
})
