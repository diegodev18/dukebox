import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { EnvironmentsPanel } from '@/components/EnvironmentsPanel'

/**
 * Every assertion here targets text that is on screen unconditionally, so a
 * broken preview or a broken commit rule shows up as a failure rather than as
 * an assertion against something that was never rendered.
 *
 * Rows are addressed through `within(listitem)` because both rows carry the
 * same labels — a bare `getByText(/2 branches/)` would pass while attributing
 * the count to the wrong pattern.
 */

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
    getEnvironment: vi.fn().mockResolvedValue({
      config: null,
      draft: null,
      secretNames: [],
    }),
    getEnvironmentProposal: vi.fn(),
    putEnvironment: vi.fn().mockResolvedValue({}),
    ...overrides,
  }
}

/** The row a given pattern belongs to, so counts cannot be read off a sibling. */
async function rowFor(pattern: string) {
  const field = await screen.findByDisplayValue(pattern)
  const row = field.closest('li')
  if (!row) throw new Error(`no row around the field showing ${pattern}`)
  return row
}

describe('EnvironmentsPanel', () => {
  it('lists environments in order', async () => {
    render(<EnvironmentsPanel client={makeClient() as never} projectId="p1" />)

    await waitFor(() => expect(screen.getByDisplayValue('Refactors')).toBeInTheDocument())
    expect(screen.getByDisplayValue('Default')).toBeInTheDocument()

    const names = screen.getAllByLabelText('Environment name').map((field) => field.value)
    expect(names).toEqual(['Refactors', 'Default'])
  })

  it('previews which branches a pattern matches', async () => {
    render(<EnvironmentsPanel client={makeClient() as never} projectId="p1" />)

    // `refact/*` covers two of the three branches; `**` covers all three.
    const refactors = await rowFor('refact/*')
    expect(within(refactors).getByText(/matches 2 branches/i)).toBeInTheDocument()

    const fallback = await rowFor('**')
    expect(within(fallback).getByText(/matches 3 branches/i)).toBeInTheDocument()
  })

  it('says "1 branch" rather than "1 branches"', async () => {
    const client = makeClient({ listBranches: vi.fn().mockResolvedValue(['main', 'refact/auth']) })
    render(<EnvironmentsPanel client={client as never} projectId="p1" />)

    const refactors = await rowFor('refact/*')
    await waitFor(() => expect(within(refactors).getByText('Matches 1 branch')).toBeInTheDocument())
  })

  it('warns when a pattern matches nothing', async () => {
    render(<EnvironmentsPanel client={makeClient() as never} projectId="p1" />)

    const field = await screen.findByDisplayValue('refact/*')
    // Replacing the value with fireEvent.change is deterministic; a clear()
    // followed by type() can race under load and leave the old text prepended
    // to the new ("refact/*nope/*").
    fireEvent.change(field, { target: { value: 'nope/*' } })

    const row = await rowFor('nope/*')
    await waitFor(() => expect(within(row).getByText('Matches no branches')).toBeInTheDocument())
  })

  it('shows a validation error for an unsafe pattern', async () => {
    render(<EnvironmentsPanel client={makeClient() as never} projectId="p1" />)

    const row = await rowFor('refact/*')
    await waitFor(() => expect(within(row).getByText(/matches 2 branches/i)).toBeInTheDocument())
    fireEvent.change(within(row).getByLabelText('Branch pattern'), {
      target: { value: 're:(a+)+' },
    })

    expect(within(row).getByText(/nested quantifiers/i)).toBeInTheDocument()
  })

  it('commits a name on blur, not per keystroke', async () => {
    const client = makeClient()
    render(<EnvironmentsPanel client={client as never} projectId="p1" />)

    const field = await screen.findByDisplayValue('Refactors')
    // Focus, then set the value: a change event never moves focus, and the
    // blur (via tab below) is what the test is really about.
    field.focus()
    fireEvent.change(field, { target: { value: 'Rewrites' } })

    // A half-typed name must never reach the server.
    expect(client.updateEnvironment).not.toHaveBeenCalled()

    await userEvent.tab()
    await waitFor(() =>
      expect(client.updateEnvironment).toHaveBeenCalledWith('env-1', { name: 'Rewrites' }),
    )
    expect(client.updateEnvironment).toHaveBeenCalledTimes(1)
  })

  it('never sends an invalid pattern to the server', async () => {
    const client = makeClient()
    render(<EnvironmentsPanel client={client as never} projectId="p1" />)

    const row = await rowFor('refact/*')
    await waitFor(() => expect(within(row).getByText(/matches 2 branches/i)).toBeInTheDocument())
    const field = within(row).getByLabelText('Branch pattern')
    field.focus()
    fireEvent.change(field, { target: { value: 're:(a+)+' } })
    await userEvent.tab()

    expect(within(row).getByText(/nested quantifiers/i)).toBeInTheDocument()
    expect(client.updateEnvironment).not.toHaveBeenCalled()
  })

  it('commits a valid pattern on blur', async () => {
    const client = makeClient()
    render(<EnvironmentsPanel client={client as never} projectId="p1" />)

    const field = await screen.findByDisplayValue('refact/*')
    field.focus()
    fireEvent.change(field, { target: { value: 'feat/*' } })
    await userEvent.tab()

    await waitFor(() =>
      expect(client.updateEnvironment).toHaveBeenCalledWith('env-1', { branchPattern: 'feat/*' }),
    )
  })

  it('sends the complete ordered id list when reordering', async () => {
    const client = makeClient()
    render(<EnvironmentsPanel client={client as never} projectId="p1" />)

    await waitFor(() => expect(screen.getByDisplayValue('Refactors')).toBeInTheDocument())
    await userEvent.click(screen.getAllByRole('button', { name: 'Move down' })[0])

    // Task 5's server rejects a partial list, so the whole order goes at once.
    await waitFor(() =>
      expect(client.reorderEnvironments).toHaveBeenCalledWith('p1', ['env-2', 'env-1']),
    )
    expect(client.reorderEnvironments).toHaveBeenCalledTimes(1)
  })

  it('deletes an environment', async () => {
    const client = makeClient()
    render(<EnvironmentsPanel client={client as never} projectId="p1" />)

    await waitFor(() => expect(screen.getByDisplayValue('Refactors')).toBeInTheDocument())
    await userEvent.click(screen.getAllByRole('button', { name: /delete/i })[0])

    expect(client.deleteEnvironment).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: /confirm delete/i }))

    await waitFor(() => expect(client.deleteEnvironment).toHaveBeenCalledWith('env-1'))
    await waitFor(() => expect(screen.queryByDisplayValue('Refactors')).not.toBeInTheDocument())
  })

  it('keeps the row and surfaces the reason when a delete fails', async () => {
    const client = makeClient({
      deleteEnvironment: vi.fn().mockRejectedValue(new Error('environment is in use')),
    })
    render(<EnvironmentsPanel client={client as never} projectId="p1" />)

    await waitFor(() => expect(screen.getByDisplayValue('Refactors')).toBeInTheDocument())
    await userEvent.click(screen.getAllByRole('button', { name: /delete/i })[0])
    await userEvent.click(screen.getByRole('button', { name: /confirm delete/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/environment is in use/i)
    // A row that vanishes on a failed delete looks like the delete worked.
    expect(screen.getByDisplayValue('Refactors')).toBeInTheDocument()
  })

  it('adds an environment', async () => {
    const created = {
      id: 'env-3',
      projectId: 'p1',
      name: 'New environment',
      branchPattern: '**',
      position: 2,
      hasConfig: false,
      hasSnapshot: false,
      hasDraft: false,
    }
    const client = makeClient({ createEnvironment: vi.fn().mockResolvedValue(created) })
    render(<EnvironmentsPanel client={client as never} projectId="p1" />)

    await waitFor(() => expect(screen.getByDisplayValue('Refactors')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: 'New environment' }))

    await waitFor(() =>
      expect(client.createEnvironment).toHaveBeenCalledWith('p1', {
        name: 'New environment',
        branchPattern: '**',
      }),
    )
    expect(await screen.findByDisplayValue('New environment')).toBeInTheDocument()
  })

  it('still lets patterns be edited when the branch list cannot be loaded', async () => {
    const client = makeClient({
      listBranches: vi.fn().mockRejectedValue(new Error('github is down')),
    })
    render(<EnvironmentsPanel client={client as never} projectId="p1" />)

    const field = await screen.findByDisplayValue('refact/*')
    field.focus()
    fireEvent.change(field, { target: { value: 'feat/*' } })
    // Tab can miss this field when the branch-list error has extra focusable
    // chrome; blur is the event the row actually commits on.
    fireEvent.blur(field)

    await waitFor(() =>
      expect(client.updateEnvironment).toHaveBeenCalledWith('env-1', { branchPattern: 'feat/*' }),
    )
  })

  it('edits setup through EnvironmentReview without a setup session', async () => {
    const client = makeClient({
      getEnvironment: vi.fn().mockResolvedValue({
        config: {
          image: 'dukebox/base-node:latest',
          setup: ['pnpm install'],
          env: { NODE_ENV: 'test', DATABASE_URL: '${secret.DATABASE_URL}' },
          instructions: 'Use pnpm',
        },
        draft: null,
        secretNames: ['DATABASE_URL'],
      }),
    })
    render(<EnvironmentsPanel client={client as never} projectId="p1" />)

    const row = await rowFor('refact/*')
    await userEvent.click(within(row).getByRole('button', { name: 'Edit setup' }))

    await waitFor(() => expect(client.getEnvironment).toHaveBeenCalledWith('p1', 'env-1'))
    expect(client.getEnvironmentProposal).not.toHaveBeenCalled()

    expect(await screen.findByLabelText(/setup commands/i)).toHaveValue('pnpm install')
    expect(screen.getByRole('heading', { name: /edit setup/i })).toBeInTheDocument()
    expect(screen.getByLabelText(/agent instructions/i)).toHaveValue('Use pnpm')

    await userEvent.click(screen.getByRole('button', { name: 'Save environment' }))

    await waitFor(() =>
      expect(client.putEnvironment).toHaveBeenCalledWith(
        'p1',
        'env-1',
        expect.objectContaining({
          setup: ['pnpm install'],
          secretEnv: ['DATABASE_URL'],
          literalEnv: { NODE_ENV: 'test' },
        }),
      ),
    )
  })

  it('runs setup again on the existing environment rather than creating a sibling', async () => {
    const onRunSetup = vi.fn()
    const client = makeClient()
    render(<EnvironmentsPanel client={client as never} projectId="p1" onRunSetup={onRunSetup} />)

    const row = await rowFor('refact/*')
    await userEvent.click(within(row).getByRole('button', { name: 'Run setup again' }))

    expect(onRunSetup).toHaveBeenCalledWith('env-1')
    expect(onRunSetup).toHaveBeenCalledTimes(1)
    expect(client.createEnvironment).not.toHaveBeenCalled()
  })

  it('bumps the default name when "New environment" is already taken', async () => {
    const taken = [{ ...environments[0], name: 'New environment' }, ...environments.slice(1)]
    const created = {
      id: 'env-3',
      projectId: 'p1',
      name: 'New environment 2',
      branchPattern: '**',
      position: 2,
      hasConfig: false,
      hasSnapshot: false,
      hasDraft: false,
    }
    const client = makeClient({
      listEnvironments: vi.fn().mockResolvedValue(taken),
      createEnvironment: vi.fn().mockResolvedValue(created),
    })
    render(<EnvironmentsPanel client={client as never} projectId="p1" />)

    await waitFor(() => expect(screen.getByDisplayValue('New environment')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: 'New environment' }))

    // A duplicate name would bounce off the server's (project_id, name)
    // constraint, so the panel counts what is taken and asks for a free one.
    await waitFor(() =>
      expect(client.createEnvironment).toHaveBeenCalledWith('p1', {
        name: 'New environment 2',
        branchPattern: '**',
      }),
    )
  })
})
