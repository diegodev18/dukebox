import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn(),
}))

import { PlanPanel } from '@/components/PlanPanel'

describe('PlanPanel', () => {
  it('renders the plan as markdown', () => {
    render(<PlanPanel plan={'# Plan\n\n1. Read `execStream`'} onBuild={vi.fn()} />)

    expect(screen.getByRole('heading', { name: 'Plan' })).toBeInTheDocument()
    expect(screen.getByRole('listitem')).toHaveTextContent('Read execStream')
    expect(screen.getByRole('listitem').querySelector('code')).toHaveTextContent('execStream')
  })

  it('calls onBuild when Build is clicked', async () => {
    const onBuild = vi.fn()
    render(<PlanPanel plan={'Do the thing'} ready onBuild={onBuild} />)

    await userEvent.click(screen.getByRole('button', { name: 'Build' }))
    expect(onBuild).toHaveBeenCalledTimes(1)
  })

  it('disables Build while the plan is not ready', () => {
    render(<PlanPanel plan={'Do the thing'} onBuild={vi.fn()} />)

    expect(screen.getByRole('button', { name: 'Build' })).toBeDisabled()
  })

  it('says Building while an approved plan runs', () => {
    render(<PlanPanel plan={'Do the thing'} running ready={false} onBuild={vi.fn()} />)

    expect(screen.getByRole('button', { name: 'Building…' })).toBeDisabled()
  })

  it('explains itself when there is no plan yet', () => {
    render(<PlanPanel plan="" onBuild={vi.fn()} />)

    expect(
      screen.getByText('There is no plan yet. Ask in Plan mode to draft one.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Build' })).not.toBeInTheDocument()
  })

  it('shows drafting state while the plan is being written', () => {
    render(<PlanPanel plan="" running onBuild={vi.fn()} />)

    expect(screen.getByText('Drafting the plan…')).toBeInTheDocument()
  })
})
