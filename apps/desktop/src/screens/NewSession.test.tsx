import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { LastNewSession } from '@/lib/settings'
import { NewSession } from '@/screens/NewSession'

/**
 * The pickers are popover menus, not `<select>`s, so every assertion about the
 * options has to open the menu first. Asserting against the closed chip would
 * pass even when the filtering is broken, since the chip only ever shows the
 * one selected label.
 */

const environments = [
  {
    id: '00000000-0000-4000-8000-0000000000e1',
    projectId: '00000000-0000-4000-8000-000000000001',
    name: 'Refactors',
    branchPattern: 'refact/*',
    position: 0,
    hasConfig: true,
    hasSnapshot: false,
    hasDraft: false,
  },
  {
    id: '00000000-0000-4000-8000-0000000000e2',
    projectId: '00000000-0000-4000-8000-000000000001',
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
    listOpencodeProviders: vi.fn().mockResolvedValue([]),
    upsertOpencodeProvider: vi.fn().mockResolvedValue({
      id: 'anthropic',
      kind: 'anthropic',
      name: 'Anthropic',
      models: [{ id: 'claude-sonnet-4-5', label: 'Sonnet 4.5' }],
    }),
    startSession: vi.fn().mockResolvedValue({ id: 's1' }),
    createProject: vi.fn(),
    ...overrides,
  }
}

const project = {
  id: '00000000-0000-4000-8000-000000000001',
  repoFullName: 'acme/app',
  defaultBranch: 'main',
  environmentCount: 2,
  createdAt: Date.now(),
  sessionCount: 0,
}

const connection = { deviceId: 'd1', serverName: 'server', address: { host: 'localhost' } }

function renderScreen(
  client: ReturnType<typeof makeClient>,
  projectOverrides = {},
  extra: {
    onConfigureProviders?: () => void
    onRemember?: ReturnType<typeof vi.fn>
    preferAgentId?: string | null
    preferProjectId?: string | null
    lastNewSession?: LastNewSession | null
    projects?: (typeof project)[]
    disabled?: boolean
  } = {},
) {
  return render(
    <NewSession
      client={client as never}
      connection={connection as never}
      projects={(extra.projects ?? [{ ...project, ...projectOverrides }]) as never}
      identity={null}
      onCreated={vi.fn()}
      onConfigureProviders={extra.onConfigureProviders ?? vi.fn()}
      onRemember={extra.onRemember}
      preferAgentId={extra.preferAgentId}
      preferProjectId={extra.preferProjectId}
      lastNewSession={extra.lastNewSession}
      disabled={extra.disabled}
    />,
  )
}

/** Open a chip's popover and hand back the listbox to assert within. */
async function openPicker(name: string) {
  await userEvent.click(await screen.findByRole('button', { name }))
  return screen.getByRole('listbox', { name })
}

describe('NewSession environment picker', () => {
  it('offers only environments matching the branch', async () => {
    renderScreen(makeClient())

    // On `main`, only the catch-all matches; Refactors is not offered.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Environment' })).toBeEnabled())
    const listbox = await openPicker('Environment')

    expect(within(listbox).getByRole('option', { name: /Default/ })).toBeInTheDocument()
    expect(within(listbox).queryByRole('option', { name: /Refactors/ })).not.toBeInTheDocument()
    // The base image always closes the list.
    expect(within(listbox).getByRole('option', { name: /base image/i })).toBeInTheDocument()
  })

  it('preselects the lowest-position match after switching branch', async () => {
    renderScreen(makeClient())

    await waitFor(() => expect(screen.getByRole('button', { name: 'Branch' })).toBeEnabled())
    const branches = await openPicker('Branch')
    await userEvent.click(within(branches).getByRole('option', { name: 'refact/auth' }))

    // `refact/*` (position 0) beats the catch-all (position 1).
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Environment' })).toHaveTextContent('Refactors'),
    )
  })

  it('sends the selected environment id when starting a session', async () => {
    const client = makeClient()
    renderScreen(client)

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Environment' })).toHaveTextContent('Default'),
    )
    await userEvent.type(screen.getByLabelText(/what should it do/i), 'do a thing')
    await userEvent.click(screen.getByRole('button', { name: /start session/i }))

    await waitFor(() =>
      expect(client.startSession).toHaveBeenCalledWith(
        expect.objectContaining({
          purpose: 'coding',
          environmentId: '00000000-0000-4000-8000-0000000000e2',
        }),
      ),
    )
  })

  it('shows the base-image notice when nothing matches', async () => {
    const client = makeClient({
      // `refact/*` only, and the base branch is `main`.
      listEnvironments: vi.fn().mockResolvedValue([environments[0]]),
    })

    renderScreen(client, { environmentCount: 1 })

    await waitFor(() => expect(screen.getByText(/base image will be used/i)).toBeInTheDocument())
  })

  it('starts a coding session on the base image rather than forcing setup', async () => {
    // The old gate sent a project with no environment into environment_setup
    // before any coding session could run. Setup is now offered, not required.
    const client = makeClient({ listEnvironments: vi.fn().mockResolvedValue([]) })
    renderScreen(client, { environmentCount: 0 })

    await userEvent.type(await screen.findByLabelText(/what should it do/i), 'do a thing')
    await userEvent.click(screen.getByRole('button', { name: /start session/i }))

    await waitFor(() => expect(client.startSession).toHaveBeenCalled())
    expect(client.startSession.mock.calls[0][0]).toMatchObject({ purpose: 'coding' })
    expect(client.startSession.mock.calls[0][0]).not.toHaveProperty('environmentId')
    // With no environments at all the picker is noise and stays hidden.
    expect(screen.queryByRole('button', { name: 'Environment' })).not.toBeInTheDocument()
  })

  it('removes the environment again when the setup session fails to start', async () => {
    const client = makeClient({
      listEnvironments: vi.fn().mockResolvedValue([]),
      createEnvironment: vi.fn().mockResolvedValue({ id: 'env-new' }),
      startSession: vi.fn().mockRejectedValue(new Error('sandbox unavailable')),
      deleteEnvironment: vi.fn().mockResolvedValue(undefined),
    })
    renderScreen(client, { environmentCount: 0 })

    await userEvent.click(await screen.findByRole('button', { name: 'Configure environment' }))
    await userEvent.click(await screen.findByRole('button', { name: /start setup/i }))

    // Leaving it behind would collide with the unique (project_id, name) index
    // on the retry, turning a transient failure into a permanent one.
    await waitFor(() => expect(client.deleteEnvironment).toHaveBeenCalledWith('env-new'))
    expect(await screen.findByRole('alert')).toHaveTextContent(/sandbox unavailable/i)
  })

  it('returns to the prompt from configure environment', async () => {
    const client = makeClient({ listEnvironments: vi.fn().mockResolvedValue([]) })
    renderScreen(client, { environmentCount: 0 })

    await userEvent.click(await screen.findByRole('button', { name: 'Configure environment' }))
    expect(screen.getByRole('heading', { name: 'Configure environment' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByLabelText(/what should it do/i)).toBeInTheDocument()
  })

  it('prefills the branch pattern from the current branch', async () => {
    const client = makeClient({ listEnvironments: vi.fn().mockResolvedValue([]) })
    renderScreen(client, { environmentCount: 0 })

    await userEvent.click(await screen.findByRole('button', { name: 'Configure environment' }))
    // A branch with no slash cannot suggest a family, so it offers the catch-all.
    expect(screen.getByLabelText(/branches/i)).toHaveValue('**')

    const branches = await openPicker('Branch')
    await userEvent.click(within(branches).getByRole('option', { name: 'refact/auth' }))

    // `refact/auth` suggests the family, not the single branch.
    await waitFor(() => expect(screen.getByLabelText(/branches/i)).toHaveValue('refact/*'))
  })
})

describe('NewSession OpenCode', () => {
  it('offers OpenCode in the agent picker', async () => {
    renderScreen(makeClient())

    const agents = await openPicker('Agent')
    expect(within(agents).getByRole('option', { name: /OpenCode/ })).toBeInTheDocument()
  })

  it('lists OpenCode models from the selected provider', async () => {
    const client = makeClient({
      listOpencodeProviders: vi.fn().mockResolvedValue([
        {
          id: 'anthropic',
          kind: 'anthropic',
          name: 'Anthropic',
          models: [{ id: 'claude-sonnet-4-5', label: 'Sonnet 4.5' }],
        },
      ]),
    })
    renderScreen(client)

    const agents = await openPicker('Agent')
    await userEvent.click(within(agents).getByRole('option', { name: /OpenCode/ }))

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Provider' })).toHaveTextContent('Anthropic'),
    )
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Model' })).toHaveTextContent('Sonnet 4.5'),
    )

    const models = await openPicker('Model')
    expect(within(models).getByRole('option', { name: /Sonnet 4.5/ })).toBeInTheDocument()
  })

  it('sends the provider/model id when starting an OpenCode session', async () => {
    const client = makeClient({
      listOpencodeProviders: vi.fn().mockResolvedValue([
        {
          id: 'openai',
          kind: 'openai',
          name: 'OpenAI',
          models: [{ id: 'gpt-5.2', label: 'GPT-5.2' }],
        },
      ]),
    })
    renderScreen(client)

    const agents = await openPicker('Agent')
    await userEvent.click(within(agents).getByRole('option', { name: /OpenCode/ }))

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Model' })).toHaveTextContent('GPT-5.2'),
    )
    await userEvent.type(screen.getByLabelText(/what should it do/i), 'do a thing')
    await userEvent.click(screen.getByRole('button', { name: /start session/i }))

    await waitFor(() =>
      expect(client.startSession).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'opencode',
          model: 'openai/gpt-5.2',
          permissionMode: 'bypass',
        }),
      ),
    )
  })

  it('opens provider settings when OpenCode is selected with no providers', async () => {
    const onConfigureProviders = vi.fn()
    renderScreen(makeClient(), {}, { onConfigureProviders })

    const agents = await openPicker('Agent')
    await userEvent.click(within(agents).getByRole('option', { name: /OpenCode/ }))

    await waitFor(() => expect(onConfigureProviders).toHaveBeenCalled())
  })

  it('offers a provider picker and Add provider opens settings', async () => {
    const onConfigureProviders = vi.fn()
    const client = makeClient({
      listOpencodeProviders: vi.fn().mockResolvedValue([
        {
          id: 'anthropic',
          kind: 'anthropic',
          name: 'Anthropic',
          models: [{ id: 'claude-sonnet-4-5', label: 'Sonnet 4.5' }],
        },
        {
          id: 'openai',
          kind: 'openai',
          name: 'OpenAI',
          models: [{ id: 'gpt-5.2', label: 'GPT-5.2' }],
        },
      ]),
    })
    renderScreen(client, {}, { onConfigureProviders })

    const agents = await openPicker('Agent')
    await userEvent.click(within(agents).getByRole('option', { name: /OpenCode/ }))

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Provider' })).toHaveTextContent('Anthropic'),
    )

    const providers = await openPicker('Provider')
    expect(within(providers).getByRole('option', { name: /Anthropic/ })).toBeInTheDocument()
    expect(within(providers).getByRole('option', { name: /OpenAI/ })).toBeInTheDocument()

    await userEvent.click(within(providers).getByRole('option', { name: /OpenAI/ }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Model' })).toHaveTextContent('GPT-5.2'),
    )

    const again = await openPicker('Provider')
    await userEvent.click(within(again).getByRole('button', { name: /add provider/i }))
    expect(onConfigureProviders).toHaveBeenCalled()
  })

  it('does not bounce to settings when returning with OpenCode and no providers', async () => {
    const onConfigureProviders = vi.fn()
    const client = makeClient()
    renderScreen(client, {}, { onConfigureProviders, preferAgentId: 'opencode' })

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Agent' })).toHaveTextContent('OpenCode'),
    )
    await waitFor(() => expect(client.listOpencodeProviders).toHaveBeenCalled())
    expect(onConfigureProviders).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Provider' })).toBeInTheDocument(),
    )
  })
})

describe('NewSession permission mode', () => {
  it('offers Plan, Auto, Accept edits, and Bypass for Claude Code', async () => {
    renderScreen(makeClient())

    const modes = await openPicker('Permission mode')
    expect(within(modes).getByRole('option', { name: 'Plan' })).toBeInTheDocument()
    expect(within(modes).getByRole('option', { name: 'Auto' })).toBeInTheDocument()
    expect(within(modes).getByRole('option', { name: 'Accept edits' })).toBeInTheDocument()
    expect(within(modes).getByRole('option', { name: 'Bypass' })).toBeInTheDocument()
  })

  it('cycles the permission mode with Shift+Tab', async () => {
    renderScreen(makeClient())

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Permission mode' })).toHaveTextContent('Bypass'),
    )

    await userEvent.type(screen.getByLabelText(/what should it do/i), '{Shift>}{Tab}{/Shift}')

    expect(screen.getByRole('button', { name: 'Permission mode' })).toHaveTextContent('Plan')
  })

  it('sends the selected mode when starting a Claude Code session', async () => {
    const client = makeClient()
    renderScreen(client)

    const modes = await openPicker('Permission mode')
    await userEvent.click(within(modes).getByRole('option', { name: 'Plan' }))
    await userEvent.type(screen.getByLabelText(/what should it do/i), 'do a thing')
    await userEvent.click(screen.getByRole('button', { name: /start session/i }))

    await waitFor(() =>
      expect(client.startSession).toHaveBeenCalledWith(
        expect.objectContaining({ permissionMode: 'plan' }),
      ),
    )
  })

  it('offers only Plan and Bypass for OpenCode', async () => {
    const client = makeClient({
      listOpencodeProviders: vi.fn().mockResolvedValue([
        {
          id: 'openai',
          kind: 'openai',
          name: 'OpenAI',
          models: [{ id: 'gpt-5.2', label: 'GPT-5.2' }],
        },
      ]),
    })
    renderScreen(client)

    const agents = await openPicker('Agent')
    await userEvent.click(within(agents).getByRole('option', { name: /OpenCode/ }))

    const modes = await openPicker('Permission mode')
    expect(within(modes).getByRole('option', { name: 'Plan' })).toBeInTheDocument()
    expect(within(modes).getByRole('option', { name: 'Bypass' })).toBeInTheDocument()
    expect(within(modes).queryByRole('option', { name: 'Auto' })).not.toBeInTheDocument()
    expect(within(modes).queryByRole('option', { name: 'Accept edits' })).not.toBeInTheDocument()
  })

  it('cycles OpenCode between Plan and Bypass with Shift+Tab', async () => {
    const client = makeClient({
      listOpencodeProviders: vi.fn().mockResolvedValue([
        {
          id: 'openai',
          kind: 'openai',
          name: 'OpenAI',
          models: [{ id: 'gpt-5.2', label: 'GPT-5.2' }],
        },
      ]),
    })
    renderScreen(client)

    const agents = await openPicker('Agent')
    await userEvent.click(within(agents).getByRole('option', { name: /OpenCode/ }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Permission mode' })).toHaveTextContent('Bypass'),
    )

    await userEvent.type(screen.getByLabelText(/what should it do/i), '{Shift>}{Tab}{/Shift}')
    expect(screen.getByRole('button', { name: 'Permission mode' })).toHaveTextContent('Plan')

    await userEvent.type(screen.getByLabelText(/what should it do/i), '{Shift>}{Tab}{/Shift}')
    expect(screen.getByRole('button', { name: 'Permission mode' })).toHaveTextContent('Bypass')
  })

  it('sends a chosen mode when starting an OpenCode session', async () => {
    const client = makeClient({
      listOpencodeProviders: vi.fn().mockResolvedValue([
        {
          id: 'openai',
          kind: 'openai',
          name: 'OpenAI',
          models: [{ id: 'gpt-5.2', label: 'GPT-5.2' }],
        },
      ]),
    })
    renderScreen(client)

    const agents = await openPicker('Agent')
    await userEvent.click(within(agents).getByRole('option', { name: /OpenCode/ }))

    const modes = await openPicker('Permission mode')
    await userEvent.click(within(modes).getByRole('option', { name: 'Plan' }))
    await userEvent.type(screen.getByLabelText(/what should it do/i), 'do a thing')
    await userEvent.click(screen.getByRole('button', { name: /start session/i }))

    await waitFor(() =>
      expect(client.startSession).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'opencode', permissionMode: 'plan' }),
      ),
    )
  })

  it('starts environment setup in bypass even when Plan is selected', async () => {
    const client = makeClient({
      listEnvironments: vi.fn().mockResolvedValue([]),
      createEnvironment: vi.fn().mockResolvedValue({ id: 'env-new' }),
    })
    renderScreen(client, { environmentCount: 0 })

    const modes = await openPicker('Permission mode')
    await userEvent.click(within(modes).getByRole('option', { name: 'Plan' }))
    expect(screen.getByRole('button', { name: 'Permission mode' })).toHaveTextContent('Plan')

    await userEvent.click(await screen.findByRole('button', { name: 'Configure environment' }))
    expect(screen.queryByRole('button', { name: 'Permission mode' })).not.toBeInTheDocument()

    await userEvent.click(await screen.findByRole('button', { name: /start setup/i }))

    await waitFor(() =>
      expect(client.startSession).toHaveBeenCalledWith(
        expect.objectContaining({
          purpose: 'environment_setup',
          permissionMode: 'bypass',
        }),
      ),
    )
  })
})

describe('NewSession loading', () => {
  it('says repositories are loading while the list is in flight', () => {
    const hang = () => new Promise(() => undefined)
    const client = makeClient({
      listRepositories: vi.fn(hang),
      listBranches: vi.fn(hang),
      listEnvironments: vi.fn(hang),
      listOpencodeProviders: vi.fn(hang),
    })
    renderScreen(client)

    expect(screen.getByRole('status')).toHaveTextContent(/loading repositories/i)
  })
})

describe('NewSession preferProjectId', () => {
  it('preselects the project without forcing environment setup', async () => {
    const other = {
      ...project,
      id: '00000000-0000-4000-8000-000000000002',
      repoFullName: 'acme/other',
      defaultBranch: 'develop',
      environmentCount: 0,
    }
    const client = makeClient({
      listRepositories: vi.fn().mockResolvedValue([
        { fullName: project.repoFullName, defaultBranch: 'main', isRegistered: true },
        { fullName: other.repoFullName, defaultBranch: 'develop', isRegistered: true },
      ]),
    })

    renderScreen(client, {}, { preferProjectId: other.id, projects: [project, other] })

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Repository' })).toHaveTextContent('other'),
    )
    expect(screen.queryByRole('heading', { name: 'Configure environment' })).not.toBeInTheDocument()
    expect(screen.getByLabelText(/what should it do/i)).toBeInTheDocument()
  })

  it('locks the prompt while disconnected', async () => {
    renderScreen(makeClient(), {}, { disabled: true })

    const field = await screen.findByLabelText(/what should it do/i)
    expect(field).toBeDisabled()
    expect(field).toHaveAttribute('placeholder', 'Waiting for connection…')
    expect(screen.getByRole('button', { name: 'Start session' })).toBeDisabled()
  })
})

describe('NewSession last session', () => {
  const last: LastNewSession = {
    repoFullName: 'acme/app',
    baseBranch: 'refact/auth',
    environmentId: environments[0].id,
    agentId: 'claude-code',
    model: 'claude-opus-5',
    providerId: '',
    permissionMode: 'plan',
  }

  it('restores the last session pickers', async () => {
    renderScreen(makeClient(), {}, { lastNewSession: last })

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Branch' })).toHaveTextContent('refact/auth'),
    )
    expect(screen.getByRole('button', { name: 'Model' })).toHaveTextContent('Opus 5')
    expect(screen.getByRole('button', { name: 'Permission mode' })).toHaveTextContent('Plan')
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Environment' })).toHaveTextContent('Refactors'),
    )
  })

  it('keeps an explicit base-image choice instead of auto-resolving', async () => {
    renderScreen(
      makeClient(),
      {},
      {
        lastNewSession: {
          ...last,
          baseBranch: 'main',
          environmentId: '',
          model: 'claude-sonnet-5',
          permissionMode: 'bypass',
        },
      },
    )

    await waitFor(() => expect(screen.getByText(/base image will be used/i)).toBeInTheDocument())
  })

  it('lets preferProjectId override the last repository', async () => {
    const other = {
      ...project,
      id: '00000000-0000-4000-8000-000000000002',
      repoFullName: 'acme/other',
      defaultBranch: 'develop',
      environmentCount: 0,
    }
    const client = makeClient({
      listRepositories: vi.fn().mockResolvedValue([
        { fullName: project.repoFullName, defaultBranch: 'main', isRegistered: true },
        { fullName: other.repoFullName, defaultBranch: 'develop', isRegistered: true },
      ]),
      listEnvironments: vi.fn().mockResolvedValue([]),
    })

    renderScreen(
      client,
      {},
      {
        lastNewSession: last,
        preferProjectId: other.id,
        projects: [project, other],
      },
    )

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Repository' })).toHaveTextContent('other'),
    )
    expect(screen.getByRole('button', { name: 'Model' })).toHaveTextContent('Opus 5')
    expect(screen.getByRole('button', { name: 'Permission mode' })).toHaveTextContent('Plan')
  })

  it('restores the last OpenCode provider and model', async () => {
    const client = makeClient({
      listOpencodeProviders: vi.fn().mockResolvedValue([
        {
          id: 'anthropic',
          kind: 'anthropic',
          name: 'Anthropic',
          models: [{ id: 'claude-sonnet-4-5', label: 'Sonnet 4.5' }],
        },
        {
          id: 'openai',
          kind: 'openai',
          name: 'OpenAI',
          models: [{ id: 'gpt-5.2', label: 'GPT-5.2' }],
        },
      ]),
    })

    renderScreen(
      client,
      {},
      {
        lastNewSession: {
          ...last,
          agentId: 'opencode',
          providerId: 'openai',
          model: 'openai/gpt-5.2',
          permissionMode: 'bypass',
        },
      },
    )

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Agent' })).toHaveTextContent('OpenCode'),
    )
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Provider' })).toHaveTextContent('OpenAI'),
    )
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Model' })).toHaveTextContent('GPT-5.2'),
    )
  })

  it('remembers the chosen settings when a session starts', async () => {
    const client = makeClient()
    const onRemember = vi.fn()
    renderScreen(client, {}, { onRemember })

    const models = await openPicker('Model')
    await userEvent.click(within(models).getByRole('option', { name: /Opus 5/ }))
    const modes = await openPicker('Permission mode')
    await userEvent.click(within(modes).getByRole('option', { name: 'Plan' }))
    await userEvent.type(screen.getByLabelText(/what should it do/i), 'do a thing')
    await userEvent.click(screen.getByRole('button', { name: /start session/i }))

    await waitFor(() =>
      expect(onRemember).toHaveBeenCalledWith(
        expect.objectContaining({
          repoFullName: 'acme/app',
          baseBranch: 'main',
          environmentId: '00000000-0000-4000-8000-0000000000e2',
          agentId: 'claude-code',
          model: 'claude-opus-5',
          permissionMode: 'plan',
        }),
      ),
    )
  })
})

describe('NewSession file attachments', () => {
  function fileInput(container: HTMLElement) {
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    if (!input) throw new Error('expected a hidden file input')
    return input
  }

  it('attaches files and sends them with the session', async () => {
    const client = makeClient()
    const { container } = renderScreen(client)

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Environment' })).toHaveTextContent('Default'),
    )

    fireEvent.change(fileInput(container), {
      target: { files: [new File(['hello'], 'notes.txt', { type: 'text/plain' })] },
    })

    expect(await screen.findByText('notes.txt')).toBeInTheDocument()

    await userEvent.type(screen.getByLabelText(/what should it do/i), 'read this')
    await userEvent.click(screen.getByRole('button', { name: /start session/i }))

    await waitFor(() =>
      expect(client.startSession).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'read this',
          files: [
            expect.objectContaining({
              name: 'notes.txt',
              data: expect.stringMatching(/^data:text\/plain;base64,/),
            }),
          ],
        }),
      ),
    )
  })

  it('attaches several files at once', async () => {
    const { container } = renderScreen(makeClient())

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Environment' })).toHaveTextContent('Default'),
    )

    fireEvent.change(fileInput(container), {
      target: {
        files: [
          new File(['a'], 'one.txt', { type: 'text/plain' }),
          new File(['b'], 'two.txt', { type: 'text/plain' }),
        ],
      },
    })

    expect(await screen.findByText('one.txt')).toBeInTheDocument()
    expect(await screen.findByText('two.txt')).toBeInTheDocument()
  })

  it('removes an attached file from the draft', async () => {
    const { container } = renderScreen(makeClient())

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Environment' })).toHaveTextContent('Default'),
    )

    fireEvent.change(fileInput(container), {
      target: { files: [new File(['x'], 'drop.txt', { type: 'text/plain' })] },
    })

    await screen.findByText('drop.txt')
    await userEvent.click(screen.getByRole('button', { name: 'Remove drop.txt' }))

    expect(screen.queryByText('drop.txt')).not.toBeInTheDocument()
  })

  it('disables attaching while disconnected', async () => {
    renderScreen(makeClient(), {}, { disabled: true })

    expect(await screen.findByRole('button', { name: 'Attach files' })).toBeDisabled()
  })

  it('omits files when none were attached', async () => {
    const client = makeClient()
    renderScreen(client)

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Environment' })).toHaveTextContent('Default'),
    )
    await userEvent.type(screen.getByLabelText(/what should it do/i), 'do a thing')
    await userEvent.click(screen.getByRole('button', { name: /start session/i }))

    await waitFor(() => expect(client.startSession).toHaveBeenCalled())
    expect(client.startSession.mock.calls[0][0]).not.toHaveProperty('files')
  })

  it('attaches files dropped on the prompt and sends them with the session', async () => {
    const client = makeClient()
    renderScreen(client)

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Environment' })).toHaveTextContent('Default'),
    )

    fireEvent.drop(promptComposer(), {
      dataTransfer: {
        types: ['Files'],
        files: [new File(['hello'], 'notes.txt', { type: 'text/plain' })],
      },
    })

    expect(await screen.findByText('notes.txt')).toBeInTheDocument()

    await userEvent.type(screen.getByLabelText(/what should it do/i), 'read this')
    await userEvent.click(screen.getByRole('button', { name: /start session/i }))

    await waitFor(() =>
      expect(client.startSession).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'read this',
          files: [
            expect.objectContaining({
              name: 'notes.txt',
              data: expect.stringMatching(/^data:text\/plain;base64,/),
            }),
          ],
        }),
      ),
    )
  })
})

function promptComposer() {
  const field = screen.getByLabelText(/what should it do/i)
  const box = field.parentElement
  if (!box) throw new Error('expected the prompt composer')
  return box
}

describe('NewSession picker placement', () => {
  it('keeps session-fixed pickers above the prompt and mutable ones inside', async () => {
    renderScreen(makeClient())

    await waitFor(() => expect(screen.getByRole('button', { name: 'Model' })).toBeInTheDocument())

    const inside = within(promptComposer())
    expect(inside.getByRole('button', { name: 'Model' })).toBeInTheDocument()
    expect(inside.getByRole('button', { name: 'Permission mode' })).toBeInTheDocument()
    expect(inside.queryByRole('button', { name: 'Repository' })).not.toBeInTheDocument()
    expect(inside.queryByRole('button', { name: 'Agent' })).not.toBeInTheDocument()
    expect(inside.queryByRole('button', { name: 'Instance' })).not.toBeInTheDocument()
    expect(inside.queryByRole('button', { name: 'Environment' })).not.toBeInTheDocument()

    expect(screen.getByRole('button', { name: 'Repository' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Agent' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Instance' })).toBeInTheDocument()
  })

  it('puts OpenCode provider, model, and permission mode inside the prompt', async () => {
    const client = makeClient({
      listOpencodeProviders: vi.fn().mockResolvedValue([
        {
          id: 'openai',
          kind: 'openai',
          name: 'OpenAI',
          models: [{ id: 'gpt-5.2', label: 'GPT-5.2' }],
        },
      ]),
    })
    renderScreen(client)

    const agents = await openPicker('Agent')
    await userEvent.click(within(agents).getByRole('option', { name: /OpenCode/ }))

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Provider' })).toHaveTextContent('OpenAI'),
    )

    const inside = within(promptComposer())
    expect(inside.getByRole('button', { name: 'Provider' })).toBeInTheDocument()
    expect(inside.getByRole('button', { name: 'Model' })).toBeInTheDocument()
    expect(inside.getByRole('button', { name: 'Permission mode' })).toBeInTheDocument()
    expect(inside.queryByRole('button', { name: 'Agent' })).not.toBeInTheDocument()
  })

  it('keeps Reconfigure environment outside the prompt', async () => {
    renderScreen(makeClient())

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Environment' })).toHaveTextContent('Default'),
    )

    expect(
      within(promptComposer()).queryByRole('button', { name: 'Reconfigure environment' }),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reconfigure environment' })).toBeInTheDocument()
  })

  it('keeps the model picker on the environment setup form', async () => {
    const client = makeClient({ listEnvironments: vi.fn().mockResolvedValue([]) })
    renderScreen(client, { environmentCount: 0 })

    await userEvent.click(await screen.findByRole('button', { name: 'Configure environment' }))

    const form = screen.getByRole('heading', { name: 'Configure environment' }).closest('div')
    expect(form).not.toBeNull()
    expect(within(form!).getByRole('button', { name: 'Model' })).toBeInTheDocument()
    // Setup always runs in bypass, so the mode picker would be a lie.
    expect(within(form!).queryByRole('button', { name: 'Permission mode' })).not.toBeInTheDocument()
    expect(within(form!).queryByRole('button', { name: 'Agent' })).not.toBeInTheDocument()
  })
})
