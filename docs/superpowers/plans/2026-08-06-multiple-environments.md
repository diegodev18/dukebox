# Multiple Environments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a project many environments instead of one, each with a branch pattern deciding which branches it is available for, selectable in New Session.

**Architecture:** A new `environments` table takes over the three environment columns currently on `projects`. A pure matching module in `@dukebox/protocol` translates glob (or `re:`-prefixed regex) patterns into branch matches, and resolves a branch to the first matching environment by explicit `position`. The server resolves once at session creation and persists the result on `sessions.environmentId`; no match means the base image, never a blocked session.

**Tech Stack:** TypeScript, Zod, Drizzle ORM (Postgres), Hono, React 19, Vitest, pnpm workspaces, Turbo.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-06-multiple-environments-design.md`. Read it before starting.
- Glob semantics: `*` matches any run of characters **except `/`**; `**` matches any run **including `/`**; `?` matches exactly one character.
- The catch-all pattern is `**`, never `*`. The migration writes `**`.
- Regex patterns use the `re:` prefix and are implicitly anchored `^…$`.
- Pattern guards: max 200 characters; reject nested quantifiers; never compile with the `g` flag.
- An invalid pattern never throws from `matchesBranch` — it returns `false`.
- Pattern validation runs server-side in write endpoints, not only in the UI.
- No match → base image (`defaultProjectConfig()`), never an error.
- Session environment is resolved once at creation and persisted; never re-resolved on resume.
- Database conventions (from `packages/db/src/schema.ts`): `timestamptz` everywhere, `text` over `varchar(n)`, an explicit index on every foreign key.
- Run tests with the dev stack URLs exported (see `AGENTS.md`):
  ```bash
  export DUKEBOX_DATABASE_URL='postgres://dukebox:dukebox@127.0.0.1:5433/dukebox'
  export DUKEBOX_REDIS_URL='redis://127.0.0.1:6380'
  ```
- Container-creating tests cannot pass in the Cursor VM (cgroups limitation in `AGENTS.md`). Do not treat their failure as caused by this work.
- Run `pnpm exec prettier --write <files>` before every commit; CI checks formatting.

---

## File Structure

**Created:**

- `packages/protocol/src/branchPattern.ts` — glob/regex matching, validation, and branch→environment resolution. Pure, no I/O.
- `packages/protocol/src/branchPattern.test.ts` — matching and resolution tests.
- `packages/db/migrations/0005_environments.sql` — table, data copy, `sessions.environment_id`, column drops.
- `apps/server/src/http/environments.ts` — CRUD and reorder routes.
- `apps/server/src/http/environments.test.ts` — route integration tests.
- `apps/desktop/src/components/EnvironmentsPanel.tsx` — management UI.

**Modified:**

- `packages/db/src/schema.ts` — add `environments`, add `sessions.environmentId`, remove three `projects` columns.
- `packages/protocol/src/index.ts` — export the new module.
- `packages/protocol/src/api.ts` — environment API schemas; `hasEnvironment` → `environmentCount`; `environmentId` on `createSessionRequest`.
- `apps/server/src/sessions/manager.ts` — `configFor` by environment; resolve at start; draft writes to the environment.
- `apps/server/src/http/projects.ts` — project summary count; environment routes read/write the environment row.
- `apps/server/src/http/sessions.ts` — pass `environmentId` through.
- `apps/desktop/src/lib/client.ts` — environment client methods.
- `apps/desktop/src/components/RepoBranchPickers.tsx` — add `EnvironmentPicker`.
- `apps/desktop/src/screens/NewSession.tsx` — picker, base-image notice, inline create form.
- `apps/desktop/src/components/Sidebar.tsx:204` — `environmentCount === 0`.
- `apps/desktop/src/preview.tsx` — scripted environment data.

---

## Task 1: Branch pattern matching

Pure module first: everything else depends on its semantics, and it needs no database.

**Files:**

- Create: `packages/protocol/src/branchPattern.ts`
- Create: `packages/protocol/src/branchPattern.test.ts`
- Modify: `packages/protocol/src/index.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `matchesBranch(pattern: string, branch: string): boolean`
  - `validateBranchPattern(pattern: string): { ok: true } | { ok: false; reason: string }`
  - `resolveEnvironment<T extends { branchPattern: string; position: number }>(environments: T[], branch: string): T | null`
  - `MAX_BRANCH_PATTERN_LENGTH: 200`

- [ ] **Step 1: Write the failing test**

Create `packages/protocol/src/branchPattern.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { matchesBranch, resolveEnvironment, validateBranchPattern } from './branchPattern.js'

describe('matchesBranch — glob', () => {
  it('matches a literal branch name', () => {
    expect(matchesBranch('main', 'main')).toBe(true)
    expect(matchesBranch('main', 'develop')).toBe(false)
  })

  it('stops * at a slash', () => {
    expect(matchesBranch('*', 'main')).toBe(true)
    expect(matchesBranch('*', 'refact/auth')).toBe(false)
  })

  it('lets ** cross slashes', () => {
    expect(matchesBranch('**', 'main')).toBe(true)
    expect(matchesBranch('**', 'refact/auth')).toBe(true)
    expect(matchesBranch('**', 'refact/auth/deep')).toBe(true)
  })

  it('scopes a prefix to one segment with *', () => {
    expect(matchesBranch('refact/*', 'refact/auth')).toBe(true)
    expect(matchesBranch('refact/*', 'refact/auth/deep')).toBe(false)
    expect(matchesBranch('refact/*', 'feat/auth')).toBe(false)
  })

  it('spans segments with **', () => {
    expect(matchesBranch('refact/**', 'refact/auth')).toBe(true)
    expect(matchesBranch('refact/**', 'refact/auth/deep')).toBe(true)
  })

  it('matches exactly one character with ?', () => {
    expect(matchesBranch('v?', 'v1')).toBe(true)
    expect(matchesBranch('v?', 'v10')).toBe(false)
  })

  it('treats regex metacharacters as literals', () => {
    expect(matchesBranch('release.1', 'release.1')).toBe(true)
    expect(matchesBranch('release.1', 'releaseX1')).toBe(false)
  })
})

describe('matchesBranch — regex', () => {
  it('matches an alternation', () => {
    expect(matchesBranch('re:^(feat|fix)/', 'feat/x')).toBe(true)
    expect(matchesBranch('re:^(feat|fix)/', 'fix/x')).toBe(true)
    expect(matchesBranch('re:^(feat|fix)/', 'chore/x')).toBe(false)
  })

  it('anchors implicitly', () => {
    expect(matchesBranch('re:main', 'main')).toBe(true)
    expect(matchesBranch('re:main', 'feat/maintenance')).toBe(false)
  })

  it('returns false for an invalid regex instead of throwing', () => {
    expect(() => matchesBranch('re:[unclosed', 'main')).not.toThrow()
    expect(matchesBranch('re:[unclosed', 'main')).toBe(false)
  })

  it('returns the same result on repeated calls', () => {
    // A regex compiled with the `g` flag carries lastIndex between calls and
    // produces intermittent false negatives. This is the guard against that.
    const pattern = 're:^feat/'
    expect(matchesBranch(pattern, 'feat/a')).toBe(true)
    expect(matchesBranch(pattern, 'feat/a')).toBe(true)
    expect(matchesBranch(pattern, 'feat/a')).toBe(true)
  })
})

describe('validateBranchPattern', () => {
  it('accepts ordinary globs and regexes', () => {
    expect(validateBranchPattern('**')).toEqual({ ok: true })
    expect(validateBranchPattern('refact/*')).toEqual({ ok: true })
    expect(validateBranchPattern('re:^(feat|fix)/')).toEqual({ ok: true })
  })

  it('rejects an empty pattern', () => {
    const result = validateBranchPattern('')
    expect(result.ok).toBe(false)
  })

  it('rejects a pattern over 200 characters', () => {
    const result = validateBranchPattern('a'.repeat(201))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('200')
  })

  it('rejects nested quantifiers', () => {
    expect(validateBranchPattern('re:(a+)+').ok).toBe(false)
    expect(validateBranchPattern('re:(a*)*').ok).toBe(false)
  })

  it('rejects a regex that does not compile', () => {
    const result = validateBranchPattern('re:[unclosed')
    expect(result.ok).toBe(false)
  })
})

describe('resolveEnvironment', () => {
  const envs = [
    { id: 'catch-all', branchPattern: '**', position: 1 },
    { id: 'refactors', branchPattern: 'refact/*', position: 0 },
  ]

  it('returns the lowest position among several matches', () => {
    expect(resolveEnvironment(envs, 'refact/auth')?.id).toBe('refactors')
  })

  it('falls through to a broader pattern when the narrow one misses', () => {
    expect(resolveEnvironment(envs, 'feat/x')?.id).toBe('catch-all')
  })

  it('returns null when nothing matches', () => {
    const only = [{ id: 'refactors', branchPattern: 'refact/*', position: 0 }]
    expect(resolveEnvironment(only, 'feat/x')).toBeNull()
  })

  it('returns null for an empty list', () => {
    expect(resolveEnvironment([], 'main')).toBeNull()
  })

  it('ignores an environment whose pattern is invalid', () => {
    const broken = [
      { id: 'broken', branchPattern: 're:[unclosed', position: 0 },
      { id: 'good', branchPattern: '**', position: 1 },
    ]
    expect(resolveEnvironment(broken, 'main')?.id).toBe('good')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dukebox/protocol exec vitest run src/branchPattern.test.ts`
Expected: FAIL — cannot resolve `./branchPattern.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/protocol/src/branchPattern.ts`:

```ts
/**
 * Which branches an environment is available for.
 *
 * Patterns are glob by default because branch names are paths and glob is the
 * syntax people already use for them in gitignore and in branch protection.
 * A `re:` prefix opts into a regular expression for the cases glob cannot
 * express.
 *
 * This module is pure and lives in protocol because both sides need it: the
 * server resolves a branch to an environment, and the app previews which
 * branches a pattern would match while the user is typing it.
 */

/** Regex prefix. Anything else is read as a glob. */
const REGEX_PREFIX = 're:'

/**
 * Cap on pattern length.
 *
 * Patterns are user-written and evaluated on the server, so an unbounded one
 * is an invitation to burn CPU on backtracking.
 */
export const MAX_BRANCH_PATTERN_LENGTH = 200

/**
 * A quantified group that is itself quantified — `(a+)+`, `(a*)*`.
 *
 * This is the classic catastrophic-backtracking shape. Rejecting it on the
 * source is cruder than analysing the compiled pattern, but it costs nothing
 * and no legitimate branch pattern needs one.
 */
const NESTED_QUANTIFIER = /\([^)]*[+*][^)]*\)\s*[+*]/

/** Characters that mean something to a regex and must survive a glob literally. */
const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\]/g

/**
 * Translate a glob into a regex source string.
 *
 * Everything is escaped first, then the escaped wildcards are put back as
 * regex fragments. Doing it in that order is what keeps `release.1` from
 * matching `releaseX1`.
 *
 * `**` is handled before `*` so the two-character wildcard is not consumed as
 * two one-character ones.
 */
function globToRegexSource(pattern: string): string {
  const escaped = pattern.replace(REGEX_METACHARACTERS, '\\$&')

  return escaped
    .replace(/\\\*\\\*/g, '�DOUBLESTAR�')
    .replace(/\\\*/g, '[^/]*')
    .replace(/�DOUBLESTAR�/g, '.*')
    .replace(/\\\?/g, '.')
}

/**
 * Compile a pattern to an anchored regex, or null if it cannot be compiled.
 *
 * Never carries the `g` flag: a global regex keeps `lastIndex` between calls,
 * which would make repeated matching of the same pattern return alternating
 * results.
 */
function compile(pattern: string): RegExp | null {
  const source = pattern.startsWith(REGEX_PREFIX)
    ? pattern.slice(REGEX_PREFIX.length)
    : globToRegexSource(pattern)

  try {
    // Anchored: an unanchored pattern matches substrings, so `re:main` would
    // match `feat/maintenance`, which nobody expects of a branch filter.
    return new RegExp(`^(?:${source})$`)
  } catch {
    return null
  }
}

/**
 * Whether a branch is covered by a pattern.
 *
 * An uncompilable pattern matches nothing rather than throwing: a broken
 * pattern should drop its own environment out of the list, not break session
 * start for every other one.
 */
export function matchesBranch(pattern: string, branch: string): boolean {
  const compiled = compile(pattern)
  if (!compiled) return false

  return compiled.test(branch)
}

/**
 * Whether a pattern is safe and usable, with a reason when it is not.
 *
 * Called by the write endpoints, not only by the UI — the app is not the
 * gatekeeper for something the server evaluates.
 */
export function validateBranchPattern(
  pattern: string,
): { ok: true } | { ok: false; reason: string } {
  if (pattern.trim().length === 0) {
    return { ok: false, reason: 'pattern cannot be empty' }
  }

  if (pattern.length > MAX_BRANCH_PATTERN_LENGTH) {
    return {
      ok: false,
      reason: `pattern cannot exceed ${MAX_BRANCH_PATTERN_LENGTH} characters`,
    }
  }

  if (pattern.startsWith(REGEX_PREFIX)) {
    const source = pattern.slice(REGEX_PREFIX.length)

    if (NESTED_QUANTIFIER.test(source)) {
      return { ok: false, reason: 'nested quantifiers are not allowed' }
    }

    if (!compile(pattern)) {
      return { ok: false, reason: 'not a valid regular expression' }
    }
  }

  return { ok: true }
}

/**
 * The environment a branch should use, or null for the base image.
 *
 * Ties are broken by explicit `position` rather than by how specific a pattern
 * looks: glob specificity is not well defined — between `feat/*` and `*/auth`
 * neither is obviously narrower — and mixing regex in makes it undecidable.
 */
export function resolveEnvironment<T extends { branchPattern: string; position: number }>(
  environments: T[],
  branch: string,
): T | null {
  const ordered = [...environments].sort((a, b) => a.position - b.position)

  return ordered.find((environment) => matchesBranch(environment.branchPattern, branch)) ?? null
}
```

- [ ] **Step 4: Export it from the package**

In `packages/protocol/src/index.ts`, add the export alongside the existing ones:

```ts
export * from './branchPattern.js'
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @dukebox/protocol exec vitest run src/branchPattern.test.ts`
Expected: PASS, all cases.

- [ ] **Step 6: Commit**

```bash
pnpm exec prettier --write packages/protocol/src/branchPattern.ts packages/protocol/src/branchPattern.test.ts packages/protocol/src/index.ts
git add packages/protocol/src/branchPattern.ts packages/protocol/src/branchPattern.test.ts packages/protocol/src/index.ts
git commit -m "feat(protocol): branch pattern matching and environment resolution"
```

---

## Task 2: Database schema and migration

**Files:**

- Modify: `packages/db/src/schema.ts` (projects block at lines ~97-132; sessions block at lines ~183-250)
- Create: `packages/db/migrations/0005_environments.sql`
- Modify: `packages/db/src/schema.test.ts`

**Interfaces:**

- Consumes: nothing from Task 1.
- Produces: `environments` table export from `@dukebox/db`; `sessions.environmentId` column; `projects` no longer has `configOverride`, `snapshotImage`, `environmentDraft`.

- [ ] **Step 1: Add the table to the schema**

In `packages/db/src/schema.ts`, **remove** these three fields from the `projects` table (they move):

```ts
    configOverride: jsonb('config_override'),
    snapshotImage: text('snapshot_image'),
    environmentDraft: jsonb('environment_draft'),
```

Keep their doc comments' substance on the new columns. Then add the table after `projects`:

```ts
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
```

In the `sessions` table, add after `baseBranch`:

```ts
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
```

And add its index to the `sessions` index list:

```ts
    index('sessions_environment_id_idx').on(table.environmentId),
```

- [ ] **Step 2: Write the migration**

Create `packages/db/migrations/0005_environments.sql`:

```sql
CREATE TABLE "environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"branch_pattern" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"config_override" jsonb,
	"snapshot_image" text,
	"environment_draft" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "environments_project_id_position_idx" ON "environments" USING btree ("project_id","position");
--> statement-breakpoint
CREATE UNIQUE INDEX "environments_project_id_name_idx" ON "environments" USING btree ("project_id","name");
--> statement-breakpoint
-- Existing single environments become one row each. The pattern is `**` and
-- not `*` because a single star stops at a slash, so `*` would silently stop
-- matching branches like `refact/auth` that work today.
INSERT INTO "environments" ("project_id", "name", "branch_pattern", "position", "config_override", "snapshot_image", "environment_draft")
SELECT "id", 'Default', '**', 0, "config_override", "snapshot_image", "environment_draft"
FROM "projects"
WHERE "config_override" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "environment_id" uuid;
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "sessions_environment_id_idx" ON "sessions" USING btree ("environment_id");
--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "config_override";
--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "snapshot_image";
--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "environment_draft";
```

- [ ] **Step 3: Regenerate Drizzle metadata**

Drizzle keeps a journal and snapshot alongside migrations. Regenerate so they match the hand-written SQL:

```bash
export DUKEBOX_DATABASE_URL='postgres://dukebox:dukebox@127.0.0.1:5433/dukebox'
pnpm --filter @dukebox/db exec drizzle-kit generate --name environments
```

If the generated file duplicates `0005_environments.sql`, keep the hand-written one (it carries the data copy, which drizzle-kit cannot infer) and delete the generated `.sql`, retaining the updated `meta/` files. Format the metadata — CI checks it (see commit `0780d80`):

```bash
pnpm exec prettier --write packages/db/migrations/meta
```

- [ ] **Step 4: Write the migration test**

Add to `packages/db/src/schema.test.ts`:

```ts
it('migrates a project with a config override into one Default environment', async () => {
  // A project carrying an override before the migration becomes exactly one
  // environment, matching every branch.
  const [project] = await db
    .insert(projects)
    .values({ repoFullName: 'acme/with-config', defaultBranch: 'main' })
    .returning()

  const [environment] = await db
    .insert(environments)
    .values({
      projectId: project.id,
      name: 'Default',
      branchPattern: '**',
      position: 0,
      configOverride: { setup: ['pnpm install'] },
    })
    .returning()

  expect(environment.branchPattern).toBe('**')
  expect(environment.position).toBe(0)
  expect(environment.configOverride).toEqual({ setup: ['pnpm install'] })
})

it('rejects two environments of one project sharing a name', async () => {
  const [project] = await db
    .insert(projects)
    .values({ repoFullName: 'acme/dupe-names', defaultBranch: 'main' })
    .returning()

  await db
    .insert(environments)
    .values({ projectId: project.id, name: 'Default', branchPattern: '**' })

  await expect(
    db.insert(environments).values({ projectId: project.id, name: 'Default', branchPattern: '*' }),
  ).rejects.toThrow()
})

it('keeps a session when its environment is deleted', async () => {
  // Deleting an environment must not delete the history of what ran on it.
  const [project] = await db
    .insert(projects)
    .values({ repoFullName: 'acme/orphan', defaultBranch: 'main' })
    .returning()

  const [environment] = await db
    .insert(environments)
    .values({ projectId: project.id, name: 'Default', branchPattern: '**' })
    .returning()

  const [session] = await db
    .insert(sessions)
    .values({
      projectId: project.id,
      environmentId: environment.id,
      agentId: 'claude-code',
      status: 'done',
      branch: 'duke/x',
      baseBranch: 'main',
    })
    .returning()

  await db.delete(environments).where(eq(environments.id, environment.id))

  const [after] = await db.select().from(sessions).where(eq(sessions.id, session.id))
  expect(after).toBeDefined()
  expect(after.environmentId).toBeNull()
})
```

Add `environments` to the file's imports from `./schema.js`, and `eq` from `drizzle-orm` if not already imported.

- [ ] **Step 5: Run the migration and the tests**

```bash
export DUKEBOX_DATABASE_URL='postgres://dukebox:dukebox@127.0.0.1:5433/dukebox'
pnpm --filter @dukebox/db exec drizzle-kit migrate
pnpm --filter @dukebox/db exec vitest run
```

Expected: migration applies cleanly; all schema tests PASS.

- [ ] **Step 6: Commit**

```bash
pnpm exec prettier --write packages/db/src/schema.ts packages/db/src/schema.test.ts packages/db/migrations
git add packages/db
git commit -m "feat(db): environments table and per-session environment"
```

---

## Task 3: Protocol API schemas

**Files:**

- Modify: `packages/protocol/src/api.ts`
- Modify: `packages/protocol/src/api.test.ts`

**Interfaces:**

- Consumes: `MAX_BRANCH_PATTERN_LENGTH` from Task 1.
- Produces: `environmentSummary` / `EnvironmentSummary`, `createEnvironmentRequest`, `updateEnvironmentRequest`, `reorderEnvironmentsRequest`, `listEnvironmentsResponse`; `environmentCount` on `projectSummary`; `environmentId` on `createSessionRequest`.

- [ ] **Step 1: Write the failing test**

Add to `packages/protocol/src/api.test.ts`:

```ts
describe('environment schemas', () => {
  it('accepts a valid create request', () => {
    const parsed = createEnvironmentRequest.safeParse({
      name: 'Refactors',
      branchPattern: 'refact/*',
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects an empty name', () => {
    expect(createEnvironmentRequest.safeParse({ name: '', branchPattern: '**' }).success).toBe(
      false,
    )
  })

  it('rejects a branch pattern over the length cap', () => {
    const parsed = createEnvironmentRequest.safeParse({
      name: 'Long',
      branchPattern: 'a'.repeat(201),
    })
    expect(parsed.success).toBe(false)
  })

  it('allows a partial update', () => {
    expect(updateEnvironmentRequest.safeParse({ name: 'Renamed' }).success).toBe(true)
    expect(updateEnvironmentRequest.safeParse({ branchPattern: '**' }).success).toBe(true)
  })

  it('requires at least one uuid to reorder', () => {
    expect(reorderEnvironmentsRequest.safeParse({ ids: [] }).success).toBe(false)
    expect(
      reorderEnvironmentsRequest.safeParse({ ids: ['3f1e4c1e-0b6e-4d3a-9a5f-9a1b2c3d4e5f'] })
        .success,
    ).toBe(true)
  })
})

describe('createSessionRequest environmentId', () => {
  it('accepts an optional environment id', () => {
    const parsed = createSessionRequest.safeParse({
      projectId: '3f1e4c1e-0b6e-4d3a-9a5f-9a1b2c3d4e5f',
      agentId: 'claude-code',
      prompt: 'do a thing',
      environmentId: '5c2d4e6a-1b3c-4d5e-8f9a-0b1c2d3e4f5a',
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts its absence', () => {
    const parsed = createSessionRequest.safeParse({
      projectId: '3f1e4c1e-0b6e-4d3a-9a5f-9a1b2c3d4e5f',
      agentId: 'claude-code',
      prompt: 'do a thing',
    })
    expect(parsed.success).toBe(true)
  })
})
```

Import the new schemas at the top of the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dukebox/protocol exec vitest run src/api.test.ts`
Expected: FAIL — `createEnvironmentRequest` is not exported.

- [ ] **Step 3: Add the schemas**

In `packages/protocol/src/api.ts`, replace `hasEnvironment` in `projectSummary` (currently lines 43-49) with:

```ts
  /**
   * How many environments the project has.
   *
   * Zero means every session runs on the base image, which the desktop shows
   * as a prompt to configure one rather than as an error.
   */
  environmentCount: z.number().int().nonnegative(),
```

Add a new section after the project section:

```ts
// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------

export const environmentSummary = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  name: z.string(),
  /** Glob, or a regular expression behind a `re:` prefix. */
  branchPattern: z.string(),
  /** Tie-break when several patterns match a branch. Lower wins. */
  position: z.number().int().nonnegative(),
  /** Whether setup and env have been saved, as opposed to only the row existing. */
  hasConfig: z.boolean(),
  /** Image built after this environment's setup ran, when one exists. */
  hasSnapshot: z.boolean(),
  /** Whether a proposal is waiting to be reviewed. */
  hasDraft: z.boolean(),
})

export type EnvironmentSummary = z.infer<typeof environmentSummary>

const branchPatternField = z
  .string()
  .min(1, 'pattern cannot be empty')
  // The full safety check (nested quantifiers, compilability) lives in
  // validateBranchPattern and runs in the route. This bound is here so an
  // obviously oversized pattern never reaches it.
  .max(MAX_BRANCH_PATTERN_LENGTH, `pattern cannot exceed ${MAX_BRANCH_PATTERN_LENGTH} characters`)

export const createEnvironmentRequest = z.object({
  name: z.string().min(1, 'name cannot be empty').max(80),
  branchPattern: branchPatternField,
})

export type CreateEnvironmentRequest = z.infer<typeof createEnvironmentRequest>

export const updateEnvironmentRequest = z.object({
  name: z.string().min(1).max(80).optional(),
  branchPattern: branchPatternField.optional(),
})

export type UpdateEnvironmentRequest = z.infer<typeof updateEnvironmentRequest>

/**
 * The complete ordered list of ids.
 *
 * Sending the whole list rather than "move X to slot 3" keeps two concurrent
 * clients from producing an order neither of them asked for.
 */
export const reorderEnvironmentsRequest = z.object({
  ids: z.array(z.string().uuid()).min(1),
})

export type ReorderEnvironmentsRequest = z.infer<typeof reorderEnvironmentsRequest>

export const listEnvironmentsResponse = z.object({
  environments: z.array(environmentSummary),
})
```

Add the import at the top of the file:

```ts
import { MAX_BRANCH_PATTERN_LENGTH } from './branchPattern.js'
```

In `createSessionRequest` (line 126), add after `baseBranch`:

```ts
    /**
     * Which environment to run in.
     *
     * Optional: the server resolves one from the base branch when absent. The
     * client proposes, the server decides — an id belonging to another project
     * is rejected rather than honoured.
     */
    environmentId: z.string().uuid().optional(),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @dukebox/protocol exec vitest run`
Expected: PASS. If other protocol tests referenced `hasEnvironment`, update them to `environmentCount`.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/protocol/src
git add packages/protocol/src
git commit -m "feat(protocol): environment API schemas"
```

---

## Task 4: Session manager resolves and persists the environment

**Files:**

- Modify: `apps/server/src/sessions/manager.ts` (`StartSessionOptions` ~line 84; `start()` ~line 146; `provision()` ~line 226; `captureEnvironmentProposal()` ~line 386; `configFor()` ~line 419)
- Modify: `apps/server/src/sessions/manager.test.ts`

**Interfaces:**

- Consumes: `resolveEnvironment` (Task 1), `environments` table (Task 2).
- Produces: `StartSessionOptions.environmentId?: string`; `configFor(environmentId: string | null)`.

- [ ] **Step 1: Write the failing test**

Add to `apps/server/src/sessions/manager.test.ts`, following the file's existing setup helpers:

```ts
it('resolves the environment from the base branch when none is given', async () => {
  const project = await createTestProject()

  await db.insert(environments).values([
    { projectId: project.id, name: 'Catch all', branchPattern: '**', position: 1 },
    { projectId: project.id, name: 'Refactors', branchPattern: 'refact/*', position: 0 },
  ])

  const session = await manager.start({
    projectId: project.id,
    agentId: 'claude-code',
    baseBranch: 'refact/auth',
    prompt: 'tidy this up',
  })

  const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
  const [resolved] = await db
    .select()
    .from(environments)
    .where(eq(environments.id, row.environmentId!))

  expect(resolved.name).toBe('Refactors')
})

it('leaves the environment null when no pattern matches', async () => {
  const project = await createTestProject()

  await db
    .insert(environments)
    .values({ projectId: project.id, name: 'Refactors', branchPattern: 'refact/*', position: 0 })

  const session = await manager.start({
    projectId: project.id,
    agentId: 'claude-code',
    baseBranch: 'main',
    prompt: 'do a thing',
  })

  const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
  expect(row.environmentId).toBeNull()
})

it('honours an explicit environment id belonging to the project', async () => {
  const project = await createTestProject()

  const [chosen] = await db
    .insert(environments)
    .values([
      { projectId: project.id, name: 'Catch all', branchPattern: '**', position: 0 },
      { projectId: project.id, name: 'Manual', branchPattern: 'never/*', position: 1 },
    ])
    .returning()

  const [manual] = await db
    .select()
    .from(environments)
    .where(and(eq(environments.projectId, project.id), eq(environments.name, 'Manual')))

  const session = await manager.start({
    projectId: project.id,
    agentId: 'claude-code',
    baseBranch: 'main',
    prompt: 'do a thing',
    environmentId: manual.id,
  })

  const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
  // The explicit choice wins over what the branch would have resolved to.
  expect(row.environmentId).toBe(manual.id)
  expect(row.environmentId).not.toBe(chosen.id)
})

it('rejects an environment id from another project', async () => {
  const project = await createTestProject()
  const other = await createTestProject('acme/other-repo')

  const [foreign] = await db
    .insert(environments)
    .values({ projectId: other.id, name: 'Theirs', branchPattern: '**', position: 0 })
    .returning()

  await expect(
    manager.start({
      projectId: project.id,
      agentId: 'claude-code',
      baseBranch: 'main',
      prompt: 'do a thing',
      environmentId: foreign.id,
    }),
  ).rejects.toThrow(/environment/i)
})
```

If `createTestProject` does not already take a repo name, extend it to accept an optional one defaulting to its current value.

- [ ] **Step 2: Run test to verify it fails**

```bash
export DUKEBOX_DATABASE_URL='postgres://dukebox:dukebox@127.0.0.1:5433/dukebox'
export DUKEBOX_REDIS_URL='redis://127.0.0.1:6380'
pnpm --filter @dukebox/server exec vitest run src/sessions/manager.test.ts -t environment
```

Expected: FAIL — `environmentId` is not accepted; `sessions.environmentId` is never set.

- [ ] **Step 3: Add environment resolution to `start()`**

In `StartSessionOptions` (line 84), add:

```ts
  /**
   * Which environment to run in.
   *
   * Absent means resolve from the base branch. Present means the caller chose,
   * and the choice is verified to belong to the project before it is used.
   */
  environmentId?: string
```

In `start()`, after `const baseBranch = options.baseBranch ?? project.defaultBranch` (line 162), insert:

```ts
// Resolved once, here, and persisted on the row. A session resumed weeks
// later must run in the environment it started with, even if patterns
// changed or the list was reordered in the meantime.
const environmentId = await this.resolveEnvironmentId(project.id, baseBranch, options.environmentId)
```

Add `environmentId` to the `.values({...})` insert (after `baseBranch`, line 174):

```ts
        environmentId,
```

Add the new private method next to `configFor`:

```ts
  /**
   * Which environment a new session runs in.
   *
   * An explicit choice is verified against the project: an id from another
   * project would otherwise inject that project's config and secrets into this
   * one. Without a choice, the base branch decides, and no match is null —
   * the base image, not an error.
   */
  private async resolveEnvironmentId(
    projectId: string,
    baseBranch: string,
    requested?: string,
  ): Promise<string | null> {
    if (requested) {
      const [owned] = await this.deps.db
        .select({ id: environments.id })
        .from(environments)
        .where(and(eq(environments.id, requested), eq(environments.projectId, projectId)))

      if (!owned) {
        throw new SessionError(`environment does not belong to this project: ${requested}`)
      }

      return owned.id
    }

    const rows = await this.deps.db
      .select({
        id: environments.id,
        branchPattern: environments.branchPattern,
        position: environments.position,
      })
      .from(environments)
      .where(eq(environments.projectId, projectId))

    return resolveEnvironment(rows, baseBranch)?.id ?? null
  }
```

- [ ] **Step 4: Rewrite `configFor` to take an environment**

Replace `configFor` (lines 419-433) with:

```ts
  /**
   * Effective config: defaults merged with the environment's override.
   *
   * A null environment is the base image — no database read, no override.
   */
  private async configFor(environmentId: string | null): Promise<ProjectConfig> {
    if (!environmentId) return defaultProjectConfig()

    const [environment] = await this.deps.db
      .select({ configOverride: environments.configOverride })
      .from(environments)
      .where(eq(environments.id, environmentId))

    if (!environment?.configOverride) return defaultProjectConfig()

    const parsed = projectConfig.partial().safeParse(environment.configOverride)
    if (!parsed.success) return defaultProjectConfig()

    return mergeProjectConfig(defaultProjectConfig(), parsed.data as Partial<ProjectConfig>)
  }
```

Update its caller in `provision()` (line 226):

```ts
const config = await this.configFor(session.environmentId)
```

- [ ] **Step 5: Point the draft at the environment**

In `captureEnvironmentProposal` (around line 401), the update currently writes `projects.environmentDraft`. Replace it with:

```ts
// The draft belongs to the environment the session runs in. A setup
// session started from the app always has one; without it there is
// nowhere to put the proposal, so it is reported rather than dropped.
if (!session.environmentId) {
  throw new Error('session has no environment to store the proposal on')
}

await this.deps.db
  .update(environments)
  .set({ environmentDraft: proposal, updatedAt: new Date() })
  .where(eq(environments.id, session.environmentId))
```

- [ ] **Step 6: Fix imports**

In `apps/server/src/sessions/manager.ts`, add `environments` to the `@dukebox/db` import, `resolveEnvironment` to the `@dukebox/protocol` import, and ensure `and` is imported from `drizzle-orm`.

- [ ] **Step 7: Run the tests**

```bash
export DUKEBOX_DATABASE_URL='postgres://dukebox:dukebox@127.0.0.1:5433/dukebox'
export DUKEBOX_REDIS_URL='redis://127.0.0.1:6380'
pnpm --filter @dukebox/server exec vitest run src/sessions/manager.test.ts
```

Expected: the four new tests PASS. Container-lifecycle tests in this file fail in the Cursor VM for the cgroups reason in `AGENTS.md` — that is pre-existing and not caused by this change. Confirm by checking the failure message mentions `domain controllers`.

- [ ] **Step 8: Commit**

```bash
pnpm exec prettier --write apps/server/src/sessions
git add apps/server/src/sessions
git commit -m "feat(server): resolve and persist a session's environment"
```

---

## Task 5: Environment routes

**Files:**

- Create: `apps/server/src/http/environments.ts`
- Create: `apps/server/src/http/environments.test.ts`
- Modify: `apps/server/src/http/projects.ts` (project list ~lines 62-90; environment GET/PUT ~lines 168-283)
- Modify: `apps/server/src/http/sessions.ts` (~line 77)
- Modify: `apps/server/src/http/routes.ts` (mount the new routes)

**Interfaces:**

- Consumes: `validateBranchPattern` (Task 1), `environments` (Task 2), environment schemas (Task 3).
- Produces: `environmentRoutes(deps: EnvironmentRoutesDeps)` returning a Hono app.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/http/environments.test.ts`, following the setup style of `routes.test.ts` (reuse its app/database harness):

```ts
import { environments, projects } from '@dukebox/db'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

// Reuse the harness from routes.test.ts: a real Postgres, a Hono app, and a
// paired device token. See that file for `createApp` and `authHeaders`.

describe('environment routes', () => {
  let projectId: string

  beforeEach(async () => {
    const [project] = await db
      .insert(projects)
      .values({ repoFullName: 'acme/env-routes', defaultBranch: 'main' })
      .returning()
    projectId = project.id
  })

  it('creates an environment at the end of the list', async () => {
    await app.request(`/api/projects/${projectId}/environments`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ name: 'First', branchPattern: '**' }),
    })

    const response = await app.request(`/api/projects/${projectId}/environments`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ name: 'Second', branchPattern: 'refact/*' }),
    })

    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.environment.name).toBe('Second')
    expect(body.environment.position).toBe(1)
  })

  it('rejects an invalid branch pattern with a reason', async () => {
    const response = await app.request(`/api/projects/${projectId}/environments`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ name: 'Bad', branchPattern: 're:(a+)+' }),
    })

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.message).toContain('nested quantifiers')
  })

  it('lists environments in position order', async () => {
    await db.insert(environments).values([
      { projectId, name: 'Second', branchPattern: 'refact/*', position: 1 },
      { projectId, name: 'First', branchPattern: '**', position: 0 },
    ])

    const response = await app.request(`/api/projects/${projectId}/environments`, {
      headers: authHeaders,
    })

    const body = await response.json()
    expect(body.environments.map((e: { name: string }) => e.name)).toEqual(['First', 'Second'])
  })

  it('updates a name and a pattern', async () => {
    const [environment] = await db
      .insert(environments)
      .values({ projectId, name: 'Old', branchPattern: '**', position: 0 })
      .returning()

    const response = await app.request(`/api/environments/${environment.id}`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ name: 'New', branchPattern: 'docs/*' }),
    })

    expect(response.status).toBe(200)
    const [after] = await db.select().from(environments).where(eq(environments.id, environment.id))
    expect(after.name).toBe('New')
    expect(after.branchPattern).toBe('docs/*')
  })

  it('rejects an update with an invalid pattern', async () => {
    const [environment] = await db
      .insert(environments)
      .values({ projectId, name: 'Env', branchPattern: '**', position: 0 })
      .returning()

    const response = await app.request(`/api/environments/${environment.id}`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ branchPattern: 're:[unclosed' }),
    })

    expect(response.status).toBe(400)
  })

  it('reorders by rewriting positions', async () => {
    const rows = await db
      .insert(environments)
      .values([
        { projectId, name: 'A', branchPattern: '**', position: 0 },
        { projectId, name: 'B', branchPattern: 'b/*', position: 1 },
        { projectId, name: 'C', branchPattern: 'c/*', position: 2 },
      ])
      .returning()

    const byName = (name: string) => rows.find((row) => row.name === name)!

    const response = await app.request(`/api/projects/${projectId}/environments/reorder`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ ids: [byName('C').id, byName('A').id, byName('B').id] }),
    })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.environments.map((e: { name: string }) => e.name)).toEqual(['C', 'A', 'B'])
  })

  it('refuses to reorder with ids from another project', async () => {
    const [other] = await db
      .insert(projects)
      .values({ repoFullName: 'acme/elsewhere', defaultBranch: 'main' })
      .returning()

    const [foreign] = await db
      .insert(environments)
      .values({ projectId: other.id, name: 'Theirs', branchPattern: '**', position: 0 })
      .returning()

    const response = await app.request(`/api/projects/${projectId}/environments/reorder`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ ids: [foreign.id] }),
    })

    expect(response.status).toBe(400)
  })

  it('deletes an environment', async () => {
    const [environment] = await db
      .insert(environments)
      .values({ projectId, name: 'Gone', branchPattern: '**', position: 0 })
      .returning()

    const response = await app.request(`/api/environments/${environment.id}`, {
      method: 'DELETE',
      headers: authHeaders,
    })

    expect(response.status).toBe(200)
    const remaining = await db
      .select()
      .from(environments)
      .where(eq(environments.id, environment.id))
    expect(remaining).toHaveLength(0)
  })

  it('404s for an unknown environment', async () => {
    const response = await app.request('/api/environments/3f1e4c1e-0b6e-4d3a-9a5f-9a1b2c3d4e5f', {
      method: 'DELETE',
      headers: authHeaders,
    })

    expect(response.status).toBe(404)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export DUKEBOX_DATABASE_URL='postgres://dukebox:dukebox@127.0.0.1:5433/dukebox'
export DUKEBOX_REDIS_URL='redis://127.0.0.1:6380'
pnpm --filter @dukebox/server exec vitest run src/http/environments.test.ts
```

Expected: FAIL — the routes do not exist (404 on every request).

- [ ] **Step 3: Write the routes**

Create `apps/server/src/http/environments.ts`:

```ts
import { environments, type Database } from '@dukebox/db'
import {
  createEnvironmentRequest,
  reorderEnvironmentsRequest,
  updateEnvironmentRequest,
  validateBranchPattern,
  type EnvironmentSummary,
} from '@dukebox/protocol'
import { asc, eq, inArray, max } from 'drizzle-orm'
import { Hono } from 'hono'

/**
 * Environments: the ways a project can be run.
 *
 * Which one a session uses is decided from its base branch, so these routes
 * are about the list and its order — the resolution itself lives in the
 * session manager, where it happens once per session.
 */

export interface EnvironmentRoutesDeps {
  db: Database
}

function toSummary(row: typeof environments.$inferSelect): EnvironmentSummary {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    branchPattern: row.branchPattern,
    position: row.position,
    hasConfig: row.configOverride !== null,
    hasSnapshot: row.snapshotImage !== null,
    hasDraft: row.environmentDraft !== null,
  }
}

export function environmentRoutes(deps: EnvironmentRoutesDeps) {
  const app = new Hono()

  app.get('/projects/:id/environments', async (c) => {
    const rows = await deps.db
      .select()
      .from(environments)
      .where(eq(environments.projectId, c.req.param('id')))
      .orderBy(asc(environments.position))

    return c.json({ environments: rows.map(toSummary) })
  })

  app.post('/projects/:id/environments', async (c) => {
    const projectId = c.req.param('id')

    const body = await c.req.json().catch(() => null)
    const parsed = createEnvironmentRequest.safeParse(body)

    if (!parsed.success) {
      return c.json({ error: 'invalid_request', message: parsed.error.message }, 400)
    }

    // The schema bounds the length; this is the check that the pattern is
    // actually safe to evaluate. It runs here rather than only in the app,
    // because the app is not the gatekeeper for something the server runs.
    const valid = validateBranchPattern(parsed.data.branchPattern)
    if (!valid.ok) {
      return c.json({ error: 'invalid_request', message: valid.reason }, 400)
    }

    // New environments land at the end: appending never changes which
    // environment an existing branch already resolves to.
    const [current] = await deps.db
      .select({ highest: max(environments.position) })
      .from(environments)
      .where(eq(environments.projectId, projectId))

    const position =
      current?.highest === null || current?.highest === undefined ? 0 : current.highest + 1

    const [created] = await deps.db
      .insert(environments)
      .values({
        projectId,
        name: parsed.data.name,
        branchPattern: parsed.data.branchPattern,
        position,
      })
      .returning()

    if (!created) {
      return c.json({ error: 'invalid_request', message: 'could not create environment' }, 400)
    }

    return c.json({ environment: toSummary(created) }, 201)
  })

  app.patch('/environments/:id', async (c) => {
    const id = c.req.param('id')

    const body = await c.req.json().catch(() => null)
    const parsed = updateEnvironmentRequest.safeParse(body)

    if (!parsed.success) {
      return c.json({ error: 'invalid_request', message: parsed.error.message }, 400)
    }

    if (parsed.data.branchPattern !== undefined) {
      const valid = validateBranchPattern(parsed.data.branchPattern)
      if (!valid.ok) {
        return c.json({ error: 'invalid_request', message: valid.reason }, 400)
      }
    }

    const [updated] = await deps.db
      .update(environments)
      .set({
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.branchPattern !== undefined
          ? { branchPattern: parsed.data.branchPattern }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(environments.id, id))
      .returning()

    if (!updated) {
      return c.json({ error: 'not_found', message: 'no such environment' }, 404)
    }

    return c.json({ environment: toSummary(updated) })
  })

  app.delete('/environments/:id', async (c) => {
    // Sessions that ran here keep their history: the foreign key is
    // `on delete set null`, so they become base-image sessions rather than
    // disappearing.
    const deleted = await deps.db
      .delete(environments)
      .where(eq(environments.id, c.req.param('id')))
      .returning({ id: environments.id })

    if (deleted.length === 0) {
      return c.json({ error: 'not_found', message: 'no such environment' }, 404)
    }

    return c.json({ ok: true })
  })

  app.post('/projects/:id/environments/reorder', async (c) => {
    const projectId = c.req.param('id')

    const body = await c.req.json().catch(() => null)
    const parsed = reorderEnvironmentsRequest.safeParse(body)

    if (!parsed.success) {
      return c.json({ error: 'invalid_request', message: parsed.error.message }, 400)
    }

    const { ids } = parsed.data

    const owned = await deps.db
      .select({ id: environments.id })
      .from(environments)
      .where(eq(environments.projectId, projectId))

    const ownedIds = new Set(owned.map((row) => row.id))

    // Every id must belong to this project, and all of them must be present:
    // a partial list would leave the missing rows at stale positions and
    // produce an order nobody asked for.
    if (ids.length !== owned.length || ids.some((id) => !ownedIds.has(id))) {
      return c.json(
        { error: 'invalid_request', message: 'ids must be this project’s environments, in full' },
        400,
      )
    }

    await deps.db.transaction(async (tx) => {
      for (const [position, id] of ids.entries()) {
        await tx
          .update(environments)
          .set({ position, updatedAt: new Date() })
          .where(eq(environments.id, id))
      }
    })

    const rows = await deps.db
      .select()
      .from(environments)
      .where(inArray(environments.id, ids))
      .orderBy(asc(environments.position))

    return c.json({ environments: rows.map(toSummary) })
  })

  return app
}
```

- [ ] **Step 4: Mount the routes**

In `apps/server/src/http/routes.ts`, mount `environmentRoutes({ db })` under `/api` alongside the existing route groups, matching how `projectRoutes` is mounted.

- [ ] **Step 5: Update the project summary**

In `apps/server/src/http/projects.ts`, the list query (lines 62-90) selects `snapshotImage` and `configOverride` from `projects`, which no longer exist. Replace those selections with a count over the new table and update the mapping:

```ts
const rows = await deps.db
  .select({
    id: projects.id,
    repoFullName: projects.repoFullName,
    defaultBranch: projects.defaultBranch,
    createdAt: projects.createdAt,
    sessionCount: count(sessions.id),
  })
  .from(projects)
  .leftJoin(sessions, and(eq(sessions.projectId, projects.id), isNull(sessions.archivedAt)))
  .groupBy(projects.id)
  .orderBy(desc(projects.createdAt))

// A separate grouped query rather than a second join: joining both would
// multiply the rows and inflate every count.
const environmentCounts = await deps.db
  .select({ projectId: environments.projectId, total: count(environments.id) })
  .from(environments)
  .groupBy(environments.projectId)

const countByProject = new Map(environmentCounts.map((row) => [row.projectId, Number(row.total)]))

const summaries: ProjectSummary[] = rows.map((row) => ({
  id: row.id,
  repoFullName: row.repoFullName,
  defaultBranch: row.defaultBranch,
  environmentCount: countByProject.get(row.id) ?? 0,
  createdAt: row.createdAt.getTime(),
  sessionCount: Number(row.sessionCount),
}))
```

Remove `hasSnapshot` from the mapping — it moves to `EnvironmentSummary.hasSnapshot`. Also update the single-project response near line 146 that sets `hasEnvironment: false` to `environmentCount: 0`.

- [ ] **Step 6: Point the environment GET/PUT at the environment row**

In the same file, `GET /projects/:id/environment` (line 170) and `PUT /projects/:id/environment` (line 214) read and write `projects.configOverride` and `projects.environmentDraft`. Both now take the environment id as a query parameter, since a project has several:

- `GET /projects/:id/environment?environmentId=<uuid>` reads that environment row instead of the project. Without the parameter, return 400 with `message: 'environmentId is required'`.
- `PUT /projects/:id/environment?environmentId=<uuid>` writes `configOverride` and clears `environmentDraft` on that row (`apps/server/src/http/projects.ts:266`), after verifying it belongs to `:id`. Secrets stay project-scoped and are untouched by this change.

Keep the existing validation — the `projectConfig.parse(merged)` guard that stops a bad override poisoning later sessions stays exactly as it is.

- [ ] **Step 7: Pass `environmentId` through session creation**

In `apps/server/src/http/sessions.ts` line 77, the handler destructures the parsed body. Add `environmentId` so it reaches the manager:

```ts
const { baseBranch, prompt, purpose, model, environmentId, ...rest } = parsed.data
```

and include it in the `manager.start({...})` call:

```ts
        ...(environmentId ? { environmentId } : {}),
```

A `SessionError` about a foreign environment must surface as 403, not 500. In the handler's catch, map an error whose message matches `/environment does not belong/` to:

```ts
return c.json({ error: 'forbidden', message: error.message }, 403)
```

- [ ] **Step 8: Add the 403 test**

Add to `apps/server/src/http/environments.test.ts`:

```ts
it('403s when starting a session with another project’s environment', async () => {
  const [other] = await db
    .insert(projects)
    .values({ repoFullName: 'acme/not-yours', defaultBranch: 'main' })
    .returning()

  const [foreign] = await db
    .insert(environments)
    .values({ projectId: other.id, name: 'Theirs', branchPattern: '**', position: 0 })
    .returning()

  const response = await app.request('/api/sessions', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      projectId,
      agentId: 'claude-code',
      prompt: 'do a thing',
      environmentId: foreign.id,
    }),
  })

  expect(response.status).toBe(403)
})
```

- [ ] **Step 9: Run the tests**

```bash
export DUKEBOX_DATABASE_URL='postgres://dukebox:dukebox@127.0.0.1:5433/dukebox'
export DUKEBOX_REDIS_URL='redis://127.0.0.1:6380'
pnpm --filter @dukebox/server exec vitest run src/http
```

Expected: PASS. Fix any `routes.test.ts` assertions still expecting `hasEnvironment` or `hasSnapshot` on a project.

- [ ] **Step 10: Typecheck and commit**

```bash
pnpm exec turbo run typecheck
pnpm exec prettier --write apps/server/src/http
git add apps/server/src/http
git commit -m "feat(server): environment CRUD and reorder routes"
```

---

## Task 6: Desktop client and environment picker

**Files:**

- Modify: `apps/desktop/src/lib/client.ts`
- Modify: `apps/desktop/src/components/RepoBranchPickers.tsx`
- Modify: `apps/desktop/src/screens/NewSession.tsx`
- Modify: `apps/desktop/src/components/Sidebar.tsx:204`
- Modify: `apps/desktop/src/preview.tsx:434`
- Create: `apps/desktop/src/screens/NewSession.test.tsx`

**Interfaces:**

- Consumes: `matchesBranch`, `resolveEnvironment` (Task 1); `EnvironmentSummary` and the request schemas (Task 3); the routes (Task 5).
- Produces: `EnvironmentPicker`; client methods `listEnvironments`, `createEnvironment`, `updateEnvironment`, `deleteEnvironment`, `reorderEnvironments`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/screens/NewSession.test.tsx`, following the testing-library setup used elsewhere in the app:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { NewSession } from './NewSession.js'

// A project with two environments: one for refact/*, one catch-all.
const environments = [
  {
    id: 'env-refact',
    projectId: 'p1',
    name: 'Refactors',
    branchPattern: 'refact/*',
    position: 0,
    hasConfig: true,
    hasSnapshot: false,
    hasDraft: false,
  },
  {
    id: 'env-all',
    projectId: 'p1',
    name: 'Default',
    branchPattern: '**',
    position: 1,
    hasConfig: true,
    hasSnapshot: false,
    hasDraft: false,
  },
]

function makeClient(overrides = {}) {
  return {
    listRepositories: vi.fn().mockResolvedValue([]),
    listBranches: vi.fn().mockResolvedValue(['main', 'refact/auth']),
    listEnvironments: vi.fn().mockResolvedValue(environments),
    startSession: vi.fn().mockResolvedValue({ id: 's1' }),
    createProject: vi.fn(),
    ...overrides,
  }
}

const project = {
  id: 'p1',
  repoFullName: 'acme/app',
  defaultBranch: 'main',
  environmentCount: 2,
  createdAt: Date.now(),
  sessionCount: 0,
}

const connection = { deviceId: 'd1', serverName: 'server', address: { host: 'localhost' } }

describe('NewSession environment picker', () => {
  it('offers only environments matching the branch', async () => {
    const client = makeClient()
    render(
      <NewSession
        client={client as never}
        connection={connection as never}
        projects={[project as never]}
        onCreated={vi.fn()}
      />,
    )

    // On `main`, only the catch-all matches; Refactors is not offered.
    await waitFor(() => expect(screen.getByLabelText(/environment/i)).toBeInTheDocument())
    const picker = screen.getByLabelText(/environment/i)
    expect(picker).toHaveTextContent('Default')
    expect(picker).not.toHaveTextContent('Refactors')
  })

  it('preselects the lowest-position match after switching branch', async () => {
    const client = makeClient()
    render(
      <NewSession
        client={client as never}
        connection={connection as never}
        projects={[project as never]}
        onCreated={vi.fn()}
      />,
    )

    await waitFor(() => expect(screen.getByLabelText(/branch/i)).toBeInTheDocument())
    await userEvent.selectOptions(screen.getByLabelText(/branch/i), 'refact/auth')

    await waitFor(() =>
      expect(screen.getByLabelText(/environment/i)).toHaveTextContent('Refactors'),
    )
  })

  it('sends the selected environment id when starting a session', async () => {
    const client = makeClient()
    render(
      <NewSession
        client={client as never}
        connection={connection as never}
        projects={[project as never]}
        onCreated={vi.fn()}
      />,
    )

    await waitFor(() => expect(screen.getByLabelText(/what should it do/i)).toBeInTheDocument())
    await userEvent.type(screen.getByLabelText(/what should it do/i), 'do a thing')
    await userEvent.click(screen.getByRole('button', { name: /start session/i }))

    await waitFor(() =>
      expect(client.startSession).toHaveBeenCalledWith(
        expect.objectContaining({ environmentId: 'env-all' }),
      ),
    )
  })

  it('shows the base-image notice when nothing matches', async () => {
    const client = makeClient({
      listEnvironments: vi.fn().mockResolvedValue([
        { ...environments[0] }, // refact/* only
      ]),
    })

    render(
      <NewSession
        client={client as never}
        connection={connection as never}
        projects={[{ ...project, environmentCount: 1 } as never]}
        onCreated={vi.fn()}
      />,
    )

    // Base branch is `main`; `refact/*` does not cover it.
    await waitFor(() => expect(screen.getByText(/base image will be used/i)).toBeInTheDocument())
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dukebox/desktop exec vitest run src/screens/NewSession.test.tsx`
Expected: FAIL — no environment picker is rendered.

- [ ] **Step 3: Add the client methods**

In `apps/desktop/src/lib/client.ts`, add alongside the existing methods, matching their request/parse style:

```ts
  async listEnvironments(projectId: string): Promise<EnvironmentSummary[]> {
    const body = await this.get(`/api/projects/${projectId}/environments`)
    return listEnvironmentsResponse.parse(body).environments
  }

  async createEnvironment(
    projectId: string,
    request: CreateEnvironmentRequest,
  ): Promise<EnvironmentSummary> {
    const body = await this.post(`/api/projects/${projectId}/environments`, request)
    return environmentSummary.parse((body as { environment: unknown }).environment)
  }

  async updateEnvironment(
    environmentId: string,
    request: UpdateEnvironmentRequest,
  ): Promise<EnvironmentSummary> {
    const body = await this.patch(`/api/environments/${environmentId}`, request)
    return environmentSummary.parse((body as { environment: unknown }).environment)
  }

  async deleteEnvironment(environmentId: string): Promise<void> {
    await this.delete(`/api/environments/${environmentId}`)
  }

  async reorderEnvironments(projectId: string, ids: string[]): Promise<EnvironmentSummary[]> {
    const body = await this.post(`/api/projects/${projectId}/environments/reorder`, { ids })
    return listEnvironmentsResponse.parse(body).environments
  }
```

If the class has no `patch` or `delete` helper, add them next to the existing `get`/`post` in the same style.

Add `environmentId` to the `startSession` request type it already passes through.

- [ ] **Step 4: Add the picker**

In `apps/desktop/src/components/RepoBranchPickers.tsx`, add alongside the existing pickers, matching their markup and class names:

```tsx
/** Sentinel for "no environment": the base image, with no override. */
export const BASE_IMAGE_VALUE = ''

export function EnvironmentPicker({
  environments,
  value,
  onChange,
  disabled,
}: {
  environments: EnvironmentSummary[]
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}) {
  return (
    <select
      aria-label="Environment"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
      className={PICKER_CLASS}
    >
      {environments.map((environment) => (
        <option key={environment.id} value={environment.id}>
          {environment.name}
        </option>
      ))}
      <option value={BASE_IMAGE_VALUE}>No environment (base image)</option>
    </select>
  )
}
```

Use whatever the file's existing pickers use for `PICKER_CLASS` — match them rather than inventing a new style.

- [ ] **Step 5: Wire it into New Session**

In `apps/desktop/src/screens/NewSession.tsx`:

Add state and loading, after the `branches` state (line 58):

```tsx
const [environments, setEnvironments] = useState<EnvironmentSummary[]>([])
const [environmentId, setEnvironmentId] = useState<string>(BASE_IMAGE_VALUE)
```

Load them when the project changes, alongside the existing branch effect:

```tsx
useEffect(() => {
  const project = projects.find((candidate) => candidate.repoFullName === target)

  if (!project) {
    setEnvironments([])
    return
  }

  let cancelled = false

  client
    .listEnvironments(project.id)
    .then((found) => {
      if (cancelled) return
      setEnvironments(found)
    })
    .catch(() => {
      // Best-effort, like the branch list: without environments the form
      // falls back to the base image, which is a valid way to start.
      if (cancelled) return
      setEnvironments([])
    })

  return () => {
    cancelled = true
  }
}, [client, target, projects])
```

Derive the matching set and keep the selection valid:

```tsx
const matching = environments.filter((environment) =>
  matchesBranch(environment.branchPattern, baseBranch),
)

// Changing branch must not leave a no-longer-applicable environment
// selected. A still-matching choice is kept; otherwise the first match wins,
// and with no matches at all this settles on the base image.
useEffect(() => {
  setEnvironmentId((current) => {
    if (current && matching.some((environment) => environment.id === current)) return current
    return matching[0]?.id ?? BASE_IMAGE_VALUE
  })
}, [baseBranch, environments])
```

Render the picker in the picker row (after `BranchPicker`, line 227), hidden when the project has none:

```tsx
{
  environments.length > 0 && (
    <EnvironmentPicker
      environments={matching}
      value={environmentId}
      onChange={setEnvironmentId}
      disabled={busy || !target}
    />
  )
}
```

Pass it when starting a coding session (line 191):

```tsx
const session = await client.startSession({
  projectId: project.id,
  agentId,
  model,
  prompt: prompt.trim(),
  baseBranch,
  purpose: 'coding',
  ...(environmentId ? { environmentId } : {}),
})
```

- [ ] **Step 6: Replace the environment gate with the base-image notice**

`needsEnvironment` (line 68) currently forces setup whenever the project has no environment. Setup is no longer a gate — a coding session always starts. Replace it with:

```tsx
// Setup is offered, not required: a branch with no environment runs on the
// base image rather than being blocked.
const usingBaseImage = environmentId === BASE_IMAGE_VALUE
const needsEnvironment = forceSetup
```

Under the composer, when `usingBaseImage && !needsEnvironment`, render:

```tsx
{
  usingBaseImage && (
    <p className="mt-2 text-[12px] text-muted-foreground">
      No environment for this branch — the base image will be used.{' '}
      <button
        type="button"
        onClick={() => setForceSetup(true)}
        className="underline underline-offset-2"
      >
        Configure environment
      </button>
    </p>
  )
}
```

In the `needsEnvironment` branch (line 239), add the name and pattern fields above the existing button, prefilled from the current branch:

```tsx
            <label className="mt-3 block text-[12px] text-muted-foreground">
              Name
              <input
                value={newEnvironmentName}
                onChange={(event) => setNewEnvironmentName(event.target.value)}
                className={INPUT_CLASS}
              />
            </label>
            <label className="mt-2 block text-[12px] text-muted-foreground">
              Branches
              <input
                value={newEnvironmentPattern}
                onChange={(event) => setNewEnvironmentPattern(event.target.value)}
                aria-describedby="pattern-help"
                className={INPUT_CLASS}
              />
            </label>
            <p id="pattern-help" className="mt-1 text-[11px] text-muted-foreground">
              Glob like <code>refact/*</code> or <code>**</code> for every branch. Prefix with{' '}
              <code>re:</code> for a regular expression.
            </p>
```

with state defaulting from the branch:

```tsx
const [newEnvironmentName, setNewEnvironmentName] = useState('Default')
const [newEnvironmentPattern, setNewEnvironmentPattern] = useState('**')

// `refact/auth` suggests `refact/*` — the family, not the one branch. A
// branch with no slash suggests the catch-all instead.
useEffect(() => {
  const [prefix] = baseBranch.split('/')
  setNewEnvironmentPattern(baseBranch.includes('/') ? `${prefix}/*` : '**')
}, [baseBranch])
```

In `submit()`, the setup path (line 179) creates the environment first so the session has somewhere to write its draft:

```tsx
if (needsEnvironment) {
  const environment = await client.createEnvironment(project.id, {
    name: newEnvironmentName.trim() || 'Default',
    branchPattern: newEnvironmentPattern.trim() || '**',
  })

  const session = await client.startSession({
    projectId: project.id,
    agentId,
    model,
    baseBranch,
    purpose: 'environment_setup',
    environmentId: environment.id,
  })
  onCreated(session, created)
  return
}
```

Use the file's existing input styling for `INPUT_CLASS` rather than inventing one.

- [ ] **Step 7: Update the sidebar and preview**

`apps/desktop/src/components/Sidebar.tsx:204`:

```tsx
        {project.environmentCount === 0 && (
```

`apps/desktop/src/preview.tsx:434`: replace `hasEnvironment: true` with `environmentCount: 1`, and make the scripted client's `listEnvironments` return one catch-all environment so the preview exercises the picker:

```tsx
      listEnvironments: async () => [
        {
          id: 'env-preview',
          projectId: 'project-preview',
          name: 'Default',
          branchPattern: '**',
          position: 0,
          hasConfig: true,
          hasSnapshot: false,
          hasDraft: false,
        },
      ],
```

- [ ] **Step 8: Run the tests**

```bash
pnpm --filter @dukebox/desktop exec vitest run
pnpm exec turbo run typecheck
```

Expected: PASS. Typecheck catches any remaining `hasEnvironment` reference.

- [ ] **Step 9: Verify in the preview**

```bash
pnpm --filter @dukebox/desktop dev
```

Open `http://localhost:5173/preview.html`. Confirm the environment picker appears next to the branch picker and that choosing a branch with no matching environment shows the base-image notice. Free the port first if needed: `lsof -ti :5173 | xargs kill`.

- [ ] **Step 10: Commit**

```bash
pnpm exec prettier --write apps/desktop/src
git add apps/desktop/src
git commit -m "feat(desktop): environment picker in New Session"
```

---

## Task 7: Environments management panel

**Files:**

- Create: `apps/desktop/src/components/EnvironmentsPanel.tsx`
- Create: `apps/desktop/src/components/EnvironmentsPanel.test.tsx`
- Modify: `apps/desktop/src/components/Sidebar.tsx` (entry point)
- Modify: `apps/desktop/src/components/EnvironmentReview.tsx` (header)

**Interfaces:**

- Consumes: client methods (Task 6), `matchesBranch` and `validateBranchPattern` (Task 1).
- Produces: `EnvironmentsPanel` component.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/components/EnvironmentsPanel.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { EnvironmentsPanel } from './EnvironmentsPanel.js'

const environments = [
  {
    id: 'env-1',
    projectId: 'p1',
    name: 'Refactors',
    branchPattern: 'refact/*',
    position: 0,
    hasConfig: true,
    hasSnapshot: true,
    hasDraft: false,
  },
  {
    id: 'env-2',
    projectId: 'p1',
    name: 'Default',
    branchPattern: '**',
    position: 1,
    hasConfig: true,
    hasSnapshot: false,
    hasDraft: false,
  },
]

function makeClient(overrides = {}) {
  return {
    listEnvironments: vi.fn().mockResolvedValue(environments),
    createEnvironment: vi.fn(),
    updateEnvironment: vi.fn().mockResolvedValue(environments[0]),
    deleteEnvironment: vi.fn().mockResolvedValue(undefined),
    reorderEnvironments: vi.fn().mockResolvedValue(environments),
    listBranches: vi.fn().mockResolvedValue(['main', 'refact/auth', 'refact/api']),
    ...overrides,
  }
}

describe('EnvironmentsPanel', () => {
  it('lists environments in order', async () => {
    render(<EnvironmentsPanel client={makeClient() as never} projectId="p1" />)

    await waitFor(() => expect(screen.getByDisplayValue('Refactors')).toBeInTheDocument())
    expect(screen.getByDisplayValue('Default')).toBeInTheDocument()
  })

  it('previews which branches a pattern matches', async () => {
    render(<EnvironmentsPanel client={makeClient() as never} projectId="p1" />)

    await waitFor(() => expect(screen.getByDisplayValue('refact/*')).toBeInTheDocument())

    // `refact/*` covers two of the three branches.
    expect(screen.getByText(/2 branches/i)).toBeInTheDocument()
  })

  it('warns when a pattern matches nothing', async () => {
    render(<EnvironmentsPanel client={makeClient() as never} projectId="p1" />)

    const field = await screen.findByDisplayValue('refact/*')
    await userEvent.clear(field)
    await userEvent.type(field, 'nope/*')

    await waitFor(() => expect(screen.getByText(/no branches/i)).toBeInTheDocument())
  })

  it('shows a validation error for an unsafe pattern', async () => {
    render(<EnvironmentsPanel client={makeClient() as never} projectId="p1" />)

    const field = await screen.findByDisplayValue('refact/*')
    await userEvent.clear(field)
    await userEvent.type(field, 're:(a+)+')

    await waitFor(() => expect(screen.getByText(/nested quantifiers/i)).toBeInTheDocument())
  })

  it('deletes an environment', async () => {
    const client = makeClient()
    render(<EnvironmentsPanel client={client as never} projectId="p1" />)

    await waitFor(() => expect(screen.getByDisplayValue('Refactors')).toBeInTheDocument())
    await userEvent.click(screen.getAllByRole('button', { name: /delete/i })[0])

    await waitFor(() => expect(client.deleteEnvironment).toHaveBeenCalledWith('env-1'))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dukebox/desktop exec vitest run src/components/EnvironmentsPanel.test.tsx`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the panel**

Create `apps/desktop/src/components/EnvironmentsPanel.tsx`:

```tsx
import { matchesBranch, validateBranchPattern, type EnvironmentSummary } from '@dukebox/protocol'
import { useEffect, useState } from 'react'
import type { DukeboxClient } from '../lib/client.js'

/**
 * Managing a project's environments.
 *
 * Ordering matters here in a way it does not anywhere else: when several
 * patterns match a branch, the topmost one wins. That is why the list is
 * reorderable and why each row shows which branches its pattern actually
 * covers — a pattern that matches nothing is a mistake worth seeing before a
 * session starts rather than after.
 */

interface Props {
  client: DukeboxClient
  projectId: string
}

export function EnvironmentsPanel({ client, projectId }: Props) {
  const [environments, setEnvironments] = useState<EnvironmentSummary[]>([])
  const [branches, setBranches] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    client
      .listEnvironments(projectId)
      .then((found) => {
        if (!cancelled) setEnvironments(found)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setError(cause instanceof Error ? cause.message : 'Could not load environments.')
      })

    // Best-effort: the branch list only powers the match preview, so failing
    // to load it must not stop someone editing a pattern.
    client
      .listBranches(projectId)
      .then((found) => {
        if (!cancelled) setBranches(found)
      })
      .catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [client, projectId])

  const patch = async (id: string, changes: { name?: string; branchPattern?: string }) => {
    try {
      const updated = await client.updateEnvironment(id, changes)
      setEnvironments((current) =>
        current.map((environment) => (environment.id === id ? updated : environment)),
      )
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the environment.')
    }
  }

  const move = async (index: number, delta: number) => {
    const next = [...environments]
    const target = index + delta
    if (target < 0 || target >= next.length) return

    const moved = next[index]
    next[index] = next[target]
    next[target] = moved

    // Optimistic: the reorder is a visual operation and waiting on a round
    // trip to redraw makes the buttons feel broken.
    setEnvironments(next)

    try {
      const saved = await client.reorderEnvironments(
        projectId,
        next.map((environment) => environment.id),
      )
      setEnvironments(saved)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not reorder environments.')
    }
  }

  const remove = async (id: string) => {
    try {
      await client.deleteEnvironment(id)
      setEnvironments((current) => current.filter((environment) => environment.id !== id))
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not delete the environment.')
    }
  }

  const create = async () => {
    try {
      const created = await client.createEnvironment(projectId, {
        name: 'New environment',
        branchPattern: '**',
      })
      setEnvironments((current) => [...current, created])
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create the environment.')
    }
  }

  return (
    <div className="min-h-0 min-w-0 overflow-y-auto px-6 py-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-[14px] font-medium">Environments</h2>
        <button
          type="button"
          onClick={() => void create()}
          className="rounded-full bg-foreground px-3 py-1 text-[12px] font-medium text-background"
        >
          New environment
        </button>
      </div>

      <p className="mb-4 text-[12px] text-muted-foreground">
        When several environments match a branch, the topmost one is used.
      </p>

      <ul className="flex flex-col gap-2">
        {environments.map((environment, index) => (
          <EnvironmentRow
            key={environment.id}
            environment={environment}
            branches={branches}
            isFirst={index === 0}
            isLast={index === environments.length - 1}
            onCommit={(changes) => void patch(environment.id, changes)}
            onMove={(delta) => void move(index, delta)}
            onDelete={() => void remove(environment.id)}
          />
        ))}
      </ul>

      {environments.length === 0 && (
        <p className="text-[13px] text-muted-foreground">
          No environments yet. Sessions run on the base image.
        </p>
      )}

      {error && (
        <p role="alert" className="mt-3 text-[13px] text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

function EnvironmentRow({
  environment,
  branches,
  isFirst,
  isLast,
  onCommit,
  onMove,
  onDelete,
}: {
  environment: EnvironmentSummary
  branches: string[]
  isFirst: boolean
  isLast: boolean
  onCommit: (changes: { name?: string; branchPattern?: string }) => void
  onMove: (delta: number) => void
  onDelete: () => void
}) {
  const [name, setName] = useState(environment.name)
  const [pattern, setPattern] = useState(environment.branchPattern)

  useEffect(() => {
    setName(environment.name)
    setPattern(environment.branchPattern)
  }, [environment.name, environment.branchPattern])

  const validation = validateBranchPattern(pattern)
  const matched = validation.ok ? branches.filter((branch) => matchesBranch(pattern, branch)) : []

  return (
    <li className="rounded-[calc(var(--radius)*1.1)] border border-border bg-surface px-3.5 py-3">
      <div className="flex items-center gap-2">
        <input
          aria-label="Environment name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          // Committing on blur rather than per keystroke keeps a half-typed
          // name or pattern from being saved.
          onBlur={() => {
            if (name !== environment.name) onCommit({ name })
          }}
          className="min-w-0 flex-1 bg-transparent text-[13px] font-medium outline-none"
        />

        <button
          type="button"
          aria-label="Move up"
          disabled={isFirst}
          onClick={() => onMove(-1)}
          className="px-1.5 text-[12px] text-muted-foreground disabled:opacity-30"
        >
          ↑
        </button>
        <button
          type="button"
          aria-label="Move down"
          disabled={isLast}
          onClick={() => onMove(1)}
          className="px-1.5 text-[12px] text-muted-foreground disabled:opacity-30"
        >
          ↓
        </button>
        <button
          type="button"
          aria-label={`Delete ${environment.name}`}
          onClick={onDelete}
          className="px-1.5 text-[12px] text-muted-foreground hover:text-destructive"
        >
          Delete
        </button>
      </div>

      <input
        aria-label="Branch pattern"
        value={pattern}
        onChange={(event) => setPattern(event.target.value)}
        onBlur={() => {
          // An invalid pattern is never sent: the server would reject it, and
          // the reason is already on screen.
          if (pattern !== environment.branchPattern && validateBranchPattern(pattern).ok) {
            onCommit({ branchPattern: pattern })
          }
        }}
        className="mt-2 w-full bg-transparent font-mono text-[12px] outline-none"
      />

      <div className="mt-1 flex items-center gap-2 text-[11px]">
        {!validation.ok ? (
          <span className="text-destructive">{validation.reason}</span>
        ) : matched.length === 0 ? (
          <span className="text-muted-foreground">Matches no branches</span>
        ) : (
          <span className="text-muted-foreground">
            Matches {matched.length} {matched.length === 1 ? 'branch' : 'branches'}
          </span>
        )}

        {environment.hasSnapshot && <span className="text-muted-foreground">· snapshot ready</span>}
      </div>
    </li>
  )
}
```

The copy strings ("Matches no branches", "Matches N branches", "Delete") are what the tests match on — keep them literal.

- [ ] **Step 4: Add the entry point**

In `apps/desktop/src/components/Sidebar.tsx`, add an "Environments" affordance on a project entry that opens the panel, matching how the sidebar already opens project-scoped views. Reuse the existing screen-switching mechanism rather than adding a new routing concept.

- [ ] **Step 5: Name the environment under review**

In `apps/desktop/src/components/EnvironmentReview.tsx`, add the environment's name to the header. With several environments, "Review environment" alone does not say which one is being confirmed. Take it as a prop from whatever renders the component and render it beside the existing heading.

- [ ] **Step 6: Run the tests**

```bash
pnpm --filter @dukebox/desktop exec vitest run
pnpm exec turbo run typecheck
```

Expected: PASS.

- [ ] **Step 7: Full verification**

```bash
export DUKEBOX_DATABASE_URL='postgres://dukebox:dukebox@127.0.0.1:5433/dukebox'
export DUKEBOX_REDIS_URL='redis://127.0.0.1:6380'
pnpm exec prettier --check .
pnpm exec turbo run typecheck
pnpm exec turbo run test
```

Expected: everything passes except the container-lifecycle tests listed in `AGENTS.md`, which cannot run in the Cursor VM. Confirm each failure message mentions `domain controllers` — anything else is a real regression from this work.

- [ ] **Step 8: Commit**

```bash
pnpm exec prettier --write apps/desktop/src
git add apps/desktop/src
git commit -m "feat(desktop): environments management panel"
```

---

## Verification

On the intended Linux VPS, where cgroups are not threaded:

```bash
./docker/verify.sh
```

This is the only place the container-lifecycle tests can pass, and it is what confirms a session actually starts in its resolved environment.

Manual checks worth doing once on a real deployment:

1. A project migrated from before this change has exactly one environment, named `Default`, pattern `**`, with its previous config intact.
2. Starting a session on a branch that matches nothing runs on `dukebox/base-node:latest` with no setup commands.
3. Deleting an environment that a finished session used leaves that session in the sidebar.
