#!/usr/bin/env bash
# Build a self-contained control-plane release tarball.
#
#   scripts/package-server.sh <version> [arch]
#
#   version  version number, e.g. 0.1.0  (required)
#   arch     x64 or arm64; defaults to the host's architecture
#
# Writes dist-release/dukebox-server-<version>-linux-<arch>.tar.gz and appends
# its checksum to dist-release/SHA256SUMS. The release workflow calls this; the
# local invocation exists so a maintainer can inspect a bundle before tagging.
#
# The bundle is pure JavaScript, so the tarball is the same for every
# architecture — the arch only lives in the filename, which is what lets
# `duke update` pick the right asset. If a native dependency ever enters the
# runtime dependency tree, this stops being true and each arch must build on
# its own machine.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ "$#" -lt 1 ]; then
  echo "usage: scripts/package-server.sh <version> [arch]" >&2
  exit 1
fi
version="$1"

case "${2:-$(uname -m)}" in
  x64 | x86_64 | amd64) arch="x64" ;;
  arm64 | aarch64) arch="arm64" ;;
  *) echo "unsupported architecture: $2" >&2; exit 1 ;;
esac

out_dir="$REPO_ROOT/dist-release"
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT

echo "==> Building @dukebox/server"
pnpm --dir "$REPO_ROOT" --filter '@dukebox/server...' build

echo "==> Deploying production dependencies"
pnpm --dir "$REPO_ROOT" deploy --filter '@dukebox/server' --prod --legacy "$staging" >/dev/null

echo "==> Trimming the staging tree"
# pnpm deploy copies the whole package; drop what a running server never needs.
rm -rf "$staging/src" "$staging/.turbo" "$staging/tsconfig.json" "$staging/vitest.config.ts"
find "$staging/dist" -name '.tsbuildinfo' -delete
chmod +x "$staging/dist/cli.js"

echo "==> Writing VERSION and shipping install artifacts"
echo "$version" >"$staging/VERSION"
install -d "$staging/install" "$staging/images/base-node"
install -m 0644 "$REPO_ROOT/install/dukebox.service" "$staging/install/dukebox.service"
install -m 0644 "$REPO_ROOT/install/compose.yaml" "$staging/install/compose.yaml"
install -m 0644 "$REPO_ROOT/images/base-node/Dockerfile" "$staging/images/base-node/Dockerfile"

echo "==> Tarballing"
mkdir -p "$out_dir"
tarball="$out_dir/dukebox-server-$version-linux-$arch.tar.gz"
rm -f "$tarball"
tar -C "$staging" -czf "$tarball" .

echo "==> Updating SHA256SUMS"
# Basename only, so `duke update` can look the asset up by its file name.
(cd "$out_dir" && sha256sum "$(basename "$tarball")") >>"$out_dir/SHA256SUMS"

echo "==> Wrote $tarball"
