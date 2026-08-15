/**
 * `@` file mentions in a prompt.
 *
 * The agent already has the repository; mentioning a path is enough. The
 * composer turns `@` into a filtered list of workspace (or GitHub) paths so
 * people do not have to type them from memory.
 */

/** An `@`-mention being typed at the cursor. */
export type FileMentionQuery = {
  /** Index of the `@`. */
  start: number
  /** Text after `@` up to the cursor. Never contains whitespace. */
  query: string
}

/** Find the `@token` that contains the cursor, if the `@` starts a word. */
export function mentionQueryAt(text: string, cursor: number): FileMentionQuery | null {
  if (cursor < 0 || cursor > text.length) return null

  const before = text.slice(0, cursor)
  const match = /(^|[\s])@([^\s]*)$/.exec(before)
  if (!match) return null

  const query = match[2] ?? ''
  return { start: before.length - query.length - 1, query }
}

/** Ranked, truncated matches for a mention query. Empty query lists the first paths. */
export function filterMentionPaths(paths: readonly string[], query: string, limit = 20): string[] {
  const needle = query.trim().toLowerCase()
  const scored: { path: string; score: number }[] = []

  for (const path of paths) {
    const score = mentionScore(path, needle)
    if (score > 0) scored.push({ path, score })
  }

  scored.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score
    return left.path.localeCompare(right.path)
  })

  return scored.slice(0, limit).map((entry) => entry.path)
}

function mentionScore(path: string, needle: string): number {
  if (!needle) return 1

  const lower = path.toLowerCase()
  const slash = lower.lastIndexOf('/')
  const name = slash === -1 ? lower : lower.slice(slash + 1)

  if (name === needle) return 100
  if (name.startsWith(needle)) return 80
  if (name.includes(needle)) return 60
  if (lower.includes(needle)) return 40
  return 0
}

/** Replace the in-progress `@query` with `@path ` and put the cursor after it. */
export function insertMention(
  text: string,
  start: number,
  cursor: number,
  path: string,
): { text: string; cursor: number } {
  const inserted = `@${path} `
  return {
    text: `${text.slice(0, start)}${inserted}${text.slice(cursor)}`,
    cursor: start + inserted.length,
  }
}

export function fileNameOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? path : path.slice(slash + 1)
}

export function fileDirOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}
