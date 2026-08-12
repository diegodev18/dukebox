import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@dukebox/protocol'
import { RemoteControl } from '@/components/RemoteControl'

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}))

const session = {
  id: '00000000-0000-4000-8000-000000000000',
  projectId: '00000000-0000-4000-8000-000000000001',
  agentId: 'claude-code',
  status: 'running',
  purpose: 'coding',
  title: 'A session',
  branch: 'duke/abc',
  baseBranch: 'main',
  changedFileCount: 0,
  createdAt: 1,
  updatedAt: 1,
  lastSeq: 0,
  pullRequestUrl: null,
  environmentId: null,
  permissionMode: 'bypass',
  remoteControlUrl: null,
} as SessionSummary

describe('RemoteControl', () => {
  it('hides for an agent that cannot enable it', () => {
    render(
      <RemoteControl
        session={{ ...session, agentId: 'opencode' }}
        enabled={false}
        url={null}
        onChange={vi.fn()}
      />,
    )

    expect(screen.queryByRole('button', { name: 'Remote control' })).not.toBeInTheDocument()
  })

  it('offers to enable Remote Control when it is off', async () => {
    const onChange = vi.fn()
    render(<RemoteControl session={session} enabled={false} url={null} onChange={onChange} />)

    await userEvent.click(screen.getByRole('button', { name: 'Remote control' }))
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('shows connecting while waiting for a URL', () => {
    render(
      <RemoteControl session={session} enabled={true} url={null} connecting onChange={vi.fn()} />,
    )

    expect(screen.getByText('Connecting…')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remote control' })).not.toBeInTheDocument()
  })

  it('opens the remote session and can turn it off', async () => {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    const onChange = vi.fn()
    render(
      <RemoteControl
        session={session}
        enabled
        url="https://claude.ai/code/session_01ABC"
        onChange={onChange}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Open remotely' }))
    expect(openUrl).toHaveBeenCalledWith('https://claude.ai/code/session_01ABC')

    await userEvent.click(screen.getByRole('button', { name: 'Turn off Remote Control' }))
    expect(onChange).toHaveBeenCalledWith(false)
  })

  it('shows a failure and still offers to retry', async () => {
    const onChange = vi.fn()
    render(
      <RemoteControl
        session={session}
        enabled={false}
        url={null}
        error="Remote Control requires a claude.ai subscription"
        onChange={onChange}
      />,
    )

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Remote Control requires a claude.ai subscription',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Remote control' }))
    expect(onChange).toHaveBeenCalledWith(true)
  })
})
