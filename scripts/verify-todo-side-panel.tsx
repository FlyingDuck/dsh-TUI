/**
 * Todo side-panel toggle regression (user report: 侧边栏 todo 面板展开不了).
 *
 * Mounts SidePanelColumn + PanelHost headless (xterm headless + AlternateScreen
 * + a useInput raw-mode keeper) with a fake channel carrying goal + todos, and
 * locks:
 *  - a real SGR mouse click on the fold header toggles expand/collapse in the
 *    panel variant (the header row's onClick must be wired — before the fix
 *    TodoPanelAdapter never passed onToggle and the header was a dead control);
 *  - Enter and Space toggle through the v2.1 dispatcher (usePanelInput) while
 *    the panel is active;
 *  - long goals wrap completely at narrow/wide sidebar widths, with exact
 *    row measurement and a separate phase badge; resizing reflows them;
 *  - a short viewport scrolls to the goal tail and the budgeted todo list
 *    without moving the panel chrome or consuming chat-focused arrow keys;
 *  - control: the chat-page default variant still renders its list + fold
 *    hint line untouched (panel-variant-only change).
 * Run: node --import tsx/esm scripts/verify-todo-side-panel.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, ui, { SidePanelColumn }, { useSidePanel }, prefs, { GoalTodoPanel }, termTest] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/sidePanel/SidePanelColumn.js'),
  import('../src/components/sidePanel/useSidePanel.js'),
  import('../src/tuiDisplayPrefs.js'),
  import('../src/components/GoalTodoPanel.js'),
  import('./lib/term-test.mjs'),
])
const { render, ThemeProvider, AlternateScreen, Box, Text, useInput } = ui
const { applySidePanelOpen, applySidePanelRatio } = prefs
const { settled, sleep, viewportLines } = termTest
const [{ wrapTextLines }, { getTooltipSnapshot, clearTooltip }] = await Promise.all([
  import('../src/ink/wrap-text.js'),
  import('../src/components/Tooltip.js'),
])
import type { DOMElement } from '../src/ink/dom.js'

const COLS = 110
const ROWS = 22

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log((ok ? 'PASS' : 'FAIL') + ': ' + name + (extra ? '  (' + extra + ')' : ''))
  if (!ok) failed += 1
}

// --- fake channel -----------------------------------------------------------
const NOW = Date.now()
let todos: Array<{ id: string; content: string; status: string }> = [
  { id: 't1', content: 'finish the probe', status: 'completed' },
  { id: 't2', content: 'write the fix', status: 'in_progress' },
  { id: 't3', content: 'run the gates', status: 'pending' },
]
let channelVersion = 0
const channelListeners = new Set<() => void>()
let working = true
function setWorking(next: boolean): void {
  working = next
  channelVersion += 1
  for (const listener of [...channelListeners]) listener()
}
function setTodos(next: typeof todos): void {
  todos = next
  channelVersion += 1
  for (const listener of [...channelListeners]) listener()
}
// 长行夹具：折行后第二行全为 B（首行全 a），好断言悬挂缩进；overlong 折出
// >2 行，用来锁「cap 到 2 行 + 省略号」。
const LONG_WRAP = 'a'.repeat(30) + 'B'.repeat(20)
const OVERLONG = 'X'.repeat(100)
const goal = { id: 'g1', objective: 'fix the todo panel', phase: 'active', roundsStarted: 1, maxGoalRounds: 8 }
const channel = {
  get version() { return channelVersion },
  goal,
  get todos() { return todos },
  get working() { return working },
  notifications: [] as Array<{ text: string }>,
  // 运行时契约：侧栏启用面板含 jobs/agents，适配器会读这两个字段
  // （backgroundJobs 摘要行、subagents.filter 名册）——缺了就炸进边界。
  backgroundJobs: [] as unknown[],
  subagents: [] as unknown[],
  notify(text: string) { channel.notifications.push({ text }) },
  subscribe(listener: () => void) {
    channelListeners.add(listener)
    return () => { channelListeners.delete(listener) }
  },
}

// --- harness (mirrors verify-jobs-side-panel.tsx) ----------------------------
let exposedFocus = ''
let exposedActive = ''
let openTodo: (() => void) | undefined

function Harness(): React.ReactNode {
  const sp = useSidePanel({ columns: COLS, fullscreen: true, editorOpen: false })
  const [, bump] = React.useState(0)
  exposedFocus = sp.focus
  exposedActive = sp.activePanelId ?? 'none'
  openTodo = () => sp.openPanel('todo', { focus: true })
  React.useEffect(() => channel.subscribe(() => bump(previous => previous + 1)), [])
  useInput((input: string, key: Record<string, boolean | undefined>) => {
    sp.handleKey(input, key as never)
    bump(previous => previous + 1)
  })
  return (
    <Box flexDirection="row" width={COLS} height={ROWS}>
      <Box width={sp.split ? sp.chatColumns : COLS}><Text>{'chat-anchor SP split=' + (sp.split ? 1 : 0) + ' focus=' + sp.focus + ' active=' + (sp.activePanelId ?? 'none')}</Text></Box>
      {sp.split ? <SidePanelColumn width={sp.panelColumns} controller={{ ...sp, enabledPanelIds: ['todo'] }} channel={channel as never} /> : null}
    </Box>
  )
}

class FakeStdout extends Writable {
  isTTY = true
  term: import('@xterm/headless').Terminal
  constructor(term: import('@xterm/headless').Terminal, readonly columns: number = COLS, readonly rows: number = ROWS) { super(); this.term = term }
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { this.term.write(String(chunk), cb) }
}
class FakeStderr extends Writable { isTTY = true; _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() } }
class FakeStdin extends PassThrough { isTTY = true; setRawMode() { return this }; ref() { return this }; unref() { return this } }

applySidePanelOpen(true)
applySidePanelRatio(0.68)
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
const stdout = new FakeStdout(term)
const stdin = new FakeStdin()
const app = await render(
  <AlternateScreen mouseTracking={true}>
    <ThemeProvider theme="dark">
      <Harness />
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
function lines(): string[] {
  const buf = term.buffer.active
  const out: string[] = []
  for (let y = 0; y < ROWS; y += 1) out.push((buf.getLine(y)?.translateToString(false) ?? '').padEnd(COLS, ' '))
  return out
}
const findCell = (needle: string): { col: number; row: number } | null => {
  const ls = lines()
  for (let y = 0; y < ls.length; y += 1) {
    const col = ls[y].indexOf(needle)
    if (col >= 0) return { col, row: y }
  }
  return null
}
function clickAt(cell: { col: number; row: number }): void {
  // SGR press/release; motion is button 35, a plain click is button 0.
  const seq = '\x1b[<0;' + (cell.col + 1) + ';' + (cell.row + 1)
  stdin.write(seq + 'M')
  stdin.write(seq + 'm')
}

try {
  await settled(() => lines().some(l => l.includes('split=1')))
  check('mount: sidebar split with todo panel active', exposedActive === 'todo', 'active=' + exposedActive)

  // The todo panel default state is EXPANDED: list rows visible.
  const expandedInitially = lines().some(l => l.includes('write the fix'))
  check('initial: todo list rows visible (expanded)', expandedInitially)
  const headerCell = findCell('1/3')
  check('initial: fold header (done/total) on screen', headerCell !== null)

  // --- 1. mouse click on the header collapses; second click expands --------
  check('preclick: focus is chat (click must not need focus)', exposedFocus === 'chat', exposedFocus)
  if (headerCell === null || !expandedInitially) {
    check('click: header toggle works', false, 'header/list not found')
  } else {
    clickAt(headerCell)
    check('click 1: header click collapses the list (pending rows fold away)', await settled(() => !lines().some(l => l.includes('run the gates')) && lines().some(l => l.includes('\u25b8'))))
    const collapsedCell = findCell('1/3')
    check('click 1: collapsed preview header still on screen', collapsedCell !== null)
    // ink 的双击窗口是 500ms（App.tsx MULTI_CLICK_TIMEOUT_MS）：冷却期内
    // 同点位再按会被吃成双击选词而不是 onClick——真实用户单击间隔远大于
    // 此，探针必须等过窗口再发第二次点击。
    await sleep(600) // 固定窗:墙钟 ink 500ms 双击判定窗口本身是被测语义（等冷却到期再单击）
    if (collapsedCell !== null) clickAt(collapsedCell)
    check('click 2: second header click expands again', await settled(() => lines().some(l => l.includes('run the gates'))))
  }

  // --- 2. keyboard: Enter toggles through usePanelInput --------------------
  openTodo?.()
  await settled(() => exposedFocus === 'panel', { timeout: 4000 })
  check('keys: panel focused after openPanel(todo, focus)', exposedFocus === 'panel', exposedFocus)
  await settled(() => lines().some(l => l.includes('write the fix')))
  stdin.write('\r') // ink Enter: input='' + key.return
  check('keys: Enter collapses the expanded list', await settled(() => !lines().some(l => l.includes('run the gates'))))
  stdin.write(' ')
  check('keys: Space expands again', await settled(() => lines().some(l => l.includes('run the gates'))))
  stdin.write('x') // unrelated key must NOT toggle and must be consumed-safe
  await sleep(60) // 固定窗:探针 断言无关键不改变折叠状态——只能等一个观察窗
  check('keys: unrelated key leaves the fold state alone', lines().some(l => l.includes('run the gates')))

  // --- 3. panel wrap: long todo folds onto 2 rows, height unchanged --------
  const ruleRows = (): number[] => {
    const rows: number[] = []
    for (let y = 0; y < ROWS; y += 1) if (lines()[y].includes('\u2500\u2500\u2500\u2500')) rows.push(y)
    return rows
  }
  const rulesBefore = ruleRows()
  check('wrap: panel rules located (baseline geometry)', rulesBefore.length >= 2, JSON.stringify(rulesBefore))
  // hostHeight = 18: padding + goal + badge + header use 4 rows. The
  // remaining 14 include the overflow row, leaving 13 for todo text.
  const shorts = Array.from({ length: 12 }, (_, i) => ({ id: 's' + i, content: 'short task ' + i, status: 'pending' }))
  setTodos([
    { id: 'L', content: LONG_WRAP, status: 'pending' },
    { id: 'O', content: OVERLONG, status: 'pending' },
    ...shorts,
  ])
  await settled(() => lines().some(l => l.includes('BBBBB')), { timeout: 4000 })
  check('wrap: long todo first line renders (a-run)', lines().some(l => l.includes('aaaaa')))
  // 悬挂缩进：续行在首行树形前缀列上是 5 格空格（前缀 3 + glyph 2），正文与首行对齐。
  const wrapFirstRow = lines().findIndex(l => l.includes('aaaaa'))
  const contLine = lines()[wrapFirstRow + 1]
  const prefixCol = wrapFirstRow >= 0 ? lines()[wrapFirstRow]!.indexOf('\u251c') : -1
  // 整组不变量：续行在树形前缀列上必须以 '│' 开头（竖线与首行连续），
  // 且正文列与首行对齐（'│'+4 格 = 5 格）。
  const contAtPrefix = contLine !== undefined && prefixCol >= 0 ? contLine.slice(prefixCol, prefixCol + 5) : ''
  check('wrap: continuation line hangs with 5-space indent (aligns with first-line text)',
    contAtPrefix === '\u2502    ',
    JSON.stringify(contLine ?? null))
  // Two 2-row todos + nine 1-row todos + overflow use exactly 14 rows.
  check('wrap: overflow items yield to the …N more lane (budget by rows)',
    lines().some(l => l.includes('… 3 more')) && lines().some(l => l.includes('short task 8')) &&
      !lines().some(l => l.includes('short task 9')) && !lines().some(l => l.includes('short task 10')),
    lines().find(l => l.includes('more')) ?? 'no-more-line')
  // 高度契约（§16.6）：折行只改变可见条数，面板盒子高度（分隔线位置）不变。
  check('wrap: panel height unchanged (rule rows identical)', JSON.stringify(ruleRows()) === JSON.stringify(rulesBefore),
    'before=' + JSON.stringify(rulesBefore) + ' after=' + JSON.stringify(ruleRows()))

  // --- 4. panel wrap cap: >2 lines truncate with an ellipsis on row 2 ------
  setTodos([
    { id: 'O', content: OVERLONG, status: 'pending' },
    { id: 't2', content: 'write the fix', status: 'in_progress' },
  ])
  // 上一段屏幕上本来就有 X 行——必须等到旧列表（shorts）真正退场，否则读到旧帧。
  await settled(() => !lines().some(l => l.includes('short task 0')) && lines().some(l => l.includes('XXXXX')), { timeout: 4000 })
  const xRows = lines().filter(l => l.includes('XXXXX'))
  check('cap: overlong todo occupies exactly 2 rows', xRows.length === 2, String(xRows.length))
  check('cap: second row ends with the ellipsis', xRows[1] !== undefined && xRows[1].trimEnd().endsWith('\u2026'), JSON.stringify(xRows[1] ?? null))
  const xIdx = xRows[1] !== undefined ? xRows[1].indexOf('XXXXX') : -1
  check('cap: second row also carries the tree stem (\u2502 + aligned text)',
    xIdx >= 5 && xRows[1]!.slice(xIdx - 5, xIdx) === '\u2502    ')
  check('cap: short neighbor still visible after it (budget left for 1-line rows)', lines().some(l => l.includes('write the fix')))
  check('wrap-cap: panel height still unchanged', JSON.stringify(ruleRows()) === JSON.stringify(rulesBefore))

  // --- 4b. LAST item wrapped: its continuation must NOT carry the stem -----
  // └─ 表示树到此为止——末条折行续行下面没有兄弟，'│' 是突兀的（用户实
  // 测）；非末条（cap 用例已锁）续行必须仍是 '│'+4 格。
  setTodos([
    { id: 't2', content: 'write the fix', status: 'in_progress' },
    { id: 'TL', content: 'LASTMARK-' + 'z'.repeat(60), status: 'pending' },
  ])
  await settled(() => lines().some(l => l.includes('LASTMARK-')), { timeout: 4000 })
  const lastRow = lines().findIndex(l => l.includes('LASTMARK-'))
  const lastPrefixCol = lastRow >= 0 ? lines()[lastRow]!.indexOf('\u2514') : -1
  const lastCont = lastRow >= 0 ? lines()[lastRow + 1] : undefined
  const lastAtPrefix = lastCont !== undefined && lastPrefixCol >= 0 ? lastCont.slice(lastPrefixCol, lastPrefixCol + 5) : ''
  check('last-wrap: last item first line closes with \u2514', lastPrefixCol >= 0)
  check('last-wrap: continuation column is blank (no stray stem)', lastAtPrefix === '     ', JSON.stringify(lastAtPrefix))
  check('last-wrap: continuation text still aligned with first-line text',
    lastCont !== undefined && lastCont.slice(lastPrefixCol + 5, lastPrefixCol + 7) === 'zz')

  // --- 5. idle + all completed: the expanded list must NOT be empty --------
  // 用户实测：折叠头 ✓ 9/9，点开后一条都没有。根因是 default 形态的
  // 「idle 自动隐藏完成行」语义泄漏进侧栏（过滤光 + showTodoSection 双层）。
  setWorking(false)
  const nine = Array.from({ length: 9 }, (_, i) =>
    i % 3 === 0
      ? { id: 'n' + i, content: 'long finished task ' + i + ' with plenty of wrapping text to fold onto a second row', status: 'completed' }
      : { id: 'n' + i, content: 'finished task ' + i, status: 'completed' })
  setTodos(nine)
  await settled(() => lines().some(l => l.includes('9/9')) && lines().some(l => l.includes('finished task 1')), { timeout: 4000 })
  check('idle-9: header still counts 9/9', lines().some(l => l.includes('9/9')))
  const idleRows = lines().filter(l => l.includes('finished task')).length
  check('idle-9: expanded list shows the completed rows (not empty)', idleRows >= 9, String(idleRows))
  check('idle-9: first and last items both on screen', lines().some(l => l.includes('finished task 0')) && lines().some(l => l.includes('finished task 8')))
  check('idle-9: completed rows render dimmed but present (glyph ✓)', lines().some(l => l.includes('\u2713 finished task 1')))
  // 点开/收起往返仍然工作（折叠头 → 预览行；再展开 → 9 行回来）。
  const idleHeader = findCell('9/9')
  await sleep(600) // 固定窗:墙钟 ink 500ms 双击判定窗口（距上次点击已远，此处仅对齐用例节奏）
  if (idleHeader !== null) clickAt(idleHeader)
  check('idle-9: collapse still folds the list', await settled(() => !lines().some(l => l.includes('finished task 1')) && lines().some(l => l.includes('\u25b8'))))
  await sleep(600) // 固定窗:墙钟 双击冷却到期后再单击展开
  const idleCollapsed = findCell('9/9')
  if (idleCollapsed !== null) clickAt(idleCollapsed)
  check('idle-9: re-expand brings the 9 rows back (list never empty)', await settled(() => lines().filter(l => l.includes('finished task')).length >= 9))
  setWorking(true)
  // control 段的夹具：短列表 + 超长行（default 形态不折行的对照物）。
  setTodos([
    { id: 't2', content: 'write the fix', status: 'in_progress' },
    { id: 't3', content: 'run the gates', status: 'pending' },
    { id: 'O', content: OVERLONG, status: 'pending' },
  ])

  await app.unmount()
  term.dispose()

  // --- 5. control: default (chat-page) variant untouched -------------------
  const term2 = new XTerm({ cols: 60, rows: 12, scrollback: 0, allowProposedApi: true })
  const stdout2 = new FakeStdout(term2, 60, 12)
  const stdin2 = new FakeStdin()
  const app2 = await render(
    <AlternateScreen>
      <ThemeProvider theme="dark">
        <GoalTodoPanel channel={{ ...channel, goal: { ...goal, objective: 'COMPACT_HEAD ' + 'x'.repeat(150) + ' COMPACT_TAIL' } } as never} variant="default" />
      </ThemeProvider>
    </AlternateScreen>,
    {
      stdout: stdout2 as unknown as NodeJS.WriteStream,
      stdin: stdin2 as unknown as NodeJS.ReadStream,
      stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  try {
    await settled(() => {
      for (let y = 0; y < 12; y += 1) if ((term2.buffer.active.getLine(y)?.translateToString(false) ?? '').includes('write the fix')) return true
      return false
    })
    const ls2: string[] = []
    for (let y = 0; y < 12; y += 1) ls2.push(term2.buffer.active.getLine(y)?.translateToString(false) ?? '')
    check('control: default variant renders expanded list', ls2.some(l => l.includes('write the fix')))
    check('control: default variant keeps its fold hint line', ls2.some(l => l.includes('to fold')), ls2.find(l => l.includes('fold')) ?? '')
    check('control: default variant header is expanded glyph', ls2.some(l => l.includes('\u25be')))
    check('control: long goal stays on one compact row beside its badge',
      ls2.some(line => line.includes('COMPACT_HEAD') && line.includes('active ·'))
      && !ls2.some(line => line.includes('COMPACT_TAIL')))
    // 整屏形态不折行：长 todo 仍是单行 truncate——没有任何续行。
    const xRows2 = ls2.filter(l => l.includes('XXXXX'))
    check('control: default variant does NOT wrap the long todo (single truncated row)',
      xRows2.length === 1 && !ls2.some(l => l.includes('BBBBB')), String(xRows2.length))
  } finally {
    await app2.unmount()
    term2.dispose()
  }
} finally {
  try { await app.unmount() } catch { /* already unmounted */ }
  try { term.dispose() } catch { /* already disposed */ }
}

// --- goal layout: real built-in adapter + PanelHost + terminal renderer -----
const LONG_GOAL = 'GOAL_HEAD 将本机个人 dsh-tui profile 安装为干净提交后的版本，'
  + '验证中英文目标自然换行 👩‍💻 e\u0301、侧栏尺寸和待办行预算。'.repeat(4)
  + '\n显式换行后仍保留全部目标内容 GOAL_TAIL'

function scrollNode(node: DOMElement | null): DOMElement | undefined {
  if (node === null) return undefined
  if (node.style.overflowY === 'scroll') return node
  for (const child of node.childNodes) {
    if (child.nodeName === '#text') continue
    const found = scrollNode(child)
    if (found !== undefined) return found
  }
  return undefined
}

async function goalLayout(rows: number): Promise<void> {
  const columns = 132
  let width = 28
  let panelRoot: DOMElement | null = null
  let controller: ReturnType<typeof useSidePanel> | undefined
  const goalChannel = {
    ...channel,
    sessionId: 'goal-layout-session',
    goal: { ...goal, objective: LONG_GOAL },
    todos: Array.from({ length: 24 }, (_, i) => ({ content: 'task-' + i, status: 'pending' })),
  }
  const goalTerm = new XTerm({ cols: columns, rows, scrollback: 0, allowProposedApi: true })
  const goalOut = new FakeStdout(goalTerm, columns, rows)
  const goalIn = new FakeStdin()
  function GoalHarness(): React.ReactNode {
    const sp = useSidePanel({ columns, fullscreen: true, editorOpen: false })
    controller = sp
    useInput((input, key) => { sp.handleKey(input, key as never) })
    React.useEffect(() => { sp.openPanel('todo', { focus: true }) }, [])
    return (
      <Box flexDirection="row" width={columns} height={rows}>
        <Box width={columns - width}><Text>chat-anchor</Text></Box>
        <Box ref={node => { panelRoot = node }} width={width} flexDirection="column">
          <SidePanelColumn width={width} controller={{ ...sp, enabledPanelIds: ['todo'], activePanelId: 'todo' }} channel={goalChannel as never} />
        </Box>
      </Box>
    )
  }
  const tree = () => <AlternateScreen><ThemeProvider theme="dark"><GoalHarness /></ThemeProvider></AlternateScreen>
  const instance = await render(tree(), {
    stdout: goalOut as unknown as NodeJS.WriteStream,
    stdin: goalIn as unknown as NodeJS.ReadStream,
    stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  const screen = () => viewportLines(goalTerm, rows)
  const scroller = () => scrollNode(panelRoot)
  const expectedGoalRows = () => wrapTextLines(LONG_GOAL, width - 5).length
  const compact = (text: string) => text.normalize('NFC').replace(/\s/g, '')
  const fullObjective = () => {
    const lines = screen()
    const head = lines.findIndex(line => line.includes('GOAL_HEAD'))
    const phase = lines.findIndex(line => line.includes('active ·'))
    return head >= 0 && phase - head === expectedGoalRows()
      && compact(lines.slice(head, phase).join('')).includes(compact(LONG_GOAL))
  }
  try {
    await settled(() => screen().some(line => line.includes('GOAL_HEAD')) && controller?.focus === 'panel')
    const ruleRows = () => screen().flatMap((line, index) => line.includes('────') ? [index] : [])
    const rules = ruleRows()
    if (rows >= 30) {
      for (const nextWidth of [28, 62, 28]) {
        width = nextWidth
        instance.rerender(tree())
        check(`goal ${width} cols: full CJK/emoji/multiline objective without hover`, await settled(fullObjective), screen().join('\n'))
        check(`goal ${width} cols: phase badge follows exactly the wrapped goal rows`,
          screen().findIndex(line => line.includes('active ·')) - screen().findIndex(line => line.includes('GOAL_HEAD')) === expectedGoalRows())
        check(`goal ${width} cols: todo budget includes padding/header/overflow (no hidden overflow row)`,
          await settled(() => screen().some(line => line.includes('more')))
          && scroller()?.scrollHeight === rows - 4 && scroller()?.scrollViewportHeight === rows - 4,
          `height=${scroller()?.scrollHeight}, viewport=${scroller()?.scrollViewportHeight}`)
        check(`goal ${width} cols: resizing keeps panel chrome fixed`, JSON.stringify(ruleRows()) === JSON.stringify(rules))
      }
      const hit = termTest.findText(goalTerm, 'GOAL_HEAD')
      if (hit !== null) goalIn.write(`\x1b[<35;${hit.col + 1};${hit.row + 1}M`)
      await sleep(700) // 固定窗:墙钟 fully visible wrapped goals must stay silent after tooltip dwell.
      check('goal panel: fully visible wrapped objective has no truncation tooltip', getTooltipSnapshot() === null)
    } else {
      check('short goal panel: measured content exceeds only its own viewport',
        (scroller()?.scrollHeight ?? 0) > rows - 4 && scroller()?.scrollViewportHeight === rows - 4)
      // Real focused-panel arrow bytes must expose the goal tail and todo rows.
      goalIn.write('\x1b[B'.repeat(100))
      check('short goal panel: scroll reaches full goal tail, badge, first todo and overflow summary',
        await settled(() => screen().some(line => line.includes('GOAL_TAIL'))
          && screen().some(line => line.includes('active ·')) && screen().some(line => line.includes('task-0'))
          && screen().some(line => line.includes('more'))), screen().join('\n'))
      check('short goal panel: total scroll height uses a minimum todo budget, not the full list',
        scroller()?.scrollHeight === 1 + expectedGoalRows() + 1 + 1 + 3,
        `height=${scroller()?.scrollHeight}, goalRows=${expectedGoalRows()}`)
      goalIn.write('\x1b[A'.repeat(100))
      check('short goal panel: arrows scroll back to the objective head', await settled(() => screen().some(line => line.includes('GOAL_HEAD'))))
      // The wheel is routed by its coordinates even while chat owns the keys.
      controller?.focusChat()
      await termTest.settle(() => controller?.focus === 'chat')
      goalIn.write(`\x1b[<65;${columns - 10};4M`.repeat(30))
      check('short goal panel: mouse wheel also reaches the todo list', await settled(() => screen().some(line => line.includes('task-0'))))
      const top = scroller()?.scrollTop
      goalIn.write('\x1b[A')
      await sleep(100) // 固定窗:探针 chat-focused arrows must not scroll the sidebar.
      check('short goal panel: chat-focused arrows do not scroll the sidebar', scroller()?.scrollTop === top)
      check('short goal panel: scrolling preserves panel chrome', JSON.stringify(ruleRows()) === JSON.stringify(rules))
      goalChannel.goal = { ...goalChannel.goal, id: 'replacement-goal' }
      instance.rerender(tree())
      check('short goal panel: a replacement goal starts at its head', await settled(() => scroller()?.scrollTop === 0 && screen().some(line => line.includes('GOAL_HEAD'))))
      goalIn.write(`\x1b[<65;${columns - 10};4M`.repeat(30))
      await termTest.settle(() => screen().some(line => line.includes('task-0')))
      goalChannel.sessionId = 'replacement-session'
      instance.rerender(tree())
      check('short goal panel: changing sessions resets the retained panel scroll', await settled(() => scroller()?.scrollTop === 0 && screen().some(line => line.includes('GOAL_HEAD'))))
    }
  } finally {
    clearTooltip()
    await instance.unmount()
    goalTerm.dispose()
  }
}

await goalLayout(34)
await goalLayout(12)

if (failed > 0) {
  console.error('FAILED: ' + failed + ' check(s).')
  process.exit(1)
}
console.log('OK: todo side panel all checks passed.')
process.exit(0)
