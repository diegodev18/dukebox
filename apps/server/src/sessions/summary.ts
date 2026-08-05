import type { EnvelopedEvent } from '@dukebox/protocol'

/**
 * A pull request that describes the work rather than the request.
 *
 * The session already contains what happened — what the agent said it did,
 * which files it touched, what the run cost. A fixed body throws all of that
 * away and leaves a reviewer opening the diff to find out what they are
 * looking at.
 */

export interface PullRequestContent {
  title: string
  body: string
}

/** The prompt that started the session, for the fallback title. */
const MAX_TITLE = 72

export function pullRequestContent(options: {
  prompt: string
  events: readonly EnvelopedEvent[]
  changedFiles: readonly string[]
  sessionId: string
  branch: string
}): PullRequestContent {
  const said = assistantText(options.events)

  return {
    title: titleFrom(said, options.prompt),
    body: bodyFrom({ ...options, said }),
  }
}

/**
 * Everything the agent said, in order.
 *
 * Its own account of the work is the closest thing to a summary that exists
 * without asking a model to write another one.
 */
function assistantText(events: readonly EnvelopedEvent[]): string {
  return events
    .map((enveloped) => enveloped.event)
    .filter((event) => event.type === 'assistant_text')
    .map((event) => event.delta)
    .join('')
    .trim()
}

/**
 * A title taken from what the agent reported, falling back to the prompt.
 *
 * The agent's closing summary usually opens with a sentence naming what it
 * did, which is a better title than the instruction it was given — "Translate
 * the README to Spanish" rather than "Traducelo al español".
 */
function titleFrom(said: string, prompt: string): string {
  const sentence = firstSentence(said)
  const candidate = sentence || prompt.trim()

  const singleLine = candidate.replace(/\s+/g, ' ').trim()
  if (singleLine.length <= MAX_TITLE) return singleLine || 'Agent changes'

  // Cut at a word boundary: a title ending mid-word reads as truncated data
  // rather than as a summary. One character short of the limit so the ellipsis
  // fits inside it.
  const cut = singleLine.slice(0, MAX_TITLE - 1)
  const lastSpace = cut.lastIndexOf(' ')
  const kept = lastSpace > 40 ? cut.slice(0, lastSpace) : cut

  // Trailing punctuation before an ellipsis reads as a typo.
  return `${kept.replace(/[\s,;:.]+$/, '')}…`
}

/**
 * The first sentence of the agent's prose.
 *
 * Sentences run across line breaks, so this works on the joined text rather
 * than line by line. Headings, list markers and code fences are formatting
 * rather than prose, and a heading like "Summary" as a pull request title
 * says nothing at all.
 */
function firstSentence(text: string): string {
  const prose = text
    .split('\n')
    // A `#` heading is a label for what follows, so taking it as the summary
    // loses the sentence it was labelling. Only explicit markdown headings are
    // dropped: guessing at unmarked ones swallows real prose.
    .filter((line) => !line.trim().startsWith('```') && !/^\s*#/.test(line))
    .map((line) => line.replace(/^\s*[-*]\s+/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (prose === '') return ''

  const end = prose.search(/[.!?](\s|$)/)
  return (end === -1 ? prose : prose.slice(0, end)).trim()
}

function bodyFrom(options: {
  said: string
  prompt: string
  changedFiles: readonly string[]
  sessionId: string
  branch: string
}): string {
  const sections: string[] = []

  if (options.said !== '') {
    sections.push(options.said)
  }

  if (options.changedFiles.length > 0) {
    const files = options.changedFiles.map((path) => `- \`${path}\``).join('\n')
    sections.push(`## Files changed\n\n${files}`)
  }

  // The prompt is worth keeping: it is why any of this happened, and a
  // reviewer asking "who asked for this" should not have to go looking.
  sections.push(
    [
      '<details>',
      '<summary>Session</summary>',
      '',
      `Asked for: ${options.prompt.trim()}`,
      '',
      `Branch \`${options.branch}\`, session \`${options.sessionId}\`.`,
      '',
      'Opened by [Dukebox](https://github.com/diegodev18/dukebox).',
      '</details>',
    ].join('\n'),
  )

  return sections.join('\n\n')
}
