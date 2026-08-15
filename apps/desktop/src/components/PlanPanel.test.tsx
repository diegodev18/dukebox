import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { PlanPanel } from '@/components/PlanPanel'
import type { PlanTab } from '@/lib/plans'

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn(),
}))

function tab(overrides: Partial<PlanTab> = {}): PlanTab {
  return { id: 'p1', number: 1, plan: '# Ship it\n\n- Step one', status: 'pending', ...overrides }
}

describe('PlanPanel', () => {
  it('renders the plan as markdown', () => {
    render(<PlanPanel tab={tab()} onRespond={vi.fn()} />)

    expect(screen.getByRole('heading', { name: 'Ship it' })).toBeInTheDocument()
    expect(screen.getByText('Step one')).toBeInTheDocument()
  })

  it('builds the plan', async () => {
    const onRespond = vi.fn()
    render(<PlanPanel tab={tab()} onRespond={onRespond} />)

    await userEvent.click(screen.getByRole('button', { name: 'Build' }))

    expect(onRespond).toHaveBeenCalledWith('p1', true)
  })

  it('keeps planning', async () => {
    const onRespond = vi.fn()
    render(<PlanPanel tab={tab()} onRespond={onRespond} />)

    await userEvent.click(screen.getByRole('button', { name: 'Keep planning' }))

    expect(onRespond).toHaveBeenCalledWith('p1', false)
  })

  it('says building switches the session to Bypass', () => {
    render(<PlanPanel tab={tab()} onRespond={vi.fn()} />)

    expect(screen.getByText(/switches the session to Bypass/)).toBeInTheDocument()
  })

  it('drops the buttons once the plan is being built', () => {
    render(<PlanPanel tab={tab({ status: 'built' })} onRespond={vi.fn()} />)

    expect(screen.getByText('Building this plan.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Build' })).not.toBeInTheDocument()
  })

  it('says so when a plan was settled without being built', () => {
    render(<PlanPanel tab={tab({ status: 'closed' })} onRespond={vi.fn()} />)

    expect(screen.getByText('This plan was not built.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Build' })).not.toBeInTheDocument()
  })

  it('cannot answer while the socket is down', () => {
    render(<PlanPanel tab={tab()} onRespond={vi.fn()} disabled />)

    expect(screen.getByRole('button', { name: 'Build' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Keep planning' })).toBeDisabled()
  })
})
