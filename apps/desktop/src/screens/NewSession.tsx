import type { ProjectSummary, RepositorySummary, SessionSummary } from '@dukebox/protocol'
import { useEffect, useRef, useState } from 'react'
import { BranchPicker, RepoPicker } from '../components/RepoBranchPickers.js'
import type { DukeboxClient } from '../lib/client.js'

/**
 * Starting a session from the centre column.
 *
 * Two choices sit above the prompt: which repository, and which branch to
 * branch from. Everything else — the agent, the container — keeps its default.
 * A repository that is not yet a project becomes one on the way through.
 */

interface Props {
  client: DukeboxClient
  projects: ProjectSummary[]
  onCreated: (session: SessionSummary, project: ProjectSummary | null) => void
}

type Status =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'starting' }
  | { kind: 'failed'; message: string }

export function NewSession({ client, projects, onCreated }: Props) {
  const [repositories, setRepositories] = useState<RepositorySummary[]>([])
  const [target, setTarget] = useState<string>(projects[0]?.repoFullName ?? '')
  const [baseBranch, setBaseBranch] = useState<string>(projects[0]?.defaultBranch ?? '')
  const [branches, setBranches] = useState<string[]>([])
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  const field = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    let cancelled = false

    client
      .listRepositories()
      .then((found) => {
        if (cancelled) return
        setRepositories(found)
        setTarget((current) => {
          if (current) return current
          return projects[0]?.repoFullName || found[0]?.fullName || ''
        })
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
  }, [client, projects])

  // Resolve the branch list whenever the chosen repository changes. A project
  // can ask GitHub for every branch; a bare repository only has its default.
  useEffect(() => {
    if (!target) {
      setBranches([])
      setBaseBranch('')
      return
    }

    const project = projects.find((candidate) => candidate.repoFullName === target)
    const repository = repositories.find((candidate) => candidate.fullName === target)
    const fallback = project?.defaultBranch || repository?.defaultBranch || 'main'

    let cancelled = false

    if (!project) {
      setBranches([fallback])
      setBaseBranch(fallback)
      setBranchesLoading(false)
      return
    }

    setBranchesLoading(true)
    client
      .listBranches(project.id)
      .then((found) => {
        if (cancelled) return
        setBranches(found.length > 0 ? found : [fallback])
        setBaseBranch((current) => (found.includes(current) ? current : found[0] || fallback))
        setBranchesLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        // Branch listing is best-effort: the default is enough to start, and a
        // hard failure here would block the whole form for a secondary choice.
        setBranches([fallback])
        setBaseBranch(fallback)
        setBranchesLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [client, target, projects, repositories])

  useEffect(() => {
    const element = field.current
    if (!element) return

    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`
  }, [prompt])

  const selectRepo = (fullName: string) => {
    setTarget(fullName)
    const project = projects.find((candidate) => candidate.repoFullName === fullName)
    const repository = repositories.find((candidate) => candidate.fullName === fullName)
    setBaseBranch(project?.defaultBranch || repository?.defaultBranch || 'main')
  }

  const submit = async () => {
    if (!target || !prompt.trim() || !baseBranch) return

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
        baseBranch,
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
  const canSend = !busy && Boolean(target) && Boolean(baseBranch) && prompt.trim() !== ''

  return (
    <div className="grid h-full min-h-0 min-w-0 place-items-center px-6">
      <div className="w-full max-w-xl">
        <div className="mb-3 flex flex-wrap items-center gap-1">
          <RepoPicker options={options} value={target} onChange={selectRepo} disabled={busy} />
          <BranchPicker
            branches={branches}
            value={baseBranch}
            onChange={setBaseBranch}
            disabled={busy || !target}
            loading={branchesLoading}
          />
        </div>

        <div className="rounded-[calc(var(--radius)*1.1)] border border-border bg-surface focus-within:border-muted-foreground/40">
          <textarea
            ref={field}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void submit()
              }
            }}
            rows={3}
            disabled={busy}
            placeholder="Ask for a change…"
            aria-label="What should it do?"
            className="block w-full resize-none bg-transparent px-3.5 pt-3.5 pb-2 outline-none placeholder:text-muted-foreground disabled:opacity-50"
          />

          <div className="flex items-center justify-end gap-2 px-2.5 pb-2.5">
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!canSend}
              aria-label={status.kind === 'starting' ? 'Starting' : 'Start session'}
              className="inline-flex size-8 items-center justify-center rounded-full bg-foreground text-background disabled:opacity-40"
            >
              {status.kind === 'starting' ? (
                <span className="text-[11px] font-medium">…</span>
              ) : (
                <SendIcon />
              )}
            </button>
          </div>
        </div>

        {status.kind === 'failed' && (
          <p role="alert" className="mt-3 text-[13px] text-destructive">
            {status.message}
          </p>
        )}
      </div>
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

function SendIcon() {
  return (
    <svg
      className="size-4"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 12.5V3.5M4.5 7 8 3.5 11.5 7" />
    </svg>
  )
}
