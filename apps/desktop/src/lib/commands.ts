/**
 * The command palette's catalogue.
 *
 * Commands are the app's own actions — reload the webview, and later anything
 * else a person might reach for without hunting through menus. Filtering is
 * local and cheap, so matching happens on every keystroke like the search
 * palette does for sessions.
 */

export interface Command {
  id: string
  label: string
  /** Extra words that should match but are not shown. */
  keywords?: string[]
}

/** Reloads the webview's loaded page: the dev URL in dev, the bundle in prod. */
export const RELOAD_WEBVIEW: Command = {
  id: 'reload-webview',
  label: 'Reload Webview',
  keywords: ['refresh', 'restart'],
}

export const COMMANDS: Command[] = [RELOAD_WEBVIEW]

export function filterCommands(query: string, commands: Command[]): Command[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return commands
  return commands.filter((command) =>
    [command.label, ...(command.keywords ?? [])].some((part) =>
      part.toLowerCase().includes(needle),
    ),
  )
}
