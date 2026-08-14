import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'

const exec = promisify(execFile)

/**
 * GitHub, through the `gh` CLI on the host.
 *
 * Every API call happens here, in the control plane — never inside a session
 * container. The agent's only reach into GitHub is git itself, authenticated
 * through the credential proxy and scoped to one repository. That keeps the
 * blast radius of a compromised agent to the repository it was given, rather
 * than every repository the user owns.
 *
 * `gh` rather than raw HTTP because the user has already authenticated it, and
 * asking them to create a GitHub App for a self-hosted tool is friction that
 * would stop most people at the install step.
 */

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly remedy?: string,
  ) {
    super(message)
    this.name = 'GitHubError'
  }
}

/**
 * A short reason the app can show. `gh` stderr stays on the server log.
 *
 * Callers still inspect `GitHubError.message` when they need the raw text
 * (conflict detection); this is only for the JSON body that reaches the desktop.
 */
export function pullRequestFailureMessage(error: GitHubError): string {
  const raw = error.message
  if (/draft/i.test(raw)) return 'this pull request is still a draft'
  if (/already merged|is closed|not open/i.test(raw)) {
    return 'this pull request is no longer open'
  }
  if (/required status|status check/i.test(raw)) {
    if (/pending|in progress|not complet/i.test(raw)) {
      return 'GitHub status checks are still running'
    }
    return 'GitHub status checks have not passed'
  }
  if (/changes requested/i.test(raw)) {
    return 'changes were requested on this pull request'
  }
  if (/review/i.test(raw)) return 'this pull request still needs a review'
  if (/protected branch/i.test(raw)) {
    return 'the branch is protected and this merge is not allowed'
  }
  if (/not allowed to merge|permission/i.test(raw)) {
    return 'you do not have permission to merge this pull request'
  }
  return 'the pull request action failed'
}

const repository = z.object({
  nameWithOwner: z.string(),
  defaultBranchRef: z.object({ name: z.string() }).nullable(),
  isPrivate: z.boolean(),
  updatedAt: z.string(),
})

export type Repository = z.infer<typeof repository>

const branch = z.object({ name: z.string() })

const checkRollupEntry = z
  .object({
    name: z.string().optional(),
    context: z.string().optional(),
    state: z.string().optional(),
    conclusion: z.string().optional(),
    status: z.string().optional(),
    detailsUrl: z.string().nullish(),
    targetUrl: z.string().nullish(),
  })
  .passthrough()

const pullRequestCommitEntry = z
  .object({
    oid: z.string().optional(),
    messageHeadline: z.string().optional(),
    authors: z
      .array(z.object({ login: z.string().optional(), name: z.string().optional() }).passthrough())
      .nullish(),
  })
  .passthrough()

const pullRequestReviewEntry = z
  .object({
    author: z.object({ login: z.string().optional() }).passthrough().nullish(),
    state: z.string().optional(),
    body: z.string().nullish(),
    submittedAt: z.string().nullish(),
  })
  .passthrough()

const mergeStateStatus = z.enum([
  'BEHIND',
  'BLOCKED',
  'CLEAN',
  'DIRTY',
  'DRAFT',
  'HAS_HOOKS',
  'UNKNOWN',
  'UNSTABLE',
])

/** `gh --json` emits `""` for unset GraphQL enums instead of null. */
const emptyAsNull = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === '' ? null : value), schema)

const pullRequestView = z.object({
  url: z.string(),
  title: z.string(),
  body: z.string().nullish().default(''),
  isDraft: z.boolean(),
  state: z.enum(['OPEN', 'MERGED', 'CLOSED', 'open', 'merged', 'closed']),
  mergeable: emptyAsNull(z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']).nullish()),
  statusCheckRollup: z.array(checkRollupEntry).nullish(),
  reviewDecision: emptyAsNull(
    z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']).nullish(),
  ),
  mergeStateStatus: emptyAsNull(mergeStateStatus.nullish()),
  commits: z.array(pullRequestCommitEntry).nullish(),
  reviews: z.array(pullRequestReviewEntry).nullish(),
})

export type PullRequestCheckRun = {
  name: string
  state: 'pending' | 'passing' | 'failing' | 'neutral'
  url?: string
}

export type PullRequestCommit = {
  sha: string
  title: string
  author?: string
}

export type PullRequestReview = {
  author: string
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING'
  body?: string
  submittedAt?: string
}

export type PullRequestView = {
  url: string
  title: string
  body: string
  isDraft: boolean
  state: 'open' | 'merged' | 'closed'
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null
  checks: 'passing' | 'pending' | 'failing' | 'none'
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  mergeStateStatus: z.infer<typeof mergeStateStatus> | null
  commits: PullRequestCommit[]
  checkRuns: PullRequestCheckRun[]
  reviews: PullRequestReview[]
}

const PR_VIEW_JSON =
  'url,title,body,isDraft,state,mergeable,statusCheckRollup,reviewDecision,commits,reviews,mergeStateStatus'

const FAILING_TOKENS = new Set(['FAILURE', 'ERROR', 'FAILING', 'TIMED_OUT', 'STARTUP_FAILURE'])
const PENDING_TOKENS = new Set(['PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED', 'WAITING'])
const PASSING_TOKENS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED', 'COMPLETED'])

export function checkRunStateFromEntry(entry: {
  state?: string
  conclusion?: string
  status?: string
}): PullRequestCheckRun['state'] {
  const tokens = [entry.conclusion, entry.state, entry.status]
    .filter((token): token is string => Boolean(token))
    .map((token) => token.toUpperCase())
  if (tokens.some((token) => FAILING_TOKENS.has(token))) return 'failing'
  if (tokens.some((token) => PENDING_TOKENS.has(token))) return 'pending'
  if (tokens.some((token) => token === 'NEUTRAL' || token === 'SKIPPED' || token === 'CANCELLED')) {
    return 'neutral'
  }
  if (tokens.some((token) => PASSING_TOKENS.has(token))) return 'passing'
  return 'pending'
}

export function checksFromRollup(rollup: unknown): PullRequestView['checks'] {
  const runs = checkRunsFromRollup(rollup)
  if (runs.length === 0) return 'none'
  if (runs.some((run) => run.state === 'failing')) return 'failing'
  if (runs.some((run) => run.state === 'pending')) return 'pending'
  return 'passing'
}

export function checkRunsFromRollup(rollup: unknown): PullRequestCheckRun[] {
  if (!Array.isArray(rollup)) return []
  return rollup.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const row = entry as {
      name?: string
      context?: string
      state?: string
      conclusion?: string
      status?: string
      detailsUrl?: string | null
      targetUrl?: string | null
    }
    const name = row.name || row.context
    if (!name) return []
    const url = row.detailsUrl || row.targetUrl
    return [
      {
        name,
        state: checkRunStateFromEntry(row),
        ...(url ? { url } : {}),
      },
    ]
  })
}

function commitsFromGh(raw: unknown): PullRequestCommit[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const row = entry as {
      oid?: string
      messageHeadline?: string
      authors?: { login?: string; name?: string }[] | null
    }
    if (!row.oid) return []
    const author = row.authors?.find((person) => person.login || person.name)
    return [
      {
        sha: row.oid,
        title: row.messageHeadline ?? '',
        ...(author?.login || author?.name ? { author: author.login || author.name } : {}),
      },
    ]
  })
}

const REVIEW_STATES = new Set([
  'APPROVED',
  'CHANGES_REQUESTED',
  'COMMENTED',
  'DISMISSED',
  'PENDING',
])

function reviewsFromGh(raw: unknown): PullRequestReview[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const row = entry as {
      author?: { login?: string } | null
      state?: string
      body?: string | null
      submittedAt?: string | null
    }
    const state = (row.state ?? 'COMMENTED').toUpperCase()
    if (!REVIEW_STATES.has(state)) return []
    return [
      {
        author: row.author?.login || 'unknown',
        state: state as PullRequestReview['state'],
        ...(row.body ? { body: row.body } : {}),
        ...(row.submittedAt ? { submittedAt: row.submittedAt } : {}),
      },
    ]
  })
}

function toPullRequestView(raw: {
  url: string
  title: string
  body?: string | null
  isDraft: boolean
  state: string
  mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null
  statusCheckRollup?: unknown
  reviewDecision?: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  mergeStateStatus?: PullRequestView['mergeStateStatus'] | null
  commits?: unknown
  reviews?: unknown
}): PullRequestView {
  const state = raw.state.toLowerCase()
  const checkRuns = checkRunsFromRollup(raw.statusCheckRollup)
  let checks = checksFromRollup(raw.statusCheckRollup)
  if (
    checks === 'none' &&
    (raw.mergeStateStatus === 'BLOCKED' || raw.mergeStateStatus === 'UNSTABLE')
  ) {
    checks = 'pending'
  }
  return {
    url: raw.url,
    title: raw.title,
    body: raw.body ?? '',
    isDraft: raw.isDraft,
    state: state === 'merged' || state === 'closed' ? state : 'open',
    mergeable: raw.mergeable ?? null,
    checks,
    reviewDecision: raw.reviewDecision ?? null,
    mergeStateStatus: raw.mergeStateStatus ?? null,
    commits: commitsFromGh(raw.commits),
    checkRuns,
    reviews: reviewsFromGh(raw.reviews),
  }
}

export interface GitHubClientOptions {
  /** Path to the CLI. Overridable for tests and unusual installs. */
  binary?: string
  /** Injectable so tests never shell out. */
  run?: (args: string[]) => Promise<string>
}

export class GitHubClient {
  private readonly binary: string
  private readonly run: (args: string[]) => Promise<string>

  constructor(options: GitHubClientOptions = {}) {
    this.binary = options.binary ?? 'gh'
    this.run = options.run ?? ((args) => this.execute(args))
  }

  private async execute(args: string[]): Promise<string> {
    try {
      const { stdout } = await exec(this.binary, args, {
        // A repository list can exceed the default buffer.
        maxBuffer: 10 * 1024 * 1024,
      })
      return stdout
    } catch (error) {
      const failure = error as { code?: string; stderr?: string; message?: string }

      if (failure.code === 'ENOENT') {
        throw new GitHubError(
          'the gh command was not found',
          'Install the GitHub CLI: https://cli.github.com',
        )
      }

      const stderr = failure.stderr ?? failure.message ?? 'unknown error'

      // The one failure an operator can always fix themselves, and the one
      // they hit first after a fresh install.
      if (/not logged|authentication|gh auth login/i.test(stderr)) {
        throw new GitHubError('gh is not authenticated', 'Run: gh auth login')
      }

      throw new GitHubError(`gh ${args[0] ?? ''} failed: ${stderr.trim()}`)
    }
  }

  private async json<T>(args: string[], schema: z.ZodType<T>): Promise<T> {
    const raw = await this.run(args)

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new GitHubError(`gh ${args[0] ?? ''} returned output that is not JSON`)
    }

    const result = schema.safeParse(parsed)
    if (!result.success) {
      throw new GitHubError(`unexpected gh output: ${result.error.message}`)
    }

    return result.data
  }

  /**
   * The token `gh` holds.
   *
   * Read on demand by the credential proxy rather than cached, so it is never
   * held longer than an in-flight request and a re-login takes effect at once.
   */
  async token(): Promise<string> {
    const token = (await this.run(['auth', 'token'])).trim()
    if (!token) throw new GitHubError('gh returned an empty token', 'Run: gh auth login')
    return token
  }

  /** Whether `gh` is installed and signed in. Used by preflight checks. */
  async isAuthenticated(): Promise<boolean> {
    try {
      await this.run(['auth', 'status'])
      return true
    } catch {
      return false
    }
  }

  /** The signed-in account. */
  async currentUser(): Promise<string> {
    const user = await this.json(
      ['api', 'user', '--jq', '{login: .login}'],
      z.object({ login: z.string() }),
    )
    return user.login
  }

  /**
   * Repositories the user can push to — owned, a collaborator, or through an
   * organization — most recently updated first.
   *
   * `gh repo list` only returns repositories the user owns, which hides
   * organization repositories and repositories where they are a collaborator.
   * `GET /user/repos` returns every repository the user has access to; the
   * `affiliation` query picks the owned, collaborator, and organization-member
   * sets, and the jq filter keeps only those the user can actually write to
   * (a session's agent must push branches and open pull requests).
   */
  async listRepositories(limit = 100): Promise<Repository[]> {
    return this.json(
      [
        'api',
        `user/repos?per_page=${limit}&sort=updated&direction=desc&affiliation=owner,collaborator,organization_member`,
        '--jq',
        '[.[] | select((.permissions.push // false) or (.permissions.admin // false)) | {nameWithOwner: .full_name, defaultBranchRef: (if .default_branch then {name: .default_branch} else null end), isPrivate: .private, updatedAt: .updated_at}]',
      ],
      z.array(repository),
    )
  }

  /** Branch names in a repository. */
  async listBranches(repoFullName: string, limit = 100): Promise<string[]> {
    const branches = await this.json(
      ['api', `repos/${repoFullName}/branches?per_page=${limit}`, '--jq', '[.[] | {name}]'],
      z.array(branch),
    )

    return branches.map((entry) => entry.name)
  }

  /** A repository's default branch, which is the base for new sessions. */
  async defaultBranch(repoFullName: string): Promise<string> {
    const repo = await this.json(
      ['api', `repos/${repoFullName}`, '--jq', '{name: .default_branch}'],
      z.object({ name: z.string() }),
    )

    return repo.name
  }

  /**
   * Open a pull request and return its URL.
   *
   * Draft by default: the agent is still working, and a ready PR would invite
   * review of unfinished work. Pass `draft: false` when the caller has already
   * decided it is ready.
   */
  async createPullRequest(options: {
    repoFullName: string
    head: string
    base: string
    title: string
    body?: string
    draft?: boolean
  }): Promise<string> {
    const args = [
      'pr',
      'create',
      '--repo',
      options.repoFullName,
      '--head',
      options.head,
      '--base',
      options.base,
      '--title',
      options.title,
      // Always passed, even when empty: without it `gh` opens an editor and
      // waits forever on a headless server.
      '--body',
      options.body ?? '',
    ]

    if (options.draft !== false) args.push('--draft')

    const output = (await this.run(args)).trim()

    // `gh pr create` prints the URL as its last line.
    const url = output.split('\n').filter(Boolean).at(-1) ?? ''
    if (!url.startsWith('https://')) {
      throw new GitHubError(`could not read the pull request URL from: ${output}`)
    }

    return url
  }

  /** An open or recently closed pull request for a branch, or null. */
  async findPullRequest(repoFullName: string, head: string): Promise<PullRequestView | null> {
    const results = await this.json(
      [
        'pr',
        'list',
        '--repo',
        repoFullName,
        '--head',
        head,
        '--json',
        PR_VIEW_JSON,
        '--state',
        'all',
        '--limit',
        '1',
      ],
      z.array(pullRequestView),
    )

    const first = results[0]
    return first ? toPullRequestView(first as Parameters<typeof toPullRequestView>[0]) : null
  }

  /** One pull request, identified by URL. */
  async viewPullRequest(repoFullName: string, url: string): Promise<PullRequestView> {
    const raw = await this.json(
      ['pr', 'view', url, '--repo', repoFullName, '--json', PR_VIEW_JSON],
      pullRequestView,
    )

    return toPullRequestView(raw as Parameters<typeof toPullRequestView>[0])
  }

  /** Mark a draft pull request ready for review. */
  async markReady(repoFullName: string, url: string): Promise<void> {
    await this.run(['pr', 'ready', url, '--repo', repoFullName])
  }

  /** Merge a pull request. */
  async mergePullRequest(options: {
    repoFullName: string
    url: string
    method: 'squash' | 'merge' | 'rebase'
    deleteBranch?: boolean
  }): Promise<void> {
    const args = ['pr', 'merge', options.url, '--repo', options.repoFullName, `--${options.method}`]
    if (options.deleteBranch) args.push('--delete-branch')
    await this.run(args)
  }

  /** Update a pull request's title or body. */
  async editPullRequest(options: {
    repoFullName: string
    url: string
    title?: string
    body?: string
  }): Promise<void> {
    const args = ['pr', 'edit', options.url, '--repo', options.repoFullName]
    if (options.title !== undefined) args.push('--title', options.title)
    if (options.body !== undefined) args.push('--body', options.body)
    await this.run(args)
  }
}
