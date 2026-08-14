import { describe, expect, it } from 'vitest'
import { parseDeviceAuthOutput } from '@/grok/parse'

describe('parseDeviceAuthOutput', () => {
  it('reads a visit-and-enter sentence', () => {
    expect(
      parseDeviceAuthOutput(
        'Please visit https://accounts.x.ai/activate and enter code ABCD-EFGH to continue.',
      ),
    ).toEqual({ url: 'https://accounts.x.ai/activate', userCode: 'ABCD-EFGH' })
  })

  it('reads a labelled code on its own line', () => {
    expect(
      parseDeviceAuthOutput('Open https://grok.com/device\nCode: WXYZ-1234\nWaiting…'),
    ).toEqual({ url: 'https://grok.com/device', userCode: 'WXYZ-1234' })
  })

  it('strips trailing punctuation from the URL', () => {
    expect(parseDeviceAuthOutput('Go to https://auth.x.ai/device.').url).toBe(
      'https://auth.x.ai/device',
    )
  })

  it('returns nothing useful for unrelated output', () => {
    expect(parseDeviceAuthOutput('downloading…')).toEqual({})
  })
})
