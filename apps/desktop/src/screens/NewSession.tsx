import {
  matchesBranch,
  resolveEnvironment,
  resolvePermissionMode,
  type CommitIdentity,
  type DeviceRole,
  type EnvironmentSummary,
  type GitPreferences,
  type OpencodeProvider,
  type ProjectSummary,
  type RepositorySummary,
  type SessionSummary,
} from '@dukebox/protocol'
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import {
  AVAILABLE_AGENTS,
  AVAILABLE_MODELS,
  AVAILABLE_PERMISSION_MODES,
  DEFAULT_GROK_BUILD_MODEL,
  DEFAULT_MODEL,
  DEFAULT_PERMISSION_MODE,
  GROK_BUILD_MODELS,
  agentHasPermissionModes,
  availablePermissionModes,
  cyclePermissionMode,
  type AvailablePermissionModeId,
} from '@/components/AgentIcon'
import { AttachmentChips } from '@/components/AttachmentChips'
import { readPickedFiles, type ComposerFile } from '@/components/Composer'
import { modelsForProvider } from '@/components/OpenCodeProviders'
import { AttachIcon } from '@/components/icons'
import { filesFromPaste, useFileDrop } from '@/lib/useFileDrop'
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
import {
  clearNewSessionDraft,
  loadNewSessionDraft,
  saveNewSessionDraft,
} from '@/lib/newSessionDraft'
import type { LastNewSession } from '@/lib/settings'

/**
 * Starting a session from the centre column.
 *
 * Session-fixed choices sit above the prompt: which repository, which branch
 * to branch from, which environment, which agent, and which instance. A
 * repository that is not yet a project becomes one on the way through.
 *
 * Choices that can change during a session sit inside the prompt, the same
 * place the composer keeps them: model, permission mode, and OpenCode's
 * provider.
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
  /**
   * Re-run setup for this existing environment. Unlike preferSetupProjectId,
   * this must not create a sibling row.
   */
  preferSetupEnvironmentId?: string | null
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
  /**
   * Who is paired. Members cannot open Settings → Agents, so a missing-agent
   * state must not offer a button that no-ops.
   */
  role?: DeviceRole | null
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
  preferSetupEnvironmentId,
  preferProjectId,
  preferAgentId,
  lastNewSession = null,
  onRemember,
  onConfigureProviders,
  role = null,
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
  const [environmentId, setEnvironmentId] = useState<string>(
    preferSetupEnvironmentId ?? BASE_IMAGE_VALUE,
  )
  // Local so Back or a repo change can drop the re-run without the prop
  // staying sticky and sending that id after the person has left the card.
  const [reuseEnvironmentId, setReuseEnvironmentId] = useState<string | null>(
    preferSetupEnvironmentId ?? null,
  )
  const [agentId, setAgentId] = useState<string>(initialAgent)
  const [model, setModel] = useState<string>(initialModel(lastNewSession, initialAgent))
  const [permissionMode, setPermissionMode] = useState(initialPermissionMode(lastNewSession))
  const [opencodeProviders, setOpencodeProviders] = useState<OpencodeProvider[]>([])
  const [opencodeProvidersStatus, setOpencodeProvidersStatus] = useState<
    'loading' | 'loaded' | 'failed'
  >('loading')
  const [claudeConfigured, setClaudeConfigured] = useState(false)
  const [grokConfigured, setGrokConfigured] = useState(false)
  const [agentsStatus, setAgentsStatus] = useState<'loading' | 'loaded' | 'failed'>('loading')
  const [agentsReload, setAgentsReload] = useState(0)
  const [providerId, setProviderId] = useState(initialProviderId(lastNewSession, initialAgent))
  const [prompt, setPrompt] = useState(loadNewSessionDraft)
  const [files, setFiles] = useState<ComposerFile[]>([])
  const [attachError, setAttachError] = useState<string | null>(null)
  const [forceSetup, setForceSetup] = useState(
    Boolean(preferSetupProjectId || preferSetupEnvironmentId),
  )
  const [newEnvironmentName, setNewEnvironmentName] = useState('Default')
  const [newEnvironmentPattern, setNewEnvironmentPattern] = useState('**')
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  const field = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)

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

  // New Session unmounts when the person leaves, so the prompt has to live
  // outside the component. An empty field clears the stored draft.
  useEffect(() => {
    saveNewSessionDraft(prompt)
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
  const reuseEnvironment = reuseEnvironmentId
    ? environments.find((environment) => environment.id === reuseEnvironmentId)
    : undefined

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
    if (reuseEnvironmentId) {
      setEnvironmentId(reuseEnvironmentId)
      return
    }

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
  }, [baseBranch, environments, target, lastNewSession, reuseEnvironmentId])

  useEffect(() => {
    let cancelled = false

    Promise.all([
      client.agentCredentialsConfigured().then(
        (configured) => ({ ok: true as const, configured }),
        () => ({ ok: false as const }),
      ),
      client.grokCredentialsConfigured().then(
        (configured) => ({ ok: true as const, configured }),
        () => ({ ok: false as const }),
      ),
      client.listOpencodeProviders().then(
        (found) => ({ ok: true as const, found }),
        () => ({ ok: false as const }),
      ),
    ]).then(([claude, grok, providers]) => {
      if (cancelled) return
      const claudeOn = claude.ok && claude.configured
      const grokOn = grok.ok && grok.configured
      setClaudeConfigured(claudeOn)
      setGrokConfigured(grokOn)
      if (providers.ok) {
        setOpencodeProviders(providers.found)
        setOpencodeProvidersStatus('loaded')
      } else {
        // A failed list must not look like "no providers": Start stays
        // blocked until a model can be chosen.
        setOpencodeProviders([])
        setOpencodeProvidersStatus('failed')
      }
      // A failed check must not look like "none configured": that screen
      // offers a Settings button members cannot use.
      const anyConfigured = claudeOn || grokOn || (providers.ok && providers.found.length > 0)
      const listingFailed = !claude.ok || !grok.ok || !providers.ok
      setAgentsStatus(anyConfigured ? 'loaded' : listingFailed ? 'failed' : 'loaded')
    })

    return () => {
      cancelled = true
    }
  }, [client, agentsReload])

  const usingOpenCode = agentId === 'opencode'
  const usingGrokBuild = agentId === 'grok-build'
  const selectedProvider = opencodeProviders.find((provider) => provider.id === providerId)
  const models = useMemo(() => {
    if (usingOpenCode) {
      return selectedProvider ? modelsForProvider(selectedProvider) : []
    }
    if (usingGrokBuild) return GROK_BUILD_MODELS
    return AVAILABLE_MODELS
  }, [usingOpenCode, usingGrokBuild, selectedProvider])

  const configuredAgents = useMemo(() => {
    if (agentsStatus !== 'loaded') return []
    return AVAILABLE_AGENTS.filter((agent) => {
      if (agent.id === 'claude-code') return claudeConfigured
      if (agent.id === 'grok-build') return grokConfigured
      if (agent.id === 'opencode') return opencodeProviders.length > 0
      return false
    })
  }, [agentsStatus, claudeConfigured, grokConfigured, opencodeProviders.length])

  const hasNoAgents = agentsStatus === 'loaded' && configuredAgents.length === 0
  const canConfigureAgents = role === 'owner'

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

  const selectAgent = (next: string) => {
    setAgentId(next)
    if (next === 'opencode') {
      const firstProvider = opencodeProviders[0]
      if (firstProvider) {
        setProviderId(firstProvider.id)
        const firstModel = modelsForProvider(firstProvider)[0]?.id
        if (firstModel) setModel(firstModel)
      }
    } else if (next === 'grok-build') {
      setProviderId('')
      setModel(DEFAULT_GROK_BUILD_MODEL)
    } else {
      setProviderId('')
      setModel(DEFAULT_MODEL)
    }
  }

  useEffect(() => {
    if (agentsStatus !== 'loaded') return
    if (configuredAgents.some((agent) => agent.id === agentId)) return

    const preferred =
      preferAgentId && configuredAgents.some((agent) => agent.id === preferAgentId)
        ? preferAgentId
        : undefined
    const last =
      lastNewSession?.agentId &&
      configuredAgents.some((agent) => agent.id === lastNewSession.agentId)
        ? lastNewSession.agentId
        : undefined
    const next = preferred ?? last ?? configuredAgents[0]?.id
    if (next) selectAgent(next)
    else setAgentId('')
  }, [agentsStatus, configuredAgents, agentId, preferAgentId, lastNewSession])

  const selectProvider = (next: string) => {
    setProviderId(next)
    const provider = opencodeProviders.find((candidate) => candidate.id === next)
    const first = provider ? modelsForProvider(provider)[0]?.id : undefined
    if (first) setModel(first)
  }

  const leaveReuse = () => {
    setReuseEnvironmentId(null)
    setForceSetup(false)
  }

  const selectRepo = (fullName: string) => {
    setTarget(fullName)
    leaveReuse()
    const project = projects.find((candidate) => candidate.repoFullName === fullName)
    const repository = repositories.find((candidate) => candidate.fullName === fullName)
    setBaseBranch(project?.defaultBranch || repository?.defaultBranch || 'main')
  }

  // Selected files are read once, immediately, and held as base64 data URIs so
  // the start request is a single message. Re-selecting the same file works
  // because the input's value is reset after every pick.
  const attachFiles = (picked: File[]) => {
    if (picked.length === 0 || busy) return

    void readPickedFiles(picked).then(({ files: read, error: readError }) => {
      if (read.length > 0) setFiles((current) => [...current, ...read])
      setAttachError(readError)
    })
  }

  const handleFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files ?? [])
    event.target.value = ''
    attachFiles(picked)
  }

  const removeFile = (index: number) => {
    setFiles((current) => current.filter((_, i) => i !== index))
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

    // The start is in flight; a leftover read error would look like this failed.
    setAttachError(null)
    setStatus({ kind: 'starting' })

    try {
      // The project may not exist yet. Creating it here keeps the choice about
      // a repository rather than about a concept the server invented.
      let project = projects.find((candidate) => candidate.repoFullName === target) ?? null
      let created: ProjectSummary | null = null

      if (!project) {
        project = created = await client.createProject(target)
      }

      const mode = resolvePermissionMode(
        agentId,
        needsEnvironment ? 'environment_setup' : 'coding',
        permissionMode,
      )

      if (needsEnvironment) {
        if (reuseEnvironmentId) {
          // Seeded from the prop and locked while this card is open. Refuse a
          // foreign id rather than start setup on another project's row.
          if (!reuseEnvironment || reuseEnvironment.projectId !== project.id) {
            throw new Error('This environment does not belong to the selected repository.')
          }

          const session = await client.startSession({
            projectId: project.id,
            agentId,
            model,
            baseBranch,
            purpose: 'environment_setup',
            environmentId,
            ...(mode ? { permissionMode: mode } : {}),
            ...(identity ? { commitIdentity: identity } : {}),
            ...(gitPreferences ? { gitPreferences } : {}),
          })

          remember(environmentId)
          clearNewSessionDraft()
          onCreated(session, created)
          return
        }

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
            ...(mode ? { permissionMode: mode } : {}),
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
        clearNewSessionDraft()
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
        ...(files.length > 0 ? { files } : {}),
        ...(mode ? { permissionMode: mode } : {}),
        ...(identity ? { commitIdentity: identity } : {}),
        ...(gitPreferences ? { gitPreferences } : {}),
      })

      remember(environmentId)
      clearNewSessionDraft()
      onCreated(session, created)
    } catch (error) {
      setStatus({
        kind: 'failed',
        message: error instanceof Error ? error.message : 'Could not start the session.',
      })
    }
  }

  const busy =
    status.kind === 'starting' ||
    status.kind === 'loading' ||
    agentsStatus === 'loading' ||
    Boolean(disabled)
  const { dragging, onDragEnter, onDragOver, onDragLeave, onDrop } = useFileDrop({
    disabled: busy,
    onFiles: attachFiles,
  })
  const options = mergeOptions(projects, repositories)
  const hasModel = models.length > 0 && models.some((candidate) => candidate.id === model)

  // The server this app is paired with is the only instance it can reach, so
  // it is the whole list. Pairing with several is what makes this plural.
  const instances = [
    { id: connection.deviceId, name: connection.serverName, host: connection.address.host },
  ]

  const agentReady = configuredAgents.some((agent) => agent.id === agentId)

  const canSend = needsEnvironment
    ? !busy &&
      Boolean(target) &&
      Boolean(baseBranch) &&
      agentReady &&
      hasModel &&
      (!reuseEnvironmentId || Boolean(reuseEnvironment))
    : !busy &&
      Boolean(target) &&
      Boolean(baseBranch) &&
      agentReady &&
      hasModel &&
      prompt.trim() !== ''

  if (agentsStatus === 'failed') {
    return (
      <div className="grid h-full min-h-0 min-w-0 place-items-center px-6">
        <div className="w-full max-w-xl rounded-[calc(var(--radius)*1.1)] border border-border bg-surface px-3.5 py-3.5">
          <h2 className="text-[14px] font-medium">Couldn’t load agents</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Check the connection and try again.
          </p>
          <button
            type="button"
            onClick={() => setAgentsReload((current) => current + 1)}
            className="mt-3 rounded-full bg-foreground px-3.5 py-1.5 text-[13px] font-medium text-background"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  if (hasNoAgents) {
    return (
      <div className="grid h-full min-h-0 min-w-0 place-items-center px-6">
        <div className="w-full max-w-xl rounded-[calc(var(--radius)*1.1)] border border-border bg-surface px-3.5 py-3.5">
          <h2 className="text-[14px] font-medium">Configure an agent</h2>
          {canConfigureAgents ? (
            <>
              <p className="mt-1 text-[13px] text-muted-foreground">
                Add a Claude Code token, a Grok Build API key, or an OpenCode provider in Settings
                before starting a session.
              </p>
              <button
                type="button"
                onClick={onConfigureProviders}
                className="mt-3 rounded-full bg-foreground px-3.5 py-1.5 text-[13px] font-medium text-background"
              >
                Configure agents
              </button>
            </>
          ) : (
            <p className="mt-1 text-[13px] text-muted-foreground">
              Ask the server owner to configure an agent.
            </p>
          )}
        </div>
      </div>
    )
  }

  return (
    <div
      className="grid h-full min-h-0 min-w-0 place-items-center px-6"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="relative w-full max-w-xl" aria-busy={busy}>
        {status.kind === 'loading' && (
          <p role="status" className="mb-3 text-[13px] text-muted-foreground">
            Loading repositories…
          </p>
        )}
        <div className="mb-3 flex flex-wrap items-center gap-1">
          <RepoPicker
            options={options}
            value={target}
            onChange={selectRepo}
            disabled={busy || Boolean(reuseEnvironmentId)}
          />
          <BranchPicker
            branches={branches}
            value={baseBranch}
            onChange={setBaseBranch}
            disabled={busy || !target}
            loading={branchesLoading}
          />
          {/* Hidden while re-running: a matching-only list would label the
              locked id as Base image, and the heading already names it. */}
          {environments.length > 0 && !reuseEnvironmentId && (
            <EnvironmentPicker
              environments={matching}
              value={environmentId}
              onChange={setEnvironmentId}
              disabled={busy || !target}
            />
          )}
          <AgentPicker
            value={agentId}
            onChange={selectAgent}
            disabled={busy || configuredAgents.length === 0}
            agents={configuredAgents}
          />
          <InstancePicker instances={instances} value={connection.deviceId} disabled={busy} />
        </div>

        {needsEnvironment ? (
          <div className="rounded-[calc(var(--radius)*1.1)] border border-border bg-surface px-3.5 py-3.5">
            <h2 className="text-[14px] font-medium">
              {reuseEnvironmentId
                ? `Run setup again${reuseEnvironment ? ` · ${reuseEnvironment.name}` : ''}`
                : 'Configure environment'}
            </h2>
            <p className="mt-1 text-[13px] text-muted-foreground">
              {agentId} will inspect the repository and propose setup commands and environment
              variables. You review and save them, and branches this environment covers use them
              from then on.
            </p>
            {!reuseEnvironmentId && (
              <>
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
              </>
            )}

            <div className="mt-3 flex items-center justify-between gap-2">
              <SessionMutablePickers
                busy={busy}
                usingOpenCode={usingOpenCode}
                opencodeProvidersStatus={opencodeProvidersStatus}
                opencodeProviders={opencodeProviders}
                providerId={providerId}
                onProviderChange={selectProvider}
                onAddProvider={onConfigureProviders}
                models={models}
                model={model}
                onModelChange={setModel}
                agentId={agentId}
                permissionMode={permissionMode}
                onPermissionModeChange={setPermissionMode}
                showPermissionMode={false}
              />
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={leaveReuse}
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
          </div>
        ) : (
          <div
            className={`relative rounded-[calc(var(--radius)*1.1)] border bg-surface transition-[border-color,box-shadow] ${dragging ? 'border-primary ring-2 ring-primary/20' : 'border-border focus-within:border-muted-foreground/40'}`}
          >
            <textarea
              ref={field}
              value={prompt}
              onChange={(event) => {
                const element = event.currentTarget
                setPrompt(element.value)
                element.style.height = 'auto'
                element.style.height = `${Math.min(element.scrollHeight, 200)}px`
              }}
              onKeyDown={(event) => {
                if (
                  event.key === 'Tab' &&
                  event.shiftKey &&
                  agentHasPermissionModes(agentId) &&
                  !busy
                ) {
                  event.preventDefault()
                  setPermissionMode(cyclePermissionMode(permissionMode, agentId))
                  return
                }
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void submit()
                }
              }}
              onPaste={(event) => {
                const pasted = filesFromPaste(event.clipboardData)
                if (pasted.length === 0) return
                event.preventDefault()
                attachFiles(pasted)
              }}
              rows={3}
              disabled={busy}
              placeholder={disabled ? 'Waiting for connection…' : 'Ask for a change…'}
              aria-label="What should it do?"
              className="block w-full resize-none bg-transparent px-3.5 pt-3.5 pb-2 outline-none placeholder:text-muted-foreground disabled:opacity-50"
            />

            {files.length > 0 && (
              <div className="px-3 pb-2">
                <AttachmentChips attachments={files} onRemove={removeFile} disabled={busy} />
              </div>
            )}

            <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5">
              <div className="flex min-w-0 flex-wrap items-center gap-1">
                <button
                  type="button"
                  onClick={() => picker.current?.click()}
                  disabled={busy}
                  aria-label="Attach files"
                  title="Attach files"
                  className="inline-flex shrink-0 items-center justify-center rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                >
                  <AttachIcon size={15} />
                </button>
                <SessionMutablePickers
                  busy={busy}
                  usingOpenCode={usingOpenCode}
                  opencodeProvidersStatus={opencodeProvidersStatus}
                  opencodeProviders={opencodeProviders}
                  providerId={providerId}
                  onProviderChange={selectProvider}
                  onAddProvider={onConfigureProviders}
                  models={models}
                  model={model}
                  onModelChange={setModel}
                  agentId={agentId}
                  permissionMode={permissionMode}
                  onPermissionModeChange={setPermissionMode}
                />
                <p className="text-[11.5px] text-muted-foreground">
                  {agentHasPermissionModes(agentId)
                    ? '↵ Start · ⇧↵ Newline · ⇧⇥ Mode'
                    : '↵ Start · ⇧↵ Newline'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={!canSend}
                aria-label={status.kind === 'starting' ? 'Starting' : 'Start session'}
                className="shrink-0 rounded-[calc(var(--radius)*0.6)] bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background disabled:opacity-40"
              >
                {status.kind === 'starting' ? 'Starting…' : 'Start'}
              </button>
            </div>
            <input ref={picker} type="file" multiple className="hidden" onChange={handleFiles} />
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

        {!needsEnvironment && !usingBaseImage && (
          <p className="mt-2 text-[12px] text-muted-foreground">
            <button
              type="button"
              onClick={() => setForceSetup(true)}
              disabled={busy}
              className="underline underline-offset-2 disabled:opacity-40"
            >
              Reconfigure environment
            </button>
          </p>
        )}

        {attachError && (
          <p role="alert" className="mt-3 text-[13px] text-destructive">
            {attachError}
          </p>
        )}
        {status.kind === 'failed' && (
          <p role="alert" className="mt-3 text-[13px] text-destructive">
            {status.message}
          </p>
        )}
        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-[calc(var(--radius)*1.1)] border-2 border-dashed border-primary/60 bg-background/85">
            <p className="flex items-center gap-2 text-[13px] font-medium text-foreground">
              <AttachIcon size={16} />
              Drop to attach
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function SessionMutablePickers({
  busy,
  usingOpenCode,
  opencodeProvidersStatus,
  opencodeProviders,
  providerId,
  onProviderChange,
  onAddProvider,
  models,
  model,
  onModelChange,
  agentId,
  permissionMode,
  onPermissionModeChange,
  showPermissionMode = true,
}: {
  busy: boolean
  usingOpenCode: boolean
  opencodeProvidersStatus: 'loading' | 'loaded' | 'failed'
  opencodeProviders: OpencodeProvider[]
  providerId: string
  onProviderChange: (providerId: string) => void
  onAddProvider: () => void
  models: readonly { id: string; label: string }[]
  model: string
  onModelChange: (modelId: string) => void
  agentId: string
  permissionMode: AvailablePermissionModeId
  onPermissionModeChange: (mode: AvailablePermissionModeId) => void
  /** Setup sessions always run in bypass, so the picker is noise there. */
  showPermissionMode?: boolean
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {usingOpenCode && opencodeProvidersStatus === 'loaded' && (
        <ProviderPicker
          providers={opencodeProviders}
          value={providerId}
          onChange={onProviderChange}
          onAddProvider={onAddProvider}
          disabled={busy}
        />
      )}
      {!(usingOpenCode && models.length === 0) && (
        <ModelPicker value={model} onChange={onModelChange} disabled={busy} models={models} />
      )}
      {showPermissionMode && agentHasPermissionModes(agentId) && (
        <PermissionModePicker
          value={permissionMode}
          onChange={onPermissionModeChange}
          disabled={busy}
          modes={availablePermissionModes(agentId)}
        />
      )}
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
  if (agentId === 'opencode') return last?.model ?? ''
  if (agentId === 'grok-build') {
    if (last?.model && GROK_BUILD_MODELS.some((candidate) => candidate.id === last.model)) {
      return last.model
    }
    return DEFAULT_GROK_BUILD_MODEL
  }
  if (last?.model && AVAILABLE_MODELS.some((candidate) => candidate.id === last.model)) {
    return last.model
  }
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
