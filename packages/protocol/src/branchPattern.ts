/**
 * Which branches an environment is available for.
 *
 * Patterns are glob by default because branch names are paths and glob is the
 * syntax people already use for them in gitignore and in branch protection.
 * A re: prefix opts into a regular expression for the cases glob cannot
 * express.
 *
 * This module is pure and lives in protocol because both sides need it: the
 * server resolves a branch to an environment, and the app previews which
 * branches a pattern would match while the user is typing it.
 */

/** Regex prefix. Anything else is read as a glob. */
const REGEX_PREFIX = 're:'

/**
 * Cap on pattern length.
 *
 * Patterns are user-written and evaluated on the server, so an unbounded one
 * is an invitation to burn CPU on backtracking.
 */
export const MAX_BRANCH_PATTERN_LENGTH = 200

/**
 * A quantified group that is itself quantified - (a+)+, (a*)*
 *
 * This is the classic catastrophic-backtracking shape. Rejecting it on the
 * source is cruder than analysing the compiled pattern, but it costs nothing
 * and no legitimate branch pattern needs one.
 */
const NESTED_QUANTIFIER = /\([^)]*[+*][^)]*\)\s*[+*]/

/** Characters that mean something to a regex and must survive a glob literally. */
const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\]/g

/**
 * Translate a glob into a regex source string.
 *
 * Everything is escaped first, then the escaped wildcards are put back as
 * regex fragments. Doing it in that order is what keeps release.1 from
 * matching releaseX1.
 *
 * ** is handled before * so the two-character wildcard is not consumed as
 * two one-character ones.
 */
function globToRegexSource(pattern: string): string {
  const escaped = pattern.replace(REGEX_METACHARACTERS, '\\$&')
  // Use NUL bytes as placeholder to avoid collisions with branch names that
  // might contain the literal text another placeholder would use.
  const DOUBLESTAR_PLACEHOLDER = '\x00DOUBLESTAR\x00'

  return escaped
    .replace(/\\\*\\\*/g, DOUBLESTAR_PLACEHOLDER)
    .replace(/\\\*/g, '[^/]*')
    .replace(/\x00DOUBLESTAR\x00/g, '.*')
    .replace(/\\\?/g, '.')
}

/**
 * Compile a pattern to an anchored regex, or null if it cannot be compiled.
 *
 * Never carries the g flag: a global regex keeps lastIndex between calls,
 * which would make repeated matching of the same pattern return alternating
 * results.
 */
function compile(pattern: string): RegExp | null {
  const isRegex = pattern.startsWith(REGEX_PREFIX)

  const source = isRegex ? pattern.slice(REGEX_PREFIX.length) : globToRegexSource(pattern)

  try {
    // A glob describes the whole branch name, so it is always anchored at both
    // ends.
    if (!isRegex) return new RegExp(`^(?:${source})$`)

    // A regex keeps whatever anchoring its author wrote. Adding the missing
    // ^ is what stops re:main matching feat/maintenance or main-old —
    // substring matching on a branch filter surprises everyone. But a pattern
    // that anchored its own start, like ^(feat|fix)/, means branches under
    // these prefixes: forcing a $ onto it would make it match nothing.
    const anchoredStart = source.startsWith('^')
    const anchoredEnd = source.endsWith('$')

    const head = anchoredStart ? '' : '^(?:'
    const tail = anchoredStart ? '' : anchoredEnd ? ')' : ')$'

    return new RegExp(`${head}${source}${tail}`)
  } catch {
    return null
  }
}

/**
 * Whether a branch is covered by a pattern.
 *
 * An uncompilable pattern matches nothing rather than throwing: a broken
 * pattern should drop its own environment out of the list, not break session
 * start for every other one.
 */
export function matchesBranch(pattern: string, branch: string): boolean {
  const compiled = compile(pattern)
  if (!compiled) return false

  return compiled.test(branch)
}

/**
 * Whether a pattern is safe and usable, with a reason when it is not.
 *
 * Called by the write endpoints, not only by the UI - the app is not the
 * gatekeeper for something the server evaluates.
 */
export function validateBranchPattern(
  pattern: string,
): { ok: true } | { ok: false; reason: string } {
  if (pattern.trim().length === 0) {
    return { ok: false, reason: 'pattern cannot be empty' }
  }

  if (pattern.length > MAX_BRANCH_PATTERN_LENGTH) {
    return {
      ok: false,
      reason: `pattern cannot exceed ${MAX_BRANCH_PATTERN_LENGTH} characters`,
    }
  }

  if (pattern.startsWith(REGEX_PREFIX)) {
    const source = pattern.slice(REGEX_PREFIX.length)

    if (NESTED_QUANTIFIER.test(source)) {
      return { ok: false, reason: 'nested quantifiers are not allowed' }
    }

    if (!compile(pattern)) {
      return { ok: false, reason: 'not a valid regular expression' }
    }
  }

  return { ok: true }
}

/**
 * The environment a branch should use, or null for the base image.
 *
 * Ties are broken by explicit position rather than by how specific a pattern
 * looks: glob specificity is not well defined - between feat/ and /auth
 * neither is obviously narrower - and mixing regex in makes it undecidable.
 */
export function resolveEnvironment<T extends { branchPattern: string; position: number }>(
  environments: T[],
  branch: string,
): T | null {
  const ordered = [...environments].sort((a, b) => a.position - b.position)

  return ordered.find((environment) => matchesBranch(environment.branchPattern, branch)) ?? null
}
