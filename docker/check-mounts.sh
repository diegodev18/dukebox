#!/usr/bin/env bash
# Fail if any workspace package is missing its container-only volume mounts.
#
# The repository is bind-mounted into the dev container, so a package whose
# node_modules and dist are not masked writes them straight to the host. That
# fails silently — the tests still pass — and only shows up as Linux binaries
# accumulating in the working tree.
#
# Run by verify.sh before anything else.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="${repo_root}/docker/compose.dev.yaml"

missing=()

for package_json in "${repo_root}"/packages/*/package.json "${repo_root}"/apps/*/package.json; do
  [ -e "$package_json" ] || continue

  package_dir="$(dirname "$package_json")"
  relative="${package_dir#"${repo_root}/"}"

  for generated in node_modules dist .turbo; do
    if ! grep -qF ":/workspace/${relative}/${generated}" "$compose_file"; then
      missing+=("${relative}/${generated}")
    fi
  done
done

if [ ${#missing[@]} -gt 0 ]; then
  echo "error: these directories would be written to the host filesystem:" >&2
  printf '  %s\n' "${missing[@]}" >&2
  echo >&2
  echo "Add a volume for each in docker/compose.dev.yaml, under both the" >&2
  echo "verify service's 'volumes:' list and the top-level 'volumes:' block." >&2
  exit 1
fi
