# Dukebox

Self-hosted cloud agents manager. Run coding agents on your own VPS, drive them from a native desktop app.

> Named after Duke, a very good dog.

## What it does

Coding agents like Claude Code live in a terminal. Dukebox gives them a proper home:

- **Sandbox-first.** Every agent session runs in its own Docker container with your repo cloned, your env vars, your setup scripts.
- **Not a terminal.** Agent output is parsed into structured events and rendered as chat, collapsible tool calls, and reviewable diffs.
- **Your infrastructure.** One install script sets up your VPS. No SaaS, no telemetry, no accounts.
- **Native desktop app.** Built with Tauri — small binary, low memory, works on macOS, Windows, and Linux.

## Status

Early development. Not usable yet.

## Architecture

```
Desktop app (Tauri)  ──Tailscale──>  Control plane (VPS)
                                        │
                                        ├─ Postgres, Redis
                                        └─ Docker ── agent containers
```

The desktop app ships with no baked-in configuration. It learns where your server is from a pairing link the installer prints.

Agent integrations go through an adapter layer that normalizes each agent's output into a common event stream, so the UI never knows which agent it is talking to.

## Repository layout

| Path                 | Contents                                            |
| -------------------- | --------------------------------------------------- |
| `apps/desktop`       | Tauri desktop app (React frontend, Rust shell)      |
| `apps/server`        | Control plane                                       |
| `packages/protocol`  | Shared event and config types — the source of truth |
| `packages/adapters`  | Agent adapters                                      |
| `packages/sandbox`   | Docker container lifecycle                          |
| `packages/transport` | Network transport (Tailscale)                       |
| `packages/db`        | Database schema and migrations                      |
| `install/`           | VPS installer                                       |
| `docker/`            | Containerized development and verification          |

## Development

Requires Docker, and nothing else. Dependencies, build output, and the test
databases all live inside containers — none of it is installed on your machine.

```bash
./docker/verify.sh              # typecheck, format check, and tests
./docker/verify.sh --shell      # a shell in the dev container
./docker/verify.sh --down       # tear the stack down
```

Build the image agent sessions run in:

```bash
docker build -t dukebox/base-node:latest images/base-node
```

Then take the sandbox for a spin against a real repository. It clones, makes a
change, reports the diff, prints the container's hardening, and cleans up:

```bash
./docker/verify.sh -- pnpm --filter @dukebox/sandbox smoke \
  https://github.com/octocat/Hello-World.git master
```

### Updating a server

The server builds only the control plane and what it imports. Building
everything would pull in the desktop app, whose dependencies a server has no
reason to install:

```bash
cd /opt/dukebox
sudo -u dukebox git pull
sudo -u dukebox pnpm install --frozen-lockfile --filter '@dukebox/server...'
sudo -u dukebox pnpm --filter '@dukebox/server...' build
sudo systemctl restart dukebox
```

Re-running the installer does the same thing and is the better habit — it also
applies any new migrations and unit-file changes.

### The desktop app

Tauri opens a native window and compiles Rust, neither of which a container
can do for you — so this is the one part that installs on your machine:

```bash
pnpm install --filter @dukebox/desktop...   # ~180 MB, desktop only
pnpm --filter @dukebox/protocol build       # the app imports it
pnpm --filter @dukebox/desktop tauri dev
```

The first Rust build takes several minutes; later ones take seconds.

`tauri dev` needs port 5173, and fails outright rather than moving — the Rust
shell loads that exact address, so a port that moved would leave the window
blank. If something else has it:

```bash
lsof -ti :5173 | xargs kill
```

You will need a pairing link from a running server. Print one with:

```bash
sudo -u dukebox dukebox pair new
```

### Looking at the UI without a server

The conversation and the review panel render from a scripted session at
`/preview.html` — no server, no container, no agent. It is served by the same
dev server, so open it while `tauri dev` is running rather than starting a
second one:

```
http://localhost:5173/preview.html
```

## License

MIT
