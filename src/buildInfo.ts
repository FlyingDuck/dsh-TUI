/**
 * The identity of the build this copy came from (`/version`): the compile-time
 * stamp `scripts/gen-build-info.mjs` writes to `lib/build-info.json`, plus
 * where this copy was installed from.
 *
 * The stamp is read from the module's own location, so one path serves both
 * layouts: a compiled copy (lib/types/buildInfo.js) finds lib/build-info.json,
 * while a run from source (pnpm tui / pnpm smoke: src/buildInfo.ts) and an
 * upstream package without a stamp both find nothing and report the degraded
 * line instead.
 *
 * Why the stamp lives in the gitignored `lib/` rather than a committed
 * `*.generated.ts`: it carries the commit and a build timestamp, so a
 * committed file would dirty the worktree on every build. The package name and
 * version keep tracking upstream (identity rides on the git description), so a
 * rebase conflicts on no version line at all.
 *
 * Nothing in this module throws. A missing or corrupt profile manifest reports
 * an unknown source while the other lines print; a missing stamp reports the
 * run kind instead of the build.
 * @module dsh-tui/buildInfo
 */
import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { t } from './i18n.js'
import { dshHomeDir } from './utils/credentials.js'

/** The identity recorded by the build that produced this copy. */
export interface BuildInfo {
  /** `package.json` version at build time (kept aligned with upstream). */
  readonly version: string | null
  /** `git describe --tags --dirty --always`; `-dirty` marks an unclean worktree. */
  readonly describe: string | null
  readonly branch: string | null
  /** Full commit hash; the report shortens it. */
  readonly commit: string | null
  /** ISO build timestamp. */
  readonly builtAt: string | null
  /** Node that ran the build. Recorded for diagnostics; `/version` omits it. */
  readonly node: string | null
  /**
   * Curated self-use release note, one line per entry; absent or null when the
   * build had no note file. `/version` prints it verbatim at the end.
   */
  readonly notes?: readonly string[] | null
}

/** How this package reached the profile that runs it. */
export type InstallSourceKind = 'tarball' | 'directory' | 'link' | 'registry' | 'unknown'

export interface InstallSource {
  readonly kind: InstallSourceKind
  /** The dependency spec, verbatim; null when nothing could be read. */
  readonly spec: string | null
  /** Absolute path for the local kinds (tarball / directory / link), else null. */
  readonly path: string | null
}

const PACKAGE_NAME = '@deepseek-harness-tui/dsh-tui'
/** The profile whose manifest records this package's install spec. */
const PROFILE = 'dsh-tui'
const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
/** This module's own file; its extension is what {@link runningFromSource} reads. */
const MODULE_FILE = fileURLToPath(import.meta.url)

/** A plain `0.16.1` / `^0.16.1` / `~0.16.1` spec: a registry install. */
const REGISTRY_SPEC = /^[\^~]?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u

/**
 * The build stamp for this copy, or null when there is none (a run from
 * source, an upstream package built without the generator, a corrupt stamp).
 */
export function readBuildInfo(): BuildInfo | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(resolve(MODULE_DIR, '..', 'build-info.json'), 'utf8'))
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>
  const field = (key: string): string | null => (typeof record[key] === 'string' ? record[key] : null)
  const notes = Array.isArray(record.notes)
    ? record.notes.filter((note): note is string => typeof note === 'string' && note.trim() !== '')
    : null
  return {
    version: field('version'),
    describe: field('describe'),
    branch: field('branch'),
    commit: field('commit'),
    builtAt: field('builtAt'),
    node: field('node'),
    notes,
  }
}

/**
 * Whether this module is the TypeScript source (tsx: `pnpm tui`, `pnpm smoke`)
 * rather than a compiled artifact. It is the only thing that separates the two
 * degraded wordings — neither has a stamp, and only the run kind differs.
 */
export function runningFromSource(): boolean {
  return MODULE_FILE.endsWith('.ts')
}

/**
 * The version this copy declares. The stamp is authoritative when it exists;
 * without one (a source run) the manifest beside the module still answers, so
 * the degraded line names a real version instead of a placeholder.
 */
function packageVersion(): string | null {
  let directory = MODULE_DIR
  for (let depth = 0; depth < 5; depth += 1) {
    try {
      const manifest: unknown = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'))
      const record = manifest as { name?: unknown; version?: unknown }
      if (record?.name === PACKAGE_NAME && typeof record.version === 'string') return record.version
    } catch {
      // No manifest at this level (or an unreadable one): keep walking up.
    }
    directory = resolve(directory, '..')
  }
  return null
}

/** The `link:` / `file:` target as an absolute path, relative to the profile root. */
function absolutePath(target: string, profileDir: string): string {
  return isAbsolute(target) ? normalize(target) : resolve(profileDir, target)
}

/**
 * Where this copy came from, decided by the dependency spec in the profile
 * manifest (`dependencies['@deepseek-harness-tui/dsh-tui']`).
 *
 * The spec is a fact on disk rather than a claim: `file:` is a local install
 * (a packed tarball or a directory), `link:` is a source link, and a bare
 * semver range came from the registry. Anything unreadable — no manifest, no
 * dependency key, invalid JSON — reports unknown rather than guessing.
 * @param profileDir - Profile root; defaults to `$DSH_HOME/profiles/dsh-tui`.
 */
export function detectInstallSource(profileDir: string = resolve(dshHomeDir(), 'profiles', PROFILE)): InstallSource {
  let spec: unknown
  try {
    const manifest: unknown = JSON.parse(readFileSync(resolve(profileDir, 'package.json'), 'utf8'))
    spec = (manifest as { dependencies?: Record<string, unknown> } | null)?.dependencies?.[PACKAGE_NAME]
  } catch {
    return { kind: 'unknown', spec: null, path: null }
  }
  if (typeof spec !== 'string' || spec === '') return { kind: 'unknown', spec: null, path: null }
  if (spec.startsWith('file:')) {
    const target = spec.slice('file:'.length)
    const kind: InstallSourceKind = /\.(?:tgz|tar\.gz)$/iu.test(target) ? 'tarball' : 'directory'
    return { kind, spec, path: absolutePath(target, profileDir) }
  }
  if (spec.startsWith('link:')) {
    return { kind: 'link', spec, path: absolutePath(spec.slice('link:'.length), profileDir) }
  }
  if (REGISTRY_SPEC.test(spec)) return { kind: 'registry', spec, path: null }
  return { kind: 'unknown', spec, path: null }
}

/** An ISO stamp as local wall time with its UTC offset: `2026-10-19 10:45 (+0800)`. */
function formatBuiltAt(iso: string | null): string | null {
  if (iso === null) return null
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return null
  const pad = (value: number): string => String(value).padStart(2, '0')
  const offset = -at.getTimezoneOffset()
  const sign = offset < 0 ? '-' : '+'
  const magnitude = Math.abs(offset)
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())} (${sign}${pad(Math.floor(magnitude / 60))}${pad(magnitude % 60)})`
}

/** The wording for one install source; a path only exists for the local kinds. */
function sourceText(source: InstallSource): string {
  const path = source.path ?? source.spec ?? '?'
  switch (source.kind) {
    case 'tarball': return t('version-source-tarball', { path })
    case 'directory': return t('version-source-directory', { path })
    case 'link': return t('version-source-link', { path })
    case 'registry': return t('version-source-registry')
    case 'unknown': return t('version-source-unknown')
  }
}

export interface VersionReportOptions {
  /** Build stamp to report; `null` forces the degraded path. Defaults to {@link readBuildInfo}. */
  readonly info?: BuildInfo | null
  /** Profile root for the install-source probe; defaults as in {@link detectInstallSource}. */
  readonly profileDir?: string
  /**
   * DSH kernel version the running TUI is bound to. Omitted or blank when it
   * could not be resolved — the report then skips the kernel line instead of
   * inventing one.
   */
  readonly kernelVersion?: string
}

/**
 * The `/version` report: one line without a build stamp, three with one, plus
 * optional DSH-kernel and self-use release-note blocks. The dirty flag needs no
 * line of its own — `git describe --dirty` puts it in the description
 * (`0.16.1+bean.1-dirty`), where a build from an unclean worktree cannot hide
 * behind a clean commit.
 * @param options - Stamp, profile and kernel overrides; all default to this copy.
 */
export function versionReportLines(options: VersionReportOptions = {}): readonly string[] {
  const info = options.info === undefined ? readBuildInfo() : options.info
  const version = info?.version ?? packageVersion() ?? '?'
  const kernel = options.kernelVersion?.trim()
  const kernelLines = kernel === undefined || kernel === '' ? [] : [t('version-line-kernel', { version: kernel })]
  if (info === null) {
    return [t(runningFromSource() ? 'version-degraded-dev' : 'version-degraded-package', { version }), ...kernelLines]
  }
  const identity = [
    t('version-line-build', { version, describe: info.describe ?? '?' }),
    ...kernelLines,
    t('version-line-git', {
      branch: info.branch ?? '?',
      commit: info.commit === null ? '?' : info.commit.slice(0, 8),
      builtAt: formatBuiltAt(info.builtAt) ?? '?',
    }),
    t('version-line-source', { source: sourceText(detectInstallSource(options.profileDir)) }),
  ]
  const notes = info.notes ?? []
  return notes.length === 0
    ? identity
    : [...identity, t('version-line-notes'), ...notes.map(line => `    ${line}`)]
}
