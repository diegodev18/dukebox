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

  it('focuses Allow when a permission prompt appears', () => {
    render(
      <Transcript
        transcript={transcript({
          blocks: [{ kind: 'permission', id: 'p1', action: 'run a command', detail: null }],
        })}
        onRespond={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: 'Allow' })).toHaveFocus()
  })

  it('does not answer a permission while disconnected', async () => {
    const onRespond = vi.fn()
    render(
      <Transcript
        transcript={transcript({
          blocks: [{ kind: 'permission', id: 'p1', action: 'run a command', detail: null }],
        })}
        onRespond={onRespond}
        disabled
      />,
    )

    expect(screen.getByRole('button', { name: 'Allow' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Deny' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Allow' }))
    expect(onRespond).not.toHaveBeenCalled()
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

  it('copies a user prompt to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })

    render(
      <Transcript
        transcript={transcript({
          blocks: [{ kind: 'prompt', id: 'p', text: 'fix the parser' }],
        })}
        onRespond={vi.fn()}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Copy' }))

    expect(writeText).toHaveBeenCalledWith('fix the parser')
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })

  it('loads a user prompt into the composer when edited', async () => {
    const onEdit = vi.fn()
    render(
      <Transcript
        transcript={transcript({
          blocks: [{ kind: 'prompt', id: 'p', text: 'rename the widget' }],
        })}
        onRespond={vi.fn()}
        onEdit={onEdit}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))

    expect(onEdit).toHaveBeenCalledWith('rename the widget')
  })

  it('does not offer edit on the seeded environment-setup prompt', () => {
    render(
      <Transcript
        transcript={transcript({
          blocks: [{ kind: 'prompt', id: 'setup', text: 'Configure the sandbox.' }],
        })}
        onRespond={vi.fn()}
        onEdit={vi.fn()}
        purpose="environment_setup"
      />,
    )

    expect(screen.getByRole('button', { name: 'Configure environment' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument()
  })

  it('copies assistant text and does not offer edit', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })

    render(
      <Transcript
        transcript={transcript({
          blocks: [{ kind: 'text', id: 't', text: 'I found the bug.' }],
        })}
        onRespond={vi.fn()}
        onEdit={vi.fn()}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Copy' }))

    expect(writeText).toHaveBeenCalledWith('I found the bug.')
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
  })

  it('does not edit a prompt while disconnected', async () => {
    const onEdit = vi.fn()
    render(
      <Transcript
        transcript={transcript({
          blocks: [{ kind: 'prompt', id: 'p', text: 'try again' }],
        })}
        onRespond={vi.fn()}
        onEdit={onEdit}
        disabled
      />,
    )

    expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(onEdit).not.toHaveBeenCalled()
  })
})
