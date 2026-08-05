# Terminal tab in the workspace panel

## Summary

The workspace panel gains a tab bar — `Files | Terminal` — and the Terminal tab
hosts up to four interactive shells running inside the session's container. A
shell survives the client disconnecting: switching to the Files tab, closing the
app, or losing the network leaves the process running, and reattaching redraws
the screen from a server-side scrollback buffer.

Today `Workspace.tsx` renders one thing, the list of changed files, and its
comment notes that "the terminal and preview tabs arrive later". This is that
terminal. The preview tab stays out of scope.

## Motivation

An agent session already runs commands in a container, but the person watching
cannot run one themselves. Inspecting state the transcript does not show —
checking a process, reading a file the agent did not touch, running a test by
hand — currently means leaving the app entirely.

## Design decisions

Four decisions shape everything below.

**Interactive, not a replay of the agent's commands.** A read-only view of the
bash tool calls the agent already makes would be a frontend-only change, but it
answers a different question. This is a real shell the user drives.

**Multiple terminals per session, persistent across disconnects.** A terminal
tied to the panel's visibility loses a `tail -f` every time the user checks the
diff. The server owns the process; the client attaches and detaches.

**Docker exec with `Tty: true`, not `node-pty` and not `tmux`.** Docker already
allocates the PTY and exposes `exec.resize`. `node-pty` would need a native
module compiled into the base image for no capability we lack. `tmux` would give
persistence for free but adds a base-image dependency and moves resize and
terminal state into a negotiation with tmux rather than with Docker.

**Audit the fact, not the content.** Opening and closing a terminal is recorded
in the session's persisted event stream with the device that did it. Keystrokes
and output are never persisted. A user pastes secrets into a shell; a keystroke
log in the database is a liability that outweighs the forensic value.

## Threat model

The project treats the container as hostile: it runs an autonomous agent with
network access, so it gets `CapDrop: ALL`, `no-new-privileges`, a restricted
network, no Docker socket, and no root. A terminal is a different channel into
that same container — the user typing rather than the model — and it inherits
every one of those controls. A shell there holds no privilege the agent does not
already hold.

What it does change:

- **Who can open one.** Any paired device that can subscribe to a session can
  open a terminal in it. That device can already send arbitrary prompts to an
  agent that executes commands, so this grants no new reach — but it is stated
  rather than assumed.
- **What is recorded.** Agent commands land in the persisted event stream.
  Terminal I/O deliberately does not; see the audit decision above.

## Architecture

Four layers, each with one responsibility:

| Layer                                         | Responsibility                                                      |
| --------------------------------------------- | ------------------------------------------------------------------- |
| `packages/sandbox`                            | `SessionContainer.openTerminal()` — the only code that knows Docker |
| `apps/server/src/sessions/terminals.ts` (new) | `TerminalRegistry` — owns live PTYs, buffers, limits                |
| `packages/protocol`                           | Terminal commands and messages, plus two audit events               |
| `apps/desktop`                                | Tab bar, sub-tabs, xterm.js                                         |

`TerminalRegistry` knows nothing about WebSockets; `Terminal.tsx` knows nothing
about Docker. The registry's surface is `open`, `attach`, `detach`, `write`,
`resize`, `close`, and `closeSession`.

### Sandbox

```ts
interface TerminalHandle {
  stream: Duplex                                  // raw; a TTY exec is not framed
  resize: (cols: number, rows: number) => Promise<void>
  close: () => Promise<void>
}

openTerminal(options: { cols: number; rows: number; cwd?: string }): Promise<TerminalHandle>
```

Implemented as `container.exec({ Cmd: ['/bin/bash', '-l'], Tty: true,
AttachStdin: true, AttachStdout: true, AttachStderr: true })`. Unlike
`execStream`, there is no demultiplexing: Docker's 8-byte frame headers exist
only for TTY-less execs, and a TTY exec merges stdout and stderr into one
stream, which is what a terminal wants. `resize` calls `exec.resize({ h, w })`.

`/bin/bash` is present — `node:22-bookworm-slim` ships it. No base-image change
is required.

### Terminal registry

```ts
interface LiveTerminal {
  terminalId: string
  sessionId: string
  handle: TerminalHandle
  scrollback: RingBuffer // capped at 128 KB
  size: { cols: number; rows: number }
  listeners: Set<(chunk: Buffer) => void>
}
```

**Output.** Every chunk from the exec is appended to `scrollback` and fanned out
to `listeners`. With no listeners the buffer still fills, which is what makes a
detached terminal worth reattaching to. `attach` returns the buffer's contents
and registers a listener.

**Why a capped ring buffer.** An accidental `yes` produces megabytes a second.
A fixed cap makes the worst case knowable: 4 terminals × 128 KB × live sessions.
Unbounded history makes control-plane memory hostage to whatever someone types.

**Backpressure.** When a socket's `bufferedAmount` exceeds a threshold, chunks
for that listener are dropped and the gap is marked. A terminal that skips lines
under a flood is acceptable; a control plane that runs out of memory buffering
for one slow client is not.

**Input.** `terminal_input` writes the decoded bytes straight to the stream. No
interpretation and no filtering — Ctrl-C included.

**Limit.** Four terminals per session. Beyond that `terminal_open` returns
`command_error`. Without a cap, a client-side retry bug creates PTYs until it
hits the container's `PidsLimit: 512` and takes the session down.

**Lifecycle.** The registry hooks into the session lifecycle in `manager.ts`:
when a session reaches a terminal status (`done`, `failed`, `stopped`), its
terminals are closed and their buffers released. A PTY outliving its container
is a guaranteed leak.

**Errors.** A dead container on `terminal_open` yields `command_error` and no
registry entry. A stream that ends on its own emits `terminal_exit` to listeners
and removes the entry. The client marks the sub-tab as exited rather than
removing it — a shell's exit is information, and a tab that vanishes leaves the
user wondering what happened.

## Protocol

Terminal traffic does **not** go through `EventBus`. That stream is persisted,
sequenced, and replayable via `resumeFrom` / `lastSeq`; PTY bytes are ephemeral,
high-volume, and per-connection. Routing them through it would pollute the
session transcript and make replay unmanageable. These messages ride the
existing WebSocket as their own message types.

### Client to server

```ts
terminal_open    { sessionId, cols, rows }              // server assigns terminalId
terminal_attach  { sessionId, terminalId, cols, rows }
terminal_detach  { sessionId, terminalId }              // stop receiving; PTY lives on
terminal_input   { sessionId, terminalId, data }        // base64
terminal_resize  { sessionId, terminalId, cols, rows }
terminal_close   { sessionId, terminalId }              // kill the PTY
```

### Server to client

```ts
terminal_opened  { sessionId, terminalId, title, cols, rows }
terminal_output  { sessionId, terminalId, data }        // base64
terminal_exit    { sessionId, terminalId, exitCode? }
terminal_list    { sessionId, terminals: [{ terminalId, title }] }
```

All are added to the `clientCommand` and `serverMessage` discriminated unions in
`packages/protocol/src/commands.ts`.

**Base64 for `data`.** TTY output is binary — ANSI escape sequences, and UTF-8
sequences split across chunk boundaries. Embedding it raw in JSON forces an
encoding decision at every hop; base64 settles it once. The 33% size cost is
paid on a local tailnet link.

**`terminal_list` accompanies `subscribe`.** Opening a session already
subscribes, and the server includes the live terminal list in that exchange.
Otherwise the client needs a second round-trip and the tab flashes empty first.

**`detach` is not `close`.** Switching to the Files tab detaches — output stops
reaching an unmounted component, but the `tail -f` keeps running. The X on a
sub-tab closes, which kills the process. Two distinct gestures, two messages.

### Audit events

Two new variants in `packages/protocol/src/events.ts`, persisted through
`EventBus` like any other session event:

```ts
{ type: 'terminal_opened', terminalId, deviceId }
{ type: 'terminal_closed', terminalId, deviceId, exitCode? }
```

No content, ever.

## Desktop UI

**Tab bar.** `Panels` in `Workspace.tsx` currently renders the file list
directly. It gains a `Files | Terminal` bar beneath the header with the active
panel below it. `Files` keeps exactly its current behaviour. The bar appears
only when expanded; collapsed still renders `Metrics`, unchanged.

**Sub-tabs.** Inside the Terminal panel, a row of chips `1 2 3 +`, each with a
close X. With zero terminals, an empty state with a "New terminal" button rather
than an empty chip row. Titles default to the index; renaming is out of scope.

**xterm.js.** New dependencies in `apps/desktop`: `@xterm/xterm` and
`@xterm/addon-fit`. One instance per live terminal. Inactive ones stay mounted
but `hidden` rather than unmounting — xterm rebuilds its screen from scratch on
mount, so unmounting on every chip switch would mean a full attach-and-replay
flash each time.

**Resize.** `FitAddon` observes the container and each size change sends
`terminal_resize`, debounced. Dragging a window edge fires dozens of events a
second and each one is a round-trip to Docker.

**Detach on tab switch.** Leaving for the Files tab detaches every terminal;
returning reattaches and redraws from scrollback.

**Theme.** xterm is configured from the CSS variables the app already uses, so
it is not a black rectangle pasted into a light UI.

**State.** Terminal state lives in the existing zustand session store, not local
to `Workspace`. The WebSocket delivers `terminal_output` at app level, and a
component cannot own a channel that outlives its own mounting.

## Testing

The registry and the protocol carry the weight:

- Registry lifecycle: open, attach, detach, close, the four-terminal cap, and
  cleanup when a session reaches a terminal status.
- Ring buffer: cap enforcement and truncation behaviour.
- Protocol: zod round-trips for every new command and message.
- Sandbox `openTerminal`: covered by the container integration tests, which
  require a Linux host with non-threaded cgroups (see `AGENTS.md`).

`Terminal.tsx` gets light coverage only. xterm touches the real DOM and canvas,
and testing it thoroughly tests xterm rather than our code.

`preview.html`, which already exercises the frontend with no server, gains a
scripted terminal so the tab can be developed without a container.

## Out of scope

- The preview tab.
- Renaming terminals.
- Splitting or tiling panes.
- Persisting scrollback across a control-plane restart. The registry is
  in-memory; restarting the server ends every terminal. Sessions already do not
  survive that.
