/**
 * `git status --porcelain=v2 --branch` as the footer needs it: the branch, how
 * far it is from its upstream, and whether the work tree has uncommitted
 * changes — one shell query, one parse, no polling.
 *
 * The footer used to run `git branch --show-current` and refresh only when the
 * working directory changed, so a turn that edited files left the footer
 * claiming the tree was clean. Porcelain v2 is the stable machine format
 * (git's own documentation calls it "porcelain" precisely so scripts may rely
 * on it), and `--branch` folds the upstream/ahead/behind headers into the same
 * answer.
 *
 * Only checkout identity and summary counts leave this module: listing a
 * large dirty tree would cost more than it tells. The scan is
 * capped so a runaway work tree (a build directory that is not ignored) cannot
 * stall the footer; the cap is reported, never silent.
 *
 * @module dsh-tui/utils/gitStatus
 */
import { isAbsolute } from 'node:path'
import type { GitStatusSummary } from '../adapter/ports/channel-view.js'

/** How many output lines are parsed before the scan gives up and reports it. */
export const GIT_STATUS_MAX_LINES = 2000

/** Absolute checkout identity first, then the stable branch/dirty stream. */
export const GIT_STATUS_COMMAND = 'git rev-parse --path-format=absolute --git-dir --git-common-dir && git status --porcelain=v2 --branch --untracked-files=normal'

/** `# branch.ab +2 -1` */
const BRANCH_AB = /^# branch\.ab \+(\d+) -(\d+)$/u

/**
 * Parse a `--porcelain=v2 --branch` stream.
 * @param stdout - The command's stdout.
 * @returns The summary, or undefined when the stream carries no branch header
 *          (not a git work tree — the caller leaves the footer blank).
 */
export function parseGitStatus(stdout: string): GitStatusSummary | undefined {
  let head: string | undefined
  let oid: string | undefined
  let upstream: string | undefined
  let ahead = 0
  let behind = 0
  let changed = 0
  let untracked = 0
  let truncated = false
  let scanned = 0
  const lines = stdout.split('\n')
  // Plain porcelain remains valid for callers without checkout metadata. Both
  // rev-parse paths must be absolute: a relative common-dir from a nested cwd
  // would otherwise misclassify an ordinary checkout as a linked worktree.
  const gitDir = lines[0] !== undefined && isAbsolute(lines[0]) ? lines[0] : undefined
  const commonDir = lines[1] !== undefined && isAbsolute(lines[1]) ? lines[1] : undefined
  const hasIdentity = gitDir !== undefined && commonDir !== undefined
  for (const line of hasIdentity ? lines.slice(2) : lines) {
    if (line === '') continue
    scanned += 1
    if (scanned > GIT_STATUS_MAX_LINES) {
      truncated = true
      break
    }
    if (line.startsWith('# ')) {
      if (line.startsWith('# branch.head ')) head = line.slice('# branch.head '.length)
      else if (line.startsWith('# branch.oid ')) oid = line.slice('# branch.oid '.length)
      else if (line.startsWith('# branch.upstream ')) upstream = line.slice('# branch.upstream '.length)
      else {
        const ab = BRANCH_AB.exec(line)
        if (ab !== null) {
          ahead = Number(ab[1])
          behind = Number(ab[2])
        }
      }
      continue
    }
    // Unmerged (`u`) and renamed (`2`) entries are changes like any other.
    if (line.startsWith('1 ') || line.startsWith('2 ') || line.startsWith('u ')) changed += 1
    else if (line.startsWith('? ')) untracked += 1
  }
  if (head === undefined) return undefined
  const detached = head === '(detached)'
  // An unborn branch reports `(initial)` and an unreadable oid all zeros: there
  // is nothing to print for either.
  const unborn = head === '(initial)' || oid === undefined || /^0+$/u.test(oid)
  const branch = detached ? shortOid(oid) : unborn ? '' : head
  return {
    branch,
    ...(hasIdentity ? { gitDir, isLinkedWorktree: gitDir !== commonDir } : {}),
    ahead,
    behind,
    changed,
    untracked,
    ...(upstream === undefined ? {} : { upstream }),
    detached,
    truncated,
  }
}

/** `00831178` — the short form a detached footer shows. */
function shortOid(oid: string | undefined): string {
  return oid === undefined || /^0+$/u.test(oid) ? '' : oid.slice(0, 8)
}

/**
 * The one-line suffix the footer draws after `git <branch>`: the empties are
 * dropped, so a clean checkout shows nothing at all rather than `↑0 ↓0`.
 * @param status - The summary to render.
 */
export function gitStatusSuffix(status: GitStatusSummary): { ahead?: string; behind?: string; dirty?: string } {
  const dirty = status.changed + status.untracked
  return {
    ...(status.ahead > 0 ? { ahead: `↑${status.ahead}` } : {}),
    ...(status.behind > 0 ? { behind: `↓${status.behind}` } : {}),
    ...(dirty > 0 ? { dirty: `●${dirty}${status.truncated ? '+' : ''}` } : {}),
  }
}
