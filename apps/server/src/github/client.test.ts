import { describe, expect, it, vi } from 'vitest'
import { GitHubClient, GitHubError, pullRequestFailureMessage } from '@/github/client'

/**
 * The CLI is injected rather than executed. These assert the arguments the
 * client builds and how it reads what comes back — running the real `gh` would
 * mean using someone's actual GitHub account.
 *
 * The recorded shapes come from gh 2.83.1 and 2.97.0.
 */

/** A client whose CLI returns a fixed response. */
function clientReturning(output: string) {
  const run = vi.fn(async () => output)
  return { client: new GitHubClient({ run }), run }
}

/** A client whose CLI fails. */
function clientFailing(message: string) {
  return new GitHubClient({
    run: async () => {
      throw new GitHubError(message)
    },
  })
}

const REPO_LIST = JSON.stringify([
  {
    nameWithOwner: 'diego/dukebox',
    defaultBranchRef: { name: 'main' },
    isPrivate: true,
    updatedAt: '2026-07-31T17:51:52Z',
  },
  {
    nameWithOwner: 'diego/other',
    defaultBranchRef: { name: 'master' },
    isPrivate: false,
    updatedAt: '2026-07-30T10:00:00Z',
  },
])

describe('token', () => {
  it('returns the token gh holds', async () => {
    const { client } = clientReturning('gho_thetoken\n')
    expect(await client.token()).toBe('gho_thetoken')
  })

  it('rejects an empty token with something the operator can act on', async () => {
    const { client } = clientReturning('\n')
    await expect(client.token()).rejects.toMatchObject({ remedy: 'Run: gh auth login' })
  })

  it('reads the token fresh each time, never caching it', async () => {
    const { client, run } = clientReturning('gho_thetoken\n')

    await client.token()
    await client.token()

    // The credential proxy calls this per request; caching would keep the
    // token in memory and ignore a re-login on the host.
    expect(run).toHaveBeenCalledTimes(2)
  })
})

describe('isAuthenticated', () => {
  it('is true when gh reports a login', async () => {
    const { client } = clientReturning('Logged in to github.com account diego')
    expect(await client.isAuthenticated()).toBe(true)
  })

  it('is false rather than throwing when gh is signed out', async () => {
    // Called from preflight, where a failure is a state to report, not an
    // exception to handle.
    expect(await clientFailing('not logged into any hosts').isAuthenticated()).toBe(false)
  })
})

describe('listRepositories', () => {
  it('asks for the fields the session picker needs', async () => {
    const { client, run } = clientReturning(REPO_LIST)
    await client.listRepositories()

    const args = run.mock.calls[0]?.[0] as unknown as string[]
    const joined = args.join(' ')
    expect(joined).toContain('api')
    expect(joined).toContain('user/repos')
    expect(joined).toContain('--jq')
    expect(joined).toContain('nameWithOwner')
    expect(joined).toContain('defaultBranchRef')
  })

  it('includes organization and collaborator repositories', async () => {
    const { client, run } = clientReturning(REPO_LIST)
    await client.listRepositories()

    // Without `affiliation` the endpoint defaults to owned repositories only,
    // which would keep hiding the org and collaborator ones.
    const args = run.mock.calls[0]?.[0] as unknown as string[]
    expect(args.join(' ')).toContain('affiliation=owner,collaborator,organization_member')
  })

  it('keeps only repositories the user can write to', async () => {
    const { client, run } = clientReturning(REPO_LIST)
    await client.listRepositories()

    // The filtering happens inside gh's jq, so this asserts the expression is
    // there: a session's agent must push branches and open pull requests.
    const args = run.mock.calls[0]?.[0] as unknown as string[]
    const jq = args[args.indexOf('--jq') + 1] ?? ''
    expect(jq).toContain('select')
    expect(jq).toContain('permissions.push')
  })

  it('parses the repositories', async () => {
    const { client } = clientReturning(REPO_LIST)
    const repos = await client.listRepositories()

    expect(repos).toHaveLength(2)
    expect(repos[0]).toMatchObject({ nameWithOwner: 'diego/dukebox', isPrivate: true })
  })

  it('honours the limit it is given', async () => {
    const { client, run } = clientReturning('[]')
    await client.listRepositories(25)

    const args = run.mock.calls[0]?.[0] as unknown as string[]
    expect(args.join(' ')).toContain('per_page=25')
  })

  it('handles a repository with no default branch', async () => {
    // An empty repository has none, and it should not break the list.
    const { client } = clientReturning(
      JSON.stringify([
        {
          nameWithOwner: 'diego/empty',
          defaultBranchRef: null,
          isPrivate: false,
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ]),
    )

    const repos = await client.listRepositories()
    expect(repos[0]?.defaultBranchRef).toBeNull()
  })

  it('rejects output that is not JSON', async () => {
    const { client } = clientReturning('command not found')
    await expect(client.listRepositories()).rejects.toThrow('not JSON')
  })

  it('rejects JSON of an unexpected shape', async () => {
    const { client } = clientReturning(JSON.stringify([{ unexpected: true }]))
    await expect(client.listRepositories()).rejects.toThrow('unexpected gh output')
  })
})

describe('listBranches', () => {
  it('returns branch names', async () => {
    const { client } = clientReturning(JSON.stringify([{ name: 'main' }, { name: 'develop' }]))
    expect(await client.listBranches('diego/dukebox')).toEqual(['main', 'develop'])
  })

  it('asks about the repository it was given', async () => {
    const { client, run } = clientReturning('[]')
    await client.listBranches('diego/dukebox')

    const args = run.mock.calls[0]?.[0] as unknown as string[]
    expect(args.join(' ')).toContain('repos/diego/dukebox/branches')
  })
})

describe('defaultBranch', () => {
  it('returns the default branch name', async () => {
    const { client } = clientReturning(JSON.stringify({ name: 'main' }))
    expect(await client.defaultBranch('diego/dukebox')).toBe('main')
  })
})

describe('createPullRequest', () => {
  const options = {
    repoFullName: 'diego/dukebox',
    head: 'duke/3f9a2b1c',
    base: 'main',
    title: 'Add a multiply function',
  }

  it('returns the pull request URL', async () => {
    const { client } = clientReturning('https://github.com/diego/dukebox/pull/42\n')
    expect(await client.createPullRequest(options)).toBe('https://github.com/diego/dukebox/pull/42')
  })

  it('reads the URL from the last line, ignoring progress output', async () => {
    const { client } = clientReturning(
      'Warning: 3 uncommitted changes\nhttps://github.com/diego/dukebox/pull/42\n',
    )

    expect(await client.createPullRequest(options)).toContain('/pull/42')
  })

  it('always passes a body, so gh never opens an editor', async () => {
    const { client, run } = clientReturning('https://github.com/diego/dukebox/pull/1')
    await client.createPullRequest(options)

    // Without --body, gh opens an editor and waits forever on a headless
    // server — the session would hang with no indication why.
    const args = run.mock.calls[0]?.[0] as unknown as string[]
    expect(args).toContain('--body')
  })

  it('targets the session branch and the base branch', async () => {
    const { client, run } = clientReturning('https://github.com/diego/dukebox/pull/1')
    await client.createPullRequest(options)

    const args = run.mock.calls[0]?.[0] as unknown as string[]
    expect(args[args.indexOf('--head') + 1]).toBe('duke/3f9a2b1c')
    expect(args[args.indexOf('--base') + 1]).toBe('main')
    expect(args[args.indexOf('--repo') + 1]).toBe('diego/dukebox')
  })

  it('can open a draft', async () => {
    const { client, run } = clientReturning('https://github.com/diego/dukebox/pull/1')
    await client.createPullRequest({ ...options, draft: true })

    expect(run.mock.calls[0]?.[0] as unknown as string[]).toContain('--draft')
  })

  it('is a draft by default', async () => {
    const { client, run } = clientReturning('https://github.com/diego/dukebox/pull/1')
    await client.createPullRequest(options)

    expect(run.mock.calls[0]?.[0] as unknown as string[]).toContain('--draft')
  })

  it('can open a ready pull request', async () => {
    const { client, run } = clientReturning('https://github.com/diego/dukebox/pull/1')
    await client.createPullRequest({ ...options, draft: false })

    expect(run.mock.calls[0]?.[0] as unknown as string[]).not.toContain('--draft')
  })

  it('fails loudly when the output holds no URL', async () => {
    // Better than returning a plausible-looking empty string that the UI would
    // then present as a link.
    const { client } = clientReturning('something went wrong')
    await expect(client.createPullRequest(options)).rejects.toThrow('could not read')
  })
})

describe('findPullRequest', () => {
  it('returns an open pull request for the branch', async () => {
    const { client } = clientReturning(
      JSON.stringify([
        {
          url: 'https://github.com/diego/dukebox/pull/42',
          title: 'Add a health check',
          body: 'Adds /health.',
          isDraft: true,
          state: 'OPEN',
          mergeable: 'MERGEABLE',
        },
      ]),
    )

    expect(await client.findPullRequest('diego/dukebox', 'duke/abc')).toMatchObject({
      url: 'https://github.com/diego/dukebox/pull/42',
      title: 'Add a health check',
      isDraft: true,
      state: 'open',
    })
  })

  it('returns null when there is none', async () => {
    const { client } = clientReturning('[]')
    expect(await client.findPullRequest('diego/dukebox', 'duke/abc')).toBeNull()
  })

  it('looks at every state so a merged PR is still found', async () => {
    const { client, run } = clientReturning('[]')
    await client.findPullRequest('diego/dukebox', 'duke/abc')

    const args = run.mock.calls[0]?.[0] as unknown as string[]
    expect(args[args.indexOf('--state') + 1]).toBe('all')
  })
})

describe('viewPullRequest', () => {
  it('asks gh for one pull request by URL, including mergeable', async () => {
    const { client, run } = clientReturning(
      JSON.stringify({
        url: 'https://github.com/diego/dukebox/pull/42',
        title: 'Add a health check',
        body: 'Adds /health.',
        isDraft: false,
        state: 'OPEN',
        mergeable: 'CONFLICTING',
      }),
    )

    expect(
      await client.viewPullRequest('diego/dukebox', 'https://github.com/diego/dukebox/pull/42'),
    ).toMatchObject({
      url: 'https://github.com/diego/dukebox/pull/42',
      state: 'open',
      mergeable: 'CONFLICTING',
    })

    const args = run.mock.calls[0]?.[0] as unknown as string[]
    expect(args.slice(0, 2)).toEqual(['pr', 'view'])
    expect(args).toContain('--json')
    expect(args[args.indexOf('--json') + 1]).toContain('mergeable')
    expect(args[args.indexOf('--json') + 1]).toContain('statusCheckRollup')
    expect(args[args.indexOf('--json') + 1]).toContain('reviewDecision')
    expect(args[args.indexOf('--json') + 1]).toContain('commits')
    expect(args[args.indexOf('--json') + 1]).toContain('reviews')
    expect(args[args.indexOf('--json') + 1]).toContain('mergeStateStatus')
  })

  it('maps a failing check rollup', async () => {
    const { client } = clientReturning(
      JSON.stringify({
        url: 'https://github.com/diego/dukebox/pull/42',
        title: 'Add a health check',
        body: '',
        isDraft: false,
        state: 'OPEN',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [{ name: 'ci', state: 'FAILURE', detailsUrl: 'https://ci.example/1' }],
        reviewDecision: 'REVIEW_REQUIRED',
      }),
    )

    expect(
      await client.viewPullRequest('diego/dukebox', 'https://github.com/diego/dukebox/pull/42'),
    ).toMatchObject({
      checks: 'failing',
      reviewDecision: 'REVIEW_REQUIRED',
      checkRuns: [{ name: 'ci', state: 'failing', url: 'https://ci.example/1' }],
    })
  })

  it('treats a blocked merge with an empty rollup as pending', async () => {
    const { client } = clientReturning(
      JSON.stringify({
        url: 'https://github.com/diego/dukebox/pull/42',
        title: 'Add a health check',
        body: '',
        isDraft: false,
        state: 'OPEN',
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'BLOCKED',
        statusCheckRollup: [],
      }),
    )

    expect(
      await client.viewPullRequest('diego/dukebox', 'https://github.com/diego/dukebox/pull/42'),
    ).toMatchObject({
      checks: 'pending',
      mergeStateStatus: 'BLOCKED',
      checkRuns: [],
    })
  })

  it('maps commits and reviews', async () => {
    const { client } = clientReturning(
      JSON.stringify({
        url: 'https://github.com/diego/dukebox/pull/42',
        title: 'Add a health check',
        body: 'Adds /health.',
        isDraft: false,
        state: 'OPEN',
        mergeable: 'MERGEABLE',
        commits: [
          {
            oid: 'abc123def456',
            messageHeadline: 'Add a health check',
            authors: [{ login: 'diego' }],
          },
        ],
        reviews: [
          {
            author: { login: 'reviewer' },
            state: 'APPROVED',
            body: 'Looks good.',
            submittedAt: '2026-08-14T12:00:00Z',
          },
        ],
      }),
    )

    expect(
      await client.viewPullRequest('diego/dukebox', 'https://github.com/diego/dukebox/pull/42'),
    ).toMatchObject({
      commits: [{ sha: 'abc123def456', title: 'Add a health check', author: 'diego' }],
      reviews: [
        {
          author: 'reviewer',
          state: 'APPROVED',
          body: 'Looks good.',
          submittedAt: '2026-08-14T12:00:00Z',
        },
      ],
    })
  })

  it('treats an empty reviewDecision the way gh emits it as none', async () => {
    const { client } = clientReturning(
      JSON.stringify({
        url: 'https://github.com/diego/dukebox/pull/122',
        title: 'Align Dukebox PR preview with GitHub change set',
        body: '## Summary\n\nLine-change detection.',
        isDraft: true,
        state: 'OPEN',
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        reviewDecision: '',
        statusCheckRollup: [
          {
            __typename: 'CheckRun',
            conclusion: 'SUCCESS',
            detailsUrl: 'https://github.com/diego/dukebox/actions/runs/1',
            name: 'Verify',
            status: 'COMPLETED',
            workflowName: 'CI',
          },
        ],
        commits: [
          {
            oid: '2ea88a2ea7b661f9d3ee2b4850f81bda9c12fed2',
            messageHeadline: 'Align Dukebox pull request preview with GitHub change set',
            authors: [{ login: 'diegodev18', name: 'Diego Sanchez' }],
          },
        ],
        reviews: [],
      }),
    )

    await expect(
      client.viewPullRequest('diego/dukebox', 'https://github.com/diego/dukebox/pull/122'),
    ).resolves.toMatchObject({
      body: '## Summary\n\nLine-change detection.',
      reviewDecision: null,
      checks: 'passing',
      checkRuns: [{ name: 'Verify', state: 'passing' }],
      commits: [
        {
          sha: '2ea88a2ea7b661f9d3ee2b4850f81bda9c12fed2',
          title: 'Align Dukebox pull request preview with GitHub change set',
          author: 'diegodev18',
        },
      ],
      reviews: [],
    })
  })
})

describe('markReady', () => {
  it('asks gh to mark the pull request ready', async () => {
    const { client, run } = clientReturning('')
    await client.markReady('diego/dukebox', 'https://github.com/diego/dukebox/pull/1')

    const args = run.mock.calls[0]?.[0] as unknown as string[]
    expect(args.slice(0, 2)).toEqual(['pr', 'ready'])
    expect(args).toContain('https://github.com/diego/dukebox/pull/1')
  })
})

describe('mergePullRequest', () => {
  it('squashes by default of the caller', async () => {
    const { client, run } = clientReturning('')
    await client.mergePullRequest({
      repoFullName: 'diego/dukebox',
      url: 'https://github.com/diego/dukebox/pull/1',
      method: 'squash',
      deleteBranch: true,
    })

    const args = run.mock.calls[0]?.[0] as unknown as string[]
    expect(args).toContain('--squash')
    expect(args).toContain('--delete-branch')
  })
})

describe('editPullRequest', () => {
  it('passes a new title and body', async () => {
    const { client, run } = clientReturning('')
    await client.editPullRequest({
      repoFullName: 'diego/dukebox',
      url: 'https://github.com/diego/dukebox/pull/1',
      title: 'New title',
      body: 'New body',
    })

    const args = run.mock.calls[0]?.[0] as unknown as string[]
    expect(args.slice(0, 2)).toEqual(['pr', 'edit'])
    expect(args[args.indexOf('--title') + 1]).toBe('New title')
    expect(args[args.indexOf('--body') + 1]).toBe('New body')
  })
})

describe('pullRequestFailureMessage', () => {
  it('does not forward gh stderr', () => {
    expect(pullRequestFailureMessage(new GitHubError('gh pr failed: is still a draft'))).toBe(
      'this pull request is still a draft',
    )
    expect(
      pullRequestFailureMessage(new GitHubError('gh pr failed: Pull request is already merged')),
    ).toBe('this pull request is no longer open')
    expect(
      pullRequestFailureMessage(
        new GitHubError('gh pr failed: required status checks have not completed'),
      ),
    ).toBe('GitHub status checks are still running')
    expect(
      pullRequestFailureMessage(
        new GitHubError('gh pr failed: required status checks have failed'),
      ),
    ).toBe('GitHub status checks have not passed')
    expect(
      pullRequestFailureMessage(new GitHubError('gh pr failed: at least 1 approving review')),
    ).toBe('this pull request still needs a review')
    expect(
      pullRequestFailureMessage(new GitHubError('gh pr failed: changes requested by a reviewer')),
    ).toBe('changes were requested on this pull request')
    expect(pullRequestFailureMessage(new GitHubError('gh pr failed: protected branch rules'))).toBe(
      'the branch is protected and this merge is not allowed',
    )
    expect(pullRequestFailureMessage(new GitHubError('gh pr failed: not allowed to merge'))).toBe(
      'you do not have permission to merge this pull request',
    )
    expect(
      pullRequestFailureMessage(new GitHubError('gh pr failed: explosion in /tmp/secret')),
    ).toBe('the pull request action failed')
  })
})

describe('failure reporting', () => {
  it('explains a missing gh with an install link', async () => {
    const client = new GitHubClient({
      binary: '/nonexistent/gh',
      // Uses the real executor, so this exercises the ENOENT path.
    })

    await expect(client.token()).rejects.toMatchObject({
      message: expect.stringContaining('not found'),
      remedy: expect.stringContaining('cli.github.com'),
    })
  })

  it('explains an unauthenticated gh with the command to fix it', async () => {
    const client = new GitHubClient({
      run: async () => {
        const error = new Error('gh: To get started with GitHub CLI, please run: gh auth login')
        throw Object.assign(error, { stderr: error.message })
      },
    })

    await expect(client.listRepositories()).rejects.toThrow()
  })
})
