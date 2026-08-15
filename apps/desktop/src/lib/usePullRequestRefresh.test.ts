import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@dukebox/protocol'
import { PULL_REQUEST_POLL_MS } from '@/lib/pullRequest'
import { useOpenPullRequestRefresh } from '@/lib/usePullRequestRefresh'

const openPr = {
  url: 'https://github.com/acme/app/pull/8',
  title: 'Fix the demux bug',
  isDraft: false,
  state: 'open' as const,
}

const session: SessionSummary = {
  id: '00000000-0000-4000-8000-000000000011',
  projectId: '00000000-0000-4000-8000-000000000001',
  agentId: 'claude-code',
  status: 'done',
  purpose: 'coding',
  title: 'Fix the demux bug',
  branch: 'duke/abc',
  baseBranch: 'main',
  changedFileCount: 1,
  createdAt: 1,
  updatedAt: 1,
  lastSeq: 4,
  pullRequestUrl: openPr.url,
  pullRequest: openPr,
  environmentId: null,
  permissionMode: 'bypass',
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useOpenPullRequestRefresh', () => {
  it('applies a merge that happened on GitHub when the session is selected', async () => {
    const getPullRequest = vi.fn().mockResolvedValue({ ...openPr, state: 'merged' })
    const onUpdated = vi.fn()

    renderHook(() =>
      useOpenPullRequestRefresh({ getPullRequest }, [session], session.id, true, onUpdated),
    )

    await waitFor(() =>
      expect(onUpdated).toHaveBeenCalledWith(session.id, {
        pullRequestUrl: openPr.url,
        pullRequest: expect.objectContaining({ state: 'merged' }),
      }),
    )
  })

  it('refreshes every open pull request when the window is focused again', async () => {
    const other: SessionSummary = {
      ...session,
      id: '00000000-0000-4000-8000-000000000012',
      title: 'Add a health check',
      pullRequestUrl: 'https://github.com/acme/app/pull/9',
      pullRequest: { ...openPr, url: 'https://github.com/acme/app/pull/9', title: 'Health' },
    }
    const getPullRequest = vi
      .fn()
      .mockImplementation(async (id: string) =>
        id === session.id
          ? { ...openPr, state: 'merged' }
          : { ...other.pullRequest, state: 'merged' },
      )
    const onUpdated = vi.fn()

    renderHook(() =>
      useOpenPullRequestRefresh({ getPullRequest }, [session, other], session.id, true, onUpdated),
    )

    await waitFor(() => expect(onUpdated).toHaveBeenCalled())
    onUpdated.mockClear()
    getPullRequest.mockClear()

    act(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
      document.dispatchEvent(new Event('visibilitychange'))
    })

    await waitFor(() => {
      expect(getPullRequest).toHaveBeenCalledWith(session.id)
      expect(getPullRequest).toHaveBeenCalledWith(other.id)
      expect(onUpdated).toHaveBeenCalledWith(
        other.id,
        expect.objectContaining({
          pullRequest: expect.objectContaining({ state: 'merged' }),
        }),
      )
    })
  })

  it('polls the selected open pull request until GitHub reports it merged', async () => {
    vi.useFakeTimers()
    const getPullRequest = vi
      .fn()
      .mockResolvedValueOnce({ ...openPr })
      .mockResolvedValueOnce({ ...openPr, state: 'merged' })
    const onUpdated = vi.fn()

    renderHook(() =>
      useOpenPullRequestRefresh({ getPullRequest }, [session], session.id, true, onUpdated),
    )

    await act(async () => {
      await Promise.resolve()
    })
    expect(getPullRequest).toHaveBeenCalledTimes(1)
    expect(onUpdated).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PULL_REQUEST_POLL_MS)
    })

    expect(getPullRequest).toHaveBeenCalledTimes(2)
    expect(onUpdated).toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({ pullRequest: expect.objectContaining({ state: 'merged' }) }),
    )
  })

  it('does not refresh when the socket is down or there is no open pull request', async () => {
    const getPullRequest = vi.fn()
    const onUpdated = vi.fn()
    const closed: SessionSummary = {
      ...session,
      pullRequest: { ...openPr, state: 'merged' },
    }

    renderHook(() =>
      useOpenPullRequestRefresh({ getPullRequest }, [closed], closed.id, false, onUpdated),
    )
    renderHook(() =>
      useOpenPullRequestRefresh({ getPullRequest }, [closed], closed.id, true, onUpdated),
    )

    await act(async () => {
      await Promise.resolve()
    })
    expect(getPullRequest).not.toHaveBeenCalled()
    expect(onUpdated).not.toHaveBeenCalled()
  })
})
