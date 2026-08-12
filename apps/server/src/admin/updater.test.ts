import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AGENT_IMAGE_TAG,
  buildAgentImage,
  runCommand,
  type CommandResult,
  type RunCommandOptions,
} from './updater.js'

describe('buildAgentImage', () => {
  it('runs docker build against the install Dockerfile context', async () => {
    const installRoot = await mkdtemp(join(tmpdir(), 'dukebox-image-'))
    const calls: string[] = []
    const logs: string[] = []
    let inheritStdio: boolean | undefined

    try {
      const result = await buildAgentImage({
        installRoot,
        log: (line) => logs.push(line),
        run: async (command, args, options?: RunCommandOptions): Promise<CommandResult> => {
          calls.push([command, ...args].join(' '))
          inheritStdio = options?.inheritStdio
          return { code: 0, stdout: '', stderr: '' }
        },
      })

      expect(result).toEqual({ ok: true, message: `built ${AGENT_IMAGE_TAG}` })
      expect(calls).toEqual([
        `docker build -t ${AGENT_IMAGE_TAG} ${join(installRoot, 'images/base-node')}`,
      ])
      expect(inheritStdio).toBe(true)
      expect(logs.some((line) => line.includes(AGENT_IMAGE_TAG))).toBe(true)
    } finally {
      await rm(installRoot, { recursive: true, force: true })
    }
  })

  it('surfaces docker build failures with a retry hint', async () => {
    const installRoot = await mkdtemp(join(tmpdir(), 'dukebox-image-'))

    try {
      const result = await buildAgentImage({
        installRoot,
        log: () => {},
        run: async () => ({
          code: 1,
          stdout: '',
          stderr: 'permission denied while trying to connect to the Docker daemon',
        }),
      })

      expect(result.ok).toBe(false)
      expect(result.message).toMatch(/could not build/)
      expect(result.message).toMatch(/duke image rebuild/)
      expect(result.message).toMatch(/Docker daemon/)
    } finally {
      await rm(installRoot, { recursive: true, force: true })
    }
  })
})

describe('runCommand', () => {
  it('captures stdout when liveLog spawns the child', async () => {
    const result = await runCommand(process.execPath, ['-e', "process.stdout.write('hello\\n')"], {
      liveLog: true,
    })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('hello')
  })

  it('reports a non-zero exit from a liveLog spawn', async () => {
    const result = await runCommand(process.execPath, ['-e', 'process.exit(7)'], { liveLog: true })
    expect(result.code).toBe(7)
  })
})
