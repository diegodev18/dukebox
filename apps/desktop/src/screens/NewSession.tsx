import type { ProjectSummary, RepositorySummary, SessionSummary } from '@dukebox/protocol'
import { useEffect, useRef, useState } from 'react'
import { AVAILABLE_AGENTS } from '../components/AgentIcon.js'
import {
  AgentPicker,
  BranchPicker,
  InstancePicker,
  RepoPicker,
} from '../components/RepoBranchPickers.js'
import type { DukeboxClient } from '../lib/client.js'
import type { Connection } from '../lib/connection.js'

/**
 * Starting a session from the centre column.
 *
 * Three choices sit above the prompt: which repository, which branch to
 * branch from, and which agent. A repository that is not yet a project
 * becomes one on the way through.
 *
 * Projects without a saved environment are steered into an environment_setup
 * session first; coding sessions only start once setup/env exist.
 */

interface Props {
  client: DukeboxClient
  connection: Connection
  projects: ProjectSummary[]
  onCreated: (session: SessionSummary, project: ProjectSummary | null) => void
  /** Prefer starting environment setup for this project (e.g. from sidebar). */
  preferSetupProjectId?: string | null
}

type Status =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'starting' }
  | { kind: 'failed'; message: string }

export function NewSession({
  client,
  connection,
  projects,
  onCreated,
  preferSetupProjectId,
}: Props) {
  const preferred = preferSetupProjectId
    ? projects.find((project) => project.id === preferSetupProjectId)
    : undefined

  const [repositories, setRepositories] = useState<RepositorySummary[]>([])
  const [target, setTarget] = useState<string>(
    preferred?.repoFullName ?? projects[0]?.repoFullName ?? '',
  )
  const [baseBranch, setBaseBranch] = useState<string>(
    preferred?.defaultBranch ?? projects[0]?.defaultBranch ?? '',
  )
  const [branches, setBranches] = useState<string[]>([])
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [agentId, setAgentId] = useState<string>(AVAILABLE_AGENTS[0].id)
  const [prompt, setPrompt] = useState('')
  const [forceSetup, setForceSetup] = useState(Boolean(preferSetupProjectId))
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  const field = useRef<HTMLTextAreaElement>(null)

  const selectedProject = projects.find((candidate) => candidate.repoFullName === target) ?? null
  const needsEnvironment = forceSetup || !selectedProject || !selectedProject.hasEnvironment

  useEffect(() => {
    let cancelled = false

    client
      .listRepositories()
      .then((found) => {
        if (cancelled) return
        setRepositories(found)
        setTarget((current) => {
          if (current) return current
          return preferred?.repoFullName || projects[0]?.repoFullName || found[0]?.fullName || ''
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
  }, [client, projects, preferred?.repoFullName])

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
    setForceSetup(false)
    const project = projects.find((candidate) => candidate.repoFullName === fullName)
    const repository = repositories.find((candidate) => candidate.fullName === fullName)
    setBaseBranch(project?.defaultBranch || repository?.defaultBranch || 'main')
  }

  const submit = async () => {
    if (!target || !baseBranch || !agentId) return
    if (!needsEnvironment && !prompt.trim()) return

    setStatus({ kind: 'starting' })

    try {
      // The project may not exist yet. Creating it here keeps the choice about
      // a repository rather than about a concept the server invented.
      let project = projects.find((candidate) => candidate.repoFullName === target) ?? null
      let created: ProjectSummary | null = null

      if (!project) {
        project = created = await client.createProject(target)
      }

      if (needsEnvironment || !project.hasEnvironment) {
        const session = await client.startSession({
          projectId: project.id,
          agentId,
          baseBranch,
          purpose: 'environment_setup',
        })
        onCreated(session, created)
        return
      }

      const session = await client.startSession({
        projectId: project.id,
        agentId,
        prompt: prompt.trim(),
        baseBranch,
        purpose: 'coding',
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

  // The server this app is paired with is the only instance it can reach, so
  // it is the whole list. Pairing with several is what makes this plural.
  const instances = [
    { id: connection.deviceId, name: connection.serverName, host: connection.address.host },
  ]

  const canSend = needsEnvironment
    ? !busy && Boolean(target) && Boolean(baseBranch) && Boolean(agentId)
    : !busy && Boolean(target) && Boolean(baseBranch) && Boolean(agentId) && prompt.trim() !== ''

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
          <AgentPicker value={agentId} onChange={setAgentId} disabled={busy} />
          <InstancePicker instances={instances} value={connection.deviceId} disabled={busy} />
        </div>

        {needsEnvironment ? (
          <div className="rounded-[calc(var(--radius)*1.1)] border border-border bg-surface px-3.5 py-3.5">
            <h2 className="text-[14px] font-medium">Configure environment</h2>
            <p className="mt-1 text-[13px] text-muted-foreground">
              {agentId} will inspect the repository and propose setup commands and environment
              variables. You review and save them before coding sessions can start.
            </p>
            <div className="mt-3 flex justify-end">
              <button
                type="button"
                onClick={() => void submit()}
                disabled={!canSend}
                className="rounded-full bg-foreground px-3.5 py-1.5 text-[13px] font-medium text-background disabled:opacity-40"
              >
                {status.kind === 'starting' ? 'Starting…' : 'Start setup'}
              </button>
            </div>
          </div>
        ) : (
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

            <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5">
              <button
                type="button"
                onClick={() => setForceSetup(true)}
                className="text-[12px] text-muted-foreground underline-offset-2 hover:underline"
              >
                Reconfigure environment
              </button>
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
        )}

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
