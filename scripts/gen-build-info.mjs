#!/usr/bin/env node
/**
 * Build lib/build-info.json: the identity and provenance of THIS build, the
 * single source the TUI's `/version` command reads (src/buildInfo.ts). Not
 * committed — it carries the commit and a timestamp, so a checked-in file
 * would dirty the worktree on every build (unlike
 * src/dsh-adapter/backends.generated.ts, whose content is deterministic).
 * `lib/` is gitignored and ships in the npm tarball. Run after tsc (part of
 * `pnpm compile`).
 *
 * Best-effort by design: outside a git checkout (an unpacked tarball, a source
 * drop) or with any git command failing, the affected fields are null and the
 * build still succeeds — a build must never fail for want of an identity.
 * `builtAt` and `node` always exist.
 *
 * `describe` carries `--dirty` so a build from an unclean worktree says so in
 * the description itself (`0.16.1+bean.1-dirty`) instead of pretending to be a
 * clean commit; that is the one thing this command exists to catch.
 *
 * `notes` carries the curated self-use release note from
 * `.github/release-notes/self-use.md`, line by line, so the installed copy's
 * `/version` can print a release-note block without shipping `.github/`.
 *
 * Usage: node scripts/gen-build-info.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const NOTES_FILE = new URL('../.github/release-notes/self-use.md', import.meta.url)
/** `/version` stays scannable; the note file is meant to be a short list. */
const NOTE_LIMIT = 8

/** One git answer, or null when git is unavailable or has none. */
function git(...args) {
  try {
    const answer = execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return answer === '' ? null : answer
  } catch {
    return null
  }
}

/**
 * The curated self-use note, verbatim (comments and blank lines dropped), or
 * null when the file is absent (an unpacked tarball/source drop). Best-effort
 * for the same reason as the other fields: a build must never fail for want of
 * a note.
 */
function readSelfUseNotes() {
  try {
    const lines = readFileSync(NOTES_FILE, 'utf8')
      .split(/\r?\n/u)
      .map(line => line.trim())
      .filter(line => line !== '' && !line.startsWith('#'))
    return lines.length === 0 ? null : lines.slice(0, NOTE_LIMIT)
  } catch {
    return null
  }
}

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const info = {
  // package.json's version, not the git description: identity rides on
  // `describe`, so the version stays aligned with upstream and a rebase keeps
  // conflicting on zero version lines. See src/buildInfo.ts.
  version: typeof pkg.version === 'string' ? pkg.version : null,
  describe: git('describe', '--tags', '--dirty', '--always'),
  branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
  commit: git('rev-parse', 'HEAD'),
  builtAt: new Date().toISOString(),
  node: process.version,
  notes: readSelfUseNotes(),
}

const output = new URL('../lib/build-info.json', import.meta.url)
mkdirSync(dirname(fileURLToPath(output)), { recursive: true })
writeFileSync(output, `${JSON.stringify(info, null, 2)}\n`)
console.log(`build-info: ${info.describe ?? '(not a git checkout)'} -> lib/build-info.json`)
