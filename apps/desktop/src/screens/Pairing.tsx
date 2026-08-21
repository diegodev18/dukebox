import { useEffect, useState } from 'react'
import { DukeHero } from '@/components/Duke'
import { PairingForm } from '@/components/PairingForm'
import { CheckIcon, CopyIcon } from '@/components/icons'
import type { Connection } from '@/lib/connection'

const PAIR_COMMAND = 'sudo -u dukebox dukebox pair new'

/**
 * First run.
 *
 * The app ships knowing about no server at all, so this is the only screen it
 * can show until a link is pasted. That is the point of the design: one
 * published binary, and the address arrives from the installer's output rather
 * than from a build.
 */

interface Props {
  onPaired: (connection: Connection) => void
}

export function Pairing({ onPaired }: Props) {
  return (
    <main className="relative h-full">
      <p className="absolute top-4 left-5 text-[15px] font-semibold tracking-tight">Dukebox</p>
      <div className="grid h-full place-items-center px-6">
        <div className="w-full max-w-md">
          <DukeHero size={140} className="mx-auto" />
          <h1 className="mt-5 text-xl font-semibold tracking-tight">Connect to your server</h1>
          <p className="mt-2 text-muted-foreground">
            Dukebox runs on a machine you own. Paste the pairing link the installer printed.
          </p>

          <div className="mt-7">
            <PairingForm onPaired={onPaired} />
          </div>

          <details className="mt-8 text-[13px] text-muted-foreground">
            <summary className="cursor-pointer">No link yet?</summary>
            <p className="mt-3">Run this on the server to print one:</p>
            <div className="group relative mt-2">
              <pre
                data-selectable
                className="overflow-x-auto rounded-[var(--radius)] bg-muted px-3 py-2.5 pr-9 font-mono text-[12px]"
              >
                {PAIR_COMMAND}
              </pre>
              <CopyButton text={PAIR_COMMAND} />
            </div>
            <p className="mt-3">Links expire after fifteen minutes and work once.</p>
          </details>
        </div>
      </div>
    </main>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      // Clipboard can be missing in a locked-down webview; selection still works.
    }
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={copied ? 'Copied' : 'Copy'}
      title={copied ? 'Copied' : 'Copy'}
      className={`absolute top-1.5 right-1.5 grid size-6 place-items-center rounded-[calc(var(--radius)*0.5)] text-muted-foreground hover:bg-background hover:text-foreground ${
        copied ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
      }`}
    >
      {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
    </button>
  )
}
