import { describe, expect, it } from 'vitest'
import {
  createSessionRequest,
  createEnvironmentRequest,
  updateEnvironmentRequest,
  reorderEnvironmentsRequest,
  workspaceTreeResponse,
  workspaceFileResponse,
  resolvePullRequestConflictsResponse,
  pullRequestResponse,
  partitionAttachments,
} from '@/api'

describe('createSessionRequest', () => {
  it('requires a prompt for coding sessions', () => {
    expect(
      createSessionRequest.safeParse({
        projectId: '00000000-0000-4000-8000-000000000001',
        agentId: 'claude-code',
      }).success,
    ).toBe(false)
  })

  it('allows environment_setup without a prompt', () => {
    const parsed = createSessionRequest.parse({
      projectId: '00000000-0000-4000-8000-000000000001',
      agentId: 'claude-code',
      purpose: 'environment_setup',
    })
    expect(parsed.purpose).toBe('environment_setup')
  })

  it('defaults purpose to coding', () => {
    const parsed = createSessionRequest.parse({
      projectId: '00000000-0000-4000-8000-000000000001',
      agentId: 'claude-code',
      prompt: 'fix it',
    })
    expect(parsed.purpose).toBe('coding')
  })

  it('accepts a permission mode', () => {
    const parsed = createSessionRequest.parse({
      projectId: '00000000-0000-4000-8000-000000000001',
      agentId: 'claude-code',
      prompt: 'fix it',
      permissionMode: 'plan',
    })
    expect(parsed.permissionMode).toBe('plan')
  })

  it('omits permission mode when the caller did not pick one', () => {
    const parsed = createSessionRequest.parse({
      projectId: '00000000-0000-4000-8000-000000000001',
      agentId: 'claude-code',
      prompt: 'fix it',
    })
    expect(parsed.permissionMode).toBeUndefined()
  })

  it('fills git preference defaults when the object is empty', () => {
    const parsed = createSessionRequest.parse({
      projectId: '00000000-0000-4000-8000-000000000001',
      agentId: 'claude-code',
      prompt: 'fix it',
      gitPreferences: {},
    })
    expect(parsed.gitPreferences).toMatchObject({
      createAsDraft: true,
      autoOpenDraft: true,
      commitOnTurnEnd: true,
      mergeMethod: 'squash',
      deleteBranchAfterMerge: true,
      prDescription: 'auto',
    })
  })

  it('accepts a partial git preference override', () => {
    const parsed = createSessionRequest.parse({
      projectId: '00000000-0000-4000-8000-000000000001',
      agentId: 'claude-code',
      prompt: 'fix it',
      gitPreferences: { autoOpenDraft: false, mergeMethod: 'rebase' },
    })
    expect(parsed.gitPreferences?.autoOpenDraft).toBe(false)
    expect(parsed.gitPreferences?.mergeMethod).toBe('rebase')
    expect(parsed.gitPreferences?.createAsDraft).toBe(true)
  })

  it('accepts files to stage before the first prompt', () => {
    const parsed = createSessionRequest.parse({
      projectId: '00000000-0000-4000-8000-000000000001',
      agentId: 'claude-code',
      prompt: 'fix it',
      files: [{ name: 'notes.txt', data: 'data:text/plain;base64,aGVsbG8=' }],
    })
    expect(parsed.files).toEqual([{ name: 'notes.txt', data: 'data:text/plain;base64,aGVsbG8=' }])
  })

  it('rejects an attached file without a name', () => {
    const parsed = createSessionRequest.safeParse({
      projectId: '00000000-0000-4000-8000-000000000001',
      agentId: 'claude-code',
      prompt: 'fix it',
      files: [{ data: 'data:text/plain;base64,aGVsbG8=' }],
    })
    expect(parsed.success).toBe(false)
  })

  it('omits files when none were attached', () => {
    const parsed = createSessionRequest.parse({
      projectId: '00000000-0000-4000-8000-000000000001',
      agentId: 'claude-code',
      prompt: 'fix it',
    })
    expect(parsed.files).toBeUndefined()
  })
})

describe('partitionAttachments', () => {
  it('lifts png/jpeg/gif/webp data URIs onto images and leaves the rest as files', () => {
    const png = 'data:image/png;base64,QUFB'
    const notes = { name: 'notes.txt', data: 'data:text/plain;base64,aGVsbG8=' }

    expect(
      partitionAttachments(
        [notes, { name: 'shot.png', data: png }],
        ['data:image/jpeg;base64,QkJC'],
      ),
    ).toEqual({
      images: ['data:image/jpeg;base64,QkJC', png],
      files: [notes],
    })
  })

  it('returns nothing when there are no attachments', () => {
    expect(partitionAttachments()).toEqual({})
  })

  it('leaves svg and other types as files rather than inline images', () => {
    const svg = { name: 'icon.svg', data: 'data:image/svg+xml;base64,PHN2Zz4=' }
    expect(partitionAttachments([svg])).toEqual({ files: [svg] })
  })
})

describe('environment schemas', () => {
  it('accepts a valid create request', () => {
    const parsed = createEnvironmentRequest.safeParse({
      name: 'Refactors',
      branchPattern: 'refact/*',
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects an empty name', () => {
    expect(createEnvironmentRequest.safeParse({ name: '', branchPattern: '**' }).success).toBe(
      false,
    )
  })

  it('rejects a branch pattern over the length cap', () => {
    const parsed = createEnvironmentRequest.safeParse({
      name: 'Long',
      branchPattern: 'a'.repeat(201),
    })
    expect(parsed.success).toBe(false)
  })

  it('allows a partial update', () => {
    expect(updateEnvironmentRequest.safeParse({ name: 'Renamed' }).success).toBe(true)
    expect(updateEnvironmentRequest.safeParse({ branchPattern: '**' }).success).toBe(true)
  })

  it('requires at least one uuid to reorder', () => {
    expect(reorderEnvironmentsRequest.safeParse({ ids: [] }).success).toBe(false)
    expect(
      reorderEnvironmentsRequest.safeParse({ ids: ['3f1e4c1e-0b6e-4d3a-9a5f-9a1b2c3d4e5f'] })
        .success,
    ).toBe(true)
  })
})

describe('workspace file schemas', () => {
  it('accepts a list of relative paths', () => {
    const parsed = workspaceTreeResponse.parse({ paths: ['README.md', 'src/app.ts'] })
    expect(parsed.paths).toEqual(['README.md', 'src/app.ts'])
  })

  it('accepts an empty tree', () => {
    expect(workspaceTreeResponse.parse({ paths: [] }).paths).toEqual([])
  })

  it('accepts a text file payload', () => {
    const parsed = workspaceFileResponse.parse({
      path: 'src/app.ts',
      content: 'export {}',
      binary: false,
      truncated: false,
    })
    expect(parsed.content).toBe('export {}')
  })

  it('accepts a binary file with empty content', () => {
    const parsed = workspaceFileResponse.parse({
      path: 'icon.png',
      content: '',
      binary: true,
      truncated: false,
    })
    expect(parsed.binary).toBe(true)
    expect(parsed.content).toBe('')
  })
})

describe('pull request schemas', () => {
  it('accepts mergeable on a live pull request', () => {
    const parsed = pullRequestResponse.parse({
      url: 'https://github.com/diego/dukebox/pull/1',
      title: 'Add a thing',
      isDraft: false,
      state: 'open',
      mergeable: 'CONFLICTING',
    })
    expect(parsed.mergeable).toBe('CONFLICTING')
  })

  it('accepts a clean conflict resolution', () => {
    expect(resolvePullRequestConflictsResponse.parse({ status: 'resolved' })).toEqual({
      status: 'resolved',
    })
  })

  it('accepts an in-progress resolution with conflicted files', () => {
    const parsed = resolvePullRequestConflictsResponse.parse({
      status: 'resolving',
      conflictedFiles: ['src/app.ts'],
    })
    expect(parsed.conflictedFiles).toEqual(['src/app.ts'])
  })
})

describe('createSessionRequest environmentId', () => {
  it('accepts an optional environment id', () => {
    const parsed = createSessionRequest.safeParse({
      projectId: '3f1e4c1e-0b6e-4d3a-9a5f-9a1b2c3d4e5f',
      agentId: 'claude-code',
      prompt: 'do a thing',
      environmentId: '5c2d4e6a-1b3c-4d5e-8f9a-0b1c2d3e4f5a',
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts its absence', () => {
    const parsed = createSessionRequest.safeParse({
      projectId: '3f1e4c1e-0b6e-4d3a-9a5f-9a1b2c3d4e5f',
      agentId: 'claude-code',
      prompt: 'do a thing',
    })
    expect(parsed.success).toBe(true)
  })
})
