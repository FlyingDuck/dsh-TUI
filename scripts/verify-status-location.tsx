/**
 * Fixed workspace + independent current-directory footer regression.
 *
 * Renders the real StatusLine into @xterm/headless, without importing its
 * layout helpers. Inputs that must fail: replacing workspace fields with the
 * current checkout, appending breadcrumbs to the compact main row, repeating
 * a same-gitDir branch, identifying repositories by branch name, suppressing
 * location with field switches, stealing the hint/hover/wake row, retaining a
 * stale location after return, or truncating away a narrow row's leaf.
 *
 * Covers undefined/equal, nested directory, linked worktree, other repository,
 * non-Git and unknown Git identity, home folding, remote display paths,
 * inline/fullscreen × compact/split/minimal, resize and cell-aware narrow
 * paths, separate workspace/current hover details, stable hint/wake rows,
 * and the real InfoPanel's independent workspace/current directory/Git rows.
 * Fixtures supply backend snapshots; no Git process or real session is used.
 *
 * Run: node --import tsx/esm scripts/verify-status-location.tsx
 * Source imports only; no compiled lib/ or pnpm build required.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ComponentProps, ReactNode } from 'react'
import type { ChannelUi } from '../src/adapter/channel/ui-policy.js'
import type { GitStatusSummary } from '../src/adapter/ports/channel-view.js'

// Isolate path/language preferences before modules capture HOME at import.
const fakeHome = mkdtempSync(join(tmpdir(), 'verify-status-location-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
process.env.DSH_TUI_LANG = 'zh'
process.env.FORCE_COLOR = '3'

const [React, { PassThrough, Writable }, { Terminal: XTerm }, ui, { StatusLine }, { stringWidth }, termTest] = await Promise.all([
  import('react'),
  import('node:stream'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/StatusLine.js'),
  import('../src/ink/stringWidth.js'),
  import('./lib/term-test.mjs'),
])
const { settled, viewportLines } = termTest

type StatusProps = Omit<ComponentProps<typeof StatusLine>, 'channel'>
const WORKSPACE = '/w/workspace-app'
const WORKSPACE_GIT_DIR = `${WORKSPACE}/.git`
const MODEL = 'MODELX'
const WORKSPACE_BRANCH = 'WRKBR'
const CURRENT_BRANCH = 'CURBR'

function gitStatus(overrides: Partial<GitStatusSummary> = {}): GitStatusSummary {
  return {
    branch: WORKSPACE_BRANCH,
    ahead: 1,
    behind: 0,
    changed: 1,
    untracked: 0,
    detached: false,
    truncated: false,
    gitDir: WORKSPACE_GIT_DIR,
    isLinkedWorktree: false,
    ...overrides,
  }
}

const BASE_CHANNEL = {
  minimalUi: false,
  statusBar: {
    compact: true,
    model: true,
    thinking: false,
    cwd: true,
    contextUsage: false,
    cache: false,
    tokens: false,
    cost: false,
    tps: false,
    gitBranch: true,
    sessionTitle: false,
    sessionId: false,
    goal: false,
    mode: false,
    contextBar: false,
    activity: false,
    trajectory: false,
    shortcutHint: false,
    pluginFields: false,
    pluginFieldsOrder: '*',
  },
  model: MODEL,
  provider: 'test-provider',
  contextWindow: 64_000,
  displayCwd: WORKSPACE,
  cwd: WORKSPACE,
  workingDirectory: undefined,
  workingDirectoryGitBranch: undefined,
  workingDirectoryGitStatus: undefined,
  mode: { id: 'default', plan: false, sandbox: 'workspace-write', approval: 'ask' },
  modeIndex: 0,
  tokens: {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    peak: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    idle: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  tpsSamples: [],
  backgroundJobs: [],
  contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
  working: false,
  activityFrames: undefined,
  agentId: 'abcdef0123456789',
  sessionRef: { backendId: 'dsh', sessionId: 'abcdef0123456789' },
  contextBarEnabled: false,
  gitBranch: WORKSPACE_BRANCH,
  gitStatus: gitStatus(),
} satisfies Partial<ChannelUi>

function channelWith(
  overrides: Partial<ChannelUi> = {},
  statusBar: Partial<NonNullable<ChannelUi['statusBar']>> = {},
): Partial<ChannelUi> {
  return { ...BASE_CHANNEL, ...overrides, statusBar: { ...BASE_CHANNEL.statusBar, ...statusBar } }
}

let checks = 0
let failures = 0
function check(name: string, ok: boolean, detail: unknown = ''): void {
  checks += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${ok ? '' : `  ${JSON.stringify(detail)}`}`)
  if (!ok) failures += 1
}

class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}

function KeySink(): null {
  ui.useInput(() => {})
  return null
}

function statusNode(channel: Partial<ChannelUi>, fullscreen: boolean, props: StatusProps, content?: ReactNode) {
  const body = React.createElement(ui.Box, { flexDirection: 'column' },
    React.createElement(KeySink),
    content ?? React.createElement(StatusLine, { ...props, channel: channel as ChannelUi }),
  )
  return fullscreen ? React.createElement(ui.AlternateScreen, null, body) : body
}

async function mountStatus(
  channel: Partial<ChannelUi>,
  { columns = 120, rows = 12, fullscreen = true, props = {}, renderContent }: {
    columns?: number
    rows?: number
    fullscreen?: boolean
    props?: StatusProps
    renderContent?: (channel: Partial<ChannelUi>) => ReactNode
  } = {},
) {
  const node = (next: Partial<ChannelUi>, nextProps: StatusProps) => statusNode(next, fullscreen, nextProps, renderContent?.(next))
  const term = new XTerm({ cols: columns, rows, scrollback: 0, allowProposedApi: true })
  class FakeOutput extends Writable {
    columns = columns
    rows = rows
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
      term.write(String(chunk), callback)
    }
  }
  const stdout = new FakeOutput()
  const stdin = new FakeStdin()
  let frames = 0
  const instance = await ui.render(node(channel, props), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    exitOnCtrlC: false,
    patchConsole: false,
    onFrame: () => { frames += 1 },
  })
  const flush = (): Promise<void> => new Promise(resolve => { stdout.write('', () => resolve()) })
  const flushFrame = async (after: number): Promise<void> => {
    if (!await settled(() => frames > after)) throw new Error('StatusLine did not paint a frame')
    await flush()
  }
  await flushFrame(0)
  return {
    term,
    lines: (): string[] => viewportLines(term),
    async rerender(next: Partial<ChannelUi>, nextProps: StatusProps = props): Promise<void> {
      const before = frames
      instance.rerender(node(next, nextProps))
      await flushFrame(before)
    },
    async resize(width: number): Promise<void> {
      const before = frames
      term.resize(width, term.rows)
      stdout.columns = width
      stdout.emit('resize')
      await flushFrame(before)
    },
    hover(needle: string): boolean {
      const lines = viewportLines(term)
      const row = lines.findIndex(line => line.includes(needle))
      if (row < 0) return false
      const line = lines[row]!
      const col = stringWidth(line.slice(0, line.indexOf(needle)))
      stdin.write(`\x1b[<35;${col + 1};${row + 1}M`)
      return true
    },
    async close(): Promise<void> {
      // A fake stream has no TTY fd. Avoid shutdown's synchronous fd=1
      // fallback restoring modes on the runner's real stdout.
      stdout.isTTY = false
      instance.unmount()
      await flush()
      instance.cleanup()
      term.dispose()
      stdin.destroy()
    },
  }
}

type Rig = Awaited<ReturnType<typeof mountStatus>>
const mainIndex = (rig: Rig): number => rig.lines().findIndex(line => line.includes(MODEL))
const mainRow = (rig: Rig): string => rig.lines()[mainIndex(rig)] ?? ''
const currentRow = (rig: Rig): string => rig.lines()[mainIndex(rig) + 1] ?? ''
const nonempty = (rig: Rig): string[] => rig.lines().filter(line => line.trim() !== '')
function rightAligned(rig: Rig, row: string): boolean {
  // StatusLine owns one padding cell at either edge; inspect the untrimmed
  // row's visible end, not a trimmed string that could mask trailing space.
  const index = rig.lines().indexOf(row)
  if (index < 0 || row.trim() === '') return false
  const raw = rig.term.buffer.active.getLine(rig.term.buffer.active.baseY + index)?.translateToString(false) ?? ''
  return stringWidth(raw.trimEnd()) === rig.term.cols - 1
}

try {
  // The same snapshots drive every presentation: compact's main cwd MUST NOT
  // grow a breadcrumb; minimal adds one leaf-only row, never Git decoration.
  for (const fullscreen of [false, true]) {
    for (const layout of ['compact', 'split', 'minimal'] as const) {
      const minimalUi = layout === 'minimal'
      const config = { compact: layout !== 'split' }
      const make = (overrides: Partial<ChannelUi> = {}) => channelWith({ minimalUi, ...overrides }, config)
      const rig = await mountStatus(make(), { fullscreen })
      const label = `${fullscreen ? 'fullscreen' : 'inline'}/${layout}`
      try {
        const baseline = mainRow(rig)
        check(`${label}: undefined current directory has no extra text row`,
          baseline.includes('workspace-app') && nonempty(rig).length === 1, rig.lines())
        if (layout === 'compact') {
          check(`${label}: main cwd is just the project name`,
            baseline.includes('workspace-app') && !baseline.includes('/w/'), baseline)
        }
        if (layout === 'split') check(`${label}: main cwd retains workspace path`, baseline.includes(WORKSPACE), baseline)

        await rig.rerender(make({
          workingDirectory: `${WORKSPACE}/src/leaf`,
          workingDirectoryGitBranch: WORKSPACE_BRANCH,
          workingDirectoryGitStatus: gitStatus(),
        }))
        const inside = currentRow(rig)
        check(`${label}: moving inside leaves workspace main row untouched`, mainRow(rig) === baseline, rig.lines())
        check(`${label}: current location owns the next right-aligned row`,
          inside.includes('leaf') && rightAligned(rig, inside) && nonempty(rig).length === 2, rig.lines())
        check(`${label}: same Git directory never repeats a branch`,
          !inside.includes(WORKSPACE_BRANCH) && !inside.includes('⧉'), inside)
        check(`${label}: ${minimalUi ? 'only the final directory name' : 'relative breadcrumb without workspace repetition'}`,
          minimalUi ? inside.trim().replace(/^[›→]\s*/u, '') === 'leaf' : inside.includes('›') && inside.includes('src/leaf') && !inside.includes('workspace-app'), inside)

        await rig.rerender(make({
          workingDirectory: '/other/repo',
          workingDirectoryGitBranch: CURRENT_BRANCH,
          workingDirectoryGitStatus: gitStatus({ branch: CURRENT_BRANCH, gitDir: '/other/repo/.git', ahead: 3, changed: 5 }),
        }))
        const outside = currentRow(rig)
        check(`${label}: other repository never changes workspace branch/status`, mainRow(rig) === baseline, rig.lines())
        check(`${label}: other repository ${minimalUi ? 'still shows only the leaf' : 'shows its own branch and status'}`,
          minimalUi
            ? outside.trim().replace(/^[›→]\s*/u, '') === 'repo'
            : outside.includes('→') && outside.includes('/other/repo') && outside.includes(CURRENT_BRANCH)
              && outside.includes('↑3') && outside.includes('●5') && !outside.includes(WORKSPACE_BRANCH), outside)

        // Backend may still hold a Git snapshot while cwd returns; path equality
        // alone must retract the whole reminder and its current-only branch.
        await rig.rerender(make({
          workingDirectory: WORKSPACE,
          workingDirectoryGitBranch: CURRENT_BRANCH,
          workingDirectoryGitStatus: gitStatus({ branch: CURRENT_BRANCH, gitDir: '/other/repo/.git' }),
        }))
        check(`${label}: equal directory removes stale location/branch`,
          mainRow(rig) === baseline && nonempty(rig).length === 1 && !rig.lines().some(line => line.includes(CURRENT_BRANCH)), rig.lines())

        await rig.rerender(make({ workingDirectory: `${WORKSPACE}/src/back-again` }))
        await rig.rerender(make())
        check(`${label}: undefined after a move removes the reminder`,
          mainRow(rig) === baseline && nonempty(rig).length === 1 && !rig.lines().some(line => line.includes('back-again')), rig.lines())
      } finally {
        await rig.close()
      }
    }
  }

  // Git directory identity, NOT branch names or workspace ownership, decides
  // whether the current checkout needs a separate branch readout.
  const branchCases = [
    { name: 'same gitDir, different branch label', workspaceStatus: gitStatus(), currentStatus: gitStatus({ branch: CURRENT_BRANCH }), showBranch: false, linked: false },
    { name: 'linked worktree', workspaceStatus: gitStatus(), currentStatus: gitStatus({ branch: CURRENT_BRANCH, gitDir: `${WORKSPACE_GIT_DIR}/worktrees/try`, isLinkedWorktree: true }), showBranch: true, linked: true },
    { name: 'ordinary other repository', workspaceStatus: gitStatus(), currentStatus: gitStatus({ branch: CURRENT_BRANCH, gitDir: '/else/.git' }), showBranch: true, linked: false },
    { name: 'missing workspace gitDir', workspaceStatus: gitStatus({ gitDir: undefined }), currentStatus: gitStatus({ branch: CURRENT_BRANCH, gitDir: '/else/.git' }), showBranch: false, linked: false },
    { name: 'missing current gitDir', workspaceStatus: gitStatus(), currentStatus: gitStatus({ branch: CURRENT_BRANCH, gitDir: undefined }), showBranch: false, linked: false },
    { name: 'non-Git directory', workspaceStatus: gitStatus(), currentStatus: undefined, showBranch: false, linked: false },
  ]
  for (const scenario of branchCases) {
    const rig = await mountStatus(channelWith({
      workingDirectory: '/else/checkout',
      gitStatus: scenario.workspaceStatus,
      workingDirectoryGitBranch: scenario.currentStatus === undefined ? undefined : CURRENT_BRANCH,
      workingDirectoryGitStatus: scenario.currentStatus,
    }))
    try {
      const row = currentRow(rig)
      check(`${scenario.name}: location remains visible`, row.includes('/else/checkout'), rig.lines())
      check(`${scenario.name}: branch requires two known different gitDirs`, row.includes(CURRENT_BRANCH) === scenario.showBranch, row)
      check(`${scenario.name}: worktree mark follows current snapshot`, row.includes('⧉') === scenario.linked, row)
    } finally {
      await rig.close()
    }
  }
  {
    const rig = await mountStatus(channelWith({
      workingDirectory: '/else/same-name',
      workingDirectoryGitBranch: WORKSPACE_BRANCH,
      workingDirectoryGitStatus: gitStatus({ gitDir: '/else/.git' }),
    }))
    try {
      check('different gitDir with identical branch names still shows current branch',
        mainRow(rig).includes(WORKSPACE_BRANCH) && currentRow(rig).includes(WORKSPACE_BRANCH), rig.lines())
    } finally {
      await rig.close()
    }
  }

  for (const cwd of [false, true]) {
    for (const gitBranch of [false, true]) {
      const rig = await mountStatus(channelWith({
        workingDirectory: '/other/checkout',
        workingDirectoryGitBranch: CURRENT_BRANCH,
        workingDirectoryGitStatus: gitStatus({ branch: CURRENT_BRANCH, gitDir: '/other/.git', isLinkedWorktree: true }),
      }, { cwd, gitBranch }))
      try {
        const row = currentRow(rig)
        check(`cwd=${cwd}/gitBranch=${gitBranch}: reminder ignores field switches`,
          row.includes('/other/checkout') && rightAligned(rig, row), rig.lines())
        check(`cwd=${cwd}/gitBranch=${gitBranch}: current branch respects gitBranch`,
          row.includes(CURRENT_BRANCH) === gitBranch, row)
        check(`cwd=${cwd}/gitBranch=${gitBranch}: workspace switches remain effective`,
          mainRow(rig).includes('workspace-app') === cwd && mainRow(rig).includes(WORKSPACE_BRANCH) === gitBranch, mainRow(rig))
      } finally {
        await rig.close()
      }
    }
  }

  // A sibling whose name shares the workspace prefix is outside, not relative.
  for (const [name, target, marker, expected] of [
    ['home folding', join(fakeHome, 'other/leaf'), '→', '~/other/leaf'],
    ['outside home', '/external/leaf', '→', '/external/leaf'],
    ['prefix sibling', `${WORKSPACE}lication/leaf`, '→', `${WORKSPACE}lication/leaf`],
  ] as const) {
    const rig = await mountStatus(channelWith({ workingDirectory: target }))
    try {
      const row = currentRow(rig)
      check(`${name}: correct marker and target`, row.includes(marker) && row.includes(expected), row)
    } finally {
      await rig.close()
    }
  }

  for (const compact of [false, true]) {
    const displayCwd = 'ssh://dev/home/remote-project'
    const rig = await mountStatus(channelWith({ displayCwd }, { compact }))
    try {
      const baseline = mainRow(rig)
      check(`remote compact=${compact}: workspace uses provider display path`,
        baseline.includes(compact ? 'remote-project' : displayCwd) && !baseline.includes(WORKSPACE), baseline)
      await rig.rerender(channelWith({ displayCwd, workingDirectory: '/remote/tmp/leaf' }, { compact }))
      check(`remote compact=${compact}: moving retains display path and independent current row`,
        mainRow(rig) === baseline && currentRow(rig).includes('/remote/tmp/leaf'), rig.lines())
    } finally {
      await rig.close()
    }
  }

  const leaf = '叶子e\u0301🙂'
  for (const fullscreen of [false, true]) {
    for (const compact of [false, true]) {
      const target = `${WORKSPACE}/${'nested/'.repeat(12)}${leaf}`
      const rig = await mountStatus(channelWith({
        workingDirectory: target,
        workingDirectoryGitBranch: 'feature/' + 'long-branch-'.repeat(8),
        workingDirectoryGitStatus: gitStatus({ gitDir: `${WORKSPACE_GIT_DIR}/worktrees/narrow`, isLinkedWorktree: true }),
      }, { compact }), { columns: 120, fullscreen })
      try {
        for (const columns of [60, 40, 30, 20, 120]) {
          await rig.resize(columns)
          const visible = nonempty(rig)
          const location = visible.find(line => line.includes(leaf)) ?? ''
          check(`narrow ${fullscreen ? 'fullscreen' : 'inline'}/${compact ? 'compact' : 'split'}/${columns}: leaf survives without wrapping`,
            location.includes('›') && rightAligned(rig, location) && visible.length === 2
              && visible.every(line => stringWidth(line) <= columns), rig.lines())
          if (columns === 120) check('resize restores full workspace main fields',
            mainRow(rig).includes(WORKSPACE_BRANCH) && mainRow(rig).includes('workspace-app'), rig.lines())
        }
      } finally {
        await rig.close()
      }
    }
  }

  // The current row is between main fields and the permanent supplemental
  // hint/detail/wake row. Every hover must preserve both location and wake.
  {
    const target = `${WORKSPACE}/src/hoverleaf`
    const wake: NonNullable<StatusProps['wake']> = {
      band: {
        buckets: [{ weight: 1, count: 1, channels: { input: 1, model: 0, tool: 0 }, error: false, retry: false, running: false, firstIndex: 0 }],
        peak: 1,
        floor: 0,
        turns: [],
      },
      hint: 'WAKEKEY',
    }
    const make = (workingDirectory: string | undefined) => channelWith({
      workingDirectory,
      workingDirectoryGitBranch: CURRENT_BRANCH,
      workingDirectoryGitStatus: gitStatus({ branch: CURRENT_BRANCH, gitDir: `${WORKSPACE_GIT_DIR}/worktrees/hover`, isLinkedWorktree: true, ahead: 3, changed: 5 }),
    }, { shortcutHint: true, trajectory: true })
    const rig = await mountStatus(make(undefined), { props: { wake } })
    try {
      const mainAt = mainIndex(rig)
      const idleTrailer = rig.lines()[mainAt + 1] ?? ''
      check('idle supplemental row contains both shortcut hint and wake',
        idleTrailer.includes('? 查看快捷键') && idleTrailer.includes('WAKEKEY'), rig.lines())
      await rig.rerender(make(target))
      const location = currentRow(rig)
      check('current directory inserts its own row before hint/wake',
        location.includes('src/hoverleaf') && rig.lines()[mainAt + 2] === idleTrailer, rig.lines())
      check('workspace cwd hover target exists', rig.hover('workspace-app'))
      check('workspace cwd hover remains anchored to workspace', await settled(() => {
        const detail = rig.lines()[mainAt + 2] ?? ''
        return detail.includes(`workspace ${WORKSPACE}`) && !detail.includes('/src/hoverleaf') && detail.includes('WAKEKEY')
      }), rig.lines())
      check('workspace cwd hover does not replace/reposition current', currentRow(rig) === location, rig.lines())
      check('workspace Git hover target exists', rig.hover(WORKSPACE_BRANCH))
      check('workspace Git hover keeps workspace branch', await settled(() => {
        const detail = rig.lines()[mainAt + 2] ?? ''
        return detail.includes(`git ${WORKSPACE_BRANCH}`) && detail.includes(WORKSPACE)
          && !detail.includes(CURRENT_BRANCH) && detail.includes('WAKEKEY')
      }), rig.lines())
      check('current directory has its own hover target', rig.hover('src/hoverleaf'))
      check('current hover reveals its independent absolute target', await settled(() => {
        const detail = rig.lines()[mainAt + 2] ?? ''
        return detail.includes(target) && detail.includes(`⧉${CURRENT_BRANCH}`)
          && detail.includes('↑3') && detail.includes('●5') && !detail.includes(WORKSPACE_BRANCH) && detail.includes('WAKEKEY')
      }), rig.lines())
      check('current hover keeps the independent row right-aligned',
        currentRow(rig) === location && rightAligned(rig, location), rig.lines())
      await rig.rerender(make(WORKSPACE))
      check('return while hovered removes location and stale current detail, preserving hint/wake',
        rig.lines()[mainAt + 1] === idleTrailer && nonempty(rig).length === 2
          && !rig.lines().some(line => line.includes('hoverleaf')), rig.lines())
    } finally {
      await rig.close()
    }
  }

  // The information panel must keep two independent location records too,
  // even when the footer's field switches are disabled.
  {
    const [{ InfoPanel }, { SidePanelRuntimeContext, PanelContext }] = await Promise.all([
      import('../src/components/sidePanel/InfoPanel.js'),
      import('../src/components/sidePanel/SidePanelRuntimeContext.js'),
    ])
    const runtime = { registerInput: () => () => {}, dispatchKey: () => false }
    const make = (overrides: Partial<ChannelUi> = {}) => channelWith({
      sessionTitle: 'LOCATION-INFO', sessionId: 'abcdef0123456789', status: 'idle', ...overrides,
    }, { cwd: false, gitBranch: false })
    const rig = await mountStatus(make(), {
      columns: 120,
      rows: 40,
      renderContent: channel => React.createElement(SidePanelRuntimeContext.Provider,
        { value: { runtime, channel: channel as ChannelUi } },
        React.createElement(PanelContext.Provider, { value: { panelId: 'info' } },
          React.createElement(InfoPanel, { width: 120, height: 38, focused: false, visible: true, mode: 'split' }),
        ),
      ),
    })
    const row = (label: string): string => (rig.lines().find(line => line.trimStart().startsWith(label)) ?? '').trimEnd()
    try {
      const workspaceCwd = row('会话工作区')
      const workspaceBranch = row('工作区分支')
      check('InfoPanel: workspace rows are visible despite footer switches',
        workspaceCwd.includes(WORKSPACE) && workspaceBranch.includes(WORKSPACE_BRANCH)
          && workspaceBranch.includes('↑1') && workspaceBranch.includes('●1'), rig.lines())
      check('InfoPanel: undefined current directory has no current rows',
        row('当前目录') === '' && row('当前分支') === '', rig.lines())
      await rig.rerender(make({
        workingDirectory: '/other/worktree',
        workingDirectoryGitBranch: CURRENT_BRANCH,
        workingDirectoryGitStatus: gitStatus({ branch: CURRENT_BRANCH, gitDir: `${WORKSPACE_GIT_DIR}/worktrees/other`, isLinkedWorktree: true, ahead: 3, changed: 5 }),
      }))
      check('InfoPanel: move preserves both workspace rows unchanged',
        row('会话工作区') === workspaceCwd && row('工作区分支') === workspaceBranch, rig.lines())
      check('InfoPanel: current directory and linked-worktree branch have separate rows',
        row('当前目录').includes('/other/worktree') && row('当前分支').includes(`⧉${CURRENT_BRANCH}`)
          && row('当前分支').includes('↑3') && row('当前分支').includes('●5'), rig.lines())
      await rig.rerender(make({ workingDirectory: join(fakeHome, 'non-git') }))
      check('InfoPanel: non-Git current directory keeps its row and no stale branch',
        row('当前目录').includes('~/non-git') && row('当前分支').includes('—')
          && !rig.lines().some(line => line.includes(CURRENT_BRANCH))
          && row('工作区分支') === workspaceBranch, rig.lines())
      await rig.rerender(make({
        workingDirectory: WORKSPACE,
        workingDirectoryGitBranch: CURRENT_BRANCH,
        workingDirectoryGitStatus: gitStatus({ branch: CURRENT_BRANCH, gitDir: '/stale/.git' }),
      }))
      check('InfoPanel: returning to workspace retracts current rows and stale Git',
        row('当前目录') === '' && row('当前分支') === ''
          && row('会话工作区') === workspaceCwd && row('工作区分支') === workspaceBranch, rig.lines())
      await rig.rerender(make({ displayCwd: 'ssh://dev/home/remote-project', workingDirectory: '/remote/leaf' }))
      check('InfoPanel: remote workspace display and current path remain independent',
        row('会话工作区').includes('ssh://dev/home/remote-project') && row('当前目录').includes('/remote/leaf'), rig.lines())
      await rig.rerender(make())
      check('InfoPanel: reset to undefined removes current rows',
        row('当前目录') === '' && row('当前分支') === '' && row('会话工作区') === workspaceCwd, rig.lines())
    } finally {
      await rig.close()
    }
  }
} catch (error) {
  failures += 1
  console.error(error)
}

console.log(`\n${checks - failures}/${checks} status-location checks passed`)
process.exitCode = failures === 0 ? 0 : 1
