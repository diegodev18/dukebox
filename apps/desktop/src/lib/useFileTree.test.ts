import { describe, expect, it, vi } from 'vitest'
import { loadFileTree } from '@/lib/useFileTree'

describe('loadFileTree', () => {
  it('asks GitHub for a repository ref', async () => {
    const client = {
      listRepositoryTree: vi.fn().mockResolvedValue(['README.md']),
      listWorkspaceTree: vi.fn(),
    }

    await expect(
      loadFileTree(client, { kind: 'repo', repoFullName: 'acme/app', ref: 'main' }),
    ).resolves.toEqual(['README.md'])
    expect(client.listRepositoryTree).toHaveBeenCalledWith('acme/app', 'main')
    expect(client.listWorkspaceTree).not.toHaveBeenCalled()
  })

  it('prefers the session workspace tree', async () => {
    const client = {
      listRepositoryTree: vi.fn(),
      listWorkspaceTree: vi.fn().mockResolvedValue(['src/new.ts']),
    }

    await expect(
      loadFileTree(client, {
        kind: 'session',
        sessionId: 's1',
        repoFullName: 'acme/app',
        ref: 'duke/abc',
      }),
    ).resolves.toEqual(['src/new.ts'])
    expect(client.listRepositoryTree).not.toHaveBeenCalled()
  })

  it('falls back to GitHub when the workspace cannot be read', async () => {
    const client = {
      listRepositoryTree: vi.fn().mockResolvedValue(['README.md']),
      listWorkspaceTree: vi.fn().mockRejectedValue(new Error('container gone')),
    }

    await expect(
      loadFileTree(client, {
        kind: 'session',
        sessionId: 's1',
        repoFullName: 'acme/app',
        ref: 'main',
      }),
    ).resolves.toEqual(['README.md'])
    expect(client.listRepositoryTree).toHaveBeenCalledWith('acme/app', 'main')
  })
})
