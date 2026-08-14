import { describe, expect, it, vi } from 'vitest'
import type { SessionContainer } from '@dukebox/sandbox'
import { extensionFor, sanitizeUploadName, stageUpload, UPLOADS_DIR } from '@/uploads'

describe('sanitizeUploadName', () => {
  it('keeps an ordinary filename as-is', () => {
    expect(sanitizeUploadName('report.pdf')).toBe('report.pdf')
  })

  it('keeps the basename when handed a path', () => {
    expect(sanitizeUploadName('../../etc/passwd')).toBe('passwd')
    expect(sanitizeUploadName('a/b/c.txt')).toBe('c.txt')
  })

  it('replaces characters that are unsafe on the shell', () => {
    expect(sanitizeUploadName('a b;rm -rf /')).toMatch(/^[A-Za-z0-9._-]+$/)
  })

  it('falls back when the name reduces to nothing', () => {
    expect(sanitizeUploadName('../..')).not.toBe('')
  })
})

describe('extensionFor', () => {
  it('maps known media types', () => {
    expect(extensionFor('image/png')).toBe('png')
    expect(extensionFor('image/jpeg')).toBe('jpg')
  })

  it('returns undefined for an unknown type', () => {
    expect(extensionFor('application/x-whatever')).toBeUndefined()
  })
})

describe('stageUpload', () => {
  it('writes the payload into /tmp/imgs via stdin, not an env var', async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    const container = { exec } as unknown as SessionContainer

    const path = await stageUpload(container, 'notes.txt', 'aGVsbG8=')

    expect(path).toBe(`${UPLOADS_DIR}/notes.txt`)
    expect(exec).toHaveBeenCalledWith(
      ['sh', '-c', `mkdir -p ${UPLOADS_DIR} && base64 -d > ${path}`],
      { stdin: 'aGVsbG8=' },
    )
    const options = exec.mock.calls[0]?.[1] as { env?: unknown; stdin?: unknown }
    expect(options.env).toBeUndefined()
  })

  it('pipes a payload larger than Linux MAX_ARG_STRLEN through stdin', async () => {
    // A single env var cannot exceed ~128 KiB on Linux. Real screenshots do.
    const payload = 'A'.repeat(200_000)
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    const container = { exec } as unknown as SessionContainer

    await stageUpload(container, 'shot.png', payload)

    expect(exec).toHaveBeenCalledWith(
      ['sh', '-c', `mkdir -p ${UPLOADS_DIR} && base64 -d > ${UPLOADS_DIR}/shot.png`],
      { stdin: payload },
    )
  })

  it('rejects when the container write fails', async () => {
    const exec = vi.fn(async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'base64: invalid input',
    }))
    const container = { exec } as unknown as SessionContainer

    await expect(stageUpload(container, 'notes.txt', 'aGVsbG8=')).rejects.toThrow(/notes\.txt/)
  })

  it('appends a media-type extension when asked', async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    const container = { exec } as unknown as SessionContainer

    const path = await stageUpload(container, 'image-0', 'QUFB', { extension: 'png' })

    expect(path).toBe(`${UPLOADS_DIR}/image-0.png`)
  })
})
