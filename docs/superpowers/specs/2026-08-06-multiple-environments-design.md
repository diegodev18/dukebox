# Multiple environments per project, selected by branch

## Summary

A project gains many environments instead of one. Each carries its own setup
commands, environment variables, image, and snapshot, plus a **branch pattern**
deciding which branches it is available for — `**` for every branch,
`refact/*` for one family, `re:^(feat|fix)/` when a glob is not enough.

New Session shows only the environments matching the chosen base branch and
preselects the first one. When nothing matches, the session runs on the base
image with no override — it is never blocked.

Today the model is one environment per project: `projects.configOverride`,
`projects.snapshotImage`, and `projects.environmentDraft`. Those three columns
move to a new `environments` table.

## Motivation

One environment per repository forces every branch through the same setup. A
refactor branch needing an extra toolchain, a docs branch needing no `pnpm
install` at all, and a feature branch on a different base image all share one
configuration, so it ends up being the union of everything — slow to build for
every session and wrong for most of them.

Branch names already encode this intent. `refact/*` and `docs/*` are how the
work is grouped, so they are the natural key for which environment applies.

## Design decisions

Six decisions shape everything below.

**Patterns filter availability; they do not merely hint.** An environment whose
pattern does not match the branch is not offered and cannot be picked. The
alternative — showing every environment and warning about mismatches — invites
starting a container with setup commands written for a different kind of work.

**Glob by default, regex behind a `re:` prefix.** Branch names are paths, and
glob is the syntax people already use for them in gitignore and in GitHub branch
protection. Regex stays reachable for the cases glob cannot express, but a
mistyped regex silently matches the wrong set, so it is opt-in rather than the
default reading of the field.

**Explicit order breaks ties, not specificity.** When several environments match,
the one with the lowest `position` wins. Glob specificity is not well defined —
between `feat/*` and `*/auth` neither is obviously narrower — and mixing regex
in makes it undecidable. An ordered list is predictable and visible in the UI.

**No match means base image, never a blocked session.** A branch no pattern
covers still starts a session: default config, no override, no snapshot. Making
this a hard error would turn a missing configuration into a wall in front of the
most common action in the app.

**The resolved environment is persisted on the session.** Resolution happens once,
at creation. A session resumed weeks later uses the environment it started with,
even if patterns changed or the list was reordered — re-resolving on resume would
let a running container change images mid-life.

**Environment setup becomes optional, not obsolete.** The setup agent stays the
comfortable way to build an environment, offered inline when a branch has none,
with the pattern prefilled from the current branch. It no longer gates coding
sessions.

## Data model

New table, `environments`:

| column              | type        | notes                                |
| ------------------- | ----------- | ------------------------------------ |
| `id`                | uuid pk     |                                      |
| `project_id`        | uuid        | → `projects.id`, `on delete cascade` |
| `name`              | text        | "Default", "Refactors"               |
| `branch_pattern`    | text        | `**`, `refact/*`, `re:^(feat\|fix)/` |
| `position`          | integer     | tie-break; lower wins                |
| `config_override`   | jsonb       | moved from `projects`                |
| `snapshot_image`    | text        | moved from `projects`                |
| `environment_draft` | jsonb       | moved from `projects`                |
| `created_at`        | timestamptz |                                      |
| `updated_at`        | timestamptz |                                      |

Indexes:

- `environments_project_id_position_idx` on `(project_id, position)` — exactly
  the picker's query: every environment of one project, in order.
- `uniqueIndex(project_id, name)` — two environments of one project sharing a
  name would make the picker unreadable.

`sessions` gains `environment_id uuid` referencing `environments.id` with
`on delete set null`. Nullable because "no environment, base image" is a
legitimate state, and `set null` because deleting an environment must not delete
the history of sessions that ran on it.

`snapshot_image` is currently declared but never written and never read when
starting a container — only reported as `hasSnapshot`. Moving it costs nothing
today and puts it where it belongs once snapshots are built, since different
setup commands produce different images.

### Migration

One migration, `0005_environments.sql`, in a single step:

1. Create `environments`.
2. Insert one row per project where `config_override is not null`:
   `name = 'Default'`, `branch_pattern = '**'`, `position = 0`, copying
   `config_override`, `snapshot_image`, and `environment_draft`.
3. Add `sessions.environment_id`.
4. Drop the three columns from `projects`.

The migrated pattern is `**`, not `*`: under the glob semantics below `*` stops
at `/`, so `*` would silently stop matching branches like `refact/auth` that
work today.

Projects with no `config_override` produce no row and fall through to the base
image, which matches the intended no-match behaviour.

Dropping the columns in the same migration makes the deploy irreversible without
restoring a backup. This is accepted: the copy happens in the same statement, and
this is a single-operator self-hosted deployment. The two-phase alternative —
leave the columns dead, drop them later — is available if the operator prefers it.

## Branch pattern matching

New module `packages/protocol/src/branchPattern.ts`, in protocol because the
server resolves with it and the app previews with it. One implementation, no
drift between the two.

```ts
export function matchesBranch(pattern: string, branch: string): boolean
export function validateBranchPattern(pattern: string): { ok: true } | { ok: false; reason: string }
```

**Glob** is the default reading. The pattern is translated to a regex by escaping
every regex metacharacter, then mapping the wildcards:

| wildcard | matches                              |
| -------- | ------------------------------------ |
| `*`      | any run of characters except `/`     |
| `**`     | any run of characters, including `/` |
| `?`      | exactly one character                |

So `refact/*` matches `refact/auth` but not `refact/auth/deep`; `refact/**`
matches both. `*` alone matches `main` but not `refact/auth` — the real catch-all
is `**`.

**Regex** is the `re:` prefix. The remainder is compiled with the user's own
anchoring respected, and anchored only where they left it open:

- A pattern that starts with `^` keeps its own start anchor; otherwise `^` is
  added.
- A pattern that ends with `$` keeps its own end anchor; otherwise `$` is added
  **unless** the pattern already anchored its start, in which case the tail is
  left free.

The two halves of that rule answer two different mistakes. Anchoring an
unanchored pattern is what stops `re:main` from matching `feat/maintenance` or
`main-old` — substring matching on a branch filter surprises everyone. Leaving
the tail free on a deliberately start-anchored pattern is what makes
`re:^(feat|fix)/` match `feat/auth`, which is the obvious reading of a pattern
someone wrote to mean "branches under feat/ or fix/".

### Guards

The pattern is user-written and evaluated server-side, so `validateBranchPattern`
enforces:

- Maximum length of 200 characters.
- Rejection of nested quantifiers (`(a+)+`, `(a*)*`) by inspecting the source, as
  catastrophic-backtracking bait.
- Compilation without the `g` flag. A global regex carries `lastIndex` between
  calls and produces intermittent false negatives on repeated matching.

Validation runs in the write endpoints, not only in the UI. The app is not the
gatekeeper.

An invalid regex never matches and never throws: a broken pattern drops its
environment out of the picker rather than breaking session start.

### Resolution

```ts
export function resolveEnvironment(environments: Environment[], branch: string): Environment | null
```

Sorts by `position`, returns the first match, or `null`. Pure — testable without
a database.

## Server

### Config resolution

`configFor()` changes signature. It is `configFor(projectId)` today, reading
`projects.configOverride` (`apps/server/src/sessions/manager.ts:422`). It becomes
`configFor(environmentId | null)`:

- `null` returns `defaultProjectConfig()` without touching the database — the
  base-image case.
- An id reads that row and performs the same merge as today.

Branch → environment resolution does **not** happen here. It happens once at
session creation and is persisted on `sessions.environment_id`.

### Session creation

`POST /api/sessions` accepts an optional `environmentId`.

- When supplied, the server verifies it belongs to the session's project.
  Without that check, an id from another project would inject its config and its
  secrets into this one. Mismatch responds 403.
- When absent, the server resolves by branch with `resolveEnvironment`.

The client proposes; the server decides. The API keeps working for clients that
know nothing about environments.

### New endpoints

In `apps/server/src/http/environments.ts`:

```
GET    /api/projects/:id/environments
POST   /api/projects/:id/environments          { name, branchPattern }
PATCH  /api/environments/:id                   { name?, branchPattern? }
DELETE /api/environments/:id
POST   /api/projects/:id/environments/reorder  { ids: [...] }
```

`reorder` takes the complete list of ids and rewrites `position` in a
transaction. Sending the whole list rather than "move X to slot 3" prevents two
concurrent clients from producing an order neither asked for.

`PATCH` validates the pattern and responds 400 with the reason. `DELETE` leaves
historical sessions intact via `set null`.

### Existing endpoints that change

- The proposal confirm in `apps/server/src/http/projects.ts:266` writes
  `configOverride` on the project today. It now writes to the environment the
  session belongs to (`sessions.environmentId`).
- `hasEnvironment` on `ProjectSummary` (`projects.ts:87`,
  `packages/protocol/src/api.ts:49`) is meaningless as a per-project boolean and
  is replaced by `environmentCount`, which is what the sidebar actually needs.

### Setup sessions

Starting environment setup from New Session creates the `environments` row first,
with the name and pattern the user supplied, and the session is born with that
`environmentId`. The draft and the confirm have a destination from the start,
with no intermediate orphan-proposal state.

Abandoning setup leaves an environment with no `configOverride`. It behaves as
the base image and can be deleted from the panel.

## UI

### Environment picker in New Session

An `EnvironmentPicker` joins the existing row of pickers in
`apps/desktop/src/screens/NewSession.tsx`, placed after `BranchPicker` — the
order reads as the real dependency: repo → branch → environment.

It lists only environments matching the chosen branch, in `position` order, plus
a fixed final entry **"No environment (base image)"**. The first match is
preselected; when nothing matches, the base-image entry is.

Changing branch recomputes the selection: a still-matching environment is kept,
otherwise the first valid one is selected. Without that rule, switching branches
would leave a no-longer-applicable environment selected.

The picker is hidden when the project has no environments at all — a dropdown
with one option is noise. It reappears as soon as one exists.

### Base-image notice

When the effective selection is "no environment", a quiet line sits under the
pickers: _"No environment for this branch — the base image will be used"_, with a
**Configure environment** button.

The button opens a small inline form — name plus pattern, prefilled from the
current branch (`refact/auth` → `refact/*`, editable) — and starts the setup
session with the environment already created. The prefill is what makes creating
an environment for a family of branches a gesture rather than a form.

### Environments panel

New `EnvironmentsPanel.tsx`, opened from the project's sidebar entry. A
drag-reorderable list; each row has an editable name, an editable pattern, a
snapshot indicator, and delete.

Under the pattern field, while typing, the panel shows which of the project's
branches match — reusing `matchesBranch` against the branch list already fetched
from GitHub. A pattern matching nothing is visible immediately instead of being
discovered when a session starts.

Validation errors come from the server and render under the field. The app
validates locally too, for immediate feedback, but the server decides.

### Existing components

- `EnvironmentReview` is not redesigned. It stays in the Workspace tab; the
  confirm writes to the session's environment. Its header gains the environment
  name, since with several it matters which one is being confirmed.
- `Sidebar.tsx:204` switches from `!project.hasEnvironment` to
  `environmentCount === 0`.
- `preview.tsx` needs environment data in its scripted session — per `AGENTS.md`
  it is the way to exercise this without a server.

## Testing

**`branchPattern.test.ts`** carries the weight:

- `*` matches `main`, not `refact/auth`; `**` matches both.
- `refact/*` matches `refact/auth`, not `refact/auth/deep`.
- `re:^(feat|fix)/` matches `feat/x`, not `chore/x`.
- Implicit anchoring: `re:main` does not match `feat/maintenance`.
- An invalid regex returns `false` without throwing.
- A pattern over 200 characters is rejected.
- A nested quantifier is rejected.
- Repeated calls with the same pattern return the same result — the proof that no
  `lastIndex` is carried between calls.

**`resolveEnvironment`**: lowest `position` wins among several matches; `null`
when none match; `null` for an empty list.

**Server**, integration against real Postgres alongside `routes.test.ts`:

- Creating a session without `environmentId` resolves by branch.
- An `environmentId` from another project responds 403 — an explicit test, not an
  implicit consequence.
- Reorder rewrites `position` transactionally.
- Deleting an environment leaves the session with a null `environmentId` and does
  not delete it.
- `PATCH` with an invalid pattern responds 400 with a reason.

**Migration**: a project with `configOverride` produces exactly one `Default` /
`**` environment with the config copied; a project without one produces none.

Container-creating tests do not run in the Cursor VM because of the cgroups
limitation documented in `AGENTS.md`; they are validated on the VPS with
`./docker/verify.sh`. Environment resolution itself needs no container, which is
what makes the new logic testable there.

## Error handling

| Situation                                   | Behaviour                                   |
| ------------------------------------------- | ------------------------------------------- |
| Invalid pattern on write                    | 400 with reason, shown under the field      |
| `environmentId` from another project        | 403                                         |
| Environment deleted between render and send | Server re-resolves by branch                |
| Regex fails to compile                      | That environment never matches; others work |

None of these blocks starting a session. The worst case always degrades to the
base image.

## Out of scope

- Config inheritance between environments.
- Environments shared across projects.
- Patterns over anything other than the branch name.
