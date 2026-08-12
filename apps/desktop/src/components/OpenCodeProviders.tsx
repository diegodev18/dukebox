import {
  OPENCODE_CATALOG,
  type OpencodeProvider,
  type OpencodeProviderKind,
  type UpsertOpencodeProviderRequest,
} from '@dukebox/protocol'
import { useEffect, useState } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { DukeboxClient } from '@/lib/client'

/**
 * OpenCode's providers: API keys for Anthropic, OpenAI, and the rest, plus
 * custom OpenAI-compatible endpoints.
 *
 * Used from Settings. The key is written and never read back.
 */

export function modelsForProvider(provider: OpencodeProvider): { id: string; label: string }[] {
  return provider.models.map((model) => ({
    id: `${provider.id}/${model.id}`,
    label: model.label,
  }))
}

export function opencodeModelOptions(
  providers: OpencodeProvider[],
): { id: string; label: string }[] {
  return providers.flatMap(modelsForProvider)
}

export function OpenCodeProviders({ client }: { client: DukeboxClient }) {
  const [providers, setProviders] = useState<OpencodeProvider[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [working, setWorking] = useState(false)
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const reload = async () => {
    const found = await client.listOpencodeProviders()
    setProviders(found)
    return found
  }

  useEffect(() => {
    let cancelled = false
    client
      .listOpencodeProviders()
      .then((found) => {
        if (cancelled) return
        setProviders(found)
      })
      .catch(() => {
        if (!cancelled) setProviders([])
      })
    return () => {
      cancelled = true
    }
  }, [client])

  const remove = async (id: string) => {
    setWorking(true)
    setMessage(null)
    try {
      await client.deleteOpencodeProvider(id)
      await reload()
      setMessage({ tone: 'ok', text: 'Provider removed.' })
    } catch (error) {
      setMessage({
        tone: 'error',
        text: error instanceof Error ? error.message : 'Could not remove the provider.',
      })
    } finally {
      setWorking(false)
    }
  }

  const save = async (request: UpsertOpencodeProviderRequest) => {
    setWorking(true)
    setMessage(null)
    try {
      await client.upsertOpencodeProvider(request)
      await reload()
      setAdding(false)
      setMessage({ tone: 'ok', text: 'Provider saved.' })
    } catch (error) {
      setMessage({
        tone: 'error',
        text: error instanceof Error ? error.message : 'Could not save the provider.',
      })
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className="mt-5 border-t border-border pt-4">
      <h3 className="text-[12px] font-semibold tracking-wide text-muted-foreground uppercase">
        OpenCode providers
      </h3>
      <p className="mt-1 text-[12.5px] text-muted-foreground">
        API keys OpenCode uses to reach each model provider. Stored on the server.
      </p>

      {providers === null ? (
        <p className="mt-3 text-[12.5px] text-muted-foreground">Loading providers…</p>
      ) : providers.length === 0 && !adding ? (
        <p className="mt-3 text-[12.5px] text-muted-foreground">No providers configured yet.</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {providers.map((provider) => (
            <li
              key={provider.id}
              className="flex items-center gap-2 rounded-[calc(var(--radius)*0.8)] border border-border bg-surface px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{provider.name}</div>
                <div className="truncate text-[11.5px] text-muted-foreground">
                  {provider.models.map((model) => model.label).join(', ') || provider.id}
                </div>
              </div>
              <button
                type="button"
                disabled={working}
                onClick={() => void remove(provider.id)}
                className="flex-none rounded-[calc(var(--radius)*0.6)] px-2 py-1 text-[12px] text-muted-foreground hover:bg-muted hover:text-destructive disabled:opacity-40"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <ProviderForm
          existingIds={new Set((providers ?? []).map((provider) => provider.id))}
          working={working}
          onSave={(request) => void save(request)}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="mt-3 rounded-[calc(var(--radius)*0.6)] border border-border px-3.5 py-1.5 text-[12.5px] font-medium hover:bg-muted"
        >
          Add provider…
        </button>
      )}

      {message && (
        <p
          className={`mt-2 text-[12px] ${message.tone === 'ok' ? 'text-muted-foreground' : 'text-destructive'}`}
        >
          {message.text}
        </p>
      )}
    </div>
  )
}

function ProviderForm({
  existingIds,
  working,
  onSave,
  onCancel,
}: {
  existingIds: Set<string>
  working: boolean
  onSave: (request: UpsertOpencodeProviderRequest) => void
  onCancel: () => void
}) {
  const [kind, setKind] = useState<OpencodeProviderKind>('anthropic')
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [modelsText, setModelsText] = useState('')

  const custom = kind === 'openai-compatible'
  const catalog = OPENCODE_CATALOG.find((entry) => entry.kind === kind)
  const taken = !custom && existingIds.has(kind)

  const submit = () => {
    if (apiKey.trim() === '') return

    if (custom) {
      const models = parseModels(modelsText)
      if (id.trim() === '' || baseUrl.trim() === '' || models.length === 0) return
      onSave({
        kind,
        id: id.trim(),
        name: name.trim() || id.trim(),
        apiKey: apiKey.trim(),
        baseUrl: baseUrl.trim(),
        models,
      })
      return
    }

    onSave({ kind, apiKey: apiKey.trim() })
  }

  const canSave = custom
    ? apiKey.trim() !== '' &&
      id.trim() !== '' &&
      baseUrl.trim() !== '' &&
      parseModels(modelsText).length > 0
    : apiKey.trim() !== ''

  return (
    <div className="mt-3 rounded-[calc(var(--radius)*0.8)] border border-border bg-surface px-3.5 py-3">
      <div className="block text-[12px] text-muted-foreground">
        <span id="opencode-provider-kind-label">Provider</span>
        <Select value={kind} onValueChange={(value) => setKind(value as OpencodeProviderKind)}>
          <SelectTrigger className="mt-1" aria-labelledby="opencode-provider-kind-label">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {OPENCODE_CATALOG.map((entry) => (
              <SelectItem key={entry.kind} value={entry.kind}>
                {entry.name}
              </SelectItem>
            ))}
            <SelectItem value="openai-compatible">Custom (OpenAI-compatible)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {taken && (
        <p className="mt-2 text-[12px] text-muted-foreground">
          {catalog?.name} is already configured. Saving replaces its key.
        </p>
      )}

      {custom && (
        <>
          <label className="mt-2.5 block text-[12px] text-muted-foreground">
            Id
            <input
              value={id}
              onChange={(event) => setId(event.target.value)}
              placeholder="my-proxy"
              spellCheck={false}
              className="mt-1 w-full rounded-[calc(var(--radius)*0.6)] border border-border-strong bg-background px-2.5 py-1.5 font-mono text-[13px] outline-none"
            />
          </label>
          <label className="mt-2.5 block text-[12px] text-muted-foreground">
            Name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="My proxy"
              className="mt-1 w-full rounded-[calc(var(--radius)*0.6)] border border-border-strong bg-background px-2.5 py-1.5 text-[13px] outline-none"
            />
          </label>
          <label className="mt-2.5 block text-[12px] text-muted-foreground">
            Base URL
            <input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://api.example.com/v1"
              spellCheck={false}
              className="mt-1 w-full rounded-[calc(var(--radius)*0.6)] border border-border-strong bg-background px-2.5 py-1.5 font-mono text-[13px] outline-none"
            />
          </label>
          <label className="mt-2.5 block text-[12px] text-muted-foreground">
            Models
            <textarea
              value={modelsText}
              onChange={(event) => setModelsText(event.target.value)}
              placeholder={'gpt-4\nllama-3'}
              rows={3}
              className="mt-1 w-full rounded-[calc(var(--radius)*0.6)] border border-border-strong bg-background px-2.5 py-1.5 font-mono text-[13px] outline-none"
            />
          </label>
          <p className="mt-1 text-[11px] text-muted-foreground">One model id per line.</p>
        </>
      )}

      <label className="mt-2.5 block text-[12px] text-muted-foreground">
        API key
        <input
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder="Paste key…"
          spellCheck={false}
          autoComplete="off"
          className="mt-1 w-full rounded-[calc(var(--radius)*0.6)] border border-border-strong bg-background px-2.5 py-1.5 font-mono text-[13px] outline-none"
        />
      </label>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          disabled={working || !canSave}
          onClick={submit}
          className="rounded-[calc(var(--radius)*0.6)] bg-foreground px-3.5 py-1.5 text-[12.5px] font-medium text-background disabled:opacity-40"
        >
          Save provider
        </button>
        <button
          type="button"
          disabled={working}
          onClick={onCancel}
          className="rounded-[calc(var(--radius)*0.6)] px-2 py-1.5 text-[12.5px] text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

function parseModels(text: string): { id: string; label: string }[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, ...rest] = line.split(/\s*\|\s*/)
      const trimmed = id?.trim() ?? ''
      return { id: trimmed, label: rest.join(' | ').trim() || trimmed }
    })
    .filter((model) => model.id !== '')
}
