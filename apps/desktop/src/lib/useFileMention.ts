import { useEffect, useMemo, useState } from 'react'
import { filterMentionPaths, mentionQueryAt } from '@/lib/fileMentions'

/**
 * The `@` mention that is open in a composer, if any.
 *
 * Escape hides the list until the person starts a new `@` token. Arrow keys
 * and the selected index live here so New Session and the session composer
 * share one set of rules.
 */

export function useFileMention(text: string, cursor: number, paths: readonly string[] | undefined) {
  const mention = mentionQueryAt(text, cursor)
  const matches = useMemo(
    () => (mention && paths ? filterMentionPaths(paths, mention.query) : []),
    [mention, paths],
  )
  const [index, setIndex] = useState(0)
  const [dismissedStart, setDismissedStart] = useState<number | null>(null)

  useEffect(() => {
    setIndex(0)
  }, [mention?.query, mention?.start])

  useEffect(() => {
    setIndex((current) => {
      if (matches.length === 0) return 0
      return Math.min(current, matches.length - 1)
    })
  }, [matches.length])

  useEffect(() => {
    if (!mention) setDismissedStart(null)
  }, [mention])

  const open = Boolean(mention && paths !== undefined && dismissedStart !== mention.start)

  return {
    mention,
    matches,
    index,
    setIndex,
    open,
    dismiss: () => {
      if (mention) setDismissedStart(mention.start)
    },
  }
}
