import { DEFAULT_GIT_PREFERENCES, type GitPreferences } from '@dukebox/protocol'
import { defaultSettings, type Settings, type Theme } from '@/lib/settings'

/**
 * The command palette's catalogue.
 *
 * Commands are the app's own actions — reload the webview, flip a preference,
 * pick a theme — so they can be reached without hunting through Settings.
 * Filtering is local and cheap, so matching happens on every keystroke like
 * the search palette does for sessions.
 */

export interface Command {
  id: string
  label: string
  /** Extra words that should match but are not shown. */
  keywords?: string[]
  /** Current value, shown muted after the label. */
  detail?: string
}

export interface CommandContext {
  settings: Settings
  save: (patch: Partial<Settings>) => void
  checkForUpdates: () => void
  reload: () => void
}

/** Reloads the webview's loaded page: the dev URL in dev, the bundle in prod. */
export const RELOAD_WEBVIEW: Command = {
  id: 'reload-webview',
  label: 'Reload Webview',
  keywords: ['refresh', 'restart'],
}

/** The catalogue against default settings — useful when no live store is in hand. */
export const COMMANDS: Command[] = commandsFor(defaultSettings())

export function commandsFor(settings: Settings): Command[] {
  const git = gitPrefs(settings)
  return [
    RELOAD_WEBVIEW,
    themeCommand('system', 'System', settings.theme),
    themeCommand('light', 'Light', settings.theme),
    themeCommand('dark', 'Dark', settings.theme),
    {
      id: 'updates:check',
      label: 'Check for updates now',
      keywords: ['upgrade', 'version'],
    },
    {
      id: 'updates:toggle-check-on-launch',
      label: 'Check for updates on launch',
      keywords: ['auto update', 'check on launch'],
      detail: onOff(settings.checkForUpdatesOnLaunch),
    },
    toggleCommand(
      'git:toggle-create-as-draft',
      'Create pull requests as drafts',
      git.createAsDraft,
      ['draft pr'],
    ),
    toggleCommand('git:toggle-auto-open-draft', 'Open a draft automatically', git.autoOpenDraft, [
      'auto open',
      'push',
    ]),
    toggleCommand(
      'git:toggle-commit-on-turn-end',
      'Commit leftover changes at the end of a turn',
      git.commitOnTurnEnd,
      ['uncommitted'],
    ),
    toggleCommand(
      'git:toggle-delete-branch-after-merge',
      'Delete the branch after merge',
      git.deleteBranchAfterMerge,
      ['cleanup'],
    ),
    choiceCommand('git:merge:squash', 'Merge method: Squash', git.mergeMethod === 'squash', [
      'git',
    ]),
    choiceCommand('git:merge:merge', 'Merge method: Merge commit', git.mergeMethod === 'merge', [
      'git',
    ]),
    choiceCommand('git:merge:rebase', 'Merge method: Rebase', git.mergeMethod === 'rebase', [
      'git',
    ]),
    choiceCommand(
      'git:pr-description:auto',
      'Pull request description: Auto',
      git.prDescription === 'auto',
      ['pr body', 'title'],
    ),
    choiceCommand(
      'git:pr-description:dedicated',
      'Pull request description: Dedicated model',
      git.prDescription === 'dedicated',
      ['pr body', 'title'],
    ),
    choiceCommand(
      'git:pr-description:heuristic',
      'Pull request description: Git only',
      git.prDescription === 'heuristic',
      ['pr body', 'title', 'heuristic'],
    ),
  ]
}

export function filterCommands(query: string, commands: Command[]): Command[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return commands
  return commands.filter((command) =>
    [command.label, ...(command.keywords ?? [])].some((part) =>
      part.toLowerCase().includes(needle),
    ),
  )
}

export function runCommand(id: string, ctx: CommandContext): void {
  switch (id) {
    case 'reload-webview':
      ctx.reload()
      return
    case 'theme:system':
      ctx.save({ theme: 'system' })
      return
    case 'theme:light':
      ctx.save({ theme: 'light' })
      return
    case 'theme:dark':
      ctx.save({ theme: 'dark' })
      return
    case 'updates:check':
      ctx.checkForUpdates()
      return
    case 'updates:toggle-check-on-launch':
      ctx.save({ checkForUpdatesOnLaunch: !ctx.settings.checkForUpdatesOnLaunch })
      return
    case 'git:toggle-create-as-draft':
      patchGit(ctx, { createAsDraft: !gitPrefs(ctx.settings).createAsDraft })
      return
    case 'git:toggle-auto-open-draft':
      patchGit(ctx, { autoOpenDraft: !gitPrefs(ctx.settings).autoOpenDraft })
      return
    case 'git:toggle-commit-on-turn-end':
      patchGit(ctx, { commitOnTurnEnd: !gitPrefs(ctx.settings).commitOnTurnEnd })
      return
    case 'git:toggle-delete-branch-after-merge':
      patchGit(ctx, {
        deleteBranchAfterMerge: !gitPrefs(ctx.settings).deleteBranchAfterMerge,
      })
      return
    case 'git:merge:squash':
      patchGit(ctx, { mergeMethod: 'squash' })
      return
    case 'git:merge:merge':
      patchGit(ctx, { mergeMethod: 'merge' })
      return
    case 'git:merge:rebase':
      patchGit(ctx, { mergeMethod: 'rebase' })
      return
    case 'git:pr-description:auto':
      patchGit(ctx, { prDescription: 'auto' })
      return
    case 'git:pr-description:dedicated':
      patchGit(ctx, { prDescription: 'dedicated' })
      return
    case 'git:pr-description:heuristic':
      patchGit(ctx, { prDescription: 'heuristic' })
      return
  }
}

function themeCommand(id: Theme, label: string, current: Theme): Command {
  return choiceCommand(`theme:${id}`, `Theme: ${label}`, current === id, [
    'appearance',
    'colour',
    'color',
    'scheme',
  ])
}

function toggleCommand(id: string, label: string, on: boolean, keywords: string[]): Command {
  return { id, label, keywords, detail: onOff(on) }
}

function choiceCommand(id: string, label: string, selected: boolean, keywords: string[]): Command {
  return selected ? { id, label, keywords, detail: 'Current' } : { id, label, keywords }
}

function onOff(on: boolean): string {
  return on ? 'On' : 'Off'
}

function gitPrefs(settings: Settings): GitPreferences {
  return { ...DEFAULT_GIT_PREFERENCES, ...settings.git }
}

function patchGit(ctx: CommandContext, partial: Partial<GitPreferences>): void {
  ctx.save({ git: { ...gitPrefs(ctx.settings), ...partial } })
}
