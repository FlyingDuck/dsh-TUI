/**
 * Side-panel layout regression (Phase 1, render level): mounts
 * SidePanelLayout + SidePanelColumn (real useSidePanel controller + a
 * minimal channel stub — the column's tabs now come from the panel store
 * via the controller) with fake chat content in a headless XTerm
 * (AlternateScreen — fixed-height boxes are only trustworthy there, see
 * verify-divider-width's lesson) and locks the visual contract:
 *  - divider column sits exactly at the chat width; row 1 draws '├',
 *    the final row closes with '└', and all intermediate rows draw '│';
 *  - PanelBar shows text tabs in fixed order, with a contiguous overflow window;
 *  - selection stays bold/accent with either focus, badges remain visible;
 *  - the chat-side bordered input never crosses the divider;
 *  93-column split keeps the bar and hint on one row;
 *  - geometry=null renders children byte-identically to no layout;
 *  - wide/narrow/tiny bars, empty/single tabs and Unicode titles stay one row;
 *  - active changes and resize follow selection without unnecessarily moving the window;
 *  - resize oracle: 120 -> 100 -> 120 settles to the same frame as a
 *    fresh 120 render (terminal-state equivalence); the frame must also
 *    re-split live (geometry resolved from useTerminalSize, mirroring
 *    Chat's call site — a fixed prop would not re-split).
 * Run: node --import tsx/esm scripts/verify-side-panel-layout.tsx
 */
process.env.FORCE_COLOR = '3'
// Pin zh before module imports resolve the startup lang; the en pass
// switches at runtime via setLang (i18n hot-swaps).
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, ui, { SidePanelLayout }, { SidePanelColumn }, { useSidePanel }, dims, prefs, { setLang }, termTest] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/sidePanel/SidePanelLayout.js'),
  import('../src/components/sidePanel/SidePanelColumn.js'),
  import('../src/components/sidePanel/useSidePanel.js'),
  import('../src/components/sidePanel/dimensions.js'),
  import('../src/tuiDisplayPrefs.js'),
  import('../src/i18n.js'),
  import('./lib/term-test.mjs'),
])
const { render, ThemeProvider, Box, Text, AlternateScreen, useTerminalSize } = ui
const { resolveSplit, resolveZoom, resolveSidePanelGeometry } = dims
const { applySidePanelOpen, applySidePanelRatio, applySidePanelPanels } = prefs
const { settled, settle } = termTest
const [{ PanelBar }, { stringWidth }, { getTheme }] = await Promise.all([
  import('../src/components/sidePanel/PanelBar.js'),
  import('../src/ink/stringWidth.js'),
  import('../src/theme.js'),
])
type BarTab = import('../src/components/sidePanel/PanelBar.js').PanelBarTab
setLang('zh')

const ROWS = 18

// Minimal channel stub: the todo builtin reads goal/todos/working (all
// empty -> renders nothing); nothing else in the column touches it.
const channelStub: unknown = {
  version: 0,
  rows: [],
  status: 'idle',
  working: false,
  goal: undefined,
  todos: [],
  // jobs/agents 面板默认启用（摘要 length / 名册 filter）
  backgroundJobs: [],
  subagents: [],
  subscribe() { return () => {} },
}

function ChatFake({ width }: { width: number }): React.ReactNode {
  return (
    <Box flexDirection="column" width={width} flexGrow={1}>
      <Box flexGrow={1} flexDirection="column" justifyContent="center">
        <Text>chat-body</Text>
      </Box>
      <Box borderStyle="single" flexShrink={0}>
        <Text>input › _</Text>
      </Box>
      <Box height={1} flexShrink={0}>
        <Text>status:ready</Text>
      </Box>
    </Box>
  )
}

// Controller-driven split: mirrors Chat's call site (useSidePanel reads
// useTerminalSize via its columns prop and resolves geometry per render).
function SplitFixture({ focusPanel, zoom }: { focusPanel: boolean; zoom?: boolean }): React.ReactNode {
  const size = useTerminalSize()
  const sp = useSidePanel({ columns: size.columns, fullscreen: true, editorOpen: false })
  React.useEffect(() => {
    if (focusPanel) sp.focusPanel()
    if (zoom) sp.toggleZoom()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const geo = sp.geometry
  return (
    <SidePanelLayout
      geometry={geo}
      focus={sp.focus}
      side={geo === null ? null : (
        <SidePanelColumn width={geo.panel} controller={sp} channel={channelStub as never} />
      )}
    >
      <ChatFake width={geo === null ? size.columns : geo.chat} />
    </SidePanelLayout>
  )
}

let failed = 0
function check(name: string, ok: boolean, extra = '') {
  console.log((ok ? 'PASS' : 'FAIL') + ': ' + name + (extra ? '  (' + extra + ')' : ''))
  if (!ok) failed += 1
}

class FakeStdout extends Writable {
  columns: number
  rows = ROWS
  isTTY = true
  term: import('@xterm/headless').Terminal
  constructor(term: import('@xterm/headless').Terminal, cols: number) {
    super()
    this.term = term
    this.columns = cols
  }
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { this.term.write(String(chunk), cb) }
}
class FakeStderr extends Writable { isTTY = true; _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() } }
class FakeStdin extends PassThrough { isTTY = true; setRawMode() { return this }; ref() { return this }; unref() { return this } }

interface Frame {
  term: import('@xterm/headless').Terminal
  stdout: FakeStdout
  app: Awaited<ReturnType<typeof render>>
  rerender(tree: React.ReactNode): void
  lines(): string[]
}

async function mountTree(cols: number, tree: React.ReactNode): Promise<Frame> {
  const term = new XTerm({ cols, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const stdout = new FakeStdout(term, cols)
  const wrap = (node: React.ReactNode) => <AlternateScreen><ThemeProvider theme="dark">{node}</ThemeProvider></AlternateScreen>
  const app = await render(
    wrap(tree),
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
      stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  const frame: Frame = {
    term, stdout, app,
    rerender(node) { app.rerender(wrap(node)) },
    lines() {
      const buf = term.buffer.active
      const out: string[] = []
      for (let y = 0; y < ROWS; y += 1) out.push((buf.getLine(y)?.translateToString(true) ?? '').padEnd(stdout.columns, ' '))
      return out
    },
  }
  await settle(() => frame.lines().some(l => l.includes('status:ready') || l.trim() === 'ready'))
  return frame
}

/** Reset the module-level live stores, then mount a controller-driven split. */
async function mountSplit(cols: number, focusPanel: boolean, zoom = false): Promise<Frame> {
  applySidePanelOpen(true)
  applySidePanelRatio(0.68)
  applySidePanelPanels('todo,jobs,agents')
  const frame = await mountTree(cols, <SplitFixture focusPanel={focusPanel} zoom={zoom} />)
  await settle(() => cols < 93 || frame.lines()[ROWS - 2]!.includes(focusPanel ? 'Esc' : 'Ctrl+B'))
  if (zoom) await settle(() => cells(frame.lines()[5]!)[64] === '│')
  return frame
}

function cells(line: string): string[] { return [...line] }

function assertSplitFrame(name: string, frame: Frame, geo: { chat: number; panel: number }, hintNeedle: string, hintAnti: string) {
  const lines = frame.lines()
  const chatCol = geo.chat
  // Divider column: top-rule tee, middle seam, and a closing bottom corner.
  for (let y = 0; y < ROWS; y += 1) {
    const expected = y === 1 ? '├' : y === ROWS - 1 ? '└' : '│'
    const got = cells(lines[y])[chatCol]
    check(name + ': divider row ' + y + ' is ' + expected, got === expected, 'got ' + JSON.stringify(got) + ' line=' + JSON.stringify(lines[y]))
  }
  check(name + ': row 0 carries the active title', lines[0].includes('待办'), JSON.stringify(lines[0]))
  const titles = ['待办', '任务', '代理']
  const positions = titles.map(title => lines[0]!.indexOf(title))
  check(name + ': row 0 shows text tabs in configured order', positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1]!)), JSON.stringify(lines[0]))
  check(name + ': fitting tabs have no icons or overflow arrows', !/[≡▸◆◀▶]/.test(lines[0]!), JSON.stringify(lines[0]))
  // The final rule follows the hint, closing the entire column on its last row.
  const ruleAfter = cells(lines[1]).slice(chatCol + 1).join('').trim()
  check(name + ': row 1 rule right of the divider', ruleAfter.length > 0 && ruleAfter.startsWith('─'), ruleAfter.slice(0, 8))
  const closingRule = cells(lines[ROWS - 1]).slice(chatCol + 1).join('').trim()
  check(name + ': final row is a continuous closing rule', closingRule.length > 0 && /^─+$/.test(closingRule), closingRule.slice(0, 8))
  // Hint is immediately above the final rule, swapping with focus.
  check(name + ': hint row carries ' + JSON.stringify(hintNeedle), lines[ROWS - 2].includes(hintNeedle), JSON.stringify(lines[ROWS - 2]))
  check(name + ': hint row does not carry the other focus copy', !lines[ROWS - 2].includes(hintAnti), JSON.stringify(lines[ROWS - 2]))
  check(name + ': closing rule carries no hint', !lines[ROWS - 1].includes(hintNeedle) && !lines[ROWS - 1].includes(hintAnti), JSON.stringify(lines[ROWS - 1]))
  // Chat-side bordered input never crosses the divider.
  const topBorder = lines.find(l => l.includes('┌'))
  const bottomBorder = lines.find(l => cells(l).slice(0, chatCol).includes('└'))
  const inputRow = lines.find(l => l.includes('input ›'))
  check(name + ': bordered input rendered', topBorder !== undefined && inputRow !== undefined && bottomBorder !== undefined)
  if (topBorder !== undefined && inputRow !== undefined) {
    const rightCorner = cells(topBorder).indexOf('┐')
    check(name + ': input box right edge (' + rightCorner + ') < divider (' + chatCol + ')', rightCorner >= 0 && rightCorner < chatCol)
    const side = cells(inputRow).indexOf('│')
    check(name + ': input box side border < divider', side >= 0 && side < chatCol)
    // Nothing chat-side bleeds into the divider column.
    check(name + ': chat body stops before the divider', cells(lines.find(l => l.includes('chat-body')) ?? '')[chatCol - 1] === ' ')
  }
}

// --- 1. 120 columns, focus=chat -----------------------------------------
{
  const frame = await mountSplit(120, false)
  assertSplitFrame('120/focus=chat', frame, resolveSplit(120, 0.68), 'Ctrl+B 聚焦侧栏', 'Esc 聊天')
  await frame.app.unmount()
}

// --- 2. 120 columns, focus=panel (hint swaps) ----------------------------
{
  const frame = await mountSplit(120, true)
  assertSplitFrame('120/focus=panel', frame, resolveSplit(120, 0.68), 'Esc 聊天', 'Ctrl+B 聚焦侧栏')
  await frame.app.unmount()
}

// --- 3. zoom at 120: chat=64 keeps every invariant -----------------------
{
  const frame = await mountSplit(120, true, true)
  assertSplitFrame('zoom(120)/chat=64', frame, resolveZoom(120), 'Esc 聊天', 'Ctrl+B 聚焦侧栏')
  check('zoom(120)/chat=64: divider sits at column 64', cells(frame.lines()[5])[64] === '│', JSON.stringify(frame.lines()[5]))
  await frame.app.unmount()
}

// --- 4. 93-column minimum split: bar/hint stay single rows ----------------
{
  const geo = resolveSidePanelGeometry({ columns: 93, open: true, zoom: false, ratio: 0.68 })
  if (geo === null) throw new Error('93 columns must split')
  const frame = await mountSplit(93, true)
  const lines = frame.lines()
  assertSplitFrame('93/focus=panel', frame, geo, 'Esc 聊天', 'Ctrl+B 聚焦侧栏')
  check('93: fitting text tabs need no overflow arrows', !/[◀▶]/.test(lines[0]!) && lines[0]!.includes('代理'), JSON.stringify(lines[0]))
  // Hint is exactly one row, immediately above the closing rule.
  check('93: hint is exactly one row above the final rule', lines[ROWS - 2].includes('Esc') && !lines[ROWS - 1].includes('Esc'), JSON.stringify(lines.slice(ROWS - 2)))
  await frame.app.unmount()
  // Unfocused hint at the minimum width: full copy fits.
  const frame2 = await mountSplit(93, false)
  check('93: unfocused hint copy fits one row', frame2.lines()[ROWS - 2].includes('Ctrl+B 聚焦侧栏'), JSON.stringify(frame2.lines()[ROWS - 2]))
  await frame2.app.unmount()
}

// --- 5. Text tabs, overflow windows, badges and Unicode ------------------
function BarFixture({ tabs, activeId, focused = true, stamp = 'initial' }: {
  tabs: readonly BarTab[]; activeId?: string; focused?: boolean; stamp?: string
}): React.ReactNode {
  const { columns } = useTerminalSize()
  return (
    <Box flexDirection="column" width={columns}>
      <PanelBar tabs={tabs} activeId={activeId} width={columns} focused={focused} canExpand={tabs.length > 0} />
      <Text>BODY</Text>
      <Text>ready</Text>
      <Text>{stamp}</Text>
    </Box>
  )
}

function visibleTabs(frame: Frame, tabs: readonly BarTab[]): number[] {
  const row = frame.lines()[0]!
  return tabs.flatMap((tab, i) => row.includes(tab.title) ? [i] : [])
}

function assertWindow(name: string, frame: Frame, tabs: readonly BarTab[], active: number): number[] {
  const row = frame.lines()[0]!
  const shown = visibleTabs(frame, tabs)
  const start = shown[0] ?? -1
  const end = shown.at(-1) ?? -1
  check(name + ': active text remains visible', shown.includes(active), JSON.stringify(row))
  check(name + ': window is contiguous and in tab order', shown.length > 0 && shown.every((index, i) => index === start + i && (i === 0 || row.indexOf(tabs[index]!.title) > row.indexOf(tabs[shown[i - 1]!]!.title))), JSON.stringify(shown))
  check(name + ': arrows appear only toward hidden tabs', row.includes('◀') === (start > 0) && row.includes('▶') === (end < tabs.length - 1), JSON.stringify(row))
  check(name + ': body and fullscreen never wrap/overlap', row.includes('⤢') && row.indexOf('⤢') > row.indexOf(tabs[active]!.title) + tabs[active]!.title.length - 1 && frame.lines()[1]!.trim() === 'BODY', JSON.stringify(frame.lines().slice(0, 2)))
  return shown
}

function titleCell(frame: Frame, title: string) {
  const row = frame.lines()[0]!
  const index = row.indexOf(title)
  return index < 0 ? undefined : frame.term.buffer.active.getLine(0)?.getCell(stringWidth(row.slice(0, index)))
}

{
  const tabs: readonly BarTab[] = [
    { id: 'p0', title: 'P0', icon: '≡', badge: { level: 'info', unread: 3 } },
    { id: 'p1', title: 'Notes' },
    { id: 'p2', title: 'P2', icon: 'ⓘ', badge: { level: 'warning', unread: 4 } },
    { id: 'p3', title: 'P3', icon: '▸' },
    { id: 'p4', title: 'P4', icon: '∿' },
    { id: 'p5', title: 'P5', icon: '◆', badge: { level: 'error', unread: 2 } },
    { id: 'p6', title: 'P6', icon: '♥' },
  ]
  const rgb = (color: string) => (color.match(/\d+/g) ?? []).map(Number).reduce((value, part) => value * 256 + part, 0)
  const accent = rgb(getTheme('dark').accent)
  const frame = await mountTree(80, <BarFixture tabs={tabs} activeId="p3" />)
  assertWindow('wide(80/7)', frame, tabs, 3)
  check('wide: every title is visible, icons are compatibility data only', visibleTabs(frame, tabs).length === tabs.length && !/[≡ⓘ▸∿◆♥]/.test(frame.lines()[0]!), JSON.stringify(frame.lines()[0]))
  check('wide: active is bold theme accent and inactive text stays weak', Boolean(titleCell(frame, 'P3')?.isBold()) && titleCell(frame, 'P3')?.getFgColor() === accent && !titleCell(frame, 'Notes')?.isBold() && titleCell(frame, 'Notes')?.getFgColor() !== accent)
  check('wide: unread badges accompany text tabs', /P0\s*3/.test(frame.lines()[0]!) && /P2\s*4/.test(frame.lines()[0]!) && /P5\s*2/.test(frame.lines()[0]!), JSON.stringify(frame.lines()[0]))
  for (const [digit, level] of [['4', 'warning'], ['2', 'error']] as const) {
    const title = level === 'warning' ? 'P2' : 'P5'
    const row = frame.lines()[0]!
    const at = row.indexOf(digit, row.indexOf(title) + title.length)
    const cell = frame.term.buffer.active.getLine(0)?.getCell(at)
    check('wide: ' + level + ' badge retains its semantic color', at >= 0 && cell?.getFgColor() === rgb(getTheme('dark')[level]))
  }
  const fixedPositions = tabs.map(tab => frame.lines()[0]!.indexOf(tab.title))
  frame.rerender(<BarFixture tabs={tabs} activeId="p0" focused={false} stamp="chat" />)
  check('chat focus: active badge/title remains bold accent', await settled(() => frame.lines()[3]!.includes('chat') && Boolean(titleCell(frame, 'P0')?.isBold()) && titleCell(frame, 'P0')?.getFgColor() === accent && /P0\s*3/.test(frame.lines()[0]!)))
  check('active change: titles do not move toward the center', JSON.stringify(fixedPositions) === JSON.stringify(tabs.map(tab => frame.lines()[0]!.indexOf(tab.title))))
  await frame.app.unmount()

  // Uniform labels make the overflow oracle independent of spacing policy.
  const shortTabs = Array.from({ length: 12 }, (_, i) => ({ id: 't' + i, title: 'T' + String(i).padStart(2, '0'), icon: '◆' }))
  for (const width of [28, 14, 11]) {
    const narrow = await mountTree(width, <BarFixture tabs={shortTabs} activeId="t6" />)
    const shown = assertWindow('narrow(' + width + '/12)', narrow, shortTabs, 6)
    check('narrow(' + width + '): hides tabs rather than squeezing icons', shown.length < shortTabs.length && !narrow.lines()[0]!.includes('◆'), JSON.stringify(narrow.lines()[0]))
    if (shown.length > 1) {
      const next = shown[0] === 6 ? shown.at(-1)! : shown[0]!
      narrow.rerender(<BarFixture tabs={shortTabs} activeId={'t' + next} stamp="moved" />)
      check('visible switch(' + width + '): preserves window start', await settled(() => narrow.lines()[3]!.includes('moved') && visibleTabs(narrow, shortTabs)[0] === shown[0] && Boolean(titleCell(narrow, shortTabs[next]!.title)?.isBold())), JSON.stringify(shown))
      assertWindow('visible switch(' + width + ')', narrow, shortTabs, next)
    }
    await narrow.app.unmount()
  }

  for (const tabs of [[], [{ id: 'solo', title: 'Solo', icon: '◆' }]] as readonly (readonly BarTab[])[]) {
    const single = await mountTree(28, <BarFixture tabs={tabs} activeId={tabs[0]?.id} />)
    const row = single.lines()[0]!
    check('tabs=' + tabs.length + ': no overflow arrows or icons', !/[◀▶◆]/.test(row) && row.includes('⤢') === (tabs.length === 1), JSON.stringify(row))
    check('tabs=' + tabs.length + ': one-row bar does not move body', single.lines()[1]!.trim() === 'BODY')
    if (tabs.length === 1) check('single: title starts at the left, not centered', row.indexOf('Solo') >= 0 && row.indexOf('Solo') <= 2, JSON.stringify(row))
    await single.app.unmount()
  }

  for (const title of ['Plugin observability dashboard with a deliberately long English title', '计划👩‍💻状态😀插件扩展面板']) {
    const long = await mountTree(18, <BarFixture tabs={[{ id: 'plugin:long', title }]} activeId="plugin:long" />)
    const row = long.lines()[0]!
    const shown = row.slice(0, row.indexOf('⤢')).trim()
    const prefixes = new Set([''])
    let prefix = ''
    for (const part of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(title)) {
      prefix += part.segment
      prefixes.add(prefix)
    }
    check('long title: ellipsis preserves graphemes and fullscreen space', shown.endsWith('…') && prefixes.has(shown.slice(0, -1)) && stringWidth(row.trimEnd()) <= 18 && long.lines()[1]!.trim() === 'BODY', JSON.stringify(row))
    await long.app.unmount()
  }

  const resizing = await mountTree(80, <BarFixture tabs={shortTabs} activeId="t9" />)
  for (const width of [28, 18, 52]) {
    resizing.stdout.columns = width
    resizing.term.resize(width, ROWS)
    resizing.stdout.emit('resize')
    check('bar resize ' + width + ': follows active and keeps body stable', await settled(() => resizing.lines()[0]!.includes('T09') && resizing.lines()[0]!.includes('⤢') && resizing.lines()[1]!.trim() === 'BODY' && resizing.lines()[0]!.indexOf('⤢') >= width - 3 && resizing.lines()[0]!.trimEnd().length <= width))
    assertWindow('bar resize ' + width, resizing, shortTabs, 9)
  }
  await resizing.app.unmount()
}

// --- 6. 90 columns (!canSplit): geometry=null is a byte-identical passthrough
{
  const bare = await mountTree(90, <ChatFake width={90} />)
  const bareLines = bare.lines()
  await bare.app.unmount()
  const wrapped = await mountSplit(90, false)
  const wrappedLines = wrapped.lines()
  check('90 cols: geometry=null renders identical to no SidePanelLayout', JSON.stringify(bareLines) === JSON.stringify(wrappedLines),
    JSON.stringify(bareLines) + ' vs ' + JSON.stringify(wrappedLines))
  await wrapped.app.unmount()
}

// --- 7. resize oracle: 120 -> 100 -> 120 equals a fresh 120 frame ---------
{
  const frame = await mountSplit(120, true)
  // Shrink to 100, let it settle, then back to 120.
  frame.stdout.columns = 100
  frame.term.resize(100, ROWS)
  frame.stdout.emit('resize')
  const shrunkGeo = resolveSidePanelGeometry({ columns: 100, open: true, zoom: false, ratio: 0.68 })
  if (shrunkGeo === null) throw new Error('100 columns must split')
  check('resize: 100-col frame re-splits to chat=68/panel=31', await settled(() => cells(frame.lines()[5]!)[shrunkGeo.chat] === '│'), JSON.stringify(frame.lines()[5]))
  frame.stdout.columns = 120
  frame.term.resize(120, ROWS)
  frame.stdout.emit('resize')
  check('resize: 120-col divider returns to its original position', await settled(() => cells(frame.lines()[5]!)[resolveSplit(120, 0.68).chat] === '│'))
  const backLines = frame.lines().map(l => l.slice(0, 120))
  await frame.app.unmount()
  const fresh = await mountSplit(120, true)
  const freshLines = fresh.lines()
  await fresh.app.unmount()
  check('resize: 120->100->120 equals a fresh 120 render', JSON.stringify(backLines) === JSON.stringify(freshLines),
    'back=' + JSON.stringify(backLines.slice(0, 3)) + ' fresh=' + JSON.stringify(freshLines.slice(0, 3)))
}

// --- 8. en hint pass -------------------------------------------------------
{
  setLang('en')
  const frame = await mountSplit(120, true)
  check('en: focused hint says Esc chat', frame.lines()[ROWS - 2].includes('Esc chat'), JSON.stringify(frame.lines()[ROWS - 2]))
  await frame.app.unmount()
  const frame2 = await mountSplit(120, false)
  check('en: unfocused hint says Ctrl+B focus panel', frame2.lines()[ROWS - 2].includes('Ctrl+B focus panel'), JSON.stringify(frame2.lines()[ROWS - 2]))
  await frame2.app.unmount()
  setLang('zh')
}

if (failed > 0) {
  console.error('FAILED: ' + failed + ' check(s).')
  process.exit(1)
}
console.log('OK: side-panel layout all checks passed.')
process.exit(0)
