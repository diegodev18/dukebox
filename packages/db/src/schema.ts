import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * Database schema.
 *
 * Conventions:
 *   - `timestamptz` everywhere. A server in one timezone and a laptop in
 *     another must agree on when things happened.
 *   - `text` over `varchar(n)`; length caps belong in the Zod schemas, where
 *     violating one produces a useful error instead of a database exception.
 *   - Every foreign key gets an explicit index. Postgres does not create them,
 *     and without them both joins and cascading deletes fall back to scans.
 */

const createdAt = timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const updatedAt = timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()

// ---------------------------------------------------------------------------
// Devices and pairing
// ---------------------------------------------------------------------------

/**
 * A paired desktop app.
 *
 * Tailscale authenticates the network; this table authenticates the app. Each
 * device holds its own token so one can be revoked without touching the rest.
 */
export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    platform: text('platform').notNull(),

    /**
     * SHA-256 of the device token, never the token itself. A database dump
     * must not be enough to impersonate a device.
     */
    tokenHash: text('token_hash').notNull(),

    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt,
  },
  (table) => [
    // Every authenticated request looks a device up by token hash.
    uniqueIndex('devices_token_hash_idx').on(table.tokenHash),
  ],
)

/**
 * A single-use pairing code.
 *
 * Rows are kept after redemption rather than deleted: a code that was already
 * used and a code that never existed must be indistinguishable to a caller,
 * and keeping the row is what lets the server tell them apart internally.
 */
export const pairingCodes = pgTable(
  'pairing_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** SHA-256 of the code. Same reasoning as device tokens. */
    codeHash: text('code_hash').notNull(),

    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }),

    /** Set on redemption, for auditing which device claimed which code. */
    redeemedByDeviceId: uuid('redeemed_by_device_id').references(() => devices.id, {
      onDelete: 'set null',
    }),

    createdAt,
  },
  (table) => [
    uniqueIndex('pairing_codes_code_hash_idx').on(table.codeHash),
    index('pairing_codes_redeemed_by_device_id_idx').on(table.redeemedByDeviceId),
  ],
)

// ---------------------------------------------------------------------------
// Projects and environments
// ---------------------------------------------------------------------------

/** A GitHub repository the user has connected. */
export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** `owner/repo`, the natural key on GitHub's side. */
    repoFullName: text('repo_full_name').notNull(),

    defaultBranch: text('default_branch').notNull().default('main'),

    createdAt,
    updatedAt,
  },
  (table) => [uniqueIndex('projects_repo_full_name_idx').on(table.repoFullName)],
)

/**
 * One way to run a project, scoped to a family of branches.
 *
 * A project has many: a refactor branch needing an extra toolchain and a docs
 * branch needing no install at all should not share one configuration. Which
 * one applies is decided by `branchPattern` against the session's base branch,
 * and ties are broken by `position` rather than by guessing which pattern is
 * more specific.
 *
 * No environment matching a branch is not an error — that session runs on the
 * base image with no override.
 */
export const environments = pgTable(
  'environments',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),

    /**
     * Which branches this environment is available for.
     *
     * Glob by default (`**`, `refact/*`), or a regular expression behind a
     * `re:` prefix. Note the catch-all is `**` and not `*`: a single star
     * stops at a slash.
     */
    branchPattern: text('branch_pattern').notNull(),

    /** Tie-break when several patterns match. Lower wins. */
    position: integer('position').notNull().default(0),

    /** UI overrides merged over the repo's `.duke/config.yaml`. */
    configOverride: jsonb('config_override'),

    /**
     * Image built after running this environment's setup commands. Per
     * environment, because different setup commands produce different images.
     */
    snapshotImage: text('snapshot_image'),

    /**
     * Agent-proposed environment waiting for the user to review.
     *
     * Written when an `environment_setup` session finishes; cleared when the
     * user confirms into `configOverride` (or discards the draft).
     */
    environmentDraft: jsonb('environment_draft'),

    createdAt,
    updatedAt,
  },
  (table) => [
    // Exactly the picker's query: every environment of one project, in order.
    index('environments_project_id_position_idx').on(table.projectId, table.position),

    // Two environments of one project sharing a name would make the picker
    // unreadable.
    uniqueIndex('environments_project_id_name_idx').on(table.projectId, table.name),
  ],
)

/**
 * An encrypted secret injected into a project's containers at runtime.
 *
 * Referenced from `.duke/config.yaml` as `${secret.NAME}`. The plaintext never
 * touches the repo, an image layer, or a log line.
 */
export const secrets = pgTable(
  'secrets',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * The project this secret belongs to, or null for a server-wide one.
     *
     * Agent credentials are server-wide: the same subscription runs every
     * session, so scoping them to a project would mean re-entering the same
     * token for each repository.
     */
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),

    /** AES-256-GCM ciphertext, keyed by the installer-generated master key. */
    ciphertext: text('ciphertext').notNull(),
    iv: text('iv').notNull(),
    authTag: text('auth_tag').notNull(),

    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('secrets_project_id_name_idx').on(table.projectId, table.name),

    /**
     * Server-wide secrets, which the index above cannot constrain.
     *
     * Postgres treats every NULL as distinct, so a unique index over a
     * nullable column lets the same name be inserted repeatedly. A partial
     * index over just those rows is what actually enforces one per name.
     */
    uniqueIndex('secrets_global_name_idx')
      .on(table.name)
      .where(sql`${table.projectId} is null`),
  ],
)

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** One agent run in one container. */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),

    agentId: text('agent_id').notNull(),
    status: text('status').notNull(),
    title: text('title').notNull().default(''),

    /**
     * `coding` (default) or `environment_setup`.
     *
     * Setup sessions skip the project's own setup commands and ask the agent
     * to propose them instead.
     */
    purpose: text('purpose').notNull().default('coding'),

    branch: text('branch').notNull(),
    baseBranch: text('base_branch').notNull(),

    /**
     * The environment this session runs in, or null for the base image.
     *
     * Resolved once at creation and persisted rather than re-derived on
     * resume: a session resumed weeks later must use the environment it
     * started with, even if patterns changed or the list was reordered.
     */
    environmentId: uuid('environment_id').references(() => environments.id, {
      onDelete: 'set null',
    }),

    /** Null until the container is created; cleared when it is removed. */
    containerId: text('container_id'),

    /**
     * The agent's own session identifier, when it has one. Required to resume
     * a conversation rather than start over.
     */
    agentSessionId: text('agent_session_id'),

    /**
     * The commit the session branched from.
     *
     * Persisted because diffs and the pull request check measure against it,
     * and a control plane restart would otherwise re-derive it from whatever
     * HEAD happens to be — which is the agent's own work, making every change
     * it already made invisible.
     */
    baseCommit: text('base_commit'),

    /**
     * Highest seq assigned so far. The source of truth for numbering: a new
     * event takes `last_seq + 1` under a row lock, which keeps sequences gap
     * free even with concurrent writers.
     */
    lastSeq: bigint('last_seq', { mode: 'number' }).notNull().default(0),

    changedFileCount: integer('changed_file_count').notNull().default(0),
    prUrl: text('pr_url'),
    errorMessage: text('error_message'),

    createdAt,
    updatedAt,
    endedAt: timestamp('ended_at', { withTimezone: true }),

    /**
     * When the session was archived. Null while it still belongs in the
     * sidebar — archiving hides it without deleting the history.
     */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    index('sessions_project_id_idx').on(table.projectId),
    // The sidebar lists sessions newest first, filtered by status.
    index('sessions_status_updated_at_idx').on(table.status, table.updatedAt),
    index('sessions_environment_id_idx').on(table.environmentId),
  ],
)

/**
 * The event log. One row per AgentEvent.
 *
 * This is the highest-volume table in the system — a long session is thousands
 * of rows — so the primary key is a `bigint identity`, not a UUID. Sequential
 * keys append to the end of the index; random UUIDs would scatter writes across
 * it and fragment the index as the table grows.
 *
 * Redis Streams serve recent events for live replay; this table is the durable
 * record and backs history older than the stream's retention.
 */
export const messages = pgTable(
  'messages',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),

    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),

    /** Monotonic per session, assigned from `sessions.last_seq`. */
    seq: bigint('seq', { mode: 'number' }).notNull(),

    /** An AgentEvent, validated by the protocol schema before insert. */
    event: jsonb('event').notNull(),

    createdAt,
  },
  (table) => [
    /**
     * Serves both access patterns: replaying one session in order, and
     * resuming from a known seq. Unique because a duplicate seq within a
     * session would corrupt client-side reconciliation.
     */
    uniqueIndex('messages_session_id_seq_idx').on(table.sessionId, table.seq),
  ],
)

// ---------------------------------------------------------------------------
// Server metadata
// ---------------------------------------------------------------------------

/**
 * Single-row table holding this installation's identity.
 *
 * Lets the desktop app tell paired servers apart, and gives the pairing screen
 * a name to show instead of a bare hostname.
 */
export const serverIdentity = pgTable('server_identity', {
  id: boolean('id').primaryKey().default(true),
  name: text('name').notNull(),
  createdAt,
})

export type Device = typeof devices.$inferSelect
export type NewDevice = typeof devices.$inferInsert
export type PairingCode = typeof pairingCodes.$inferSelect
export type NewPairingCode = typeof pairingCodes.$inferInsert
export type Project = typeof projects.$inferSelect
export type NewProject = typeof projects.$inferInsert
export type Environment = typeof environments.$inferSelect
export type NewEnvironment = typeof environments.$inferInsert
export type Secret = typeof secrets.$inferSelect
export type NewSecret = typeof secrets.$inferInsert
export type Session = typeof sessions.$inferSelect
export type NewSession = typeof sessions.$inferInsert
export type Message = typeof messages.$inferSelect
export type NewMessage = typeof messages.$inferInsert
