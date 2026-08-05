import {
  ENVIRONMENT_PROPOSAL_PATH,
  environmentProposal,
  type EnvironmentProposal,
} from '@dukebox/protocol'

/**
 * Fixed prompt for an environment_setup session.
 *
 * The agent must inspect the repo and write a JSON proposal outside the git
 * worktree — never invent secret values, and never modify the repository for
 * this task.
 */
export const ENVIRONMENT_SETUP_PROMPT = `You are configuring a Dukebox development environment for this repository.

Inspect the repository (package managers, lockfiles, README, CI, .env.example, docker-compose, etc.) and propose:
1. setup — shell commands to install dependencies and prepare the workspace (run once when a session starts)
2. env — environment variable NAMES the project needs, with whether each is a secret and a short description. Never invent or guess actual secret values.
3. instructions — optional short guidance for coding agents in later sessions
4. image — optional container image if the default dukebox/base-node:latest is wrong

Write ONLY this JSON object to ${ENVIRONMENT_PROPOSAL_PATH} (create/overwrite that file). Do not commit anything. Do not modify files in the repository.

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
