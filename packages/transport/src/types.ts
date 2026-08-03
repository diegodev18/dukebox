/**
 * How the desktop app reaches the control plane.
 *
 * Tailscale is the only implementation today, but nothing outside this package
 * knows that. Adding a public domain with TLS, or an SSH tunnel, should be a
 * new file here and a config value — not a change anywhere else.
 */

export interface BindAddress {
  /** Interface address to listen on. Never 0.0.0.0 for a private transport. */
  host: string
  port: number
}

export interface AdvertisedEndpoint {
  /** How a client addresses this server. Goes into the pairing link. */
  host: string
  port: number
  /**
   * Whether clients should use TLS.
   *
   * False for Tailscale: WireGuard already authenticates and encrypts the
   * link, so a certificate would add a second layer with nothing to prove.
   * A public-domain transport would set this true.
   */
  tls: boolean
}

export interface PreflightResult {
  ok: boolean
  /** Why it failed, phrased as something the operator can act on. */
  message?: string
}

export interface Transport {
  readonly id: string

  /**
   * Check the transport is usable before the server binds anything.
   *
   * Runs at startup. Failing here with a clear message is the difference
   * between an operator fixing their setup in one step and debugging a server
   * that came up unreachable.
   */
  preflight(): Promise<PreflightResult>

  /** Where the server should listen. */
  bindAddress(port: number): Promise<BindAddress>

  /** Where clients should connect. */
  advertisedEndpoint(port: number): Promise<AdvertisedEndpoint>
}

export class TransportError extends Error {
  constructor(
    message: string,
    /** What the operator should do about it. */
    readonly remedy?: string,
  ) {
    super(message)
    this.name = 'TransportError'
  }
}
