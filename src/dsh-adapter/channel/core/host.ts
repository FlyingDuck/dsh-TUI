/**
 * Host seams every channel composition reads: the optional Cordis service
 * rows (themes, workspaces, command trees, scenes, settings sections,
 * custom-entry renderers), the default-deny decision gate with its
 * dispatch-topology marker, the runtime subscriptions that re-render on host
 * changes, and the git-branch breadcrumb. Each lookup degrades when its row
 * is not mounted, whatever backend serves the session.
 */
import { readlink, realpath, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { AdapterRuntimeOptions } from '../../../adapter/kernel/runtime.js'
import { readGrantStore } from '../../../adapter/standard/grants.js'
import { readBoundedRegularFile } from '../../../utils/pastedImagePath.js'
import { getHostCommandTrees, type TuiCommandTreeRuntime } from '../../command-trees.js'
import { runForegroundShell, type ForegroundShell } from '../../compat/shell.js'
import { getHostGrantStore } from '../../host-grants.js'
import { getHostRenderers, type TuiRendererRuntime } from '../../renderers.js'
import { getHostSceneRuntime, type TuiSceneRuntime } from '../../scenes.js'
import { getHostSettingsSections, type TuiSettingsSectionsRuntime } from '../../settings-sections.js'
import { GIT_STATUS_COMMAND, parseGitStatus } from '../../../utils/gitStatus.js'
import { getHostThemes, type TuiThemeRuntime } from '../../themes.js'
import { createLocalWorkspaceRuntime, getHostWorkspaceRuntime, type TuiWorkspaceRuntime } from '../../workspaces.js'
import type { ChannelHost, ServiceLookup } from '../channel-host.js'
import type { ChannelOwner } from '../owner.js'
import type { ChannelState } from '../types.js'

/**
 * The host services a channel composition reads, looked up per read: the
 * profile's `tui*` rows can compose after the mount.
 */
export interface CoreHost {
  readonly adapterRuntime: AdapterRuntimeOptions
  readonly themeHost: ReturnType<typeof getHostThemes>
  /** Workspace registry runtime; the local-only runtime without the row. */
  readonly workspaceService: NonNullable<ReturnType<typeof getHostWorkspaceRuntime>> | ReturnType<typeof createLocalWorkspaceRuntime>
  readonly commandTrees: ReturnType<typeof getHostCommandTrees>
  readonly sceneRuntime: ReturnType<typeof getHostSceneRuntime>
  readonly settingsSectionsRuntime: ReturnType<typeof getHostSettingsSections>
  readonly rendererRuntime: ReturnType<typeof getHostRenderers>
  /** The live grant store: the host-owned one when the plugin-host row is
   *  mounted, else this channel's private fallback (re-read per operation). */
  currentGrantStore(): ReturnType<typeof readGrantStore>
}

/**
 * Resolve the host seams and install the decision gate. The topology marker
 * is effectful state, so it is owned at acquisition: a later construction
 * failure rolls it back.
 */
export function resolveCoreHost(ctx: ChannelHost, owner: Pick<ChannelOwner, 'own'>): CoreHost {
  const adapterRuntime = ctx.runtime
  // Backstop: the extensions row installs the decision-subscription gate,
  // but the channel is the dispatch path. A stale patch without that row (or
  // a bare embed mounting neither) would otherwise leave tui/input and
  // friends subscribable by default, silently voiding default-deny.
  // Idempotent per cordis root, so the full-patch path installs exactly
  // once whichever side runs first. Keep a private fallback for
  // bare embedders, but resolve the host-owned store on every operation so
  // a plugin-host row mounted later (or a custom live GrantStore) is not
  // shadowed by an early snapshot.
  const fallbackGrantStore = readGrantStore(undefined, undefined, adapterRuntime)
  const currentGrantStore = (): ReturnType<typeof readGrantStore> =>
    getHostGrantStore(ctx.get('tuiPluginHost')) ?? fallbackGrantStore
  ctx.installDecisionGuard(currentGrantStore())
  // The channel is the real DecisionEvents dispatch path. Record that
  // topology so the live driver can distinguish "guard installed" (not a
  // live feature) from "events can actually be dispatched here".
  owner.own(ctx.markDecisionDispatchTopology())
  // Workspace registry runtime (optional service, issue #183): mounted by
  // the bundle patch's dsh-tui-workspaces row; absent the row (stale patch
  // or a bare embedder), degrade to the local-only runtime (one per channel).
  let localWorkspaces: ReturnType<typeof createLocalWorkspaceRuntime> | undefined
  return {
    adapterRuntime,
    get themeHost() { return getHostThemes(ctx.get('tuiThemes') as TuiThemeRuntime | undefined) },
    get workspaceService() {
      return getHostWorkspaceRuntime(ctx.get('tuiWorkspaces') as TuiWorkspaceRuntime | undefined)
        ?? (localWorkspaces ??= createLocalWorkspaceRuntime())
    },
    get commandTrees() { return getHostCommandTrees(ctx.get('tuiCommandTrees') as TuiCommandTreeRuntime | undefined) },
    // Plugin scene runtime (optional, dsh-tui-scenes row): absent the row,
    // `pluginScene` simply stays undefined.
    get sceneRuntime() { return getHostSceneRuntime(ctx.get('tuiScenes') as TuiSceneRuntime | undefined) },
    // Falls back to the in-package local host when the composition's
    // service row is unavailable (issue #557).
    get settingsSectionsRuntime() {
      return getHostSettingsSections(ctx.get('tuiSettingsSections') as TuiSettingsSectionsRuntime | undefined)
        ?? ctx.localSettingsSections()
    },
    // Custom-entry text renderers (optional, dsh-tui-extensions row): absent
    // the row, unknown plugin event types stay invisible in the transcript.
    get rendererRuntime() { return getHostRenderers(ctx.get('tuiRenderers') as TuiRendererRuntime | undefined) },
    currentGrantStore,
  }
}

/**
 * Re-render on settings-section and plugin-scene changes (owner-scoped),
 * re-binding when the host reports a service change.
 */
export function startHostSubscriptions(
  host: Pick<CoreHost, 'settingsSectionsRuntime' | 'sceneRuntime'>,
  owner: Pick<ChannelOwner, 'own' | 'current'>,
  state: Pick<ChannelState, 'pluginScene' | 'emit'>,
  services?: Pick<ChannelHost, 'watchServices'>,
): void {
  let sections: { runtime: CoreHost['settingsSectionsRuntime']; off: (() => void) | undefined } | undefined
  let scenes: { runtime: CoreHost['sceneRuntime']; off: (() => void) | undefined } | undefined
  const bind = (): boolean => {
    let changed = false
    const sectionsRuntime = host.settingsSectionsRuntime
    if (sections === undefined || sections.runtime !== sectionsRuntime) {
      sections?.off?.()
      sections = { runtime: sectionsRuntime, off: sectionsRuntime?.subscribe(() => { if (owner.current()) state.emit() }) }
      changed = true
    }
    const sceneRuntime = host.sceneRuntime
    if (scenes === undefined || scenes.runtime !== sceneRuntime) {
      scenes?.off?.()
      scenes = {
        runtime: sceneRuntime,
        off: sceneRuntime?.subscribe(() => {
          if (state.pluginScene === sceneRuntime.active) return
          state.pluginScene = sceneRuntime.active
          state.emit()
        }),
      }
      if (state.pluginScene !== sceneRuntime?.active) state.pluginScene = sceneRuntime?.active
      changed = true
    }
    return changed
  }
  bind()
  owner.own(() => {
    sections?.off?.()
    scenes?.off?.()
    sections = undefined
    scenes = undefined
  })
  const unwatch = services?.watchServices?.(name => {
    if (name !== 'tuiSettingsSections' && name !== 'tuiScenes') return
    if (!owner.current()) return
    if (bind()) state.emit()
  })
  if (unwatch !== undefined) owner.own(unwatch)
}

/** Cheap HEAD samples notice checkouts without waiting for the full status scan. */
const BRANCH_HEAD_POLL_MS = 1000
/** Files and upstream refs can change without HEAD changing. */
const GIT_STATUS_POLL_MS = 5000
/** Ample room for long UTF-8 refs/gitdir paths without unbounded control-file reads. */
const GIT_METADATA_MAX_BYTES = 128 * 1024

/**
 * The `HEAD` file of the repository containing `cwd` (a linked worktree or a
 * submodule points at its git dir through a `gitdir:` line in `.git`), or
 * undefined when this process cannot see one. Reached from the timer path, so
 * it answers rather than throws: a missing or malformed `.git` lands on
 * undefined and leaves the poll silent.
 */
async function gitHeadPath(cwd: string): Promise<string | undefined> {
  try {
    let dir = await realpath(cwd)
    for (;;) {
      const dotGit = join(dir, '.git')
      const entry = await stat(dotGit).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined
        throw error
      })
      if (entry?.isDirectory()) return join(dotGit, 'HEAD')
      if (entry?.isFile()) {
        const target = /^gitdir:\s*(.+)$/m.exec(await readGitMetadata(dotGit) ?? '')?.[1]
        // Git records the target relative to the directory holding `.git`.
        if (target === undefined) return undefined
        return join(resolve(dirname(dotGit), target.trim()), 'HEAD')
      }
      if (entry !== undefined) return undefined
      const parent = dirname(dir)
      if (parent === dir) return undefined
      dir = parent
    }
  } catch {
    return undefined
  }
}

/** Small, regular Git control files only; unreadable metadata stays best-effort. */
async function readGitMetadata(path: string | undefined): Promise<string | undefined> {
  if (path === undefined) return undefined
  try {
    return Buffer.from(await readBoundedRegularFile(path, GIT_METADATA_MAX_BYTES)).toString('utf8')
  } catch {
    return undefined
  }
}

/**
 * Independent workspace/current-directory git facts through the host shell.
 * HEAD is sampled every second (including gitdir retargeting); a full status
 * scan every five seconds also catches dirty files and upstream ref changes.
 * Explicit refreshes run both active routes immediately after moves/adoptions
 * and settled turns. Full status scans also run without a local HEAD, so
 * remote/sandboxed shell-only workspaces stay current.
 */
export function createGitBranchRefresher(ctx: ServiceLookup, deps: {
  owner: Pick<ChannelOwner, 'current' | 'own'>
  state: Pick<ChannelState, 'cwd' | 'workingDirectory' | 'agentBindingGeneration' |
    'gitBranch' | 'gitStatus' | 'workingDirectoryGitBranch' | 'workingDirectoryGitStatus' | 'emit'>
  /** Record the fixed workspace branch against the bound session. */
  noteBranch?(branch: string): void
}): () => void {
  const { state } = deps
  let disposed = false
  const lane = (workingDirectory: boolean) => {
    const branchKey = workingDirectory ? 'workingDirectoryGitBranch' : 'gitBranch'
    const statusKey = workingDirectory ? 'workingDirectoryGitStatus' : 'gitStatus'
    const cwd = (): string | undefined => workingDirectory
      ? state.workingDirectory !== state.cwd ? state.workingDirectory : undefined
      : state.cwd
    let currentCwd: string | undefined
    let generation: number | undefined
    /** HEAD path plus text: a retargeted gitdir can keep the same branch. */
    let signature: string | undefined
    let refreshAfter = 0
    let retryAfter: number | undefined
    let retryDelayMs = 0
    let issued = 0
    let polling = false
    const retry = (): void => {
      retryDelayMs = Math.min(retryDelayMs * 2 || BRANCH_HEAD_POLL_MS, 30_000)
      retryAfter = performance.now() + retryDelayMs
    }
    const clear = (): void => {
      const changed = state[branchKey] !== undefined || state[statusKey] !== undefined
      state[branchKey] = undefined
      state[statusKey] = undefined
      if (changed) state.emit()
    }
    const probe = async (force: boolean): Promise<void> => {
      if (disposed || !deps.owner.current()) return
      const requestedCwd = cwd()
      const requestedGeneration = state.agentBindingGeneration
      const changedScope = requestedCwd !== currentCwd || requestedGeneration !== generation
      if (force || changedScope) {
        // Invalidate before any await, including a return to the workspace.
        issued += 1
        retryAfter = undefined
        retryDelayMs = 0
        if (changedScope) {
          currentCwd = requestedCwd
          generation = requestedGeneration
          signature = undefined
          refreshAfter = 0
          clear()
        }
      }
      if (requestedCwd === undefined) return
      const current = (): boolean => !disposed && deps.owner.current()
        && state.agentBindingGeneration === requestedGeneration && cwd() === requestedCwd
      const readTicket = issued
      // Slow filesystem samples are single-flight per lane; explicit moves
      // can still overtake one, and the other lane remains independent.
      const headPath = await gitHeadPath(requestedCwd)
      const link = headPath === undefined ? undefined : await readlink(headPath).catch(() => undefined)
      const observed = link?.startsWith('refs/')
        ? `ref: ${link}`
        : (await readGitMetadata(headPath))?.trim()
      if (readTicket !== issued || !current()) return
      const observedSignature = observed === undefined ? undefined : `${headPath}\0${observed}`
      if (!force && !changedScope) {
        if (observedSignature === undefined && signature !== undefined) {
          // A formerly visible HEAD disappeared; never let its in-flight
          // reply restore the stale checkout. Shell-only directories still
          // receive full scans after the status/retry deadline.
          signature = undefined
          retryAfter = undefined
          retryDelayMs = 0
          issued += 1
          clear()
          return
        }
        if (observedSignature === signature
          && performance.now() < (retryAfter ?? refreshAfter)) return
      }
      // Baseline at issue time: a checkout during the shell call still
      // differs from this signature and is noticed by the next HEAD sample.
      if (observedSignature !== signature) retryDelayMs = 0
      signature = observedSignature
      retryAfter = undefined
      refreshAfter = performance.now() + GIT_STATUS_POLL_MS
      const ticket = ++issued
      const shell = ctx.get('shell') as ForegroundShell | undefined
      if (!shell) { retry(); return }
      void runForegroundShell(shell, {
        command: GIT_STATUS_COMMAND,
        workdir: requestedCwd,
        timeoutMs: 3000,
      }).then(result => {
        if (ticket !== issued || !current()) return
        if (result.timedOut) { retry(); return }
        if (result.exitCode !== undefined && result.exitCode !== 0) {
          // A shell transport/permission failure is not an empty checkout.
          // Only Git's explicit non-repository answer may clear known facts.
          if (result.exitCode === 128 && /^fatal: not a git repository\b/mu.test(result.stderr.text)) clear()
          retry()
          return
        }
        const status = parseGitStatus(result.stdout.text)
        // A B -> C -> B checkout can return C while both HEAD samples saw B.
        const expectedBranch = observed?.startsWith('ref:')
          ? /^ref:\s+refs\/heads\/(.+)$/.exec(observed)?.[1]
          : undefined
        const detachedOid = observed !== undefined && /^[0-9a-f]{40,64}$/iu.test(observed) ? observed : undefined
        if ((expectedBranch !== undefined && (status?.detached === true || status?.branch !== expectedBranch))
          || (detachedOid !== undefined && (status?.detached !== true || status.branch !== detachedOid.slice(0, 8)))) {
          retry()
          return
        }
        retryDelayMs = 0
        const next = status === undefined || status.branch === '' ? undefined : status.branch
        const previous = state[statusKey]
        const changed = next !== state[branchKey]
          || previous?.branch !== status?.branch
          || previous?.gitDir !== status?.gitDir
          || previous?.isLinkedWorktree !== status?.isLinkedWorktree
          || previous?.ahead !== status?.ahead
          || previous?.behind !== status?.behind
          || previous?.changed !== status?.changed
          || previous?.untracked !== status?.untracked
          || previous?.upstream !== status?.upstream
          || previous?.detached !== status?.detached
          || previous?.truncated !== status?.truncated
        state[statusKey] = status
        state[branchKey] = next
        if (!workingDirectory && next !== undefined) deps.noteBranch?.(next)
        if (changed) state.emit()
      }).catch(() => {
        if (ticket === issued && current()) retry()
      })
    }
    return {
      refresh: () => { void probe(true) },
      poll: () => {
        if (disposed || !deps.owner.current() || polling) return
        polling = true
        void probe(false).finally(() => { polling = false })
      },
      invalidate: () => { issued += 1 },
    }
  }
  const workspace = lane(false)
  const workingDirectory = lane(true)
  const timer = setInterval(() => {
    workspace.poll()
    workingDirectory.poll()
  }, BRANCH_HEAD_POLL_MS)
  timer.unref?.()
  deps.owner.own(() => {
    disposed = true
    clearInterval(timer)
    workspace.invalidate()
    workingDirectory.invalidate()
  })
  return () => {
    workspace.refresh()
    workingDirectory.refresh()
  }
}

