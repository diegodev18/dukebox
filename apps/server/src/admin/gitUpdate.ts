import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { archName, REPO_NAME, REPO_OWNER } from './update.js'
import { installStaging, runCommand, type UpdateResult } from './updater.js'

/** Default branch tracked when an operator opts out of waiting for releases. */
export const DEFAULT_GIT_REF = 'main'

/** pnpm version the monorepo pins; keep in sync with the root packageManager field. */
export const PNPM_VERSION = '10.24.0'

export function defaultRepoUrl(
  owner = REPO_OWNER,
  repo = REPO_NAME,
  override = process.env.DUKEBOX_REPO_URL,
): string {
  return override && override.length > 0 ? override : `https://github.com/${owner}/${repo}.git`
}

/**
 * Version string written into the release-style VERSION file for a git-built
 * install. Semver-shaped so `duke update` (release) still compares cleanly —
 * any published `server-vX.Y.Z` is newer than `0.0.0-git.*`.
 */
export function gitVersionLabel(shortSha: string, ref = DEFAULT_GIT_REF): string {
  const safeRef = ref.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'git'
  const sha = shortSha
    .replace(/[^a-f0-9]/gi, '')
    .toLowerCase()
    .slice(0, 12)
  return `0.0.0-git.${safeRef}.${sha || 'unknown'}`
}

/**
 * Parse `duke update` argv after the command name.
 *
 *   duke update --from-git
 *   duke update --from-git main
 *   duke update --from-git=abc1234
 *   duke update --check
 *   duke update --force
 */
export function parseUpdateArgs(args: string[]): {
  fromGit: boolean
  ref: string
  checkOnly: boolean
  force: boolean
} {
  let fromGit = false
  let ref = DEFAULT_GIT_REF
  let checkOnly = false
  let force = false
  let sawRef = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--from-git') {
      fromGit = true
      const next = args[i + 1]
      if (next && !next.startsWith('-')) {
        ref = next
        sawRef = true
        i++
      }
      continue
    }
    if (arg.startsWith('--from-git=')) {
      fromGit = true
      const value = arg.slice('--from-git='.length)
      if (value) {
        ref = value
        sawRef = true
      }
      continue
    }
    if (arg === '--check') {
      checkOnly = true
      continue
    }
    if (arg === '--force') {
      force = true
      continue
    }
    // A bare positional is the git ref when --from-git was already seen without one.
    if (!arg.startsWith('-') && fromGit && !sawRef) {
      ref = arg
      sawRef = true
    }
  }

  return { fromGit, ref, checkOnly, force }
}

export interface PerformGitUpdateOptions {
  installRoot: string
  /** Branch, tag, or commit-ish to build. Defaults to `main`. */
  ref: string
  repoUrl: string
  configPath: string
  service: string
  serviceUser: string
  log: (line: string) => void
  /** Override for tests. */
  run?: typeof runCommand
  /** Override for tests. */
  install?: typeof installStaging
}

/**
 * Clone a git ref, build a release-style bundle on the machine, and swap it in.
 *
 * This is how an operator tracks `main` (or any other ref) without waiting for
 * a published `server-v*` release. The install still ends up as a self-contained
 * bundle under `/opt/dukebox` — same layout as `duke update` — so rollback and
 * later release updates keep working.
 */
export async function performGitUpdate(options: PerformGitUpdateOptions): Promise<UpdateResult> {
  const run = options.run ?? runCommand
  const install = options.install ?? installStaging
  const { installRoot, ref, repoUrl, configPath, service, serviceUser, log } = options

  const workDir = await mkdtemp(join(tmpdir(), 'dukebox-git-'))
  const stagingDir = `${installRoot}.new`

  try {
    const git = await run('git', ['--version'])
    if (git.code !== 0) {
      return {
        ok: false,
        message: 'git is not installed. Install git and retry, or use `duke update` for a release.',
      }
    }

    log(`Cloning ${repoUrl} @ ${ref}`)
    // Shallow fetch of one ref keeps the download small and works for branches,
    // tags, and commit SHAs alike (`git clone --branch` only accepts names).
    const init = await run('git', ['init', '--quiet', workDir])
    if (init.code !== 0) {
      return { ok: false, message: `git init failed: ${init.stderr.trim() || init.stdout.trim()}` }
    }
    const remote = await run('git', ['-C', workDir, 'remote', 'add', 'origin', repoUrl])
    if (remote.code !== 0) {
      return {
        ok: false,
        message: `could not add remote: ${remote.stderr.trim() || remote.stdout.trim()}`,
      }
    }
    const fetch = await run('git', [
      '-C',
      workDir,
      'fetch',
      '--depth',
      '1',
      '--quiet',
      'origin',
      ref,
    ])
    if (fetch.code !== 0) {
      return {
        ok: false,
        message: `could not fetch ${ref}: ${fetch.stderr.trim() || fetch.stdout.trim()}`,
      }
    }
    const checkout = await run('git', ['-C', workDir, 'checkout', '--quiet', 'FETCH_HEAD'])
    if (checkout.code !== 0) {
      return {
        ok: false,
        message: `could not check out ${ref}: ${checkout.stderr.trim() || checkout.stdout.trim()}`,
      }
    }

    const rev = await run('git', ['-C', workDir, 'rev-parse', '--short=12', 'HEAD'])
    if (rev.code !== 0) {
      return { ok: false, message: `could not read HEAD: ${rev.stderr.trim()}` }
    }
    const shortSha = rev.stdout.trim()
    const version = gitVersionLabel(shortSha, ref)
    log(`Building server bundle from ${shortSha} (${version})`)

    const pnpmReady = await ensurePnpm(run, log)
    if (!pnpmReady.ok) return pnpmReady

    log('Installing dependencies')
    const deps = await run('pnpm', ['install', '--frozen-lockfile'], {
      cwd: workDir,
      env: { ...process.env, CI: '1' },
      liveLog: true,
    })
    if (deps.code !== 0) {
      return {
        ok: false,
        message: `pnpm install failed: ${deps.stderr.trim() || deps.stdout.trim()}`,
      }
    }

    const pack = await run('bash', [join(workDir, 'scripts/package-server.sh'), version], {
      cwd: workDir,
      env: { ...process.env, CI: '1' },
      liveLog: true,
    })
    if (pack.code !== 0) {
      return {
        ok: false,
        message: `build failed: ${pack.stderr.trim() || pack.stdout.trim()}`,
      }
    }

    const tarball = join(
      workDir,
      'dist-release',
      `dukebox-server-${version}-linux-${archName()}.tar.gz`,
    )
    await rm(stagingDir, { recursive: true, force: true })
    await mkdir(stagingDir)

    log('Extracting built bundle')
    const extract = await run('tar', ['-xzf', tarball, '-C', stagingDir])
    if (extract.code !== 0) {
      return {
        ok: false,
        message: `extraction failed: ${extract.stderr.trim() || `missing ${tarball}`}`,
      }
    }

    return await install({
      installRoot,
      stagingDir,
      configPath,
      service,
      serviceUser,
      successMessage: `updated from git ${ref} @ ${shortSha} (${version}). The service restarted successfully.`,
      log,
      run,
    })
  } finally {
    await rm(workDir, { recursive: true, force: true })
    await rm(stagingDir, { recursive: true, force: true })
  }
}

async function ensurePnpm(
  run: typeof runCommand,
  log: (line: string) => void,
): Promise<UpdateResult> {
  const existing = await run('pnpm', ['--version'])
  if (existing.code === 0) return { ok: true, message: existing.stdout.trim() }

  log(`Installing pnpm@${PNPM_VERSION} via corepack`)
  const enable = await run('corepack', ['enable'])
  if (enable.code !== 0) {
    return {
      ok: false,
      message: `corepack enable failed: ${enable.stderr.trim() || enable.stdout.trim()}. Install pnpm@${PNPM_VERSION} and retry.`,
    }
  }
  const prepare = await run('corepack', ['prepare', `pnpm@${PNPM_VERSION}`, '--activate'])
  if (prepare.code !== 0) {
    return {
      ok: false,
      message: `corepack prepare failed: ${prepare.stderr.trim() || prepare.stdout.trim()}`,
    }
  }
  const verify = await run('pnpm', ['--version'])
  if (verify.code !== 0) {
    return { ok: false, message: 'pnpm was installed but is not on PATH' }
  }
  return { ok: true, message: verify.stdout.trim() }
}
