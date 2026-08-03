# Verification image: runs typecheck, lint, and tests for the whole monorepo.
# Nothing from this project is ever installed on the developer's host machine.
FROM node:22-bookworm-slim

# git is needed by some tooling; ca-certificates for registry access.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# pnpm ships with Node via corepack. Pin the version to match packageManager.
RUN corepack enable && corepack prepare pnpm@10.24.0 --activate

WORKDIR /workspace

# Store the pnpm cache on a mountable path so repeat runs are fast.
ENV PNPM_HOME=/pnpm-store
RUN pnpm config set store-dir /pnpm-store

CMD ["bash"]
