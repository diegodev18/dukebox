# Terminal Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Terminal tab to the desktop workspace panel that hosts up to four interactive shells running inside the session's container, surviving client disconnects.

**Architecture:** A Docker exec with `Tty: true` gives each terminal a PTY. A server-side `TerminalRegistry` owns the live streams plus a capped scrollback buffer, so a client can detach and reattach without killing the process. Terminal traffic rides the existing WebSocket as its own message types, deliberately outside the persisted, sequenced `EventBus`; only open/close facts are audited into that stream.

**Tech Stack:** TypeScript, dockerode, zod, `ws`, React 19, xterm.js (`@xterm/xterm`, `@xterm/addon-fit`), vitest, Tailwind 4.

**Spec:** `docs/superpowers/specs/2026-08-05-terminal-tab-design.md`

## Global Constraints

- Package manager is `pnpm` (workspace at repo root). Never use `npm install`.
- Run tests with `pnpm --filter <pkg> test`. Full check is `pnpm exec turbo run typecheck` and `pnpm exec turbo run test`.
- Server and sandbox tests need these env vars exported (see `AGENTS.md`):
  `DUKEBOX_DATABASE_URL='postgres://dukebox:dukebox@127.0.0.1:5433/dukebox'` and
  `DUKEBOX_REDIS_URL='redis://127.0.0.1:6380'`.
- Container-lifecycle tests cannot pass in the Cursor Cloud VM (threaded cgroups). Tests that create a real container are expected to fail there and must be validated on the Linux VPS via `./docker/verify.sh`.
- Formatting is Prettier: `pnpm exec prettier --write <files>` before every commit. No semicolons, single quotes, 100 char width — the existing files show the style.
- Code, comments, and commit messages are written in **English**. This matches every existing file in the repo.
- Comments explain _why_, not _what_. The codebase's existing comments are the model: they justify a decision or warn about a trap. Do not add comments that restate the code.
- Terminal limit is exactly **4** per session. Scrollback cap is exactly **128 KB** per terminal.
- Terminal I/O is **never** persisted. Only `terminal_opened` / `terminal_closed` audit events reach the database.

---

### Task 1: Protocol — terminal commands and messages

**Files:**

- Modify: `packages/protocol/src/commands.ts`
- Test: `packages/protocol/src/commands.test.ts` (create)

**Interfaces:**

- Consumes: nothing.
- Produces: zod schemas `terminalOpenCommand`, `terminalAttachCommand`, `terminalDetachCommand`, `terminalInputCommand`, `terminalResizeCommand`, `terminalCloseCommand` added to the `clientCommand` union; `terminalOpenedMessage`, `terminalOutputMessage`, `terminalExitMessage`, `terminalListMessage` added to the `serverMessage` union. Exported TS types `ClientCommand` and `ServerMessage` widen automatically.

- [ ] **Step 1: Write the failing test**

Create `packages/protocol/src/commands.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { clientCommand, serverMessage } from './commands.js'

const sessionId = '11111111-1111-4111-8111-111111111111'

describe('terminal commands', () => {
  it('parses terminal_open with a size', () => {
    const result = clientCommand.safeParse({
      type: 'terminal_open',
      sessionId,
      cols: 80,
      rows: 24,
    })

    expect(result.success).toBe(true)
  })

  it('rejects a terminal_open without a size', () => {
    const result = clientCommand.safeParse({ type: 'terminal_open', sessionId })

    expect(result.success).toBe(false)
  })

  it('rejects a zero-column terminal, which no PTY accepts', () => {
    const result = clientCommand.safeParse({
      type: 'terminal_open',
      sessionId,
      cols: 0,
      rows: 24,
    })

    expect(result.success).toBe(false)
  })

  it('parses terminal_input carrying base64 payloads', () => {
    const result = clientCommand.safeParse({
      type: 'terminal_input',
      sessionId,
      terminalId: 't1',
      data: 'bHMgLWxhCg==',
    })

    expect(result.success).toBe(true)
  })

  it('parses terminal_detach, which leaves the process running', () => {
    const result = clientCommand.safeParse({
      type: 'terminal_detach',
      sessionId,
      terminalId: 't1',
    })

    expect(result.success).toBe(true)
  })
})

describe('terminal messages', () => {
  it('parses terminal_output', () => {
    const result = serverMessage.safeParse({
      type: 'terminal_output',
      sessionId,
      terminalId: 't1',
      data: 'aGVsbG8=',
    })

    expect(result.success).toBe(true)
  })

  it('parses terminal_exit without an exit code, for a stream that just ended', () => {
    const result = serverMessage.safeParse({
      type: 'terminal_exit',
      sessionId,
      terminalId: 't1',
    })

    expect(result.success).toBe(true)
  })

  it('parses terminal_list with no terminals', () => {
    const result = serverMessage.safeParse({
      type: 'terminal_list',
      sessionId,
      terminals: [],
    })

    expect(result.success).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dukebox/protocol test -- commands`
Expected: FAIL — every terminal parse returns `success: false`, because the union has no such variants.

- [ ] **Step 3: Write the implementation**

In `packages/protocol/src/commands.ts`, add after `interruptCommand` (before the `clientCommand` union):

```ts
/**
 * Terminal size in character cells.
 *
 * A PTY with zero rows or columns is not a degenerate terminal, it is an
 * invalid one: curses applications divide by these.
 */
const terminalSize = {
  cols: z.number().int().positive().max(1000),
  rows: z.number().int().positive().max(1000),
}

/** Open a new shell in the session's container. The server assigns the id. */
export const terminalOpenCommand = z.object({
  type: z.literal('terminal_open'),
  sessionId: z.string().uuid(),
  ...terminalSize,
})

/**
 * Start receiving output from an existing terminal.
 *
 * The server replies with the scrollback buffer, so a reattached terminal
 * redraws rather than resuming mid-screen.
 */
export const terminalAttachCommand = z.object({
  type: z.literal('terminal_attach'),
  sessionId: z.string().uuid(),
  terminalId: z.string().min(1),
  ...terminalSize,
})

/**
 * Stop receiving output. The process keeps running.
 *
 * Sent when the panel is hidden. Distinct from `terminal_close`, which kills
 * the shell — switching tabs must not end a long-running command.
 */
export const terminalDetachCommand = z.object({
  type: z.literal('terminal_detach'),
  sessionId: z.string().uuid(),
  terminalId: z.string().min(1),
})

/** Keystrokes for the PTY, base64 encoded. Written through unmodified. */
export const terminalInputCommand = z.object({
  type: z.literal('terminal_input'),
  sessionId: z.string().uuid(),
  terminalId: z.string().min(1),
  data: z.string(),
})

export const terminalResizeCommand = z.object({
  type: z.literal('terminal_resize'),
  sessionId: z.string().uuid(),
  terminalId: z.string().min(1),
  ...terminalSize,
})

/** Kill the shell and forget it. */
export const terminalCloseCommand = z.object({
  type: z.literal('terminal_close'),
  sessionId: z.string().uuid(),
  terminalId: z.string().min(1),
})
```

Extend the `clientCommand` union to:

```ts
export const clientCommand = z.discriminatedUnion('type', [
  subscribeCommand,
  unsubscribeCommand,
  promptCommand,
  permissionResponseCommand,
  interruptCommand,
  terminalOpenCommand,
  terminalAttachCommand,
  terminalDetachCommand,
  terminalInputCommand,
  terminalResizeCommand,
  terminalCloseCommand,
])
```

Then add the server-to-client messages after `subscriptionClosedMessage`:

```ts
/** A terminal now exists and is streaming. */
export const terminalOpenedMessage = z.object({
  type: z.literal('terminal_opened'),
  sessionId: z.string().uuid(),
  terminalId: z.string().min(1),
  title: z.string(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
})

/**
 * Bytes from the PTY, base64 encoded.
 *
 * Base64 rather than a raw string because this is binary: ANSI escapes, and
 * UTF-8 sequences split across chunk boundaries. Encoding it once here means no
 * hop downstream has to guess.
 */
export const terminalOutputMessage = z.object({
  type: z.literal('terminal_output'),
  sessionId: z.string().uuid(),
  terminalId: z.string().min(1),
  data: z.string(),
})

/**
 * The shell ended.
 *
 * `exitCode` is absent when the stream died without Docker reporting one, which
 * is what a killed container looks like.
 */
export const terminalExitMessage = z.object({
  type: z.literal('terminal_exit'),
  sessionId: z.string().uuid(),
  terminalId: z.string().min(1),
  exitCode: z.number().int().optional(),
})

/**
 * Every terminal alive in a session.
 *
 * Sent alongside the subscribe handshake. Without it the client must ask
 * separately and the tab flashes empty before filling in.
 */
export const terminalListMessage = z.object({
  type: z.literal('terminal_list'),
  sessionId: z.string().uuid(),
  terminals: z.array(z.object({ terminalId: z.string().min(1), title: z.string() })),
})
```

Extend the `serverMessage` union to:

```ts
export const serverMessage = z.discriminatedUnion('type', [
  eventMessage,
  caughtUpMessage,
  sessionUpdateMessage,
  commandErrorMessage,
  subscriptionClosedMessage,
  terminalOpenedMessage,
  terminalOutputMessage,
  terminalExitMessage,
  terminalListMessage,
])
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @dukebox/protocol test -- commands`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/protocol/src/commands.ts packages/protocol/src/commands.test.ts
git add packages/protocol/src/commands.ts packages/protocol/src/commands.test.ts
git commit -m "feat(protocol): terminal commands and messages

Terminal traffic gets its own WebSocket message types rather than riding
the event stream, which is persisted, sequenced, and replayed. PTY bytes
are ephemeral and high-volume; replaying them would be meaningless and
storing them would put keystrokes in the database."
```

---

### Task 2: Protocol — terminal audit events

**Files:**

- Modify: `packages/protocol/src/events.ts`
- Test: `packages/protocol/src/events.test.ts:1` (append to the existing file)

**Interfaces:**

- Consumes: nothing.
- Produces: `terminalOpenedEvent` and `terminalClosedEvent` added to the `agentEvent` union. Shapes: `{ type: 'terminal_opened', terminalId: string, deviceId: string }` and `{ type: 'terminal_closed', terminalId: string, deviceId: string, exitCode?: number }`.

**Note for the implementer:** every other variant in this union is produced by an agent adapter. These two are produced by the control plane instead. They belong in the union anyway because the union _is_ the session's persisted event stream, which is what an audit record has to live in — but do not go looking for an adapter that emits them.

- [ ] **Step 1: Write the failing test**

Append to `packages/protocol/src/events.test.ts`:

```ts
describe('terminal audit events', () => {
  it('parses terminal_opened', () => {
    const result = agentEvent.safeParse({
      type: 'terminal_opened',
      terminalId: 't1',
      deviceId: 'device-1',
    })

    expect(result.success).toBe(true)
  })

  it('parses terminal_closed with an exit code', () => {
    const result = agentEvent.safeParse({
      type: 'terminal_closed',
      terminalId: 't1',
      deviceId: 'device-1',
      exitCode: 0,
    })

    expect(result.success).toBe(true)
  })

  it('requires the device that opened the terminal', () => {
    const result = agentEvent.safeParse({ type: 'terminal_opened', terminalId: 't1' })

    expect(result.success).toBe(false)
  })
})
```

Make sure `agentEvent` is imported at the top of that file; add it to the existing import from `./events.js` if it is missing.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dukebox/protocol test -- events`
Expected: FAIL — the first two cases return `success: false`.

- [ ] **Step 3: Write the implementation**

In `packages/protocol/src/events.ts`, add before the `agentEvent` union:

```ts
/**
 * Someone opened a shell in this session's container.
 *
 * Recorded because a person ran commands here, and the transcript otherwise
 * shows only what the agent did. Deliberately carries no I/O: people paste
 * secrets into shells, and a keystroke log in the database would be a liability
 * worth more than the forensics.
 */
export const terminalOpenedEvent = z.object({
  type: z.literal('terminal_opened'),
  terminalId: z.string(),
  deviceId: z.string(),
})

export const terminalClosedEvent = z.object({
  type: z.literal('terminal_closed'),
  terminalId: z.string(),
  deviceId: z.string(),
  exitCode: z.number().int().optional(),
})
```

Add both to the `agentEvent` union, after `doneEvent`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @dukebox/protocol test`
Expected: PASS. The whole protocol suite, including `transcript.test.ts`, must stay green — the transcript reducer ignores unknown variants, so these should pass through untouched.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/protocol/src/events.ts packages/protocol/src/events.test.ts
git add packages/protocol/src/events.ts packages/protocol/src/events.test.ts
git commit -m "feat(protocol): audit terminal open and close

Records that a person had a shell in a session, and which device it was,
without recording what they typed."
```

---

### Task 3: Sandbox — open a PTY in the container

**Files:**

- Modify: `packages/sandbox/src/container.ts:177` (add `openTerminal` after `execStream`)
- Modify: `packages/sandbox/src/index.ts` (export the new type)
- Test: `packages/sandbox/src/container.test.ts` (append)

**Interfaces:**

- Consumes: nothing.
- Produces: `SessionContainer.openTerminal(options: { cols: number; rows: number; cwd?: string }): Promise<TerminalHandle>` where

```ts
export interface TerminalHandle {
  stream: Duplex
  resize: (cols: number, rows: number) => Promise<void>
  close: () => Promise<void>
}
```

Task 4 consumes this exact shape.

- [ ] **Step 1: Write the failing test**

Append to `packages/sandbox/src/container.test.ts`. Match the file's existing setup — read the top of the file first and reuse its container-creation helper and its `describe` skipping conventions rather than inventing new ones.

```ts
describe('openTerminal', () => {
  it('runs an interactive shell and echoes what is written to it', async () => {
    const container = await sandbox.create({
      sessionId: randomUUID(),
      image: TEST_IMAGE,
    })

    const terminal = await container.openTerminal({ cols: 80, rows: 24 })

    const chunks: Buffer[] = []
    terminal.stream.on('data', (chunk: Buffer) => chunks.push(chunk))

    terminal.stream.write('echo dukebox-terminal-works\n')

    // A shell prints a prompt, echoes the line, then prints the output, and
    // none of that arrives in one chunk. Polling for the marker is what makes
    // this deterministic without guessing at a sleep.
    await waitFor(() => Buffer.concat(chunks).includes('dukebox-terminal-works'))

    await terminal.close()
    await container.remove()
  })

  it('reports a size change without throwing', async () => {
    const container = await sandbox.create({
      sessionId: randomUUID(),
      image: TEST_IMAGE,
    })

    const terminal = await container.openTerminal({ cols: 80, rows: 24 })
    await expect(terminal.resize(120, 40)).resolves.toBeUndefined()

    await terminal.close()
    await container.remove()
  })
})

/** Poll until a condition holds, so a test never depends on a fixed sleep. */
async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('timed out waiting for condition')
}
```

If `TEST_IMAGE` or an equivalent constant does not exist in that file, use `'dukebox/base-node:latest'` and note the image must be built: `docker build -t dukebox/base-node:latest images/base-node`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dukebox/sandbox test -- container`
Expected: FAIL with "container.openTerminal is not a function".

**In the Cursor Cloud VM this test fails for a different reason** — `cannot enter cgroupv2 ... domain controllers`. That is the documented cgroup limitation, not your bug. Confirm the failure message says `openTerminal is not a function` where containers work; where they do not, write the code and verify it on the VPS with `./docker/verify.sh`.

- [ ] **Step 3: Write the implementation**

In `packages/sandbox/src/container.ts`, add the interface near `ExecResult`:

```ts
/** An interactive shell inside a container. */
export interface TerminalHandle {
  /**
   * Raw bidirectional bytes.
   *
   * Not demultiplexed, unlike `execStream`: Docker's 8-byte frame headers only
   * exist for TTY-less execs. With a TTY there is one merged stream, which is
   * exactly what a terminal wants — stderr belongs interleaved on screen.
   */
  stream: Duplex
  resize: (cols: number, rows: number) => Promise<void>
  close: () => Promise<void>
}
```

Add the method to `SessionContainer`, after `execStream`:

```ts
  /**
   * Start an interactive login shell with a PTY.
   *
   * A login shell rather than a bare one so the profile runs and the toolchain
   * on PATH matches what the agent sees. The caller owns the returned stream
   * and must close it: an abandoned exec keeps a process alive in the container
   * against its PID limit.
   */
  async openTerminal(
    options: { cols: number; rows: number; cwd?: string } = { cols: 80, rows: 24 },
  ): Promise<TerminalHandle> {
    const exec = await this.container.exec({
      Cmd: ['/bin/bash', '-l'],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      ConsoleSize: [options.rows, options.cols],
      ...(options.cwd ? { WorkingDir: options.cwd } : {}),
    })

    const stream = (await exec.start({ hijack: true, stdin: true })) as Duplex

    return {
      stream,
      // Docker takes rows before columns, and getting them backwards produces a
      // terminal that looks right until something wraps.
      resize: async (cols, rows) => {
        await exec.resize({ h: rows, w: cols })
      },
      close: async () => {
        stream.destroy()
      },
    }
  }
```

Export `TerminalHandle` from `packages/sandbox/src/index.ts` alongside the existing container exports.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @dukebox/sandbox test -- container`
Expected: PASS where containers work. In the Cursor Cloud VM, expect the cgroup failure and defer verification to `./docker/verify.sh` on the VPS.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/sandbox/src/container.ts packages/sandbox/src/index.ts packages/sandbox/src/container.test.ts
git add packages/sandbox/src/container.ts packages/sandbox/src/index.ts packages/sandbox/src/container.test.ts
git commit -m "feat(sandbox): open an interactive PTY in a session container

Docker allocates the PTY, so there is no native module to compile into
the base image. A TTY exec is unframed, which is why this returns the
stream raw where execStream demultiplexes."
```

---

### Task 4: Server — the ring buffer

**Files:**

- Create: `apps/server/src/sessions/ringBuffer.ts`
- Test: `apps/server/src/sessions/ringBuffer.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:

```ts
export class RingBuffer {
  constructor(capacityBytes: number)
  append(chunk: Buffer): void
  contents(): Buffer
  get truncated(): boolean
}
```

Task 5 consumes this.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/sessions/ringBuffer.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { RingBuffer } from './ringBuffer.js'

describe('RingBuffer', () => {
  it('returns everything it was given while under capacity', () => {
    const buffer = new RingBuffer(1024)
    buffer.append(Buffer.from('hello '))
    buffer.append(Buffer.from('world'))

    expect(buffer.contents().toString()).toBe('hello world')
    expect(buffer.truncated).toBe(false)
  })

  it('keeps the newest bytes when it overflows', () => {
    const buffer = new RingBuffer(10)
    buffer.append(Buffer.from('0123456789'))
    buffer.append(Buffer.from('abcde'))

    expect(buffer.contents().toString()).toBe('56789abcde')
  })

  it('reports truncation, so a reader knows the screen is partial', () => {
    const buffer = new RingBuffer(4)
    buffer.append(Buffer.from('12345'))

    expect(buffer.truncated).toBe(true)
  })

  it('handles a single chunk larger than the whole buffer', () => {
    const buffer = new RingBuffer(4)
    buffer.append(Buffer.from('abcdefgh'))

    expect(buffer.contents().toString()).toBe('efgh')
  })

  it('starts empty', () => {
    expect(new RingBuffer(16).contents()).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dukebox/server test -- ringBuffer`
Expected: FAIL — cannot resolve `./ringBuffer.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/server/src/sessions/ringBuffer.ts`:

```ts
/**
 * The last N bytes written to it.
 *
 * Terminal scrollback has to be capped somewhere: an accidental `yes` produces
 * megabytes a second, and a buffer that grows with it makes control-plane
 * memory hostage to whatever someone types. A fixed cap makes the worst case
 * knowable instead.
 */
export class RingBuffer {
  private chunks: Buffer[] = []
  private size = 0
  private overflowed = false

  constructor(private readonly capacityBytes: number) {}

  append(chunk: Buffer): void {
    if (chunk.length === 0) return

    this.chunks.push(chunk)
    this.size += chunk.length

    if (this.size <= this.capacityBytes) return

    this.overflowed = true

    // Drop whole chunks first and slice only the one straddling the boundary.
    // Concatenating on every append would make this quadratic against a stream
    // that arrives in thousands of small writes, which is what a PTY is.
    while (this.chunks.length > 0 && this.size - this.chunks[0]!.length >= this.capacityBytes) {
      this.size -= this.chunks.shift()!.length
    }

    const excess = this.size - this.capacityBytes
    if (excess > 0 && this.chunks.length > 0) {
      this.chunks[0] = this.chunks[0]!.subarray(excess)
      this.size -= excess
    }
  }

  contents(): Buffer {
    return Buffer.concat(this.chunks)
  }

  /** Whether anything has been dropped. A reattached screen is partial. */
  get truncated(): boolean {
    return this.overflowed
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @dukebox/server test -- ringBuffer`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write apps/server/src/sessions/ringBuffer.ts apps/server/src/sessions/ringBuffer.test.ts
git add apps/server/src/sessions/ringBuffer.ts apps/server/src/sessions/ringBuffer.test.ts
git commit -m "feat(server): capped ring buffer for terminal scrollback"
```

---

### Task 5: Server — the terminal registry

**Files:**

- Create: `apps/server/src/sessions/terminals.ts`
- Test: `apps/server/src/sessions/terminals.test.ts`

**Interfaces:**

- Consumes: `RingBuffer` from Task 4; `TerminalHandle` from Task 3.
- Produces:

```ts
export const MAX_TERMINALS_PER_SESSION = 4
export const SCROLLBACK_BYTES = 128 * 1024

export interface TerminalInfo {
  terminalId: string
  title: string
}

export type TerminalListener = (chunk: Buffer) => void
export type TerminalExitListener = (exitCode?: number) => void

export interface TerminalRegistryDeps {
  /** Opens a PTY in a session's container. Throws if the session is not running. */
  openTerminal: (sessionId: string, size: { cols: number; rows: number }) => Promise<TerminalHandle>
}

export class TerminalRegistry {
  constructor(deps: TerminalRegistryDeps)
  open(sessionId: string, size: { cols: number; rows: number }): Promise<TerminalInfo>
  list(sessionId: string): TerminalInfo[]
  attach(
    sessionId: string,
    terminalId: string,
    listener: TerminalListener,
    onExit: TerminalExitListener,
  ): Buffer
  detach(sessionId: string, terminalId: string, listener: TerminalListener): void
  write(sessionId: string, terminalId: string, data: Buffer): void
  resize(sessionId: string, terminalId: string, cols: number, rows: number): Promise<void>
  close(sessionId: string, terminalId: string): Promise<void>
  closeSession(sessionId: string): Promise<void>
}

export class TerminalError extends Error {}
```

Tasks 6 and 7 consume these.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/sessions/terminals.test.ts`:

```ts
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_TERMINALS_PER_SESSION, TerminalRegistry } from './terminals.js'

const sessionId = 'session-1'

/**
 * A stand-in for a container PTY.
 *
 * A PassThrough is enough: the registry only writes to the stream, reads from
 * it, and destroys it. Using a real container here would test Docker.
 */
function fakeTerminal() {
  const stream = new PassThrough()
  return {
    stream,
    resize: vi.fn(async () => {}),
    close: vi.fn(async () => {
      stream.destroy()
    }),
  }
}

describe('TerminalRegistry', () => {
  let terminals: ReturnType<typeof fakeTerminal>[]
  let registry: TerminalRegistry

  beforeEach(() => {
    terminals = []
    registry = new TerminalRegistry({
      openTerminal: async () => {
        const terminal = fakeTerminal()
        terminals.push(terminal)
        return terminal
      },
    })
  })

  it('opens a terminal and lists it', async () => {
    const info = await registry.open(sessionId, { cols: 80, rows: 24 })

    expect(registry.list(sessionId)).toEqual([info])
  })

  it('numbers terminals in the order they were opened', async () => {
    const first = await registry.open(sessionId, { cols: 80, rows: 24 })
    const second = await registry.open(sessionId, { cols: 80, rows: 24 })

    expect(first.title).toBe('1')
    expect(second.title).toBe('2')
  })

  it('refuses to open more than the cap', async () => {
    for (let index = 0; index < MAX_TERMINALS_PER_SESSION; index += 1) {
      await registry.open(sessionId, { cols: 80, rows: 24 })
    }

    await expect(registry.open(sessionId, { cols: 80, rows: 24 })).rejects.toThrow(
      /at most 4 terminals/,
    )
  })

  it('counts the cap per session, not globally', async () => {
    for (let index = 0; index < MAX_TERMINALS_PER_SESSION; index += 1) {
      await registry.open(sessionId, { cols: 80, rows: 24 })
    }

    await expect(registry.open('session-2', { cols: 80, rows: 24 })).resolves.toBeDefined()
  })

  it('delivers output to an attached listener', async () => {
    const info = await registry.open(sessionId, { cols: 80, rows: 24 })

    const received: Buffer[] = []
    registry.attach(
      sessionId,
      info.terminalId,
      (chunk) => received.push(chunk),
      () => {},
    )

    terminals[0]!.stream.write('hello')
    await new Promise((resolve) => setImmediate(resolve))

    expect(Buffer.concat(received).toString()).toBe('hello')
  })

  it('buffers output while nobody is attached, and replays it on attach', async () => {
    const info = await registry.open(sessionId, { cols: 80, rows: 24 })

    terminals[0]!.stream.write('while detached')
    await new Promise((resolve) => setImmediate(resolve))

    const scrollback = registry.attach(
      sessionId,
      info.terminalId,
      () => {},
      () => {},
    )

    expect(scrollback.toString()).toBe('while detached')
  })

  it('stops delivering after detach but keeps the process alive', async () => {
    const info = await registry.open(sessionId, { cols: 80, rows: 24 })

    const received: Buffer[] = []
    const listener = (chunk: Buffer) => received.push(chunk)
    registry.attach(sessionId, info.terminalId, listener, () => {})
    registry.detach(sessionId, info.terminalId, listener)

    terminals[0]!.stream.write('after detach')
    await new Promise((resolve) => setImmediate(resolve))

    expect(received).toHaveLength(0)
    expect(terminals[0]!.close).not.toHaveBeenCalled()
    expect(registry.list(sessionId)).toHaveLength(1)
  })

  it('writes input straight through to the PTY', async () => {
    const info = await registry.open(sessionId, { cols: 80, rows: 24 })

    const written: Buffer[] = []
    terminals[0]!.stream.on('data', (chunk: Buffer) => written.push(chunk))

    registry.write(sessionId, info.terminalId, Buffer.from('ls -la\n'))
    await new Promise((resolve) => setImmediate(resolve))

    expect(Buffer.concat(written).toString()).toBe('ls -la\n')
  })

  it('forwards a resize to the container', async () => {
    const info = await registry.open(sessionId, { cols: 80, rows: 24 })
    await registry.resize(sessionId, info.terminalId, 120, 40)

    expect(terminals[0]!.resize).toHaveBeenCalledWith(120, 40)
  })

  it('closes the PTY and forgets the terminal', async () => {
    const info = await registry.open(sessionId, { cols: 80, rows: 24 })
    await registry.close(sessionId, info.terminalId)

    expect(terminals[0]!.close).toHaveBeenCalled()
    expect(registry.list(sessionId)).toHaveLength(0)
  })

  it('notifies attached listeners when the stream ends on its own', async () => {
    const info = await registry.open(sessionId, { cols: 80, rows: 24 })

    const exits: (number | undefined)[] = []
    registry.attach(
      sessionId,
      info.terminalId,
      () => {},
      (code) => exits.push(code),
    )

    terminals[0]!.stream.end()
    await new Promise((resolve) => setImmediate(resolve))

    expect(exits).toHaveLength(1)
    expect(registry.list(sessionId)).toHaveLength(0)
  })

  it('closes every terminal in a session at once', async () => {
    await registry.open(sessionId, { cols: 80, rows: 24 })
    await registry.open(sessionId, { cols: 80, rows: 24 })

    await registry.closeSession(sessionId)

    expect(registry.list(sessionId)).toHaveLength(0)
    expect(terminals.every((terminal) => terminal.close.mock.calls.length > 0)).toBe(true)
  })

  it('reports an unknown terminal rather than failing silently', () => {
    expect(() => registry.write(sessionId, 'nope', Buffer.from('x'))).toThrow(/no such terminal/)
  })

  it('frees a slot when a terminal closes, so the cap is not permanent', async () => {
    const first = await registry.open(sessionId, { cols: 80, rows: 24 })
    for (let index = 1; index < MAX_TERMINALS_PER_SESSION; index += 1) {
      await registry.open(sessionId, { cols: 80, rows: 24 })
    }

    await registry.close(sessionId, first.terminalId)

    await expect(registry.open(sessionId, { cols: 80, rows: 24 })).resolves.toBeDefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dukebox/server test -- terminals`
Expected: FAIL — cannot resolve `./terminals.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/server/src/sessions/terminals.ts`:

```ts
import type { TerminalHandle } from '@dukebox/sandbox'
import { randomUUID } from 'node:crypto'
import { RingBuffer } from './ringBuffer.js'

/**
 * The interactive shells running inside session containers.
 *
 * The registry owns the PTY rather than the WebSocket connection that opened
 * it, which is what makes a terminal survive a client disconnect: the socket
 * attaches and detaches, the process keeps running. A terminal ends when
 * someone closes it or when its session does.
 */

/**
 * Terminals allowed per session.
 *
 * A cap because a client-side retry bug would otherwise create PTYs until it
 * hits the container's PidsLimit and takes the whole session down with it.
 */
export const MAX_TERMINALS_PER_SESSION = 4

/** Scrollback kept per terminal, so a reattaching client can redraw. */
export const SCROLLBACK_BYTES = 128 * 1024

export interface TerminalInfo {
  terminalId: string
  title: string
}

export type TerminalListener = (chunk: Buffer) => void
export type TerminalExitListener = (exitCode?: number) => void

export interface TerminalRegistryDeps {
  openTerminal: (sessionId: string, size: { cols: number; rows: number }) => Promise<TerminalHandle>
}

export class TerminalError extends Error {}

interface LiveTerminal {
  terminalId: string
  title: string
  handle: TerminalHandle
  scrollback: RingBuffer
  listeners: Set<TerminalListener>
  exitListeners: Set<TerminalExitListener>
}

export class TerminalRegistry {
  private readonly sessions = new Map<string, Map<string, LiveTerminal>>()

  constructor(private readonly deps: TerminalRegistryDeps) {}

  async open(sessionId: string, size: { cols: number; rows: number }): Promise<TerminalInfo> {
    const existing = this.sessions.get(sessionId) ?? new Map<string, LiveTerminal>()

    if (existing.size >= MAX_TERMINALS_PER_SESSION) {
      throw new TerminalError(`a session may have at most ${MAX_TERMINALS_PER_SESSION} terminals`)
    }

    const handle = await this.deps.openTerminal(sessionId, size)

    const terminal: LiveTerminal = {
      terminalId: randomUUID(),
      // Numbered by how many are already open. Titles are for telling tabs
      // apart, and a uuid on a tab tells nobody anything.
      title: String(existing.size + 1),
      handle,
      scrollback: new RingBuffer(SCROLLBACK_BYTES),
      listeners: new Set(),
      exitListeners: new Set(),
    }

    handle.stream.on('data', (chunk: Buffer) => {
      terminal.scrollback.append(chunk)
      for (const listener of terminal.listeners) listener(chunk)
    })

    // 'close' rather than 'end': a destroyed stream never emits 'end', and a
    // terminal whose container died would otherwise linger in the registry
    // forever, holding a slot against the cap.
    const finish = () => this.forget(sessionId, terminal)
    handle.stream.on('close', finish)
    handle.stream.on('end', finish)
    handle.stream.on('error', finish)

    existing.set(terminal.terminalId, terminal)
    this.sessions.set(sessionId, existing)

    return { terminalId: terminal.terminalId, title: terminal.title }
  }

  list(sessionId: string): TerminalInfo[] {
    const session = this.sessions.get(sessionId)
    if (!session) return []

    return [...session.values()].map(({ terminalId, title }) => ({ terminalId, title }))
  }

  /** Start receiving output. Returns the scrollback to redraw from. */
  attach(
    sessionId: string,
    terminalId: string,
    listener: TerminalListener,
    onExit: TerminalExitListener,
  ): Buffer {
    const terminal = this.require(sessionId, terminalId)
    terminal.listeners.add(listener)
    terminal.exitListeners.add(onExit)

    return terminal.scrollback.contents()
  }

  detach(sessionId: string, terminalId: string, listener: TerminalListener): void {
    // Deliberately tolerant of an unknown terminal: detach races with a shell
    // exiting, and turning that into an error would surface as a spurious
    // failure every time a client closes a tab at the wrong moment.
    const terminal = this.sessions.get(sessionId)?.get(terminalId)
    terminal?.listeners.delete(listener)
  }

  write(sessionId: string, terminalId: string, data: Buffer): void {
    this.require(sessionId, terminalId).handle.stream.write(data)
  }

  async resize(sessionId: string, terminalId: string, cols: number, rows: number): Promise<void> {
    await this.require(sessionId, terminalId).handle.resize(cols, rows)
  }

  async close(sessionId: string, terminalId: string): Promise<void> {
    const terminal = this.sessions.get(sessionId)?.get(terminalId)
    if (!terminal) return

    this.forget(sessionId, terminal)
    await terminal.handle.close().catch(() => undefined)
  }

  /**
   * End every terminal in a session.
   *
   * Called when a session stops. A PTY outliving its container is a guaranteed
   * leak: the process is gone, but the registry entry holds a scrollback buffer
   * and a slot against the cap forever.
   */
  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return

    const terminals = [...session.values()]
    this.sessions.delete(sessionId)

    for (const terminal of terminals) {
      this.notifyExit(terminal)
    }

    await Promise.all(terminals.map((terminal) => terminal.handle.close().catch(() => undefined)))
  }

  private require(sessionId: string, terminalId: string): LiveTerminal {
    const terminal = this.sessions.get(sessionId)?.get(terminalId)
    if (!terminal) throw new TerminalError('no such terminal')

    return terminal
  }

  /** Drop a terminal and tell whoever was watching. Safe to call twice. */
  private forget(sessionId: string, terminal: LiveTerminal): void {
    const session = this.sessions.get(sessionId)
    if (!session?.delete(terminal.terminalId)) return

    if (session.size === 0) this.sessions.delete(sessionId)
    this.notifyExit(terminal)
  }

  private notifyExit(terminal: LiveTerminal): void {
    for (const listener of terminal.exitListeners) listener(undefined)
    terminal.listeners.clear()
    terminal.exitListeners.clear()
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @dukebox/server test -- terminals`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write apps/server/src/sessions/terminals.ts apps/server/src/sessions/terminals.test.ts
git add apps/server/src/sessions/terminals.ts apps/server/src/sessions/terminals.test.ts
git commit -m "feat(server): registry of live terminals per session

The registry owns the PTY rather than the connection that opened it,
which is what lets a client detach and reattach without killing a
long-running command. Capped at four per session and 128 KB of
scrollback each, so a runaway process cannot exhaust the host."
```

---

### Task 6: Session manager — open PTYs and clean them up

**Files:**

- Modify: `apps/server/src/sessions/manager.ts:664` (add `openTerminal` near `interrupt`)
- Modify: `apps/server/src/sessions/manager.ts:685` (hook cleanup into `stop`)
- Test: `apps/server/src/sessions/manager.test.ts` (append)

**Interfaces:**

- Consumes: `TerminalHandle` from Task 3.
- Produces:
  - `SessionManager.openTerminal(sessionId: string, size: { cols: number; rows: number }): Promise<TerminalHandle>` — throws `SessionError('that session is not running')` when it is not.
  - `SessionManagerDeps.onSessionStopped?: (sessionId: string) => Promise<void>` — called from `stop()` after the container is stopped. Task 7 wires the registry's `closeSession` into it.

- [ ] **Step 1: Write the failing test**

Append to `apps/server/src/sessions/manager.test.ts`. Read the file's existing setup first and reuse its manager-construction helper and fake adapter rather than building new ones.

```ts
describe('openTerminal', () => {
  it('refuses when the session is not running', async () => {
    const manager = makeManager()

    await expect(manager.openTerminal(randomUUID(), { cols: 80, rows: 24 })).rejects.toThrow(
      /not running/,
    )
  })
})

describe('stop', () => {
  it('tells the terminal registry the session is over', async () => {
    const stopped: string[] = []
    const manager = makeManager({
      onSessionStopped: async (sessionId) => {
        stopped.push(sessionId)
      },
    })

    const session = await startTestSession(manager)
    await manager.stop(session.id)

    expect(stopped).toEqual([session.id])
  })
})
```

`makeManager` and `startTestSession` stand for whatever the existing file already uses — reuse those names if they exist, otherwise adapt these two cases to the file's established helpers. Do not add a second way to build a manager.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dukebox/server test -- manager`
Expected: FAIL — `manager.openTerminal is not a function`, and `onSessionStopped` is not a recognized dep.

In the Cursor Cloud VM this suite cannot pass at all (it creates real containers; see the cgroup limitation in `AGENTS.md`). Where that is the case, write the code, confirm it typechecks, and verify on the VPS with `./docker/verify.sh`.

- [ ] **Step 3: Write the implementation**

In `SessionManagerDeps`, add:

```ts
  /**
   * Called when a session stops, before its status is written.
   *
   * The terminal registry hangs off this rather than importing the manager:
   * a PTY belonging to a stopped container is dead weight, and the manager is
   * the only place that knows when that happened.
   */
  onSessionStopped?: (sessionId: string) => Promise<void>
```

Add the method next to `interrupt`:

```ts
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
```

Import `TerminalHandle` from `@dukebox/sandbox` at the top of the file, alongside the existing sandbox imports.

In `stop()`, after `await running.container.stop()` and before the credentials cleanup, add:

```ts
// Before the status write, so a client that reacts to the status change
// never finds a terminal that is still listed but already dead.
await this.deps.onSessionStopped?.(sessionId).catch(() => undefined)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @dukebox/server test -- manager`
Expected: PASS where containers work; the documented cgroup failure otherwise.

Also run: `pnpm exec turbo run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write apps/server/src/sessions/manager.ts apps/server/src/sessions/manager.test.ts
git add apps/server/src/sessions/manager.ts apps/server/src/sessions/manager.test.ts
git commit -m "feat(server): open terminals in a running session and reap them on stop"
```

---

### Task 7: WebSocket — wire terminals into the connection

**Files:**

- Modify: `apps/server/src/ws/server.ts:22` (deps), `:72` (dispatch), `:99` (subscribe), `:164` (close)
- Modify: `apps/server/src/main.ts:68` and `:95` (construct the registry, pass the deps)
- Test: `apps/server/src/ws/server.test.ts` (append)

**Interfaces:**

- Consumes: `TerminalRegistry` from Task 5; `SessionManager.openTerminal` and `onSessionStopped` from Task 6; the protocol schemas from Tasks 1 and 2.
- Produces: a `Connection` that handles every terminal command and sends every terminal message. No new exported API.

- [ ] **Step 1: Write the failing test**

Append to `apps/server/src/ws/server.test.ts`. Reuse the file's existing harness for opening an authenticated socket — read it first and match its helper names.

```ts
describe('terminal commands', () => {
  it('opens a terminal and answers with its id', async () => {
    const { socket, received } = await connectTestClient()

    socket.send(JSON.stringify({ type: 'terminal_open', sessionId, cols: 80, rows: 24 }))

    const opened = await waitForMessage(received, 'terminal_opened')
    expect(opened.terminalId).toBeTruthy()
    expect(opened.title).toBe('1')
  })

  it('streams PTY output as base64', async () => {
    const { socket, received } = await connectTestClient()

    socket.send(JSON.stringify({ type: 'terminal_open', sessionId, cols: 80, rows: 24 }))
    const opened = await waitForMessage(received, 'terminal_opened')

    fakeTerminals[0]!.stream.write('hi')

    const output = await waitForMessage(received, 'terminal_output')
    expect(Buffer.from(output.data, 'base64').toString()).toBe('hi')
  })

  it('reports a refused open rather than going silent', async () => {
    const { socket, received } = await connectTestClient()

    for (let index = 0; index < 4; index += 1) {
      socket.send(JSON.stringify({ type: 'terminal_open', sessionId, cols: 80, rows: 24 }))
      await waitForMessage(received, 'terminal_opened')
    }

    socket.send(JSON.stringify({ type: 'terminal_open', sessionId, cols: 80, rows: 24 }))

    const error = await waitForMessage(received, 'command_error')
    expect(error.message).toMatch(/at most 4 terminals/)
  })

  it('includes live terminals in the subscribe handshake', async () => {
    const first = await connectTestClient()
    first.socket.send(JSON.stringify({ type: 'terminal_open', sessionId, cols: 80, rows: 24 }))
    await waitForMessage(first.received, 'terminal_opened')

    const second = await connectTestClient()
    second.socket.send(JSON.stringify({ type: 'subscribe', sessionId }))

    const list = await waitForMessage(second.received, 'terminal_list')
    expect(list.terminals).toHaveLength(1)
  })

  it('leaves the terminal running when the socket closes', async () => {
    const { socket, received } = await connectTestClient()

    socket.send(JSON.stringify({ type: 'terminal_open', sessionId, cols: 80, rows: 24 }))
    await waitForMessage(received, 'terminal_opened')

    socket.close()
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(fakeTerminals[0]!.close).not.toHaveBeenCalled()
  })
})
```

`fakeTerminals` is an array the test harness fills from the registry's injected `openTerminal`, exactly as in Task 5. Build the registry in the test with the same `PassThrough`-based fake rather than a real container.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dukebox/server test -- ws`
Expected: FAIL — the server replies `command_error: unrecognized command` to every terminal command.

- [ ] **Step 3: Write the implementation**

In `WebSocketDeps`, add:

```ts
  /** Live terminals. Absent on a server without sessions. */
  terminals?: TerminalRegistry
  /** Records that a person opened or closed a shell. Never records I/O. */
  auditTerminal?: (
    sessionId: string,
    event: { type: 'terminal_opened' | 'terminal_closed'; terminalId: string; deviceId: string },
  ) => Promise<void>
```

In `Connection`, add a field tracking what this socket is attached to, so closing the socket detaches without killing anything:

```ts
  /** Terminals this socket is watching, and how to stop watching them. */
  private readonly attached = new Map<string, () => void>()
```

Add the dispatch cases to the `switch` in `dispatch`:

```ts
      case 'terminal_open':
        return this.openTerminal(command.sessionId, command.cols, command.rows)
      case 'terminal_attach':
        return this.attachTerminal(command.sessionId, command.terminalId, {
          cols: command.cols,
          rows: command.rows,
        })
      case 'terminal_detach':
        return this.detachTerminal(command.sessionId, command.terminalId)
      case 'terminal_input':
        return this.withTerminals(command.sessionId, (terminals) => {
          terminals.write(command.sessionId, command.terminalId, Buffer.from(command.data, 'base64'))
        })
      case 'terminal_resize':
        return this.withTerminals(command.sessionId, (terminals) =>
          terminals.resize(command.sessionId, command.terminalId, command.cols, command.rows),
        )
      case 'terminal_close':
        return this.closeTerminal(command.sessionId, command.terminalId)
```

Add the methods:

```ts
  private async openTerminal(sessionId: string, cols: number, rows: number): Promise<void> {
    await this.withTerminals(sessionId, async (terminals) => {
      const info = await terminals.open(sessionId, { cols, rows })

      this.send({
        type: 'terminal_opened',
        sessionId,
        terminalId: info.terminalId,
        title: info.title,
        cols,
        rows,
      })

      // The opener is attached automatically: a terminal you have to ask for
      // twice before it says anything looks broken.
      this.attachTo(sessionId, info.terminalId, terminals)

      await this.deps.auditTerminal?.(sessionId, {
        type: 'terminal_opened',
        terminalId: info.terminalId,
        deviceId: this.device.id,
      })
    })
  }

  private async attachTerminal(
    sessionId: string,
    terminalId: string,
    size: { cols: number; rows: number },
  ): Promise<void> {
    await this.withTerminals(sessionId, async (terminals) => {
      this.attachTo(sessionId, terminalId, terminals)
      await terminals.resize(sessionId, terminalId, size.cols, size.rows)
    })
  }

  /**
   * Start forwarding a terminal to this socket.
   *
   * The scrollback goes out first so the client redraws a full screen rather
   * than joining mid-line.
   */
  private attachTo(sessionId: string, terminalId: string, terminals: TerminalRegistry): void {
    if (this.attached.has(terminalId)) return

    const listener = (chunk: Buffer) => {
      // Dropped rather than queued when the socket is already backed up. A
      // terminal that skips lines under a flood of output is survivable; a
      // control plane buffering megabytes for one slow client is not.
      if (this.socket.bufferedAmount > BACKPRESSURE_BYTES) return

      this.send({
        type: 'terminal_output',
        sessionId,
        terminalId,
        data: chunk.toString('base64'),
      })
    }

    const onExit = (exitCode?: number) => {
      this.attached.delete(terminalId)
      this.send({
        type: 'terminal_exit',
        sessionId,
        terminalId,
        ...(exitCode === undefined ? {} : { exitCode }),
      })
    }

    const scrollback = terminals.attach(sessionId, terminalId, listener, onExit)
    if (scrollback.length > 0) {
      this.send({
        type: 'terminal_output',
        sessionId,
        terminalId,
        data: scrollback.toString('base64'),
      })
    }

    this.attached.set(terminalId, () => terminals.detach(sessionId, terminalId, listener))
  }

  private async detachTerminal(sessionId: string, terminalId: string): Promise<void> {
    const stop = this.attached.get(terminalId)
    if (!stop) return

    this.attached.delete(terminalId)
    stop()
  }

  private async closeTerminal(sessionId: string, terminalId: string): Promise<void> {
    await this.withTerminals(sessionId, async (terminals) => {
      await terminals.close(sessionId, terminalId)
      this.attached.get(terminalId)?.()
      this.attached.delete(terminalId)

      await this.deps.auditTerminal?.(sessionId, {
        type: 'terminal_closed',
        terminalId,
        deviceId: this.device.id,
      })
    })
  }

  /** Run a terminal action, reporting failure to the client rather than throwing. */
  private async withTerminals(
    sessionId: string,
    action: (terminals: TerminalRegistry) => Promise<void> | void,
  ): Promise<void> {
    const terminals = this.deps.terminals
    if (!terminals) {
      this.fail('terminals are not available on this server', sessionId)
      return
    }

    try {
      await action(terminals)
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'terminal command failed', sessionId)
    }
  }
```

Add the constant near `INITIAL_RETRY_MS`-style module constants at the top of the file:

```ts
/**
 * How far behind a socket may fall before terminal output is dropped for it.
 *
 * One megabyte is roughly a screen-refresh storm's worth of backlog: past that
 * the client is not keeping up and buffering more only delays the truth.
 */
const BACKPRESSURE_BYTES = 1024 * 1024
```

At the end of `subscribe()`, after the `caught_up` send:

```ts
// Sent with the handshake rather than on request: a client that has to ask
// separately shows an empty terminal tab until the second round-trip lands.
if (this.deps.terminals) {
  this.send({
    type: 'terminal_list',
    sessionId,
    terminals: this.deps.terminals.list(sessionId),
  })
}
```

In `close()`, detach without closing:

```ts
// Detached, not closed: the whole point of the registry owning the PTY is
// that a dropped connection leaves the shell running.
for (const stop of this.attached.values()) stop()
this.attached.clear()
```

Import `TerminalRegistry` at the top of the file.

In `apps/server/src/main.ts`, construct the registry after the `SessionManager` and pass both new deps:

```ts
const terminals = new TerminalRegistry({
  openTerminal: (sessionId, size) => sessions.openTerminal(sessionId, size),
})
```

Add `onSessionStopped: (sessionId) => terminals.closeSession(sessionId)` to the `SessionManager` deps. Because `terminals` is declared after `sessions`, reference it through the closure — the callback only runs later, so the ordering is fine.

Then in the `attachWebSocketServer` call, add:

```ts
    terminals,
    auditTerminal: (sessionId, event) => bus.append(sessionId, event).then(() => undefined),
```

Use whatever local name `main.ts` already binds the `EventBus` to rather than assuming `bus`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @dukebox/server test -- ws`
Expected: PASS, 5 new tests, and the existing ws suite still green.

Run: `pnpm exec turbo run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write apps/server/src/ws/server.ts apps/server/src/ws/server.test.ts apps/server/src/main.ts
git add apps/server/src/ws/server.ts apps/server/src/ws/server.test.ts apps/server/src/main.ts
git commit -m "feat(server): serve terminals over the session WebSocket

A closing socket detaches rather than closing, so a dropped connection
leaves the shell running. Output is dropped for a client already a
megabyte behind: skipped lines beat an unbounded server-side queue."
```

---

### Task 8: Desktop — terminal state hook

**Files:**

- Modify: `apps/desktop/src/lib/stream.ts:132` (add send methods)
- Create: `apps/desktop/src/lib/useTerminals.ts`
- Test: `apps/desktop/src/lib/useTerminals.test.ts`

**Interfaces:**

- Consumes: protocol types from Task 1.
- Produces:
  - On `SessionStream`: `openTerminal(sessionId, cols, rows)`, `attachTerminal(sessionId, terminalId, cols, rows)`, `detachTerminal(sessionId, terminalId)`, `sendTerminalInput(sessionId, terminalId, data: string)`, `resizeTerminal(sessionId, terminalId, cols, rows)`, `closeTerminal(sessionId, terminalId)`.
  - `applyTerminalMessage(state: TerminalState, message: ServerMessage): TerminalState` — a pure reducer, exported for testing.
  - `emptyTerminalState(): TerminalState` where

```ts
export interface TerminalTab {
  terminalId: string
  title: string
  exited: boolean
  /** Base64 chunks not yet written to xterm, oldest first. */
  pending: string[]
}

export interface TerminalState {
  tabs: TerminalTab[]
}
```

**Note on state ownership:** the spec says "zustand store". The codebase does not actually keep session state in zustand — `useSession` holds it in `useState`/`useRef`. Follow the codebase, not the spec sentence: this is a sibling hook in the same shape as `useSession`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/lib/useTerminals.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { applyTerminalMessage, emptyTerminalState } from './useTerminals.js'

const sessionId = '11111111-1111-4111-8111-111111111111'

describe('applyTerminalMessage', () => {
  it('adds a tab when a terminal opens', () => {
    const state = applyTerminalMessage(emptyTerminalState(), {
      type: 'terminal_opened',
      sessionId,
      terminalId: 't1',
      title: '1',
      cols: 80,
      rows: 24,
    })

    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0]?.title).toBe('1')
  })

  it('replaces the tab list when the server sends one', () => {
    const opened = applyTerminalMessage(emptyTerminalState(), {
      type: 'terminal_opened',
      sessionId,
      terminalId: 'stale',
      title: '1',
      cols: 80,
      rows: 24,
    })

    const state = applyTerminalMessage(opened, {
      type: 'terminal_list',
      sessionId,
      terminals: [{ terminalId: 't1', title: '1' }],
    })

    expect(state.tabs.map((tab) => tab.terminalId)).toEqual(['t1'])
  })

  it('queues output for the tab it belongs to', () => {
    const opened = applyTerminalMessage(emptyTerminalState(), {
      type: 'terminal_opened',
      sessionId,
      terminalId: 't1',
      title: '1',
      cols: 80,
      rows: 24,
    })

    const state = applyTerminalMessage(opened, {
      type: 'terminal_output',
      sessionId,
      terminalId: 't1',
      data: 'aGk=',
    })

    expect(state.tabs[0]?.pending).toEqual(['aGk='])
  })

  it('ignores output for a terminal it does not know about', () => {
    const state = applyTerminalMessage(emptyTerminalState(), {
      type: 'terminal_output',
      sessionId,
      terminalId: 'ghost',
      data: 'aGk=',
    })

    expect(state.tabs).toHaveLength(0)
  })

  it('marks a tab exited rather than removing it', () => {
    const opened = applyTerminalMessage(emptyTerminalState(), {
      type: 'terminal_opened',
      sessionId,
      terminalId: 't1',
      title: '1',
      cols: 80,
      rows: 24,
    })

    const state = applyTerminalMessage(opened, {
      type: 'terminal_exit',
      sessionId,
      terminalId: 't1',
      exitCode: 0,
    })

    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0]?.exited).toBe(true)
  })

  it('leaves unrelated messages alone', () => {
    const before = emptyTerminalState()
    const after = applyTerminalMessage(before, {
      type: 'caught_up',
      sessionId,
      lastSeq: 3,
    })

    expect(after).toBe(before)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dukebox/desktop test -- useTerminals`
Expected: FAIL — cannot resolve `./useTerminals.js`.

- [ ] **Step 3: Write the implementation**

First extend `apps/desktop/src/lib/stream.ts`, after `answerPermission`:

```ts
  openTerminal(sessionId: string, cols: number, rows: number): void {
    this.send({ type: 'terminal_open', sessionId, cols, rows })
  }

  attachTerminal(sessionId: string, terminalId: string, cols: number, rows: number): void {
    this.send({ type: 'terminal_attach', sessionId, terminalId, cols, rows })
  }

  detachTerminal(sessionId: string, terminalId: string): void {
    this.send({ type: 'terminal_detach', sessionId, terminalId })
  }

  /** `data` is already base64: the caller encodes what the keyboard produced. */
  sendTerminalInput(sessionId: string, terminalId: string, data: string): void {
    this.send({ type: 'terminal_input', sessionId, terminalId, data })
  }

  resizeTerminal(sessionId: string, terminalId: string, cols: number, rows: number): void {
    this.send({ type: 'terminal_resize', sessionId, terminalId, cols, rows })
  }

  closeTerminal(sessionId: string, terminalId: string): void {
    this.send({ type: 'terminal_close', sessionId, terminalId })
  }
```

Then create `apps/desktop/src/lib/useTerminals.ts`:

```ts
import type { ServerMessage } from '@dukebox/protocol'

/**
 * The terminals open in the current session.
 *
 * A reducer plus the state it folds, kept apart from the socket for the same
 * reason the transcript is: a pure function over messages can be tested without
 * a WebSocket, a container, or a DOM.
 *
 * Output is queued as base64 rather than written straight to xterm because the
 * component that owns the xterm instance may not be mounted when a chunk
 * arrives — the panel can be hidden, and the terminal keeps running anyway.
 */

export interface TerminalTab {
  terminalId: string
  title: string
  exited: boolean
  pending: string[]
}

export interface TerminalState {
  tabs: TerminalTab[]
}

export function emptyTerminalState(): TerminalState {
  return { tabs: [] }
}

export function applyTerminalMessage(state: TerminalState, message: ServerMessage): TerminalState {
  switch (message.type) {
    case 'terminal_list':
      // Authoritative: the server knows what is alive, and a tab left over
      // from a previous connection would be one nothing can be typed into.
      return {
        tabs: message.terminals.map((terminal) => ({
          terminalId: terminal.terminalId,
          title: terminal.title,
          exited: false,
          pending: [],
        })),
      }

    case 'terminal_opened':
      if (state.tabs.some((tab) => tab.terminalId === message.terminalId)) return state

      return {
        tabs: [
          ...state.tabs,
          {
            terminalId: message.terminalId,
            title: message.title,
            exited: false,
            pending: [],
          },
        ],
      }

    case 'terminal_output':
      return mapTab(state, message.terminalId, (tab) => ({
        ...tab,
        pending: [...tab.pending, message.data],
      }))

    case 'terminal_exit':
      // Kept in the list rather than removed. A shell's exit is information,
      // and a tab that vanishes leaves the user wondering what happened.
      return mapTab(state, message.terminalId, (tab) => ({ ...tab, exited: true }))

    default:
      return state
  }
}

/** Drop chunks already written to xterm, so they are not replayed on remount. */
export function drainTab(state: TerminalState, terminalId: string): TerminalState {
  return mapTab(state, terminalId, (tab) =>
    tab.pending.length === 0 ? tab : { ...tab, pending: [] },
  )
}

export function removeTab(state: TerminalState, terminalId: string): TerminalState {
  const tabs = state.tabs.filter((tab) => tab.terminalId !== terminalId)
  return tabs.length === state.tabs.length ? state : { tabs }
}

/**
 * Replace one tab, returning the same state object when nothing matched.
 *
 * Identity matters: React skips a render when the state is unchanged, and
 * output for a terminal that no longer exists is common enough during teardown
 * to be worth not re-rendering over.
 */
function mapTab(
  state: TerminalState,
  terminalId: string,
  update: (tab: TerminalTab) => TerminalTab,
): TerminalState {
  const index = state.tabs.findIndex((tab) => tab.terminalId === terminalId)
  if (index === -1) return state

  const tabs = [...state.tabs]
  tabs[index] = update(tabs[index]!)

  return { tabs }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @dukebox/desktop test -- useTerminals`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write apps/desktop/src/lib/stream.ts apps/desktop/src/lib/useTerminals.ts apps/desktop/src/lib/useTerminals.test.ts
git add apps/desktop/src/lib/stream.ts apps/desktop/src/lib/useTerminals.ts apps/desktop/src/lib/useTerminals.test.ts
git commit -m "feat(desktop): terminal state reducer and stream commands

Output is queued rather than written straight through: the panel that
owns the xterm instance can be hidden while the terminal keeps running."
```

---

### Task 9: Desktop — wire terminal state into the session hook

**Files:**

- Modify: `apps/desktop/src/lib/useSession.ts:25` (widen `LiveSession`), `:66` (handle messages), `:101` (reset on session switch)
- Test: covered by Task 8's reducer tests plus the manual check below.

**Interfaces:**

- Consumes: `applyTerminalMessage`, `emptyTerminalState`, `drainTab`, `removeTab`, `TerminalState` from Task 8.
- Produces: `LiveSession` gains

```ts
  terminals: TerminalState
  openTerminal: (cols: number, rows: number) => void
  attachTerminal: (terminalId: string, cols: number, rows: number) => void
  detachTerminal: (terminalId: string) => void
  sendTerminalInput: (terminalId: string, data: string) => void
  resizeTerminal: (terminalId: string, cols: number, rows: number) => void
  closeTerminal: (terminalId: string) => void
  drainTerminal: (terminalId: string) => void
```

Task 10 consumes all of these.

- [ ] **Step 1: Write the implementation**

There is no new pure logic here — Task 8 tested the reducer, and this step is wiring. Add to `LiveSession` the fields above, then inside `useSession`:

```ts
const [terminals, setTerminals] = useState<TerminalState>(emptyTerminalState)
```

In the `onMessage` switch, replace the `default`-less tail so terminal messages reach the reducer. Add these cases before the closing brace:

```ts
            case 'terminal_list':
            case 'terminal_opened':
            case 'terminal_output':
            case 'terminal_exit':
              setTerminals((current) => applyTerminalMessage(current, message))
              return
```

In the session-switch effect, reset alongside the transcript:

```ts
setTerminals(emptyTerminalState())
```

Add the callbacks near `respond`:

```ts
const openTerminal = useCallback(
  (cols: number, rows: number) => {
    if (sessionId) streamRef.current?.openTerminal(sessionId, cols, rows)
  },
  [sessionId],
)

const attachTerminal = useCallback(
  (terminalId: string, cols: number, rows: number) => {
    if (sessionId) streamRef.current?.attachTerminal(sessionId, terminalId, cols, rows)
  },
  [sessionId],
)

const detachTerminal = useCallback(
  (terminalId: string) => {
    if (sessionId) streamRef.current?.detachTerminal(sessionId, terminalId)
  },
  [sessionId],
)

const sendTerminalInput = useCallback(
  (terminalId: string, data: string) => {
    if (sessionId) streamRef.current?.sendTerminalInput(sessionId, terminalId, data)
  },
  [sessionId],
)

const resizeTerminal = useCallback(
  (terminalId: string, cols: number, rows: number) => {
    if (sessionId) streamRef.current?.resizeTerminal(sessionId, terminalId, cols, rows)
  },
  [sessionId],
)

const closeTerminal = useCallback(
  (terminalId: string) => {
    if (!sessionId) return

    streamRef.current?.closeTerminal(sessionId, terminalId)

    // Removed here rather than waiting for terminal_exit: the tab was closed
    // deliberately, and leaving it on screen until the server confirms makes
    // the X feel broken.
    setTerminals((current) => removeTab(current, terminalId))
  },
  [sessionId],
)

const drainTerminal = useCallback((terminalId: string) => {
  setTerminals((current) => drainTab(current, terminalId))
}, [])
```

Return all of them from the hook alongside the existing fields.

- [ ] **Step 2: Verify it typechecks and nothing regressed**

Run: `pnpm exec turbo run typecheck`
Expected: PASS.

Run: `pnpm --filter @dukebox/desktop test`
Expected: PASS — the existing desktop suite stays green.

- [ ] **Step 3: Commit**

```bash
pnpm exec prettier --write apps/desktop/src/lib/useSession.ts
git add apps/desktop/src/lib/useSession.ts
git commit -m "feat(desktop): expose terminal state and commands from useSession"
```

---

### Task 10: Desktop — the Terminal component

**Files:**

- Modify: `apps/desktop/package.json` (add `@xterm/xterm`, `@xterm/addon-fit`)
- Create: `apps/desktop/src/components/Terminal.tsx`
- Modify: `apps/desktop/src/styles.css` (import xterm's stylesheet)

**Interfaces:**

- Consumes: `TerminalTab` from Task 8; the callbacks from Task 9.
- Produces: `<Terminal>` with props

```ts
interface TerminalProps {
  tab: TerminalTab
  active: boolean
  onInput: (data: string) => void
  onResize: (cols: number, rows: number) => void
  onDrain: () => void
}
```

Task 11 renders this.

- [ ] **Step 1: Add the dependencies**

Run: `pnpm --filter @dukebox/desktop add @xterm/xterm @xterm/addon-fit`

Then add to `apps/desktop/src/styles.css`, at the top with the other imports:

```css
@import '@xterm/xterm/css/xterm.css';
```

- [ ] **Step 2: Write the component**

Create `apps/desktop/src/components/Terminal.tsx`:

```tsx
import { FitAddon } from '@xterm/addon-fit'
import { Terminal as Xterm } from '@xterm/xterm'
import { useEffect, useRef } from 'react'
import type { TerminalTab } from '../lib/useTerminals.js'

/**
 * One shell, rendered.
 *
 * The xterm instance is created once and kept for the life of the tab. It is
 * hidden rather than unmounted when another tab is selected: xterm rebuilds its
 * screen from scratch on mount, so unmounting would mean a full replay flash
 * every time someone switches between two terminals.
 */

interface TerminalProps {
  tab: TerminalTab
  active: boolean
  onInput: (data: string) => void
  onResize: (cols: number, rows: number) => void
  onDrain: () => void
}

/** Dragging a window edge fires continuously; each resize is a round trip. */
const RESIZE_DEBOUNCE_MS = 120

export function Terminal({ tab, active, onInput, onResize, onDrain }: TerminalProps) {
  const host = useRef<HTMLDivElement>(null)
  const xterm = useRef<Xterm | null>(null)
  const fit = useRef<FitAddon | null>(null)

  // Read by long-lived listeners that must not be re-registered on every
  // render — rebinding xterm's onData would double every keystroke.
  const handlers = useRef({ onInput, onResize })
  handlers.current = { onInput, onResize }

  useEffect(() => {
    if (!host.current) return

    const terminal = new Xterm({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12.5,
      // Read from the app's own palette so a terminal is not a black rectangle
      // pasted into a light UI.
      theme: themeFromCss(),
      cursorBlink: true,
      scrollback: 5000,
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(host.current)
    fitAddon.fit()

    terminal.onData((data) => {
      // Base64 of the raw bytes. `btoa` needs latin1, and a multi-byte
      // character typed or pasted would throw without this encode first.
      handlers.current.onInput(base64(data))
    })

    xterm.current = terminal
    fit.current = fitAddon

    return () => {
      terminal.dispose()
      xterm.current = null
      fit.current = null
    }
  }, [])

  // Refit and report the size whenever the panel changes shape.
  useEffect(() => {
    if (!host.current) return

    let timer: ReturnType<typeof setTimeout> | null = null

    const observer = new ResizeObserver(() => {
      if (timer) clearTimeout(timer)

      timer = setTimeout(() => {
        const terminal = xterm.current
        if (!terminal || !fit.current) return

        fit.current.fit()
        handlers.current.onResize(terminal.cols, terminal.rows)
      }, RESIZE_DEBOUNCE_MS)
    })

    observer.observe(host.current)

    return () => {
      if (timer) clearTimeout(timer)
      observer.disconnect()
    }
  }, [])

  // Write whatever arrived while this component could not.
  useEffect(() => {
    const terminal = xterm.current
    if (!terminal || tab.pending.length === 0) return

    for (const chunk of tab.pending) {
      terminal.write(decode(chunk))
    }

    onDrain()
  }, [tab.pending, onDrain])

  // Refit on becoming visible: a terminal sized while hidden measures a
  // zero-height box and comes back one row tall.
  useEffect(() => {
    if (!active || !fit.current || !xterm.current) return

    fit.current.fit()
    handlers.current.onResize(xterm.current.cols, xterm.current.rows)
  }, [active])

  return (
    <div className={`min-h-0 flex-1 ${active ? 'flex' : 'hidden'} flex-col`}>
      <div ref={host} className="min-h-0 flex-1 px-2 py-1.5" />
      {tab.exited && (
        <p className="border-t border-border px-3 py-1.5 text-[12px] text-muted-foreground">
          This shell exited.
        </p>
      )}
    </div>
  )
}

/** UTF-8 safe base64, which `btoa` alone is not. */
function base64(value: string): string {
  const bytes = new TextEncoder().encode(value)
  return btoa(String.fromCharCode(...bytes))
}

function decode(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

/**
 * Pull terminal colours from the app's CSS variables.
 *
 * xterm wants concrete colours rather than `var(...)`, so these are resolved
 * once at construction against the live stylesheet.
 */
function themeFromCss(): Record<string, string> {
  const styles = getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback

  return {
    background: read('--color-surface', '#111111'),
    foreground: read('--color-foreground', '#e6e6e6'),
    cursor: read('--color-foreground', '#e6e6e6'),
  }
}
```

Before writing `themeFromCss`, open `apps/desktop/src/styles.css` and use the variable names that actually exist there. The names above are the ones `Workspace.tsx` implies through `bg-surface` and `text-foreground`; if the CSS defines them differently, use the real names and keep the fallbacks.

- [ ] **Step 3: Verify it builds**

Run: `pnpm exec turbo run typecheck`
Expected: PASS.

Run: `pnpm --filter @dukebox/desktop test`
Expected: PASS — no new tests here by design. xterm drives the real DOM and a canvas; a test around this component would be testing xterm, not our code.

- [ ] **Step 4: Commit**

```bash
pnpm exec prettier --write apps/desktop/src/components/Terminal.tsx apps/desktop/src/styles.css apps/desktop/package.json
git add apps/desktop/src/components/Terminal.tsx apps/desktop/src/styles.css apps/desktop/package.json pnpm-lock.yaml
git commit -m "feat(desktop): xterm-backed terminal component

Hidden rather than unmounted when inactive: xterm rebuilds its screen on
mount, so unmounting would flash a full replay on every tab switch."
```

---

### Task 11: Desktop — the tab bar in Workspace

**Files:**

- Modify: `apps/desktop/src/components/Workspace.tsx:26` (props), `:56` (panel switch), `:119` (`Panels`)
- Modify: `apps/desktop/src/screens/Session.tsx` (pass the new props)

**Interfaces:**

- Consumes: `Terminal` from Task 10; `TerminalState` and the callbacks from Task 9.
- Produces: `Workspace` gains these props:

```ts
  terminals: TerminalState
  onOpenTerminal: (cols: number, rows: number) => void
  onAttachTerminal: (terminalId: string, cols: number, rows: number) => void
  onDetachTerminal: (terminalId: string) => void
  onTerminalInput: (terminalId: string, data: string) => void
  onTerminalResize: (terminalId: string, cols: number, rows: number) => void
  onCloseTerminal: (terminalId: string) => void
  onDrainTerminal: (terminalId: string) => void
```

- [ ] **Step 1: Write the implementation**

In `Workspace.tsx`, extend `Props` with the fields above and add tab state:

```ts
type WorkspaceTab = 'files' | 'terminal'
```

Replace the body's panel switch so the expanded state renders a tab bar plus the active panel. Keep `Metrics` untouched for the collapsed state — a collapsed panel has no room for tabs, and the counts are what it exists to show.

```tsx
{
  collapsed ? (
    <Metrics session={session} files={files} />
  ) : (
    <>
      <TabBar active={tab} onSelect={setTab} />
      {tab === 'files' ? (
        <Panels session={session} files={files} />
      ) : (
        <TerminalPanel session={session} {...props} />
      )}
    </>
  )
}
```

Add the tab bar:

```tsx
/**
 * Files or terminal.
 *
 * Two tabs rather than a dropdown: there are two, and a menu to choose between
 * two things costs a click to show what a pair of labels shows for free.
 */
function TabBar({
  active,
  onSelect,
}: {
  active: WorkspaceTab
  onSelect: (tab: WorkspaceTab) => void
}) {
  return (
    <div
      role="tablist"
      aria-label="Workspace panels"
      className="flex gap-1 border-b border-border px-2 py-1.5"
    >
      {(['files', 'terminal'] as const).map((tab) => (
        <button
          key={tab}
          role="tab"
          aria-selected={active === tab}
          onClick={() => onSelect(tab)}
          className={`rounded-[calc(var(--radius)*0.6)] px-2.5 py-1 text-[12.5px] capitalize ${
            active === tab
              ? 'bg-muted font-medium text-foreground'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground'
          }`}
        >
          {tab}
        </button>
      ))}
    </div>
  )
}
```

Add the terminal panel, which owns the sub-tabs and the attach/detach lifecycle:

```tsx
/**
 * The shells open in this session.
 *
 * Attaching and detaching happens here rather than in `Terminal`: leaving the
 * panel should stop output reaching a component nobody is looking at, without
 * killing the process behind it.
 */
function TerminalPanel({
  session,
  terminals,
  onOpenTerminal,
  onAttachTerminal,
  onDetachTerminal,
  onTerminalInput,
  onTerminalResize,
  onCloseTerminal,
  onDrainTerminal,
}: TerminalPanelProps) {
  const [selected, setSelected] = useState<string | null>(null)

  const tabs = terminals.tabs
  const active = tabs.find((tab) => tab.terminalId === selected) ?? tabs[0] ?? null

  // Follow the newest terminal. Opening one and landing on an old tab reads as
  // the button having done nothing.
  useEffect(() => {
    const newest = tabs.at(-1)
    if (newest && !tabs.some((tab) => tab.terminalId === selected)) {
      setSelected(newest.terminalId)
    }
  }, [tabs, selected])

  // Attach on mount, detach on unmount. The dependency is the id list rather
  // than the tabs themselves, which change identity on every chunk of output.
  const ids = tabs.map((tab) => tab.terminalId).join(',')
  useEffect(() => {
    const current = ids ? ids.split(',') : []
    for (const terminalId of current) onAttachTerminal(terminalId, 80, 24)

    return () => {
      for (const terminalId of current) onDetachTerminal(terminalId)
    }
  }, [ids, onAttachTerminal, onDetachTerminal])

  if (!session) {
    return (
      <p className="px-4 py-4 text-[12.5px] text-muted-foreground">
        Select a session to open a terminal in it.
      </p>
    )
  }

  if (tabs.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-start gap-2.5 px-4 py-4">
        <p className="text-[12.5px] text-muted-foreground">
          No terminal is open. A shell here runs inside this session’s container.
        </p>
        <button
          onClick={() => onOpenTerminal(80, 24)}
          className="rounded-[calc(var(--radius)*0.6)] bg-muted px-2.5 py-1.5 text-[12.5px] font-medium hover:bg-border"
        >
          New terminal
        </button>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        {tabs.map((tab) => (
          <span
            key={tab.terminalId}
            className={`flex items-center gap-1 rounded-[calc(var(--radius)*0.6)] pr-1 pl-2.5 text-[12.5px] ${
              tab.terminalId === active?.terminalId ? 'bg-muted' : 'hover:bg-muted'
            }`}
          >
            <button
              onClick={() => setSelected(tab.terminalId)}
              className={tab.exited ? 'py-1 text-muted-foreground line-through' : 'py-1'}
            >
              {tab.title}
            </button>
            <button
              onClick={() => onCloseTerminal(tab.terminalId)}
              aria-label={`Close terminal ${tab.title}`}
              className="grid size-5 place-items-center rounded-[calc(var(--radius)*0.5)] text-muted-foreground hover:bg-border hover:text-foreground"
            >
              ×
            </button>
          </span>
        ))}

        {tabs.length < 4 && (
          <button
            onClick={() => onOpenTerminal(80, 24)}
            aria-label="New terminal"
            className="grid size-6 place-items-center rounded-[calc(var(--radius)*0.6)] text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            +
          </button>
        )}
      </div>

      {tabs.map((tab) => (
        <Terminal
          key={tab.terminalId}
          tab={tab}
          active={tab.terminalId === active?.terminalId}
          onInput={(data) => onTerminalInput(tab.terminalId, data)}
          onResize={(cols, rows) => onTerminalResize(tab.terminalId, cols, rows)}
          onDrain={() => onDrainTerminal(tab.terminalId)}
        />
      ))}
    </div>
  )
}
```

Define `TerminalPanelProps` as the terminal-related subset of `Props` plus `session`. Import `Terminal` from `./Terminal.js` and `useEffect`/`useState` as needed.

Update the doc comment at the top of `Workspace.tsx`: it currently promises "The terminal and preview tabs arrive later" in `Panels`. Change that line to say the terminal is here and the preview is not.

Finally, in `Session.tsx`, pass the new props through from `useSession`. Read the file first and match how it already threads `session` and `files` into `<Workspace>`.

- [ ] **Step 2: Verify**

Run: `pnpm exec turbo run typecheck`
Expected: PASS.

Run: `pnpm --filter @dukebox/desktop test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
pnpm exec prettier --write apps/desktop/src/components/Workspace.tsx apps/desktop/src/screens/Session.tsx
git add apps/desktop/src/components/Workspace.tsx apps/desktop/src/screens/Session.tsx
git commit -m "feat(desktop): terminal tab in the workspace panel

Attach and detach live in the panel rather than the terminal component,
so hiding the panel stops output without killing the shell."
```

---

### Task 12: Preview — a scripted terminal

**Files:**

- Modify: `apps/desktop/src/preview.tsx`

**Interfaces:**

- Consumes: everything above.
- Produces: nothing new. `preview.html` renders the terminal tab with a fake terminal, so the UI can be exercised with no server, container, or agent — the workflow `AGENTS.md` documents as the way to develop the frontend in the cloud VM.

- [ ] **Step 1: Write the implementation**

Read `apps/desktop/src/preview.tsx` first to see how it fakes a session. Add terminal state in the same style: one tab, titled `1`, pre-loaded with a scripted `pending` chunk so the panel shows a realistic screen.

```tsx
const terminalScript = [
  'node@dukebox:/workspace/repo$ pnpm test\r\n',
  '\r\n',
  ' [32m✓[0m packages/protocol/src/commands.test.ts (8)\r\n',
  ' [32m✓[0m apps/server/src/sessions/terminals.test.ts (15)\r\n',
  '\r\n',
  ' Test Files  [32m2 passed[0m (2)\r\n',
  'node@dukebox:/workspace/repo$ ',
].join('')

const previewTerminals: TerminalState = {
  tabs: [
    {
      terminalId: 'preview-terminal',
      title: '1',
      exited: false,
      pending: [btoa(terminalScript)],
    },
  ],
}
```

Wire it into the preview's `<Workspace>` with no-op callbacks, except `onTerminalInput`, which should echo back into the tab so typing visibly does something. Keep it simple — echoing the same bytes is enough to prove the input path is connected.

- [ ] **Step 2: Verify by running it**

Run: `pnpm --filter @dukebox/desktop dev`

Open `http://localhost:5173/preview.html`, click the Terminal tab, and confirm: the scripted output renders with colour, the `+` button is present, and typing echoes. Port 5173 is `strictPort`; free it with `lsof -ti :5173 | xargs kill` if it is taken.

- [ ] **Step 3: Commit**

```bash
pnpm exec prettier --write apps/desktop/src/preview.tsx
git add apps/desktop/src/preview.tsx
git commit -m "feat(desktop): scripted terminal in the preview harness"
```

---

### Task 13: Full verification

**Files:** none.

- [ ] **Step 1: Format check**

Run: `pnpm exec prettier --check .`
Expected: PASS. Fix with `--write` if not.

- [ ] **Step 2: Typecheck**

Run: `pnpm exec turbo run typecheck`
Expected: PASS.

- [ ] **Step 3: Tests**

```bash
export DUKEBOX_DATABASE_URL='postgres://dukebox:dukebox@127.0.0.1:5433/dukebox'
export DUKEBOX_REDIS_URL='redis://127.0.0.1:6380'
pnpm exec turbo run test
```

Expected: PASS, except the container-lifecycle suites documented in `AGENTS.md` as unable to run in the Cursor Cloud VM (`packages/sandbox`: `container.test.ts`, `credentials.integration.test.ts`, `workspace.test.ts`; `apps/server`: `sessions/manager.test.ts`). Report exactly which suites failed and why — do not claim a green run that did not happen.

- [ ] **Step 4: Container verification on a real host**

On the Linux VPS (not the Cursor Cloud VM): `./docker/verify.sh`
Expected: PASS, including `openTerminal` from Task 3 and the manager tests from Task 6.

If a VPS is not available in this session, say so explicitly rather than marking this step done.

---

## Notes for the implementer

**Where the spec and the codebase disagree.** The spec says terminal state lives in "the existing zustand store". It does not — `useSession` holds session state in `useState`/`useRef`, and zustand is used elsewhere. Task 8 follows the codebase. This is deliberate, not an oversight.

**Order matters.** Tasks 1–2 (protocol) unblock everything. Tasks 3–7 are the server, in order. Tasks 8–12 are the desktop, in order. Task 3 can run in parallel with Tasks 1–2 if you want, but nothing else can be reordered.

**Tests you cannot run here.** The Cursor Cloud VM cannot create containers with resource limits. Tasks 3, 6, and 13 all hit this. Write the code, confirm typecheck, and be honest in the report about what was verified and what was deferred.
