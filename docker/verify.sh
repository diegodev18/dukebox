#!/usr/bin/env bash
# Run project commands inside the verification container.
#
# Nothing runs on the host: no Node, no pnpm, no databases. The host only
# provides the Docker daemon.
#
#   ./docker/verify.sh              # install, typecheck, lint, test
#   ./docker/verify.sh test         # a single turbo task
#   ./docker/verify.sh -- <cmd>     # an arbitrary command in the container
#   ./docker/verify.sh --shell      # interactive shell
#   ./docker/verify.sh --down       # stop and remove the dev stack
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose=(docker compose -f "${repo_root}/docker/compose.dev.yaml")

# `run` starts dependencies via depends_on and removes the container afterwards.
in_container() {
  "${compose[@]}" run --rm verify "$@"
}

case "${1:-}" in
  --down)
    "${compose[@]}" down --volumes --remove-orphans
    exit 0
    ;;
  --shell)
    in_container bash
    exit 0
    ;;
  --)
    shift
    in_container "$@"
    exit 0
    ;;
esac

# A package without container-only volumes writes its build output to the
# host. That failure is silent, so check for it before anything runs.
echo "==> Checking container mounts"
"${repo_root}/docker/check-mounts.sh"

# CI=true makes pnpm require a frozen lockfile. During development the lockfile
# legitimately moves ahead of it, so allow it to update.
echo "==> Installing dependencies"
in_container pnpm install --no-frozen-lockfile

if [[ $# -gt 0 ]]; then
  echo "==> Running: turbo run $*"
  in_container pnpm exec turbo run "$@"
  exit 0
fi

echo "==> Typecheck"
in_container pnpm exec turbo run typecheck

echo "==> Format check"
in_container pnpm exec prettier --check .

echo "==> Test"
in_container pnpm exec turbo run test

echo "==> All checks passed"
