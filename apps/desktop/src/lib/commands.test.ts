import { describe, expect, it } from 'vitest'
import { COMMANDS, filterCommands, RELOAD_WEBVIEW } from '@/lib/commands'

describe('filterCommands', () => {
  it('lists every command for an empty query', () => {
    expect(filterCommands('', COMMANDS)).toEqual(COMMANDS)
  })

  it('matches the label, case-insensitively', () => {
    expect(filterCommands('reload', COMMANDS)).toEqual([RELOAD_WEBVIEW])
    expect(filterCommands('RELOAD', COMMANDS)).toEqual([RELOAD_WEBVIEW])
  })

  it('matches keywords too', () => {
    expect(filterCommands('refresh', COMMANDS)).toEqual([RELOAD_WEBVIEW])
  })

  it('omits commands the query does not match', () => {
    expect(filterCommands('settings', COMMANDS)).toEqual([])
  })
})
