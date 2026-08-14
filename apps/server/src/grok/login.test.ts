import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { GROK_AUTH_SECRET, SecretStore } from '@/secrets/store'
import { GrokDeviceLogin, type LoginProcess } from '@/grok/login'

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  killed = false

  kill(): void {
    this.killed = true
    this.emit('close', 1)
  }
}

function secrets() {
  return {
    set: vi.fn(async () => {}),
    get: vi.fn(),
    has: vi.fn(),
    delete: vi.fn(),
    names: vi.fn(),
    environmentFor: vi.fn(),
  } as unknown as SecretStore
}

describe('GrokDeviceLogin', () => {
  it('starts installing then waits once the process is up', async () => {
    const child = new FakeProcess()
    const login = new GrokDeviceLogin({
      secrets: secrets(),
      ensureBinary: async () => '/tmp/grok',
      spawnLogin: () => child as unknown as LoginProcess,
    })

    const first = await login.start()
    expect(first.status).toBe('installing')

    await vi.waitFor(() => expect(login.snapshot().status).toBe('waiting'))
  })

  it('surfaces the device URL and code from process output', async () => {
    const child = new FakeProcess()
    const login = new GrokDeviceLogin({
      secrets: secrets(),
      ensureBinary: async () => '/tmp/grok',
      spawnLogin: () => child as unknown as LoginProcess,
    })

    await login.start()
    await vi.waitFor(() => expect(login.snapshot().status).toBe('waiting'))

    child.stderr.emit(
      'data',
      Buffer.from('Visit https://accounts.x.ai/activate and enter code ABCD-EFGH\n'),
    )

    expect(login.snapshot()).toMatchObject({
      status: 'waiting',
      url: 'https://accounts.x.ai/activate',
      userCode: 'ABCD-EFGH',
    })
  })

  it('stores auth.json when grok exits cleanly', async () => {
    const child = new FakeProcess()
    const store = secrets()
    const auth = '{"https://auth.x.ai":{"key":"sess"}}'
    const login = new GrokDeviceLogin({
      secrets: store,
      ensureBinary: async () => '/tmp/grok',
      spawnLogin: () => child as unknown as LoginProcess,
      readAuthFile: async () => auth,
    })

    await login.start()
    await vi.waitFor(() => expect(login.snapshot().status).toBe('waiting'))
    child.emit('close', 0)
    await vi.waitFor(() => expect(login.snapshot().status).toBe('success'))

    expect(store.set).toHaveBeenCalledWith(GROK_AUTH_SECRET, auth)
  })

  it('fails when grok exits without writing auth.json', async () => {
    const child = new FakeProcess()
    const login = new GrokDeviceLogin({
      secrets: secrets(),
      ensureBinary: async () => '/tmp/grok',
      spawnLogin: () => child as unknown as LoginProcess,
    })

    await login.start()
    await vi.waitFor(() => expect(login.snapshot().status).toBe('waiting'))
    child.stderr.emit('data', Buffer.from('authentication failed'))
    child.emit('close', 1)
    await vi.waitFor(() => expect(login.snapshot().status).toBe('failed'))
    expect(login.snapshot().error).toMatch(/authentication failed/)
  })

  it('reuses an in-flight login instead of starting a second process', async () => {
    const spawnLogin = vi.fn(() => new FakeProcess() as unknown as LoginProcess)
    const login = new GrokDeviceLogin({
      secrets: secrets(),
      ensureBinary: async () => '/tmp/grok',
      spawnLogin,
    })

    await login.start()
    await vi.waitFor(() => expect(spawnLogin).toHaveBeenCalledTimes(1))
    await login.start()
    expect(spawnLogin).toHaveBeenCalledTimes(1)
  })

  it('expires a login that outlives the TTL', async () => {
    const child = new FakeProcess()
    let now = 1_000
    const login = new GrokDeviceLogin({
      secrets: secrets(),
      ensureBinary: async () => '/tmp/grok',
      spawnLogin: () => child as unknown as LoginProcess,
      now: () => now,
      ttlMs: 50,
    })

    await login.start()
    await vi.waitFor(() => expect(login.snapshot().status).toBe('waiting'))
    now = 2_000
    expect(login.snapshot().status).toBe('expired')
    expect(child.killed).toBe(true)
  })

  it('cancel returns to idle and kills the process', async () => {
    const child = new FakeProcess()
    const login = new GrokDeviceLogin({
      secrets: secrets(),
      ensureBinary: async () => '/tmp/grok',
      spawnLogin: () => child as unknown as LoginProcess,
    })

    await login.start()
    await vi.waitFor(() => expect(login.snapshot().status).toBe('waiting'))
    expect(login.cancel().status).toBe('idle')
    expect(child.killed).toBe(true)
  })
})
