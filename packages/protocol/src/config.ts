import { z } from 'zod'

/**
 * Configuration schemas.
 *
 * Two unrelated files live here because both are contracts the server and the
 * app must agree on:
 *
 *   - `.duke/config.yaml` — committed to the user's repo, describes how to
 *     build and run their project.
 *   - `/etc/dukebox/config.toml` — written by the installer on the VPS,
 *     describes the server itself.
 *
 * Neither is ever baked into a build. Dukebox binaries are identical for
 * everyone; all deployment-specific values are read at runtime.
 */

// ---------------------------------------------------------------------------
// .duke/config.yaml — per-project, committed to the user's repo
// ---------------------------------------------------------------------------

/**
 * A reference to a secret stored on the server, written as `${secret.NAME}`.
 *
 * Secrets are never written into the repo. The value is decrypted and injected
 * into the container at runtime.
 */
export const SECRET_REFERENCE_PATTERN = /^\$\{secret\.([A-Z0-9_]+)\}$/

export function parseSecretReference(value: string): string | null {
  const match = SECRET_REFERENCE_PATTERN.exec(value)
  return match?.[1] ?? null
}

export const projectConfig = z.object({
  /** Base image for the session container. */
  image: z.string().default('dukebox/base-node:latest'),

  /** Commands run once when the environment is first built, e.g. installing deps. */
  setup: z.array(z.string()).default([]),

  /** Commands that start the dev server. Used by the Preview tab. */
  dev: z.array(z.string()).default([]),

  /**
   * Environment variables for the container.
   *
   * Values may be literals or `${secret.NAME}` references.
   */
  env: z.record(z.string()).default({}),

  /** Extra instructions handed to the agent alongside the user's prompt. */
  instructions: z.string().default(''),

  /** Agents allowed for this project. Empty means all installed agents. */
  agents: z.array(z.string()).default([]),

  /** Ports the dev server listens on, tunneled to the desktop Preview tab. */
  ports: z.array(z.number().int().min(1).max(65535)).default([]),
})

export type ProjectConfig = z.infer<typeof projectConfig>

/** Defaults applied when a repo has no `.duke/config.yaml`. */
export function defaultProjectConfig(): ProjectConfig {
  return projectConfig.parse({})
}

/**
 * Merge UI overrides over the repo's config.
 *
 * `env` merges key by key so an override can add or replace a single variable
 * without restating the whole map. Arrays replace wholesale — a partial merge
 * of setup commands would be ambiguous about ordering.
 */
export function mergeProjectConfig(
  base: ProjectConfig,
  override: Partial<ProjectConfig>,
): ProjectConfig {
  return {
    ...base,
    ...override,
    env: { ...base.env, ...(override.env ?? {}) },
  }
}

// ---------------------------------------------------------------------------
// Environment setup proposals — agent → review UI → server-stored config
// ---------------------------------------------------------------------------

/**
 * One environment variable the agent thinks the project needs.
 *
 * Values are never proposed: secrets stay on the server, and the review UI is
 * where a person fills them in.
 */
export const environmentEnvVar = z.object({
  /** When true, the value is stored as a project secret and referenced as `${secret.NAME}`. */
  secret: z.boolean().default(true),
  description: z.string().optional(),
})

export type EnvironmentEnvVar = z.infer<typeof environmentEnvVar>

/**
 * What an environment-setup session writes for the user to review.
 *
 * Stored on the project as a draft until confirmed. Confirmed values become
 * `projects.configOverride` (and secret rows for secret env vars).
 */
export const environmentProposal = z.object({
  setup: z.array(z.string()).default([]),
  env: z.record(environmentEnvVar).default({}),
  instructions: z.string().optional(),
  image: z.string().optional(),
})

export type EnvironmentProposal = z.infer<typeof environmentProposal>

/** Path the setup agent must write its proposal to, outside the git worktree. */
export const ENVIRONMENT_PROPOSAL_PATH = '/tmp/dukebox-env-proposal.json'

/**
 * Turn a reviewed proposal into a `ProjectConfig` fragment for `configOverride`.
 *
 * Secret env vars become `${secret.NAME}` references; non-secret ones need a
 * literal value supplied alongside the proposal at confirm time.
 */
export function proposalToConfigOverride(
  proposal: EnvironmentProposal,
  literalEnv: Record<string, string> = {},
): Partial<ProjectConfig> {
  const env: Record<string, string> = {}

  for (const [name, meta] of Object.entries(proposal.env)) {
    if (meta.secret) {
      env[name] = `\${secret.${name}}`
    } else if (literalEnv[name] !== undefined) {
      env[name] = literalEnv[name]
    }
  }

  return {
    setup: proposal.setup,
    env,
    ...(proposal.instructions !== undefined ? { instructions: proposal.instructions } : {}),
    ...(proposal.image !== undefined ? { image: proposal.image } : {}),
  }
}

// ---------------------------------------------------------------------------
// /etc/dukebox/config.toml — per-installation, written by the installer
// ---------------------------------------------------------------------------

export const transportId = z.enum(['tailscale'])
export type TransportId = z.infer<typeof transportId>

export const serverConfig = z.object({
  server: z
    .object({
      /**
       * How clients reach this server. Tailscale is the only implementation
       * today; the enum exists so adding one is a config value, not a refactor.
       */
      transport: transportId.default('tailscale'),
      port: z.number().int().min(1).max(65535).default(7777),
    })
    .default({}),

  database: z.object({
    url: z.string().min(1),
  }),

  redis: z
    .object({
      url: z.string().min(1).default('redis://127.0.0.1:6379'),
    })
    .default({}),

  security: z.object({
    /**
     * Path to the master encryption key, generated by the installer at
     * 0600. Kept out of this file so the config can be read for debugging
     * without exposing the key.
     */
    masterKeyFile: z.string().min(1),
  }),

  sandbox: z
    .object({
      defaultImage: z.string().default('dukebox/base-node:latest'),
      cpuLimit: z.string().default('2'),
      memoryLimit: z.string().default('4g'),
      pidsLimit: z.number().int().positive().default(512),
      /** How long a finished container stays warm for follow-ups, in seconds. */
      idleTtlSeconds: z.number().int().positive().default(3600),
    })
    .default({}),
})

export type ServerConfig = z.infer<typeof serverConfig>
