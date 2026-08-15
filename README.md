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

| Platform | Asset                                                                 |
| -------- | --------------------------------------------------------------------- |
| macOS    | `Dukebox_<version>_aarch64.dmg` (Apple silicon) or `_x64.dmg` (Intel) |
| Windows  | `Dukebox_<version>_x64-setup.exe`                                     |
| Linux    | `Dukebox_<version>_amd64.deb` (or the `.AppImage`)                    |

`<version>` is the release you are downloading from — `Dukebox_0.9.0_aarch64.dmg`
in the 0.9.0 release. Linux builds are x86_64 only: there is no ARM64 desktop
asset, and an ARM64 machine gets no update notifications either, because the
update feed has no entry to offer it.

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

The installer downloads the newest server release from GitHub, verifies its
checksum, and prints a pairing link for the desktop app. Re-running it, or
running `sudo duke update` on the machine, is how you update the server (see
"Updating a server" below).

## Updating

The desktop app checks for new versions when it launches and whenever you pick
"Check for updates…" from the account menu at the foot of the sidebar. When a
newer version exists, a toast appears in the corner of the window; **Update &
restart** downloads, installs, and relaunches into the new build in one click,
and "Later" defers it until the next check. Every bundle is signed, and the app
refuses to install one whose signature does not verify against the public key
compiled into it.

### Releasing a new desktop version

The `Release desktop app` workflow builds installers for all three platforms
and uploads them to a GitHub Release — which is also the feed the app's update
check reads. To publish:

1. Bump the version to match in `apps/desktop/src-tauri/tauri.conf.json`,
   `apps/desktop/src-tauri/Cargo.toml`, and `apps/desktop/package.json`. CI
   fails if the three disagree; check them yourself with
   `./scripts/check-desktop-version.sh`.
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

### Updating a server

The server is installed from a self-contained release bundle, so an update
downloads the new bundle, verifies its checksum, applies any database
migrations with the new code, and swaps it in — no build toolchain on the
server. Run it over SSH:

```bash
sudo duke update            # download, verify, migrate, swap, restart
sudo duke update --check    # only report whether an update exists
sudo duke update --from-git # build and install from main (no release needed)
sudo duke update --from-git some-branch
sudo duke rollback          # restore the previous release if something is wrong
```

`duke update` restarts the service, rebuilds the session agent image
(`dukebox/base-node:latest`, which ships Claude Code, OpenCode, and Grok Build), and rolls
back automatically if the new release fails to start. Re-running `install.sh`
does the same thing and also applies any unit-file changes.

If an update left the control plane on a new release but the agent image
rebuild failed (or you restored OpenCode onto a machine whose image was built
before that agent existed), rebuild just the image:

```bash
sudo duke image rebuild
```

New sessions pick up the rebuilt image; already-running containers keep the
old one until you stop them.

`duke update --from-git` is for operators who want `main` (or any other branch,
tag, or commit) without waiting for a `server-v*` release. It clones the ref
onto the machine, builds the same self-contained bundle the release workflow
publishes, then swaps it in with the same migrate / restart / rollback path.
The install still looks like a release (a `VERSION` file, `duke rollback`
works), so later `duke update` calls can move back onto a published release.
Override the remote with `DUKEBOX_REPO_URL` if you are tracking a fork.

> **Already had a server before this release?** A server installed the old way
> is a git checkout that builds in place; it has no `duke` command and no
> release version. Migrate it by re-running the installer once:
>
> ```bash
> curl -fsSL https://raw.githubusercontent.com/diegodev18/dukebox/main/install/install.sh | sudo bash
> ```
>
> It replaces `/opt/dukebox` with the release bundle, updates the systemd unit
> to the new layout, and installs the `duke` symlink. The config in
> `/etc/dukebox` and the Postgres/Redis data (Docker volumes) are untouched.
> After that, updates are `sudo duke update`.

### Releasing a new server version

The `Release server` workflow builds the control plane into a self-contained
tarball and uploads it to a GitHub Release — the feed `duke update` reads.
To publish:

1. Commit, then tag and push:
   ```bash
   git tag server-v0.1.0
   git push origin server-v0.1.0
   ```
2. Open the draft release the workflow created, check the assets, and publish
   it. Until then `duke update` will not offer the version.

Build a bundle locally to inspect it before tagging:

```bash
./scripts/package-server.sh 0.1.0 x64   # writes dist-release/
```

### The duke CLI

Every server installs a `duke` command (a symlink into the release bundle).
It is how an operator talks to a server over SSH. The admin commands — those
that talk to systemd — need `sudo`:

```bash
duke version                          # installed release version
duke status                           # version, service state, transport, devices
duke update [--check]                 # update to the latest release
duke update --from-git [ref]          # build and install from git (default: main)
duke image rebuild                    # rebuild dukebox/base-node:latest
duke rollback                         # restore the previous release
duke restart                          # restart the control plane
duke logs [-f] [-n N]                 # control plane journal (journalctl -u dukebox)
duke logs session                     # list sessions
duke logs session <id> [-f] [--json]  # session event log
duke logs docker                      # list agent containers
duke logs docker <id> [-f]            # agent container logs
duke config show                      # effective configuration
duke config get server.port           # one setting
duke config set sandbox.memory_limit 6g   # change one setting and restart
duke pair new                         # issue a pairing link
duke device ls                        # list paired devices
duke device rm <id>                   # revoke a device
```

`duke config set` validates the value against the server's schema, rewrites
only the one line (comments and the rest of the file survive), and restarts
the service. Pass `--no-restart` to change the file without restarting.
`database.url` and `security.master_key_file` are protected and need
`--force`: changing the first can orphan encrypted secrets, the second
invalidates every paired device.

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

A release install updates itself — the bundle is built in CI and `duke update`
swaps it in:

```bash
sudo duke update
sudo duke update --from-git   # track main without a release
```

That is also what re-running `install.sh` does (for the release path). Re-running
the installer is the better habit when a release also changes the systemd unit
or the compose stack, since it reapplies those files. There is nothing left to
build on the server for a release install: it installs the release bundle, not
the source tree. `--from-git` is the exception — it builds the bundle on the
machine from a git ref, then installs it the same way.

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
