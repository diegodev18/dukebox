import { describe, expect, it } from 'vitest'
import {
  explainState,
  selectAdvertisedHost,
  selectBindIp,
  TailscaleTransport,
  type TailscaleStatus,
} from '@/tailscale'
import { TransportError } from '@/types'

/**
 * The status documents here are shaped after real `tailscale status --json`
 * output, including the disconnected case, which is what an operator hits when
 * they install Dukebox before joining their tailnet.
 */

const RUNNING: TailscaleStatus = {
  BackendState: 'Running',
  Self: {
    HostName: 'dukebox-vps',
    DNSName: 'dukebox-vps.tail1234.ts.net.',
    TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1234'],
    Online: true,
  },
  MagicDNSSuffix: 'tail1234.ts.net',
}

/** Observed on a machine with Tailscale installed but not started. */
const STOPPED: TailscaleStatus = {
  BackendState: 'Stopped',
  Self: { HostName: 'laptop', DNSName: '', TailscaleIPs: null, Online: false },
  MagicDNSSuffix: '',
}

function transportFor(status: TailscaleStatus | string) {
  return new TailscaleTransport({
    runStatus: async () => (typeof status === 'string' ? status : JSON.stringify(status)),
  })
}

describe('selectBindIp', () => {
  it('prefers IPv4, which is what pairing links carry', () => {
    // An IPv6 literal would need bracket quoting, making a link the user has
    // to retype harder to read.
    expect(selectBindIp(RUNNING)).toBe('100.101.102.103')
  })

  it('falls back to IPv6 when that is all there is', () => {
    expect(selectBindIp({ ...RUNNING, Self: { TailscaleIPs: ['fd7a::1'] } })).toBe('fd7a::1')
  })

  it('returns null when the machine has no tailnet address', () => {
    expect(selectBindIp(STOPPED)).toBeNull()
  })

  it('returns null when the address list is missing entirely', () => {
    expect(selectBindIp({ BackendState: 'Running' })).toBeNull()
  })
})

describe('selectAdvertisedHost', () => {
  it('prefers the MagicDNS name, which survives an address change', () => {
    expect(selectAdvertisedHost(RUNNING)).toBe('dukebox-vps.tail1234.ts.net')
  })

  it('strips the trailing dot, which reads as a typo in a pairing link', () => {
    expect(selectAdvertisedHost(RUNNING)).not.toMatch(/\.$/)
  })

  it('falls back to the IP when MagicDNS is off', () => {
    const status = { ...RUNNING, Self: { ...RUNNING.Self, DNSName: '' } }
    expect(selectAdvertisedHost(status)).toBe('100.101.102.103')
  })

  it('returns null when there is nothing to advertise', () => {
    expect(selectAdvertisedHost(STOPPED)).toBeNull()
  })
})

describe('explainState', () => {
  it('accepts a running backend', () => {
    expect(explainState('Running')).toBeUndefined()
  })

  it.each([
    ['NeedsLogin', 'tailscale up'],
    ['Stopped', 'tailscale up'],
    ['Starting', 'starting'],
  ])('explains %s with something actionable', (state, expected) => {
    expect(explainState(state)).toContain(expected)
  })

  it('names an unrecognized state rather than hiding it', () => {
    expect(explainState('Frobnicating')).toContain('Frobnicating')
  })
})

describe('TailscaleTransport', () => {
  describe('preflight', () => {
    it('passes on a connected tailnet', async () => {
      expect(await transportFor(RUNNING).preflight()).toEqual({ ok: true })
    })

    it('fails with instructions when Tailscale is stopped', async () => {
      // The common case: Dukebox installed before joining the tailnet.
      const result = await transportFor(STOPPED).preflight()

      expect(result.ok).toBe(false)
      expect(result.message).toContain('tailscale up')
    })

    it('fails when connected but without an address yet', async () => {
      const result = await transportFor({
        BackendState: 'Running',
        Self: { TailscaleIPs: [] },
      }).preflight()

      expect(result.ok).toBe(false)
      expect(result.message).toContain('tailscale up')
    })

    it('fails rather than throws when the CLI is missing', async () => {
      // preflight reports; it is the caller that decides to abort.
      const transport = new TailscaleTransport({
        runStatus: async () => {
          throw new TransportError('the tailscale command was not found', 'Install Tailscale')
        },
      })

      const result = await transport.preflight()
      expect(result.ok).toBe(false)
      expect(result.message).toContain('Install Tailscale')
    })

    it('fails on output that is not JSON', async () => {
      const result = await transportFor('command not found').preflight()

      expect(result.ok).toBe(false)
      expect(result.message).toContain('not JSON')
    })
  })

  describe('bindAddress', () => {
    it('binds to the tailnet address, never to every interface', async () => {
      const address = await transportFor(RUNNING).bindAddress(7777)

      // Binding 0.0.0.0 would expose the control plane on every interface,
      // including whatever public one the VPS has.
      expect(address).toEqual({ host: '100.101.102.103', port: 7777 })
      expect(address.host).not.toBe('0.0.0.0')
    })

    it('throws with a remedy when there is no address', async () => {
      await expect(transportFor(STOPPED).bindAddress(7777)).rejects.toThrow(TransportError)
    })
  })

  describe('advertisedEndpoint', () => {
    it('advertises the MagicDNS name and port', async () => {
      expect(await transportFor(RUNNING).advertisedEndpoint(7777)).toEqual({
        host: 'dukebox-vps.tail1234.ts.net',
        port: 7777,
        tls: false,
      })
    })

    it('does not ask clients for TLS, since WireGuard already secures the link', async () => {
      const endpoint = await transportFor(RUNNING).advertisedEndpoint(7777)
      expect(endpoint.tls).toBe(false)
    })

    it('throws when there is nothing to advertise', async () => {
      await expect(transportFor(STOPPED).advertisedEndpoint(7777)).rejects.toThrow(TransportError)
    })
  })

  describe('unfamiliar status documents', () => {
    it('tolerates fields added by a newer Tailscale', async () => {
      // The document is large and changes between releases; depending on all
      // of it would break on upgrade.
      const status = { ...RUNNING, SomethingNew: { nested: true } }
      expect(await transportFor(status as TailscaleStatus).preflight()).toEqual({ ok: true })
    })

    it('rejects a document with no backend state', async () => {
      const result = await transportFor({ Self: {} } as TailscaleStatus).preflight()
      expect(result.ok).toBe(false)
    })
  })
})
