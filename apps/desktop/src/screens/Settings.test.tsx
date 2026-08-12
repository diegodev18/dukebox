import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { defaultSettings, type Settings } from '@/lib/settings'
import type { UseUpdate } from '@/lib/useUpdate'
import { Settings as SettingsScreen, SettingsNav, type SettingsCategory } from '@/screens/Settings'

vi.mock('@/lib/connection', () => ({
  listConnections: vi.fn(),
  setActiveConnection: vi.fn(),
  removeConnection: vi.fn(),
  addConnection: vi.fn(),
  deviceName: vi.fn(() => 'Dukebox on Mac'),
  detectPlatform: vi.fn(() => 'macos'),
  activeConnection: vi.fn(),
}))

import { listConnections, removeConnection, setActiveConnection } from '@/lib/connection'

/**
 * The panel is exercised through its categories. The server row is asserted
 * carefully because Forget is two clicks (confirm), and Use/Forget coexist.
 */

const server: ConnectionValue = {
  serverName: 'debian-01',
  address: { host: 'debian-01.tailnet.ts.net', port: 7777, tls: false },
  deviceId: 'device-1',
  deviceToken: 'token-1',
  pairedAt: Date.now(),
}

type ConnectionValue = {
  serverName: string
  address: { host: string; port: number; tls: boolean }
  deviceId: string
  deviceToken: string
  pairedAt: number
}

function clientMock() {
  return {
    agentCredentialsConfigured: vi.fn().mockResolvedValue(false),
    setAgentCredentials: vi.fn().mockResolvedValue(undefined),
    clearAgentCredentials: vi.fn().mockResolvedValue(undefined),
    listOpencodeProviders: vi.fn().mockResolvedValue([]),
    upsertOpencodeProvider: vi.fn().mockResolvedValue({
      id: 'anthropic',
      kind: 'anthropic',
      name: 'Anthropic',
      models: [{ id: 'claude-sonnet-4-5', label: 'Sonnet 4.5' }],
    }),
    deleteOpencodeProvider: vi.fn().mockResolvedValue(undefined),
  }
}

function updateMock(): UseUpdate {
  return {
    state: { status: 'up-to-date' },
    checked: true,
    dismissed: false,
    announcing: false,
    check: vi.fn(),
    install: vi.fn(),
    dismiss: vi.fn(),
  }
}

function SettingsHarness({
  category: initialCategory = 'account',
  ...overrides
}: {
  settings?: Settings
  connection?: ConnectionValue
  client?: ReturnType<typeof clientMock>
  update?: UseUpdate
  category?: SettingsCategory
  onSaveSettings?: ReturnType<typeof vi.fn>
  onSwitchServer?: ReturnType<typeof vi.fn>
  onClose?: ReturnType<typeof vi.fn>
  onDisconnected?: ReturnType<typeof vi.fn>
}) {
  const [category, setCategory] = useState<SettingsCategory>(initialCategory)
  const props = {
    settings: defaultSettings(),
    connection: server,
    client: clientMock(),
    update: updateMock(),
    onSaveSettings: vi.fn(),
    onSwitchServer: vi.fn(),
    onClose: vi.fn(),
    onDisconnected: vi.fn(),
    ...overrides,
  }

  return (
    <div className="flex h-full">
      <SettingsNav category={category} onCategoryChange={setCategory} onBack={props.onClose} />
      <SettingsScreen
        client={props.client as never}
        connection={props.connection as never}
        settings={props.settings}
        update={props.update}
        category={category}
        onSaveSettings={props.onSaveSettings}
        onSwitchServer={props.onSwitchServer}
        onClose={props.onClose}
        onDisconnected={props.onDisconnected}
      />
    </div>
  )
}

function renderSettings(
  overrides: {
    settings?: Settings
    connection?: ConnectionValue
    client?: ReturnType<typeof clientMock>
    update?: UseUpdate
    category?: SettingsCategory
  } = {},
) {
  const props = {
    settings: defaultSettings(),
    connection: server,
    client: clientMock(),
    update: updateMock(),
    onSaveSettings: vi.fn(),
    onSwitchServer: vi.fn(),
    onClose: vi.fn(),
    onDisconnected: vi.fn(),
    ...overrides,
  }

  render(<SettingsHarness {...props} />)
  return props
}

async function openCategory(label: string) {
  await userEvent.click(screen.getByRole('button', { name: label }))
}

describe('Settings', () => {
  it('shows every category and lands on Account first', () => {
    renderSettings()

    expect(screen.getByRole('heading', { name: 'Account' })).toBeInTheDocument()
    const nav = screen.getByRole('navigation', { name: 'Settings' })
    const buttons = [...nav.querySelectorAll('button')].map((button) => button.textContent?.trim())
    expect(buttons).toEqual(['Settings', 'Account', 'Agents', 'Servers', 'Appearance', 'Updates'])
  })

  it('applies and persists a theme change', async () => {
    const { onSaveSettings } = renderSettings()
    await openCategory('Appearance')
    await userEvent.click(screen.getByRole('button', { name: 'Dark' }))
    expect(onSaveSettings).toHaveBeenCalledWith({ theme: 'dark' })
  })

  it('auto-saves the commit identity after typing settles', async () => {
    const { onSaveSettings } = renderSettings()

    await userEvent.clear(screen.getByLabelText(/^Name$/))
    await userEvent.type(screen.getByLabelText(/^Name$/), 'Diego')
    await userEvent.clear(screen.getByLabelText(/^Email$/))
    await userEvent.type(screen.getByLabelText(/^Email$/), 'diego@example.com')

    await waitFor(() =>
      expect(onSaveSettings).toHaveBeenCalledWith({
        commitIdentity: { name: 'Diego', email: 'diego@example.com' },
      }),
    )
  })

  it('shows whether the agent API is configured and saves a token', async () => {
    const client = clientMock()
    renderSettings({ client })
    await openCategory('Agents')

    await waitFor(() => expect(screen.getByText('Not configured')).toBeInTheDocument())

    await userEvent.type(screen.getByPlaceholderText(/paste token/i), 'sk-ant-123')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(client.setAgentCredentials).toHaveBeenCalledWith('sk-ant-123'))
  })

  it('clears the agent token when configured', async () => {
    const client = clientMock()
    client.agentCredentialsConfigured.mockResolvedValue(true)
    renderSettings({ client })
    await openCategory('Agents')

    await waitFor(() => expect(screen.getByText('Configured')).toBeInTheDocument())

    await userEvent.click(screen.getByRole('button', { name: 'Clear' }))
    await waitFor(() => expect(client.clearAgentCredentials).toHaveBeenCalled())
  })

  it('saves an OpenCode provider from Agents', async () => {
    const client = clientMock()
    renderSettings({ client })
    await openCategory('Agents')

    await waitFor(() => expect(screen.getByText(/no providers configured/i)).toBeInTheDocument())

    await userEvent.click(screen.getByRole('button', { name: /add provider/i }))
    await userEvent.type(screen.getByPlaceholderText(/paste key/i), 'sk-ant-opencode')
    await userEvent.click(screen.getByRole('button', { name: 'Save provider' }))

    await waitFor(() =>
      expect(client.upsertOpencodeProvider).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'anthropic', apiKey: 'sk-ant-opencode' }),
      ),
    )
  })

  it('opens Appearance when asked to land there', async () => {
    renderSettings({ category: 'appearance' })

    expect(await screen.findByRole('heading', { name: 'Appearance' })).toBeInTheDocument()
  })

  it('labels the agent API token field', async () => {
    renderSettings({ category: 'agents' })

    expect(await screen.findByLabelText('Agent API token')).toBeInTheDocument()
  })

  it('lists paired servers and switches to another one', async () => {
    vi.mocked(listConnections).mockResolvedValue([
      server,
      { ...server, deviceId: 'device-2', serverName: 'debian-02' },
    ] as never)
    vi.mocked(setActiveConnection).mockResolvedValue(undefined)
    const { onSwitchServer } = renderSettings()

    await openCategory('Servers')
    await waitFor(() => expect(screen.getByText('debian-01')).toBeInTheDocument())
    expect(screen.getByText('debian-02')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Use' }))

    await waitFor(() => expect(setActiveConnection).toHaveBeenCalledWith('device-2'))
    expect(onSwitchServer).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'device-2' }))
  })

  it('asks before forgetting a server and does not disconnect inactive ones', async () => {
    vi.mocked(listConnections).mockResolvedValue([
      server,
      { ...server, deviceId: 'device-2', serverName: 'debian-02' },
    ] as never)
    vi.mocked(removeConnection).mockResolvedValue(undefined)
    const { onSwitchServer, onDisconnected } = renderSettings()

    await openCategory('Servers')
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Forget' })).toHaveLength(2))

    await userEvent.click(screen.getAllByRole('button', { name: 'Forget' })[1])
    expect(removeConnection).not.toHaveBeenCalled()
    expect(screen.getByText(/Forget debian-02/i)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Forget server' }))

    await waitFor(() => expect(removeConnection).toHaveBeenCalledWith('device-2'))
    expect(onSwitchServer).not.toHaveBeenCalled()
    expect(onDisconnected).not.toHaveBeenCalled()
  })

  it('reports an available update and can check again', async () => {
    const update = updateMock()
    update.state = { status: 'available', update: { version: '0.2.0', body: '' } as never }
    renderSettings({ update })

    await openCategory('Updates')
    await waitFor(() => expect(screen.getByText(/0.2.0 is available/i)).toBeInTheDocument())

    await userEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
    expect(update.check).toHaveBeenCalledWith(true)
  })

  it('toggles the launch update check', async () => {
    const { onSaveSettings } = renderSettings()
    await openCategory('Updates')

    await userEvent.click(screen.getByRole('switch', { name: 'Check on launch' }))
    expect(onSaveSettings).toHaveBeenCalledWith({ checkForUpdatesOnLaunch: false })
  })

  it('closes with the Back button', async () => {
    const { onClose } = renderSettings()
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(onClose).toHaveBeenCalled()
  })
})
