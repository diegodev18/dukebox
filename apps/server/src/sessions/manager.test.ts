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

  it('configures git to commit as the Dukebox identity', async () => {
    const session = await startSession()
    await waitForStatus(session.id, 'running')

    const container = await sandbox.get(session.id)
    const result = await container!.exec([
      'sh',
      '-c',
      'git config --global user.name && git config --global user.email',
    ])

    expect(result.stdout.trim().split('\n')).toEqual(['Dukebox', 'dukebox@withdiego.dev'])
  })

  it('attributes commits to that identity, not the image default', async () => {
    const session = await startSession()
    await waitForStatus(session.id, 'running')

    // The config is only worth setting if it reaches a commit: the image
    // carries its own identity, and a commit made before this is applied
    // would silently be authored by "Dukebox Agent" instead.
    const container = await sandbox.get(session.id)
    const result = await container!.exec([
      'sh',
      '-c',
      "cd /workspace/repo && git commit --allow-empty -m probe --quiet && git log -1 '--format=%an|%ae'",
    ])

    expect(result.stdout.trim()).toBe('Dukebox|dukebox@withdiego.dev')
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

    // Polled on the agent's own output rather than on the log being non-empty:
    // the prompt is already in there, so a length check passes before the
    // agent has said anything.
    await expect
      .poll(
        async () =>
          (await bus.replay(session.id)).some((event) => event.event.type === 'assistant_text'),
        { timeout: 5000 },
      )
      .toBe(true)
  })

  it('opens the log with the prompt that started the session', async () => {
    // The first prompt is sent while the session provisions, so this log is the
    // only place it is ever recorded.
    const session = await startSession('rename the widget')
    await waitForStatus(session.id, 'running')

    await expect
      .poll(async () => (await bus.replay(session.id)).length, { timeout: 5000 })
      .toBeGreaterThan(0)

    const [first] = await bus.replay(session.id)
    expect(first?.event).toMatchObject({ type: 'user_prompt', text: 'rename the widget' })
  })

  it('numbers events so a client can resume', async () => {
    const session = await startSession()
    await waitForStatus(session.id, 'running')

    for (const delta of ['a', 'b', 'c']) {
      adapter.emit({ type: 'assistant_text', delta })
    }

    // Four, not three: the prompt that started the session is the first event
    // in the log, ahead of anything the agent produced in reply to it.
    await expect.poll(async () => (await bus.replay(session.id)).length, { timeout: 5000 }).toBe(4)

    expect((await bus.replay(session.id)).map((event) => event.seq)).toEqual([1, 2, 3, 4])
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

  it('records a follow-up prompt in the log, so it survives a reload', async () => {
    const session = await startSession('first')
    await waitForStatus(session.id, 'running')

    await manager.prompt(session.id, 'second')

    const prompts = (await bus.replay(session.id))
      .map((event) => event.event)
      .filter((event) => event.type === 'user_prompt')

    expect(prompts).toMatchObject([{ text: 'first' }, { text: 'second' }])
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

describe('terminals', () => {
  it('opens a shell in a running session', async () => {
    const session = await startSession()
    await waitForStatus(session.id, 'running')

    const terminal = await manager.openTerminal(session.id, { cols: 80, rows: 24 })

    const chunks: Buffer[] = []
    terminal.stream.on('data', (chunk: Buffer) => chunks.push(chunk))
    terminal.stream.write('printf TERMINAL-READY\n')

    const deadline = Date.now() + 20_000
    while (Date.now() < deadline && !Buffer.concat(chunks).includes('TERMINAL-READY')) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    expect(Buffer.concat(chunks).toString()).toContain('TERMINAL-READY')

    await terminal.close()
  })

  it('refuses when the session is not running', async () => {
    await expect(
      manager.openTerminal('00000000-0000-4000-8000-000000000000', { cols: 80, rows: 24 }),
    ).rejects.toThrow(SessionError)
  })

  it('tells the terminal registry when a session stops', async () => {
    const stopped: string[] = []

    // A separate manager so the hook can be observed. The shared one in
    // beforeEach is built without it.
    const watched = new SessionManager({
      db,
      bus,
      sandbox,
      cloneUrl: () => originUrl,
      createAdapter: () => adapter,
      onSessionStopped: async (sessionId) => {
        stopped.push(sessionId)
      },
    })

    const projectId = await createProject()
    const session = await watched.start({ projectId, agentId: 'fake', prompt: 'do the thing' })
    createdSessions.push(session.id)
    await waitForStatus(session.id, 'running')

    await watched.stop(session.id)

    expect(stopped).toEqual([session.id])
  })
})

describe('pull requests', () => {
  /** A manager whose GitHub calls are recorded rather than made. */
  function managerWithGitHub(overrides: Partial<GitHubClient> = {}) {
    const created: Parameters<GitHubClient['createPullRequest']>[0][] = []

    const github = {
      token: async () => 'gho_test',
      findPullRequest: async () => null,
      // Reachable unless a test says otherwise: a push failure checks this to
      // tell a missing repository from a credential problem.
      defaultBranch: async () => 'main',
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

  it('resumes a session the control plane has forgotten', async () => {
    // A restart empties the in-memory map while the containers stay on disk.
    // A second manager over the same database is what that looks like.
    const { manager: first } = managerWithGitHub()
    const session = await startOn(first)

    const { manager: afterRestart } = managerWithGitHub()
    await afterRestart.prompt(session.id, 'carry on')

    expect(adapter.prompts.at(-1)?.text).toBe('carry on')
    await afterRestart.stopAll()
  })

  it('opens a pull request on a session it had to resume', async () => {
    // The path that failed in practice: restart, then ask for a pull request
    // on work the agent did before it.
    const { manager: first } = managerWithGitHub()
    const session = await startOn(first)

    const container = await sandbox.get(session.id)
    await container?.exec(['sh', '-c', 'echo hola > README.es.md'], { cwd: '/workspace/repo' })

    const { manager: afterRestart } = managerWithGitHub()
    await afterRestart.prompt(session.id, 'anything')

    const url = await afterRestart.openPullRequest(session.id)

    expect(url).toContain('/pull/1')
    await afterRestart.stopAll()
  })

  it('opens one for a session that predates the stored base commit', async () => {
    // Sessions started before base_commit existed have it null. Falling back
    // to HEAD measures the branch against the agent's own commit and finds
    // nothing, which refused a pull request for work sitting on the branch.
    const { manager: first } = managerWithGitHub()
    const session = await startOn(first)

    const container = await sandbox.get(session.id)
    await container?.exec(['sh', '-c', 'echo hola > README.es.md'], { cwd: '/workspace/repo' })
    await container?.exec(['git', 'add', '-A'], { cwd: '/workspace/repo' })
    await container?.exec(['git', 'commit', '-m', 'Translate'], { cwd: '/workspace/repo' })

    // What an older row looks like.
    await db.update(sessions).set({ baseCommit: null }).where(eq(sessions.id, session.id))

    const { manager: afterRestart } = managerWithGitHub()
    const url = await afterRestart.openPullRequest(session.id)

    expect(url).toContain('/pull/1')
    await afterRestart.stopAll()
  })

  it('names an unreachable repository rather than blaming credentials', async () => {
    // GitHub refuses a repository you cannot see exactly as it refuses one
    // that does not exist, and git reports both as an authentication failure.
    // Someone whose repository was renamed should not be sent to check a token.
    const { manager: withGitHub } = managerWithGitHub({
      defaultBranch: async () => {
        throw new Error('gh: Could not resolve to a Repository')
      },
    })

    const session = await startOn(withGitHub)
    const container = await sandbox.get(session.id)
    await container?.exec(['sh', '-c', 'echo changed > README.md'], { cwd: '/workspace/repo' })
    await container?.exec(['git', 'remote', 'set-url', 'origin', '/nonexistent/repo.git'], {
      cwd: '/workspace/repo',
    })

    await expect(withGitHub.openPullRequest(session.id)).rejects.toThrow(
      /could not be reached on GitHub/,
    )

    await withGitHub.stopAll()
  })

  it("includes git's own words when a push fails", async () => {
    // "command failed: git push ..." names what ran and not what went wrong,
    // which sends someone looking in the wrong place.
    const { manager: withGitHub } = managerWithGitHub()
    const session = await startOn(withGitHub)

    const container = await sandbox.get(session.id)
    await container?.exec(['sh', '-c', 'echo changed > README.md'], { cwd: '/workspace/repo' })
    // A remote that cannot be reached is the shape of every real push failure.
    await container?.exec(['git', 'remote', 'set-url', 'origin', '/nonexistent/repo.git'], {
      cwd: '/workspace/repo',
    })

    await expect(withGitHub.openPullRequest(session.id)).rejects.toThrow(/could not push/)

    await withGitHub.stopAll()
  })

  it('says so when the container is gone rather than reporting it not running', async () => {
    // Without a container there is no workspace to resume into, and the two
    // send someone to different places: wait, or start over.
    const { manager: afterRestart } = managerWithGitHub()
    const projectId = await createProject()

    const [orphan] = await db
      .insert(sessions)
      .values({
        projectId,
        agentId: 'fake',
        title: 'Gone',
        baseBranch: 'main',
        branch: 'duke/gone',
        status: 'done',
      })
      .returning()

    await expect(afterRestart.prompt(orphan!.id, 'hello')).rejects.toThrow(/no longer exists/)
  })

  it('opens one for work the agent committed itself', async () => {
    // Agents commit as they go. Asking whether anything is *uncommitted* makes
    // that look identical to an agent that did nothing, which refused a pull
    // request for work that was sitting right there on the branch.
    const { manager: withGitHub } = managerWithGitHub()
    const session = await startOn(withGitHub)

    const container = await sandbox.get(session.id)
    await container?.exec(['sh', '-c', 'echo translated > README.es.md'], {
      cwd: '/workspace/repo',
    })
    await container?.exec(['git', 'add', '-A'], { cwd: '/workspace/repo' })
    await container?.exec(['git', 'commit', '-m', 'Translate the README'], {
      cwd: '/workspace/repo',
    })

    const url = await withGitHub.openPullRequest(session.id)

    expect(url).toContain('/pull/1')
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

describe('project environment on coding sessions', () => {
  it('runs saved setup commands and injects env before the agent starts', async () => {
    const projectId = await createProject()
    await db
      .update(projects)
      .set({
        configOverride: {
          setup: ['touch /tmp/dukebox-setup-ran', 'echo ok > /tmp/dukebox-setup-marker'],
          env: { DUKEBOX_TEST_ENV: 'from-config' },
        },
      })
      .where(eq(projects.id, projectId))

    const session = await manager.start({
      projectId,
      agentId: 'fake',
      prompt: 'use the environment',
    })
    createdSessions.push(session.id)

    await waitForStatus(session.id, 'running')

    const container = await sandbox.get(session.id)
    expect(container).toBeTruthy()

    const marker = await container!.exec(['cat', '/tmp/dukebox-setup-marker'])
    expect(marker.exitCode).toBe(0)
    expect(marker.stdout.trim()).toBe('ok')

    const env = await container!.exec(['printenv', 'DUKEBOX_TEST_ENV'])
    expect(env.stdout.trim()).toBe('from-config')

    expect(adapter.started).toBeTruthy()
  }, 120_000)

  it('fails the session when a setup command fails', async () => {
    const projectId = await createProject()
    await db
      .update(projects)
      .set({
        configOverride: {
          setup: ['false'],
          env: {},
        },
      })
      .where(eq(projects.id, projectId))

    const session = await manager.start({
      projectId,
      agentId: 'fake',
      prompt: 'should not reach the agent',
    })
    createdSessions.push(session.id)

    await waitForStatus(session.id, 'failed')
    expect(adapter.started).toBeUndefined()
  }, 120_000)

  it('skips project setup for environment_setup sessions', async () => {
    const projectId = await createProject()
    await db
      .update(projects)
      .set({
        configOverride: {
          setup: ['touch /tmp/should-not-run'],
          env: {},
        },
      })
      .where(eq(projects.id, projectId))

    const session = await manager.start({
      projectId,
      agentId: 'fake',
      purpose: 'environment_setup',
    })
    createdSessions.push(session.id)

    expect(session.purpose).toBe('environment_setup')
    expect(session.title).toBe('Configure environment')

    await waitForStatus(session.id, 'running')

    const container = await sandbox.get(session.id)
    const check = await container!.exec(['test', '-f', '/tmp/should-not-run'])
    expect(check.exitCode).not.toBe(0)

    // Write a proposal as the agent would, then finish the turn.
    await container!.exec([
      'sh',
      '-c',
      `printf '%s' '{"setup":["pnpm install"],"env":{"DATABASE_URL":{"secret":true}}}' > /tmp/dukebox-env-proposal.json`,
    ])

    adapter.emit({ type: 'done', reason: 'completed' })
    await waitForStatus(session.id, 'done')

    const [project] = await db.select().from(projects).where(eq(projects.id, projectId))
    expect(project?.environmentDraft).toMatchObject({
      setup: ['pnpm install'],
      env: { DATABASE_URL: { secret: true } },
    })
  }, 120_000)
})
