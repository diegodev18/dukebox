/**
 * Who Dukebox commits as.
 *
 * One value shared by the server, which configures git inside the sandbox, and
 * the desktop, which shows the same name and address in the sidebar. Keeping it
 * here stops the two from drifting into disagreeing about who authored a commit.
 *
 * Static for now. The settings panel will make it per-account, at which point
 * this becomes the fallback rather than the only answer.
 */

export interface CommitIdentity {
  name: string
  email: string
}

export const DEFAULT_COMMIT_IDENTITY: CommitIdentity = {
  name: 'Dukebox',
  email: 'dukebox@withdiego.dev',
}
