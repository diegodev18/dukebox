import { ClaudeCodeAdapter, type AgentAdapter } from '@dukebox/adapters'
import { projects, sessions, type Database, type Session } from '@dukebox/db'
import {
  defaultProjectConfig,
  isTerminal,
  parseSecretReference,
  type ProjectConfig,
  type SessionStatus,
} from '@dukebox/protocol'
import {
  CONTAINER_SOCKET_DIR,
  createSessionCredentialProxy,
  Sandbox,
  Workspace,
  type CredentialProxy,
  type SessionContainer,
} from '@dukebox/sandbox'
import { eq } from 'drizzle-orm'
import { join } from 'node:path'
import type { EventBus } from '../events/bus.js'
import type { GitHubClient } from '../github/client.js'
import { AGENT_CREDENTIAL_SECRET, type SecretStore } from '../secrets/store.js'

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
}

export interface StartSessionOptions {
  projectId: string
  agentId: string
  baseBranch?: string
  prompt: string
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
}

export class SessionError extends Error {}

export class SessionManager {
  private readonly running = new Map<string, RunningSession>()

  constructor(private readonly deps: SessionManagerDeps) {}

  private createAdapter(agentId: string): AgentAdapter {
    if (this.deps.createAdapter) return this.deps.createAdapter(agentId)

    if (agentId === 'claude-code') return new ClaudeCodeAdapter()
    throw new SessionError(`no adapter for agent: ${agentId}`)
  }

  private async setStatus(
    sessionId: string,
    status: SessionStatus,
    extra: Partial<Session> = {},
  ): Promise<void> {
    await this.deps.db
      .update(sessions)
      .set({ status, updatedAt: new Date(), ...extra })
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

    const baseBranch = options.baseBranch ?? project.defaultBranch

    const [session] = await this.deps.db
      .insert(sessions)
      .values({
        projectId: project.id,
        agentId: options.agentId,
        status: 'provisioning',
        // Placeholder until the workspace names the branch; the row has to
        // exist first so the client has something to subscribe to.
        branch: '',
        baseBranch,
        title: options.prompt.slice(0, 80),
      })
      .returning()

    if (!session) throw new SessionError('failed to create session')

    // Deliberately not awaited: provisioning is slow, and its progress reaches
    // the client as events rather than as a blocked request.
    void this.provision(session, project.repoFullName, options.prompt).catch(
      async (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)

        await this.deps.bus
          .append(session.id, { type: 'error', message, fatal: true })
          .catch(() => undefined)
        await this.setStatus(session.id, 'failed', { errorMessage: message })
      },
    )

    return session
  }

  private async provision(session: Session, repoFullName: string, prompt: string): Promise<void> {
    // Started before the container so the socket exists to be mounted. It
    // answers only for this session's repository, so an agent that asks for
    // any other gets nothing.
    const credentials = await this.startCredentialProxy(session.id, repoFullName)

    try {
      await this.provisionWith(session, repoFullName, prompt, credentials)
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
  ): Promise<void> {
    const config = defaultProjectConfig()

    // Set on the container rather than only on setup commands: the agent
    // process needs its own credentials, and it is started later by exec.
    const environment = await this.environmentFor(config, session.projectId)

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

    const { branch } = await workspace.clone({
      url: this.deps.cloneUrl(repoFullName),
      baseBranch: session.baseBranch,
      sessionId: session.id,
    })

    await this.deps.db.update(sessions).set({ branch }).where(eq(sessions.id, session.id))

    // The container already carries these, but exec's own environment is what
    // a setup command sees for anything the shell resolves at invocation.
    await workspace.runSetup(config.setup, environment)

    const baseCommit = await workspace.headCommit()
    const adapter = this.createAdapter(session.agentId)

    await adapter.start({
      sessionId: session.id,
      container,
      workingDir: '/workspace/repo',
      ...(config.instructions ? { instructions: config.instructions } : {}),
      ...(session.agentSessionId ? { resumeFrom: session.agentSessionId } : {}),
    })

    this.running.set(session.id, {
      container,
      workspace,
      adapter,
      baseCommit,
      repoFullName,
      ...(credentials ? { credentials } : {}),
    })
    await this.setStatus(session.id, 'running')

    // Started before the first prompt so no early output is missed.
    void this.consume(session.id, adapter)

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

    const agentSessionId = running.adapter.agentSessionId()

    await this.setStatus(sessionId, reason === 'error' ? 'failed' : 'done', {
      ...(agentSessionId ? { agentSessionId } : {}),
    })
  }

  /** Where this session's credential socket lives on the host. */
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
    const running = this.running.get(sessionId)
    if (!running) throw new SessionError('that session is not running')

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
    await running.workspace.commitAll(title ?? session.title ?? 'Agent changes')

    if (changed.length === 0 && !session.prUrl) {
      throw new SessionError('there is nothing to open a pull request for')
    }

    await running.workspace.push(session.branch)

    // A second push to the same branch updates the existing pull request
    // rather than failing, so a follow-up turn extends the same review.
    const existing = await github.findPullRequest(running.repoFullName, session.branch)
    const url =
      existing ??
      (await github.createPullRequest({
        repoFullName: running.repoFullName,
        head: session.branch,
        base: session.baseBranch,
        title: title ?? session.title ?? 'Agent changes',
        body: `Opened by Dukebox from session \`${sessionId}\`.`,
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
  ): Promise<Record<string, string>> {
    const store = this.deps.secrets
    const projectSecrets = store ? await store.environmentFor(projectId) : {}

    const environment: Record<string, string> = {}

    // The agent's credentials. Server-wide: one subscription runs every
    // session, whatever repository it is working in.
    if (store) {
      const agentToken = await store.get(AGENT_CREDENTIAL_SECRET)
      if (agentToken) environment[AGENT_CREDENTIAL_SECRET] = agentToken
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
    const running = this.running.get(sessionId)
    if (!running) throw new SessionError('that session is not running')

    await this.setStatus(sessionId, 'running')
    await running.adapter.send({ text, ...(images ? { images } : {}) })
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

  /** Stop every running session. Called on shutdown. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((sessionId) => this.stop(sessionId)))
  }

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId)
  }
}
