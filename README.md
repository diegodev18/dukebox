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

Working on the desktop app additionally requires Rust, since it compiles a
native binary:

```bash
pnpm --filter @dukebox/desktop tauri dev
```

## License

MIT
