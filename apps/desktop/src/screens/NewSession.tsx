import {
  matchesBranch,
  resolveEnvironment,
  type CommitIdentity,
  type EnvironmentSummary,
  type GitPreferences,
  type OpencodeProvider,
  type ProjectSummary,
  type RepositorySummary,
  type SessionSummary,
} from '@dukebox/protocol'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AVAILABLE_AGENTS,
  AVAILABLE_MODELS,
  AVAILABLE_PERMISSION_MODES,
  DEFAULT_MODEL,
  DEFAULT_PERMISSION_MODE,
  agentHasPermissionModes,
  type AvailablePermissionModeId,
} from '@/components/AgentIcon'
import { modelsForProvider } from '@/components/OpenCodeProviders'
import { SendIcon } from '@/components/icons'
import {
  AgentPicker,
  BASE_IMAGE_VALUE,
  BranchPicker,
  EnvironmentPicker,
  InstancePicker,
  ModelPicker,
  PermissionModePicker,
  ProviderPicker,
  RepoPicker,
} from '@/components/RepoBranchPickers'
import type { DukeboxClient } from '@/lib/client'
import type { Connection } from '@/lib/connection'
import type { LastNewSession } from '@/lib/settings'

/**
 * Starting a session from the centre column.
 *
 * Choices sit above the prompt: which repository, which branch to branch
 * from, which agent, which model, which environment, and which instance. A
 * repository that is not yet a project becomes one on the way through.
 *
 * Environments are offered, never required: a branch no environment covers
 * runs on the base image, with a quiet notice rather than a blocked form.
 *
 * The pickers start as they were when the last session was created, so a
 * second session does not ask the same questions again.
 */

interface Props {
  client: DukeboxClient
  connection: Connection
  projects: ProjectSummary[]
  /** Who commits are authored as; null means the server's default. */
  identity: CommitIdentity | null
  /** How this session should commit and open pull requests. */
  gitPreferences?: Partial<GitPreferences>
  onCreated: (session: SessionSummary, project: ProjectSummary | null) => void
  /** Prefer starting environment setup for this project (e.g. from sidebar). */
  preferSetupProjectId?: string | null
  /** Prefill this project without forcing setup (e.g. from the project menu). */
  preferProjectId?: string | null
  /** Restore this agent after returning from provider settings. */
  preferAgentId?: string | null
  /** The pickers as they were when the last session started. */
  lastNewSession?: LastNewSession | null
  /** Persist the pickers after a session starts, so the next form matches. */
  onRemember?: (last: LastNewSession) => void
  /** Open Settings → Agents to add or edit OpenCode providers. */
  onConfigureProviders: () => void
  /** Starting a session needs the server. */
  disabled?: boolean
}

/** Matches the search field in the pickers, so the two read as one family. */
const INPUT_CLASS =
  'mt-1 w-full rounded-[calc(var(--radius)*0.6)] border border-border-strong bg-background px-2.5 py-1.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground'

type Status =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'starting' }
  | { kind: 'failed'; message: string }

export function NewSession({
  client,
  connection,
  projects,
  identity,
  gitPreferences,
  onCreated,
  preferSetupProjectId,
  preferProjectId,
  preferAgentId,
  lastNewSession = null,
  onRemember,
  onConfigureProviders,
  disabled = false,
}: Props) {
  const preferredId = preferSetupProjectId ?? preferProjectId
  const preferred = preferredId ? projects.find((project) => project.id === preferredId) : undefined

  const initialAgent = initialAgentId(preferAgentId, lastNewSession)
  const initialRepo =
    preferred?.repoFullName ?? lastNewSession?.repoFullName ?? projects[0]?.repoFullName ?? ''
  const initialBranch =
    lastNewSession?.repoFullName === initialRepo
      ? lastNewSession.baseBranch
      : (preferred?.defaultBranch ?? projects[0]?.defaultBranch ?? '')

  const [repositories, setRepositories] = useState<RepositorySummary[]>([])
  const [target, setTarget] = useState<string>(initialRepo)
  const [baseBranch, setBaseBranch] = useState<string>(initialBranch)
  const [branches, setBranches] = useState<string[]>([])
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [environments, setEnvironments] = useState<EnvironmentSummary[]>([])
  const [environmentId, setEnvironmentId] = useState<string>(BASE_IMAGE_VALUE)
  const [agentId, setAgentId] = useState<string>(initialAgent)
  const [model, setModel] = useState<string>(initialModel(lastNewSession, initialAgent))
  const [permissionMode, setPermissionMode] = useState(initialPermissionMode(lastNewSession))
  const [opencodeProviders, setOpencodeProviders] = useState<OpencodeProvider[]>([])
  const [opencodeProvidersStatus, setOpencodeProvidersStatus] = useState<
    'loading' | 'loaded' | 'failed'
  >('loading')
  const [providerId, setProviderId] = useState(initialProviderId(lastNewSession, initialAgent))
  const [prompt, setPrompt] = useState('')
  // Coming back from provider settings with OpenCode already selected must
  // not bounce straight into settings again if the list is still empty. The
  // same applies when the last session was OpenCode: restoring that agent
  // is not a fresh pick that should yank the form away.
  const skipEmptyRedirect = useRef(initialAgent === 'opencode')
  const onConfigureProvidersRef = useRef(onConfigureProviders)
  onConfigureProvidersRef.current = onConfigureProviders
  const [forceSetup, setForceSetup] = useState(Boolean(preferSetupProjectId))
  const [newEnvironmentName, setNewEnvironmentName] = useState('Default')
  const [newEnvironmentPattern, setNewEnvironmentPattern] = useState('**')
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  const field = useRef<HTMLTextAreaElement>(null)

  // Setup is offered, not required: a branch with no environment runs on the
  // base image rather than being blocked.
  const needsEnvironment = forceSetup
  const usingBaseImage = environmentId === BASE_IMAGE_VALUE

  useEffect(() => {
    let cancelled = false

    client
      .listRepositories()
      .then((found) => {
        if (cancelled) return
        setRepositories(found)
        setTarget((current) => {
          const known = new Set([
            ...projects.map((project) => project.repoFullName),
            ...found.map((repository) => repository.fullName),
          ])
          if (current && known.has(current)) return current
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

  // Environments belong to the project, so they reload when it changes.
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

  useEffect(() => {
    const element = field.current
    if (!element) return

    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`
  }, [prompt])

  // `refact/auth` suggests `refact/*` — the family, not the one branch. A
  // branch with no slash suggests the catch-all instead.
  useEffect(() => {
    const [prefix] = baseBranch.split('/')
    setNewEnvironmentPattern(baseBranch.includes('/') ? `${prefix}/*` : '**')
  }, [baseBranch])

  // Only environments whose pattern covers the branch can apply. Position
  // orders them, so the first match is the one the server would resolve.
  const matching = environments
    .filter((environment) => matchesBranch(environment.branchPattern, baseBranch))
    .sort((left, right) => left.position - right.position)

  // Changing branch re-resolves the environment with the same rule the server
  // uses, so the picker never shows one the server would not have chosen. A
  // catch-all still matches a feature branch, so keeping the current choice
  // here would strand `Default` on a branch that has a more specific
  // environment. With no match at all this settles on the base image.
  //
  // The last session is the exception: if that repo and branch are still
  // selected, keep the environment it ran in — including an explicit base
  // image — rather than overwriting it with the auto-resolved match.
  useEffect(() => {
    const resolved = resolveEnvironment(environments, baseBranch)?.id ?? BASE_IMAGE_VALUE
    const sameContext =
      lastNewSession != null &&
      lastNewSession.repoFullName === target &&
      lastNewSession.baseBranch === baseBranch

    if (sameContext) {
      const preferredEnvironment = lastNewSession.environmentId
      if (preferredEnvironment === BASE_IMAGE_VALUE) {
        setEnvironmentId(BASE_IMAGE_VALUE)
        return
      }
      if (
        environments.some(
          (environment) =>
            environment.id === preferredEnvironment &&
            matchesBranch(environment.branchPattern, baseBranch),
        )
      ) {
        setEnvironmentId(preferredEnvironment)
        return
      }
    }

    setEnvironmentId(resolved)
  }, [baseBranch, environments, target, lastNewSession])

  useEffect(() => {
    let cancelled = false

    client
      .listOpencodeProviders()
      .then((found) => {
        if (cancelled) return
        setOpencodeProviders(found)
        setOpencodeProvidersStatus('loaded')
      })
      .catch(() => {
        // A failed list must not bounce into settings: the form stays put and
        // Start stays blocked until a model can be chosen.
        if (cancelled) return
        setOpencodeProviders([])
        setOpencodeProvidersStatus('failed')
      })

    return () => {
      cancelled = true
    }
  }, [client])

  const usingOpenCode = agentId === 'opencode'
  const selectedProvider = opencodeProviders.find((provider) => provider.id === providerId)
  const models = useMemo(
    () =>
      usingOpenCode
        ? selectedProvider
          ? modelsForProvider(selectedProvider)
          : []
        : AVAILABLE_MODELS,
    [usingOpenCode, selectedProvider],
  )

  useEffect(() => {
    if (!usingOpenCode) return
    if (opencodeProviders.some((provider) => provider.id === providerId)) return
    const first = opencodeProviders[0]?.id
    if (first) setProviderId(first)
  }, [usingOpenCode, opencodeProviders, providerId])

  useEffect(() => {
    if (models.some((candidate) => candidate.id === model)) return
    const fallback = models[0]?.id
    if (fallback) setModel(fallback)
  }, [models, model])

  useEffect(() => {
    if (!usingOpenCode || opencodeProvidersStatus !== 'loaded') return
    if (opencodeProviders.length > 0) return
    if (skipEmptyRedirect.current) return
    onConfigureProvidersRef.current()
  }, [usingOpenCode, opencodeProvidersStatus, opencodeProviders.length])

  const selectAgent = (next: string) => {
    setAgentId(next)
    if (next === 'opencode') {
      if (opencodeProvidersStatus === 'loaded' && opencodeProviders.length === 0) {
        onConfigureProviders()
        return
      }
      const firstProvider = opencodeProviders[0]
      if (firstProvider) {
        setProviderId(firstProvider.id)
        const firstModel = modelsForProvider(firstProvider)[0]?.id
        if (firstModel) setModel(firstModel)
      }
    } else {
      setProviderId('')
      setModel(DEFAULT_MODEL)
    }
  }

  const selectProvider = (next: string) => {
    setProviderId(next)
    const provider = opencodeProviders.find((candidate) => candidate.id === next)
    const first = provider ? modelsForProvider(provider)[0]?.id : undefined
    if (first) setModel(first)
  }

  const selectRepo = (fullName: string) => {
    setTarget(fullName)
    setForceSetup(false)
    const project = projects.find((candidate) => candidate.repoFullName === fullName)
    const repository = repositories.find((candidate) => candidate.fullName === fullName)
    setBaseBranch(project?.defaultBranch || repository?.defaultBranch || 'main')
  }

  const remember = (usedEnvironmentId: string) => {
    onRemember?.({
      repoFullName: target,
      baseBranch,
      environmentId: usedEnvironmentId,
      agentId,
      model,
      providerId: agentId === 'opencode' ? providerId : '',
      permissionMode,
    })
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

      if (needsEnvironment) {
        // The environment has to exist before the session starts, so the setup
        // run has somewhere to write its draft. If starting then fails, the row
        // is removed again: a retry with the same name would otherwise collide
        // with the unique (project_id, name) index and turn a transient failure
        // into a permanent one.
        const environment = await client.createEnvironment(project.id, {
          name: newEnvironmentName.trim() || 'Default',
          branchPattern: newEnvironmentPattern.trim() || '**',
        })

        let session: SessionSummary
        try {
          session = await client.startSession({
            projectId: project.id,
            agentId,
            model,
            baseBranch,
            purpose: 'environment_setup',
            environmentId: environment.id,
            ...(agentHasPermissionModes(agentId) ? { permissionMode } : {}),
            ...(identity ? { commitIdentity: identity } : {}),
            ...(gitPreferences ? { gitPreferences } : {}),
          })
        } catch (error) {
          await client.deleteEnvironment(environment.id).catch(() => {
            // Rollback is best-effort; the original failure is what to report.
          })
          throw error
        }

        remember(environment.id)
        onCreated(session, created)
        return
      }

      const session = await client.startSession({
        projectId: project.id,
        agentId,
        model,
        prompt: prompt.trim(),
        baseBranch,
        purpose: 'coding',
        ...(environmentId ? { environmentId } : {}),
        ...(agentHasPermissionModes(agentId) ? { permissionMode } : {}),
        ...(identity ? { commitIdentity: identity } : {}),
        ...(gitPreferences ? { gitPreferences } : {}),
      })

      remember(environmentId)
      onCreated(session, created)
    } catch (error) {
      setStatus({
        kind: 'failed',
        message: error instanceof Error ? error.message : 'Could not start the session.',
      })
    }
  }

  const busy = status.kind === 'starting' || status.kind === 'loading' || Boolean(disabled)
  const options = mergeOptions(projects, repositories)
  const hasModel = models.length > 0 && models.some((candidate) => candidate.id === model)

  // The server this app is paired with is the only instance it can reach, so
  // it is the whole list. Pairing with several is what makes this plural.
  const instances = [
    { id: connection.deviceId, name: connection.serverName, host: connection.address.host },
  ]

  const canSend = needsEnvironment
    ? !busy && Boolean(target) && Boolean(baseBranch) && Boolean(agentId) && hasModel
    : !busy &&
      Boolean(target) &&
      Boolean(baseBranch) &&
      Boolean(agentId) &&
      hasModel &&
      prompt.trim() !== ''

  return (
    <div className="grid h-full min-h-0 min-w-0 place-items-center px-6">
      <div className="w-full max-w-xl" aria-busy={busy}>
        {status.kind === 'loading' && (
          <p role="status" className="mb-3 text-[13px] text-muted-foreground">
            Loading repositories…
          </p>
        )}
        <div className="mb-3 flex flex-wrap items-center gap-1">
          <RepoPicker options={options} value={target} onChange={selectRepo} disabled={busy} />
          <BranchPicker
            branches={branches}
            value={baseBranch}
            onChange={setBaseBranch}
            disabled={busy || !target}
            loading={branchesLoading}
          />
          {/* A lone "base image" entry would be noise, so it stays hidden
              until the project actually has environments to choose between. */}
          {environments.length > 0 && (
            <EnvironmentPicker
              environments={matching}
              value={environmentId}
              onChange={setEnvironmentId}
              disabled={busy || !target}
            />
          )}
          <AgentPicker value={agentId} onChange={selectAgent} disabled={busy} />
          {usingOpenCode && opencodeProvidersStatus === 'loaded' && (
            <ProviderPicker
              providers={opencodeProviders}
              value={providerId}
              onChange={selectProvider}
              onAddProvider={onConfigureProviders}
              disabled={busy}
            />
          )}
          {!(usingOpenCode && models.length === 0) && (
            <ModelPicker value={model} onChange={setModel} disabled={busy} models={models} />
          )}
          {agentHasPermissionModes(agentId) && (
            <PermissionModePicker
              value={permissionMode}
              onChange={setPermissionMode}
              disabled={busy}
            />
          )}
          <InstancePicker instances={instances} value={connection.deviceId} disabled={busy} />
        </div>

        {needsEnvironment ? (
          <div className="rounded-[calc(var(--radius)*1.1)] border border-border bg-surface px-3.5 py-3.5">
            <h2 className="text-[14px] font-medium">Configure environment</h2>
            <p className="mt-1 text-[13px] text-muted-foreground">
              {agentId} will inspect the repository and propose setup commands and environment
              variables. You review and save them, and branches this environment covers use them
              from then on.
            </p>
            <label className="mt-3 block text-[12px] text-muted-foreground">
              Name
              <input
                value={newEnvironmentName}
                onChange={(event) => setNewEnvironmentName(event.target.value)}
                disabled={busy}
                className={INPUT_CLASS}
              />
            </label>
            <label className="mt-2 block text-[12px] text-muted-foreground">
              Branches
              <input
                value={newEnvironmentPattern}
                onChange={(event) => setNewEnvironmentPattern(event.target.value)}
                aria-describedby="pattern-help"
                disabled={busy}
                className={INPUT_CLASS}
              />
            </label>
            <p id="pattern-help" className="mt-1 text-[11px] text-muted-foreground">
              Glob like <code>refact/*</code> or <code>**</code> for every branch. Prefix with{' '}
              <code>re:</code> for a regular expression.
            </p>

            <div className="mt-3 flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => setForceSetup(false)}
                disabled={busy}
                className="text-[12px] text-muted-foreground underline-offset-2 hover:underline disabled:opacity-40"
              >
                Back
              </button>
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
              placeholder={disabled ? 'Waiting for connection…' : 'Ask for a change…'}
              aria-label="What should it do?"
              className="block w-full resize-none bg-transparent px-3.5 pt-3.5 pb-2 outline-none placeholder:text-muted-foreground disabled:opacity-50"
            />

            <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5">
              {!usingBaseImage ? (
                <button
                  type="button"
                  onClick={() => setForceSetup(true)}
                  disabled={busy}
                  className="text-[12px] text-muted-foreground underline-offset-2 hover:underline disabled:opacity-40"
                >
                  Reconfigure environment
                </button>
              ) : (
                <span />
              )}
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
                  <SendIcon size={16} />
                )}
              </button>
            </div>
          </div>
        )}

        {!needsEnvironment && usingBaseImage && (
          <p className="mt-2 text-[12px] text-muted-foreground">
            No environment for this branch — the base image will be used.{' '}
            <button
              type="button"
              onClick={() => setForceSetup(true)}
              disabled={busy}
              className="underline underline-offset-2 disabled:opacity-40"
            >
              Configure environment
            </button>
          </p>
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

function initialAgentId(
  preferAgentId: string | null | undefined,
  last: LastNewSession | null,
): string {
  if (preferAgentId && AVAILABLE_AGENTS.some((agent) => agent.id === preferAgentId)) {
    return preferAgentId
  }
  if (last?.agentId && AVAILABLE_AGENTS.some((agent) => agent.id === last.agentId)) {
    return last.agentId
  }
  return AVAILABLE_AGENTS[0].id
}

function initialModel(last: LastNewSession | null, agentId: string): string {
  if (!last?.model) return agentId === 'opencode' ? '' : DEFAULT_MODEL
  if (agentId === 'opencode') return last.model
  if (AVAILABLE_MODELS.some((candidate) => candidate.id === last.model)) return last.model
  return DEFAULT_MODEL
}

function initialProviderId(last: LastNewSession | null, agentId: string): string {
  if (agentId !== 'opencode' || !last) return ''
  if (last.providerId) return last.providerId
  const slash = last.model.indexOf('/')
  return slash === -1 ? '' : last.model.slice(0, slash)
}

function initialPermissionMode(last: LastNewSession | null): AvailablePermissionModeId {
  return (
    AVAILABLE_PERMISSION_MODES.find((mode) => mode.id === last?.permissionMode)?.id ??
    DEFAULT_PERMISSION_MODE
  )
}
