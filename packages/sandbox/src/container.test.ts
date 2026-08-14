import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import {
  clampTerminalSize,
  cpuQuota,
  DEFAULT_LIMITS,
  parseMemory,
  Sandbox,
  SESSION_LABEL,
  toBind,
} from '@/container'

describe('parseMemory', () => {
  it.each([
    ['4g', 4 * 1024 ** 3],
    ['512m', 512 * 1024 ** 2],
    ['1024k', 1024 * 1024],
    ['2G', 2 * 1024 ** 3],
    ['1gb', 1024 ** 3],
    ['1024', 1024],
  ])('parses %s', (input, expected) => {
    expect(parseMemory(input)).toBe(expected)
  })

  it.each(['', 'lots', '4x', '-1g'])('rejects %s', (input) => {
    expect(() => parseMemory(input)).toThrow()
  })
})

describe('cpuQuota', () => {
  it('converts whole cores to a quota over the standard period', () => {
    expect(cpuQuota('2')).toEqual({ period: 100_000, quota: 200_000 })
  })

  it('supports fractional cores', () => {
    expect(cpuQuota('0.5')).toEqual({ period: 100_000, quota: 50_000 })
  })

  it.each(['0', '-1', 'many', ''])('rejects %s', (input) => {
    expect(() => cpuQuota(input)).toThrow()
  })
})

describe('toBind', () => {
  it('formats a writable bind', () => {
    expect(toBind({ source: '/var/run/git-cred.sock', target: '/run/git-cred.sock' })).toBe(
      '/var/run/git-cred.sock:/run/git-cred.sock',
    )
  })

  it('marks a read-only bind', () => {
    expect(
      toBind({ source: '/var/run/git-cred.sock', target: '/run/git-cred.sock', readOnly: true }),
    ).toBe('/var/run/git-cred.sock:/run/git-cred.sock:ro')
  })

  it.each(['/var/run/docker.sock', '/proc', '/proc/1', '/sys', '/'])(
    'refuses to mount %s',
    (source) => {
      expect(() => toBind({ source, target: '/mnt' })).toThrow(/refusing to mount/)
    },
  )
})

describe('clampTerminalSize', () => {
  it('floors a measured 0×0 PTY to the xterm default', () => {
    expect(clampTerminalSize(0, 0)).toEqual({ cols: 80, rows: 24 })
  })

  it('rejects a non-finite column count', () => {
    expect(clampTerminalSize(Number.NaN, 12)).toEqual({ cols: 80, rows: 12 })
  })

  it('drops a fractional layout measurement', () => {
    expect(clampTerminalSize(80.9, 24.2)).toEqual({ cols: 80, rows: 24 })
  })
})

/**
 * Integration tests against a real Docker daemon.
 *
 * The security assertions here are the reason these are not mocked: the point
 * is that the daemon actually applied the hardening, not that we asked for it.
 */
describe('Sandbox', () => {
  const sandbox = new Sandbox()
  const image = process.env.DUKEBOX_TEST_IMAGE ?? 'dukebox/base-node:latest'
  const created: string[] = []

  async function createSession() {
    const sessionId = randomUUID()
    created.push(sessionId)
    return sandbox.create({ sessionId, image })
  }

  afterAll(async () => {
    // Remove only what these tests created; other containers on this host are
    // not ours to touch.
    for (const sessionId of created) {
      const container = await sandbox.get(sessionId)
      await container?.remove()
    }
  })

  it('reaches the Docker daemon', async () => {
    await expect(sandbox.ping()).resolves.not.toThrow()
  })

  it('starts a container that is running', async () => {
    const container = await createSession()
    expect(await container.isRunning()).toBe(true)
  })

  it('runs a command and captures stdout', async () => {
    const container = await createSession()
    const result = await container.exec(['echo', 'hello'])

    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('hello')
    expect(result.stderr).toBe('')
  })

  it('separates stderr from stdout', async () => {
    const container = await createSession()
    const result = await container.exec(['sh', '-c', 'echo out; echo err >&2'])

    // Docker interleaves both channels in one framed stream. If demuxing were
    // wrong, stderr would appear spliced into stdout.
    expect(result.stdout.trim()).toBe('out')
    expect(result.stderr.trim()).toBe('err')
  })

  describe('execStream', () => {
    /** Read everything a stream produces, then resolve. */
    async function collect(stream: NodeJS.ReadableStream): Promise<string> {
      let output = ''
      for await (const chunk of stream) output += chunk.toString()
      return output
    }

    it('strips the frame headers Docker adds', async () => {
      const container = await createSession()
      const stream = await container.execStream(['sh', '-c', `printf '%s\\n' '{"type":"hello"}'`])

      // Docker frames a TTY-less exec with an 8-byte header per chunk. Handed
      // the raw stream, a JSONL reader sees binary before every `{` and
      // rejects every line the agent emits — which is exactly how a real
      // session failed.
      const output = await collect(stream)

      expect(() => JSON.parse(output.trim())).not.toThrow()
      expect(JSON.parse(output.trim())).toEqual({ type: 'hello' })
    })

    it('keeps multi-line output parseable line by line', async () => {
      const container = await createSession()
      const stream = await container.execStream([
        'sh',
        '-c',
        `printf '%s\\n' '{"n":1}' '{"n":2}' '{"n":3}'`,
      ])

      const lines = (await collect(stream)).trim().split('\n')

      expect(lines).toHaveLength(3)
      expect(lines.map((line) => JSON.parse(line))).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
    })

    it('carries what is written to it through to the process', async () => {
      const container = await createSession()
      const stream = await container.execStream(['cat'])

      stream.write('echoed back\n')
      stream.end()

      // The agent is driven this way for a whole session: prompts in, events
      // out, over one long-lived process.
      expect(await collect(stream)).toContain('echoed back')
    })

    it('excludes stderr, so diagnostics cannot corrupt the event stream', async () => {
      const container = await createSession()
      const stream = await container.execStream([
        'sh',
        '-c',
        `printf '%s\\n' '{"real":true}'; printf 'a warning\\n' >&2`,
      ])

      const output = await collect(stream)

      expect(output).toContain('{"real":true}')
      expect(output).not.toContain('a warning')
    })

    it('ends when the process exits', async () => {
      const container = await createSession()
      const stream = await container.execStream(['sh', '-c', 'echo done'])

      // Without this the consumer would wait forever on a process that is
      // already gone.
      await expect(collect(stream)).resolves.toContain('done')
    })

    it('leaves stdin closed when asked, so a process that reads it does not hang', async () => {
      const container = await createSession()
      const stream = await container.execStream(['cat'], { stdin: false })

      // `cat` with an attached stdin that never closes is the OpenCode hang:
      // the process waits forever for EOF. Closed stdin makes it exit.
      await expect(collect(stream)).resolves.toBe('')
    })
  })

  describe('openTerminal', () => {
    /** Poll until a condition holds, so a test never depends on a fixed sleep. */
    async function waitFor(condition: () => boolean, timeoutMs = 15_000): Promise<void> {
      const deadline = Date.now() + timeoutMs

      while (Date.now() < deadline) {
        if (condition()) return
        await new Promise((resolve) => setTimeout(resolve, 50))
      }

      throw new Error('timed out waiting for condition')
    }

    it('runs an interactive shell and echoes what is written to it', async () => {
      const container = await createSession()
      const terminal = await container.openTerminal({ cols: 80, rows: 24 })

      const chunks: Buffer[] = []
      terminal.stream.on('data', (chunk: Buffer) => chunks.push(chunk))

      terminal.stream.write('echo dukebox-terminal-works\n')

      // A shell prints a prompt, echoes the line, then prints the output, and
      // none of that arrives in one chunk. Polling for the marker is what makes
      // this deterministic without guessing at a sleep.
      await waitFor(() => Buffer.concat(chunks).includes('dukebox-terminal-works'))

      await terminal.close()
    })

    it('does not paint multiplex headers on a TTY exec', async () => {
      const container = await createSession()
      const terminal = await container.openTerminal({ cols: 80, rows: 24 })

      const chunks: Buffer[] = []
      terminal.stream.on('data', (chunk: Buffer) => chunks.push(chunk))

      terminal.stream.write('printf MARKER\n')
      await waitFor(() => Buffer.concat(chunks).includes('MARKER'))

      // A TTY exec is a raw PTY stream. Multiplex headers (`[1, 0, 0, 0, …]`)
      // belong to TTY-less execs; left in, they reach the emulator as garbage.
      expect(Buffer.concat(chunks).includes(Buffer.from([1, 0, 0, 0]))).toBe(false)

      await terminal.close()
    })

    it('returns output from ls, which forks and writes to the PTY', async () => {
      const container = await createSession()
      await container.exec(['sh', '-c', 'echo listed-file > /tmp/listed-file'])
      const terminal = await container.openTerminal({ cols: 80, rows: 24, cwd: '/tmp' })

      const chunks: Buffer[] = []
      terminal.stream.on('data', (chunk: Buffer) => chunks.push(chunk))

      // `ls` is the command that hung when start() omitted Tty: a builtin like
      // `cd` never forks, so it kept working while anything that wrote from a
      // child process was stopped with SIGTTOU.
      terminal.stream.write('ls\n')
      await waitFor(() => Buffer.concat(chunks).includes('listed-file'))

      await terminal.close()
    })

    it('interleaves stderr with stdout, as a screen does', async () => {
      const container = await createSession()
      const terminal = await container.openTerminal({ cols: 80, rows: 24 })

      const chunks: Buffer[] = []
      terminal.stream.on('data', (chunk: Buffer) => chunks.push(chunk))

      // Unlike execStream, which drops stderr to keep a JSONL stream parseable,
      // a terminal has to show it: a build's warnings belong beside its output,
      // not discarded.
      terminal.stream.write('printf OUT; printf ERRTEXT >&2\n')
      await waitFor(() => Buffer.concat(chunks).includes('ERRTEXT'))

      expect(Buffer.concat(chunks).toString()).toContain('OUT')

      await terminal.close()
    })

    it('reports a size change without throwing', async () => {
      const container = await createSession()
      const terminal = await container.openTerminal({ cols: 80, rows: 24 })

      await expect(terminal.resize(120, 40)).resolves.toBeUndefined()
      // A hidden panel measures 0×0; that size must not reach the PTY.
      await expect(terminal.resize(0, 0)).resolves.toBeUndefined()

      await terminal.close()
    })
  })

  it('reports a non-zero exit code', async () => {
    const container = await createSession()
    const result = await container.exec(['sh', '-c', 'exit 3'])
    expect(result.exitCode).toBe(3)
  })

  it('runs commands in a given directory', async () => {
    const container = await createSession()
    const result = await container.exec(['pwd'], { cwd: '/tmp' })
    expect(result.stdout.trim()).toBe('/tmp')
  })

  it('passes environment variables to commands', async () => {
    const container = await createSession()
    const result = await container.exec(['sh', '-c', 'echo $DUKEBOX_TEST'], {
      env: { DUKEBOX_TEST: 'value' },
    })
    expect(result.stdout.trim()).toBe('value')
  })

  it('runs as a non-root user', async () => {
    const container = await createSession()
    const result = await container.exec(['id', '-u'])

    // Root inside a container is a short step from root on the host.
    expect(result.stdout.trim()).not.toBe('0')
  })

  it('applies resource limits the daemon reports back', async () => {
    const container = await createSession()
    const info = await container.inspect()

    expect(info.HostConfig.Memory).toBe(parseMemory(DEFAULT_LIMITS.memory))
    expect(info.HostConfig.PidsLimit).toBe(DEFAULT_LIMITS.pids)
    expect(info.HostConfig.CpuQuota).toBe(cpuQuota(DEFAULT_LIMITS.cpus).quota)
  })

  it('is not privileged and cannot gain new privileges', async () => {
    const container = await createSession()
    const info = await container.inspect()

    expect(info.HostConfig.Privileged).toBe(false)
    expect(info.HostConfig.SecurityOpt).toContain('no-new-privileges')
    expect(info.HostConfig.CapDrop).toContain('ALL')
  })

  it('never has the Docker socket mounted', async () => {
    const container = await createSession()
    const info = await container.inspect()

    // The single most important assertion in this file: a container holding
    // the daemon socket can start a privileged container and own the host.
    const mounts = info.HostConfig.Binds ?? []
    expect(mounts.some((bind) => bind.includes('docker.sock'))).toBe(false)
  })

  it.each([
    ['the Docker socket', '/var/run/docker.sock'],
    ['a Docker socket elsewhere', '/tmp/nested/docker.sock'],
    ['the proc filesystem', '/proc'],
    ['the sys filesystem', '/sys/fs/cgroup'],
    ['the host root', '/'],
  ])('refuses to mount %s', async (_label, source) => {
    // Rejected before the container is created, so a mistake in calling code
    // cannot produce a container that owns the host.
    await expect(
      sandbox.create({
        sessionId: randomUUID(),
        image,
        mounts: [{ source, target: '/mnt/whatever' }],
      }),
    ).rejects.toThrow('refusing to mount')
  })

  it('allows an ordinary mount, such as the credential socket', async () => {
    const sessionId = randomUUID()
    created.push(sessionId)

    const container = await sandbox.create({
      sessionId,
      image,
      mounts: [{ source: '/tmp', target: '/mnt/host-tmp', readOnly: true }],
    })

    const info = await container.inspect()
    expect(info.HostConfig.Binds).toContain('/tmp:/mnt/host-tmp:ro')
  })

  it('has no network access by default', async () => {
    const container = await createSession()
    const info = await container.inspect()
    expect(info.HostConfig.NetworkMode).toBe('none')
  })

  it('does not restart on its own', async () => {
    const container = await createSession()
    const info = await container.inspect()

    // A restart policy would resurrect a session the control plane believes
    // has ended.
    expect(info.HostConfig.RestartPolicy?.Name).toBe('no')
  })

  it('labels containers so they can be found again', async () => {
    const container = await createSession()
    const info = await container.inspect()
    expect(info.Config.Labels[SESSION_LABEL]).toBe(container.sessionId)
  })

  it('finds an existing container by session id', async () => {
    const container = await createSession()
    const found = await sandbox.get(container.sessionId)
    expect(found?.id).toBe(container.id)
  })

  it('returns null for an unknown session', async () => {
    expect(await sandbox.get(randomUUID())).toBeNull()
  })

  it('stops a container without destroying it, so a follow-up can resume', async () => {
    const container = await createSession()
    await container.stop()

    expect(await container.isRunning()).toBe(false)
    // Still present: the workspace and its state survive for a follow-up.
    expect(await sandbox.get(container.sessionId)).not.toBeNull()
  })

  it('restarts a stopped container', async () => {
    const container = await createSession()
    await container.stop()
    await container.start()
    expect(await container.isRunning()).toBe(true)
  })

  it('removes a container completely', async () => {
    const container = await createSession()
    await container.remove()

    expect(await sandbox.get(container.sessionId)).toBeNull()
    expect(await container.isRunning()).toBe(false)
  })

  it('tolerates removing a container twice', async () => {
    const container = await createSession()
    await container.remove()
    // Cleanup paths run on error handling, where a double removal is normal.
    await expect(container.remove()).resolves.not.toThrow()
  })

  it('tolerates stopping an already stopped container', async () => {
    const container = await createSession()
    await container.stop()
    await expect(container.stop()).resolves.not.toThrow()
  })
})
