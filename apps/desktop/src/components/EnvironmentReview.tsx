import {
  ENVIRONMENT_SETUP_IMAGE_MISMATCH,
  type EnvironmentProposal,
  type EnvironmentSetupVerification,
} from '@dukebox/protocol'
import { useEffect, useState } from 'react'
import type { DukeboxClient } from '@/lib/client'

/**
 * Review form for an environment_setup session's proposal.
 *
 * Lives in the workspace Environment tab so the transcript stays open for
 * follow-up context while the user edits setup commands and secrets.
 */

interface Props {
  client: DukeboxClient
  projectId: string
  sessionId: string
  /**
   * Which environment this proposal belongs to.
   *
   * Null means the session resolved to no environment. For an
   * environment_setup session that should never happen — the row is created
   * before the session starts — so it is reported as a broken state rather
   * than guessed at, because writing to the wrong environment would silently
   * overwrite another branch family's setup.
   */
  environmentId: string | null
  /** Shown in the header so it is clear which environment is being confirmed. */
  environmentName: string | null
  onSaved: () => void
  disabled?: boolean
}

type Status =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'saving' }
  | { kind: 'failed'; message: string }
  | { kind: 'saved' }

export function EnvironmentReview({
  client,
  projectId,
  sessionId,
  environmentId,
  environmentName,
  onSaved,
  disabled = false,
}: Props) {
  const [setupText, setSetupText] = useState('')
  const [proposedSetup, setProposedSetup] = useState('')
  const [verification, setVerification] = useState<EnvironmentSetupVerification | undefined>()
  const [instructions, setInstructions] = useState('')
  const [envRows, setEnvRows] = useState<EnvRow[]>([])
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  // Stays false until a fetch succeeds so a failed first load cannot offer
  // Save on empty setup/secrets.
  const [loaded, setLoaded] = useState(false)
  const [loadNonce, setLoadNonce] = useState(0)

  useEffect(() => {
    let cancelled = false

    if (!environmentId) {
      setStatus({
        kind: 'failed',
        message:
          'This session is not attached to an environment, so there is nothing to save a proposal to.',
      })
      return
    }

    const load = async () => {
      try {
        const [proposal, environment] = await Promise.all([
          client.getEnvironmentProposal(sessionId),
          client.getEnvironment(projectId, environmentId),
        ])

        if (cancelled) return

        const source: EnvironmentProposal = proposal ??
          environment.draft ?? {
            setup: [],
            env: {},
          }

        setSetupText(source.setup.join('\n'))
        setProposedSetup(source.setup.join('\n'))
        setVerification(source.verification)
        setInstructions(source.instructions ?? '')
        setEnvRows(
          Object.entries(source.env).map(([name, meta]) => ({
            name,
            secret: meta.secret,
            description: meta.description ?? '',
            value: '',
            configured: environment.secretNames.includes(name),
          })),
        )
        setLoaded(true)
        setStatus({ kind: 'ready' })
      } catch (error) {
        if (cancelled) return
        setStatus({
          kind: 'failed',
          message:
            error instanceof Error ? error.message : 'Could not load the environment proposal.',
        })
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [client, projectId, sessionId, environmentId, loadNonce])

  // Saved is a moment, not a lock: after a beat, or as soon as they edit,
  // the button is a save again.
  useEffect(() => {
    if (status.kind !== 'saved') return
    const timer = setTimeout(() => setStatus({ kind: 'ready' }), 2500)
    return () => clearTimeout(timer)
  }, [status.kind])

  const markDirty = () => {
    setStatus((current) => (current.kind === 'saved' ? { kind: 'ready' } : current))
  }

  const save = async () => {
    // Guarded again rather than trusted from the effect: without an id there
    // is no route to write to, and the button is unreachable in that state.
    if (!environmentId) return

    setStatus({ kind: 'saving' })

    try {
      const setup = setupText
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)

      const secretEnv: string[] = []
      const literalEnv: Record<string, string> = {}
      const secrets: Record<string, string> = {}

      for (const row of envRows) {
        const name = row.name.trim()
        if (!name) continue

        if (row.secret) {
          secretEnv.push(name)
          if (row.value.trim()) secrets[name] = row.value
        } else if (row.value.trim()) {
          literalEnv[name] = row.value
        }
      }

      await client.putEnvironment(projectId, environmentId, {
        setup,
        secretEnv,
        literalEnv,
        secrets,
        ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
      })

      setStatus({ kind: 'saved' })
      onSaved()
    } catch (error) {
      setStatus({
        kind: 'failed',
        message: error instanceof Error ? error.message : 'Could not save the environment.',
      })
    }
  }

  if (status.kind === 'loading') {
    return (
      <div className="px-3.5 py-4 text-[12.5px] text-muted-foreground">
        Loading environment proposal…
      </div>
    )
  }

  // No environment means no route to save to. Showing the form anyway would
  // offer a Save button that cannot work.
  if (!environmentId) {
    return (
      <p role="alert" className="px-3.5 py-4 text-[12.5px] text-destructive">
        {status.kind === 'failed' ? status.message : 'This session has no environment to review.'}
      </p>
    )
  }

  // An empty form with Save would PUT empty setup and secrets over whatever
  // is already stored. After a successful load, a later save failure keeps
  // the form (existing catch below).
  if (status.kind === 'failed' && !loaded) {
    return (
      <div className="px-3.5 py-4">
        <p role="alert" className="text-[12.5px] text-destructive">
          {status.message}
        </p>
        <button
          type="button"
          onClick={() => {
            setStatus({ kind: 'loading' })
            setLoadNonce((n) => n + 1)
          }}
          className="mt-2.5 rounded-md bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background"
        >
          Retry
        </button>
      </div>
    )
  }

  return (
    <div
      className={`min-h-0 flex-1 overflow-y-auto px-3.5 py-3 ${disabled ? 'pointer-events-none opacity-60' : ''}`}
      {...(disabled ? { 'aria-disabled': true } : {})}
    >
      <div className="mb-3 flex flex-col gap-2">
        <div>
          {/* Which environment, not just that there is one: with several per
              project, "Review environment" alone does not say what is about to
              be overwritten. */}
          <h2 className="flex flex-wrap items-baseline gap-x-1.5 text-[13px] font-medium">
            Review environment
            {environmentName && (
              <span className="font-normal text-muted-foreground">· {environmentName}</span>
            )}
          </h2>
          <p className="text-[12px] text-muted-foreground">
            Edit setup commands and fill in env values, then save. Secrets stay on the server.
          </p>
        </div>
        <VerificationBanner verification={verification} setupEdited={setupText !== proposedSetup} />
        <button
          type="button"
          onClick={() => void save()}
          disabled={status.kind === 'saving' || status.kind === 'saved'}
          className="self-start rounded-md bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background disabled:opacity-40"
        >
          {status.kind === 'saving'
            ? 'Saving…'
            : status.kind === 'saved'
              ? 'Saved'
              : 'Save environment'}
        </button>
      </div>

      <label className="mb-3 block text-[12px] font-medium">
        Setup commands
        <textarea
          value={setupText}
          onChange={(event) => {
            markDirty()
            setSetupText(event.target.value)
          }}
          rows={4}
          disabled={status.kind === 'saving'}
          className="mt-1 block w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 font-mono text-[12px] outline-none"
          placeholder={'pnpm install\npnpm exec turbo run build'}
        />
      </label>

      <div className="mb-3">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[12px] font-medium">Environment variables</span>
          <button
            type="button"
            className="text-[12px] text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => {
              markDirty()
              setEnvRows((rows) => [
                ...rows,
                { name: '', secret: true, description: '', value: '', configured: false },
              ])
            }}
          >
            Add variable
          </button>
        </div>

        {envRows.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">No variables proposed.</p>
        ) : (
          <ul className="space-y-2">
            {envRows.map((row, index) => (
              <li
                key={`${row.name}-${index}`}
                className="grid gap-1.5 rounded-md border border-border p-2"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    value={row.name}
                    onChange={(event) => {
                      markDirty()
                      setEnvRows((rows) =>
                        rows.map((candidate, i) =>
                          i === index ? { ...candidate, name: event.target.value } : candidate,
                        ),
                      )
                    }}
                    placeholder="NAME"
                    className="min-w-[10rem] flex-1 rounded border border-border bg-background px-2 py-1 font-mono text-[12px]"
                  />
                  <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={row.secret}
                      onChange={(event) => {
                        markDirty()
                        setEnvRows((rows) =>
                          rows.map((candidate, i) =>
                            i === index
                              ? { ...candidate, secret: event.target.checked }
                              : candidate,
                          ),
                        )
                      }}
                    />
                    Secret
                  </label>
                </div>
                {row.description ? (
                  <p className="text-[11.5px] text-muted-foreground">{row.description}</p>
                ) : null}
                <input
                  type={row.secret ? 'password' : 'text'}
                  value={row.value}
                  onChange={(event) => {
                    markDirty()
                    setEnvRows((rows) =>
                      rows.map((candidate, i) =>
                        i === index ? { ...candidate, value: event.target.value } : candidate,
                      ),
                    )
                  }}
                  placeholder={
                    row.secret && row.configured
                      ? 'Already set — leave blank to keep'
                      : row.secret
                        ? 'Secret value'
                        : 'Value'
                  }
                  className="w-full rounded border border-border bg-background px-2 py-1 font-mono text-[12px]"
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <label className="mb-2 block text-[12px] font-medium">
        Agent instructions
        <textarea
          value={instructions}
          onChange={(event) => {
            markDirty()
            setInstructions(event.target.value)
          }}
          rows={2}
          disabled={status.kind === 'saving'}
          className="mt-1 block w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 text-[12px] outline-none"
          placeholder="Optional guidance for later coding sessions"
        />
      </label>

      {status.kind === 'failed' && (
        <p role="alert" className="text-[12.5px] text-destructive">
          {status.message}
        </p>
      )}
    </div>
  )
}

interface EnvRow {
  name: string
  secret: boolean
  description: string
  value: string
  configured: boolean
}

function VerificationBanner({
  verification,
  setupEdited,
}: {
  verification: EnvironmentSetupVerification | undefined
  setupEdited: boolean
}) {
  const banner = verificationMessage(verification, setupEdited)
  if (!banner) return null

  return (
    <p
      role="status"
      className={`rounded-md border px-2.5 py-2 text-[12px] ${
        banner.tone === 'error'
          ? 'border-destructive/40 text-destructive'
          : 'border-border text-muted-foreground'
      }`}
    >
      {banner.message}
    </p>
  )
}

function verificationMessage(
  verification: EnvironmentSetupVerification | undefined,
  setupEdited: boolean,
): { tone: 'ok' | 'error'; message: string } | null {
  if (setupEdited) {
    return { tone: 'ok', message: 'Setup commands were edited and are no longer verified.' }
  }
  if (!verification) return null
  if (verification.ok) {
    return { tone: 'ok', message: 'Setup commands ran successfully in a clean clone.' }
  }
  if (verification.skippedReason === ENVIRONMENT_SETUP_IMAGE_MISMATCH) {
    return {
      tone: 'ok',
      message: 'Setup could not be verified because the proposal uses a different container image.',
    }
  }
  return {
    tone: 'error',
    message: verification.error
      ? `Setup verification failed: ${verification.error}`
      : 'Setup verification failed.',
  }
}
