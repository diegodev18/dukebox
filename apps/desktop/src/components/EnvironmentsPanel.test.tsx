import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { EnvironmentsPanel } from './EnvironmentsPanel.js'

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
    await userEvent.clear(field)
    await userEvent.type(field, 'nope/*')

    const row = await rowFor('nope/*')
    await waitFor(() => expect(within(row).getByText('Matches no branches')).toBeInTheDocument())
  })

  it('shows a validation error for an unsafe pattern', async () => {
    render(<EnvironmentsPanel client={makeClient() as never} projectId="p1" />)

    const field = await screen.findByDisplayValue('refact/*')
    await userEvent.clear(field)
    await userEvent.type(field, 're:(a+)+')

    await waitFor(() => expect(screen.getByText(/nested quantifiers/i)).toBeInTheDocument())
  })

  it('commits a name on blur, not per keystroke', async () => {
    const client = makeClient()
    render(<EnvironmentsPanel client={client as never} projectId="p1" />)

    const field = await screen.findByDisplayValue('Refactors')
    await userEvent.clear(field)
    await userEvent.type(field, 'Rewrites')

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

    const field = await screen.findByDisplayValue('refact/*')
    await userEvent.clear(field)
    await userEvent.type(field, 're:(a+)+')
    await userEvent.tab()

    await waitFor(() => expect(screen.getByText(/nested quantifiers/i)).toBeInTheDocument())
    expect(client.updateEnvironment).not.toHaveBeenCalled()
  })

  it('commits a valid pattern on blur', async () => {
    const client = makeClient()
    render(<EnvironmentsPanel client={client as never} projectId="p1" />)

    const field = await screen.findByDisplayValue('refact/*')
    await userEvent.clear(field)
    await userEvent.type(field, 'feat/*')
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
    await userEvent.clear(field)
    await userEvent.type(field, 'feat/*')
    await userEvent.tab()

    await waitFor(() =>
      expect(client.updateEnvironment).toHaveBeenCalledWith('env-1', { branchPattern: 'feat/*' }),
    )
  })
})
