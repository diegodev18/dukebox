import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Composer } from '@/components/Composer'

describe('Composer', () => {
  it('does not clear the draft while the agent is running', async () => {
    const onSend = vi.fn()
    render(<Composer onSend={onSend} onInterrupt={vi.fn()} running />)

    await userEvent.type(screen.getByLabelText('Message'), 'follow up')
    await userEvent.keyboard('{Enter}')

    expect(onSend).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Message')).toHaveValue('follow up')
  })

  it('restores the draft when a send is rejected', async () => {
    const onSend = vi.fn()
    const { rerender } = render(
      <Composer onSend={onSend} onInterrupt={vi.fn()} running={false} error={null} />,
    )

    await userEvent.type(screen.getByLabelText('Message'), 'do a thing')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(onSend).toHaveBeenCalledWith('do a thing')
    expect(screen.getByLabelText('Message')).toHaveValue('')

    rerender(<Composer onSend={onSend} onInterrupt={vi.fn()} running={false} error="rejected" />)

    expect(screen.getByLabelText('Message')).toHaveValue('do a thing')
    expect(screen.getByRole('alert')).toHaveTextContent('rejected')
  })

  it('does not send while disabled', async () => {
    const onSend = vi.fn()
    render(<Composer onSend={onSend} onInterrupt={vi.fn()} running={false} disabled />)

    const field = screen.getByLabelText('Message')
    expect(field).toBeDisabled()
    expect(field).toHaveAttribute('placeholder', 'Waiting for connection…')
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })

  it('does not interrupt while disabled', () => {
    const onInterrupt = vi.fn()
    render(<Composer onSend={vi.fn()} onInterrupt={onInterrupt} running disabled />)

    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled()
  })

  it('hints how to send', () => {
    render(<Composer onSend={vi.fn()} onInterrupt={vi.fn()} running={false} />)

    expect(screen.getByText(/↵ Send/)).toBeInTheDocument()
    expect(screen.queryByText(/⇧⇥ Mode/)).not.toBeInTheDocument()
  })

  it('hints Shift+Tab when the session has modes', () => {
    render(
      <Composer
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        running={false}
        permissionMode="plan"
        onPermissionModeChange={vi.fn()}
      />,
    )

    expect(screen.getByText(/⇧⇥ Mode/)).toBeInTheDocument()
  })

  it('shows a permission mode picker when the session has modes', () => {
    render(
      <Composer
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        running={false}
        permissionMode="plan"
        onPermissionModeChange={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: 'Permission mode' })).toBeInTheDocument()
    expect(screen.getByText('Plan')).toBeInTheDocument()
  })

  it('hides the picker when the agent has no modes', () => {
    render(<Composer onSend={vi.fn()} onInterrupt={vi.fn()} running={false} />)

    expect(screen.queryByRole('button', { name: 'Permission mode' })).not.toBeInTheDocument()
  })

  it('notifies when the mode changes', async () => {
    const onPermissionModeChange = vi.fn()
    render(
      <Composer
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        running={false}
        permissionMode="plan"
        onPermissionModeChange={onPermissionModeChange}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Permission mode' }))
    await userEvent.click(screen.getByRole('option', { name: 'Auto' }))

    expect(onPermissionModeChange).toHaveBeenCalledWith('auto')
  })

  it('cycles the permission mode with Shift+Tab', async () => {
    const onPermissionModeChange = vi.fn()
    render(
      <Composer
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        running={false}
        permissionMode="plan"
        onPermissionModeChange={onPermissionModeChange}
      />,
    )

    await userEvent.type(screen.getByLabelText('Message'), '{Shift>}{Tab}{/Shift}')

    expect(onPermissionModeChange).toHaveBeenCalledWith('auto')
  })

  it('wraps Shift+Tab from Bypass back to Plan', async () => {
    const onPermissionModeChange = vi.fn()
    render(
      <Composer
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        running={false}
        permissionMode="bypass"
        onPermissionModeChange={onPermissionModeChange}
      />,
    )

    await userEvent.type(screen.getByLabelText('Message'), '{Shift>}{Tab}{/Shift}')

    expect(onPermissionModeChange).toHaveBeenCalledWith('plan')
  })

  it('only offers Plan and Bypass for OpenCode', async () => {
    render(
      <Composer
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        running={false}
        permissionMode="plan"
        onPermissionModeChange={vi.fn()}
        agentId="opencode"
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Permission mode' }))

    expect(screen.getByRole('option', { name: 'Plan' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Bypass' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Auto' })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Accept edits' })).not.toBeInTheDocument()
  })

  it('cycles OpenCode from Plan to Bypass with Shift+Tab', async () => {
    const onPermissionModeChange = vi.fn()
    render(
      <Composer
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        running={false}
        permissionMode="plan"
        onPermissionModeChange={onPermissionModeChange}
        agentId="opencode"
      />,
    )

    await userEvent.type(screen.getByLabelText('Message'), '{Shift>}{Tab}{/Shift}')

    expect(onPermissionModeChange).toHaveBeenCalledWith('bypass')
  })

  it('leaves Shift+Tab alone when the agent has no modes', async () => {
    const onPermissionModeChange = vi.fn()
    render(<Composer onSend={vi.fn()} onInterrupt={vi.fn()} running={false} />)

    await userEvent.type(screen.getByLabelText('Message'), '{Shift>}{Tab}{/Shift}')

    expect(onPermissionModeChange).not.toHaveBeenCalled()
  })

  it('attaches files and sends them with the prompt', async () => {
    const onSend = vi.fn()
    const { container } = render(<Composer onSend={onSend} onInterrupt={vi.fn()} running={false} />)

    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, {
      target: { files: [new File(['hello'], 'notes.txt', { type: 'text/plain' })] },
    })

    expect(await screen.findByText('notes.txt')).toBeInTheDocument()

    await userEvent.type(screen.getByLabelText('Message'), 'read this')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(onSend).toHaveBeenCalledWith('read this', [
      expect.objectContaining({
        name: 'notes.txt',
        data: expect.stringMatching(/^data:text\/plain;base64,/),
      }),
    ])
    expect(screen.queryByText('notes.txt')).not.toBeInTheDocument()
  })

  it('attaches several files at once', async () => {
    const { container } = render(
      <Composer onSend={vi.fn()} onInterrupt={vi.fn()} running={false} />,
    )

    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, {
      target: {
        files: [
          new File(['a'], 'one.txt', { type: 'text/plain' }),
          new File(['b'], 'two.txt', { type: 'text/plain' }),
        ],
      },
    })

    expect(await screen.findByText('one.txt')).toBeInTheDocument()
    expect(await screen.findByText('two.txt')).toBeInTheDocument()
  })

  it('removes an attached file from the draft', async () => {
    const { container } = render(
      <Composer onSend={vi.fn()} onInterrupt={vi.fn()} running={false} />,
    )

    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'drop.txt', { type: 'text/plain' })] },
    })

    await screen.findByText('drop.txt')
    await userEvent.click(screen.getByRole('button', { name: 'Remove drop.txt' }))

    expect(screen.queryByText('drop.txt')).not.toBeInTheDocument()
  })

  it('restores attached files when a send is rejected', async () => {
    const onSend = vi.fn()
    const { container, rerender } = render(
      <Composer onSend={onSend} onInterrupt={vi.fn()} running={false} error={null} />,
    )

    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'report.pdf', { type: 'application/pdf' })] },
    })
    await screen.findByText('report.pdf')

    await userEvent.type(screen.getByLabelText('Message'), 'look at this')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(screen.queryByText('report.pdf')).not.toBeInTheDocument()

    rerender(<Composer onSend={onSend} onInterrupt={vi.fn()} running={false} error="rejected" />)

    expect(screen.getByLabelText('Message')).toHaveValue('look at this')
    expect(screen.getByText('report.pdf')).toBeInTheDocument()
  })

  it('disables attaching while disconnected', () => {
    render(<Composer onSend={vi.fn()} onInterrupt={vi.fn()} running={false} disabled />)

    expect(screen.getByRole('button', { name: 'Attach files' })).toBeDisabled()
  })

  it('fills the field when a transcript prompt is edited', () => {
    render(
      <Composer
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        running={false}
        draft={{ text: 'fix the parser', key: 1 }}
      />,
    )

    const field = screen.getByLabelText('Message')
    expect(field).toHaveValue('fix the parser')
    expect(field).toHaveFocus()
  })

  it('refills the field when the same prompt is edited again', () => {
    const { rerender } = render(
      <Composer
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        running={false}
        draft={{ text: 'first', key: 1 }}
      />,
    )

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'typed over' } })
    expect(screen.getByLabelText('Message')).toHaveValue('typed over')

    rerender(
      <Composer
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        running={false}
        draft={{ text: 'first', key: 2 }}
      />,
    )

    expect(screen.getByLabelText('Message')).toHaveValue('first')
    expect(screen.getByLabelText('Message')).toHaveFocus()
  })
})

describe('Composer drag and drop', () => {
  function composerBox() {
    const field = screen.getByLabelText('Message')
    const box = field.closest('.measure')
    if (!box) throw new Error('expected the composer box')
    return box as HTMLElement
  }

  function fileDrag(...files: File[]) {
    return { dataTransfer: { types: ['Files'], files } }
  }

  it('attaches dropped files and sends them with the prompt', async () => {
    const onSend = vi.fn()
    render(<Composer onSend={onSend} onInterrupt={vi.fn()} running={false} />)

    fireEvent.drop(
      composerBox(),
      fileDrag(new File(['hello'], 'notes.txt', { type: 'text/plain' })),
    )

    expect(await screen.findByText('notes.txt')).toBeInTheDocument()

    await userEvent.type(screen.getByLabelText('Message'), 'read this')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(onSend).toHaveBeenCalledWith('read this', [
      expect.objectContaining({
        name: 'notes.txt',
        data: expect.stringMatching(/^data:text\/plain;base64,/),
      }),
    ])
    expect(screen.queryByText('notes.txt')).not.toBeInTheDocument()
  })

  it('attaches several dropped files at once', async () => {
    render(<Composer onSend={vi.fn()} onInterrupt={vi.fn()} running={false} />)

    fireEvent.drop(
      composerBox(),
      fileDrag(
        new File(['a'], 'one.txt', { type: 'text/plain' }),
        new File(['b'], 'two.txt', { type: 'text/plain' }),
      ),
    )

    expect(await screen.findByText('one.txt')).toBeInTheDocument()
    expect(await screen.findByText('two.txt')).toBeInTheDocument()
  })

  it('highlights the box while a file drag is over and clears on drop', async () => {
    render(<Composer onSend={vi.fn()} onInterrupt={vi.fn()} running={false} />)

    const box = composerBox()
    fireEvent.dragEnter(box, fileDrag(new File(['x'], 'x.txt')))
    expect(await screen.findByText('Drop to attach')).toBeInTheDocument()

    fireEvent.drop(box, fileDrag(new File(['x'], 'x.txt')))

    expect(screen.queryByText('Drop to attach')).not.toBeInTheDocument()
    expect(await screen.findByText('x.txt')).toBeInTheDocument()
  })

  it('ignores drags that do not carry files', () => {
    render(<Composer onSend={vi.fn()} onInterrupt={vi.fn()} running={false} />)

    fireEvent.dragEnter(composerBox(), { dataTransfer: { types: ['text/plain'] } })

    expect(screen.queryByText('Drop to attach')).not.toBeInTheDocument()
  })

  it('does not attach dropped files while disconnected', () => {
    render(<Composer onSend={vi.fn()} onInterrupt={vi.fn()} running={false} disabled />)

    fireEvent.drop(composerBox(), fileDrag(new File(['x'], 'notes.txt', { type: 'text/plain' })))

    expect(screen.queryByText('notes.txt')).not.toBeInTheDocument()
  })
})
