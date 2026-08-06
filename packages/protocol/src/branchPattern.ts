const REGEX_PREFIX = 're:'
export const MAX_BRANCH_PATTERN_LENGTH = 200

const NESTED_QUANTIFIER = /\([^)]*[+*][^)]*\)\s*[+*]/
const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\]/g

function globToRegexSource(pattern: string): string {
  const escaped = pattern.replace(REGEX_METACHARACTERS, '\\$&')
  const DOUBLESTAR_PLACEHOLDER = '\x00DOUBLESTAR\x00'

  return escaped
    .replace(/\\\*\\\*/g, DOUBLESTAR_PLACEHOLDER)
    .replace(/\\\*/g, '[^/]*')
    .replace(/\x00DOUBLESTAR\x00/g, '.*')
    .replace(/\\\?/g, '.')
}

function compile(pattern: string): RegExp | null {
  let source: string
  let isRegex = false

  if (pattern.startsWith(REGEX_PREFIX)) {
    source = pattern.slice(REGEX_PREFIX.length)
    isRegex = true
  } else {
    source = globToRegexSource(pattern)
  }

  try {
    const finalSource = isRegex ? `^(?:${source})` : `^(?:${source})$`
    return new RegExp(finalSource)
  } catch {
    return null
  }
}

export function matchesBranch(pattern: string, branch: string): boolean {
  const compiled = compile(pattern)
  if (!compiled) return false

  return compiled.test(branch)
}

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

export function resolveEnvironment<T extends { branchPattern: string; position: number }>(
  environments: T[],
  branch: string,
): T | null {
  const ordered = [...environments].sort((a, b) => a.position - b.position)

  return ordered.find((environment) => matchesBranch(environment.branchPattern, branch)) ?? null
}
