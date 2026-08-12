import { parsePairingUrl } from '@dukebox/protocol'
import { useState } from 'react'
import { ApiFailure, reachable, redeemPairingCode, type Reachability } from '../lib/client.js'
import { addConnection, deviceName, detectPlatform, type Connection } from '../lib/connection.js'

/**
 * The pairing form: a link in, a device out.
 *
 * Shared by the first-run screen and the settings server list — pairing a
 * second server is the same interaction as pairing the first, just in a
 * narrower home. The screen keeps the surrounding prose; this keeps the part
 * that actually does something.
 */

interface Props {
  onPaired: (connection: Connection) => void
  /** Renders a way back when the form is embedded rather than full-screen. */
  onCancel?: () => void
}

type Status =
  | { kind: 'idle' }
  | { kind: 'working'; step: 'reaching' | 'pairing' }
  | { kind: 'failed'; message: string; hint?: string }

export function PairingForm({ onPaired, onCancel }: Props) {
  const [link, setLink] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()

    const parsed = parsePairingUrl(link)
    if (!parsed) {
      setStatus({
        kind: 'failed',
        message: 'That does not look like a pairing link.',
        hint: 'It starts with dukebox:// and comes from the installer.',
      })
      return
    }

    const address = { host: parsed.host, port: parsed.port, tls: false }

    // Checked before redeeming: a code is single use, and spending one against
    // a server that cannot be reached wastes it.
    setStatus({ kind: 'working', step: 'reaching' })
    const check = await reachable(address)

    if (!check.ok) {
      setStatus({ kind: 'failed', ...unreachable(parsed.host, check) })
      return
    }

    setStatus({ kind: 'working', step: 'pairing' })
    try {
      const response = await redeemPairingCode(address, parsed.code, {
        name: deviceName(),
        platform: detectPlatform(),
      })

      const connection: Connection = {
        serverName: response.serverName,
        address,
        deviceId: response.deviceId,
        deviceToken: response.deviceToken,
        pairedAt: Date.now(),
      }

      await addConnection(connection)
      onPaired(connection)
    } catch (error) {
      setStatus({ kind: 'failed', ...explain(error) })
    }
  }

  const working = status.kind === 'working'

  return (
    <form onSubmit={submit}>
      <label htmlFor="pairing-link" className="text-[13px] font-medium">
        Pairing link
      </label>

      <input
        id="pairing-link"
        value={link}
        onChange={(event) => {
          setLink(event.target.value)
          if (status.kind === 'failed') setStatus({ kind: 'idle' })
        }}
        placeholder="dukebox://pair?host=…"
        spellCheck={false}
        autoComplete="off"
        disabled={working}
        className="mt-2 w-full rounded-[var(--radius)] border border-border-strong bg-surface px-3 py-2.5 font-mono text-[13px] disabled:opacity-60"
      />

      {status.kind === 'failed' && (
        <p role="alert" className="mt-2.5 text-[13px] text-destructive">
          {status.message}
          {status.hint && <span className="mt-1 block text-muted-foreground">{status.hint}</span>}
        </p>
      )}

      <div className="mt-4 flex items-center gap-2">
        <button
          type="submit"
          disabled={working || link.trim() === ''}
          className="flex-1 rounded-[var(--radius)] bg-primary px-4 py-2.5 font-medium text-primary-foreground disabled:opacity-50"
        >
          {status.kind === 'working'
            ? status.step === 'reaching'
              ? 'Reaching the server…'
              : 'Pairing…'
            : 'Connect'}
        </button>

        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={working}
            className="flex-none rounded-[var(--radius)] border border-border px-4 py-2.5 font-medium hover:bg-muted disabled:opacity-50"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  )
}

/**
 * Why the server could not be reached.
 *
 * A timeout and a refused request send someone to different places: one is a
 * server that is not answering, the other is the request never leaving the app.
 * Reporting both as "check your network" wastes the time of whoever is right.
 */
function unreachable(host: string, check: Extract<Reachability, { ok: false }>) {
  switch (check.reason) {
    case 'timeout':
      return {
        message: `${host} did not answer.`,
        hint: 'Check this machine is on the same tailnet, and that the server is running.',
      }
    case 'http':
      return {
        message: `${host} answered, but not as Dukebox (${check.detail}).`,
        hint: 'Check the port in the link points at the control plane.',
      }
    case 'blocked':
      return {
        message: `The connection to ${host} was refused before it left the app.`,
        hint: `macOS blocks plaintext HTTP by default. Details: ${check.detail}`,
      }
  }
}

/**
 * Turn a failure into something the person can act on.
 *
 * The server distinguishes a used code from an expired one, and the difference
 * decides what they do next — ask for a new link, or find the one they already
 * used.
 */
function explain(error: unknown): { message: string; hint?: string } {
  if (!(error instanceof ApiFailure)) {
    return {
      message: 'Could not reach the server.',
      hint: 'Check this machine is on the same tailnet.',
    }
  }

  switch (error.code) {
    case 'already_used':
      return {
        message: 'That link has already been used.',
        hint: 'Each link pairs one device. Run `dukebox pair new` for another.',
      }
    case 'expired':
      return {
        message: 'That link has expired.',
        hint: 'Links last fifteen minutes. Run `dukebox pair new` for a fresh one.',
      }
    case 'invalid_code':
      return {
        message: 'The server does not recognise that link.',
        hint: 'Check it was copied whole, including the code at the end.',
      }
    default:
      return { message: error.message }
  }
}
