import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
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

function renderScreen(client: ReturnType<typeof makeClient>, projectOverrides = {}) {
  return render(
    <NewSession
      client={client as never}
      connection={connection as never}
      projects={[{ ...project, ...projectOverrides } as never]}
      onCreated={vi.fn()}
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

    // Exact, since "Reconfigure environment" sits in the composer too.
    await userEvent.click(await screen.findByRole('button', { name: 'Configure environment' }))
    await userEvent.click(await screen.findByRole('button', { name: /start setup/i }))

    // Leaving it behind would collide with the unique (project_id, name) index
    // on the retry, turning a transient failure into a permanent one.
    await waitFor(() => expect(client.deleteEnvironment).toHaveBeenCalledWith('env-new'))
    expect(await screen.findByRole('alert')).toHaveTextContent(/sandbox unavailable/i)
  })

  it('prefills the branch pattern from the current branch', async () => {
    const client = makeClient({ listEnvironments: vi.fn().mockResolvedValue([]) })
    renderScreen(client, { environmentCount: 0 })

    // Exact, since "Reconfigure environment" sits in the composer too.
    await userEvent.click(await screen.findByRole('button', { name: 'Configure environment' }))
    // A branch with no slash cannot suggest a family, so it offers the catch-all.
    expect(screen.getByLabelText(/branches/i)).toHaveValue('**')

    const branches = await openPicker('Branch')
    await userEvent.click(within(branches).getByRole('option', { name: 'refact/auth' }))

    // `refact/auth` suggests the family, not the single branch.
    await waitFor(() => expect(screen.getByLabelText(/branches/i)).toHaveValue('refact/*'))
  })
})
