import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import {
  TransportError,
  type AdvertisedEndpoint,
  type BindAddress,
  type PreflightResult,
  type Transport,
} from '@/types'

const exec = promisify(execFile)

/**
 * Reach the control plane over a Tailscale tailnet.
 *
 * The server binds only to the tailnet interface, so outside the tailnet it
 * does not exist: no public port, no certificate to manage, no login page to
 * attack. WireGuard has already authenticated whoever can reach it.
 */

/**
 * Shape of `tailscale status --json`.
 *
 * Only the fields that are needed are declared, and the rest passes through:
 * the command returns a large document that changes between releases, and
 * depending on all of it would break on upgrade.
 */
const tailscaleStatus = z
  .object({
    /** 'Running' when connected. 'Stopped' and 'NeedsLogin' are the common failures. */
    BackendState: z.string(),
    Self: z
      .object({
        HostName: z.string().optional(),
        /** MagicDNS name, with a trailing dot. Empty when MagicDNS is off. */
        DNSName: z.string().optional(),
        TailscaleIPs: z.array(z.string()).nullable().optional(),
        Online: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    MagicDNSSuffix: z.string().optional(),
  })
  .passthrough()

export type TailscaleStatus = z.infer<typeof tailscaleStatus>

export interface TailscaleTransportOptions {
  /** Path to the CLI. Overridable for tests and unusual installs. */
  binary?: string
  /** Injectable for tests, so they never shell out. */
  runStatus?: () => Promise<string>
}

/**
 * Pick the address to bind to.
 *
 * IPv4 is preferred: it is what appears in pairing links, and an IPv6 literal
 * would need bracket quoting that makes the link harder to read and to retype.
 */
export function selectBindIp(status: TailscaleStatus): string | null {
  const ips = status.Self?.TailscaleIPs ?? []
  return ips.find((ip) => !ip.includes(':')) ?? ips[0] ?? null
}

/**
 * Pick the hostname clients should use.
 *
 * The MagicDNS name survives an address change, so it is preferred over the
 * raw IP. Trailing dots are stripped: they are valid DNS but look like a typo
 * in a link the user has to trust.
 */
export function selectAdvertisedHost(status: TailscaleStatus): string | null {
  const dnsName = status.Self?.DNSName?.replace(/\.$/, '')
  if (dnsName) return dnsName

  return selectBindIp(status)
}

/** Turn a backend state into something an operator can act on. */
export function explainState(state: string): string | undefined {
  switch (state) {
    case 'Running':
      return undefined
    case 'NeedsLogin':
      return 'Tailscale is not logged in. Run: tailscale up'
    case 'Stopped':
      return 'Tailscale is installed but stopped. Run: tailscale up'
    case 'NoState':
    case 'Starting':
      return 'Tailscale is still starting. Wait a moment and try again.'
    default:
      return `Tailscale is in an unexpected state: ${state}. Check: tailscale status`
  }
}

export class TailscaleTransport implements Transport {
  readonly id = 'tailscale'

  private readonly binary: string
  private readonly runStatus: () => Promise<string>

  constructor(options: TailscaleTransportOptions = {}) {
    this.binary = options.binary ?? 'tailscale'
    this.runStatus = options.runStatus ?? (() => this.execStatus())
  }

  private async execStatus(): Promise<string> {
    try {
      const { stdout } = await exec(this.binary, ['status', '--json'])
      return stdout
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code === 'ENOENT') {
        throw new TransportError(
          'the tailscale command was not found',
          'Install Tailscale: https://tailscale.com/download',
        )
      }
      throw new TransportError(
        `tailscale status failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  async status(): Promise<TailscaleStatus> {
    const raw = await this.runStatus()

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new TransportError('tailscale status returned output that is not JSON')
    }

    const result = tailscaleStatus.safeParse(parsed)
    if (!result.success) {
      throw new TransportError(`unexpected tailscale status format: ${result.error.message}`)
    }

    return result.data
  }

  async preflight(): Promise<PreflightResult> {
    let status: TailscaleStatus
    try {
      status = await this.status()
    } catch (error) {
      const remedy = error instanceof TransportError ? error.remedy : undefined
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, message: remedy ? `${message}. ${remedy}` : message }
    }

    const stateProblem = explainState(status.BackendState)
    if (stateProblem) return { ok: false, message: stateProblem }

    if (!selectBindIp(status)) {
      return {
        ok: false,
        message: 'This machine has no tailnet address yet. Run: tailscale up',
      }
    }

    return { ok: true }
  }

  async bindAddress(port: number): Promise<BindAddress> {
    const status = await this.status()
    const host = selectBindIp(status)

    if (!host) {
      throw new TransportError(
        'no tailnet address to bind to',
        'Connect this machine to your tailnet: tailscale up',
      )
    }

    // Binding to this address specifically, rather than 0.0.0.0, is what keeps
    // the server off every other interface on the machine.
    return { host, port }
  }

  async advertisedEndpoint(port: number): Promise<AdvertisedEndpoint> {
    const status = await this.status()
    const host = selectAdvertisedHost(status)

    if (!host) {
      throw new TransportError(
        'no tailnet hostname or address to advertise',
        'Connect this machine to your tailnet: tailscale up',
      )
    }

    // No TLS: the tailnet already authenticates and encrypts the connection.
    return { host, port, tls: false }
  }
}
