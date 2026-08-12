import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AGENT_IMAGE_TAG, buildAgentImage, type CommandResult } from './updater.js'

describe('buildAgentImage', () => {
  it('runs docker build against the install Dockerfile context', async () => {
    const installRoot = await mkdtemp(join(tmpdir(), 'dukebox-image-'))
    const calls: string[] = []
    const logs: string[] = []

    try {
      const result = await buildAgentImage({
        installRoot,
        log: (line) => logs.push(line),
        run: async (command, args): Promise<CommandResult> => {
          calls.push([command, ...args].join(' '))
          return { code: 0, stdout: '', stderr: '' }
        },
      })

      expect(result).toEqual({ ok: true, message: `built ${AGENT_IMAGE_TAG}` })
      expect(calls).toEqual([
        `docker build -t ${AGENT_IMAGE_TAG} ${join(installRoot, 'images/base-node')}`,
      ])
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
