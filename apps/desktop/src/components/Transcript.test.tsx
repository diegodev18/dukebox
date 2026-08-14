import { emptyTranscript, type Transcript as TranscriptData } from '@dukebox/protocol'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Transcript } from '@/components/Transcript'

vi.mock('thinking-orbs', () => ({
  ThinkingOrb: ({ 'aria-label': label }: { 'aria-label'?: string }) =>
    label ? <span aria-label={label} /> : null,
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

  it('copies the last assistant message of each turn, not the interim ones', () => {
    render(
      <Transcript
        transcript={transcript({
          blocks: [
            { kind: 'prompt', id: 'p1', text: 'investigate' },
            { kind: 'text', id: 'interim', text: 'Looking into it.' },
            { kind: 'text', id: 'answer1', text: 'The bug is in the parser.' },
            { kind: 'prompt', id: 'p2', text: 'fix it' },
            { kind: 'text', id: 'answer2', text: 'Fixed and verified.' },
          ],
        })}
        onRespond={vi.fn()}
      />,
    )

    // Both prompts plus the final answer of each turn get a copy button.
    expect(screen.getAllByRole('button', { name: 'Copy' })).toHaveLength(4)
    expect(
      within(screen.getByText('The bug is in the parser.').closest('.group')!).getByRole('button', {
        name: 'Copy',
      }),
    ).toBeInTheDocument()
    expect(
      within(screen.getByText('Fixed and verified.').closest('.group')!).getByRole('button', {
        name: 'Copy',
      }),
    ).toBeInTheDocument()
    expect(
      within(screen.getByText('Looking into it.').closest('.group')!).queryByRole('button', {
        name: 'Copy',
      }),
    ).not.toBeInTheDocument()
  })

  it('does not copy the in-progress turn until the agent finishes it', () => {
    const { rerender } = render(
      <Transcript
        transcript={transcript({
          running: true,
          blocks: [
            { kind: 'prompt', id: 'p1', text: 'fix it' },
            { kind: 'text', id: 'answer', text: 'On it…' },
          ],
        })}
        onRespond={vi.fn()}
        running
        status="running"
      />,
    )

    // Only the prompt is copyable while the answer is still streaming.
    expect(screen.getAllByRole('button', { name: 'Copy' })).toHaveLength(1)
    expect(
      within(screen.getByText('On it…').closest('.group')!).queryByRole('button', {
        name: 'Copy',
      }),
    ).not.toBeInTheDocument()

    rerender(
      <Transcript
        transcript={transcript({
          running: false,
          blocks: [
            { kind: 'prompt', id: 'p1', text: 'fix it' },
            { kind: 'text', id: 'answer', text: 'On it…' },
          ],
        })}
        onRespond={vi.fn()}
        running={false}
        status="done"
      />,
    )

    // Once the turn settles, the answer is the copyable one.
    expect(screen.getAllByRole('button', { name: 'Copy' })).toHaveLength(2)
    expect(
      within(screen.getByText('On it…').closest('.group')!).getByRole('button', {
        name: 'Copy',
      }),
    ).toBeInTheDocument()
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

  it('renders streaming assistant text as plain prose', () => {
    render(
      <Transcript
        transcript={transcript({
          running: true,
          blocks: [
            { kind: 'prompt', id: 'p', text: 'hi' },
            { kind: 'text', id: 't', text: 'Hello **world**' },
          ],
        })}
        onRespond={vi.fn()}
        running
      />,
    )

    expect(screen.getByText(/Hello/)).toBeInTheDocument()
    expect(document.querySelector('strong')).toBeNull()
  })

  it('renders markdown once the turn has settled', () => {
    render(
      <Transcript
        transcript={transcript({
          running: false,
          blocks: [{ kind: 'text', id: 't', text: 'Hello **world**' }],
        })}
        onRespond={vi.fn()}
      />,
    )

    expect(document.querySelector('strong')).not.toBeNull()
  })
})

function done(output = 'ok'): { output: string; isError: boolean } {
  return { output, isError: false }
}

describe('Transcript tool groups', () => {
  it('collapses consecutive search tools into one summary', () => {
    render(
      <Transcript
        transcript={transcript({
          blocks: [
            {
              kind: 'tool',
              id: 'r',
              name: 'Read',
              input: { file_path: 'packages/sandbox/src/container.ts' },
              result: done(),
            },
            {
              kind: 'tool',
              id: 'g',
              name: 'Grep',
              input: { pattern: 'execStream', path: 'packages/sandbox' },
              result: done('3 matches'),
            },
            {
              kind: 'tool',
              id: 'gl',
              name: 'Glob',
              input: { pattern: '**/*.ts' },
              result: done(),
            },
          ],
        })}
        onRespond={vi.fn()}
      />,
    )

    expect(screen.getByText('Explored 3 files')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Show Read' })).not.toBeInTheDocument()
  })

  it('reveals individual rows when a group is expanded', async () => {
    render(
      <Transcript
        transcript={transcript({
          blocks: [
            {
              kind: 'tool',
              id: 'r',
              name: 'Read',
              input: { file_path: 'packages/sandbox/src/container.ts' },
              result: done(),
            },
            {
              kind: 'tool',
              id: 'g',
              name: 'Grep',
              input: { pattern: 'execStream' },
              result: done('3 matches'),
            },
          ],
        })}
        onRespond={vi.fn()}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Show Explored 2 files' }))

    expect(screen.getByRole('button', { name: 'Show Read' })).toBeInTheDocument()
    expect(screen.getByText('container.ts')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show Grep' })).toBeInTheDocument()
  })

  it('does not wrap a single tool in a group', () => {
    render(
      <Transcript
        transcript={transcript({
          blocks: [
            {
              kind: 'tool',
              id: 'r',
              name: 'Read',
              input: { file_path: 'packages/sandbox/src/container.ts' },
              result: done(),
            },
          ],
        })}
        onRespond={vi.fn()}
      />,
    )

    expect(screen.queryByText(/Explored/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show Read' })).toBeInTheDocument()
    expect(screen.getByText('container.ts')).toBeInTheDocument()
    expect(screen.queryByText('packages/sandbox/src/container.ts')).not.toBeInTheDocument()
  })

  it('does not group tools split by assistant text', () => {
    render(
      <Transcript
        transcript={transcript({
          blocks: [
            {
              kind: 'tool',
              id: 'r',
              name: 'Read',
              input: { file_path: 'a.ts' },
              result: done(),
            },
            { kind: 'text', id: 't', text: 'Looking further.' },
            {
              kind: 'tool',
              id: 'g',
              name: 'Grep',
              input: { pattern: 'x' },
              result: done(),
            },
          ],
        })}
        onRespond={vi.fn()}
      />,
    )

    expect(screen.queryByText(/Explored/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show Read' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show Grep' })).toBeInTheDocument()
  })

  it('auto-expands a live group and shows the running tool', () => {
    render(
      <Transcript
        transcript={transcript({
          running: true,
          blocks: [
            {
              kind: 'tool',
              id: 'r',
              name: 'Read',
              input: { file_path: 'a.ts' },
              result: done(),
            },
            { kind: 'tool', id: 'g', name: 'Grep', input: { pattern: 'demuxStream' } },
          ],
        })}
        onRespond={vi.fn()}
        status="running"
      />,
    )

    expect(screen.getByRole('button', { name: 'Hide Searched demuxStream' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show Read' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show Grep' })).toBeInTheDocument()
    expect(screen.getAllByLabelText('Grep running').length).toBeGreaterThan(0)
  })

  it('marks a group failed when any tool errored', () => {
    render(
      <Transcript
        transcript={transcript({
          blocks: [
            {
              kind: 'tool',
              id: 'r',
              name: 'Read',
              input: { file_path: 'a.ts' },
              result: done(),
            },
            {
              kind: 'tool',
              id: 'b',
              name: 'Bash',
              input: { command: 'pnpm test' },
              result: { output: 'FAIL', isError: true },
            },
          ],
        })}
        onRespond={vi.fn()}
      />,
    )

    expect(screen.getByText('2 actions')).toBeInTheDocument()
    expect(screen.getByText('failed')).toBeInTheDocument()
  })

  it('summarises a shell-only run as commands', () => {
    render(
      <Transcript
        transcript={transcript({
          blocks: [
            {
              kind: 'tool',
              id: 'a',
              name: 'Bash',
              input: { command: 'ls' },
              result: done(),
            },
            {
              kind: 'tool',
              id: 'b',
              name: 'Bash',
              input: { command: 'pnpm test' },
              result: done(),
            },
          ],
        })}
        onRespond={vi.fn()}
      />,
    )

    expect(screen.getByText('Ran 2 commands')).toBeInTheDocument()
  })

  it('does not let thinking split a tool group', () => {
    render(
      <Transcript
        transcript={transcript({
          blocks: [
            {
              kind: 'tool',
              id: 'g1',
              name: 'Grep',
              input: { pattern: 'rename' },
              result: done(),
            },
            { kind: 'thinking', id: 'th1', text: 'checking the protocol next' },
            {
              kind: 'tool',
              id: 'g2',
              name: 'Glob',
              input: { pattern: '**/api.ts' },
              result: done(),
            },
          ],
        })}
        onRespond={vi.fn()}
      />,
    )

    expect(screen.getByText('Explored 2 files')).toBeInTheDocument()
    expect(screen.queryByText('Thought for a moment')).not.toBeInTheDocument()
  })

  it('shows thinking inside an expanded tool group', async () => {
    render(
      <Transcript
        transcript={transcript({
          blocks: [
            {
              kind: 'tool',
              id: 'g1',
              name: 'Grep',
              input: { pattern: 'rename' },
              result: done(),
            },
            { kind: 'thinking', id: 'th1', text: 'checking the protocol next' },
            {
              kind: 'tool',
              id: 'g2',
              name: 'Glob',
              input: { pattern: '**/api.ts' },
              result: done(),
            },
          ],
        })}
        onRespond={vi.fn()}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Show Explored 2 files' }))

    expect(screen.getByText('Thought for a moment')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show Grep' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show Glob' })).toBeInTheDocument()
  })
})

describe('Transcript message actions', () => {
  it('keeps copy actions out of the message layout', () => {
    render(
      <Transcript
        transcript={transcript({
          blocks: [{ kind: 'prompt', id: 'p', text: 'Si' }],
        })}
        onRespond={vi.fn()}
        onEdit={vi.fn()}
      />,
    )

    const actions = screen.getByRole('button', { name: 'Copy' }).parentElement
    expect(actions).toHaveClass('absolute')
  })
})
