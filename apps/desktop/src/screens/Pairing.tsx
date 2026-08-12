import { PairingForm } from '@/components/PairingForm'
import type { Connection } from '@/lib/connection'

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
    <main className="grid h-full place-items-center px-6">
      <div className="w-full max-w-md">
        <h1 className="text-xl font-semibold tracking-tight">Connect to your server</h1>
        <p className="mt-2 text-muted-foreground">
          Dukebox runs on a machine you own. Paste the pairing link the installer printed.
        </p>

        <div className="mt-7">
          <PairingForm onPaired={onPaired} />
        </div>

        <details className="mt-8 text-[13px] text-muted-foreground">
          <summary className="cursor-pointer">No link yet?</summary>
          <p className="mt-3">Run this on the server to print one:</p>
          <pre
            data-selectable
            className="mt-2 overflow-x-auto rounded-[var(--radius)] bg-muted px-3 py-2.5 font-mono text-[12px]"
          >
            sudo -u dukebox dukebox pair new
          </pre>
          <p className="mt-3">Links expire after fifteen minutes and work once.</p>
        </details>
      </div>
    </main>
  )
}
