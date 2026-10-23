/**
 * Shared Chat footer regression through the real Chat + PageMargin + Ink tree.
 * The split/zoom row stops at the prompt replacement's bottom; StatusLine owns
 * the entire content width below it. Checks painted terminal cells as well as
 * rendered DOM geometry, the final └/horizontal-rule pixels and hint row,
 * dynamic chrome heights and the composer lifetime.
 *
 * Run: node --import tsx/esm scripts/verify-shared-footer-layout.tsx
 */
export {}
import './lib/fake-home.mjs'
import type { DOMElement, DOMNode } from '../src/ink/dom.js'
import type { CachedLayout } from '../src/ink/node-cache.js'
import type { StatusBarConfig } from '../src/tuiDisplayPrefs.js'

process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'
process.env.DSH_TUI_THEME = 'dark'
// Owner chains let the probe inspect the actual component roots without
// adding test IDs or recreating the product's height arithmetic in the test.
process.env.DSH_TUI_DEBUG_REPAINTS = '1'
process.env.SSH_CONNECTION = 'headless-test'
delete process.env.TMUX

const [
  assert, { PassThrough, Writable }, React, { Terminal }, ui,
  { PageMargin }, { Chat }, { QuestionStore }, { ApprovalStore }, prefs,
  { default: instances }, { nodeCache }, { setMinimalUiMode }, termTest,
] = await Promise.all([
  import('node:assert/strict'),
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/PageMargin.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/dsh-adapter/approvals.js'),
  import('../src/tuiDisplayPrefs.js'),
  import('../src/ink/instances.js'),
  import('../src/ink/node-cache.js'),
  import('../src/minimalUiMode.js'),
  import('./lib/term-test.mjs'),
])
const { createRoot, AlternateScreen, ThemeProvider } = ui
const { settled, viewportLines } = termTest
const ROWS = 38
const INSET_X = 2
const INSET_Y = 1
const MODEL = 'FOOTER_MODEL'
const CWD = '/tmp/FOOTER_DIRECTORY'
const DRAFT = 'DRAFT_SURVIVES_SHARED_FOOTER'

function check(name: string, condition: unknown, detail = ''): asserts condition {
  assert.default.ok(condition, name + (detail ? '\n' + detail : ''))
  console.log('PASS: ' + name)
}

function allNodes(root: DOMElement): DOMElement[] {
  const result: DOMElement[] = []
  const walk = (node: DOMNode): void => {
    if (node.nodeName === '#text') return
    result.push(node)
    for (const child of node.childNodes) walk(child)
  }
  walk(root)
  return result
}

function makeChannel() {
  const listeners = new Set<() => void>()
  const submitted: string[] = []
  const channel = {
    version: 0,
    rows: [
      { id: 1, kind: 'user', text: 'TRANSCRIPT_ANCHOR' },
      { id: 2, kind: 'assistant', text: 'A short answer keeps room for a multi-line composer.', time: 1_700_000_000_000 },
    ],
    status: 'idle', working: false, whale: false, whaleIdle: false,
    sessionTitle: 'shared-footer', sessionId: 'shared-footer-session', agentId: 'shared-footer-agent',
    model: MODEL, provider: 'fixture', reasoningEffort: 'high', mode: { plan: false }, modeIndex: 0,
    tokens: { input: 40_000, output: 25, cacheRead: 0, cacheWrite: 0 },
    lastUsage: { input: 40_000, output: 25, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000,
    contextBarEnabled: true,
    contextSegments: { system: 4_000, prompt: 20_000, assistant: 6_000, thinking: 2_000, tools: 8_000 },
    cwd: CWD, displayCwd: CWD, gitBranch: 'main', minimalUi: false,
    statusBar: {
      ...prefs.DEFAULT_STATUS_BAR, compact: true, shortcutHint: true,
      thinking: false, cache: false, cost: false, contextUsage: true,
    } as StatusBarConfig,
    pending: [], commandList: [], notifications: [], todos: [], subagents: [], backgroundJobs: [],
    scrollGutter: 'hidden', launchpad: false,
    spinnerMode: 'requesting', responseChars: 0, activeToolCount: 0, turnStart: 0, lastUserText: '',
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    emit() { channel.version += 1; for (const listener of listeners) listener() },
    submit: (text: string) => { submitted.push(text) },
    cancel: () => {}, clear: () => {}, steer: () => {}, notify: () => {},
    interruptAndDeliver: () => 0, removePending: () => true, cycleMode: async () => {},
    listFiles: async () => [], listModels: async () => [], listProviders: async () => [], listSessions: () => [],
    setResumeTarget: () => {}, loadOlder: () => {}, mcpStatus: () => [],
    listWorkspaceRegistry: async () => [],
  }
  return { channel, submitted }
}

async function mount({ columns = 144, fullscreen = true } = {}) {
  prefs.applyPageMargin('normal')
  prefs.applySidePanelSplitEnabled(true)
  prefs.applySidePanelPanels('todo')
  prefs.applySidePanelRatio(0.68)
  prefs.applySidePanelOpen(true)
  setMinimalUiMode(false)
  const term = new Terminal({ cols: columns, rows: ROWS, scrollback: 200, allowProposedApi: true })
  let painted = Promise.resolve()
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      painted = painted.then(() => new Promise<void>(resolve => term.write(String(chunk), resolve)))
      callback()
    },
  }) as NodeJS.WriteStream
  Object.assign(stdout, { isTTY: true, columns, rows: ROWS })
  const stderr = new Writable({ write(_chunk, _encoding, callback) { callback() } }) as NodeJS.WriteStream
  const stdin = new PassThrough() as NodeJS.ReadStream
  Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, setEncoding: () => stdin, ref: () => stdin, unref: () => stdin })
  const questions = new QuestionStore()
  const approvals = new ApprovalStore()
  const { channel, submitted } = makeChannel()
  const previousInk = instances.get(process.stdout)
  const app = await createRoot({ stdout, stderr, stdin, patchConsole: false, exitOnCtrlC: false, terminalImages: false })
  const ink = instances.get(stdout)
  check('fixture mounts a real Ink instance', ink !== undefined)
  instances.set(process.stdout, ink)
  const domRoot = (ink as unknown as { rootNode: DOMElement }).rootNode
  const body = (
    <ThemeProvider theme="dark"><PageMargin>
      <Chat fullscreen={fullscreen} channel={channel as unknown as React.ComponentProps<typeof Chat>['channel']}
        questionStore={questions} approvalStore={approvals} onExit={() => {}} />
    </PageMargin></ThemeProvider>
  )
  app.render(fullscreen ? <AlternateScreen>{body}</AlternateScreen> : body)
  const flush = async (): Promise<void> => { ink.renderNow(); await painted }
  const rect = (name: string): CachedLayout | undefined => {
    const owns = (node: DOMElement | undefined): boolean => node?.debugOwnerChain?.includes(name) === true
    const node = allNodes(domRoot).find(node => owns(node) && !owns(node.parentNode))
    return node === undefined ? undefined : nodeCache.get(node)
  }
  const lines = (): string[] => viewportLines(term)
  const rowOf = (text: string): number => lines().findIndex(line => line.includes(text))
  const point = (text: string, firstRow = 0): { col: number; row: number } | undefined => {
    const row = lines().findIndex((line, row) => row >= firstRow && line.includes(text))
    return row < 0 ? undefined : { row, col: lines()[row]!.indexOf(text) }
  }
  const cell = (col: number, row: number): string =>
    term.buffer.active.getLine(term.buffer.active.baseY + row)?.getCell(col)?.getChars() ?? ''
  const snapshot = (): string => lines().map((line, row) => `${row}: ${line}`).join('\n')
  const layout = () => ({
    footer: rect('StatusLine'), side: rect('SidePanelColumn'), divider: rect('DividerColumn'), prompt: rect('PromptInput'),
    replacement: rect('ApprovalPanel') ?? rect('AskUserQuestionPanel'),
  })
  const assertShared = async (label: string, split = true): Promise<ReturnType<typeof layout>> => {
    check(label + ': measured footer owns the complete content width', await settled(() => rect('StatusLine')?.width === stdout.columns - INSET_X * 2), snapshot())
    check(label + ': split state settled', await settled(() => (rect('SidePanelColumn') !== undefined && rect('DividerColumn') !== undefined) === split), snapshot())
    await flush()
    const geometry = layout()
    check(label + ': footer begins inside the page margin', geometry.footer?.x === INSET_X, JSON.stringify(geometry))
    check(label + ': footer ends above the bottom page margin', geometry.footer !== undefined && geometry.footer.y + geometry.footer.height <= ROWS - INSET_Y, JSON.stringify(geometry))
    const model = point(MODEL, geometry.footer!.y)
    check(label + ': terminal painted the footer model', model !== undefined, snapshot())
    if (split) {
      check(label + ': sidebar and divider are measured', geometry.side !== undefined && geometry.divider !== undefined, JSON.stringify(geometry))
      const footer = geometry.footer!
      check(label + ': footer is wider than the chat column', footer.width > geometry.divider.x - INSET_X, JSON.stringify(geometry))
      check(label + ': sidebar bottom meets the footer top', geometry.side.y + geometry.side.height === footer.y, JSON.stringify(geometry))
      check(label + ': divider bottom meets the footer top', geometry.divider.y + geometry.divider.height === footer.y, JSON.stringify(geometry))
      const hints = lines().map((line, row) => ({ line, row })).filter(({ line }) => line.includes('Ctrl+B') || line.includes('Esc chat'))
      check(label + ': side hint is above the footer', hints.some(({ row }) => row < footer.y), snapshot())
      check(label + ': side hint never appears inside the footer', hints.every(({ row }) => row < footer.y), snapshot())
      const closingRow = footer.y - 1
      const hintRow = footer.y - 2
      check(label + ': closing seam is └ immediately above the footer', cell(geometry.divider.x, closingRow) === '└', snapshot())
      const closingRule = Array.from({ length: geometry.side.width }, (_, col) => cell(geometry.side.x + col, closingRow)).join('')
      check(label + ': sidebar final row is a continuous horizontal rule', closingRule.length === geometry.side.width && /^─+$/.test(closingRule), JSON.stringify(closingRule))
      check(label + ': sidebar closing rule contains no hint', !hints.some(({ row }) => row === closingRow), snapshot())
      check(label + ': side hint is exactly one row above the closing rule', hints.some(({ row }) => row === hintRow), snapshot())
      for (let row = footer.y; row < footer.y + footer.height; row += 1) {
        const char = cell(geometry.divider.x, row)
        check(label + `: no divider glyph on footer row ${row}`, char !== '│' && char !== '├' && char !== '└', snapshot())
      }
      const input = geometry.replacement ?? geometry.prompt
      check(label + ': prompt or replacement bottom meets the sidebar bottom', input !== undefined && input.height > 0 && input.y + input.height === footer.y, JSON.stringify(geometry))
    } else {
      check(label + ': no sidebar is painted', geometry.side === undefined && geometry.divider === undefined, JSON.stringify(geometry))
    }
    return geometry
  }
  await flush()
  check('fixture reached a painted Chat footer', await settled(() => rowOf(MODEL) >= 0), snapshot())
  return {
    app, ink, stdout, stdin, term, channel, submitted, questions, approvals,
    flush, rect, layout, lines, rowOf, point, snapshot, assertShared,
    async resize(width: number) {
      term.resize(width, ROWS); stdout.columns = width; stdout.emit('resize')
      await flush()
    },
    async close() {
      questions.cancelCurrent()
      approvals.settleAll('cancelled')
      app.unmount()
      await painted
      term.dispose()
      if (previousInk) instances.set(process.stdout, previousInk)
      else instances.delete(process.stdout)
      setMinimalUiMode(false)
    },
  }
}

let failures = 0
async function verify(name: string, test: () => Promise<void>): Promise<void> {
  try { await test(); console.log('PASS SCENARIO: ' + name) }
  catch (error) { failures += 1; console.error('FAIL SCENARIO: ' + name, error) }
}

await verify('split and zoom share the full-width context bar and fields', async () => {
  const f = await mount()
  try {
    let geometry = await f.assertShared('split')
    const bar = f.point('40k/100k')
    check('context readout reaches right of the old divider', bar !== undefined && bar.col > geometry.divider!.x, f.snapshot())
    const ctx = f.point('ctx ')
    check('status context field reaches right of the old divider', ctx !== undefined && ctx.col > geometry.divider!.x, f.snapshot())
    const footer = geometry.footer!
    f.stdin.write(`\x1b[<35;${ctx.col + 1};${ctx.row + 1}M`)
    check('hovering a footer field under the former sidebar shows its own detail', await settled(() => f.lines()[footer.y + footer.height - 1]?.includes('free ') === true), f.snapshot())
    check('footer hover does not resize or enter the sidebar', f.rect('StatusLine')?.height === footer.height && f.rect('SidePanelColumn')!.y + f.rect('SidePanelColumn')!.height === footer.y, JSON.stringify(f.layout()))
    f.stdin.write('\x1b[<35;4;20M')
    check('leaving the footer restores the common hint', await settled(() => f.lines()[footer.y + footer.height - 1]?.includes('? for shortcuts') === true), f.snapshot())
    f.stdin.write('\x02') // Pre-opened sidebar: Ctrl+B focuses it.
    check('sidebar focus hint replaces its unfocused hint', await settled(() => f.lines().some(line => line.includes('Esc chat'))), f.snapshot())
    f.stdin.write('z')
    check('zoom really narrows the left column', await settled(() => (f.rect('DividerColumn')?.x ?? Infinity) < geometry.divider!.x), f.snapshot())
    geometry = await f.assertShared('zoom')
    check('zoom context readout is still in the former sidebar columns', (f.point('40k/100k')?.col ?? -1) > geometry.divider!.x, f.snapshot())
    const model = f.point(MODEL, geometry.footer!.y)!
    f.stdin.write(`\x1b[<0;${model.col + 1};${model.row + 1}M\x1b[<0;${model.col + 1};${model.row + 1}m`)
    check('clicking the shared footer returns keyboard focus to chat', await settled(() => f.lines().some(line => line.includes('Ctrl+B focus panel'))), f.snapshot())
    check('clicking the footer model opens its existing picker', await settled(() => f.rect('ModelPicker') !== undefined), f.snapshot())
    f.stdin.write('\x1b')
    check('Escape closes only the model picker', await settled(() => f.rect('ModelPicker') === undefined), f.snapshot())
    f.stdin.write('FOOTER_CLICK_DRAFT')
    check('typing after the footer click reaches the composer', await settled(() => f.rowOf('FOOTER_CLICK_DRAFT') >= 0), f.snapshot())
  } finally { await f.close() }
})

await verify('multi-line draft and prompt replacements preserve the shared boundary', async () => {
  const f = await mount()
  try {
    const initial = await f.assertShared('single-line')
    f.stdin.write(`\x1b[200~${DRAFT}\nSECOND_DRAFT_LINE\nTHIRD_DRAFT_LINE\x1b[201~`)
    check('pasted draft is visible in the real composer', await settled(() => f.rowOf('THIRD_DRAFT_LINE') >= 0), f.snapshot())
    const multi = await f.assertShared('multi-line')
    check('multi-line input grows without changing footer height', multi.prompt!.height > initial.prompt!.height && multi.footer!.height === initial.footer!.height, JSON.stringify({ initial, multi }))
    const ask = f.questions.ask({ questions: [{ id: 'shared-question', header: 'FOOTER_QUESTION', question: 'Choose an item?', options: [{ label: 'One', description: 'First item' }, { label: 'Two', description: 'Second item' }] }] }).catch(() => undefined)
    check('question replaces the composer', await settled(() => f.rowOf('FOOTER_QUESTION') >= 0), f.snapshot())
    await f.assertShared('question')
    f.questions.answerCurrent({ selected: ['One'] })
    await ask
    check('answering restores the exact multi-line draft', await settled(() => f.rowOf(DRAFT) >= 0 && f.rowOf('THIRD_DRAFT_LINE') >= 0), f.snapshot())
    const approval = f.approvals.park({
      agent: { id: 'shared-footer-agent', session: { events: [{ type: 'tool/call', seq: 1, time: 0, data: { turn: 0, step: 0, callId: 'footer-approval', name: 'Bash', arguments: JSON.stringify({ command: 'echo FOOTER_APPROVAL' }) } }] } },
      toolName: 'Bash', callId: 'footer-approval', reason: 'FOOTER_APPROVAL',
    } as never)
    check('approval replaces the composer', await settled(() => f.rowOf('FOOTER_APPROVAL') >= 0), f.snapshot())
    await f.assertShared('approval')
    f.approvals.decide('rejected')
    await approval
    check('rejecting approval restores the original draft', await settled(() => f.rowOf(DRAFT) >= 0 && f.rowOf('THIRD_DRAFT_LINE') >= 0), f.snapshot())
  } finally { await f.close() }
})

await verify('footer preference heights are measured, not fixed', async () => {
  const f = await mount()
  try {
    const barOn = await f.assertShared('context-bar on')
    f.channel.statusBar = { ...f.channel.statusBar, contextBar: false }
    f.channel.emit()
    check('hiding context bar reclaims its measured row', await settled(() => f.rect('StatusLine')?.height === barOn.footer!.height - 1), f.snapshot())
    const barOff = await f.assertShared('context-bar off')
    f.channel.statusBar = { ...f.channel.statusBar, compact: false }
    f.channel.emit()
    await f.assertShared('noncompact')
    f.channel.minimalUi = true
    setMinimalUiMode(true)
    f.channel.emit()
    check('minimal footer drops the supplemental row', await settled(() => (f.rect('StatusLine')?.height ?? Infinity) < barOff.footer!.height), f.snapshot())
    await f.assertShared('minimal')
    f.channel.minimalUi = false
    setMinimalUiMode(false)
    f.channel.statusBar = { ...f.channel.statusBar, compact: true, contextBar: true }
    f.channel.emit()
    check('restoring preferences restores the measured footer height', await settled(() => f.rect('StatusLine')?.height === barOn.footer!.height), f.snapshot())
    await f.assertShared('restored footer')
  } finally { await f.close() }
})

await verify('open close narrow and restored layouts retain one draft', async () => {
  const f = await mount()
  try {
    f.stdin.write(DRAFT)
    check('draft is visible before sidebar toggles', await settled(() => f.rowOf(DRAFT) >= 0), f.snapshot())
    prefs.applySidePanelOpen(false)
    await f.assertShared('collapsed', false)
    check('closing preserves the draft', f.rowOf(DRAFT) >= 0, f.snapshot())
    prefs.applySidePanelOpen(true)
    await f.assertShared('reopened')
    check('reopening preserves the draft', f.rowOf(DRAFT) >= 0, f.snapshot())
    await f.resize(80)
    await f.assertShared('narrow fullscreen', false)
    check('narrow fallback preserves the draft', f.rowOf(DRAFT) >= 0, f.snapshot())
    await f.resize(144)
    await f.assertShared('wide restored')
    check('wide restore preserves the draft', f.rowOf(DRAFT) >= 0, f.snapshot())
    f.stdin.write('\r')
    check('retained draft submits once unchanged', await settled(() => f.submitted.length === 1 && f.submitted[0] === DRAFT), JSON.stringify(f.submitted))
  } finally { await f.close() }
})

await verify('inline remains unsplit and keeps its composer draft', async () => {
  const f = await mount({ fullscreen: false })
  try {
    f.stdin.write(DRAFT)
    check('inline draft is visible', await settled(() => f.rowOf(DRAFT) >= 0), f.snapshot())
    await f.assertShared('inline', false)
    f.stdin.write('\x02')
    check('inline sidebar shortcut does not discard the draft', await settled(() => f.rowOf(DRAFT) >= 0), f.snapshot())
    check('inline has no sidebar after shortcut', f.rect('SidePanelColumn') === undefined, f.snapshot())
    f.stdin.write('\r')
    check('inline draft submits exactly once', await settled(() => f.submitted.length === 1 && f.submitted[0] === DRAFT), JSON.stringify(f.submitted))
    check('processed inline shortcut and submit never mounted a sidebar', f.rect('SidePanelColumn') === undefined && f.rect('DividerColumn') === undefined, f.snapshot())
  } finally { await f.close() }
})

console.log(failures === 0 ? '\nAll shared-footer layout checks passed.' : `\n${failures} shared-footer scenario(s) failed.`)
process.exitCode = failures === 0 ? 0 : 1
