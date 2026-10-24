/**
 * Side-panel mouse regression: the bar is the one place where a click
 * switches WHAT the whole right column shows, so it must be clickable, must
 * say so on hover, and the ⤢ fullscreen affordance must appear only for
 * panels that actually have a fullscreen form (capabilities.fullscreen).
 *
 * Locked behavior:
 *  a. text tabs retain their order and selection styling across focus changes;
 *  b. hovering/clicking text tabs works without confusing hover with selection;
 *  c. overflow arrows select start-1/end, while keyboard arrows still cycle;
 *  f. a clipped plugin title reveals its full text on hover; resize follows active;
 *  d. ⤢ calls the host with the active panel id;
 *  e. clicking the chat column returns focus to chat.
 *
 * Run: node --import tsx/esm scripts/verify-side-panel-mouse.tsx
 */
export {}

process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, ui, { SidePanelLayout }, { SidePanelColumn }, { useSidePanel }, prefs, { TooltipLayer }, termTest] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/sidePanel/SidePanelLayout.js'),
  import('../src/components/sidePanel/SidePanelColumn.js'),
  import('../src/components/sidePanel/useSidePanel.js'),
  import('../src/tuiDisplayPrefs.js'),
  import('../src/components/Tooltip.js'),
  import('./lib/term-test.mjs'),
])
const { render, AlternateScreen, ThemeProvider, Box, Text, useInput, useTerminalSize } = ui
const [{ panelStore }, { stringWidth }] = await Promise.all([
  import('../src/components/sidePanel/PanelStore.js'),
  import('../src/ink/stringWidth.js'),
])
const { applySidePanelOpen, applySidePanelPanels, applySidePanelRatio } = prefs
const { settled, viewportLines } = termTest

const COLS = 120
const ROWS = 20

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log((ok ? 'PASS' : 'FAIL') + ': ' + name + (extra ? '  (' + extra + ')' : ''))
  if (!ok) failed += 1
}

/** Host-side record of ⤢ clicks (mirrors Chat's openPanelFullscreen). */
let expanded: string[] = []

const channelStub: unknown = {
  version: 0, rows: [], status: 'idle', working: false, goal: undefined, todos: [], subagents: [],
  // jobs 摘要（length）/info 读数（notifications）/workspace 路径（displayCwd）
  backgroundJobs: [],
  notifications: [],
  displayCwd: '/tmp/demo',
  cwd: '/tmp/demo',
  // info 行读数经 status 助手派生（modeDisplayName 读 mode.label 等）——
  // 字段集照 verify-side-panel-registry 的桩（那里踩过同样的坑）。
  mode: { plan: false },
  sessionTitle: 'mouse',
  sessionId: 'abcd1234-5678-90ab-cdef-1234567890ab',
  agentId: 'mouse-agent',
  gitBranch: 'main',
  model: 'deepseek-chat-v4',
  reasoningEffort: 'high',
  tokens: { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  listWorkspaceRegistry: () => Promise.resolve([]),
  subscribe() { return () => {} },
  notify() {},
}

function Harness(): React.ReactNode {
  const { columns } = useTerminalSize()
  const sp = useSidePanel({ columns, fullscreen: true, editorOpen: false })
  // Mirror Chat's host fallback; plugin fixture panels register no own keys.
  useInput((input, key, event) => { sp.handleKey(input, key, event) }, { isActive: true })
  return (
    <SidePanelLayout
      geometry={sp.geometry}
      focus={sp.focus}
      onActivateChat={sp.focusChat}
      onActivatePanel={sp.focusPanel}
      onResize={sp.resize}
      side={
        <SidePanelColumn
          width={sp.panelColumns}
          controller={sp}
          channel={channelStub as never}
          onExpand={(id: string) => { expanded = [...expanded, id] }}
        />
      }
    >
      <Box flexDirection="column">
        <Text>{'chat-body'}</Text>
      </Box>
    </SidePanelLayout>
  )
}

class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  term: import('@xterm/headless').Terminal
  constructor(term: import('@xterm/headless').Terminal, cols?: number, rows?: number) {
    super()
    this.term = term
    if (cols !== undefined) this.columns = cols
    if (rows !== undefined) this.rows = rows
  }
  _write(chunk: unknown, _e: Buffer.Encoding, cb: () => void) { this.term.write(String(chunk), cb) }
}
class FakeStderr extends Writable { isTTY = true; _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() } }
class FakeStdin extends PassThrough {
  isTTY = true
  isRaw = false
  setRawMode(next: boolean) { this.isRaw = next; return this }
  setEncoding() { return this }
  ref() { return this }
  unref() { return this }
}

const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
const stdout = new FakeStdout(term)
const stdin = new FakeStdin()

const lines = (): string[] => viewportLines(term, ROWS)
const has = (s: string): boolean => lines().some(line => line.includes(s))
const findText = (s: string): { col: number; row: number } | null => {
  const view = lines()
  for (let row = 0; row < view.length; row++) {
    const col = view[row]!.indexOf(s)
    if (col >= 0) return { col: stringWidth(view[row]!.slice(0, col)), row }
  }
  return null
}
const boldAt = (col: number, row: number): boolean => {
  const buf = term.buffer.active
  return buf.getLine(buf.baseY + row)?.getCell(col)?.isBold() ?? false
}
// SGR 1-indexed。无按键移动 = 35（32 是「按住左键拖动」，别混）；
// press(0)/release(0) = 点击。
const motion = (c: number, r: number) => stdin.write('\x1b[<35;' + (c + 1) + ';' + (r + 1) + 'M')
const press = (c: number, r: number) => stdin.write('\x1b[<0;' + (c + 1) + ';' + (r + 1) + 'M')
const release = (c: number, r: number) => stdin.write('\x1b[<0;' + (c + 1) + ';' + (r + 1) + 'm')
const click = (c: number, r: number) => { press(c, r); release(c, r) }

applySidePanelRatio(0.68)
applySidePanelPanels('todo,jobs,agents')
applySidePanelOpen(true)

const app = await render(
  <AlternateScreen>
    <ThemeProvider theme="dark">
      <Harness />
      <TooltipLayer />
    </ThemeProvider>
  </AlternateScreen>,
  {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  },
)

try {
  check('a boot: text tabs appear in fixed order', await settled(() => /Todo\s+Jobs\s+Agents/.test(lines()[0] ?? '')))
  const bootRow = lines()[0] ?? ''
  const positions = ['Todo', 'Jobs', 'Agents'].map(title => bootRow.indexOf(title))
  check('a boot: fitting tabs show neither icons nor overflow arrows', !/[≡▸◆◀▶]/.test(bootRow), bootRow.trim())
  check('a boot: no ⤢ for a panel without a fullscreen form', !has('⤢'))

  const agentsTab = findText('Agents')
  check('b hover: Agents text located', agentsTab?.row === 0, JSON.stringify(agentsTab))
  if (agentsTab !== null) {
    const fg = () => term.buffer.active.getLine(agentsTab.row)?.getCell(agentsTab.col)?.getFgColor()
    const dim = fg()
    check('b hover: inactive text starts unbolded', !boldAt(agentsTab.col, agentsTab.row))
    motion(agentsTab.col + 2, agentsTab.row)
    check('b hover: inactive text brightens without becoming selected', await settled(() => fg() !== dim && !boldAt(agentsTab.col, agentsTab.row)))
    motion(5, 3)
    check('b hover: leaving restores inactive color', await settled(() => fg() === dim && !boldAt(agentsTab.col, agentsTab.row)))
    click(agentsTab.col + 3, agentsTab.row)
  }
  check('c click: text hit area selects Agents', await settled(() => agentsTab !== null && boldAt(agentsTab.col, agentsTab.row) && has('⤢')))
  check('c click: selection does not recenter the titles', JSON.stringify(positions) === JSON.stringify(['Todo', 'Jobs', 'Agents'].map(title => (lines()[0] ?? '').indexOf(title))))

  const expand = findText('⤢')
  check('d ⤢: independent button sits after text tabs', expand !== null && agentsTab !== null && expand.col > agentsTab.col + 'Agents'.length, JSON.stringify(expand))
  if (expand !== null) click(expand.col, expand.row)
  check('d ⤢: host received exactly the active panel id', await settled(() => expanded.length === 1 && expanded[0] === 'agents'), JSON.stringify(expanded))

  check('e focus: clicking a text tab focuses the panel', await settled(() => has('Esc chat')))
  const activeColor = agentsTab === null ? undefined : term.buffer.active.getLine(0)?.getCell(agentsTab.col)?.getFgColor()
  const body = findText('chat-body')
  check('e focus: chat body located', body !== null, JSON.stringify(body))
  if (body !== null) click(body.col, body.row)
  check('e focus: hint swaps back to the unfocused copy', await settled(() => has('Ctrl+B focus panel')))
  check('e focus: selection stays bold/accent while chat is focused', agentsTab !== null && boldAt(agentsTab.col, 0) && term.buffer.active.getLine(0)?.getCell(agentsTab.col)?.getFgColor() === activeColor)

  const todoTab = findText('Todo')
  if (todoTab !== null) click(todoTab.col + 1, todoTab.row)
  check('e capability: selecting Todo removes only fullscreen control', await settled(() => todoTab !== null && boldAt(todoTab.col, 0) && !has('⤢') && /Todo\s+Jobs\s+Agents/.test(lines()[0] ?? '')))
} finally {
  await app.unmount()
}

// ── f. real overflow fixture: hidden neighbors are NOT active neighbors ──
{
  const NARROW = 96
  const NROWS = 14
  const term2 = new XTerm({ cols: NARROW, rows: NROWS, scrollback: 0, allowProposedApi: true })
  const stdout2 = new FakeStdout(term2, NARROW, NROWS)
  const lines2 = (): string[] => viewportLines(term2, NROWS)
  const find2 = (text: string) => {
    const rows = lines2()
    for (let row = 0; row < rows.length; row++) {
      const index = rows[row]!.indexOf(text)
      if (index >= 0) return { row, col: stringWidth(rows[row]!.slice(0, index)) }
    }
    return null
  }
  const click2 = (text: string, offset = 0) => {
    const at = find2(text)
    check('f target located: ' + text, at !== null)
    if (at !== null) click(at.col + offset, at.row)
  }
  const ids = Array.from({ length: 8 }, (_, i) => 'regression:t' + i)
  const titles = ids.map((_, i) => 'T0' + i)
  const visible = () => titles.flatMap((title, i) => (lines2()[0] ?? '').includes(title) ? [i] : [])
  const selected = (i: number) => lines2().some(row => row.includes('panel:t' + i))
  const longTitle = 'Plugin observability dashboard / 计划👩‍💻状态😀 full details'
  const releases = ids.map((id, i) => panelStore.register({
    id, title: titles[i], icon: '◆', source: 'plugin', pluginId: 'regression',
    minColumns: 1, capabilities: { fullscreen: true },
    component: () => <Text>{'panel:t' + i}</Text>,
  }, { pluginId: 'regression' }))
  releases.push(panelStore.register({
    id: 'regression:long', title: longTitle, icon: '◆', source: 'plugin', pluginId: 'regression',
    minColumns: 1, capabilities: { fullscreen: true }, component: () => <Text>panel:long</Text>,
  }, { pluginId: 'regression' }))
  applySidePanelRatio(0.78)
  applySidePanelPanels(ids.join(','))
  const app2 = await render(
    <AlternateScreen>
      <ThemeProvider theme="dark"><Harness /><TooltipLayer /></ThemeProvider>
    </AlternateScreen>,
    {
      stdout: stdout2 as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  try {
    check('f boot: narrow fixture renders selected plugin through PanelHost', await settled(() => selected(0) && visible().length > 1 && (lines2()[0] ?? '').includes('⤢')))
    const first = visible()
    check('f boot: initial window has only right overflow', first[0] === 0 && first.length < ids.length && !(lines2()[0] ?? '').includes('◀') && (lines2()[0] ?? '').includes('▶'), JSON.stringify(lines2()[0]))
    const end = (first.at(-1) ?? -1) + 1
    check('f oracle: right hidden neighbor differs from active+1', end > 1, JSON.stringify(first))
    click2('▶')
    check('f right arrow: selects first hidden tab, not active+1', await settled(() => selected(end)), JSON.stringify(lines2()[0]))

    const middleWindow = visible()
    const middle = middleWindow[1] ?? -1
    check('f oracle: left hidden neighbor differs from active-1', middleWindow[0]! > 0 && middle > middleWindow[0]!, JSON.stringify(middleWindow))
    if (middle >= 0) click2(titles[middle]!, 1)
    check('f text click: selects visible tab without shifting window', await settled(() => selected(middle) && JSON.stringify(visible()) === JSON.stringify(middleWindow)), JSON.stringify(lines2()[0]))
    const previousHidden = middleWindow[0]! - 1
    click2('◀')
    check('f left arrow: selects start-1, not active-1', await settled(() => selected(previousHidden)), JSON.stringify(lines2()[0]))
    check('f left boundary: no left arrow or accidental wrap', previousHidden === 0 && !(lines2()[0] ?? '').includes('◀'))

    stdin.write('8')
    check('f keyboard: number selects the last registered tab', await settled(() => selected(7)))
    check('f last boundary: only left overflow remains', (lines2()[0] ?? '').includes('◀') && !(lines2()[0] ?? '').includes('▶'), JSON.stringify(lines2()[0]))
    stdin.write('\x1b[D')
    check('f keyboard: left selects active-1, not start-1', await settled(() => selected(6)))
    stdin.write('\x1b[C')
    check('f keyboard: right selects active+1 inside the window', await settled(() => selected(7)))
    stdin.write('\x1b[C')
    check('f keyboard: right still wraps last to first', await settled(() => selected(0)))
    stdin.write('\x1b[D')
    check('f keyboard: left still wraps first to last', await settled(() => selected(7)))

    const bodyRow = find2('panel:t7')?.row
    const rightInset = NARROW - (find2('⤢')?.col ?? 0)
    for (const width of [160, NARROW]) {
      stdout2.columns = width
      term2.resize(width, NROWS)
      stdout2.emit('resize')
      check('f resize ' + width + ': active, body row and fullscreen survive', await settled(() => selected(7) && (lines2()[0] ?? '').includes('T07') && find2('⤢')?.col === width - rightInset && find2('panel:t7')?.row === bodyRow && (lines2()[1] ?? '').includes('─')), JSON.stringify(lines2().slice(0, 3)))
    }

    applySidePanelPanels('regression:long')
    check('f long: single plugin title truncates with no overflow arrows', await settled(() => lines2().some(row => row.includes('panel:long')) && (lines2()[0] ?? '').includes('Plugin') && (lines2()[0] ?? '').includes('…') && !/[◀▶◆]/.test(lines2()[0] ?? '')))
    const clipped = find2('Plugin')
    if (clipped !== null) motion(clipped.col + 4, clipped.row)
    check('f hover: full English/CJK/emoji title is actually rendered', await settled(() => lines2().some(row => row.includes(longTitle))))
    motion(5, 4)
    check('f hover leave: tooltip disappears without moving the panel body', await settled(() => !lines2().some(row => row.includes(longTitle)) && find2('panel:long')?.row === bodyRow))
    click2('chat-body')
    check('f long: return focus to chat before testing the text hit area', await settled(() => lines2().some(row => row.includes('Ctrl+B focus panel'))))
    const beforeExpand = expanded.length
    click2('…')
    check('f long text: ellipsis hit area remains a tab, not fullscreen', await settled(() => lines2().some(row => row.includes('Esc chat'))) && expanded.length === beforeExpand)
    click2('⤢')
    check('f ⤢: independent fullscreen hit area reports the long plugin id', await settled(() => expanded.length === beforeExpand + 1 && expanded.at(-1) === 'regression:long'))
    check('f fold: row below the bar remains the rule', (lines2()[1] ?? '').includes('─'))
  } finally {
    await app2.unmount()
    for (const release of releases) release()
  }
}

console.log(failed === 0 ? 'ALL PASS' : failed + ' FAILED')
process.exit(failed === 0 ? 0 : 1)
