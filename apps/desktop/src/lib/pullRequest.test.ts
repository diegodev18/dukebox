import { describe, expect, it } from 'vitest'
import type { PullRequestSummary } from '@dukebox/protocol'
import {
  pullRequestNumber,
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
