import { describe, expect, it } from 'vitest'
import { DEFAULT_GIT_REF, defaultRepoUrl, gitVersionLabel, parseUpdateArgs } from './gitUpdate.js'

describe('gitVersionLabel', () => {
  it('builds a semver prerelease from the ref and short sha', () => {
    expect(gitVersionLabel('abc1234def56', 'main')).toBe('0.0.0-git.main.abc1234def56')
  })

  it('sanitizes odd ref names', () => {
    expect(gitVersionLabel('deadbeef', 'feature/foo bar')).toBe(
      '0.0.0-git.feature-foo-bar.deadbeef',
    )
  })

  it('falls back when the sha is empty', () => {
    expect(gitVersionLabel('')).toBe('0.0.0-git.main.unknown')
  })
})

describe('defaultRepoUrl', () => {
  it('points at the canonical GitHub remote', () => {
    expect(defaultRepoUrl('diegodev18', 'dukebox', undefined)).toBe(
      'https://github.com/diegodev18/dukebox.git',
    )
  })

  it('honours DUKEBOX_REPO_URL overrides', () => {
    expect(defaultRepoUrl('a', 'b', 'https://example.com/fork.git')).toBe(
      'https://example.com/fork.git',
    )
  })
})

describe('parseUpdateArgs', () => {
  it('defaults to a release update', () => {
    expect(parseUpdateArgs([])).toEqual({
      fromGit: false,
      ref: DEFAULT_GIT_REF,
      checkOnly: false,
      force: false,
    })
  })

  it('parses --from-git with the default ref', () => {
    expect(parseUpdateArgs(['--from-git'])).toEqual({
      fromGit: true,
      ref: 'main',
      checkOnly: false,
      force: false,
    })
  })

  it('parses --from-git with a positional ref', () => {
    expect(parseUpdateArgs(['--from-git', 'develop'])).toEqual({
      fromGit: true,
      ref: 'develop',
      checkOnly: false,
      force: false,
    })
  })

  it('parses --from-git=ref', () => {
    expect(parseUpdateArgs(['--from-git=abc1234'])).toEqual({
      fromGit: true,
      ref: 'abc1234',
      checkOnly: false,
      force: false,
    })
  })

  it('keeps --check and --force', () => {
    expect(parseUpdateArgs(['--from-git', 'main', '--check'])).toMatchObject({
      fromGit: true,
      ref: 'main',
      checkOnly: true,
    })
    expect(parseUpdateArgs(['--force', '--check'])).toEqual({
      fromGit: false,
      ref: 'main',
      checkOnly: true,
      force: true,
    })
  })
})
