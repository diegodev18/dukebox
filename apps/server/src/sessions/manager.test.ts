import type { AgentAdapter, SessionContext, UserMessage } from '@dukebox/adapters'
import { projects, sessions } from '@dukebox/db'
import type { AgentEvent } from '@dukebox/protocol'
import { Sandbox } from '@dukebox/sandbox'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { EventBus } from '../events/bus.js'
import type { GitHubClient } from '../github/client.js'
import { close, db, prepareDatabase, resetDatabase } from '../testing/database.js'
import { closeRedis, redis } from '../testing/redis.js'
import { SessionManager, SessionError } from './manager.js'

/**
 * Sessions are tested against a real Docker daemon and a real database, with a
 * fake agent in place of Claude Code. The agent needs credentials this suite
 * does not have, and its output is already covered by the adapter's fixtures;
 * what matters here is the wiring around it.
 */

const bus = new EventBus(db, redis)
const sandbox = new Sandbox()
const IMAGE = process.env.DUKEBOX_TEST_IMAGE ?? 'dukebox/base-node:latest'

/** An agent under the test's control. */
class FakeAdapter implements AgentAdapter {
  readonly id = 'fake'
  readonly capabilities = {
    permissions: true,
    thinking: true,
    resume: true,
    mcp: false,
    interrupt: true,
  }

  readonly prompts: UserMessage[] = []
  started: SessionContext | undefined
  stopped = false
  interrupted = false

  private queue: AgentEvent[] = []
  private resolveNext: (() => void) | undefined
  private ended = false

  async start(context: SessionContext): Promise<void> {
    this.started = context
  }

  async send(message: UserMessage): Promise<void> {
    this.prompts.push(message)
  }

  async respondToPermission(): Promise<void> {}

  async interrupt(): Promise<void> {
    this.interrupted = true
  }

  agentSessionId(): string | undefined {
    return 'fake-agent-session'
  }

  /** Push an event to whatever is consuming this adapter. */
  emit(event: AgentEvent): void {
    this.queue.push(event)
    this.resolveNext?.()
    this.resolveNext = undefined
  }

  async *events(): AsyncIterable<AgentEvent> {
    while (!this.ended || this.queue.length > 0) {
      const next = this.queue.shift()
      if (next) {
        yield next
        continue
      }
      await new Promise<void>((resolve) => {
        this.resolveNext = resolve
      })
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.ended = true
    this.resolveNext?.()
  }
}

let adapter: FakeAdapter
let manager: SessionManager
const createdSessions: string[] = []

/**
 * Serve the repository from a bare clone inside a helper container, reachable
 * over the bridge network. Cloning from GitHub would make these tests depend on
 * someone else's uptime.
 */
let originContainer: Awaited<ReturnType<Sandbox['create']>> | undefined
let originUrl = ''

/** The helper container, which outlives individual tests. */
const ORIGIN_SESSION_ID = 'origin-fixture'

beforeAll(async () => {
  await prepareDatabase()

  // The helper has a fixed name, so one left behind by an interrupted run
  // would make this fail with a name conflict — and that failure would look
  // like a bug in the code under test rather than leftover state.
  await (await sandbox.get(ORIGIN_SESSION_ID))?.remove()

  originContainer = await sandbox.create({
    sessionId: ORIGIN_SESSION_ID,
    image: IMAGE,
    network: 'bridge',
  })

  const setup = await originContainer.exec([
    'sh',
    '-c',
    `set -e
     mkdir -p /tmp/seed && cd /tmp/seed
     git init -q -b main
     echo "original" > README.md
     git add -A && git commit -q -m initial
     git clone -q --bare /tmp/seed /tmp/origin.git
     # Accepting pushes is what lets the pull-request tests exercise the real
     # push path. Safe here: a throwaway repository in a container with no
     # route off this machine.
     cd /tmp/origin.git && git config http.receivepack true
     git daemon --reuseaddr --base-path=/tmp --export-all --enable=receive-pack --detach /tmp
     sleep 1`,
  ])

  if (setup.exitCode !== 0) throw new Error(`failed to seed origin: ${setup.stderr}`)

  const info = await originContainer.inspect()
  const address = Object.values(info.NetworkSettings.Networks)[0]?.IPAddress
  originUrl = `git://${address}/origin.git`
}, 120_000)

afterAll(async () => {
  await originContainer?.remove()
  await close()
  await closeRedis()
})

beforeEach(async () => {
  await resetDatabase()
  await redis.flushdb()

  adapter = new FakeAdapter()
  manager = new SessionManager({
    db,
    bus,
    sandbox,
    cloneUrl: () => originUrl,
    createAdapter: () => adapter,
  })
})

afterEach(async () => {
  // Cleanup runs even if stopping fails. A container left behind outlives this
  // run and breaks the next one, which then looks like an unrelated failure.
  await manager.stopAll().catch(() => undefined)

  // Only containers this suite created. Sweeping every managed container would
  // delete ones another package's tests are using — Turbo runs packages in
  // parallel, and both drive the same Docker daemon.
  for (const sessionId of createdSessions) {
    const container = await sandbox.get(sessionId).catch(() => null)
    await container?.remove().catch(() => undefined)
  }

  createdSessions.length = 0
})

async function createProject(): Promise<string> {
  const [project] = await db
    .insert(projects)
    .values({ repoFullName: `diego/repo-${Math.random().toString(36).slice(2)}` })
    .returning()

  return project!.id
}

/** Start a session and wait for it to reach a status. */
async function startSession(prompt = 'do the thing') {
  const projectId = await createProject()
  const session = await manager.start({ projectId, agentId: 'fake', prompt })
  createdSessions.push(session.id)
  return session
}

async function waitForStatus(sessionId: string, status: string, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const [row] = await db
      .select({ status: sessions.status, errorMessage: sessions.errorMessage })
      .from(sessions)
      .where(eq(sessions.id, sessionId))

    if (row?.status === status) return
    if (row?.status === 'failed' && status !== 'failed') {
      throw new Error(`session failed: ${row.errorMessage}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`session did not reach ${status} in time`)
}

describe('start', () => {
  it('returns before provisioning finishes, so the client can subscribe', async () => {
    const session = await startSession()

    // Provisioning takes tens of seconds. Blocking on it would leave the user
    // watching a spinner with no way to see progress.
    expect(session.status).toBe('provisioning')
  })

  it('reaches running once the container and agent are ready', async () => {
    const session = await startSession()
    await waitForStatus(session.id, 'running')
  })

  it('records the session branch, so work never lands on the base branch', async () => {
    const session = await startSession()
    await waitForStatus(session.id, 'running')

    const [row] = await db
      .select({ branch: sessions.branch })
      .from(sessions)
      .where(eq(sessions.id, session.id))

    expect(row?.branch).toMatch(/^duke\//)
  })

  it('delivers the initial prompt to the agent', async () => {
    const session = await startSession('add a multiply function')
    await waitForStatus(session.id, 'running')

    expect(adapter.prompts[0]?.text).toBe('add a multiply function')
  })

  it('records the container id, so it can be found again after a restart', async () => {
    const session = await startSession()
    await waitForStatus(session.id, 'running')

    const [row] = await db
      .select({ containerId: sessions.containerId })
      .from(sessions)
      .where(eq(sessions.id, session.id))

    expect(row?.containerId).toMatch(/^[0-9a-f]{12,}$/)
  })

  it('rejects an unknown project', async () => {
    await expect(
      manager.start({
        projectId: '00000000-0000-4000-8000-000000000000',
        agentId: 'fake',
        prompt: 'x',
      }),
    ).rejects.toThrow(SessionError)
  })

  it('fails the session, with the reason recorded, when provisioning breaks', async () => {
    const broken = new SessionManager({
      db,
      bus,
      sandbox,
      cloneUrl: () => 'git://127.0.0.1:1/nope.git',
      createAdapter: () => adapter,
    })

    const projectId = await createProject()
    const session = await broken.start({ projectId, agentId: 'fake', prompt: 'x' })
    createdSessions.push(session.id)

    await waitForStatus(session.id, 'failed')

    const [row] = await db
      .select({ errorMessage: sessions.errorMessage })
      .from(sessions)
      .where(eq(sessions.id, session.id))

    expect(row?.errorMessage).toBeTruthy()
  })
})

describe('agent events', () => {
  it('appends agent output to the session log', async () => {
    const session = await startSession()
    await waitForStatus(session.id, 'running')

    adapter.emit({ type: 'assistant_text', delta: 'working on it' })

    await expect
      .poll(async () => (await bus.replay(session.id)).length, { timeout: 5000 })
      .toBeGreaterThan(0)

    const events = await bus.replay(session.id)
    expect(events.some((event) => event.event.type === 'assistant_text')).toBe(true)
  })

  it('numbers events so a client can resume', async () => {
    const session = await startSession()
    await waitForStatus(session.id, 'running')

    for (const delta of ['a', 'b', 'c']) {
      adapter.emit({ type: 'assistant_text', delta })
    }

    await expect.poll(async () => (await bus.replay(session.id)).length, { timeout: 5000 }).toBe(3)

    expect((await bus.replay(session.id)).map((event) => event.seq)).toEqual([1, 2, 3])
  })

  it('marks the session done when the turn ends', async () => {
    const session = await startSession()
    await waitForStatus(session.id, 'running')

    adapter.emit({ type: 'done', reason: 'completed' })
    await waitForStatus(session.id, 'done', 20_000)
  })

  it('records the agent session id, which is what resume needs', async () => {
    const session = await startSession()
    await waitForStatus(session.id, 'running')

    adapter.emit({ type: 'done', reason: 'completed' })
    await waitForStatus(session.id, 'done', 20_000)

    const [row] = await db
      .select({ agentSessionId: sessions.agentSessionId })
      .from(sessions)
      .where(eq(sessions.id, session.id))

    expect(row?.agentSessionId).toBe('fake-agent-session')
  })

  it('marks the session failed when the turn ends in error', async () => {
    const session = await startSession()
    await waitForStatus(session.id, 'running')

    adapter.emit({ type: 'done', reason: 'error' })
    await waitForStatus(session.id, 'failed', 20_000)
  })
})

describe('diffs', () => {
  it('emits file changes the agent made, whatever tool it used', async () => {
    const session = await startSession()
    await waitForStatus(session.id, 'running')

    // A shell redirect, not an editor tool: the agent's own tool results would
    // not report this, which is why diffs come from git.
    const container = await sandbox.get(session.id)
    await container?.exec(['sh', '-c', 'echo changed > README.md'], { cwd: '/workspace/repo' })

    adapter.emit({ type: 'done', reason: 'completed' })
    await waitForStatus(session.id, 'done', 20_000)

    const events = await bus.replay(session.id)
    const diffs = events.filter((event) => event.event.type === 'file_diff')

    expect(diffs).toHaveLength(1)
    expect(diffs[0]?.event).toMatchObject({ path: 'README.md', after: 'changed\n' })
  })

  it('records how many files changed, for the sidebar badge', async () => {
    const session = await startSession()
    await waitForStatus(session.id, 'running')

    const container = await sandbox.get(session.id)
    await container?.exec(['sh', '-c', 'echo a > one.txt; echo b > two.txt'], {
      cwd: '/workspace/repo',
    })

    adapter.emit({ type: 'done', reason: 'completed' })
    await waitForStatus(session.id, 'done', 20_000)

    const [row] = await db
      .select({ changedFileCount: sessions.changedFileCount })
      .from(sessions)
      .where(eq(sessions.id, session.id))

    expect(row?.changedFileCount).toBe(2)
  })

  it('emits no diffs when the agent changed nothing', async () => {
    const session = await startSession()
    await waitForStatus(session.id, 'running')

    adapter.emit({ type: 'done', reason: 'completed' })
    await waitForStatus(session.id, 'done', 20_000)

    const events = await bus.replay(session.id)
    expect(events.filter((event) => event.event.type === 'file_diff')).toHaveLength(0)
  })
})

describe('prompt, interrupt, and stop', () => {
  it('delivers a follow-up prompt', async () => {
    const session = await startSession('first')
    await waitForStatus(session.id, 'running')

    await manager.prompt(session.id, 'second')
    expect(adapter.prompts.map((prompt) => prompt.text)).toEqual(['first', 'second'])
  })

  it('rejects a prompt for a session that is not running', async () => {
    await expect(manager.prompt('00000000-0000-4000-8000-000000000000', 'x')).rejects.toThrow(
      SessionError,
    )
  })

  it('interrupts a running turn', async () => {
    const session = await startSession()
    await waitForStatus(session.id, 'running')

    await manager.interrupt(session.id)
    expect(adapter.interrupted).toBe(true)
  })

  it('keeps the container after stopping, so a follow-up resumes in place', async () => {
    const session = await startSession()
    await waitForStatus(session.id, 'running')

    await manager.stop(session.id)

    // Removing it would mean re-cloning and reinstalling on the next prompt —
    // the difference between seconds and minutes.
    const container = await sandbox.get(session.id)
    expect(container).not.toBeNull()
    expect(await container?.isRunning()).toBe(false)
  })

  it('marks a stopped session stopped', async () => {
    const session = await startSession()
    await waitForStatus(session.id, 'running')

    await manager.stop(session.id)

    const [row] = await db
      .select({ status: sessions.status })
      .from(sessions)
      .where(eq(sessions.id, session.id))

    expect(row?.status).toBe('stopped')
  })

  it('leaves a finished session marked done rather than stopped', async () => {
    const session = await startSession()
    await waitForStatus(session.id, 'running')

    adapter.emit({ type: 'done', reason: 'completed' })
    await waitForStatus(session.id, 'done', 20_000)

    await manager.stop(session.id)

    const [row] = await db
      .select({ status: sessions.status })
      .from(sessions)
      .where(eq(sessions.id, session.id))

    expect(row?.status).toBe('done')
  })

  it('tolerates stopping a session that is not running', async () => {
    await expect(manager.stop('00000000-0000-4000-8000-000000000000')).resolves.toBeUndefined()
  })
})

describe('pull requests', () => {
  /** A manager whose GitHub calls are recorded rather than made. */
  function managerWithGitHub(overrides: Partial<GitHubClient> = {}) {
    const created: Parameters<GitHubClient['createPullRequest']>[0][] = []

    const github = {
      token: async () => 'gho_test',
      findPullRequest: async () => null,
      createPullRequest: async (options: Parameters<GitHubClient['createPullRequest']>[0]) => {
        created.push(options)
        return 'https://github.com/diego/dukebox/pull/1'
      },
      ...overrides,
    } as unknown as GitHubClient

    return {
      created,
      manager: new SessionManager({
        db,
        bus,
        sandbox,
        github,
        cloneUrl: () => originUrl,
        createAdapter: () => adapter,
      }),
    }
  }

  /** Start a session on a manager other than the shared one. */
  async function startOn(target: SessionManager) {
    const projectId = await createProject()
    const session = await target.start({ projectId, agentId: 'fake', prompt: 'do the thing' })
    createdSessions.push(session.id)
    await waitForStatus(session.id, 'running')
    return session
  }

  it('refuses when the session is not running', async () => {
    const { manager: withGitHub } = managerWithGitHub()

    await expect(
      withGitHub.openPullRequest('00000000-0000-4000-8000-000000000000'),
    ).rejects.toThrow(SessionError)
  })

  it('refuses when GitHub is not configured', async () => {
    const session = await startSession()
    await waitForStatus(session.id, 'running')

    await expect(manager.openPullRequest(session.id)).rejects.toThrow('not configured')
  })

  it('refuses when the agent changed nothing', async () => {
    const { manager: withGitHub } = managerWithGitHub()
    const session = await startOn(withGitHub)

    // An empty pull request wastes the reviewer's time and clutters the
    // repository's history.
    await expect(withGitHub.openPullRequest(session.id)).rejects.toThrow('nothing to open')

    await withGitHub.stopAll()
  })

  it('opens a pull request from the session branch onto the base branch', async () => {
    const { manager: withGitHub, created } = managerWithGitHub()
    const session = await startOn(withGitHub)

    const container = await sandbox.get(session.id)
    await container?.exec(['sh', '-c', 'echo changed > README.md'], { cwd: '/workspace/repo' })

    const url = await withGitHub.openPullRequest(session.id, 'Add a thing')

    expect(url).toContain('/pull/1')
    expect(created[0]).toMatchObject({
      head: session.branch || expect.stringMatching(/^duke\//),
      base: 'main',
      title: 'Add a thing',
    })

    await withGitHub.stopAll()
  })

  it('records the pull request URL on the session', async () => {
    const { manager: withGitHub } = managerWithGitHub()
    const session = await startOn(withGitHub)

    const container = await sandbox.get(session.id)
    await container?.exec(['sh', '-c', 'echo changed > README.md'], { cwd: '/workspace/repo' })

    await withGitHub.openPullRequest(session.id)

    const [row] = await db
      .select({ prUrl: sessions.prUrl })
      .from(sessions)
      .where(eq(sessions.id, session.id))

    expect(row?.prUrl).toContain('/pull/1')
    await withGitHub.stopAll()
  })

  it('reuses an existing pull request rather than opening a second', async () => {
    const created: unknown[] = []
    const { manager: withGitHub } = managerWithGitHub({
      findPullRequest: async () => 'https://github.com/diego/dukebox/pull/7',
      createPullRequest: async (options) => {
        created.push(options)
        return 'https://github.com/diego/dukebox/pull/99'
      },
    })

    const session = await startOn(withGitHub)
    const container = await sandbox.get(session.id)
    await container?.exec(['sh', '-c', 'echo changed > README.md'], { cwd: '/workspace/repo' })

    // A follow-up turn should extend the same review, not start a new one.
    const url = await withGitHub.openPullRequest(session.id)

    expect(url).toContain('/pull/7')
    expect(created).toHaveLength(0)

    await withGitHub.stopAll()
  })
})
