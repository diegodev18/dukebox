import { describe, expect, it } from 'vitest'
import { matchesBranch, resolveEnvironment, validateBranchPattern } from '@/branchPattern'

describe('matchesBranch — glob', () => {
  it('matches a literal branch name', () => {
    expect(matchesBranch('main', 'main')).toBe(true)
    expect(matchesBranch('main', 'develop')).toBe(false)
  })

  it('stops * at a slash', () => {
    expect(matchesBranch('*', 'main')).toBe(true)
    expect(matchesBranch('*', 'refact/auth')).toBe(false)
  })

  it('lets ** cross slashes', () => {
    expect(matchesBranch('**', 'main')).toBe(true)
    expect(matchesBranch('**', 'refact/auth')).toBe(true)
    expect(matchesBranch('**', 'refact/auth/deep')).toBe(true)
  })

  it('scopes a prefix to one segment with *', () => {
    expect(matchesBranch('refact/*', 'refact/auth')).toBe(true)
    expect(matchesBranch('refact/*', 'refact/auth/deep')).toBe(false)
    expect(matchesBranch('refact/*', 'feat/auth')).toBe(false)
  })

  it('spans segments with **', () => {
    expect(matchesBranch('refact/**', 'refact/auth')).toBe(true)
    expect(matchesBranch('refact/**', 'refact/auth/deep')).toBe(true)
  })

  it('matches exactly one character with ?', () => {
    expect(matchesBranch('v?', 'v1')).toBe(true)
    expect(matchesBranch('v?', 'v10')).toBe(false)
  })

  it('treats regex metacharacters as literals', () => {
    expect(matchesBranch('release.1', 'release.1')).toBe(true)
    expect(matchesBranch('release.1', 'releaseX1')).toBe(false)
  })
})

describe('matchesBranch — regex', () => {
  it('matches an alternation', () => {
    expect(matchesBranch('re:^(feat|fix)/', 'feat/x')).toBe(true)
    expect(matchesBranch('re:^(feat|fix)/', 'fix/x')).toBe(true)
    expect(matchesBranch('re:^(feat|fix)/', 'chore/x')).toBe(false)
  })

  it('anchors an unanchored pattern at both ends', () => {
    expect(matchesBranch('re:main', 'main')).toBe(true)
    expect(matchesBranch('re:main', 'feat/maintenance')).toBe(false)
    expect(matchesBranch('re:main', 'main-old')).toBe(false)
  })

  it('leaves the tail free when the user anchored the start', () => {
    // Someone writing `^(feat|fix)/` means "branches under feat/ or fix/".
    // Forcing a `$` onto that would make it match nothing at all.
    expect(matchesBranch('re:^(feat|fix)/', 'feat/auth')).toBe(true)
    expect(matchesBranch('re:^feat/', 'feat/a/b')).toBe(true)
  })

  it('respects an explicit end anchor', () => {
    expect(matchesBranch('re:^main$', 'main')).toBe(true)
    expect(matchesBranch('re:^main$', 'main-old')).toBe(false)
  })

  it('returns false for an invalid regex instead of throwing', () => {
    expect(() => matchesBranch('re:[unclosed', 'main')).not.toThrow()
    expect(matchesBranch('re:[unclosed', 'main')).toBe(false)
  })

  it('returns the same result on repeated calls', () => {
    // A regex compiled with the `g` flag carries lastIndex between calls and
    // produces intermittent false negatives. This is the guard against that.
    const pattern = 're:^feat/'
    expect(matchesBranch(pattern, 'feat/a')).toBe(true)
    expect(matchesBranch(pattern, 'feat/a')).toBe(true)
    expect(matchesBranch(pattern, 'feat/a')).toBe(true)
  })
})

describe('validateBranchPattern', () => {
  it('accepts ordinary globs and regexes', () => {
    expect(validateBranchPattern('**')).toEqual({ ok: true })
    expect(validateBranchPattern('refact/*')).toEqual({ ok: true })
    expect(validateBranchPattern('re:^(feat|fix)/')).toEqual({ ok: true })
  })

  it('rejects an empty pattern', () => {
    const result = validateBranchPattern('')
    expect(result.ok).toBe(false)
  })

  it('rejects a pattern over 200 characters', () => {
    const result = validateBranchPattern('a'.repeat(201))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('200')
  })

  it('rejects nested quantifiers', () => {
    expect(validateBranchPattern('re:(a+)+').ok).toBe(false)
    expect(validateBranchPattern('re:(a*)*').ok).toBe(false)
  })

  it('rejects a regex that does not compile', () => {
    const result = validateBranchPattern('re:[unclosed')
    expect(result.ok).toBe(false)
  })
})

describe('resolveEnvironment', () => {
  const envs = [
    { id: 'catch-all', branchPattern: '**', position: 1 },
    { id: 'refactors', branchPattern: 'refact/*', position: 0 },
  ]

  it('returns the lowest position among several matches', () => {
    expect(resolveEnvironment(envs, 'refact/auth')?.id).toBe('refactors')
  })

  it('falls through to a broader pattern when the narrow one misses', () => {
    expect(resolveEnvironment(envs, 'feat/x')?.id).toBe('catch-all')
  })

  it('returns null when nothing matches', () => {
    const only = [{ id: 'refactors', branchPattern: 'refact/*', position: 0 }]
    expect(resolveEnvironment(only, 'feat/x')).toBeNull()
  })

  it('returns null for an empty list', () => {
    expect(resolveEnvironment([], 'main')).toBeNull()
  })

  it('ignores an environment whose pattern is invalid', () => {
    const broken = [
      { id: 'broken', branchPattern: 're:[unclosed', position: 0 },
      { id: 'good', branchPattern: '**', position: 1 },
    ]
    expect(resolveEnvironment(broken, 'main')?.id).toBe('good')
  })
})
