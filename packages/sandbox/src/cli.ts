/**
 * Manual smoke test for the sandbox.
 *
 * Exercises the full container lifecycle against a real repository and prints
 * what happened at each step. The automated tests use a local origin for
 * speed; this one takes a real URL, so it also covers network access and clone
 * behaviour against a real host.
 *
 *   pnpm --filter @dukebox/sandbox exec tsx src/cli.ts <repo-url> [branch]
 */
import { randomUUID } from 'node:crypto'
import { Sandbox } from './container.js'
import { Workspace } from './workspace.js'

const IMAGE = process.env.DUKEBOX_TEST_IMAGE ?? 'dukebox/base-node:latest'

async function main() {
  const [url, baseBranch = 'main'] = process.argv.slice(2)

  if (!url) {
    console.error('usage: cli.ts <repo-url> [branch]')
    process.exit(1)
  }

  const sandbox = new Sandbox()
  const sessionId = randomUUID()

  console.log(`session ${sessionId}`)
  await sandbox.ping()
  console.log('✓ docker reachable')

  // Cloning needs network, unlike the default isolated configuration.
  const container = await sandbox.create({ sessionId, image: IMAGE, network: 'bridge' })
  console.log(`✓ container ${container.id.slice(0, 12)} started`)

  try {
    const workspace = new Workspace(container)

    const { branch } = await workspace.clone({ url, baseBranch, sessionId })
    console.log(`✓ cloned ${url} (${baseBranch}) onto ${branch}`)

    const base = await workspace.headCommit()
    console.log(`✓ base commit ${base.slice(0, 8)}`)

    // Stand in for an agent editing the workspace.
    await container.exec(['sh', '-c', 'echo "touched by dukebox" > DUKEBOX_SMOKE_TEST.md'], {
      cwd: '/workspace/repo',
    })

    const events = await workspace.diffEvents(base)
    console.log(`✓ ${events.length} file(s) changed:`)
    for (const event of events) {
      if (event.type !== 'file_diff') continue
      const kind = event.before === null ? 'created' : event.after === null ? 'deleted' : 'modified'
      console.log(`    ${kind.padEnd(8)} ${event.path}`)
    }

    const info = await container.inspect()
    console.log('✓ hardening:')
    console.log(`    privileged:    ${info.HostConfig.Privileged}`)
    console.log(`    capabilities:  dropped ${info.HostConfig.CapDrop?.join(', ')}`)
    const memoryGb = (info.HostConfig.Memory ?? 0) / 1024 ** 3
    console.log(`    memory:        ${memoryGb.toFixed(1)}g`)
    console.log(`    pids:          ${info.HostConfig.PidsLimit}`)
    console.log(
      `    docker.sock:   ${(info.HostConfig.Binds ?? []).some((b) => b.includes('docker.sock'))}`,
    )
  } finally {
    await container.remove()
    console.log('✓ container removed')
  }

  const remaining = await sandbox.list()
  console.log(`✓ ${remaining.length} managed container(s) left behind`)
}

main().catch((error: unknown) => {
  console.error('failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
