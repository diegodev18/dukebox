import { ClaudeCodeAdapter, type AgentAdapter } from '@dukebox/adapters'
import { projects, sessions, type Database, type Session } from '@dukebox/db'
import {
  defaultProjectConfig,
  isTerminal,
  type ProjectConfig,
  type SessionStatus,
} from '@dukebox/protocol'
import { Sandbox, Workspace, type SessionContainer } from '@dukebox/sandbox'
import { eq } from 'drizzle-orm'
import type { EventBus } from '../events/bus.js'

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
    const config = defaultProjectConfig()

    const container = await this.deps.sandbox.create({
      sessionId: session.id,
      image: config.image,
      // Cloning and installing dependencies both need the network.
      network: 'bridge',
    })

    await this.deps.db
      .update(sessions)
      .set({ containerId: container.id })
      .where(eq(sessions.id, session.id))

    const workspace = new Workspace(container)
    const { branch } = await workspace.clone({
      url: this.deps.cloneUrl(repoFullName),
      baseBranch: session.baseBranch,
      sessionId: session.id,
    })

    await this.deps.db.update(sessions).set({ branch }).where(eq(sessions.id, session.id))

    await workspace.runSetup(config.setup, this.environmentFor(config))

    const baseCommit = await workspace.headCommit()
    const adapter = this.createAdapter(session.agentId)

    await adapter.start({
      sessionId: session.id,
      container,
      workingDir: '/workspace/repo',
      ...(config.instructions ? { instructions: config.instructions } : {}),
      ...(session.agentSessionId ? { resumeFrom: session.agentSessionId } : {}),
    })

    this.running.set(session.id, { container, workspace, adapter, baseCommit })
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

  /** Environment for the container, with secret references left unresolved. */
  private environmentFor(config: ProjectConfig): Record<string, string> {
    // Secrets are decrypted and injected here once the secret store lands.
    // Literal values pass through unchanged.
    return Object.fromEntries(
      Object.entries(config.env).filter(([, value]) => !value.startsWith('${secret.')),
    )
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
