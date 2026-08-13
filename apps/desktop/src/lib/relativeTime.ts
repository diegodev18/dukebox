/**
 * How long ago, in as few characters as fit a list row.
 *
 * Exact times belong in the transcript; here the question is only whether
 * something is current.
 */
export function relativeAge(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000))

  if (seconds < 60) return 'now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86_400)}d`
}
