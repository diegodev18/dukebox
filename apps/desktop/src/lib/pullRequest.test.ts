import { describe, expect, it } from 'vitest'
import type { PullRequestSummary } from '@dukebox/protocol'
import {
  pullRequestCheckRunLabel,
  pullRequestChecksTabLabel,
  pullRequestCommitSha,
  pullRequestMergeHint,
  pullRequestNumber,
  pullRequestReviewStateLabel,
  pullRequestStatus,
  pullRequestStatusAriaLabel,
  pullRequestStatusLabel,
  pullRequestTabLabel,
} from '@/lib/pullRequest'

const pr = (overrides: Partial<PullRequestSummary> = {}): PullRequestSummary => ({
  url: 'https://github.com/diego/dukebox/pull/1',
  title: 'Add a health check',
  isDraft: true,
  state: 'open',
  ...overrides,
})

describe('pullRequestNumber', () => {
  it('reads the number from a GitHub pull request URL', () => {
    expect(pullRequestNumber('https://github.com/diego/dukebox/pull/12')).toBe(12)
  })

  it('still reads the number when the URL has a query or fragment', () => {
    expect(pullRequestNumber('https://github.com/diego/dukebox/pull/12?tab=files')).toBe(12)
    expect(pullRequestNumber('https://github.com/diego/dukebox/pull/12#discussion')).toBe(12)
  })

  it('returns null when the URL is not a pull request', () => {
    expect(pullRequestNumber('https://github.com/diego/dukebox')).toBeNull()
    expect(pullRequestNumber('https://github.com/diego/dukebox/issues/12')).toBeNull()
  })
})

describe('pullRequestStatus', () => {
  it('treats an open draft as draft, not ready', () => {
    expect(pullRequestStatus(pr({ isDraft: true, state: 'open' }))).toBe('draft')
    expect(pullRequestStatusLabel('draft')).toBe('Draft')
  })

  it('treats an open non-draft as ready for review', () => {
    expect(pullRequestStatus(pr({ isDraft: false, state: 'open' }))).toBe('open')
    expect(pullRequestStatusLabel('open')).toBe('Ready for review')
    expect(pullRequestStatusAriaLabel('open')).toBe('Ready for review')
  })

  it('does not call a merged or closed draft ready', () => {
    expect(pullRequestStatus(pr({ isDraft: true, state: 'merged' }))).toBe('merged')
    expect(pullRequestStatus(pr({ isDraft: true, state: 'closed' }))).toBe('closed')
  })
})

describe('pullRequestTabLabel', () => {
  it('is the bare tab name until a number exists', () => {
    expect(pullRequestTabLabel(null)).toBe('Pull request')
    expect(pullRequestTabLabel('https://github.com/diego/dukebox')).toBe('Pull request')
  })

  it('includes the number once the pull request is opened', () => {
    expect(pullRequestTabLabel('https://github.com/diego/dukebox/pull/1')).toBe('Pull request #1')
  })
})

describe('pullRequestMergeHint', () => {
  it('names the merge block without the GitHub prefix', () => {
    expect(pullRequestMergeHint({ checks: 'pending' })).toBe('Checks are still running')
    expect(pullRequestMergeHint({ checks: 'failing' })).toBe('Status checks have not passed')
    expect(pullRequestMergeHint({ reviewDecision: 'REVIEW_REQUIRED' })).toBe('Needs a review')
    expect(pullRequestMergeHint({ reviewDecision: 'CHANGES_REQUESTED' })).toBe('Changes requested')
    expect(pullRequestMergeHint({ checks: 'passing' })).toBeNull()
  })
})

describe('pull request list labels', () => {
  it('shortens a commit sha and names check and review states', () => {
    expect(pullRequestCommitSha('abc123def456')).toBe('abc123d')
    expect(pullRequestCheckRunLabel('pending')).toBe('In progress')
    expect(pullRequestReviewStateLabel('CHANGES_REQUESTED')).toBe('Changes requested')
    expect(
      pullRequestChecksTabLabel([
        { name: 'ci', state: 'passing' },
        { name: 'lint', state: 'pending' },
      ]),
    ).toBe('Checks · 1/2')
  })
})
