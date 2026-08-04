import type { ProjectSummary, RepositorySummary, SessionSummary } from '@dukebox/protocol'
import { useEffect, useState } from 'react'
import type { DukeboxClient } from '../lib/client.js'

/**
 * Starting a session.
 *
 * Two things are needed: which repository, and what to do first. Everything
 * else — the branch, the agent, the container — has a default worth keeping,
 * and asking about them here would turn one decision into five.
 *
 * A repository that is not yet a project becomes one on the way through. That
 * distinction matters to the server and to nobody else.
 */

interface Props {
  client: DukeboxClient
  projects: ProjectSummary[]
  onCreated: (session: SessionSummary, project: ProjectSummary | null) => void
  onCancel: () => void
}

type Status =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'starting' }
  | { kind: 'failed'; message: string }

export function NewSession({ client, projects, onCreated, onCancel }: Props) {
  const [repositories, setRepositories] = useState<RepositorySummary[]>([])
  const [target, setTarget] = useState<string>(projects[0]?.repoFullName ?? '')
  const [prompt, setPrompt] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false

    client
      .listRepositories()
      .then((found) => {
        if (cancelled) return
        setRepositories(found)
        setTarget((current) => current || found[0]?.fullName || '')
        setStatus({ kind: 'idle' })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        // Listing repositories needs GitHub configured on the server. Saying so
        // beats an empty menu that looks like the account has no repositories.
        setStatus({
          kind: 'failed',
          message:
            error instanceof Error
              ? `Could not list your repositories: ${error.message}`
              : 'Could not list your repositories.',
        })
      })

    return () => {
      cancelled = true
    }
  }, [client])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!target || !prompt.trim()) return

    setStatus({ kind: 'starting' })

    try {
      // The project may not exist yet. Creating it here keeps the choice about
      // a repository rather than about a concept the server invented.
      let project = projects.find((candidate) => candidate.repoFullName === target) ?? null
      let created: ProjectSummary | null = null

      if (!project) {
        project = created = await client.createProject(target)
      }

      const session = await client.startSession({
        projectId: project.id,
        agentId: 'claude-code',
        prompt: prompt.trim(),
      })

      onCreated(session, created)
    } catch (error) {
      setStatus({
        kind: 'failed',
        message: error instanceof Error ? error.message : 'Could not start the session.',
      })
    }
  }

  const busy = status.kind === 'starting' || status.kind === 'loading'
  const options = mergeOptions(projects, repositories)

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="New session"
      className="fixed inset-0 z-50 grid place-items-center bg-background/70 px-6"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <form
        onSubmit={submit}
        className="w-full max-w-lg rounded-[var(--radius)] border border-border-strong bg-surface p-5"
      >
        <h2 className="font-medium">New session</h2>
        <p className="mt-1 text-[13px] text-muted-foreground">
          It runs on your server, in its own container, on a branch of its own.
        </p>

        <label htmlFor="repository" className="mt-5 block text-[13px] font-medium">
          Repository
        </label>
        <select
          id="repository"
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          disabled={busy || options.length === 0}
          className="mt-1.5 w-full rounded-[calc(var(--radius)*0.7)] border border-border-strong bg-background px-2.5 py-2 text-[13px] disabled:opacity-60"
        >
          {options.length === 0 && <option value="">No repositories found</option>}
          {options.map((option) => (
            <option key={option.fullName} value={option.fullName}>
              {option.fullName}
              {option.isRegistered ? '' : ' — new'}
            </option>
          ))}
        </select>

        <label htmlFor="prompt" className="mt-4 block text-[13px] font-medium">
          What should it do?
        </label>
        <textarea
          id="prompt"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            // Enter submits, as it does in the composer. A form whose two
            // fields behave differently is a form people learn twice.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void submit(event)
            }
          }}
          rows={3}
          disabled={busy}
          placeholder="Add a health check endpoint and a test for it"
          className="mt-1.5 w-full resize-none rounded-[calc(var(--radius)*0.7)] border border-border-strong bg-background px-2.5 py-2 text-[13px] outline-none placeholder:text-muted-foreground disabled:opacity-60"
        />

        {status.kind === 'failed' && (
          <p role="alert" className="mt-3 text-[13px] text-destructive">
            {status.message}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-[calc(var(--radius)*0.6)] border border-border px-3 py-1.5 text-[12.5px] font-medium hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !target || prompt.trim() === ''}
            className="rounded-[calc(var(--radius)*0.6)] bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background disabled:opacity-40"
          >
            {status.kind === 'starting' ? 'Starting…' : 'Start'}
          </button>
        </div>
      </form>
    </div>
  )
}

/**
 * Projects first, then everything else on GitHub.
 *
 * A repository already connected is the likely choice, and burying it in an
 * alphabetical list of every repository the account can see makes the common
 * case the hardest one.
 */
function mergeOptions(
  projects: ProjectSummary[],
  repositories: RepositorySummary[],
): { fullName: string; isRegistered: boolean }[] {
  const registered = projects.map((project) => ({
    fullName: project.repoFullName,
    isRegistered: true,
  }))

  const known = new Set(registered.map((option) => option.fullName))
  const rest = repositories
    .filter((repository) => !known.has(repository.fullName))
    // The server's own flag decides, not the absence of a project locally: the
    // project list can be a moment behind, and labelling a connected
    // repository "new" would promise to create something that already exists.
    .map((repository) => ({
      fullName: repository.fullName,
      isRegistered: repository.isRegistered,
    }))

  return [...registered, ...rest]
}
