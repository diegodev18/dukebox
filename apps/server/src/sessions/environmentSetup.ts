import {
  ENVIRONMENT_PROPOSAL_PATH,
  environmentProposal,
  type EnvironmentProposal,
} from '@dukebox/protocol'

/**
 * Fixed prompt for an environment_setup session.
 *
 * The agent must inspect the repo, actually run the setup commands it will
 * propose, and write a JSON proposal outside the git worktree — never invent
 * secret values, and never modify the repository for this task.
 */
export const ENVIRONMENT_SETUP_PROMPT = `You are configuring a Dukebox development environment for this repository.

Inspect the repository (package managers, lockfiles, README, CI, .env.example, docker-compose, etc.) and propose:
1. setup — shell commands to install dependencies and prepare the workspace (run once when a session starts)
2. env — environment variable NAMES the project needs, with whether each is a secret and a short description. Never invent or guess actual secret values.
3. instructions — optional short guidance for coding agents in later sessions
4. image — optional container image if the default dukebox/base-node:latest is wrong

Then actually run the setup commands you intend to propose. If they fail (wrong package manager, missing toolchain, etc.), fix the commands and retry. Coding sessions start from a fresh clone, so the commands in setup must work on a clean tree — do not omit an install step just because you already ran it in this workspace.

Setup commands must succeed without secret values. Put names that need secrets in env; do not bake guessed values into setup (no migrations that require DATABASE_URL, and similar).

If a different container image is required, set image and say so: this session cannot verify commands against an image it is not running.

Write this JSON object to ${ENVIRONMENT_PROPOSAL_PATH} (create/overwrite that file) only once the setup commands listed there are sufficient from a clean tree. Do not commit anything. Do not modify files in the repository.

JSON shape:
{
  "setup": ["pnpm install"],
  "env": {
    "DATABASE_URL": { "secret": true, "description": "Postgres connection string" }
  },
  "instructions": "optional string",
  "image": "optional string"
}

After writing the file, briefly confirm what you proposed.`

/**
 * Follow-up when the server re-ran the proposal on a clean clone and it failed.
 *
 * Bounded by MAX_ENVIRONMENT_SETUP_VERIFY_RETRIES so a broken proposal cannot
 * loop the setup session forever.
 */
export const MAX_ENVIRONMENT_SETUP_VERIFY_RETRIES = 2

/** Build the follow-up prompt that asks the setup agent to fix a failed verify. */
export function environmentSetupVerifyRetryPrompt(setup: string[], error: string): string {
  const commands = setup.length > 0 ? setup.map((command) => `- ${command}`).join('\n') : '(none)'

  return `The setup commands in ${ENVIRONMENT_PROPOSAL_PATH} failed when run on a clean clone of the repository (the same way a coding session starts). They must work from a clean tree, not leftover files from your trial.

Commands that were run:
${commands}

Failure:
${error}

Fix the setup commands, write the updated JSON to ${ENVIRONMENT_PROPOSAL_PATH}, and do not commit or modify the repository.`
}

/** Parse and validate a proposal JSON string from the setup agent. */
export function parseEnvironmentProposalJson(raw: string): EnvironmentProposal {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('environment proposal is not valid JSON')
  }

  return environmentProposal.parse(parsed)
}
