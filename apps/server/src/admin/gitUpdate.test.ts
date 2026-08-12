import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_GIT_REF,
  defaultRepoUrl,
  gitVersionLabel,
  parseUpdateArgs,
  performGitUpdate,
} from './gitUpdate.js'
import type { CommandResult } from './updater.js'

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

describe('performGitUpdate', () => {
  it('clones a ref, builds a bundle, and hands it to installStaging', async () => {
    const installRoot = await mkdtemp(join(tmpdir(), 'dukebox-root-'))
    const calls: string[] = []
    const logs: string[] = []

    const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' })
    const run = async (command: string, args: string[]): Promise<CommandResult> => {
      calls.push([command, ...args].join(' '))
      if (command === 'git' && args.includes('rev-parse')) return ok('abc1234def56\n')
      if (command === 'pnpm' && args[0] === '--version') return ok('10.24.0\n')
      return ok()
    }

    try {
      const result = await performGitUpdate({
        installRoot,
        ref: 'main',
        repoUrl: 'https://github.com/diegodev18/dukebox.git',
        configPath: '/etc/dukebox/config.toml',
        service: 'dukebox',
        serviceUser: 'dukebox',
        log: (line) => logs.push(line),
        run,
        install: async (options) => {
          expect(options.installRoot).toBe(installRoot)
          expect(options.successMessage).toContain('abc1234def56')
          return { ok: true, message: options.successMessage }
        },
      })

      expect(result.ok).toBe(true)
      expect(calls.some((call) => call.includes('fetch') && call.includes('main'))).toBe(true)
      expect(calls.some((call) => call.includes('package-server.sh'))).toBe(true)
      expect(calls.some((call) => call.startsWith('pnpm install'))).toBe(true)
      expect(logs.some((line) => line.includes('Cloning'))).toBe(true)
    } finally {
      await rm(installRoot, { recursive: true, force: true })
      await rm(`${installRoot}.new`, { recursive: true, force: true })
    }
  })

  it('fails early when git is missing', async () => {
    const installRoot = await mkdtemp(join(tmpdir(), 'dukebox-root-'))
    try {
      const result = await performGitUpdate({
        installRoot,
        ref: 'main',
        repoUrl: 'https://github.com/diegodev18/dukebox.git',
        configPath: '/etc/dukebox/config.toml',
        service: 'dukebox',
        serviceUser: 'dukebox',
        log: () => {},
        run: async () => ({ code: 127, stdout: '', stderr: 'git: not found' }),
        install: async () => {
          throw new Error('should not install')
        },
      })
      expect(result.ok).toBe(false)
      expect(result.message).toMatch(/git is not installed/)
    } finally {
      await rm(installRoot, { recursive: true, force: true })
    }
  })
})
