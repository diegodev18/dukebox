import {
  ClaudeCodeAdapter,
  grokBuildContainerEnv,
  GrokBuildAdapter,
  OpenCodeAdapter,
  type AgentAdapter,
} from '@dukebox/adapters'
import { environments, projects, sessions, type Database, type Session } from '@dukebox/db'
import {
  DEFAULT_COMMIT_IDENTITY,
  defaultProjectConfig,
  ENVIRONMENT_PROPOSAL_PATH,
  isTerminal,
  mergeProjectConfig,
  MERGED_SESSION_AGENT_NOTICE,
  parseGitPreferences,
  pullRequestMergeBlock,
  parseSecretReference,
  pullRequestState,
  reuseExistingPullRequest,
  sessionOpensPullRequests,
  projectConfig,
  resolveEnvironment,
  type CommitIdentity,
  type GitPreferences,
  type MergeMethod,
  type ProjectConfig,
  type PullRequestDetails,
  type PullRequestSummary,
  type SessionPurpose,
  type SessionStatus,
  type PermissionMode,
  DEFAULT_PERMISSION_MODE,
  resolvePermissionMode,
  ENVIRONMENT_SETUP_IMAGE_MISMATCH,
  type EnvironmentProposal,
  type EnvironmentSetupVerification,
  type EnvelopedEvent,
  partitionAttachments,
  promptAttachmentsFrom,
} from '@dukebox/protocol'
import {
  CONTAINER_SOCKET_DIR,
  CONTAINER_SOCKET_PATH,
  createSessionCredentialProxy,
  Sandbox,
  Workspace,
  WorkspaceError,
  resolveWorkspacePath,
  type CredentialProxy,
  type SessionContainer,
  type TerminalHandle,
  type WorkspaceFile,
} from '@dukebox/sandbox'
import { and, eq, inArray } from 'drizzle-orm'
import { rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { join } from 'node:path'
import type { EventBus } from '@/events/bus'
import { GitHubError, pullRequestFailureMessage, type GitHubClient } from '@/github/client'
import { buildOpencodeSessionEnv, loadOpencodeProviders } from '@/opencode/providers'
import {
  AGENT_CREDENTIAL_SECRET,
  GROK_AUTH_SECRET,
  GROK_CREDENTIAL_SECRET,
  type SecretStore,
} from '@/secrets/store'
import {
  ENVIRONMENT_SETUP_PROMPT,
  MAX_ENVIRONMENT_SETUP_VERIFY_RETRIES,
  environmentSetupVerifyRetryPrompt,
  parseEnvironmentProposalJson,
} from '@/sessions/environmentSetup'
import { grokAuthHooks } from '@/grok/session-auth'
import { writePullRequestContent } from '@/sessions/pr-writer'
import { dukeboxOwnsPullRequestBody } from '@/sessions/summary'
import { pullRequestRecordUnchanged, toSummary } from '@/sessions/summarize'
import { titleFromPrompt, writeSessionTitle } from '@/sessions/title'

/**
 * Session lifecycle.
 *
 * Ties the pieces together: a container from the sandbox, a repository in it,
 * an agent adapter driving it, and every event the agent produces appended to
 * the session log.
 *
 * Sessions outlive the app that started them. The desktop client can close at
 * any point and the work continues here.
 */

export interface SessionManagerDeps {
  db: Database
  bus: EventBus
  sandbox: Sandbox
  /** Clone URL for a repository. Credentials come from the credential proxy. */
  cloneUrl: (repoFullName: string) => string
  /**
   * GitHub access, for pull requests and for the token the credential proxy
   * hands to git. Omitted in tests that clone from a local origin.
   */
  github?: GitHubClient
  /**
   * Directory for per-session credential sockets.
   *
   * Must be a path the Docker daemon can see, which on a VPS is any local
   * directory. Omitted to run without credential proxying at all.
   */
  credentialSocketDir?: string
  /**
   * Decrypted secrets for session containers.
   *
   * Supplies both the agent's own credentials and whatever a project needs to
   * run. Omitted in tests that drive a fake agent needing neither.
   */
  secrets?: SecretStore
  /** Overridable so tests can drive a fake agent. */
  createAdapter?: (agentId: string) => AgentAdapter
  /**
   * Called when a session stops, before its status is written.
   *
   * The terminal registry hangs off this rather than importing the manager: a
   * PTY belonging to a stopped container is dead weight, and the manager is the
   * only place that knows when that happened.
   */
  onSessionStopped?: (sessionId: string) => Promise<void>
}

export interface StartSessionOptions {
  projectId: string
  agentId: string
  baseBranch?: string
  /** Passed through to the adapter; absent means the agent's default. */
  model?: string
  /**
   * How the agent is allowed to act.
   *
   * Ignored by agents without permission modes. Absent means bypass for
   * Claude Code, OpenCode, and Grok Build. Ignored for environment_setup,
   * which always starts in bypass.
   */
  permissionMode?: PermissionMode
  purpose?: SessionPurpose
  /** Required for coding sessions; ignored for environment_setup. */
  prompt?: string
  /**
   * Which environment to run in.
   *
   * Absent means resolve from the base branch. Present means the caller chose,
   * and the choice is verified to belong to the project before it is used.
   */
  environmentId?: string
  /**
   * Who this session's commits are authored as.
   *
   * Absent means the server's default identity.
   */
  commitIdentity?: CommitIdentity
  /**
   * How this session commits, opens, and merges pull requests.
   *
   * Absent means the Cursor-like defaults (draft, auto-open, squash).
   */
  gitPreferences?: GitPreferences
  /**
   * Files to stage into the sandbox before the session's first prompt runs.
   *
   * `data` is a base64 data URI; the agent sees the decoded bytes at
   * `/tmp/imgs/<name>`.
   */
  files?: { name: string; data: string }[]
  /** The paired device that asked to start this session. */
  createdByDeviceId?: string
}

/** What a running session holds while it is alive. */
interface RunningSession {
  container: SessionContainer
  workspace: Workspace
  adapter: AgentAdapter
  /** HEAD before the agent ran, so diffs have a stable base. */
  baseCommit: string
  /** Serves git credentials to this session's container, if configured. */
  credentials?: CredentialProxy
  repoFullName: string
  purpose: SessionPurpose
  /**
   * How many times a failed setup verify has already been sent back to the
   * agent. Caps the environment_setup retry loop.
   */
  setupVerifyAttempts: number
  /** OpenCode `provider/model` this session is running, when known. */
  sessionModel?: string
}

export class SessionError extends Error {}

/** The pull request cannot merge until its conflicts are resolved. */
export class MergeConflictError extends SessionError {
  constructor(message = 'this pull request has conflicts with the base branch') {
    super(message)
    this.name = 'MergeConflictError'
  }
}

const MERGEABLE_POLL_ATTEMPTS = 3
const MERGEABLE_POLL_MS = 400

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Prompt the agent gets when a merge left conflict markers in the tree. */
function conflictResolutionPrompt(baseBranch: string, files: string[]): string {
  const list = files.map((path) => `- ${path}`).join('\n')
  return [
    `The pull request has merge conflicts with \`${baseBranch}\`. The base branch is already merged into this branch; conflict markers are in the working tree.`,
    '',
    'Conflicted files:',
    list,
    '',
    "Resolve every conflict. Keep the intended behavior of this session's changes. Then commit and push the branch. Do not merge the pull request.",
  ].join('\n')
}

/** Map a sandbox failure onto the error the HTTP layer already understands. */
function workspaceAsSessionError(error: unknown): SessionError {
  if (error instanceof WorkspaceError) return new SessionError(error.message)
  throw error
}

const SETUP_VERIFY_ERROR_LIMIT = 4000

/** Stderr from a failed verify, truncated so a follow-up prompt stays readable. */
function formatSetupVerifyError(error: unknown): string {
  const raw =
    error instanceof WorkspaceError
      ? error.stderr.trim() || error.message
      : error instanceof Error
        ? error.message
        : String(error)
  return raw.length > SETUP_VERIFY_ERROR_LIMIT
    ? `${raw.slice(0, SETUP_VERIFY_ERROR_LIMIT)}\n…`
    : raw
}

/** The adapter for an agent id, or a thrown error if none is registered. */
export function createAgentAdapter(agentId: string): AgentAdapter {
  if (agentId === 'claude-code') return new ClaudeCodeAdapter()
  if (agentId === 'opencode') return new OpenCodeAdapter()
  if (agentId === 'grok-build') return new GrokBuildAdapter()
  throw new SessionError(`no adapter for agent: ${agentId}`)
}

function grokAuthContext(
  agentId: string,
  secrets?: SecretStore,
): { grokAuth: ReturnType<typeof grokAuthHooks> } | Record<string, never> {
  if (agentId !== 'grok-build' || !secrets) return {}
  return { grokAuth: grokAuthHooks(secrets) }
}

function permissionModeContext(
  session: Session,
  override?: PermissionMode,
): { permissionMode: PermissionMode } | Record<string, never> {
  const candidate = override ?? session.permissionMode
  if (
    candidate === 'bypass' ||
    candidate === 'plan' ||
    candidate === 'auto' ||
    candidate === 'acceptEdits'
  ) {
    return { permissionMode: candidate }
  }

  if (
    session.agentId === 'claude-code' ||
    session.agentId === 'opencode' ||
    session.agentId === 'grok-build'
  ) {
    return { permissionMode: DEFAULT_PERMISSION_MODE }
  }
  return {}
}

/** Statuses that mean a turn was in flight when this process started. */
const IN_PROGRESS_STATUSES: SessionStatus[] = ['provisioning', 'running', 'waiting_input']

/**
 * What the agent is told after a control-plane restart.
 *
 * The in-flight process is gone; this is how the turn continues rather than
 * waiting for the user to send a dummy follow-up. Logged as a `user_prompt`
 * so every device sees why work resumed.
 */
export const RESTART_CONTINUATION_PROMPT =
  'The server restarted. Continue the previous task from where you left off. The workspace is unchanged.'

export class SessionManager {
  private readonly running = new Map<string, RunningSession>()

  /**
   * Resumes in flight, keyed by session, so two callers (a prompt and a
   * terminal open, say) share one restart rather than starting two agents.
   */
  private readonly resuming = new Map<string, Promise<RunningSession>>()

  constructor(private readonly deps: SessionManagerDeps) {}

  private createAdapter(agentId: string): AgentAdapter {
    if (this.deps.createAdapter) return this.deps.createAdapter(agentId)
    return createAgentAdapter(agentId)
  }

  private async setStatus(
    sessionId: string,
    status: SessionStatus,
    extra: Partial<Session> = {},
  ): Promise<void> {
    const [updated] = await this.deps.db
      .update(sessions)
      .set({ status, updatedAt: new Date(), ...extra })
      .where(eq(sessions.id, sessionId))
      .returning()

    // Announced from here because this is the one place a session's state
    // changes. A client that has to poll for this shows whatever was true when
    // it loaded, which for a running session is wrong within seconds.
    if (updated) await this.deps.bus.publishSessionUpdate(toSummary(updated))
  }

  private async persistPermissionMode(sessionId: string, mode: PermissionMode): Promise<void> {
    const [updated] = await this.deps.db
      .update(sessions)
      .set({ permissionMode: mode, updatedAt: new Date() })
      .where(eq(sessions.id, sessionId))
      .returning()

    if (updated) await this.deps.bus.publishSessionUpdate(toSummary(updated))
  }

  /**
   * Replace the heuristic title with one interpreted from the task.
   *
   * Failures are swallowed: a session that cannot be named still runs, and
   * the sidebar keeps the heuristic. Naming must not delay or fail start.
   */
  private async nameSession(
    sessionId: string,
    prompt: string,
    sessionModel?: string,
  ): Promise<void> {
    try {
      const title = await writeSessionTitle({
        prompt,
        ...(sessionModel ? { sessionModel } : {}),
        ...(this.deps.secrets ? { secrets: this.deps.secrets } : {}),
      })

      const [current] = await this.deps.db
        .select({ title: sessions.title })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
      if (!current || current.title === title) return

      const [updated] = await this.deps.db
        .update(sessions)
        .set({ title, updatedAt: new Date() })
        .where(eq(sessions.id, sessionId))
        .returning()

      if (updated) await this.deps.bus.publishSessionUpdate(toSummary(updated))
    } catch {
      // Naming is best-effort. The heuristic title already on the row stands.
    }
  }

  private async persistAgentSessionId(
    sessionId: string,
    agentSessionId: string | undefined,
  ): Promise<void> {
    if (!agentSessionId) return

    await this.deps.db
      .update(sessions)
      .set({ agentSessionId, updatedAt: new Date() })
      .where(eq(sessions.id, sessionId))
  }

  /**
   * Create a session and start its agent.
   *
   * Returns as soon as the row exists, before the container is ready.
   * Provisioning takes tens of seconds, and the client needs a session to
   * subscribe to so it can watch that happen rather than stare at a spinner.
   */
  async start(options: StartSessionOptions): Promise<Session> {
    const [project] = await this.deps.db
      .select()
      .from(projects)
      .where(eq(projects.id, options.projectId))

    if (!project) throw new SessionError(`no such project: ${options.projectId}`)

    const purpose: SessionPurpose = options.purpose ?? 'coding'
    const prompt =
      purpose === 'environment_setup' ? ENVIRONMENT_SETUP_PROMPT : (options.prompt?.trim() ?? '')

    if (purpose === 'coding' && !prompt) {
      throw new SessionError('prompt is required for coding sessions')
    }

    const baseBranch = options.baseBranch ?? project.defaultBranch
    const permissionMode = resolvePermissionMode(options.agentId, purpose, options.permissionMode)

    // Resolved once, here, and persisted on the row. A session resumed weeks
    // later must run in the environment it started with, even if patterns
    // changed or the list was reordered in the meantime.
    const environmentId = await this.resolveEnvironmentId(
      project.id,
      baseBranch,
      options.environmentId,
    )

    const [session] = await this.deps.db
      .insert(sessions)
      .values({
        projectId: project.id,
        agentId: options.agentId,
        status: 'provisioning',
        purpose,
        // Placeholder until the workspace names the branch; the row has to
        // exist first so the client has something to subscribe to.
        branch: '',
        baseBranch,
        environmentId,
        title: purpose === 'environment_setup' ? 'Configure environment' : titleFromPrompt(prompt),
        prompt,
        permissionMode,
        gitPreferences: parseGitPreferences(options.gitPreferences),
        createdByDeviceId: options.createdByDeviceId,
      })
      .returning()

    if (!session) throw new SessionError('failed to create session')

    // Naming is a short model call and must not delay the 202. The heuristic
    // title is already on the row; a better one arrives as a session_update.
    if (purpose !== 'environment_setup') {
      void this.nameSession(session.id, prompt, options.model)
    }

    // Recorded before provisioning starts, so a crash mid-clone still has the
    // text needed to retry, and the client sees the prompt while the workspace
    // is coming up rather than only after the agent is already running.
    const attachments = promptAttachmentsFrom(options.files)
    await this.deps.bus.append(session.id, {
      type: 'user_prompt',
      text: prompt,
      ...(attachments ? { attachments } : {}),
    })

    // Deliberately not awaited: provisioning is slow, and its progress reaches
    // the client as events rather than as a blocked request.
    void this.provision(
      session,
      project.repoFullName,
      prompt,
      options.model,
      options.commitIdentity,
      permissionMode ?? undefined,
      options.files,
    ).catch(async (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)

      await this.deps.bus
        .append(session.id, { type: 'error', message, fatal: true })
        .catch(() => undefined)
      await this.setStatus(session.id, 'failed', { errorMessage: message })
    })

    return session
  }

  private async provision(
    session: Session,
    repoFullName: string,
    prompt: string,
    model?: string,
    commitIdentity?: CommitIdentity,
    permissionMode?: PermissionMode,
    files?: { name: string; data: string }[],
  ): Promise<void> {
    // Started before the container so the socket exists to be mounted. It
    // answers only for this session's repository, so an agent that asks for
    // any other gets nothing.
    const credentials = await this.startCredentialProxy(session.id, repoFullName)

    try {
      await this.provisionWith(
        session,
        repoFullName,
        prompt,
        credentials,
        model,
        commitIdentity,
        permissionMode,
        files,
      )
    } catch (error) {
      // The session never reached `running`, so `stop` would not find it and
      // the socket would be left listening for a session that failed.
      await credentials?.stop().catch(() => undefined)
      throw error
    }
  }

  private async provisionWith(
    session: Session,
    repoFullName: string,
    prompt: string,
    credentials: CredentialProxy | undefined,
    model?: string,
    commitIdentity?: CommitIdentity,
    permissionMode?: PermissionMode,
    files?: { name: string; data: string }[],
  ): Promise<void> {
    const purpose = (session.purpose as SessionPurpose) || 'coding'
    const config = await this.configFor(session.environmentId)

    // Set on the container rather than only on setup commands: the agent
    // process needs its own credentials, and it is started later by exec.
    const environment = await this.environmentFor(
      config,
      session.projectId,
      session.agentId,
      purpose === 'coding' ? config.instructions : undefined,
    )

    const container = await this.deps.sandbox.create({
      sessionId: session.id,
      image: config.image,
      env: environment,
      // Cloning and installing dependencies both need the network.
      network: 'bridge',
      ...(credentials
        ? {
            mounts: [
              {
                source: this.socketDirFor(session.id),
                target: CONTAINER_SOCKET_DIR,
              },
            ],
          }
        : {}),
    })

    await this.deps.db
      .update(sessions)
      .set({ containerId: container.id })
      .where(eq(sessions.id, session.id))

    const workspace = new Workspace(container)

    // Must precede any git operation that reaches a remote.
    if (credentials) await workspace.installCredentialHelper()

    // Before anything can commit, so the agent's own commits carry it too
    // rather than only the ones Dukebox makes on its behalf.
    await workspace.setCommitIdentity(commitIdentity ?? DEFAULT_COMMIT_IDENTITY)

    const { branch } = await workspace.clone({
      url: this.deps.cloneUrl(repoFullName),
      baseBranch: session.baseBranch,
      sessionId: session.id,
    })

    await this.deps.db.update(sessions).set({ branch }).where(eq(sessions.id, session.id))

    // Environment-setup sessions must not run the project's setup: they exist
    // to propose it. Coding sessions run setup so the agent starts in a ready
    // workspace; a failed setup fails the session rather than starting half-baked.
    if (purpose === 'coding' && config.setup.length > 0) {
      await workspace.runSetup(config.setup, environment)
    }

    const baseCommit = await workspace.headCommit()

    // Persisted so a resume after a restart measures diffs against the same
    // commit rather than against the agent's own work.
    await this.deps.db.update(sessions).set({ baseCommit }).where(eq(sessions.id, session.id))

    const adapter = this.createAdapter(session.agentId)

    await adapter.start({
      sessionId: session.id,
      container,
      workingDir: '/workspace/repo',
      ...(config.instructions && purpose === 'coding' ? { instructions: config.instructions } : {}),
      ...(model ? { model } : {}),
      ...(session.agentSessionId ? { resumeFrom: session.agentSessionId } : {}),
      ...permissionModeContext(session, permissionMode),
      ...grokAuthContext(session.agentId, this.deps.secrets),
    })

    this.running.set(session.id, {
      container,
      workspace,
      adapter,
      baseCommit,
      repoFullName,
      purpose,
      setupVerifyAttempts: 0,
      ...(model ? { sessionModel: model } : {}),
      ...(credentials ? { credentials } : {}),
    })
    await this.setStatus(session.id, 'running')

    // Started before the first prompt so no early output is missed.
    void this.consume(session.id, adapter)

    // The prompt is already in the log — appended when the row was created,
    // so a crash mid-provision still has the text needed to retry.
    await adapter.send({
      text: prompt,
      ...partitionAttachments(files),
    })
  }

  /**
   * Forward an agent's events into the session log until it stops.
   *
   * Every event goes through the bus, which is what numbers it, stores it, and
   * fans it out. Nothing reaches a client another way.
   */
  private async consume(sessionId: string, adapter: AgentAdapter): Promise<void> {
    try {
      for await (const event of adapter.events()) {
        await this.deps.bus.append(sessionId, event)

        if (event.type === 'permission_mode') {
          await this.persistPermissionMode(sessionId, event.mode)
        }

        if (event.type === 'session_started') {
          // As soon as it is known, not at turn end: a crash mid-turn would
          // otherwise lose the id that `--resume` / `--session` needs.
          await this.persistAgentSessionId(sessionId, adapter.agentSessionId())
          const live = this.running.get(sessionId)
          if (live && event.model) live.sessionModel = event.model
        }

        if (event.type === 'done') {
          await this.onTurnEnd(sessionId, event.reason)
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.deps.bus
        .append(sessionId, { type: 'error', message, fatal: true })
        .catch(() => undefined)
      await this.setStatus(sessionId, 'failed', { errorMessage: message })
    }
  }

  /**
   * Emit the turn's diffs and park the session.
   *
   * Diffs are computed here rather than trusted from the agent's tool results:
   * an agent can change files by editing them, redirecting shell output, or
   * running a formatter, and only git sees all of it.
   */
  private async onTurnEnd(sessionId: string, reason: string): Promise<void> {
    const running = this.running.get(sessionId)
    if (!running) return

    try {
      const diffs = await running.workspace.diffEvents(running.baseCommit)
      for (const diff of diffs) {
        await this.deps.bus.append(sessionId, diff)
      }

      await this.deps.db
        .update(sessions)
        .set({ changedFileCount: diffs.length })
        .where(eq(sessions.id, sessionId))
    } catch {
      // A failed diff should not fail the turn: the agent's work still stands,
      // and the user can still see the conversation.
    }

    if (running.purpose === 'coding' && reason !== 'error') {
      const conflicted = await running.workspace.conflictedFiles().catch(() => [] as string[])
      if (conflicted.length > 0) {
        await this.deps.bus
          .append(sessionId, {
            type: 'error',
            message:
              'Unmerged conflict markers are still in the working tree. The branch was not committed or pushed.',
            fatal: false,
          })
          .catch(() => undefined)
      } else {
        try {
          await this.syncPullRequest(sessionId, { reason: 'turn_end' })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          console.error(`auto pull request for session ${sessionId}:`, message)
          await this.deps.bus
            .append(sessionId, {
              type: 'error',
              message: `Could not update the pull request: ${message}`,
              fatal: false,
            })
            .catch(() => undefined)
        }
      }
    }

    if (running.purpose === 'environment_setup' && reason !== 'error') {
      const retried = await this.captureAndVerifyEnvironmentProposal(sessionId, running)
      if (retried) return
    }

    const agentSessionId = running.adapter.agentSessionId()

    await this.setStatus(sessionId, reason === 'error' ? 'failed' : 'done', {
      ...(agentSessionId ? { agentSessionId } : {}),
    })
  }

  /**
   * Read the setup agent's proposal, re-run its commands on a clean clone, and
   * store the draft.
   *
   * A missing or invalid file is logged rather than failing the turn. A failed
   * verify is sent back to the agent a bounded number of times so they can fix
   * the commands before the user reviews them.
   *
   * Returns true when a follow-up was sent and the turn should stay running.
   */
  private async captureAndVerifyEnvironmentProposal(
    sessionId: string,
    running: RunningSession,
  ): Promise<boolean> {
    const [session] = await this.deps.db.select().from(sessions).where(eq(sessions.id, sessionId))
    if (!session) return false

    let proposal: EnvironmentProposal
    let environmentId: string
    try {
      const result = await running.container.exec(['cat', ENVIRONMENT_PROPOSAL_PATH])
      if (result.exitCode !== 0) {
        throw new Error(`proposal file missing at ${ENVIRONMENT_PROPOSAL_PATH}`)
      }

      proposal = parseEnvironmentProposalJson(result.stdout)

      // The draft belongs to the environment the session runs in. A setup
      // session started from the app always has one; without it there is
      // nowhere to put the proposal, so it is reported rather than dropped.
      if (!session.environmentId) {
        throw new Error('session has no environment to store the proposal on')
      }
      environmentId = session.environmentId
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.deps.bus
        .append(sessionId, {
          type: 'error',
          message: `Could not read environment proposal: ${message}`,
          fatal: false,
        })
        .catch(() => undefined)
      return false
    }

    const config = await this.configFor(environmentId)
    const verification = await this.verifyEnvironmentProposal(proposal, config.image, running)

    if (!verification.ok && !verification.skippedReason) {
      if (running.setupVerifyAttempts < MAX_ENVIRONMENT_SETUP_VERIFY_RETRIES) {
        running.setupVerifyAttempts += 1
        const retry = environmentSetupVerifyRetryPrompt(
          proposal.setup,
          verification.error ?? 'setup verification failed',
        )
        await this.deps.bus.append(sessionId, { type: 'user_prompt', text: retry })
        await running.adapter.send({ text: retry })
        return true
      }

      await this.deps.bus
        .append(sessionId, {
          type: 'error',
          message: `Setup verification failed: ${verification.error ?? 'unknown error'}`,
          fatal: false,
        })
        .catch(() => undefined)
    }

    await this.persistEnvironmentDraft(environmentId, proposal, verification)
    return false
  }

  /**
   * Run proposed setup the way a coding session would, or skip when the
   * proposal asks for a different image than this container.
   */
  private async verifyEnvironmentProposal(
    proposal: EnvironmentProposal,
    currentImage: string,
    running: RunningSession,
  ): Promise<EnvironmentSetupVerification> {
    if (proposal.image !== undefined && proposal.image !== currentImage) {
      return { ok: false, skippedReason: ENVIRONMENT_SETUP_IMAGE_MISMATCH }
    }

    if (proposal.setup.length === 0) return { ok: true }

    try {
      await running.workspace.verifySetup(proposal.setup, running.baseCommit)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: formatSetupVerifyError(error) }
    }
  }

  private async persistEnvironmentDraft(
    environmentId: string,
    proposal: EnvironmentProposal,
    verification: EnvironmentSetupVerification,
  ): Promise<void> {
    const draft: EnvironmentProposal = { ...proposal, verification }
    await this.deps.db
      .update(environments)
      .set({ environmentDraft: draft, updatedAt: new Date() })
      .where(eq(environments.id, environmentId))
  }

  /**
   * Which environment a new session runs in.
   *
   * An explicit choice is verified against the project: an id from another
   * project would otherwise inject that project's config and secrets into this
   * one. Without a choice, the base branch decides, and no match is null —
   * the base image, not an error.
   */
  private async resolveEnvironmentId(
    projectId: string,
    baseBranch: string,
    requested?: string,
  ): Promise<string | null> {
    if (requested) {
      const [owned] = await this.deps.db
        .select({ id: environments.id })
        .from(environments)
        .where(and(eq(environments.id, requested), eq(environments.projectId, projectId)))

      if (!owned) {
        throw new SessionError(`environment does not belong to this project: ${requested}`)
      }

      return owned.id
    }

    const rows = await this.deps.db
      .select({
        id: environments.id,
        branchPattern: environments.branchPattern,
        position: environments.position,
      })
      .from(environments)
      .where(eq(environments.projectId, projectId))

    return resolveEnvironment(rows, baseBranch)?.id ?? null
  }

  /**
   * Effective config: defaults merged with the environment's override.
   *
   * A null environment is the base image — no database read, no override.
   */
  private async configFor(environmentId: string | null): Promise<ProjectConfig> {
    if (!environmentId) return defaultProjectConfig()

    const [environment] = await this.deps.db
      .select({ configOverride: environments.configOverride })
      .from(environments)
      .where(eq(environments.id, environmentId))

    if (!environment?.configOverride) return defaultProjectConfig()

    const parsed = projectConfig.partial().safeParse(environment.configOverride)
    if (!parsed.success) return defaultProjectConfig()

    return mergeProjectConfig(defaultProjectConfig(), parsed.data as Partial<ProjectConfig>)
  }

  /** Where this session's credential socket lives on the host. */
  /**
   * The commit a session branched from.
   *
   * Stored sessions carry it. Sessions that predate that column have to
   * recover it from the remote-tracking ref, because falling back to `HEAD`
   * would measure the branch against the agent's own latest commit and report
   * that nothing changed — hiding the very work someone is trying to open a
   * pull request for.
   *
   * Recovered values are written back, so the recovery happens once.
   */
  private async baseCommitFor(session: Session, workspace: Workspace): Promise<string> {
    if (session.baseCommit) return session.baseCommit

    const recovered = await workspace.baseCommitFromRemote(session.baseBranch)
    if (!recovered) {
      // HEAD is the last resort and is known to be wrong for a session that
      // committed. It keeps the session usable rather than refusing to resume.
      return workspace.headCommit()
    }

    await this.deps.db
      .update(sessions)
      .set({ baseCommit: recovered })
      .where(eq(sessions.id, session.id))

    return recovered
  }

  private socketDirFor(sessionId: string): string {
    return join(this.deps.credentialSocketDir ?? '', sessionId)
  }

  /**
   * Start a credential proxy for this session, if one is configured.
   *
   * Returns undefined when there is no GitHub client or socket directory —
   * the case in tests that clone from a local origin, where no credential is
   * needed at all.
   */
  private async startCredentialProxy(
    sessionId: string,
    repoFullName: string,
  ): Promise<CredentialProxy | undefined> {
    const github = this.deps.github
    if (!github || !this.deps.credentialSocketDir) return undefined

    const proxy = createSessionCredentialProxy({
      socketPath: join(this.socketDirFor(sessionId), 'credentials.sock'),
      repoFullName,
      // Read per request rather than captured here, so the token is never held
      // for longer than one in-flight call.
      readToken: () => github.token(),
      // git is told only that the request was declined, so without this a
      // token that could not be read surfaces as a push failing for no stated
      // reason.
      onError: (error) => {
        console.error(`credential proxy for session ${sessionId}:`, error.message)
      },
    })

    await proxy.start()
    return proxy
  }

  /**
   * Push the session branch and open a pull request.
   *
   * Called from the workspace tab. Auto-open at the end of a turn goes through
   * the same path with `reason: 'turn_end'`.
   */
  async openPullRequest(sessionId: string, title?: string): Promise<PullRequestSummary> {
    const opened = await this.syncPullRequest(sessionId, {
      reason: 'open',
      ...(title ? { title } : {}),
    })
    if (!opened) throw new SessionError('there is nothing to open a pull request for')
    return opened
  }

  async getPullRequest(sessionId: string): Promise<PullRequestDetails | null> {
    const [session] = await this.deps.db.select().from(sessions).where(eq(sessions.id, sessionId))
    if (!session) throw new SessionError('no such session')

    const github = this.deps.github
    if (!github) {
      return toSummary(session).pullRequest
    }

    const repo = await this.repoFullName(session.projectId)
    if (!repo) return toSummary(session).pullRequest

    const found = session.prUrl
      ? await github.viewPullRequest(repo, session.prUrl).catch((error) => {
          console.error(`view pull request for session ${sessionId}:`, error)
          return null
        })
      : await github.findPullRequest(repo, session.branch)
    if (!found) return toSummary(session).pullRequest

    const mergeable = await this.settleMergeable(github, repo, found.url, found.mergeable)

    await this.persistPullRequest(sessionId, {
      url: found.url,
      title: found.title,
      isDraft: found.isDraft,
      state: found.state,
    })

    return {
      url: found.url,
      title: found.title,
      isDraft: found.isDraft,
      state: found.state,
      ...(found.body ? { body: found.body } : {}),
      mergeable,
      ...('checks' in found && found.checks ? { checks: found.checks } : {}),
      ...('reviewDecision' in found ? { reviewDecision: found.reviewDecision } : {}),
      ...('mergeStateStatus' in found && found.mergeStateStatus
        ? { mergeStateStatus: found.mergeStateStatus }
        : {}),
      ...('commits' in found && found.commits && found.commits.length > 0
        ? { commits: found.commits }
        : {}),
      ...('checkRuns' in found && found.checkRuns && found.checkRuns.length > 0
        ? { checkRuns: found.checkRuns }
        : {}),
      ...('reviews' in found && found.reviews && found.reviews.length > 0
        ? { reviews: found.reviews }
        : {}),
    }
  }

  async markPullRequestReady(sessionId: string): Promise<PullRequestSummary> {
    const github = this.deps.github
    if (!github) throw new SessionError('GitHub is not configured on this server')

    const [session] = await this.deps.db.select().from(sessions).where(eq(sessions.id, sessionId))
    if (!session?.prUrl) throw new SessionError('this session has no pull request')

    await github.markReady(await this.requireRepoFullName(session.projectId), session.prUrl)

    const next: PullRequestSummary = {
      url: session.prUrl,
      title: session.prTitle ?? '',
      isDraft: false,
      state: 'open',
    }
    await this.persistPullRequest(sessionId, next)
    return next
  }

  async mergePullRequest(sessionId: string, method?: MergeMethod): Promise<PullRequestSummary> {
    const github = this.deps.github
    if (!github) throw new SessionError('GitHub is not configured on this server')

    const [session] = await this.deps.db.select().from(sessions).where(eq(sessions.id, sessionId))
    if (!session?.prUrl) throw new SessionError('this session has no pull request')
    if (session.status === 'running') {
      throw new SessionError('the agent is still working on this session')
    }

    const repo = await this.requireRepoFullName(session.projectId)
    const view = await github.viewPullRequest(repo, session.prUrl)
    if (view.state !== 'open') {
      await this.persistPullRequest(sessionId, {
        url: view.url,
        title: view.title,
        isDraft: view.isDraft,
        state: view.state,
      })
      throw new SessionError('this pull request is no longer open')
    }
    if (view.isDraft) {
      throw new SessionError('this pull request is still a draft')
    }

    const blocked = pullRequestMergeBlock(view)
    if (blocked) throw new SessionError(blocked)

    const mergeable = await this.settleMergeable(github, repo, session.prUrl, view.mergeable)
    if (mergeable === 'CONFLICTING') {
      throw new MergeConflictError()
    }

    const prefs = parseGitPreferences(session.gitPreferences)
    try {
      await github.mergePullRequest({
        repoFullName: repo,
        url: session.prUrl,
        method: method ?? prefs.mergeMethod,
        deleteBranch: prefs.deleteBranchAfterMerge,
      })
    } catch (error) {
      if (error instanceof GitHubError && /conflict|not mergeable/i.test(error.message)) {
        throw new MergeConflictError()
      }
      if (error instanceof GitHubError) {
        console.error(`merge pull request for session ${sessionId}:`, error.message)
        const fresh = await github.viewPullRequest(repo, session.prUrl).catch(() => null)
        const blocked = fresh ? pullRequestMergeBlock(fresh) : null
        throw new SessionError(blocked ?? pullRequestFailureMessage(error))
      }
      throw error
    }

    const next: PullRequestSummary = {
      url: session.prUrl,
      title: session.prTitle ?? '',
      isDraft: false,
      state: 'merged',
    }
    await this.persistPullRequest(sessionId, next)
    return next
  }

  /**
   * Fetch the base branch into the session workspace and either push a clean
   * merge or prompt the agent to resolve conflict markers.
   */
  async resolvePullRequestConflicts(
    sessionId: string,
  ): Promise<{ status: 'resolved' | 'resolving'; conflictedFiles?: string[] }> {
    const github = this.deps.github
    if (!github) throw new SessionError('GitHub is not configured on this server')

    const [session] = await this.deps.db.select().from(sessions).where(eq(sessions.id, sessionId))
    if (!session) throw new SessionError('no such session')
    if (!session.prUrl) throw new SessionError('this session has no pull request')
    if (session.purpose === 'environment_setup') {
      throw new SessionError('environment setup sessions do not merge pull requests')
    }

    const running = await this.ensureRunning(sessionId)

    try {
      if (await running.workspace.isDirty()) {
        await running.workspace.commitAll(
          `Save uncommitted work before merging ${session.baseBranch}`,
        )
      }

      await running.workspace.fetchBranch(session.baseBranch)
      const merged = await running.workspace.merge(`origin/${session.baseBranch}`)

      if (merged.ok) {
        await this.ensurePush(sessionId, running, session.branch, github)
        return { status: 'resolved' }
      }

      const prompt = conflictResolutionPrompt(session.baseBranch, merged.conflicted)
      await this.setStatus(sessionId, 'running')
      await this.deps.bus.append(sessionId, { type: 'user_prompt', text: prompt })
      await running.adapter.send({ text: prompt })
      return { status: 'resolving', conflictedFiles: merged.conflicted }
    } catch (error) {
      throw workspaceAsSessionError(error)
    }
  }

  /**
   * Commit leftover changes, push, and open (or reuse) a draft pull request.
   *
   * `turn_end` honours the session's git preferences and is silent when there
   * is nothing to do. `open` is the explicit user action and always tries.
   */
  private async syncPullRequest(
    sessionId: string,
    options: { reason: 'turn_end' | 'open'; title?: string },
  ): Promise<PullRequestSummary | null> {
    const [session] = await this.deps.db.select().from(sessions).where(eq(sessions.id, sessionId))
    if (!session) throw new SessionError('no such session')

    const prefs = parseGitPreferences(session.gitPreferences)
    const userAsked = options.reason === 'open'
    const knownState = pullRequestState.safeParse(session.prState)
    const prState = knownState.success ? knownState.data : undefined

    if (!sessionOpensPullRequests(prState)) {
      if (userAsked) {
        throw new SessionError("this session's pull request is already merged")
      }
      return toSummary(session).pullRequest
    }

    if (session.purpose === 'environment_setup') {
      if (userAsked) throw new SessionError('environment setup sessions do not open pull requests')
      return null
    }

    const github = this.deps.github
    if (!github) {
      if (userAsked) throw new SessionError('GitHub is not configured on this server')
      return null
    }

    const running = await this.ensureRunning(sessionId)

    const conflicted = await running.workspace.conflictedFiles()
    if (conflicted.length > 0) {
      if (userAsked) {
        throw new SessionError(
          'unmerged conflict markers are still in the working tree. Resolve them before opening or updating the pull request.',
        )
      }
      return toSummary(session).pullRequest
    }

    const dirty = await running.workspace.isDirty()
    const changed = await running.workspace.changedFiles(running.baseCommit)

    if (!userAsked && !prefs.autoOpenDraft && !prefs.commitOnTurnEnd) return null

    const shouldCommit = userAsked || prefs.commitOnTurnEnd
    const shouldOpen = userAsked || prefs.autoOpenDraft

    const commits = await running.workspace.commitsSince(running.baseCommit)
    const diffStat = await running.workspace.diffStat(running.baseCommit)
    const content = await writePullRequestContent({
      prompt: session.prompt.trim() || session.title || '',
      commits,
      diffStat,
      changedFiles: changed,
      sessionId,
      branch: session.branch,
      preferences: prefs,
      ...(running.sessionModel ? { sessionModel: running.sessionModel } : {}),
      ...(this.deps.secrets ? { secrets: this.deps.secrets } : {}),
    })

    if (shouldCommit && dirty) {
      await running.workspace.commitAll(options.title ?? content.title)
    }

    const stillChanged = await running.workspace.changedFiles(running.baseCommit)
    if (stillChanged.length === 0 && !session.prUrl) {
      if (userAsked) throw new SessionError('there is nothing to open a pull request for')
      return null
    }

    // Push whenever we will open a PR, or when one already exists so GitHub
    // sees the new commits even if auto-open is off.
    if (!shouldOpen && !session.prUrl) return null

    await this.ensurePush(sessionId, running, session.branch, github)

    const existing = await github.findPullRequest(running.repoFullName, session.branch)
    if (existing && reuseExistingPullRequest(existing.state)) {
      const summary: PullRequestSummary = {
        url: existing.url,
        title: existing.title,
        isDraft: existing.isDraft,
        state: existing.state,
      }

      if (dukeboxOwnsPullRequestBody(existing.body)) {
        const afterCommit = await running.workspace.commitsSince(running.baseCommit)
        const afterStat = await running.workspace.diffStat(running.baseCommit)
        const afterFiles = await running.workspace.changedFiles(running.baseCommit)
        const written =
          afterCommit.join('\n') === commits.join('\n')
            ? content
            : await writePullRequestContent({
                prompt: session.prompt.trim() || session.title || '',
                commits: afterCommit,
                diffStat: afterStat,
                changedFiles: afterFiles,
                sessionId,
                branch: session.branch,
                preferences: prefs,
                ...(running.sessionModel ? { sessionModel: running.sessionModel } : {}),
                ...(this.deps.secrets ? { secrets: this.deps.secrets } : {}),
              })
        try {
          await github.editPullRequest({
            repoFullName: running.repoFullName,
            url: existing.url,
            title: options.title ?? written.title,
            body: written.body,
          })
          summary.title = options.title ?? written.title
        } catch (error) {
          console.error(
            `update pull request for session ${sessionId}:`,
            error instanceof Error ? error.message : error,
          )
        }
      }

      await this.persistPullRequest(sessionId, summary)
      return summary
    }

    if (existing?.state === 'merged') {
      const summary: PullRequestSummary = {
        url: existing.url,
        title: existing.title,
        isDraft: existing.isDraft,
        state: existing.state,
      }
      await this.persistPullRequest(sessionId, summary)
      if (userAsked) {
        throw new SessionError("this session's pull request is already merged")
      }
      return summary
    }

    if (!shouldOpen) return toSummary(session).pullRequest

    const afterCommit = await running.workspace.commitsSince(running.baseCommit)
    const afterStat = await running.workspace.diffStat(running.baseCommit)
    const afterFiles = await running.workspace.changedFiles(running.baseCommit)
    const written =
      afterCommit.join('\n') === commits.join('\n')
        ? content
        : await writePullRequestContent({
            prompt: session.prompt.trim() || session.title || '',
            commits: afterCommit,
            diffStat: afterStat,
            changedFiles: afterFiles,
            sessionId,
            branch: session.branch,
            preferences: prefs,
            ...(running.sessionModel ? { sessionModel: running.sessionModel } : {}),
            ...(this.deps.secrets ? { secrets: this.deps.secrets } : {}),
          })

    const url = await github.createPullRequest({
      repoFullName: running.repoFullName,
      head: session.branch,
      base: session.baseBranch,
      title: options.title ?? written.title,
      body: written.body,
      draft: prefs.createAsDraft,
    })

    const summary: PullRequestSummary = {
      url,
      title: options.title ?? written.title,
      isDraft: prefs.createAsDraft,
      state: 'open',
    }
    await this.persistPullRequest(sessionId, summary)
    return summary
  }

  /**
   * GitHub reports `UNKNOWN` until it has computed mergeability. A few
   * retries usually land on MERGEABLE or CONFLICTING; if not, UNKNOWN is
   * the honest answer and `gh pr merge` can still fail later.
   */
  private async settleMergeable(
    github: GitHubClient,
    repoFullName: string,
    url: string,
    current: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null,
  ): Promise<'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null> {
    if (current && current !== 'UNKNOWN') return current

    for (let attempt = 0; attempt < MERGEABLE_POLL_ATTEMPTS; attempt++) {
      await sleep(MERGEABLE_POLL_MS)
      const view = await github.viewPullRequest(repoFullName, url)
      if (view.mergeable && view.mergeable !== 'UNKNOWN') return view.mergeable
    }

    return 'UNKNOWN'
  }

  private async persistPullRequest(sessionId: string, pr: PullRequestSummary): Promise<void> {
    const [current] = await this.deps.db.select().from(sessions).where(eq(sessions.id, sessionId))
    if (current && pullRequestRecordUnchanged(current, pr)) return

    const [updated] = await this.deps.db
      .update(sessions)
      .set({
        prUrl: pr.url,
        prTitle: pr.title,
        prDraft: pr.isDraft,
        prState: pr.state,
        updatedAt: new Date(),
      })
      .where(eq(sessions.id, sessionId))
      .returning()

    if (updated) await this.deps.bus.publishSessionUpdate(toSummary(updated))
  }

  private async repoFullName(projectId: string): Promise<string | null> {
    const [project] = await this.deps.db
      .select({ repoFullName: projects.repoFullName })
      .from(projects)
      .where(eq(projects.id, projectId))
    return project?.repoFullName ?? null
  }

  private async requireRepoFullName(projectId: string): Promise<string> {
    const name = await this.repoFullName(projectId)
    if (!name) throw new SessionError('no such project')
    return name
  }

  private async ensurePush(
    sessionId: string,
    running: RunningSession,
    branch: string,
    github: GitHubClient,
  ): Promise<void> {
    // A proxy that stopped listening — the service restarted, or the session
    // was stopped and resumed — leaves its socket file behind. Restarted here
    // rather than reported, because the fix is the same either way and the
    // pull request is the moment it is needed.
    if (running.credentials && !running.credentials.listening) {
      const restarted = await this.startCredentialProxy(sessionId, running.repoFullName)
      if (restarted) this.running.set(sessionId, { ...running, credentials: restarted })
    }

    if (
      running.credentials &&
      !(await running.workspace.credentialSocketReachable(CONTAINER_SOCKET_PATH))
    ) {
      throw new SessionError(
        `the credential socket is not visible inside this session's container, so git has no way to authenticate. ` +
          `This happens when its socket directory on the host was removed and recreated after the container started. ` +
          `Starting a new session for this project rebuilds the mount.`,
      )
    }

    try {
      await running.workspace.push(branch)
    } catch (error) {
      const reachable = await github
        .defaultBranch(running.repoFullName)
        .then(() => true)
        .catch(() => false)

      if (!reachable) {
        throw new SessionError(
          `${running.repoFullName} could not be reached on GitHub. ` +
            `Check the repository exists and that the account Dukebox is signed in as can push to it. ` +
            `GitHub reports a repository you cannot access the same way it reports one that is not there.`,
        )
      }

      const detail = error instanceof WorkspaceError ? error.stderr.trim() : ''

      const tokenState = await github
        .token()
        .then(() => 'host token: yes')
        .catch(
          (failure: unknown) =>
            `host token: NO (${failure instanceof Error ? failure.message : 'unknown'})`,
        )

      const proxyState = running.credentials
        ? `${await askProxy(
            join(this.socketDirFor(sessionId), 'credentials.sock'),
            running.repoFullName,
          )}, proxy listening: ${running.credentials.listening}, serving: ${running.repoFullName}`
        : 'proxy: not configured'

      const diagnosis = running.credentials
        ? await running.workspace
            .diagnoseCredentials(Workspace.HELPER_PATH, CONTAINER_SOCKET_PATH, running.repoFullName)
            .then((report) => `${report}, ${tokenState}, ${proxyState}`)
            .catch(() => `${tokenState}, ${proxyState}`)
        : 'credentials: not configured on this server'

      throw new SessionError(
        [`could not push ${branch}`, detail && `: ${detail}`, diagnosis && ` [${diagnosis}]`]
          .filter(Boolean)
          .join(''),
      )
    }
  }

  /**
   * Environment for a session container.
   *
   * Three sources, in order: the agent's own credentials, the project's
   * secrets, and the literal values from `.duke/config.yaml`. Secret
   * references in the config resolve against the project's stored secrets, and
   * one that was never set is dropped rather than passed through as the
   * literal `${secret.NAME}`, which would look like a value to whatever reads
   * it.
   */
  private async environmentFor(
    config: ProjectConfig,
    projectId: string,
    agentId: string,
    instructions?: string,
  ): Promise<Record<string, string>> {
    const store = this.deps.secrets
    const projectSecrets = store ? await store.environmentFor(projectId) : {}

    const environment: Record<string, string> = {}

    // The agent's credentials. Server-wide: one subscription runs every
    // session, whatever repository it is working in. Only the credentials
    // the chosen agent actually reads are injected, so an OpenCode session
    // does not inherit a Claude token it has no use for.
    if (store) {
      if (agentId === 'claude-code') {
        const agentToken = await store.get(AGENT_CREDENTIAL_SECRET)
        if (agentToken) environment[AGENT_CREDENTIAL_SECRET] = agentToken
      }

      if (agentId === 'opencode') {
        const providers = await loadOpencodeProviders(store)
        Object.assign(environment, buildOpencodeSessionEnv(providers, instructions))
      }
    }

    if (agentId === 'grok-build') {
      const key = store ? await store.get(GROK_CREDENTIAL_SECRET) : null
      const authJson = store ? await store.get(GROK_AUTH_SECRET) : null
      Object.assign(environment, grokBuildContainerEnv({ apiKey: key, authJson }))
    }

    Object.assign(environment, projectSecrets)

    for (const [key, value] of Object.entries(config.env)) {
      const reference = parseSecretReference(value)

      if (!reference) {
        environment[key] = value
        continue
      }

      const resolved = projectSecrets[reference]
      if (resolved !== undefined) environment[key] = resolved
    }

    return environment
  }

  /** Send a follow-up prompt to a running session. */
  async prompt(
    sessionId: string,
    text: string,
    images?: string[],
    files?: { name: string; data: string }[],
  ): Promise<void> {
    const running = await this.ensureRunning(sessionId)

    const [row] = await this.deps.db.select().from(sessions).where(eq(sessions.id, sessionId))
    const prState = pullRequestState.safeParse(row?.prState)
    const agentText =
      prState.success && !sessionOpensPullRequests(prState.data)
        ? `${MERGED_SESSION_AGENT_NOTICE}\n\n${text}`
        : text

    await this.setStatus(sessionId, 'running')

    // Recorded here rather than by the sender, so it survives a reload and
    // reaches every other device watching this session. The merge notice is
    // only for the agent — the transcript keeps what the person typed.
    const attachments = promptAttachmentsFrom(files, images)
    await this.deps.bus.append(sessionId, {
      type: 'user_prompt',
      text,
      ...(attachments ? { attachments } : {}),
    })

    await running.adapter.send({
      text: agentText,
      ...partitionAttachments(files, images),
    })
  }

  /**
   * Bring a session back after the control plane restarted.
   *
   * `running` is an in-memory map, so a restart forgets every session while
   * their containers are still on disk — the whole point of stopping a
   * container rather than removing it. Without this, a prompt to any session
   * that predates the restart fails with "not running" and the only way back
   * is to start a new session and lose the history.
   *
   * The repository is not cloned again and setup does not run again: the
   * workspace is whatever the agent left, including commits it made.
   */
  private async resume(sessionId: string): Promise<RunningSession> {
    const [session] = await this.deps.db.select().from(sessions).where(eq(sessions.id, sessionId))
    if (!session) throw new SessionError('no such session')

    // A follow-up must not stay hidden: restoreAfterRestart skips nothing that
    // is in progress, but a row that is still archived would be easy to lose
    // if a later filter ever excludes it again.
    if (session.archivedAt) await this.unarchive(sessionId)

    const container = await this.deps.sandbox.get(sessionId)
    if (!container) {
      // The container is genuinely gone, so there is no workspace to resume
      // into. Saying which of the two happened is the difference between
      // waiting and starting over.
      throw new SessionError('that session’s container no longer exists')
    }

    const [project] = await this.deps.db
      .select()
      .from(projects)
      .where(eq(projects.id, session.projectId))

    if (!project) throw new SessionError('no such project')

    // Before the container starts, exactly as provisioning does it. Starting
    // the container first lets Docker recreate the mount point as root, and
    // the proxy — running as the service user — then cannot bind inside it.
    const credentials = await this.startCredentialProxy(sessionId, project.repoFullName)

    // A container still running here is leftover from before this process
    // started. The agent inside it is not ours, and starting a second one
    // beside it is how a follow-up hangs waiting for a turn that never ends.
    if (await container.isRunning()) await container.stop()

    await container.start()

    const workspace = new Workspace(container)
    if (credentials) await workspace.installCredentialHelper()

    const purpose = (session.purpose as SessionPurpose) || 'coding'
    const config = await this.configFor(session.environmentId)

    const adapter = this.createAdapter(session.agentId)
    await adapter.start({
      sessionId,
      container,
      workingDir: '/workspace/repo',
      // Hands the agent its own prior session, so it answers with the
      // conversation rather than from nothing.
      ...(session.agentSessionId ? { resumeFrom: session.agentSessionId } : {}),
      ...(config.instructions && purpose === 'coding' ? { instructions: config.instructions } : {}),
      ...permissionModeContext(session),
      ...grokAuthContext(session.agentId, this.deps.secrets),
    })

    const running: RunningSession = {
      container,
      workspace,
      adapter,
      // The commit the branch started from, so diffs and the pull request
      // check still measure against the same point they did before.
      baseCommit: await this.baseCommitFor(session, workspace),
      repoFullName: project.repoFullName,
      purpose,
      setupVerifyAttempts: 0,
      ...(credentials ? { credentials } : {}),
    }

    this.running.set(sessionId, running)
    void this.consume(sessionId, adapter)

    return running
  }

  /**
   * The running session, starting it again if this process has forgotten it.
   *
   * `running` is empty after every restart. Prompt, terminal, and pull request
   * all need the container, and asking the user to send a dummy message first
   * is how "the session is not running" used to read.
   */
  private async ensureRunning(sessionId: string): Promise<RunningSession> {
    const existing = this.running.get(sessionId)
    if (existing) return existing

    const inFlight = this.resuming.get(sessionId)
    if (inFlight) return inFlight

    const attempt = this.resume(sessionId).finally(() => {
      this.resuming.delete(sessionId)
    })
    this.resuming.set(sessionId, attempt)
    return attempt
  }

  /**
   * Open an interactive shell in a session's container.
   *
   * Deliberately not tracked here: the terminal registry owns the lifetime, and
   * a second owner would mean two places deciding when a PTY dies.
   *
   * Resumes the session when the control plane has forgotten it — the same
   * path a follow-up prompt takes — so opening a terminal after a restart
   * brings the workspace back rather than reporting it not running.
   */
  async openTerminal(
    sessionId: string,
    size: { cols: number; rows: number },
  ): Promise<TerminalHandle> {
    const running = await this.ensureRunning(sessionId)

    // A session marked stopped was archived or explicitly stopped. Opening a
    // shell means someone is using it again; `done` is the idle state a warm
    // container already has after a normal turn.
    const [session] = await this.deps.db
      .select({ status: sessions.status })
      .from(sessions)
      .where(eq(sessions.id, sessionId))

    if (session?.status === 'stopped') await this.setStatus(sessionId, 'done')

    return running.container.openTerminal({ ...size, cwd: '/workspace/repo' })
  }

  /**
   * Paths in the session's working tree, for the Files tab.
   *
   * Resumes the container the same way a terminal does, so browsing files
   * after a control-plane restart does not require a dummy prompt first.
   */
  async listWorkspaceTree(sessionId: string): Promise<string[]> {
    const running = await this.ensureRunning(sessionId)
    try {
      return await running.workspace.listTree()
    } catch (error) {
      throw workspaceAsSessionError(error)
    }
  }

  /** Contents of one workspace path, capped and marked if binary. */
  async readWorkspaceFile(sessionId: string, path: string): Promise<WorkspaceFile> {
    if (!resolveWorkspacePath(path)) throw new SessionError('invalid path')

    const running = await this.ensureRunning(sessionId)
    try {
      return await running.workspace.readFile(path)
    } catch (error) {
      throw workspaceAsSessionError(error)
    }
  }

  async interrupt(sessionId: string): Promise<void> {
    const running = this.running.get(sessionId)
    if (!running) {
      throw new SessionError(
        'that session is not running. The server may have restarted — send a message or open a terminal to continue.',
      )
    }

    await running.adapter.interrupt()
  }

  async respondToPermission(sessionId: string, id: string, allow: boolean): Promise<void> {
    const running = this.running.get(sessionId)
    if (!running) {
      throw new SessionError(
        'that session is not running. The server may have restarted — send a message or open a terminal to continue.',
      )
    }

    await running.adapter.respondToPermission(id, allow)
  }

  async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<void> {
    const running = await this.ensureRunning(sessionId)

    await running.adapter.setPermissionMode(mode)
  }

  /**
   * Park a session without marking it stopped.
   *
   * The container stays on disk and the row stays in-progress so the next
   * process can continue the turn. Distinct from `stop`, which is what the
   * user asked for.
   */
  private async pause(sessionId: string): Promise<void> {
    const running = this.running.get(sessionId)
    if (!running) return

    this.running.delete(sessionId)

    await running.adapter.stop()
    await running.container.stop()

    await this.deps.onSessionStopped?.(sessionId).catch(() => undefined)
    await running.credentials?.stop().catch(() => undefined)
  }

  /**
   * Stop a session.
   *
   * The container is stopped, not removed: a follow-up resumes in place rather
   * than re-cloning and re-installing, which is the difference between seconds
   * and minutes.
   */
  async stop(sessionId: string): Promise<void> {
    if (!this.running.has(sessionId)) return

    await this.pause(sessionId)

    const [session] = await this.deps.db
      .select({ status: sessions.status })
      .from(sessions)
      .where(eq(sessions.id, sessionId))

    if (session && !isTerminal(session.status as SessionStatus)) {
      // Recorded so a client replaying after a user stop does not keep showing
      // a turn that can never finish: tools without results, the Working
      // spinner, a Stop button that cannot interrupt an agent that is gone.
      await this.deps.bus
        .append(sessionId, { type: 'done', reason: 'interrupted' })
        .catch(() => undefined)
      await this.setStatus(sessionId, 'stopped', { endedAt: new Date() })
    }
  }

  /**
   * Hide a session from the sidebar without deleting its history.
   *
   * Stops the container first when it is still running — an archived session
   * that keeps burning CPU would be worse than one that is merely out of sight.
   */
  async archive(sessionId: string): Promise<void> {
    const [session] = await this.deps.db
      .select({ id: sessions.id, archivedAt: sessions.archivedAt })
      .from(sessions)
      .where(eq(sessions.id, sessionId))

    if (!session) throw new SessionError(`no such session: ${sessionId}`)
    if (session.archivedAt) return

    await this.stop(sessionId)

    await this.deps.db
      .update(sessions)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(sessions.id, sessionId))
  }

  /**
   * Put an archived session back in the sidebar.
   *
   * History never left the server; this only clears the hide flag. The
   * container stays stopped — opening the row starts it again, same as any
   * other stopped session.
   */
  async unarchive(sessionId: string): Promise<void> {
    const [session] = await this.deps.db
      .select({ id: sessions.id, archivedAt: sessions.archivedAt })
      .from(sessions)
      .where(eq(sessions.id, sessionId))

    if (!session) throw new SessionError(`no such session: ${sessionId}`)
    if (!session.archivedAt) return

    await this.deps.db
      .update(sessions)
      .set({ archivedAt: null, updatedAt: new Date() })
      .where(eq(sessions.id, sessionId))
  }

  /**
   * Permanently delete a session.
   *
   * Unlike `stop` (the container stays for a follow-up) or `archive` (the row
   * stays for history), this removes everything: the container, the credential
   * socket directory, the Redis stream, and the row itself — messages cascade.
   * The client makes the user type the session title to confirm before calling
   * it, because there is no coming back from it.
   */
  async delete(sessionId: string): Promise<void> {
    const [session] = await this.deps.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.id, sessionId))

    if (!session) throw new SessionError(`no such session: ${sessionId}`)

    // Stop the agent and container the way `stop` does, so a running session's
    // work is halted and its terminals are cleaned up before anything goes.
    await this.stop(sessionId)

    // Removed, not just stopped: a deleted session has no follow-up to resume.
    const container = await this.deps.sandbox.get(sessionId)
    await container?.remove().catch(() => undefined)

    // A socket left behind would keep answering credential requests for a
    // session that no longer exists.
    await rm(this.socketDirFor(sessionId), { recursive: true, force: true }).catch(() => undefined)

    // Redis serves this session's recent events; the row and messages are gone.
    await this.deps.bus.clearStream(sessionId).catch(() => undefined)

    await this.deps.db.delete(sessions).where(eq(sessions.id, sessionId))
  }

  /** Stop every running session this process holds. Explicit: marks each one stopped. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((sessionId) => this.stop(sessionId)))
  }

  /**
   * Park every running session for a process restart.
   *
   * Containers stay on disk and rows stay in-progress so the next process can
   * continue the turn. Distinct from `stopAll`, which is a user-facing stop.
   */
  async pauseAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((sessionId) => this.pause(sessionId)))
  }

  /**
   * Continue sessions left in-flight by a previous process.
   *
   * `running` starts empty. Rows still marked provisioning/running/waiting_input
   * belong to a turn whose agent died with the last process. The workspace is
   * still on disk; this brings the container back and asks the agent to
   * continue rather than marking the session stopped.
   */
  async restoreAfterRestart(): Promise<void> {
    const live = await this.deps.db
      .select()
      .from(sessions)
      .where(inArray(sessions.status, IN_PROGRESS_STATUSES))

    await Promise.all(live.map((session) => this.restoreOne(session)))
  }

  private async restoreOne(session: Session): Promise<void> {
    try {
      if (session.status === 'provisioning' && !session.baseCommit) {
        await this.retryProvision(session)
        return
      }

      await this.continueAfterRestart(session.id)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`restore session ${session.id}:`, message)
      await this.deps.bus
        .append(session.id, { type: 'error', message, fatal: true })
        .catch(() => undefined)
      await this.setStatus(session.id, 'failed', { errorMessage: message }).catch(() => undefined)
    }
  }

  /**
   * Re-run provisioning after a crash that never finished the clone.
   *
   * The leftover container is half-baked and is removed rather than resumed.
   * The original prompt is already in the log from `start`.
   */
  private async retryProvision(session: Session): Promise<void> {
    const prompt = firstUserPrompt(await this.deps.bus.replay(session.id))
    if (!prompt) {
      throw new SessionError(
        'this session was interrupted while starting, and the original prompt was not recorded',
      )
    }

    const leftover = await this.deps.sandbox.get(session.id)
    await leftover?.remove().catch(() => undefined)

    const [project] = await this.deps.db
      .select()
      .from(projects)
      .where(eq(projects.id, session.projectId))

    if (!project) throw new SessionError('no such project')

    await this.provision(session, project.repoFullName, prompt)
  }

  /**
   * Resume a workspace whose turn was in flight and ask the agent to continue.
   *
   * The previous agent process is gone. Open tools and permission prompts in
   * the transcript are closed with `done: interrupted`, then a new adapter is
   * started with the stored conversation id when we have one.
   */
  private async continueAfterRestart(sessionId: string): Promise<void> {
    const running = await this.ensureRunning(sessionId)
    const [session] = await this.deps.db.select().from(sessions).where(eq(sessions.id, sessionId))

    const events = await this.deps.bus.replay(sessionId)
    const last = events.at(-1)?.event
    if (last?.type !== 'done') {
      await this.deps.bus.append(sessionId, { type: 'done', reason: 'interrupted' })
    }

    await this.setStatus(sessionId, 'running')

    if (session?.agentSessionId) {
      await this.deps.bus.append(sessionId, {
        type: 'user_prompt',
        text: RESTART_CONTINUATION_PROMPT,
      })
      await running.adapter.send({ text: RESTART_CONTINUATION_PROMPT })
      return
    }

    // No conversation to resume: the agent never got far enough to record an
    // id. Send the original task again without logging a second copy.
    const prompt = firstUserPrompt(events)
    if (!prompt) {
      throw new SessionError('this session was interrupted before the original prompt was recorded')
    }

    await running.adapter.send({ text: prompt })
  }

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId)
  }
}

function firstUserPrompt(events: EnvelopedEvent[]): string | undefined {
  const prompt = events.find((envelope) => envelope.event.type === 'user_prompt')
  return prompt?.event.type === 'user_prompt' ? prompt.event.text : undefined
}

/**
 * Ask the credential proxy for a repository, from the host.
 *
 * A socket file outlives the process that created it, so its presence says
 * nothing about whether anything is listening — and a proxy that is listening
 * is still not necessarily one that replies. This is the only check that
 * distinguishes the three, and it runs on the side the container cannot see.
 */
async function askProxy(socketPath: string, repoFullName: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(socketPath)
    let reply = ''

    const finish = (verdict: string) => {
      socket.destroy()
      resolve(`proxy: ${verdict}`)
    }

    socket.on('connect', () => {
      socket.end(`protocol=https\nhost=github.com\npath=${repoFullName}.git\n\n`)
    })

    socket.on('data', (chunk: Buffer) => {
      reply += chunk.toString()
    })

    socket.on('close', () => {
      if (reply.includes('password=')) finish('answers')
      // A bare newline is how the proxy declines, which is a different failure
      // from saying nothing at all: it means the request reached `answer` and
      // was turned down, by the repository check or by a token that could not
      // be read.
      else if (reply === '\n') finish('declined the request')
      else if (reply === '') finish('closed without replying')
      else finish(`replied ${JSON.stringify(reply.slice(0, 40))}`)
    })

    socket.on('error', (error: NodeJS.ErrnoException) => finish(`unreachable (${error.code})`))
    setTimeout(() => finish('no reply within 10s'), 10_000)
  })
}
