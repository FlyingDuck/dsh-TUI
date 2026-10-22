/**
 * Data-directory paths for the dsh-tui profile. All preferences and history
 * live under `~/.dsh-tui`.
 *
 * The compiled copy (lib/types/utils/paths.js) is also imported by the bin
 * launcher, mirroring the shellQuote precedent.
 */

import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/**
 * The user's home directory. `os.homedir()` first; the USERPROFILE/HOME
 * spellings are the last-resort fallback for stripped-down environments.
 * @returns Absolute home path.
 */
export function homeDir(): string {
  return homedir() || process.env.USERPROFILE || process.env.HOME || ''
}

/**
 * Resolve one user-typed path against the host: a leading `~` / `~/` expands
 * against {@link homeDir} INCLUDING subdirectories, absolute paths pass
 * through, and everything else joins `cwd`. Backslashes are normalized only
 * for the `~` test, so Windows spellings (`~\Downloads\a.txt`) expand too
 * while the joined tail uses the platform separator.
 *
 * Completion and submitted `@` mentions share this: `~/Downloads/` selected
 * from the menu then narrowed by typing must resolve the same way the sent
 * mention does, or the overlay and the attachment disagree.
 */
export function resolveHomePath(path: string, cwd: string): string {
  const normalized = path.replaceAll('\\', '/')
  if (normalized === '~' || normalized.startsWith('~/')) {
    const rest = normalized.slice(2)
    return rest === '' ? homeDir() : join(homeDir(), rest)
  }
  return isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path) ? path : join(cwd, path)
}

/** Data directory all preferences/history live in (`~/.dsh-tui`). */
export const DATA_DIR = join(homeDir(), '.dsh-tui')

/**
 * Where one backend keeps its own files: `<dataRoot>/backends/<id>`, keyed by
 * the backend's declared id (the `x-dsh-tui` Backend entry's `spec.id` field).
 * The single construction point, so a check for what a removal
 * left behind reads the same path the backend wrote to (C-5).
 *
 * `dataRoot` defaults to this profile's own `~/.dsh-tui`. It is a parameter so
 * that a regression can point the whole check at a temporary tree, exactly like
 * the diagnostics' own `dataDir` override.
 */
export function backendDataDir(backendId: string, dataRoot: string = DATA_DIR): string {
  return join(dataRoot, 'backends', backendId)
}
