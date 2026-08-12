import { describe, expect, it } from 'vitest'
import { languageFromPath } from '@/lib/syntaxHighlight'

describe('languageFromPath', () => {
  it('maps a TypeScript path to the ts grammar', () => {
    expect(languageFromPath('packages/sandbox/src/container.ts')).toBe('ts')
  })

  it('maps tsx independently of ts', () => {
    expect(languageFromPath('apps/desktop/src/App.tsx')).toBe('tsx')
  })

  it('falls back to plaintext when the extension is unknown', () => {
    expect(languageFromPath('notes.unknown')).toBe('plaintext')
  })

  it('treats a file with no extension as plaintext', () => {
    expect(languageFromPath('Makefile')).toBe('plaintext')
  })
})
