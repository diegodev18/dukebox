/**
 * Pull the activation URL and user code out of `grok login --device-auth`.
 *
 * Grok prints a human sentence, not a stable JSON line. We take the first
 * http(s) URL and the first token that looks like a device code (XXXX-XXXX
 * or labelled "code"), so a wording change does not break the wizard.
 */
export function parseDeviceAuthOutput(text: string): { url?: string; userCode?: string } {
  const urlMatch = /https?:\/\/[^\s)\]>'"]+/i.exec(text)
  const url = urlMatch?.[0]?.replace(/[.,;:]+$/, '')

  const labelled =
    /(?:enter(?:\s+the)?\s+code|user[_\s-]?code|code)\s*[:\s]+([A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})?)/i.exec(
      text,
    )
  const grouped = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(text)
  const userCode = (labelled?.[1] ?? grouped?.[1])?.toUpperCase()

  return {
    ...(url ? { url } : {}),
    ...(userCode ? { userCode } : {}),
  }
}
