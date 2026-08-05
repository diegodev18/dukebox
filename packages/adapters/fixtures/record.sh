#!/usr/bin/env bash
# Record real Claude Code stream-json output as test fixtures.
#
# Run this on a machine where `claude` is already signed in. It uses your
# existing session; no credential is read, copied, or written anywhere by this
# script, and nothing is sent to the Dukebox project except the recorded JSONL.
#
#   ./packages/adapters/fixtures/record.sh
#
# Each scenario runs against a throwaway repository in a temp directory, so
# your own projects are never touched. Output lands in this directory as
# <scenario>.jsonl. Review the files before committing them: they contain the
# prompts, the model's replies, and the contents of the files it touched.
set -euo pipefail

fixtures_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work_dir="$(mktemp -d)"

cleanup() { rm -rf "$work_dir"; }
trap cleanup EXIT

if ! command -v claude >/dev/null; then
  echo "error: claude CLI not found" >&2
  exit 1
fi

echo "recording with $(claude --version)"
echo "scratch repository: $work_dir"
echo

# A small repository with something worth reading and editing.
cd "$work_dir"
git init -q -b main
cat > calc.js <<'JS'
export function add(a, b) {
  return a + b
}

export function subtract(a, b) {
  return a - b
}
JS
cat > README.md <<'MD'
# calc

A tiny calculator.
MD
git add -A
git commit -q -m "initial"

# Absolute paths leak the recording machine's username and directory layout.
# Rewriting them keeps fixtures reproducible and free of personal detail.
redact() {
  sed -e "s|$work_dir|/workspace/repo|g" -e "s|$HOME|/home/user|g"
}

record() {
  local name="$1"
  local prompt="$2"
  shift 2

  echo "==> $name"
  echo "    $prompt"

  # --permission-mode bypassPermissions lets the agent act without prompting,
  # which is what a Dukebox session looks like. Errors are captured rather
  # than aborting: a failed run still produces a fixture worth having.
  if claude -p "$prompt" \
    --output-format stream-json \
    --verbose \
    --permission-mode bypassPermissions \
    "$@" 2>"$work_dir/$name.stderr" | redact > "$fixtures_dir/$name.jsonl"; then
    echo "    $(wc -l < "$fixtures_dir/$name.jsonl" | tr -d ' ') events"
  else
    echo "    FAILED — see below" >&2
    tail -5 "$work_dir/$name.stderr" >&2
  fi
  echo
}

# Plain text reply: no tools, the simplest possible stream.
record text-only "Reply with exactly the word: hello"

# Tool calls: the agent has to read files before it can answer.
record tool-calls "What functions does calc.js export? Just list their names."

# File edits: produces the tool_use/tool_result pairs whose ordering the
# adapter has to preserve, and leaves a real diff behind.
record file-edit "Add a multiply function to calc.js. Do not explain, just edit."

# Tool failure: the agent asks for something that is not there, so the stream
# carries an is_error result the parser has to handle.
record tool-error "Read the file nonexistent-does-not-exist.txt and tell me what it says."

echo "done. fixtures written to:"
echo "  $fixtures_dir"
echo
echo "Review them before committing — they contain your prompts, the model's"
echo "replies, and the contents of any file it read or wrote."
