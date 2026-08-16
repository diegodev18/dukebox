import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { OpenCodeProviders } from '@/components/OpenCodeProviders'

describe('OpenCodeProviders', () => {
  it('does not treat a failed list as no providers configured', async () => {
    const client = {
      listOpencodeProviders: vi.fn().mockRejectedValue(new Error('network')),
    }
    render(<OpenCodeProviders client={client as never} />)

    expect(await screen.findByRole('button', { name: /retry/i })).toBeInTheDocument()
    expect(screen.queryByText('No providers configured yet.')).not.toBeInTheDocument()
  })

  it('retries the list and then shows an empty configuration', async () => {
    const client = {
      listOpencodeProviders: vi
        .fn()
        .mockRejectedValueOnce(new Error('network'))
        .mockResolvedValue([]),
    }
    render(<OpenCodeProviders client={client as never} />)

    await userEvent.click(await screen.findByRole('button', { name: /retry/i }))

    expect(await screen.findByText('No providers configured yet.')).toBeInTheDocument()
    expect(client.listOpencodeProviders).toHaveBeenCalledTimes(2)
  })
})
