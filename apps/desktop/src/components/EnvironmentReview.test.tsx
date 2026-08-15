import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { EnvironmentReview } from '@/components/EnvironmentReview'

function makeClient(overrides = {}) {
  return {
    getEnvironmentProposal: vi.fn().mockResolvedValue({
      setup: ['pnpm install'],
      env: {},
      verification: { ok: true },
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
    expect(screen.getByRole('status')).toHaveTextContent(/no longer verified/i)
  })

  it('reports a successful clean-clone verify', async () => {
    render(
      <EnvironmentReview
        client={makeClient() as never}
        projectId="p1"
        sessionId="s1"
        environmentId="e1"
        environmentName="Default"
        onSaved={vi.fn()}
      />,
    )

    expect(await screen.findByRole('status')).toHaveTextContent(/clean clone/i)
  })

  it('reports a failed verify without blocking save', async () => {
    const client = makeClient({
      getEnvironmentProposal: vi.fn().mockResolvedValue({
        setup: ['false'],
        env: {},
        verification: { ok: false, error: 'exit 1' },
      }),
    })
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

    expect(await screen.findByRole('status')).toHaveTextContent(/failed: exit 1/i)
    expect(screen.getByRole('button', { name: 'Save environment' })).toBeEnabled()
  })

  it('explains when verify was skipped for a different image', async () => {
    const client = makeClient({
      getEnvironmentProposal: vi.fn().mockResolvedValue({
        setup: ['pnpm install'],
        env: {},
        image: 'some/other:latest',
        verification: { ok: false, skippedReason: 'image_mismatch' },
      }),
    })
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

    expect(await screen.findByRole('status')).toHaveTextContent(/different container image/i)
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

  it('does not offer save when the proposal failed to load', async () => {
    const client = makeClient({
      getEnvironmentProposal: vi.fn().mockRejectedValue(new Error('network down')),
    })
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

    expect(await screen.findByRole('alert')).toHaveTextContent(/network down/i)
    expect(screen.queryByRole('button', { name: 'Save environment' })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(client.getEnvironmentProposal).toHaveBeenCalledTimes(2))
  })
})
