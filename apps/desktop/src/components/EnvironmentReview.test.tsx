import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { EnvironmentReview } from './EnvironmentReview.js'

function makeClient(overrides = {}) {
  return {
    getEnvironmentProposal: vi.fn().mockResolvedValue({
      setup: ['pnpm install'],
      env: {},
    }),
    getEnvironment: vi.fn().mockResolvedValue({
      draft: null,
      secretNames: [],
    }),
    putEnvironment: vi.fn().mockResolvedValue({}),
    ...overrides,
  }
}

describe('EnvironmentReview', () => {
  it('lets the form be saved again after an edit', async () => {
    const client = makeClient()
    render(
      <EnvironmentReview
        client={client as never}
        projectId="p1"
        sessionId="s1"
        environmentId="e1"
        environmentName="Default"
        onSaved={vi.fn()}
      />,
    )

    await userEvent.click(await screen.findByRole('button', { name: 'Save environment' }))
    expect(await screen.findByRole('button', { name: 'Saved' })).toBeDisabled()

    await userEvent.type(screen.getByLabelText(/setup commands/i), '\npnpm test')
    expect(screen.getByRole('button', { name: 'Save environment' })).toBeEnabled()
  })

  it('reports a missing environment rather than offering a save that cannot work', async () => {
    render(
      <EnvironmentReview
        client={makeClient() as never}
        projectId="p1"
        sessionId="s1"
        environmentId={null}
        environmentName={null}
        onSaved={vi.fn()}
      />,
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(/not attached to an environment/i)
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument(),
    )
  })
})
