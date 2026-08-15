import { useEffect, useState } from 'react'
import type { DukeboxClient } from '@/lib/client'

/**
 * Load the file paths a composer can mention.
 *
 * New Session asks GitHub (no sandbox yet). An open session prefers the
 * workspace tree — it includes files the agent created — and falls back to
 * GitHub when the container cannot resume.
 */

export type FileTreeSource =
  | { kind: 'repo'; repoFullName: string; ref: string }
  | { kind: 'session'; sessionId: string; repoFullName?: string; ref?: string }

export type FileTreeStatus = 'idle' | 'loading' | 'ready' | 'failed'

export type FileTreeState = {
  paths: string[]
  status: FileTreeStatus
  error: string | null
}

type FileTreeClient = Pick<DukeboxClient, 'listRepositoryTree' | 'listWorkspaceTree'>

export function useFileTree(
  client: FileTreeClient | null,
  source: FileTreeSource | null,
  revision = 0,
): FileTreeState {
  const [state, setState] = useState<FileTreeState>(() => ({
    paths: [],
    status: client && source ? 'loading' : 'idle',
    error: null,
  }))

  const key = sourceKey(source)

  useEffect(() => {
    if (!client || !source) {
      setState({ paths: [], status: 'idle', error: null })
      return
    }

    let cancelled = false
    setState((current) =>
      current.status === 'loading' && current.error === null
        ? current
        : { ...current, status: 'loading', error: null },
    )

    loadFileTree(client, source)
      .then((paths) => {
        if (cancelled) return
        setState({ paths, status: 'ready', error: null })
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setState({
          paths: [],
          status: 'failed',
          error: cause instanceof Error ? cause.message : 'Could not load files.',
        })
      })

    return () => {
      cancelled = true
    }
  }, [client, key, revision])

  return state
}

function sourceKey(source: FileTreeSource | null): string {
  if (!source) return ''
  if (source.kind === 'repo') return `repo:${source.repoFullName}@${source.ref}`
  return `session:${source.sessionId}:${source.repoFullName ?? ''}@${source.ref ?? ''}`
}

export async function loadFileTree(
  client: FileTreeClient,
  source: FileTreeSource,
): Promise<string[]> {
  if (source.kind === 'repo') {
    return client.listRepositoryTree(source.repoFullName, source.ref)
  }

  try {
    return await client.listWorkspaceTree(source.sessionId)
  } catch {
    if (source.repoFullName && source.ref) {
      return client.listRepositoryTree(source.repoFullName, source.ref)
    }
    throw new Error('Could not load files.')
  }
}
