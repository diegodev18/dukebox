import { emptyTranscript, type Transcript as TranscriptData } from '@dukebox/protocol'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Transcript } from '@/components/Transcript'

vi.mock('thinking-orbs', () => ({
  ThinkingOrb: () => null,
}))

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn(),
}))

function transcript(overrides: Partial<TranscriptData> = {}): TranscriptData {
  return { ...emptyTranscript(), ...overrides }
}

describe('Transcript', () => {
  it('asks for a change when a coding session has nothing yet', () => {
    render(<Transcript transcript={transcript()} onRespond={vi.fn()} streamStatus="live" />)

    expect(screen.getByText('Ask for a change to start.')).toBeInTheDocument()
  })

  it('says the conversation is loading while catching up', () => {
    render(<Transcript transcript={transcript()} onRespond={vi.fn()} streamStatus="catching_up" />)

    expect(screen.getByText('Loading conversation…')).toBeInTheDocument()
  })

  it('waits for the agent on an empty environment-setup session', () => {
    render(
      <Transcript
        transcript={transcript()}
        onRespond={vi.fn()}
        purpose="environment_setup"
        streamStatus="live"
      />,
    )

    expect(screen.getByText('Waiting for the agent…')).toBeInTheDocument()
  })

  it('disables a permission once it is answered', async () => {
    const onRespond = vi.fn()
    render(
      <Transcript
        transcript={transcript({
          blocks: [{ kind: 'permission', id: 'p1', action: 'run a command', detail: null }],
        })}
        onRespond={onRespond}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Allow' }))

    expect(onRespond).toHaveBeenCalledWith('p1', true)
    expect(screen.getByText('Allowed run a command')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument()
  })

  it('offers to implement a plan rather than allow a generic tool', async () => {
    const onRespond = vi.fn()
    render(
      <Transcript
        transcript={transcript({
          blocks: [{ kind: 'permission', id: 'p1', action: 'exit_plan_mode', detail: null }],
        })}
        onRespond={onRespond}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Implement' }))

    expect(onRespond).toHaveBeenCalledWith('p1', true)
    expect(screen.getByText('Implementing the plan')).toBeInTheDocument()
  })

  it('keeps planning when the plan is not approved', async () => {
    const onRespond = vi.fn()
    render(
      <Transcript
        transcript={transcript({
          blocks: [{ kind: 'permission', id: 'p1', action: 'exit_plan_mode', detail: null }],
        })}
        onRespond={onRespond}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Keep planning' }))

    expect(onRespond).toHaveBeenCalledWith('p1', false)
    expect(screen.getByText('Kept planning')).toBeInTheDocument()
  })

  it('shows Working while a live session is producing output', () => {
    render(
      <Transcript
        transcript={transcript({
          running: true,
          blocks: [{ kind: 'prompt', id: 'p', text: 'hi' }],
        })}
        onRespond={vi.fn()}
        status="running"
      />,
    )

    expect(screen.getByRole('status', { name: 'Working' })).toBeInTheDocument()
  })

  it('does not show Working when the session has stopped', () => {
    render(
      <Transcript
        transcript={transcript({
          running: true,
          blocks: [{ kind: 'prompt', id: 'p', text: 'hi' }],
        })}
        onRespond={vi.fn()}
        status="stopped"
      />,
    )

    expect(screen.queryByRole('status', { name: 'Working' })).not.toBeInTheDocument()
  })
})
