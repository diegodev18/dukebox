import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'

/**
 * Self-updates, in the fewest moving parts the native plugins allow.
 *
 * The two functions here are the whole API the UI needs: ask the release feed
 * whether a newer build exists, and download/install/restart into one. The
 * feed is the GitHub release this app was published from, signed by a key
 * whose public half is compiled into the app (see `plugins.updater` in
 * tauri.conf.json), so a compromised feed cannot substitute a fake binary.
 *
 * Both are safe to call outside the native app — the browser preview and the
 * vitest run have no Tauri host to answer, and there is nothing to act on
 * there anyway. That distinction is the point of `checkForUpdate` returning
 * null rather than throwing.
 */

export type { Update } from '@tauri-apps/plugin-updater'

/** How far a download has got. */
export interface DownloadProgress {
  /** Bytes received so far. */
  received: number
  /** Total size, once the server has said — null before the first chunk. */
  total: number | null
}

/**
 * Ask the update feed whether a newer version exists.
 *
 * Returns null for "you are current" and also for "cannot know": outside the
 * native app there is no updater, and a machine with no network or a repo
 * with no releases yet answers the same way. All three are non-events for the
 * user, so the caller gets one value instead of a match on failure modes it
 * could not act on anyway.
 */
export async function checkForUpdate(): Promise<Update | null> {
  try {
    return await check()
  } catch {
    return null
  }
}

/**
 * Download, install, and relaunch into the given update.
 *
 * Resolves after the install completes. Relaunching happens inside this call;
 * on Windows the installer closes the app itself, in which case the relaunch
 * never runs. Rejects with the underlying reason when the download or install
 * fails, so the caller can say what went wrong instead of guessing.
 */
export async function installUpdate(
  update: Update,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<void> {
  let received = 0
  let total: number | null = null

  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case 'Started':
        total = event.data.contentLength ?? null
        onProgress?.({ received: 0, total })
        break
      case 'Progress':
        // The updater reports each chunk's size, not a running total — a
        // progress bar wants a running total, so the accumulation happens
        // here rather than in every caller.
        received += event.data.chunkLength
        onProgress?.({ received, total })
        break
      case 'Finished':
        onProgress?.({ received, total })
        break
    }
  })

  await relaunch()
}
