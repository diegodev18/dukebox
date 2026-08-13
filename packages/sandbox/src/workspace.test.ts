import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Sandbox, type SessionContainer } from './container.js'
import {
  sessionBranch,
  Workspace,
  WorkspaceError,
  WORKSPACE_DIR,
  resolveWorkspacePath,
} from './workspace.js'

describe('sessionBranch', () => {
  it('namespaces the branch so its origin is obvious in GitHub', () => {
    expect(sessionBranch('3f9a2b1c-0000-4000-8000-000000000000')).toBe('duke/3f9a2b1c')
  })

  it('is stable for a given session', () => {
    const id = randomUUID()
    expect(sessionBranch(id)).toBe(sessionBranch(id))
  })
})

describe('resolveWorkspacePath', () => {
  it('accepts a relative file path', () => {
    expect(resolveWorkspacePath('src/app.ts')).toBe('src/app.ts')
  })

  it('strips redundant slashes and dots', () => {
    expect(resolveWorkspacePath('./src//app.ts')).toBe('src/app.ts')
  })

  it('rejects parent-directory segments', () => {
    expect(resolveWorkspacePath('../secret')).toBeNull()
    expect(resolveWorkspacePath('src/../../etc/passwd')).toBeNull()
  })

  it('rejects absolute paths', () => {
    expect(resolveWorkspacePath('/etc/passwd')).toBeNull()
    expect(resolveWorkspacePath('C:\\Windows\\system.ini')).toBeNull()
  })

  it('rejects empty paths and NULs', () => {
    expect(resolveWorkspacePath('')).toBeNull()
    expect(resolveWorkspacePath('foo\0bar')).toBeNull()
    expect(resolveWorkspacePath('.')).toBeNull()
  })
})

/**
 * Integration tests against a real container.
 *
 * The origin repository is created inside the container rather than cloned
 * from GitHub: these tests exercise our git handling, and reaching the network
 * would make them slow and dependent on someone else's uptime.
 */
describe('Workspace', () => {
  const sandbox = new Sandbox()
  const image = process.env.DUKEBOX_TEST_IMAGE ?? 'dukebox/base-node:latest'
  const sessionIds: string[] = []

  const ORIGIN_DIR = '/tmp/origin.git'

  let container: SessionContainer
  let workspace: Workspace

  /** Create a bare repository with one commit to clone from. */
  async function seedOrigin(target: SessionContainer) {
    const script = `
      set -e
      rm -rf /tmp/seed ${ORIGIN_DIR}
      mkdir -p /tmp/seed
      cd /tmp/seed
      git init -q -b main
      echo "original" > README.md
      echo "value" > keep.txt
      git add -A
      git commit -q -m "initial"
      git clone -q --bare /tmp/seed ${ORIGIN_DIR}
    `
    const result = await target.exec(['sh', '-c', script])
    if (result.exitCode !== 0) {
      throw new Error(`failed to seed origin: ${result.stderr}`)
    }
  }

  async function freshWorkspace() {
    const sessionId = randomUUID()
    sessionIds.push(sessionId)

    const target = await sandbox.create({ sessionId, image })
    await seedOrigin(target)

    const ws = new Workspace(target)
    await ws.clone({ url: ORIGIN_DIR, baseBranch: 'main', sessionId })

    return { container: target, workspace: ws, sessionId }
  }

  beforeAll(async () => {
    const created = await freshWorkspace()
    container = created.container
    workspace = created.workspace
  })

  afterAll(async () => {
    for (const sessionId of sessionIds) {
      const found = await sandbox.get(sessionId)
      await found?.remove()
    }
  })

  describe('clone', () => {
    it('checks out the repository contents', async () => {
      const result = await container.exec(['cat', 'README.md'], { cwd: WORKSPACE_DIR })
      expect(result.stdout.trim()).toBe('original')
    })

    it('switches to the session branch, leaving the base branch untouched', async () => {
      const result = await container.exec(['git', 'branch', '--show-current'], {
        cwd: WORKSPACE_DIR,
      })
      expect(result.stdout.trim()).toMatch(/^duke\//)
    })

    it('fails loudly when the base branch does not exist', async () => {
      const sessionId = randomUUID()
      sessionIds.push(sessionId)
      const target = await sandbox.create({ sessionId, image })
      await seedOrigin(target)

      const ws = new Workspace(target)
      await expect(
        ws.clone({ url: ORIGIN_DIR, baseBranch: 'does-not-exist', sessionId }),
      ).rejects.toThrow(WorkspaceError)
    })
  })

  describe('runSetup', () => {
    it('runs commands in the repository directory', async () => {
      await workspace.runSetup(['pwd > /tmp/setup-cwd'])
      const result = await container.exec(['cat', '/tmp/setup-cwd'])
      expect(result.stdout.trim()).toBe(WORKSPACE_DIR)
    })

    it('runs commands through a shell so operators work', async () => {
      await workspace.runSetup(['true && echo chained > /tmp/chained'])
      const result = await container.exec(['cat', '/tmp/chained'])
      expect(result.stdout.trim()).toBe('chained')
    })

    it('passes environment variables through', async () => {
      await workspace.runSetup(['echo "$SETUP_VAR" > /tmp/setup-env'], { SETUP_VAR: 'present' })
      const result = await container.exec(['cat', '/tmp/setup-env'])
      expect(result.stdout.trim()).toBe('present')
    })

    it('stops at the first failing command', async () => {
      await expect(
        workspace.runSetup(['exit 1', 'echo unreachable > /tmp/unreachable']),
      ).rejects.toThrow(WorkspaceError)

      const result = await container.exec(['cat', '/tmp/unreachable'])
      expect(result.exitCode).not.toBe(0)
    })

    it('reports stderr from the failing command', async () => {
      await expect(workspace.runSetup(['echo "boom" >&2; exit 2'])).rejects.toMatchObject({
        stderr: expect.stringContaining('boom'),
        exitCode: 2,
      })
    })
  })

  describe('diffEvents', () => {
    it('detects a modified file with its before and after contents', async () => {
      const { workspace: ws, container: target } = await freshWorkspace()
      const base = await ws.headCommit()

      await target.exec(['sh', '-c', 'echo "modified" > README.md'], { cwd: WORKSPACE_DIR })

      const events = await ws.diffEvents(base)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        type: 'file_diff',
        path: 'README.md',
        before: 'original\n',
        after: 'modified\n',
      })
    })

    it('detects a created file, which git diff alone would miss', async () => {
      const { workspace: ws, container: target } = await freshWorkspace()
      const base = await ws.headCommit()

      await target.exec(['sh', '-c', 'echo "new" > created.txt'], { cwd: WORKSPACE_DIR })

      const events = await ws.diffEvents(base)
      expect(events).toContainEqual({
        type: 'file_diff',
        path: 'created.txt',
        before: null,
        after: 'new\n',
      })
    })

    it('detects a deleted file', async () => {
      const { workspace: ws, container: target } = await freshWorkspace()
      const base = await ws.headCommit()

      await target.exec(['rm', 'keep.txt'], { cwd: WORKSPACE_DIR })

      const events = await ws.diffEvents(base)
      expect(events).toContainEqual({
        type: 'file_diff',
        path: 'keep.txt',
        before: 'value\n',
        after: null,
      })
    })

    it('sees changes made by a shell redirect, not just by an editor tool', async () => {
      const { workspace: ws, container: target } = await freshWorkspace()
      const base = await ws.headCommit()

      // The reason diffs come from git: an agent can change files in ways its
      // own tool results never report.
      await target.exec(['sh', '-c', 'printf "appended\\n" >> README.md'], { cwd: WORKSPACE_DIR })

      const events = await ws.diffEvents(base)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ path: 'README.md', after: 'original\nappended\n' })
    })

    it('ignores a file rewritten with identical contents', async () => {
      const { workspace: ws, container: target } = await freshWorkspace()
      const base = await ws.headCommit()

      await target.exec(['sh', '-c', 'echo "original" > README.md'], { cwd: WORKSPACE_DIR })

      expect(await ws.diffEvents(base)).toHaveLength(0)
    })

    it('returns nothing when the workspace is untouched', async () => {
      const { workspace: ws } = await freshWorkspace()
      const base = await ws.headCommit()
      expect(await ws.diffEvents(base)).toHaveLength(0)
    })

    it('reports every changed path', async () => {
      const { workspace: ws, container: target } = await freshWorkspace()
      const base = await ws.headCommit()

      await target.exec(['sh', '-c', 'echo a > README.md; echo b > added.txt; rm keep.txt'], {
        cwd: WORKSPACE_DIR,
      })

      const paths = (await ws.diffEvents(base)).map((event) =>
        event.type === 'file_diff' ? event.path : '',
      )
      expect(paths.sort()).toEqual(['README.md', 'added.txt', 'keep.txt'])
    })
  })

  describe('setCommitIdentity', () => {
    it('authors commits as whoever the session names', async () => {
      const { workspace, container } = await freshWorkspace()
      await workspace.setCommitIdentity({ name: 'Diego', email: 'diego@example.com' })

      await container.exec(['sh', '-c', 'echo changed > README.md'], { cwd: WORKSPACE_DIR })
      await workspace.commitAll('A change')

      const author = await container.exec(['git', 'log', '-1', '--format=%an <%ae>'], {
        cwd: WORKSPACE_DIR,
      })

      expect(author.stdout.trim()).toBe('Diego <diego@example.com>')
    })

    it('leaves the image default in place when never called', async () => {
      // A session that names nobody still commits as something identifiable
      // rather than failing on git's "please tell me who you are".
      const { workspace, container } = await freshWorkspace()

      await container.exec(['sh', '-c', 'echo changed > README.md'], { cwd: WORKSPACE_DIR })
      await workspace.commitAll('A change')

      const author = await container.exec(['git', 'log', '-1', '--format=%an'], {
        cwd: WORKSPACE_DIR,
      })

      expect(author.stdout.trim()).not.toBe('')
    })
  })

  describe('installCredentialHelper', () => {
    it('makes git send the repository with every credential request', async () => {
      // Without `useHttpPath` git asks only "protocol=https, host=github.com".
      // The proxy cannot tell which repository that is about, so it refuses —
      // and every push fails while every check on the helper looks correct,
      // because a check that sends a path gets an answer.
      const { workspace, container } = await freshWorkspace()
      await workspace.installCredentialHelper()

      const result = await container.exec([
        'git',
        'config',
        '--global',
        '--get',
        'credential.useHttpPath',
      ])

      expect(result.stdout.trim()).toBe('true')
    })
  })

  describe('diagnoseCredentials', () => {
    it('names each thing that is missing', async () => {
      // A container with no helper and no socket: the report has to say which,
      // because git's own failure says neither.
      const { workspace } = await freshWorkspace()

      const report = await workspace.diagnoseCredentials(
        '/home/node/.dukebox/credential-helper',
        '/run/dukebox/credentials.sock',
        'diego/dukebox',
      )

      expect(report).toContain('helper configured: NO')
      expect(report).toContain('socket present: NO')
      expect(report).toContain('helper answers: NO')
    })

    it('reports a helper that is installed', async () => {
      const { workspace } = await freshWorkspace()
      await workspace.installCredentialHelper()

      const report = await workspace.diagnoseCredentials(
        '/home/node/.dukebox/credential-helper',
        '/run/dukebox/credentials.sock',
        'diego/dukebox',
      )

      expect(report).toContain('helper configured: yes')
      expect(report).toContain('helper executable: yes')
      // Still no socket, which is exactly the distinction worth drawing.
      expect(report).toContain('socket present: NO')
    })
  })

  describe('credentialSocketReachable', () => {
    it('is false when nothing is at the path', async () => {
      const { workspace } = await freshWorkspace()
      expect(await workspace.credentialSocketReachable('/run/dukebox/credentials.sock')).toBe(false)
    })

    it('is false for a regular file, which cannot serve credentials', async () => {
      // A bind mount pointing at a replaced directory can leave something that
      // is not a socket. git's own error names neither.
      const { workspace, container } = await freshWorkspace()
      await container.exec(['sh', '-c', 'mkdir -p /run/dukebox && touch /run/dukebox/notasocket'])

      expect(await workspace.credentialSocketReachable('/run/dukebox/notasocket')).toBe(false)
    })
  })

  describe('commitAll', () => {
    it('commits changes and returns the new head', async () => {
      const { workspace: ws, container: target } = await freshWorkspace()
      const before = await ws.headCommit()

      await target.exec(['sh', '-c', 'echo changed > README.md'], { cwd: WORKSPACE_DIR })
      const after = await ws.commitAll('agent changes')

      expect(after).not.toBeNull()
      expect(after).not.toBe(before)
    })

    it('includes newly created files', async () => {
      const { workspace: ws, container: target } = await freshWorkspace()
      await target.exec(['sh', '-c', 'echo new > created.txt'], { cwd: WORKSPACE_DIR })

      await ws.commitAll('add file')

      const result = await target.exec(['git', 'ls-files', 'created.txt'], { cwd: WORKSPACE_DIR })
      expect(result.stdout.trim()).toBe('created.txt')
    })

    it('returns null when there is nothing to commit', async () => {
      const { workspace: ws } = await freshWorkspace()
      expect(await ws.commitAll('no changes')).toBeNull()
    })
  })
})
