import { describe, expect, it, vi } from 'vitest'
import {
  COMMANDS,
  commandsFor,
  filterCommands,
  RELOAD_WEBVIEW,
  runCommand,
  type CommandContext,
} from '@/lib/commands'
import { defaultSettings } from '@/lib/settings'

function context(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    settings: defaultSettings(),
    save: vi.fn(),
    checkForUpdates: vi.fn(),
    reload: vi.fn(),
    ...overrides,
  }
}

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

  it('finds theme and git commands by their labels', () => {
    expect(filterCommands('theme', COMMANDS).map((command) => command.id)).toEqual([
      'theme:system',
      'theme:light',
      'theme:dark',
    ])
    expect(filterCommands('draft', COMMANDS).map((command) => command.id)).toContain(
      'git:toggle-create-as-draft',
    )
  })
})

describe('commandsFor', () => {
  it('marks the current theme and merge choices', () => {
    const commands = commandsFor({
      ...defaultSettings(),
      theme: 'dark',
      git: { ...defaultSettings().git, mergeMethod: 'rebase', prDescription: 'heuristic' },
    })

    expect(commands.find((command) => command.id === 'theme:dark')?.detail).toBe('Current')
    expect(commands.find((command) => command.id === 'theme:light')?.detail).toBeUndefined()
    expect(commands.find((command) => command.id === 'git:merge:rebase')?.detail).toBe('Current')
    expect(commands.find((command) => command.id === 'git:merge:squash')?.detail).toBeUndefined()
    expect(commands.find((command) => command.id === 'git:pr-description:heuristic')?.detail).toBe(
      'Current',
    )
  })

  it('shows On/Off for toggles', () => {
    const off = commandsFor({
      ...defaultSettings(),
      checkForUpdatesOnLaunch: false,
      git: { ...defaultSettings().git, createAsDraft: false },
    })

    expect(off.find((command) => command.id === 'updates:toggle-check-on-launch')?.detail).toBe(
      'Off',
    )
    expect(off.find((command) => command.id === 'git:toggle-create-as-draft')?.detail).toBe('Off')
    expect(COMMANDS.find((command) => command.id === 'git:toggle-create-as-draft')?.detail).toBe(
      'On',
    )
  })

  it('disables Stop this session without a live session', () => {
    const none = COMMANDS.find((command) => command.id === 'session:stop')
    expect(none?.disabled).toBe(true)
    expect(none?.detail).toBe('No session')

    const stopped = commandsFor(defaultSettings(), {
      selectedId: 'sess-1',
      status: 'stopped',
    }).find((command) => command.id === 'session:stop')
    expect(stopped?.disabled).toBe(true)
    expect(stopped?.detail).toBe('Already stopped')

    const running = commandsFor(defaultSettings(), {
      selectedId: 'sess-1',
      status: 'running',
    }).find((command) => command.id === 'session:stop')
    expect(running?.disabled).toBe(false)
    expect(running?.detail).toBeUndefined()
  })
})

describe('runCommand', () => {
  it('reloads the webview', () => {
    const ctx = context()
    runCommand('reload-webview', ctx)
    expect(ctx.reload).toHaveBeenCalledOnce()
    expect(ctx.save).not.toHaveBeenCalled()
  })

  it('saves the chosen theme', () => {
    const ctx = context()
    runCommand('theme:dark', ctx)
    expect(ctx.save).toHaveBeenCalledWith({ theme: 'dark' })
  })

  it('asks the update feed', () => {
    const ctx = context()
    runCommand('updates:check', ctx)
    expect(ctx.checkForUpdates).toHaveBeenCalledOnce()
  })

  it('flips the launch-update preference', () => {
    const ctx = context()
    runCommand('updates:toggle-check-on-launch', ctx)
    expect(ctx.save).toHaveBeenCalledWith({ checkForUpdatesOnLaunch: false })
  })

  it('toggles a git preference without dropping the rest', () => {
    const settings = {
      ...defaultSettings(),
      git: { ...defaultSettings().git, createAsDraft: true, mergeMethod: 'rebase' as const },
    }
    const ctx = context({ settings })
    runCommand('git:toggle-create-as-draft', ctx)
    expect(ctx.save).toHaveBeenCalledWith({
      git: { ...settings.git, createAsDraft: false },
    })
  })

  it('sets the merge method and PR description', () => {
    const ctx = context()
    runCommand('git:merge:merge', ctx)
    expect(ctx.save).toHaveBeenCalledWith({
      git: { ...defaultSettings().git, mergeMethod: 'merge' },
    })

    runCommand('git:pr-description:dedicated', ctx)
    expect(ctx.save).toHaveBeenCalledWith({
      git: { ...defaultSettings().git, prDescription: 'dedicated' },
    })
  })

  it('stops the selected session', () => {
    const ctx = context({ stopSession: vi.fn() })
    runCommand('session:stop', ctx)
    expect(ctx.stopSession).toHaveBeenCalledOnce()
  })

  it('ignores an unknown id', () => {
    const ctx = context()
    runCommand('nope', ctx)
    expect(ctx.save).not.toHaveBeenCalled()
    expect(ctx.reload).not.toHaveBeenCalled()
    expect(ctx.checkForUpdates).not.toHaveBeenCalled()
  })
})
