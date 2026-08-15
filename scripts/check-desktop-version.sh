#!/usr/bin/env bash
# Fail if the desktop app's three version declarations disagree.
#
# A desktop release is cut from a tag, but the version that ends up in the
# installers comes from these files:
#
#   apps/desktop/src-tauri/tauri.conf.json  the release, its assets, and the
#                                           version the update feed advertises
#   apps/desktop/src-tauri/Cargo.toml       the binary's own version, which
#                                           macOS reads as CFBundleVersion
#   apps/desktop/package.json               the workspace package
#
# They are bumped by hand, so they drift: Cargo.toml sat at 0.7.0 for two
# releases while the other two said 0.9.0. A bundle version that goes
# backwards can confuse macOS Launch Services, and nothing else catches it.
#
# Run by CI on every pull request.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
desktop="${repo_root}/apps/desktop"

tauri_conf="${desktop}/src-tauri/tauri.conf.json"
cargo_toml="${desktop}/src-tauri/Cargo.toml"
package_json="${desktop}/package.json"

for file in "$tauri_conf" "$cargo_toml" "$package_json"; do
  [ -f "$file" ] || {
    echo "check-desktop-version: missing ${file#"$repo_root"/}" >&2
    exit 1
  }
done

# Only the first `version =` in Cargo.toml belongs to [package]; the ones
# further down are dependency pins.
tauri_version="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$tauri_conf" | head -1)"
cargo_version="$(sed -n 's/^version[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$cargo_toml" | head -1)"
package_version="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$package_json" | head -1)"

for pair in "tauri.conf.json:$tauri_version" "Cargo.toml:$cargo_version" "package.json:$package_version"; do
  [ -n "${pair#*:}" ] || {
    echo "check-desktop-version: could not read a version from ${pair%%:*}" >&2
    exit 1
  }
done

if [ "$tauri_version" != "$cargo_version" ] || [ "$tauri_version" != "$package_version" ]; then
  {
    echo "check-desktop-version: the desktop version declarations disagree."
    echo
    printf '  %-40s %s\n' "apps/desktop/src-tauri/tauri.conf.json" "$tauri_version"
    printf '  %-40s %s\n' "apps/desktop/src-tauri/Cargo.toml" "$cargo_version"
    printf '  %-40s %s\n' "apps/desktop/package.json" "$package_version"
    echo
    echo "Set all three to the same version before tagging a release."
  } >&2
  exit 1
fi

echo "check-desktop-version: all three declare $tauri_version"
