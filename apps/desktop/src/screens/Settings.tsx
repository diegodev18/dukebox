import { DEFAULT_COMMIT_IDENTITY } from '@dukebox/protocol'
import { useEffect, useRef, useState } from 'react'
import { ChevronLeftIcon } from '@/components/icons'
import { OpenCodeProviders } from '@/components/OpenCodeProviders'
import { PairingForm } from '@/components/PairingForm'
import type { DukeboxClient } from '@/lib/client'
import {
  listConnections,
  removeConnection,
  setActiveConnection,
  type Connection,
} from '@/lib/connection'
import type { Settings, Theme } from '@/lib/settings'
import type { UseUpdate } from '@/lib/useUpdate'

/**
 * The settings panel.
 *
 * When open, its category rail replaces the sessions sidebar as the primary
 * nav. The content column shows one section at a time — never nested deeper.
 */

export type SettingsCategory = 'account' | 'agents' | 'servers' | 'appearance' | 'updates'

const CATEGORIES: { id: SettingsCategory; label: string }[] = [
  { id: 'account', label: 'Account' },
  { id: 'agents', label: 'Agents' },
  { id: 'servers', label: 'Servers' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'updates', label: 'Updates' },
]

interface SettingsNavProps {
  category: SettingsCategory
  onCategoryChange: (category: SettingsCategory) => void
  onBack: () => void
}

/** Left-column nav while settings is open — same slot as the sessions sidebar. */
export function SettingsNav({ category, onCategoryChange, onBack }: SettingsNavProps) {
  return (
    <nav
      aria-label="Settings"
      className="flex min-h-0 flex-col overflow-hidden border-r border-border bg-surface"
    >
      <div className="px-2 pt-2.5 pb-1">
        <button
          type="button"
          aria-label="Back"
          onClick={onBack}
          className="flex w-full items-center gap-2 rounded-[calc(var(--radius)*0.7)] px-2.5 py-1.5 text-left text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ChevronLeftIcon size={16} className="flex-none" />
          Settings
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 py-1.5">
        {CATEGORIES.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            aria-current={category === id}
            onClick={() => onCategoryChange(id)}
            className="rounded-[calc(var(--radius)*0.6)] px-2.5 py-1.5 text-left text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground aria-[current=true]:bg-muted aria-[current=true]:text-foreground"
          >
            {label}
          </button>
        ))}
      </div>
    </nav>
  )
}

interface Props {
  client: DukeboxClient
  connection: Connection
  settings: Settings
  update: UseUpdate
  category: SettingsCategory
  onSaveSettings: (patch: Partial<Settings>) => void
  onSwitchServer: (connection: Connection) => void
  onClose: () => void
  onDisconnected: () => void
}

export function Settings({
  client,
  connection,
  settings,
  update,
  category,
  onSaveSettings,
  onSwitchServer,
  onClose,
  onDisconnected,
}: Props) {
  // Esc closes from anywhere in the panel, the same way it closes a popover.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="h-full min-h-0 overflow-y-auto px-6 py-5">
      <div className="mx-auto max-w-xl">
        {category === 'account' && (
          <AccountSection
            identity={settings.commitIdentity}
            onSaveIdentity={(commitIdentity) => onSaveSettings({ commitIdentity })}
          />
        )}
        {category === 'agents' && <AgentsSection client={client} />}
        {category === 'servers' && (
          <ServersSection
            activeConnection={connection}
            onSwitchServer={onSwitchServer}
            onDisconnected={onDisconnected}
          />
        )}
        {category === 'appearance' && (
          <AppearanceSection theme={settings.theme} onSave={onSaveSettings} />
        )}
        {category === 'updates' && (
          <UpdatesSection
            update={update}
            checkOnLaunch={settings.checkForUpdatesOnLaunch}
            onSave={onSaveSettings}
          />
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Appearance
// ---------------------------------------------------------------------------

const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

function AppearanceSection({
  theme,
  onSave,
}: {
  theme: Theme
  onSave: (patch: Partial<Settings>) => void
}) {
  return (
    <section aria-labelledby="appearance-title">
      <h2 id="appearance-title" className="text-[14px] font-medium">
        Appearance
      </h2>

      <div className="mt-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[13px] font-medium">Colour scheme</p>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            Follows your operating system unless you pick one here.
          </p>
        </div>
        <div className="inline-flex flex-none rounded-[calc(var(--radius)*0.8)] border border-border bg-surface p-0.5">
          {THEME_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={theme === option.value}
              onClick={() => onSave({ theme: option.value })}
              className={`rounded-[calc(var(--radius)*0.6)] px-3 py-1.5 text-[13px] font-medium ${
                theme === option.value
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

function AccountSection({
  identity,
  onSaveIdentity,
}: {
  identity: Settings['commitIdentity']
  onSaveIdentity: (identity: { name: string; email: string } | null) => void
}) {
  const storedName = identity?.name ?? DEFAULT_COMMIT_IDENTITY.name
  const storedEmail = identity?.email ?? DEFAULT_COMMIT_IDENTITY.email
  const [name, setName] = useState(storedName)
  const [email, setEmail] = useState(storedEmail)
  const [saved, setSaved] = useState(false)
  const onSaveIdentityRef = useRef(onSaveIdentity)
  onSaveIdentityRef.current = onSaveIdentity

  // Persist as the fields settle, the same way theme applies on pick — no
  // separate Save step to remember.
  useEffect(() => {
    const nextName = name.trim()
    const nextEmail = email.trim()
    if (nextName === '' || nextEmail === '') return
    if (nextName === storedName && nextEmail === storedEmail) return

    const timer = setTimeout(() => {
      onSaveIdentityRef.current({ name: nextName, email: nextEmail })
      setSaved(true)
    }, 400)
    return () => clearTimeout(timer)
  }, [name, email, storedName, storedEmail])

  useEffect(() => {
    if (!saved) return
    const timer = setTimeout(() => setSaved(false), 2000)
    return () => clearTimeout(timer)
  }, [saved])

  const resetIdentity = () => {
    setName(DEFAULT_COMMIT_IDENTITY.name)
    setEmail(DEFAULT_COMMIT_IDENTITY.email)
    onSaveIdentity(null)
    setSaved(true)
  }

  return (
    <section aria-labelledby="account-title">
      <h2 id="account-title" className="text-[14px] font-medium">
        Account
      </h2>
      <p className="mt-1 text-[12.5px] text-muted-foreground">
        The name and email new sessions author commits with.
      </p>

      <div className="mt-4 grid grid-cols-2 gap-2.5">
        <label className="block text-[12px] text-muted-foreground">
          Name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="mt-1 w-full rounded-[calc(var(--radius)*0.6)] border border-border-strong bg-background px-2.5 py-1.5 text-[13px] outline-none placeholder:text-muted-foreground"
          />
        </label>
        <label className="block text-[12px] text-muted-foreground">
          Email
          <input
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="mt-1 w-full rounded-[calc(var(--radius)*0.6)] border border-border-strong bg-background px-2.5 py-1.5 text-[13px] outline-none placeholder:text-muted-foreground"
          />
        </label>
      </div>

      <div className="mt-2.5 flex items-center gap-2">
        <button
          type="button"
          onClick={resetIdentity}
          className="rounded-[calc(var(--radius)*0.6)] px-2 py-1.5 text-[12.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Use default
        </button>
        {saved && <span className="text-[12px] text-muted-foreground">Saved</span>}
      </div>
    </section>
  )
}

function AgentsSection({ client }: { client: DukeboxClient }) {
  return (
    <section aria-labelledby="agents-title">
      <h2 id="agents-title" className="text-[14px] font-medium">
        Agents
      </h2>
      <p className="mt-1 text-[12.5px] text-muted-foreground">
        Credentials agents use to reach model providers. Stored on the server.
      </p>

      <AgentCredentials client={client} />
      <OpenCodeProviders client={client} />
    </section>
  )
}

function AgentCredentials({ client }: { client: DukeboxClient }) {
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [token, setToken] = useState('')
  const [working, setWorking] = useState(false)
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    client
      .agentCredentialsConfigured()
      .then((found) => {
        if (!cancelled) setConfigured(found)
      })
      .catch(() => {
        if (!cancelled) setConfigured(false)
      })
    return () => {
      cancelled = true
    }
  }, [client])

  const saveToken = async () => {
    setWorking(true)
    setMessage(null)
    try {
      await client.setAgentCredentials(token.trim())
      setToken('')
      setConfigured(true)
      setMessage({ tone: 'ok', text: 'Token saved.' })
    } catch (error) {
      setMessage({
        tone: 'error',
        text: error instanceof Error ? error.message : 'Could not save the token.',
      })
    } finally {
      setWorking(false)
    }
  }

  const clearToken = async () => {
    setWorking(true)
    setMessage(null)
    try {
      await client.clearAgentCredentials()
      setConfigured(false)
      setMessage({ tone: 'ok', text: 'Token removed.' })
    } catch (error) {
      setMessage({
        tone: 'error',
        text: error instanceof Error ? error.message : 'Could not remove the token.',
      })
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className="mt-5">
      <h3 className="text-[12px] font-semibold tracking-wide text-muted-foreground uppercase">
        Agent API
      </h3>
      <p className="mt-1 text-[12.5px] text-muted-foreground">
        Shared token for agents that talk to a single provider endpoint.
      </p>

      <div className="mt-3 flex items-center gap-2">
        <input
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder={configured ? 'Replace token…' : 'Paste token…'}
          spellCheck={false}
          autoComplete="off"
          disabled={working}
          aria-label="Agent API token"
          className="min-w-0 flex-1 rounded-[calc(var(--radius)*0.6)] border border-border-strong bg-background px-2.5 py-1.5 font-mono text-[13px] outline-none placeholder:text-muted-foreground disabled:opacity-60"
        />
        <button
          type="button"
          disabled={working || token.trim() === ''}
          onClick={() => void saveToken()}
          className="flex-none rounded-[calc(var(--radius)*0.6)] bg-foreground px-3.5 py-1.5 text-[12.5px] font-medium text-background disabled:opacity-40"
        >
          Save
        </button>
        {configured && (
          <button
            type="button"
            disabled={working}
            onClick={() => void clearToken()}
            className="flex-none rounded-[calc(var(--radius)*0.6)] border border-border px-3.5 py-1.5 text-[12.5px] font-medium hover:bg-muted disabled:opacity-40"
          >
            Clear
          </button>
        )}
      </div>

      <div className="mt-2 flex items-center gap-2 text-[12px]">
        <StatusChip configured={configured} />
        {message && (
          <span className={message.tone === 'ok' ? 'text-muted-foreground' : 'text-destructive'}>
            {message.text}
          </span>
        )}
      </div>
    </div>
  )
}

function StatusChip({ configured }: { configured: boolean | null }) {
  if (configured === null) {
    return <span className="text-muted-foreground">Checking…</span>
  }
  return configured ? (
    <span className="flex items-center gap-1.5">
      <span className="size-1.5 rounded-full bg-done" />
      Configured
    </span>
  ) : (
    <span className="flex items-center gap-1.5 text-muted-foreground">
      <span className="size-1.5 rounded-full bg-muted-foreground opacity-60" />
      Not configured
    </span>
  )
}

// ---------------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------------

function ServersSection({
  activeConnection,
  onSwitchServer,
  onDisconnected,
}: {
  activeConnection: Connection
  onSwitchServer: (connection: Connection) => void
  onDisconnected: () => void
}) {
  const [connections, setConnections] = useState<Connection[]>([])
  const [pairing, setPairing] = useState(false)
  const [forgettingId, setForgettingId] = useState<string | null>(null)
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const reload = async () => {
    const found = await listConnections().catch(() => null)
    if (found) setConnections(found)
  }

  useEffect(() => {
    let cancelled = false
    listConnections()
      .then((found) => {
        if (!cancelled) setConnections(found)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const useServer = async (connection: Connection) => {
    await setActiveConnection(connection.deviceId).catch(() => undefined)
    onSwitchServer(connection)
  }

  const forgetServer = async (connection: Connection) => {
    await removeConnection(connection.deviceId)
    const remaining = connections.filter((entry) => entry.deviceId !== connection.deviceId)
    setConnections(remaining)
    setForgettingId(null)
    setMessage(null)

    if (connection.deviceId === activeConnection.deviceId) {
      if (remaining.length === 0) {
        onDisconnected()
      } else {
        await setActiveConnection(remaining[0]!.deviceId).catch(() => undefined)
        onSwitchServer(remaining[0]!)
      }
    }
  }

  return (
    <section aria-labelledby="servers-title">
      <h2 id="servers-title" className="text-[14px] font-medium">
        Servers
      </h2>
      <p className="mt-1 text-[12.5px] text-muted-foreground">
        The Dukebox servers this app is paired with.
      </p>

      <ul className="mt-4 flex flex-col gap-2">
        {connections.map((entry) => {
          const active = entry.deviceId === activeConnection.deviceId
          const confirming = forgettingId === entry.deviceId
          return (
            <li
              key={entry.deviceId}
              className="rounded-[calc(var(--radius)*0.8)] border border-border bg-surface px-3.5 py-3"
            >
              {confirming ? (
                <div className="flex flex-wrap items-center gap-2">
                  <p className="min-w-0 flex-1 text-[12.5px] text-muted-foreground">
                    {connections.length === 1
                      ? 'Forget this server and disconnect?'
                      : active
                        ? 'Forget the active server?'
                        : `Forget ${entry.serverName}?`}
                  </p>
                  <button
                    type="button"
                    onClick={() => void forgetServer(entry)}
                    className="flex-none rounded-[calc(var(--radius)*0.6)] border border-border px-2.5 py-1 text-[12px] font-medium text-destructive hover:bg-muted"
                  >
                    Forget server
                  </button>
                  <button
                    type="button"
                    onClick={() => setForgettingId(null)}
                    className="flex-none rounded-[calc(var(--radius)*0.6)] px-2.5 py-1 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-medium">{entry.serverName}</span>
                      {active && (
                        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10.5px] font-medium text-muted-foreground">
                          Active
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[11.5px] text-muted-foreground">
                      {entry.address.host}:{entry.address.port}
                    </div>
                  </div>

                  {!active && (
                    <button
                      type="button"
                      onClick={() => void useServer(entry)}
                      className="flex-none rounded-[calc(var(--radius)*0.6)] border border-border px-2.5 py-1 text-[12px] font-medium hover:bg-muted"
                    >
                      Use
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setForgettingId(entry.deviceId)}
                    className="flex-none rounded-[calc(var(--radius)*0.6)] px-2 py-1 text-[12px] text-muted-foreground hover:bg-muted hover:text-destructive"
                  >
                    Forget
                  </button>
                </div>
              )}
            </li>
          )
        })}
      </ul>

      {connections.length === 0 && (
        <p className="mt-4 text-[12.5px] text-muted-foreground">No servers paired.</p>
      )}

      {message && (
        <p
          role="alert"
          className={`mt-3 text-[12.5px] ${message.tone === 'ok' ? 'text-muted-foreground' : 'text-destructive'}`}
        >
          {message.text}
        </p>
      )}

      <div className="mt-4">
        {pairing ? (
          <div className="rounded-[calc(var(--radius)*0.8)] border border-border bg-surface px-3.5 py-3.5">
            <PairingForm
              onPaired={(connection) => {
                setPairing(false)
                void reload()
                onSwitchServer(connection)
              }}
              onCancel={() => setPairing(false)}
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setPairing(true)}
            className="rounded-[calc(var(--radius)*0.6)] border border-border px-3.5 py-1.5 text-[12.5px] font-medium hover:bg-muted"
          >
            Pair a new server…
          </button>
        )}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

function UpdatesSection({
  update,
  checkOnLaunch,
  onSave,
}: {
  update: UseUpdate
  checkOnLaunch: boolean
  onSave: (patch: Partial<Settings>) => void
}) {
  const [announcing, setAnnouncing] = useState(false)
  const state = update.state

  // A manual check that found nothing deserves an answer even outside the
  // banner: this panel is where someone came looking for it.
  useEffect(() => {
    if (state.status !== 'up-to-date' || !update.announcing) return
    setAnnouncing(true)
    const timer = setTimeout(() => setAnnouncing(false), 4000)
    return () => clearTimeout(timer)
  }, [state.status, update.announcing])

  return (
    <section aria-labelledby="updates-title">
      <h2 id="updates-title" className="text-[14px] font-medium">
        Updates
      </h2>
      <p className="mt-1 text-[12.5px] text-muted-foreground">
        Check for a newer Dukebox build, or let the app ask on launch.
      </p>

      <div className="mt-4 flex items-center gap-2 text-[12.5px]">
        {state.status === 'available' ? (
          <span className="text-muted-foreground">
            Dukebox {state.update.version} is available.
          </span>
        ) : state.status === 'downloading' ? (
          <span className="text-muted-foreground">Downloading…</span>
        ) : state.status === 'error' ? (
          <span className="text-destructive">{state.message}</span>
        ) : announcing ? (
          <span className="text-muted-foreground">You’re up to date.</span>
        ) : (
          <span className="text-muted-foreground">
            {state.status === 'checking' ? 'Checking…' : 'You’re up to date.'}
          </span>
        )}
      </div>

      <div className="mt-3 flex items-center gap-2">
        {state.status === 'available' && (
          <button
            type="button"
            onClick={() => update.install(state.update)}
            className="rounded-[calc(var(--radius)*0.6)] bg-primary px-3.5 py-1.5 text-[12.5px] font-medium text-primary-foreground hover:opacity-90"
          >
            Update &amp; restart
          </button>
        )}
        <button
          type="button"
          onClick={() => update.check(true)}
          disabled={state.status === 'checking' || state.status === 'downloading'}
          className="rounded-[calc(var(--radius)*0.6)] border border-border px-3.5 py-1.5 text-[12.5px] font-medium hover:bg-muted disabled:opacity-40"
        >
          Check for updates
        </button>
      </div>

      <label className="mt-6 flex items-center justify-between gap-3">
        <span>
          <span className="block text-[13px] font-medium">Check on launch</span>
          <span className="block text-[12px] text-muted-foreground">
            Ask the release feed for a newer build when the app starts.
          </span>
        </span>
        <Toggle
          checked={checkOnLaunch}
          onChange={(checked) => onSave({ checkForUpdatesOnLaunch: checked })}
          label="Check on launch"
        />
      </label>
    </section>
  )
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-5.5 w-9.5 flex-none rounded-full transition-colors ${
        checked ? 'bg-primary' : 'bg-muted-foreground/40'
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 size-4.5 rounded-full bg-background transition-transform ${
          checked ? 'translate-x-4' : ''
        }`}
      />
    </button>
  )
}
