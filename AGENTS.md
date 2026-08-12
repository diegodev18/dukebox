# AGENTS.md

## Cloud VM specific instructions

This section captures non-obvious, durable setup/run notes for future cloud agents.
Standard commands live in `README.md`; only the caveats specific to this VM are here.

### Toolchain (already provisioned)

- Node 22 and `pnpm@10.24.0` are preinstalled. Dependencies are refreshed automatically
  on VM startup by the update script (`pnpm install` at the repo root).
- Docker is installed and configured for this nested VM: storage driver
  `fuse-overlayfs`, the Docker 29 `containerd-snapshotter` feature disabled (required
  for `fuse-overlayfs`), and `iptables-legacy`. The `ubuntu` user is in the `docker`
  group.

### Starting Docker and the dev services (not automatic)

The update script only refreshes dependencies. The Docker daemon and the Postgres/Redis
dev stack are processes and do **not** survive across VM boots, so start them yourself:

```bash
# 1. Start the Docker daemon (leave it running, e.g. in a tmux session)
sudo dockerd > /tmp/dockerd.log 2>&1 &
# The socket is recreated each start; in the same shell you may need:
sudo chmod 666 /var/run/docker.sock   # or open a fresh login shell (docker group)

# 2. Bring up Postgres + Redis (see docker/compose.dev.yaml)
docker compose -f docker/compose.dev.yaml up -d postgres redis
# Postgres -> 127.0.0.1:5433, Redis -> 127.0.0.1:6380
```

### Running tests / typecheck / format

The repo's canonical flow is `./docker/verify.sh` (runs everything inside a container).
You can also run natively, which is faster for iteration. Native test runs need the DB
and Redis URLs pointed at the host-published dev ports (the compose defaults use the
container network `postgres:5432` / `redis:6379`, which do not resolve on the host):

```bash
export DUKEBOX_DATABASE_URL='postgres://dukebox:dukebox@127.0.0.1:5433/dukebox'
export DUKEBOX_REDIS_URL='redis://127.0.0.1:6380'
pnpm exec prettier --check .        # format
pnpm exec turbo run typecheck       # typecheck (builds deps first)
pnpm exec turbo run test            # tests
```

The sandbox integration tests default to the `dukebox/base-node:latest` image; build it
with `docker build -t dukebox/base-node:latest images/base-node`.

### KNOWN LIMITATION: container resource limits do not work in this VM

This nested Firecracker VM's cgroup-v2 namespace root is `domain threaded` and cannot be
changed, so Docker cannot delegate the `memory`/`io` (domain) controllers to container
cgroups. Any container started with a memory/cpu limit fails with:

```
cannot enter cgroupv2 "/sys/fs/cgroup/docker" with domain controllers -- it is in threaded mode
```

Containers **without** limits (Postgres, Redis, plain `docker run`) work fine. The agent
sandbox always applies memory/cpu limits, so the tests that create a real agent-session
container cannot pass here. They are:

- `packages/sandbox`: `src/container.test.ts`, `src/credentials.integration.test.ts`, `src/workspace.test.ts`
- `apps/server`: `src/sessions/manager.test.ts`

Everything else passes (server: 278 tests; sandbox unit; db, protocol, adapters,
transport, desktop). Validate the container-lifecycle tests on the intended Linux VPS
host (where cgroups are not threaded) via `./docker/verify.sh`.

### Running the app in dev

- Desktop UI: `pnpm --filter @dukebox/desktop dev` serves Vite on the fixed port **5173**
  (`strictPort` — it fails rather than moving; free it with `lsof -ti :5173 | xargs kill`).
  - `http://localhost:5173/` is the real app; with no paired server it shows the Pairing
    screen.
  - `http://localhost:5173/preview.html` renders the full session UI (transcript,
    reviewable diffs, composer, new-session dialog) from a scripted session — no server,
    container, or agent required. Best way to exercise the frontend here.
- Control-plane server (`pnpm --filter @dukebox/server dev`) is an advanced path: it
  refuses to start without a running **Tailscale** tailnet, an authenticated `gh` CLI,
  and a config file (`DUKEBOX_CONFIG` or `/etc/dukebox/config.toml`). The backend logic is
  otherwise covered end-to-end by the integration test suite against real Postgres/Redis.
