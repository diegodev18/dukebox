# Base image for agent sessions.
#
# One container per session: the agent, the user's repository, and their
# toolchain. The container is treated as hostile — it runs an autonomous agent
# on a network-reachable machine — so it gets no ambient credentials, no Docker
# socket, and no root.
FROM node:22-bookworm-slim

# Agent versions are pinned. Agents are parsed by their JSON output, and an
# unattended upgrade that changes that shape breaks the adapter at runtime.
# Bumping this is a deliberate change with a fixture update alongside it.
ARG CLAUDE_CODE_VERSION=2.1.220
ARG OPENCODE_VERSION=1.18.16
ARG GROK_BUILD_VERSION=1.0.3

ENV DEBIAN_FRONTEND=noninteractive

# git       — cloning and diffing the workspace
# ripgrep   — agents shell out to it constantly for search
# ca-certs  — HTTPS to package registries and agent APIs
# procps    — process inspection when a session hangs
# less      — git's default pager; without it git commands can fail
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    git \
    ripgrep \
    ca-certificates \
    curl \
    procps \
    less \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  && npm install -g "opencode-ai@${OPENCODE_VERSION}" \
  && npm cache clean --force \
  # Fail the build if a postinstall left a stub binary (or nothing) on PATH.
  # Sessions exec these by name; discovering that at runtime is too late.
  && command -v claude \
  && command -v opencode \
  && claude --version \
  && opencode --version

# Direct binary, not install.sh: the installer writes to ~/.grok/bin and
# does not put grok on PATH for a non-login exec.
RUN arch="$(uname -m)" \
  && case "$arch" in \
    x86_64|amd64) grok_arch=x86_64 ;; \
    aarch64|arm64) grok_arch=aarch64 ;; \
    *) echo "unsupported arch: $arch" && exit 1 ;; \
  esac \
  && (curl -fsSL "https://x.ai/cli/grok-${GROK_BUILD_VERSION}-linux-${grok_arch}" -o /usr/local/bin/grok \
    || curl -fsSL "https://storage.googleapis.com/grok-build-public-artifacts/cli/grok-${GROK_BUILD_VERSION}-linux-${grok_arch}" -o /usr/local/bin/grok) \
  && chmod +x /usr/local/bin/grok \
  && command -v grok \
  && grok --version

# The `node` user ships with the base image. Running as root would mean any
# agent command could modify the image's own toolchain.
USER node
WORKDIR /workspace

# The session's git identity. Commits are authored by the agent, not by a
# person, and this makes that visible in the history.
RUN git config --global user.name "Dukebox Agent" \
  && git config --global user.email "agent@dukebox.local" \
  && git config --global init.defaultBranch main \
  # Repositories are cloned by the control plane and owned by a different uid;
  # without this git refuses to operate on them.
  && git config --global --add safe.directory '*'

# Recorded for the control plane to report which agent build ran a session.
LABEL org.opencontainers.image.title="Dukebox base (Node)"
LABEL org.opencontainers.image.source="https://github.com/diegosanchezdev/dukebox"
LABEL dev.dukebox.claude-code-version="${CLAUDE_CODE_VERSION}"
LABEL dev.dukebox.opencode-version="${OPENCODE_VERSION}"
LABEL dev.dukebox.grok-build-version="${GROK_BUILD_VERSION}"

# Sessions exec into a running container. Without a foreground process the
# container would exit immediately and there would be nothing to exec into.
#
# `sleep infinity` alone would ignore SIGTERM, forcing Docker to wait out the
# full stop timeout and then SIGKILL — making every stop take ten seconds.
# Trapping the signal makes shutdown immediate.
CMD ["sh", "-c", "trap 'exit 0' TERM INT; sleep infinity & wait"]
