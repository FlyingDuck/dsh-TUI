/**
 * 底栏 git 段的回归：`git status --porcelain=v2 --branch` 的解析与渲染后缀。
 *
 *   A. 解析器夹具文本六态：领先/落后 + 有改动、只有未跟踪、detached HEAD、
 *      无上游、未出生分支（(initial)）、非 git 目录；外加超长脏树（截断）；
 *   B. 后缀字形：0 一律不画（不出现 ↑0 ↓0）、截断带 `+`；
 *   C. 真实仓库烟测：在**本仓库**跑一次真命令，确认线上输出真能被这个解析器吃下
 *      —— 夹具是自己写的，只有真跑一次才知道 git 的实际形状没变；tracking 动态读取。
 *   D. 真实临时仓库：自定义上游、无上游、detached、主 checkout 子目录与真正
 *      linked worktree 的绝对 git-dir；双路同 HEAD dirty/ahead/behind 周期更新。
 *   E. 真刷新器 + 假 host shell：同 HEAD 强制刷新、同 cwd 不闪空、双路票据淘汰、
 *      快速移动/回归、同 cwd 切会话、snapshot、失败与 owner 释放；HEAD/backoff 另见
 *      verify-git-branch-refresh.mjs。
 *
 * 运行：node --import tsx/esm scripts/verify-git-status.ts
 */
import assert from 'node:assert/strict'
import { execFileSync, execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGitBranchRefresher } from '../src/dsh-adapter/channel/core/host.js'
import { createChannelOwner } from '../src/dsh-adapter/channel/owner.js'
import { projectChannelState } from '../src/adapter/channel/state.js'
import type { ForegroundShell, ShellRequest, ShellResult } from '../src/dsh-adapter/compat/shell.js'
import type { GitStatusSummary } from '../src/adapter/ports/channel-view.js'
import { GIT_STATUS_COMMAND, GIT_STATUS_MAX_LINES, gitStatusSuffix, parseGitStatus } from '../src/utils/gitStatus.js'
import { settled } from './lib/term-test.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

let checks = 0
const failures: string[] = []
const check = (name: string, ok: boolean, detail = ''): void => {
  checks += 1
  if (!ok) failures.push(`${name}${detail === '' ? '' : `: ${detail}`}`)
}

const OID = '008311789ec9d2a30af1dc9d6e17a465bd355ef5'

// ── A. 夹具六态 ────────────────────────────────────────────────────────────
{
  const withChanges = [
    `# branch.oid ${OID}`,
    '# branch.head bean',
    '# branch.upstream origin/bean',
    '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 aaa bbb src/one.ts',
    '1 M. N... 100644 100644 100644 ccc ddd src/two.ts',
    '2 R. N... 100644 100644 100644 eee fff R100 src/three.ts\tsrc/renamed.ts',
    '? untracked-a.txt',
    '? untracked-b/',
    '',
  ].join('\n')
  const parsed = parseGitStatus(withChanges)
  check('A 常规：分支名', parsed?.branch === 'bean', String(parsed?.branch))
  check('A 常规：领先/落后', parsed?.ahead === 2 && parsed?.behind === 1, `${parsed?.ahead}/${parsed?.behind}`)
  check('A 常规：改动含重命名行', parsed?.changed === 3, String(parsed?.changed))
  check('A 常规：未跟踪单独计数', parsed?.untracked === 2, String(parsed?.untracked))
  check('A 常规：上游', parsed?.upstream === 'origin/bean', String(parsed?.upstream))
  check('A 常规：非 detached、未截断', parsed?.detached === false && parsed?.truncated === false)
  const gitDir = join(root, '.git')
  const mainIdentity = parseGitStatus(`${gitDir}\n${gitDir}\n${withChanges}`)
  check('A checkout标识：主checkout不是linked worktree', mainIdentity?.gitDir === gitDir && mainIdentity.isLinkedWorktree === false)
  const linkedGitDir = join(gitDir, 'worktrees', 'linked')
  const linkedIdentity = parseGitStatus(`${linkedGitDir}\n${gitDir}\n${withChanges}`)
  check('A checkout标识：linked gitDir与commonDir不同', linkedIdentity?.gitDir === linkedGitDir && linkedIdentity.isLinkedWorktree === true)
  check('A checkout标识：纯porcelain不编造身份', parsed?.gitDir === undefined && parsed?.isLinkedWorktree === undefined)
  const relativeIdentity = parseGitStatus(`.git\n../.git\n${withChanges}`)
  check('A checkout标识：不接受相对rev-parse路径', relativeIdentity?.gitDir === undefined && relativeIdentity?.isLinkedWorktree === undefined)

  const detached = parseGitStatus([`# branch.oid ${OID}`, '# branch.head (detached)', '# branch.ab +0 -0'].join('\n'))
  check('A detached：分支位显示 8 位短 sha', detached?.branch === OID.slice(0, 8), String(detached?.branch))
  check('A detached：标记为 detached', detached?.detached === true)

  const noUpstream = parseGitStatus([`# branch.oid ${OID}`, '# branch.head feature/x', '? a.txt'].join('\n'))
  check('A 无上游：不编造 ahead/behind', noUpstream?.ahead === 0 && noUpstream?.behind === 0)
  check('A 无上游：upstream 缺席', noUpstream?.upstream === undefined, String(noUpstream?.upstream))
  check('A 无上游：未跟踪仍然算', noUpstream?.untracked === 1, String(noUpstream?.untracked))

  const unborn = parseGitStatus(['# branch.oid 0000000000000000000000000000000000000000', '# branch.head (initial)', '? first.txt'].join('\n'))
  check('A 未出生分支：分支位留空', unborn?.branch === '', JSON.stringify(unborn?.branch))
  check('A 未出生分支：不报 detached', unborn?.detached === false)

  check('A 非 git 目录：无 branch 头 → undefined', parseGitStatus('') === undefined)
  check('A 非 git 目录：错误文本 → undefined', parseGitStatus('fatal: not a git repository (or any of the parent directories): .git\n') === undefined)

  // 超长脏树：扫描到上限就停，并把「这是下限」报出来。
  const huge = [`# branch.oid ${OID}`, '# branch.head bean', '# branch.upstream origin/bean', '# branch.ab +1 -0',
    ...Array.from({ length: GIT_STATUS_MAX_LINES + 100 }, (_, i) => `1 .M N... 100644 100644 100644 aaa bbb file-${i}.ts`)].join('\n')
  const capped = parseGitStatus(huge)
  check('A 超长：标记截断', capped?.truncated === true)
  check('A 超长：计数是下限（少于真实行数）', (capped?.changed ?? 0) < GIT_STATUS_MAX_LINES + 100, String(capped?.changed))
  check('A 超长：上限内仍在计数', (capped?.changed ?? 0) > 0, String(capped?.changed))
}

// ── B. 后缀字形 ────────────────────────────────────────────────────────────
{
  const clean = parseGitStatus([`# branch.oid ${OID}`, '# branch.head bean', '# branch.upstream origin/bean', '# branch.ab +0 -0'].join('\n'))
  check('B 干净仓库：一个后缀都不画', clean !== undefined && Object.keys(gitStatusSuffix(clean)).length === 0, JSON.stringify(clean === undefined ? null : gitStatusSuffix(clean)))

  const busy = parseGitStatus([`# branch.oid ${OID}`, '# branch.head bean', '# branch.upstream origin/bean', '# branch.ab +12 -3', '1 .M N... 100644 100644 100644 aaa bbb a.ts', '? u.txt'].join('\n'))
  const suffix = busy === undefined ? {} : gitStatusSuffix(busy)
  check('B 领先用 ↑N', suffix.ahead === '↑12', String(suffix.ahead))
  check('B 落后用 ↓N', suffix.behind === '↓3', String(suffix.behind))
  check('B 脏 = 改动 + 未跟踪', suffix.dirty === '●2', String(suffix.dirty))

  const onlyBehind = parseGitStatus([`# branch.oid ${OID}`, '# branch.head bean', '# branch.upstream origin/bean', '# branch.ab +0 -4'].join('\n'))
  const behindSuffix = onlyBehind === undefined ? {} : gitStatusSuffix(onlyBehind)
  check('B 只有落后：领先不出现（不画 ↑0）', behindSuffix.ahead === undefined && behindSuffix.behind === '↓4', JSON.stringify(behindSuffix))

  const truncated = parseGitStatus([`# branch.oid ${OID}`, '# branch.head bean', ...Array.from({ length: GIT_STATUS_MAX_LINES + 5 }, () => '1 .M N... 100644 100644 100644 aaa bbb x.ts')].join('\n'))
  const truncatedSuffix = truncated === undefined ? {} : gitStatusSuffix(truncated)
  check('B 截断的脏数带 +', truncatedSuffix.dirty?.endsWith('+') === true, String(truncatedSuffix.dirty))
}

// ── C. 真实仓库烟测 ────────────────────────────────────────────────────────
// hook 或调用者的 GIT_DIR/INDEX/CONFIG 不能把临时仓库操作重定向到外面。
const gitEnvironment = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/iu.test(key))),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
}
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: gitEnvironment, encoding: 'utf8' }).trim()
const liveStatus = (cwd: string, label: string): ReturnType<typeof parseGitStatus> => {
  const live = parseGitStatus(execSync(GIT_STATUS_COMMAND, { cwd, env: gitEnvironment, encoding: 'utf8' }))
  // 用独立 Git 命令求预期，不假设 checkout 的分支或 tracking 配置。
  const branch = git(cwd, 'branch', '--show-current')
  const expectedBranch = branch || git(cwd, 'rev-parse', '--verify', 'HEAD').slice(0, 8)
  const upstream = branch === '' ? undefined : git(cwd, 'for-each-ref', '--format=%(upstream:short)', `refs/heads/${branch}`) || undefined
  check(`${label}：解析器吃得下真实输出`, live !== undefined)
  check(`${label}：分支或 detached 短 SHA 一致`, live?.branch === expectedBranch, `${live?.branch} vs ${expectedBranch}`)
  check(`${label}：detached 标记一致`, live?.detached === (branch === ''))
  check(`${label}：上游与实际 tracking 配置一致`, live?.upstream === upstream, `${live?.upstream} vs ${upstream}`)
  check(`${label}：ahead/behind 是非负整数`, Number.isInteger(live?.ahead) && (live?.ahead ?? -1) >= 0 && Number.isInteger(live?.behind) && (live?.behind ?? -1) >= 0)
  check(`${label}：脏计数是非负整数`, Number.isInteger(live?.changed) && (live?.changed ?? -1) >= 0 && Number.isInteger(live?.untracked) && (live?.untracked ?? -1) >= 0)
  const gitDir = git(cwd, 'rev-parse', '--path-format=absolute', '--git-dir')
  const commonDir = git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  check(`${label}：checkout git-dir 始终绝对格式`, isAbsolute(live?.gitDir ?? '') && live?.gitDir === gitDir, String(live?.gitDir))
  check(`${label}：linked 标记与绝对 common-dir 比较一致`, live?.isLinkedWorktree === (gitDir !== commonDir))
  return live
}
liveStatus(root, 'C 本仓库')

// ── D. 真实临时仓库：tracking / 无上游 / detached 都不能靠开发机配置过关 ────────
{
  const temporaryRoot = realpathSync(tmpdir())
  const fixture = realpathSync(mkdtempSync(join(temporaryRoot, 'dsh-tui-git-status-')))
  try {
    git(fixture, '-c', 'init.defaultBranch=smoke/topic', '-c', 'init.templateDir=', 'init', '--quiet')
    git(fixture, 'config', 'user.name', 'Git status smoke')
    git(fixture, 'config', 'user.email', 'git-status@example.invalid')
    git(fixture, 'config', 'core.hooksPath', '/dev/null')
    git(fixture, 'config', 'core.excludesFile', '/dev/null')
    git(fixture, 'config', 'commit.gpgSign', 'false')
    writeFileSync(join(fixture, 'tracked.txt'), 'base\n')
    git(fixture, 'add', 'tracked.txt')
    git(fixture, 'commit', '--quiet', '-m', 'Fixture base')
    git(fixture, 'branch', 'baseline')
    git(fixture, 'branch', '--set-upstream-to=baseline')
    git(fixture, 'commit', '--quiet', '--allow-empty', '-m', 'Fixture ahead')
    writeFileSync(join(fixture, 'tracked.txt'), 'changed\n')
    writeFileSync(join(fixture, 'untracked.txt'), 'new\n')

    const tracking = liveStatus(fixture, 'D 自定义上游')
    check('D 自定义上游：不是 origin/bean 也能通过', tracking?.branch === 'smoke/topic' && tracking.upstream === 'baseline')
    check('D 自定义上游：真实 ahead/behind', tracking?.ahead === 1 && tracking.behind === 0)
    check('D 自定义上游：真实改动与未跟踪计数', tracking?.changed === 1 && tracking.untracked === 1)

    git(fixture, 'branch', '--unset-upstream')
    const noUpstream = liveStatus(fixture, 'D 无上游')
    check('D 无上游：不编造 tracking 或 ahead/behind', noUpstream !== undefined && noUpstream.upstream === undefined && noUpstream.ahead === 0 && noUpstream.behind === 0)

    const oid = git(fixture, 'rev-parse', '--verify', 'HEAD')
    git(fixture, 'checkout', '--quiet', '--detach', 'HEAD')
    const detached = liveStatus(fixture, 'D detached')
    check('D detached：完整 OID 前 8 位而不是 HEAD', detached?.branch === oid.slice(0, 8) && detached.detached)
    check('D detached：无上游但仍保留脏计数', detached !== undefined && detached.upstream === undefined && detached.changed === 1 && detached.untracked === 1)

    const nested = join(fixture, 'src', 'nested')
    mkdirSync(nested, { recursive: true })
    const nestedStatus = liveStatus(nested, 'D 主checkout子目录')
    check('D 子目录不是linked worktree且gitDir相同', nestedStatus?.isLinkedWorktree === false && nestedStatus.gitDir === detached?.gitDir)

    // All real worktrees belong below their repository's .worktrees directory.
    const linked = join(fixture, '.worktrees', 'linked')
    mkdirSync(join(fixture, '.git', 'info'), { recursive: true })
    writeFileSync(join(fixture, '.git', 'info', 'exclude'), '.worktrees/\n')
    git(fixture, 'worktree', 'add', '--quiet', '-b', 'smoke/linked', linked, 'HEAD')
    try {
      const linkedStatus = liveStatus(linked, 'D 真实linked worktree')
      check('D linked worktree具有不同gitDir', linkedStatus?.isLinkedWorktree === true && linkedStatus.gitDir !== detached?.gitDir)
      const linkedNested = join(linked, 'deep', 'directory')
      mkdirSync(linkedNested, { recursive: true })
      const linkedNestedStatus = liveStatus(linkedNested, 'D linked worktree子目录')
      check('D linked子目录仍属于同一checkout', linkedNestedStatus?.isLinkedWorktree === true && linkedNestedStatus.gitDir === linkedStatus?.gitDir)

      // The fixed workspace and moved checkout must both refresh even when
      // only file contents/upstream refs changed and neither HEAD text moved.
      git(fixture, 'switch', '--quiet', 'smoke/topic')
      git(fixture, 'branch', '--set-upstream-to=baseline')
      const initialHead = git(fixture, 'symbolic-ref', 'HEAD')
      const owner = createChannelOwner()
      const state = {
        cwd: fixture, workingDirectory: linked as string | undefined, agentBindingGeneration: 0,
        gitBranch: undefined as string | undefined, gitStatus: undefined as GitStatusSummary | undefined,
        workingDirectoryGitBranch: undefined as string | undefined, workingDirectoryGitStatus: undefined as GitStatusSummary | undefined,
        emit() {},
      }
      const shell: ForegroundShell = {
        resolve: request => request,
        async run(spec) {
          const request = spec as ShellRequest
          return { stdout: { text: execSync(request.command, { cwd: request.workdir, env: gitEnvironment, encoding: 'utf8' }) }, stderr: { text: '' }, timedOut: false, exitCode: 0 }
        },
      }
      const refresh = createGitBranchRefresher({ get: (name: string) => name === 'shell' ? shell : undefined } as never, { owner, state })
      const linkedFile = join(linked, 'linked-only.txt')
      try {
        refresh()
        assert.ok(await settled(() => state.gitStatus?.ahead === 1 && state.workingDirectoryGitBranch === 'smoke/linked'))
        check('D 双路真实checkout身份与分支独立', state.gitBranch === 'smoke/topic' && state.gitStatus?.gitDir !== state.workingDirectoryGitStatus?.gitDir)
        writeFileSync(join(fixture, 'tracked.txt'), 'base\n')
        writeFileSync(join(fixture, 'another.txt'), 'new\n')
        writeFileSync(linkedFile, 'new\n')
        const upstreamCommit = git(fixture, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'Fixture upstream advanced')
        git(fixture, 'update-ref', 'refs/heads/baseline', upstreamCommit)
        check('D 轮询前HEAD未改变', git(fixture, 'symbolic-ref', 'HEAD') === initialHead && git(fixture, 'rev-parse', 'HEAD') === oid)
        check('D 主checkout dirty与ahead/behind随轮询更新', await settled(() => state.gitStatus?.ahead === 0
          && state.gitStatus.behind === 1 && state.gitStatus.changed === 0 && state.gitStatus.untracked === 2, { timeoutMs: 8000 }))
        check('D 离开工作区时当前checkout也继续轮询dirty', await settled(() => state.workingDirectoryGitStatus?.untracked === 1, { timeoutMs: 8000 }))
      } finally {
        owner.dispose()
        assert.equal(dirname(linkedFile), linked)
        rmSync(linkedFile, { force: true })
      }
    } finally {
      // Inspect both checkouts before removing the fixture worktree; no force.
      git(fixture, 'status', '--porcelain=v2')
      assert.equal(git(linked, 'status', '--porcelain=v2'), '')
      git(fixture, 'worktree', 'remove', linked)
    }
  } finally {
    assert.equal(dirname(realpathSync(fixture)), temporaryRoot)
    assert.ok(basename(fixture).startsWith('dsh-tui-git-status-'))
    rmSync(fixture, { recursive: true, force: true })
  }
}

// ── E. 双路真刷新器：同 HEAD 刷新、快速移动、回归、切会话与释放 ─────────────
{
  const temporaryRoot = realpathSync(tmpdir())
  const fixture = realpathSync(mkdtempSync(join(temporaryRoot, 'dsh-git-status-refresh-')))
  const cwd = join(fixture, 'project')
  const moved = join(fixture, 'worktree')
  const movedAgain = join(fixture, 'another-worktree')
  for (const directory of [cwd, moved, movedAgain]) {
    mkdirSync(join(directory, '.git'), { recursive: true })
    writeFileSync(join(directory, '.git', 'HEAD'), 'ref: refs/heads/bean\n')
  }
  const owner = createChannelOwner()
  type Request = { request: ShellRequest; resolve(result: ShellResult): void }
  const requests: Request[] = []
  const shell: ForegroundShell = {
    resolve: request => request,
    async execute(spec) {
      const result = new Promise<ShellResult>(resolve => {
        requests.push({ request: spec as ShellRequest, resolve })
      })
      return { result: () => result }
    },
  }
  let emits = 0
  const state: {
    cwd: string
    workingDirectory: string | undefined
    agentBindingGeneration: number
    gitBranch: string | undefined
    gitStatus: GitStatusSummary | undefined
    workingDirectoryGitBranch: string | undefined
    workingDirectoryGitStatus: GitStatusSummary | undefined
    emit(): void
  } = {
    cwd, workingDirectory: undefined, agentBindingGeneration: 0,
    gitBranch: undefined, gitStatus: undefined, workingDirectoryGitBranch: undefined, workingDirectoryGitStatus: undefined,
    emit: () => { emits += 1 },
  }
  const recorded: string[] = []
  const refresh = createGitBranchRefresher({ get: (name: string) => name === 'shell' ? shell : undefined } as never, {
    owner, state, noteBranch: branch => { recorded.push(branch) },
  })
  const issue = async (): Promise<Map<string, Request>> => {
    const start = requests.length
    const expected = state.workingDirectory === undefined || state.workingDirectory === cwd ? 1 : 2
    refresh()
    assert.ok(await settled(() => requests.length >= start + expected), 'both active routes reach the host shell')
    const issued = requests.slice(start)
    assert.equal(issued.length, expected)
    for (const { request } of issued) assert.equal(request.command, GIT_STATUS_COMMAND)
    return new Map(issued.map(request => [request.request.workdir!, request]))
  }
  const answer = (request: Request, ahead: number): void => request.resolve({
    exitCode: 0,
    stdout: { text: `${join(request.request.workdir!, '.git')}\n${join(request.request.workdir!, '.git')}\n# branch.oid ${OID}\n# branch.head bean\n# branch.ab +${ahead} -1\n? new.txt\n` },
    stderr: { text: '' }, timedOut: false,
  })
  try {
    answer((await issue()).get(cwd)!, 2)
    check('E 首次查询发布工作区分支与计数', await settled(() => state.gitBranch === 'bean' && state.gitStatus?.ahead === 2 && state.gitStatus.untracked === 1))
    check('E 未移动时不启动当前目录路由', state.workingDirectoryGitBranch === undefined && requests.every(request => request.request.workdir === cwd))
    const bootEmits = emits

    const sameCwd = issue()
    check('E 同 cwd 刷新期间不清空已有事实', state.gitBranch === 'bean' && state.gitStatus?.ahead === 2)
    answer((await sameCwd).get(cwd)!, 3)
    check('E 同 HEAD 显式刷新仍更新计数并通知', await settled(() => state.gitStatus?.ahead === 3 && emits === bootEmits + 1))
    check('E 同分支刷新仍记录当前会话breadcrumb', recorded.length === 2 && recorded.every(branch => branch === 'bean'))

    const older = (await issue()).get(cwd)!
    const newer = (await issue()).get(cwd)!
    answer(newer, 9)
    assert.ok(await settled(() => state.gitStatus?.ahead === 9))
    answer(older, 1)
    await new Promise<void>(resolve => setImmediate(resolve))
    check('E 工作区较旧票据不能覆盖新计数', state.gitStatus?.ahead === 9)

    state.workingDirectory = moved
    const firstMove = await issue()
    check('E 移动后工作区事实仍固定在项目cwd', state.cwd === cwd && state.gitStatus?.ahead === 9)
    answer(firstMove.get(cwd)!, 10)
    answer(firstMove.get(moved)!, 4)
    assert.ok(await settled(() => state.gitStatus?.ahead === 10 && state.workingDirectoryGitStatus?.ahead === 4))
    const snapshot = projectChannelState({ ...state, todos: [], pending: [], tokens: {}, mode: {} } as never)
    check('E snapshot转发两路git字段及当前目录', snapshot.gitStatus?.ahead === 10 && snapshot.workingDirectoryGitStatus?.ahead === 4
      && snapshot.workingDirectoryGitBranch === 'bean' && snapshot.workingDirectory === moved)
    check('E snapshot保留checkout绝对身份', snapshot.gitStatus?.gitDir === join(cwd, '.git')
      && snapshot.workingDirectoryGitStatus?.gitDir === join(moved, '.git'))

    const lateMove = await issue()
    answer(lateMove.get(cwd)!, 10)
    state.workingDirectory = movedAgain
    const secondMove = issue()
    check('E 快速移动立即清空旧当前目录git但保留工作区', state.workingDirectoryGitStatus === undefined && state.workingDirectoryGitBranch === undefined && state.gitStatus?.ahead === 10)
    const secondRequests = await secondMove
    answer(secondRequests.get(cwd)!, 11)
    answer(secondRequests.get(movedAgain)!, 22)
    assert.ok(await settled(() => state.workingDirectoryGitStatus?.ahead === 22))
    answer(lateMove.get(moved)!, 99)
    await new Promise<void>(resolve => setImmediate(resolve))
    check('E 快速移动的迟到目录回复丢弃', state.workingDirectoryGitStatus?.ahead === 22 && state.gitStatus?.ahead === 11)

    const beforeReturn = await issue()
    answer(beforeReturn.get(cwd)!, 11)
    state.workingDirectory = cwd
    const returning = issue()
    check('E 回到cwd立即清空当前目录两字段', state.workingDirectoryGitBranch === undefined && state.workingDirectoryGitStatus === undefined)
    const returnRequests = await returning
    check('E 回到cwd只查询工作区', returnRequests.size === 1 && returnRequests.has(cwd))
    answer(returnRequests.get(cwd)!, 12)
    answer(beforeReturn.get(movedAgain)!, 88)
    assert.ok(await settled(() => state.gitStatus?.ahead === 12))
    check('E 回来前的迟到回复不能复活当前目录git', state.workingDirectoryGitStatus === undefined)

    state.workingDirectory = undefined
    const cleared = await issue()
    check('E 未记录目录也只查询工作区', cleared.size === 1 && cleared.has(cwd))
    answer(cleared.get(cwd)!, 12)
    const previousSession = (await issue()).get(cwd)!
    state.agentBindingGeneration += 1
    const adopting = issue()
    check('E 同cwd切会话也同步清理旧git事实', state.gitBranch === undefined && state.gitStatus === undefined)
    answer((await adopting).get(cwd)!, 13)
    assert.ok(await settled(() => state.gitStatus?.ahead === 13))
    answer(previousSession, 77)
    await new Promise<void>(resolve => setImmediate(resolve))
    check('E 同cwd前会话的迟到回复仍丢弃', state.gitStatus?.ahead === 13)

    const failed = (await issue()).get(cwd)!
    failed.resolve({ exitCode: 2, stdout: { text: '' }, stderr: { text: 'temporary transport failure' }, timedOut: false })
    await new Promise<void>(resolve => setImmediate(resolve))
    check('E 非零shell失败不冒充空checkout', state.gitStatus?.ahead === 13 && state.gitBranch === 'bean')
    const timedOut = (await issue()).get(cwd)!
    timedOut.resolve({ exitCode: null, stdout: { text: '' }, stderr: { text: '' }, timedOut: true })
    await new Promise<void>(resolve => setImmediate(resolve))
    check('E timeout保留旧checkout事实', state.gitStatus?.ahead === 13 && state.gitBranch === 'bean')

    state.workingDirectory = moved
    const disposing = await issue()
    owner.dispose()
    for (const request of disposing.values()) answer(request, 99)
    refresh()
    await new Promise<void>(resolve => setImmediate(resolve))
    check('E owner释放后两路在途回复均不能落地', state.gitStatus?.ahead === 13 && state.workingDirectoryGitStatus === undefined)
  } finally {
    owner.dispose()
    assert.equal(dirname(realpathSync(fixture)), temporaryRoot)
    assert.ok(basename(fixture).startsWith('dsh-git-status-refresh-'))
    rmSync(fixture, { recursive: true, force: true })
  }
}

if (failures.length > 0) {
  console.error(`git-status FAILED (${failures.length}/${checks}):`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`git-status OK (${checks} checks: 六态/截断/后缀、真实 checkout/子目录/linked 身份、同 HEAD 双路 dirty/上下游轮询、快速移动/回归/会话票据/snapshot/失败/释放)`)
process.exit(0)
