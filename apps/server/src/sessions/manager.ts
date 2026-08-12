import { ClaudeCodeAdapter, OpenCodeAdapter, type AgentAdapter } from '@dukebox/adapters'
import { environments, projects, sessions, type Database, type Session } from '@dukebox/db'
import {
  DEFAULT_COMMIT_IDENTITY,
  defaultProjectConfig,
  ENVIRONMENT_PROPOSAL_PATH,
  isTerminal,
  mergeProjectConfig,
  parseSecretReference,
  projectConfig,
  resolveEnvironment,
  type CommitIdentity,
  type ProjectConfig,
  type SessionPurpose,
  type SessionStatus,
  type PermissionMode,
  DEFAULT_PERMISSION_MODE,
} from '@dukebox/protocol'
import {
  CONTAINER_SOCKET_DIR,
  CONTAINER_SOCKET_PATH,
  createSessionCredentialProxy,
  Sandbox,
  Workspace,
  WorkspaceError,
  type CredentialProxy,
  type SessionContainer,
  type TerminalHandle,
} from '@dukebox/sandbox'
import { and, eq } from 'drizzle-orm'
import { connect } from 'node:net'
import { join } from 'node:path'
import type { EventBus } from '../events/bus.js'
import type { GitHubClient } from '../github/client.js'
import { AGENT_CREDENTIAL_SECRET, type SecretStore } from '../secrets/store.js'
import { buildOpencodeSessionEnv, loadOpencodeProviders } from '../opencode/providers.js'
import { ENVIRONMENT_SETUP_PROMPT, parseEnvironmentProposalJson } from './environmentSetup.js'
import { pullRequestContent } from './summary.js'
import { toSummary } from './summarize.js'

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
   * Claude Code.
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
}

export class SessionError extends Error {}

/** The adapter for an agent id, or a thrown error if none is registered. */
export function createAgentAdapter(agentId: string): AgentAdapter {
  if (agentId === 'claude-code') return new ClaudeCodeAdapter()
  if (agentId === 'opencode') return new OpenCodeAdapter()
  throw new SessionError(`no adapter for agent: ${agentId}`)
}

function storedPermissionMode(agentId: string, requested?: PermissionMode): string | null {
  if (agentId !== 'claude-code') return null
  return requested ?? DEFAULT_PERMISSION_MODE
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

  if (session.agentId === 'claude-code') return { permissionMode: DEFAULT_PERMISSION_MODE }
  return {}
}

export class SessionManager {
  private readonly running = new Map<string, RunningSession>()

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
        title: purpose === 'environment_setup' ? 'Configure environment' : prompt.slice(0, 80),
        permissionMode: storedPermissionMode(options.agentId, options.permissionMode),
      })
      .returning()

    if (!session) throw new SessionError('failed to create session')

    // Deliberately not awaited: provisioning is slow, and its progress reaches
    // the client as events rather than as a blocked request.
    void this.provision(
      session,
      project.repoFullName,
      prompt,
      options.model,
      options.commitIdentity,
      options.permissionMode,
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
    })

    this.running.set(session.id, {
      container,
      workspace,
      adapter,
      baseCommit,
      repoFullName,
      purpose,
      ...(credentials ? { credentials } : {}),
    })
    await this.setStatus(session.id, 'running')

    // Started before the first prompt so no early output is missed.
    void this.consume(session.id, adapter)

    // Appended before it is sent, so the prompt is the first thing in the log
    // rather than arriving after the agent's reply to it. This is the only
    // record of the first prompt: it is sent from here while the session is
    // still provisioning, with no client watching to remember it.
    await this.deps.bus.append(session.id, { type: 'user_prompt', text: prompt })

    await adapter.send({ text: prompt })
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

    if (running.purpose === 'environment_setup' && reason !== 'error') {
      await this.captureEnvironmentProposal(sessionId, running)
    }

    const agentSessionId = running.adapter.agentSessionId()

    await this.setStatus(sessionId, reason === 'error' ? 'failed' : 'done', {
      ...(agentSessionId ? { agentSessionId } : {}),
    })
  }

  /**
   * Read the setup agent's proposal file and store it as the project's draft.
   *
   * A missing or invalid file is logged on the session rather than failing the
   * turn — the user can still re-run setup or fill the form manually.
   */
  private async captureEnvironmentProposal(
    sessionId: string,
    running: RunningSession,
  ): Promise<void> {
    const [session] = await this.deps.db.select().from(sessions).where(eq(sessions.id, sessionId))
    if (!session) return

    try {
      const result = await running.container.exec(['cat', ENVIRONMENT_PROPOSAL_PATH])
      if (result.exitCode !== 0) {
        throw new Error(`proposal file missing at ${ENVIRONMENT_PROPOSAL_PATH}`)
      }

      const proposal = parseEnvironmentProposalJson(result.stdout)

      // The draft belongs to the environment the session runs in. A setup
      // session started from the app always has one; without it there is
      // nowhere to put the proposal, so it is reported rather than dropped.
      if (!session.environmentId) {
        throw new Error('session has no environment to store the proposal on')
      }

      await this.deps.db
        .update(environments)
        .set({ environmentDraft: proposal, updatedAt: new Date() })
        .where(eq(environments.id, session.environmentId))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.deps.bus
        .append(sessionId, {
          type: 'error',
          message: `Could not read environment proposal: ${message}`,
          fatal: false,
        })
        .catch(() => undefined)
    }
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
   * A pull request, never a merge: the user reviews the agent's work on
   * GitHub, where they already have the tools to read a diff.
   */
  async openPullRequest(sessionId: string, title?: string): Promise<string> {
    // Resumed if the control plane has forgotten it. Asking for a pull request
    // is exactly what someone does after coming back to finished work, which
    // is the case most likely to have outlived a restart.
    const running = this.running.get(sessionId) ?? (await this.resume(sessionId))

    const github = this.deps.github
    if (!github) throw new SessionError('GitHub is not configured on this server')

    const [session] = await this.deps.db.select().from(sessions).where(eq(sessions.id, sessionId))

    if (!session) throw new SessionError('no such session')

    // Whether the branch has anything on it, asked against the commit the
    // session started from. `commitAll` returning null only means there is
    // nothing *uncommitted* — an agent that committed its own work would look
    // identical to one that did nothing, which is the case this used to
    // refuse.
    const changed = await running.workspace.changedFiles(running.baseCommit)

    // The same summary the pull request uses, so a commit read on its own says
    // what changed rather than repeating the instruction.
    const summary = pullRequestContent({
      prompt: session.title ?? '',
      events: await this.deps.bus.replay(sessionId).catch(() => []),
      changedFiles: changed,
      sessionId,
      branch: session.branch,
    })

    await running.workspace.commitAll(title ?? summary.title)

    if (changed.length === 0 && !session.prUrl) {
      throw new SessionError('there is nothing to open a pull request for')
    }

    // A proxy that stopped listening — the service restarted, or the session
    // was stopped and resumed — leaves its socket file behind. Restarted here
    // rather than reported, because the fix is the same either way and the
    // pull request is the moment it is needed.
    if (running.credentials && !running.credentials.listening) {
      const restarted = await this.startCredentialProxy(sessionId, running.repoFullName)
      if (restarted) this.running.set(sessionId, { ...running, credentials: restarted })
    }

    // Checked from inside the container, which is the only place it matters.
    // A bind mount is tied to the directory that existed when the container
    // was created, so one replaced since then leaves the container looking at
    // nothing while the host holds a working socket.
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
      await running.workspace.push(session.branch)
    } catch (error) {
      // A repository that does not exist — renamed, deleted, or never pushed —
      // refuses authentication exactly like a bad token, because GitHub will
      // not confirm a private repository is missing to someone who might not
      // be allowed to know. Checked first so it is not reported as a
      // credential problem.
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

      // git's own stderr is the only thing that says why a push failed —
      // rejected credentials, a protected branch, a remote that moved on. The
      // command line alone sends someone looking in the wrong place.
      const detail = error instanceof WorkspaceError ? error.stderr.trim() : ''

      // git names none of the things that can actually be wrong, so the state
      // of the credential path is collected from inside the container and sent
      // with the failure rather than left for someone to go and look for.
      // Whether the host can produce a token at all. The container-side checks
      // cannot see this: a proxy that serves nothing because `gh` gave it
      // nothing looks exactly like one that was never asked.
      const tokenState = await github
        .token()
        .then(() => 'host token: yes')
        .catch(
          (failure: unknown) =>
            `host token: NO (${failure instanceof Error ? failure.message : 'unknown'})`,
        )

      // The proxy answering from the host side. The container-side checks
      // cannot distinguish a proxy that is listening from one that replies,
      // and a socket file outlives the process that created it.
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
        [
          `could not push ${session.branch}`,
          detail && `: ${detail}`,
          diagnosis && ` [${diagnosis}]`,
        ]
          .filter(Boolean)
          .join(''),
      )
    }

    // A second push to the same branch updates the existing pull request
    // rather than failing, so a follow-up turn extends the same review.
    const existing = await github.findPullRequest(running.repoFullName, session.branch)

    const url =
      existing ??
      (await github.createPullRequest({
        repoFullName: running.repoFullName,
        head: session.branch,
        base: session.baseBranch,
        // An explicit title still wins: someone who names it means it.
        title: title ?? summary.title,
        body: summary.body,
      }))

    await this.deps.db.update(sessions).set({ prUrl: url }).where(eq(sessions.id, sessionId))

    return url
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
  async prompt(sessionId: string, text: string, images?: string[]): Promise<void> {
    const running = this.running.get(sessionId) ?? (await this.resume(sessionId))

    await this.setStatus(sessionId, 'running')

    // Recorded here rather than by the sender, so it survives a reload and
    // reaches every other device watching this session.
    await this.deps.bus.append(sessionId, { type: 'user_prompt', text })

    await running.adapter.send({ text, ...(images ? { images } : {}) })
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

    await container.start()

    const workspace = new Workspace(container)
    if (credentials) await workspace.installCredentialHelper()

    const adapter = this.createAdapter(session.agentId)
    await adapter.start({
      sessionId,
      container,
      workingDir: '/workspace/repo',
      // Hands the agent its own prior session, so it answers with the
      // conversation rather than from nothing.
      ...(session.agentSessionId ? { resumeFrom: session.agentSessionId } : {}),
      ...permissionModeContext(session),
    })

    const running: RunningSession = {
      container,
      workspace,
      adapter,
      // The commit the branch started from, so diffs and the pull request
      // check still measure against the same point they did before.
      baseCommit: await this.baseCommitFor(session, workspace),
      repoFullName: project.repoFullName,
      purpose: (session.purpose as SessionPurpose) || 'coding',
      ...(credentials ? { credentials } : {}),
    }

    this.running.set(sessionId, running)
    void this.consume(sessionId, adapter)

    return running
  }

  /**
   * Open an interactive shell in a session's container.
   *
   * Deliberately not tracked here: the terminal registry owns the lifetime, and
   * a second owner would mean two places deciding when a PTY dies.
   */
  async openTerminal(
    sessionId: string,
    size: { cols: number; rows: number },
  ): Promise<TerminalHandle> {
    const running = this.running.get(sessionId)
    if (!running) throw new SessionError('that session is not running')

    return running.container.openTerminal({ ...size, cwd: '/workspace/repo' })
  }

  async interrupt(sessionId: string): Promise<void> {
    const running = this.running.get(sessionId)
    if (!running) throw new SessionError('that session is not running')

    await running.adapter.interrupt()
  }

  async respondToPermission(sessionId: string, id: string, allow: boolean): Promise<void> {
    const running = this.running.get(sessionId)
    if (!running) throw new SessionError('that session is not running')

    await running.adapter.respondToPermission(id, allow)
  }

  async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<void> {
    const running = this.running.get(sessionId)
    if (!running) throw new SessionError('that session is not running')

    await running.adapter.setPermissionMode(mode)
  }

  /**
   * Stop a session.
   *
   * The container is stopped, not removed: a follow-up resumes in place rather
   * than re-cloning and re-installing, which is the difference between seconds
   * and minutes.
   */
  async stop(sessionId: string): Promise<void> {
    const running = this.running.get(sessionId)
    if (!running) return

    this.running.delete(sessionId)

    await running.adapter.stop()
    await running.container.stop()

    // Before the status write, so a client reacting to the status change never
    // finds a terminal that is still listed but already dead.
    await this.deps.onSessionStopped?.(sessionId).catch(() => undefined)

    // Stopped with the session: a socket left listening would keep answering
    // credential requests for a session that is over.
    await running.credentials?.stop().catch(() => undefined)

    const [session] = await this.deps.db
      .select({ status: sessions.status })
      .from(sessions)
      .where(eq(sessions.id, sessionId))

    if (session && !isTerminal(session.status as SessionStatus)) {
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

  /** Stop every running session. Called on shutdown. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((sessionId) => this.stop(sessionId)))
  }

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId)
  }
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
