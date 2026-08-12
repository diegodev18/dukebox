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

## Installing

### The desktop app

The app installs from a downloaded installer — no checkout, no build. Grab the
newest one for your machine from the
[latest release](https://github.com/diegodev18/dukebox/releases/latest):

| Platform | Asset                                                                |
| -------- | -------------------------------------------------------------------- |
| macOS    | `Dukebox_0.1.0_aarch64.dmg` (Apple silicon) or `_x86_64.dmg` (Intel) |
| Windows  | `Dukebox_0.1.0_x64-setup.exe`                                        |
| Linux    | `dukebox_0.1.0_amd64.deb` (or the `.AppImage`)                       |

The installers are not signed by Apple or Microsoft yet, so the OS will warn
once per installation. The warning is about the developer's identity, not the
app's integrity (the macOS bundle is ad-hoc signed; verify with
`codesign --verify --deep --strict /Applications/Dukebox.app`).

**macOS** — the first launch shows _"Apple could not verify that Dukebox does
not contain malware"_ (or _"is from an unidentified developer"_). It appears
because the download carries a quarantine tag, which any browser sets. Either
bypass works, once:

```bash
# Right-click the app in Applications → Open → Open, or:
xattr -dr com.apple.quarantine /Applications/Dukebox.app
```

**Windows** — "More info → Run anyway".

First run shows the pairing screen — paste the link a server installer prints
(below) and the app finds its server.

To drop the macOS warning for everyone, sign the release with an Apple
Developer ID and notarize it: generate a Developer ID Application certificate
and set the `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
`APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID`
secrets. The release workflow then signs and notarizes instead of ad-hoc
signing.

### The server

Runs on a Debian or Ubuntu VPS:

```bash
curl -fsSL https://raw.githubusercontent.com/diegodev18/dukebox/main/install/install.sh | bash
```

The installer prints a pairing link for the desktop app, and re-running it is
how you update the server (see "Updating a server" below).

## Updating

The desktop app checks for new versions when it launches and whenever you pick
"Check for updates…" from the account menu at the foot of the sidebar. When a
newer version exists, a banner appears across the top of the window; **Update &
restart** downloads, installs, and relaunches into the new build in one click,
and "Later" defers it until the next check. Every bundle is signed, and the app
refuses to install one whose signature does not verify against the public key
compiled into it.

### Releasing a new desktop version

The `Release desktop app` workflow builds installers for all three platforms
and uploads them to a GitHub Release — which is also the feed the app's update
check reads. To publish:

1. Bump the version to match in `apps/desktop/src-tauri/tauri.conf.json`,
   `apps/desktop/src-tauri/Cargo.toml`, and `apps/desktop/package.json`.
2. Commit, then tag and push:
   ```bash
   git tag desktop-v0.1.0
   git push origin desktop-v0.1.0
   ```
3. Open the draft release the workflow created, check the assets, and publish it.

The workflow signs update bundles with the `TAURI_SIGNING_PRIVATE_KEY` secret
(the private half of the key whose public half lives in `tauri.conf.json`);
without it the build fails. Generate a pair with
`pnpm --filter @dukebox/desktop tauri signer generate -w ~/.tauri/dukebox.key`
and store the private key somewhere safe — losing it means no future updates
for anyone who already installed the app.

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
