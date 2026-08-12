/**
 * A pull request that describes the work rather than the conversation.
 *
 * The transcript is a chat log. A reviewer opening GitHub wants to know what
 * changed and why, which lives in the commits, the diffstat, and the prompt
 * that started the session — not in everything the agent said along the way.
 */

export interface PullRequestContent {
  title: string
  body: string
}

const MAX_TITLE = 72

export function pullRequestContent(options: {
  prompt: string
  commits: readonly string[]
  diffStat: string
  changedFiles: readonly string[]
  sessionId: string
  branch: string
}): PullRequestContent {
  return {
    title: titleFrom(options.commits, options.prompt, options.changedFiles),
    body: bodyFrom(options),
  }
}

/**
 * A title taken from the commits, falling back to the prompt, then the files.
 *
 * One commit's subject is already a summary. Several commits mean the prompt
 * (why this session exists) is a better single line than concatenating them.
 */
function titleFrom(commits: readonly string[], prompt: string, files: readonly string[]): string {
  const fromCommit = commits.length === 1 ? commits[0]?.trim() : ''
  const candidate = fromCommit || prompt.trim() || filesTitle(files)

  const singleLine = candidate.replace(/\s+/g, ' ').trim()
  if (singleLine.length <= MAX_TITLE) return singleLine || 'Agent changes'

  const cut = singleLine.slice(0, MAX_TITLE - 1)
  const lastSpace = cut.lastIndexOf(' ')
  const kept = lastSpace > 40 ? cut.slice(0, lastSpace) : cut

  return `${kept.replace(/[\s,;:.]+$/, '')}…`
}

function filesTitle(files: readonly string[]): string {
  if (files.length === 0) return ''
  if (files.length === 1) return `Update ${files[0]}`
  return `Update ${files.length} files`
}

function bodyFrom(options: {
  prompt: string
  commits: readonly string[]
  diffStat: string
  changedFiles: readonly string[]
  sessionId: string
  branch: string
}): string {
  const sections: string[] = []

  const summary = summaryParagraph(options.commits, options.prompt)
  if (summary) sections.push(`## Summary\n\n${summary}`)

  if (options.changedFiles.length > 0) {
    const files = options.changedFiles.map((path) => `- \`${path}\``).join('\n')
    sections.push(`## Files changed\n\n${files}`)
  }

  const stat = options.diffStat.trim()
  if (stat) {
    sections.push(`## Diff\n\n\`\`\`\n${stat}\n\`\`\``)
  }

  sections.push(
    [
      '<details>',
      '<summary>Session</summary>',
      '',
      `Asked for: ${options.prompt.trim() || '(none)'}`,
      '',
      `Branch \`${options.branch}\`, session \`${options.sessionId}\`.`,
      '',
      'Opened by [Dukebox](https://github.com/diegodev18/dukebox).',
      '</details>',
    ].join('\n'),
  )

  return sections.join('\n\n')
}

function summaryParagraph(commits: readonly string[], prompt: string): string {
  if (commits.length === 1 && commits[0]) return commits[0].trim()
  if (commits.length > 1) {
    const list = commits.map((commit) => `- ${commit.trim()}`).join('\n')
    return prompt.trim() ? `${prompt.trim()}\n\n${list}` : list
  }
  return prompt.trim()
}
