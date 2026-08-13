import { matchesBranch, validateBranchPattern, type EnvironmentSummary } from '@dukebox/protocol'
import { useEffect, useState } from 'react'
import type { DukeboxClient } from '@/lib/client'

/**
 * Managing a project's environments.
 *
 * Ordering matters here in a way it does not anywhere else: when several
 * patterns match a branch, the topmost one wins. That is why the list is
 * reorderable and why each row shows which branches its pattern actually
 * covers — a pattern that matches nothing is a mistake worth seeing before a
 * session starts rather than after.
 *
 * Plain inputs and buttons rather than the popover pickers used in New
 * Session: this is a form, and every value it holds should be readable without
 * opening anything.
 */

interface Props {
  client: DukeboxClient
  projectId: string
  disabled?: boolean
}

export function EnvironmentsPanel({ client, projectId, disabled = false }: Props) {
  const [environments, setEnvironments] = useState<EnvironmentSummary[]>([])
  const [branches, setBranches] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    client
      .listEnvironments(projectId)
      .then((found) => {
        if (!cancelled) {
          setEnvironments(found)
          setLoading(false)
        }
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setError(cause instanceof Error ? cause.message : 'Could not load environments.')
        setLoading(false)
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
    const target = index + delta
    if (target < 0 || target >= environments.length) return

    // Spliced rather than swapped by index: under noUncheckedIndexedAccess a
    // bare `next[i]` is possibly-undefined, and removing then reinserting says
    // the same thing without an assertion.
    const next = [...environments]
    const [moved] = next.splice(index, 1)
    if (!moved) return
    next.splice(target, 0, moved)

    // Optimistic: the reorder is a visual operation and waiting on a round
    // trip to redraw makes the buttons feel broken.
    setEnvironments(next)

    try {
      // The complete ordered list, once: the server rejects a partial one, and
      // sending it whole is what stops two clients producing an order neither
      // asked for.
      const saved = await client.reorderEnvironments(
        projectId,
        next.map((environment) => environment.id),
      )
      setEnvironments(saved)
      setError(null)
    } catch (cause) {
      // Put the old order back, or the list claims a move the server refused.
      setEnvironments(environments)
      setError(cause instanceof Error ? cause.message : 'Could not reorder environments.')
    }
  }

  const remove = async (id: string) => {
    try {
      await client.deleteEnvironment(id)
      setEnvironments((current) => current.filter((environment) => environment.id !== id))
      setError(null)
    } catch (cause) {
      // The row stays: one that vanishes on a failed delete reads as deleted.
      setError(cause instanceof Error ? cause.message : 'Could not delete the environment.')
    }
  }

  const create = async () => {
    // The server allows one name per project, so a plain "New environment"
    // would make a second click fail with a 409. Count the names already in
    // use and bump the default until it is free.
    const taken = new Set(environments.map((environment) => environment.name))
    let name = 'New environment'
    for (let suffix = 2; taken.has(name); suffix++) {
      name = `New environment ${suffix}`
    }

    try {
      const created = await client.createEnvironment(projectId, {
        name,
        branchPattern: '**',
      })
      setEnvironments((current) => [...current, created])
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create the environment.')
    }
  }

  return (
    <div
      className={`min-h-0 min-w-0 overflow-y-auto px-6 py-5 ${disabled ? 'pointer-events-none opacity-60' : ''}`}
      {...(disabled ? { 'aria-disabled': true } : {})}
    >
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <h2 className="text-[14px] font-medium">Environments</h2>
        <button
          type="button"
          onClick={() => void create()}
          className="flex-none rounded-[calc(var(--radius)*0.6)] bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background"
        >
          New environment
        </button>
      </div>

      <p className="mb-4 text-[12.5px] text-muted-foreground">
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
        <p role={loading ? 'status' : undefined} className="text-[12.5px] text-muted-foreground">
          {loading
            ? 'Loading environments…'
            : 'No environments yet. Sessions run on the base image.'}
        </p>
      )}

      {error && (
        <p role="alert" className="mt-3 text-[12.5px] text-destructive">
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
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [synced, setSynced] = useState({
    name: environment.name,
    branchPattern: environment.branchPattern,
  })

  // Sync during render, not in an effect. An effect runs after paint, so a
  // keystroke that landed between first paint and that effect was overwritten
  // with the saved pattern — the field snapped back and validation vanished.
  if (environment.name !== synced.name || environment.branchPattern !== synced.branchPattern) {
    setSynced({ name: environment.name, branchPattern: environment.branchPattern })
    setName(environment.name)
    setPattern(environment.branchPattern)
  }

  const validation = validateBranchPattern(pattern)
  const matched = validation.ok ? branches.filter((branch) => matchesBranch(pattern, branch)) : []

  return (
    <li className="rounded-[calc(var(--radius)*0.8)] border border-border bg-surface px-3.5 py-3">
      <div className="flex items-center gap-1">
        <input
          aria-label="Environment name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          // Committing on blur rather than per keystroke keeps a half-typed
          // name or pattern from being saved.
          onBlur={() => {
            if (name !== environment.name && name.trim() !== '') onCommit({ name })
          }}
          className="mr-1 min-w-0 flex-1 bg-transparent text-[13px] font-medium outline-none"
        />

        <button
          type="button"
          aria-label="Move up"
          disabled={isFirst}
          onClick={() => onMove(-1)}
          className="grid size-6 flex-none place-items-center rounded-[calc(var(--radius)*0.6)] text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
        >
          ↑
        </button>
        <button
          type="button"
          aria-label="Move down"
          disabled={isLast}
          onClick={() => onMove(1)}
          className="grid size-6 flex-none place-items-center rounded-[calc(var(--radius)*0.6)] text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
        >
          ↓
        </button>
        {confirmingDelete ? (
          <>
            <button
              type="button"
              aria-label={`Confirm delete ${environment.name}`}
              onClick={onDelete}
              className="flex-none rounded-[calc(var(--radius)*0.6)] px-1.5 py-1 text-[12px] text-destructive hover:bg-muted"
            >
              Delete
            </button>
            <button
              type="button"
              onClick={() => setConfirmingDelete(false)}
              className="flex-none rounded-[calc(var(--radius)*0.6)] px-1.5 py-1 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            aria-label={`Delete ${environment.name}`}
            onClick={() => setConfirmingDelete(true)}
            className="flex-none rounded-[calc(var(--radius)*0.6)] px-1.5 py-1 text-[12px] text-muted-foreground hover:bg-muted hover:text-destructive"
          >
            Delete
          </button>
        )}
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

      <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[11.5px]">
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
