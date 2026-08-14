import type { SessionContainer } from '@dukebox/sandbox'

/**
 * Staging of user uploads into a session container.
 *
 * Agents take filesystem paths rather than inline content, so attached files
 * (and images, which adapters without base64 image support turn into files)
 * are written into `/tmp/imgs/` inside the sandbox before a prompt runs. The
 * directory is fixed so a follow-up prompt can overwrite a same-named file
 * rather than accumulating stale uploads.
 */

export const UPLOADS_DIR = '/tmp/imgs'

/**
 * Reduce a client-supplied filename to something that cannot escape the
 * uploads directory. A name like `../../etc/passwd` must stay a filename.
 */
export function sanitizeUploadName(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? 'file'
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '')
  return cleaned || 'file'
}

/** Decode a base64 data URI. Returns undefined when `data` is not one. */
export function parseDataUri(data: string): { mime: string; payload: string } | undefined {
  const match = /^data:([^;]+);base64,(.+)$/.exec(data)
  if (!match?.[1] || !match[2]) return undefined
  return { mime: match[1], payload: match[2] }
}

/**
 * Write one uploaded file into the sandbox at `/tmp/imgs/<name>`.
 *
 * Returns the container path, for the agent-facing flags (`--file`, prompt
 * references) to point at. The payload travels on exec stdin rather than as
 * an environment variable: Linux caps a single env string at ~128 KiB
 * (`MAX_ARG_STRLEN`), which a real screenshot exceeds, and that used to fail
 * the session during staging.
 *
 * `options.extension` appends a media-type-derived suffix, so an unnamed image
 * can keep its file type (`/tmp/imgs/image-0.png`) for agents that sniff.
 */
export async function stageUpload(
  container: SessionContainer,
  name: string,
  data: string,
  options: { extension?: string } = {},
): Promise<string> {
  const base = sanitizeUploadName(name)
  const path = `${UPLOADS_DIR}/${base}${options.extension ? `.${options.extension}` : ''}`
  const result = await container.exec(
    ['sh', '-c', `mkdir -p ${UPLOADS_DIR} && base64 -d > ${path}`],
    { stdin: data },
  )
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || `exit ${result.exitCode}`
    throw new Error(`failed to stage ${base}: ${detail}`)
  }
  return path
}

/** Map a media type like `image/png` to a file extension, when one is known. */
const MEDIA_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
}

export function extensionFor(mime: string | undefined): string | undefined {
  if (!mime) return undefined
  return MEDIA_EXTENSIONS[mime.toLowerCase()]
}
