/**
 * Plugin footer fields (`tuiStatus.setField`) regression.
 *
 * Part A — admission, against a real Cordis composition: the returned
 * disposer, option normalization, every refusal path (key/text/tone/slot/
 * maxCells/minColumns/onClick-without-detail), token semantics, activation
 * ownership, caps (6 total / 2 per activation), effect cleanup on fiber
 * dispose, bidi stripping, and effect-ledger records with kind `status-field`.
 *
 * Part B — rendering, against the real StatusLine through `@xterm/headless`:
 * zero-footprint default, the three slots and in-slot order, the user switch,
 * minimal UI, `minColumns`, a width ladder, compact mode, hover detail, click
 * dispatch, and a throwing click plus a REJECTED async click that must both be
 * reported (never reach the renderer). The toast itself is Chat's wiring
 * (`setFieldErrorHandler` → `channel.notify`); this battery drives the same
 * handler shape Chat installs.
 *
 * Part C — single-line adaptive degradation, still through real StatusLine:
 * 30/40/60/80/120/200 columns in inline/fullscreen and compact/split layouts,
 * whole-field removal and accurate +N, model/mode/ctx priority, cell-aware
 * Unicode and long route/path/title inputs, full hidden-field hover tooltips,
 * resize recovery, and stale hover cleanup after content-only hiding.
 * No layout-planner internals are imported.
 *
 * Run: node --import tsx/esm scripts/verify-status-fields.tsx
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// HOME/USERPROFILE must be isolated before any src import (paths.ts captures
// DATA_DIR at module load).
const fakeHome = mkdtempSync(join(tmpdir(), 'verify-status-fields-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
process.env.DSH_TUI_LANG = 'zh'
// Colour on: the tone cases assert themed cells, and the zero-footprint case
// compares real frames rather than plain text.
process.env.FORCE_COLOR = '3'

const [
  { Context },
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  ui,
  statusModule,
  ledgerModule,
  termTest,
  { stringWidth },
] = await Promise.all([
  import('@deepseek-ai/cordis'),
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/dsh-adapter/status.js'),
  import('../src/dsh-adapter/effect-ledger.js'),
  import('./lib/term-test.mjs'),
  import('../src/ink/stringWidth.js'),
])

const { TuiStatusRuntime, getHostStatusStore } = statusModule
const { TuiEffectLedgerRuntime } = ledgerModule
const [{ StatusLine }, { TooltipLayer }, { DEFAULT_STATUS_BAR }] = await Promise.all([
  import('../src/screens/StatusLine.js'),
  import('../src/components/Tooltip.js'),
  import('../src/tuiDisplayPrefs.js'),
])
const { sleep, settled, screenHas, findText, viewportLines } = termTest

let failures = 0
let checks = 0
function check(name: string, ok: boolean, detail = ''): void {
  checks += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${ok || detail === '' ? '' : `  (${detail})`}`)
  if (!ok) failures += 1
}

// ── Part A: admission ───────────────────────────────────────────────────────

const ledgerFile = join(fakeHome, 'ledger.jsonl')
const root = new Context()
const warnings: string[] = []
root.logger.exporter({
  colors: false,
  levels: { default: 4 },
  export(message: { type: string; args: unknown[] }): void {
    if (message.type === 'warn') {
      warnings.push(message.args.map(arg => (typeof arg === 'string' ? arg : String(arg))).join(' '))
    }
  },
})
new TuiEffectLedgerRuntime(root, { file: ledgerFile, generationId: 'status-fields-battery' })
await root.plugin(TuiStatusRuntime)

const store = getHostStatusStore(root.get('tuiStatus'))
if (store === undefined) throw new Error('status store accessor unavailable')
const fieldOf = (key: string) => store.getFieldSnapshot().find(field => field.key === key)
const warnCount = () => warnings.length
/** One persisted ledger record, narrowed to the fields this battery reads. */
interface LedgerRecord {
  operation?: string
  resource?: { kind?: string; id?: string }
}
const ledgerRecords = (): LedgerRecord[] =>
  readFileSync(ledgerFile, 'utf8').split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as LedgerRecord)

/** Mount one plugin activation; the callback runs inside its fiber. */
async function activate(run: (ctx: Context) => void) {
  const fiber = root.inject(['tuiStatus', 'tuiEffectLedger'], (pluginCtx: Context) => {
    run(pluginCtx)
  })
  await fiber
  return fiber
}

/** Every refusal must warn and leave the store untouched, never throw. */
async function refused(name: string, run: (ctx: Context) => void): Promise<void> {
  const before = warnCount()
  const beforeFields = store.getFieldSnapshot().length
  let threw: unknown
  const fiber = await activate(ctx => {
    try {
      run(ctx)
    } catch (error) {
      threw = error
    }
  })
  check(`${name}: refused without throwing`, threw === undefined, String(threw))
  check(`${name}: warned`, warnCount() > before)
  check(`${name}: no field entered the store`, store.getFieldSnapshot().length === beforeFields)
  await fiber.dispose()
}

// A1 — admitted field, normalized entry, disposer.
{
  store.clear()
  let dispose: (() => void) | undefined
  const fiber = await activate(ctx => {
    dispose = ctx.tuiStatus.setField('build', '构建 42%', {
      slot: 'right-head',
      tone: 'success',
      maxCells: 20,
      minColumns: 100,
      detail: 'watch #42',
      onClick: () => {},
    })
  })
  const entry = fieldOf('build')
  check('A1 entry carries normalized options',
    entry !== undefined
    && entry.text === '构建 42%'
    && entry.slot === 'right-head'
    && entry.tone === 'success'
    && entry.maxCells === 20
    && entry.minColumns === 100
    && entry.detail === 'watch #42'
    && typeof entry.onClick === 'function',
    JSON.stringify(entry))
  check('A1 disposer is a function', typeof dispose === 'function')
  dispose?.()
  check('A1 disposer clears its own field', fieldOf('build') === undefined)
  await fiber.dispose()
}

// A2 — invalid key, text, and options.
{
  store.clear()
  await refused('A2 invalid key', ctx => ctx.tuiStatus.setField('Bad Key', 'x'))
  await refused('A2 non-scalar text', ctx => ctx.tuiStatus.setField('obj', { nope: true }))
  await refused('A2 invalid tone', ctx => ctx.tuiStatus.setField('tone', 'x', { tone: 'rainbow' }))
  await refused('A2 invalid slot', ctx => ctx.tuiStatus.setField('slot', 'x', { slot: 'middle' }))
  await refused('A2 fractional maxCells', ctx => ctx.tuiStatus.setField('cells', 'x', { maxCells: 1.5 }))
  await refused('A2 string maxCells', ctx => ctx.tuiStatus.setField('cells2', 'x', { maxCells: '20' }))
  await refused('A2 fractional minColumns', ctx => ctx.tuiStatus.setField('cols', 'x', { minColumns: 1.5 }))
  await refused('A2 non-object options', ctx => ctx.tuiStatus.setField('opts', 'x', null))
  await refused('A2 non-string detail', ctx => ctx.tuiStatus.setField('detail', 'x', { detail: 42 }))
  // A throwing getter is plugin-supplied input too: the documented contract is
  // reject-and-warn, never an exception escaping into the caller.
  await refused('A2 unreadable options', ctx => {
    ctx.tuiStatus.setField('getter', 'x', { get slot(): never { throw new Error('boom') } })
  })
}

// A3 — cell-accurate truncation for wide and combining text.
{
  store.clear()
  const fiber = await activate(ctx => {
    ctx.tuiStatus.setField('cjk', '构建构建构建构建构建', { maxCells: 8 })
    ctx.tuiStatus.setField('emoji', '🙂🙂🙂🙂🙂🙂🙂', { maxCells: 5 })
  })
  const cjk = fieldOf('cjk')
  const emoji = fieldOf('emoji')
  check('A3 CJK text capped in cells with an ellipsis',
    cjk !== undefined && stringWidth(cjk.text) <= 8 && cjk.text.endsWith('…'),
    `${JSON.stringify(cjk?.text)} width=${cjk === undefined ? 'n/a' : stringWidth(cjk.text)}`)
  check('A3 emoji text capped in cells with an ellipsis',
    emoji !== undefined && stringWidth(emoji.text) <= 5 && emoji.text.endsWith('…'),
    `${JSON.stringify(emoji?.text)} width=${emoji === undefined ? 'n/a' : stringWidth(emoji.text)}`)
  await fiber.dispose()
}

// A4 — maxCells clamps to [1, 32] and defaults to 16.
{
  store.clear()
  let high = 0
  let low = 0
  let def = 0
  const fiber = await activate(ctx => {
    ctx.tuiStatus.setField('clamp', 'x', { maxCells: 999 })
    high = fieldOf('clamp')?.maxCells ?? -1
    ctx.tuiStatus.setField('clamp', undefined)
    ctx.tuiStatus.setField('clamp', 'x', { maxCells: 0 })
    low = fieldOf('clamp')?.maxCells ?? -1
    ctx.tuiStatus.setField('clamp', undefined)
    ctx.tuiStatus.setField('clamp', 'x')
    def = fieldOf('clamp')?.maxCells ?? -1
  })
  check('A4 maxCells clamps to 32 / 1, defaults to 16', high === 32 && low === 1 && def === 16, `${high}/${low}/${def}`)
  await fiber.dispose()
}

// A5 — a clickable field owes a detail line; clearing the detail retracts it.
{
  store.clear()
  await refused('A5 onClick without detail', ctx => {
    ctx.tuiStatus.setField('click', 'x', { onClick: () => {} })
  })
  let fiber = await activate(ctx => {
    ctx.tuiStatus.setField('click', 'CLICK', { detail: 'why', onClick: () => {} })
  })
  check('A5 onClick with detail is admitted', typeof fieldOf('click')?.onClick === 'function')
  await refused('A5 clearing detail while a click survives', ctx => {
    ctx.tuiStatus.setField('click', 'CLICK', { detail: '' })
  })
  check('A5 the refused update kept the original detail', fieldOf('click')?.detail === 'why')
  await fiber.dispose()
}

// A6 — a throwing click is logged/reported once and never escapes.
{
  store.clear()
  let handledKey: string | undefined
  let handledMessage: string | undefined
  store.setFieldErrorHandler((key, error) => {
    handledKey = key
    handledMessage = error.message
  })
  let click: (() => void) | undefined
  const fiber = await activate(ctx => {
    ctx.tuiStatus.setField('boom', 'BOOM', { detail: 'Boom detail', onClick: () => { throw new Error('kaboom') } })
    click = fieldOf('boom')?.onClick
  })
  let escaped: unknown
  try {
    click?.()
  } catch (error) {
    escaped = error
  }
  // The funnel reports on a microtask (`Promise.resolve().then(...)`), so the
  // synchronous half is checked first, then the report.
  await new Promise<void>(resolve => setImmediate(resolve))
  check('A6 click error is swallowed', escaped === undefined, String(escaped))
  check('A6 error handler sees the key and the error once', handledKey === 'boom' && handledMessage === 'kaboom',
    `${handledKey}/${handledMessage}`)
  store.setFieldErrorHandler(undefined)
  await fiber.dispose()
}

// A7 — another activation can neither update nor clear an owned field.
{
  store.clear()
  const first = await activate(ctx => {
    ctx.tuiStatus.setField('owned', 'mine')
  })
  const second = await activate(ctx => {
    ctx.tuiStatus.setField('owned', 'theirs')
    ctx.tuiStatus.setField('owned', undefined)
  })
  check('A7 foreign update/clear is refused, original survives', fieldOf('owned')?.text === 'mine')
  await second.dispose()
  await first.dispose()
}

// A8 — an old disposer must not clear a newer write (token, not text).
{
  store.clear()
  let oldDispose: (() => void) | undefined
  const fiber = await activate(ctx => {
    oldDispose = ctx.tuiStatus.setField('token', 'first')
    ctx.tuiStatus.setField('token', 'second')
  })
  oldDispose?.()
  check('A8 stale disposer leaves the newer value intact', fieldOf('token')?.text === 'second')
  await fiber.dispose()
}

// A9 — ctx.effect cleanup on plugin dispose, and a reload re-admits the key.
{
  store.clear()
  const first = await activate(ctx => {
    const dispose = ctx.tuiStatus.setField('reload', 'v1')
    ctx.effect(() => () => dispose())
  })
  check('A9 field is visible before dispose', fieldOf('reload')?.text === 'v1')
  await first.dispose()
  check('A9 fiber dispose removes the field', fieldOf('reload') === undefined)
  const second = await activate(ctx => {
    ctx.tuiStatus.setField('reload', 'v2')
  })
  check('A9 reloaded activation re-admits the same key', fieldOf('reload')?.text === 'v2')
  await second.dispose()
}

// A10 — the composition root is not a plugin activation.
{
  store.clear()
  let threw: unknown
  try {
    root.get('tuiStatus')?.setField('root-leak', 'x')
  } catch (error) {
    threw = error
  }
  check('A10 root call is refused without throwing', threw === undefined, String(threw))
  check('A10 root call leaves no field', fieldOf('root-leak') === undefined)
}

// A11 — two per activation, six in total.
{
  store.clear()
  const before = warnCount()
  const single = await activate(ctx => {
    ctx.tuiStatus.setField('one', '1')
    ctx.tuiStatus.setField('two', '2')
    ctx.tuiStatus.setField('three', '3')
  })
  check('A11 third field from one activation is refused', store.getFieldSnapshot().length === 2 && warnCount() > before)
  await single.dispose()

  store.clear()
  const fibers = []
  for (let index = 0; index < 3; index += 1) {
    fibers.push(await activate(ctx => {
      ctx.tuiStatus.setField(`p${index}-a`, 'a')
      ctx.tuiStatus.setField(`p${index}-b`, 'b')
    }))
  }
  check('A11 six fields from three activations are admitted', store.getFieldSnapshot().length === 6)
  const beforeSeventh = warnCount()
  const fourth = await activate(ctx => {
    ctx.tuiStatus.setField('seventh', '7')
  })
  check('A11 seventh field is refused', store.getFieldSnapshot().length === 6 && warnCount() > beforeSeventh)
  await fourth.dispose()
  for (const fiber of fibers) await fiber.dispose()
}

// A12 — the effect ledger records bind / replace / release with kind status-field.
{
  store.clear()
  const fiber = await activate(ctx => {
    ctx.tuiStatus.setField('ledger-x', 'one', {}, ctx)
    ctx.tuiStatus.setField('ledger-x', 'two', {}, ctx)
  })
  // Dispose the explicit first write: the second one still owns the key.
  await fiber.dispose()
  const records = ledgerRecords().filter(record => record.resource?.id === 'ledger-x')
  const ops = records.map(record => record.operation)
  check('A12 ledger records bind + replace', ops.includes('bind') && ops.includes('replace'), ops.join(','))
  check('A12 ledger records release on dispose', ops.includes('release'), ops.join(','))
  check('A12 ledger kind is status-field', records.every(record => record.resource?.kind === 'status-field'))
}

// A13 — bidi controls and invisible separators never reach a footer cell;
// the joiners (ZWNJ/ZWJ) DO, because they carry orthography and compose emoji.
{
  store.clear()
  const fiber = await activate(ctx => {
    ctx.tuiStatus.setField('bidi', 'ab\u202Ecd\u200Bef', { detail: 'x\u202Ey\uFEFF' })
    ctx.tuiStatus.setField('joiners', '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200Cab')
  })
  check('A13 bidi/invisible marks stripped from text', fieldOf('bidi')?.text === 'abcdef', JSON.stringify(fieldOf('bidi')?.text))
  check('A13 bidi/invisible marks stripped from detail', fieldOf('bidi')?.detail === 'xy', JSON.stringify(fieldOf('bidi')?.detail))
  check('A13 joiners survive (emoji ZWJ sequence, ZWNJ)',
    fieldOf('joiners')?.text === '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200Cab',
    JSON.stringify(fieldOf('joiners')?.text))
  await fiber.dispose()
}

// ── Part B: rendering ───────────────────────────────────────────────────────

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
    gitBranch: false,
    sessionTitle: false,
    sessionId: false,
    goal: false,
    mode: false,
    contextBar: false,
    activity: false,
    trajectory: false,
    shortcutHint: false,
    pluginFields: true,
    pluginFieldsOrder: '*',
  },
  model: 'MODELX',
  provider: 'test-provider',
  contextWindow: 64_000,
  displayCwd: '/w/uniqdir',
  cwd: '/w/uniqdir',
  mode: { plan: false, sandbox: 'workspace-write', approval: 'on-request' },
  modeIndex: 0,
  tokens: { input: 1200, output: 34 },
  tpsSamples: [],
  backgroundJobs: [],
  contextSegments: {},
  working: false,
  activityFrames: [],
  agentId: 'abcdef0123456789',
  sessionRef: { sessionId: 'abcdef0123456789' },
  reasoningEffort: undefined,
  tps: undefined,
  lastUsage: undefined,
  contextBarEnabled: false,
  gitBranch: 'main',
}

function channelWith(statusBar: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  return {
    ...BASE_CHANNEL,
    ...overrides,
    statusBar: { ...BASE_CHANNEL.statusBar, ...statusBar },
  }
}

/** One renderable field, with overrides. */
function field(overrides: Record<string, unknown> = {}) {
  return {
    key: 'note',
    text: 'NOTEX',
    slot: 'left-tail',
    tone: 'dim',
    maxCells: 16,
    minColumns: 0,
    ...overrides,
  }
}

class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}

function makeRig(cols: number, rows: number) {
  const term = new XTerm({ cols, rows, scrollback: 0, allowProposedApi: true })
  class FakeOutput extends Writable {
    columns = cols
    rows = rows
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
      term.write(String(chunk), callback)
    }
  }
  const stdout = new FakeOutput()
  return {
    term, stdout, stderr: new FakeOutput(), stdin: new FakeStdin(),
    // Writable callbacks follow xterm's parse callback, so this drains every
    // queued terminal write without guessing a renderer/CI timing window.
    flush: () => new Promise<void>(resolve => { stdout.write('', () => resolve()) }),
  }
}

function KeySink(): null {
  ui.useInput(() => {})
  return null
}

function statusNode(
  props: Record<string, unknown>,
  channel: Record<string, unknown>,
  fullscreen = true,
  tooltips = false,
) {
  const body = React.createElement(
    ui.Box,
    { flexDirection: 'column' },
    React.createElement(KeySink),
    React.createElement(StatusLine, { channel: channel as never, ...props }),
    tooltips ? React.createElement(TooltipLayer) : null,
  )
  return fullscreen ? React.createElement(ui.AlternateScreen, null, body) : body
}

/** Hover: SGR mode-1003 motion with no buttons (coords 1-indexed). */
const hover = (stdin: FakeStdin, col: number, row: number): void => {
  stdin.write(`\x1b[<35;${col};${row}M`)
}

/** The footer's status row: row 0 without the context bar, row 1 with it. */
const statusRow = (lines: readonly string[], needle = 'MODELX'): string =>
  lines.find(line => line.includes(needle)) ?? ''

/** The status row as the terminal holds it, trailing blank cells intact.
 *  `viewportLines` trims them, and an edge assertion needs to see them. */
const rawStatusRow = (term: InstanceType<typeof XTerm>, needle = 'MODELX'): string => {
  const buffer = term.buffer.active
  for (let y = 0; y < term.rows; y += 1) {
    const line = buffer.getLine(buffer.baseY + y)?.translateToString(false) ?? ''
    if (line.includes(needle)) return line
  }
  return ''
}

/** Press + release at the first on-screen occurrence of `needle`. */
async function clickText(stdin: FakeStdin, term: InstanceType<typeof XTerm>, needle: string): Promise<boolean> {
  const at = findText(term, needle)
  if (at === null) return false
  stdin.write(`\x1b[<0;${at.col + 1};${at.row + 1}M`)
  await sleep(30) // 固定窗:pacing 鼠标 press→release 步间
  stdin.write(`\x1b[<0;${at.col + 1};${at.row + 1}m`)
  return true
}

async function mountStatus(
  cols: number,
  props: Record<string, unknown>,
  channel: Record<string, unknown>,
  fullscreen = true,
  tooltips = false,
) {
  const rig = makeRig(cols, tooltips ? 40 : 12)
  let frames = 0
  const instance = await ui.render(statusNode(props, channel, fullscreen, tooltips), {
    stdout: rig.stdout as unknown as NodeJS.WriteStream,
    stdin: rig.stdin as unknown as NodeJS.ReadStream,
    exitOnCtrlC: false,
    patchConsole: false,
    onFrame: () => { frames += 1 },
  })
  const flushFrame = async (after: number): Promise<void> => {
    if (!await settled(() => frames > after)) throw new Error('StatusLine did not paint a frame')
    await rig.flush()
  }
  await flushFrame(0)
  return {
    ...rig,
    instance,
    lines: () => viewportLines(rig.term),
    async rerender(props: Record<string, unknown>, channel: Record<string, unknown>): Promise<void> {
      const before = frames
      instance.rerender(statusNode(props, channel, fullscreen, tooltips))
      await flushFrame(before)
    },
    async resize(width: number): Promise<void> {
      const before = frames
      rig.term.resize(width, rig.term.rows)
      rig.stdout.columns = width
      rig.stdout.emit('resize')
      await flushFrame(before)
    },
    async close(): Promise<void> {
      instance.unmount()
      await rig.flush()
      instance.cleanup()
      rig.term.dispose()
    },
  }
}

async function capture(cols: number, props: Record<string, unknown>, channel = BASE_CHANNEL): Promise<string[]> {
  const rig = makeRig(cols, 12)
  const instance = await ui.render(statusNode(props, channel), {
    stdout: rig.stdout as unknown as NodeJS.WriteStream,
    stdin: rig.stdin as unknown as NodeJS.ReadStream,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  await settled(() => screenHas(rig.term, 'MODELX'))
  await sleep(120) // 固定窗:pacing 等首帧/卸载落定，无单一可轮询锚点
  const lines = viewportLines(rig.term)
  instance.unmount()
  await sleep(120) // 固定窗:pacing 等首帧/卸载落定，无单一可轮询锚点
  rig.term.dispose()
  return lines
}

try {
  // R1/R12 — zero footprint: an absent list and an empty list are identical.
  {
    const absent = await capture(100, {})
    const empty = await capture(100, { pluginFields: [] })
    check('R1/R12 no plugin fields → identical screen rows', absent.join('\n') === empty.join('\n'),
      JSON.stringify({ absent, empty }))
    check('R1 no plugin fields → no extra footer row', absent.slice(2).every(line => line.trim() === ''),
      JSON.stringify(absent))
  }

  // R2 — left-tail appends to the left group's end.
  {
    const lines = await capture(100, {
      pluginFields: [field({ key: 'lt', text: 'LTX', slot: 'left-tail' })],
    }, channelWith({ tokens: true }))
    const row = statusRow(lines)
    check('R2 left-tail sits after the built-in left fields',
      row.includes('LTX')
      // `indexOf` is -1 for a missing anchor, so every anchor must be proven
      // present before its position is compared.
      && row.includes('MODELX') && row.includes('34') && row.includes('uniqdir')
      && row.indexOf('MODELX') < row.indexOf('LTX')
      && row.indexOf('LTX') > row.indexOf('34')
      && row.indexOf('LTX') < row.indexOf('uniqdir'),
      JSON.stringify(row))
  }

  // R3 — right-head before the host right group, right-tail after it. The
  // compact row is one chain, so this proves ORDER, not the right edge; the
  // split-layout case (R15) owns the edge assertion.
  {
    const lines = await capture(100, {
      pluginFields: [
        field({ key: 'rh', text: 'HEADX', slot: 'right-head' }),
        field({ key: 'rt', text: 'TAILX', slot: 'right-tail' }),
      ],
    }, channelWith({ gitBranch: true, sessionId: true }))
    const row = statusRow(lines)
    check('R3 right-head precedes git/cwd/sessionId',
      row.includes('HEADX') && row.includes('main') && row.includes('uniqdir') && row.includes('#abcdef01')
      && row.indexOf('HEADX') < row.indexOf('main')
      && row.indexOf('HEADX') < row.indexOf('uniqdir')
      && row.indexOf('HEADX') < row.indexOf('#abcdef01'), JSON.stringify(row))
    check('R3 right-tail follows the right group',
      row.includes('TAILX') && row.includes('#abcdef01') && row.indexOf('TAILX') > row.indexOf('#abcdef01'),
      JSON.stringify(row))
  }

  // R11 — compact merges the groups and the slots follow their group.
  {
    const lines = await capture(120, {
      pluginFields: [
        field({ key: 'lt', text: 'LTX', slot: 'left-tail' }),
        field({ key: 'rh', text: 'HEADX', slot: 'right-head' }),
        field({ key: 'rt', text: 'TAILX', slot: 'right-tail' }),
      ],
    }, channelWith({ gitBranch: true, sessionId: true }))
    const row = statusRow(lines)
    check('R11 compact: slots keep their group position',
      row.includes('MODELX') && row.includes('LTX') && row.includes('HEADX')
      && row.includes('main') && row.includes('#abcdef01') && row.includes('TAILX')
      && row.indexOf('MODELX') < row.indexOf('LTX')
      && row.indexOf('LTX') < row.indexOf('HEADX')
      && row.indexOf('HEADX') < row.indexOf('main')
      && row.indexOf('main') < row.indexOf('#abcdef01')
      && row.indexOf('#abcdef01') < row.indexOf('TAILX'), JSON.stringify(row))
  }

  // R15 — the split layout keeps the groups apart: right-head opens the right
  // group, right-tail closes it, and the row's right edge is actually the
  // field's (the compact cases above only prove chain order). Drawn through a
  // dedicated rig: the edge claim needs the UNTRIMMED terminal row.
  {
    const COLUMNS = 100
    const rig = makeRig(COLUMNS, 12)
    const instance = await ui.render(
      statusNode({
        pluginFields: [
          field({ key: 'lt', text: 'LTX', slot: 'left-tail' }),
          field({ key: 'rh', text: 'HEADX', slot: 'right-head' }),
          field({ key: 'rt', text: 'TAILX', slot: 'right-tail' }),
        ],
      }, channelWith(
        { compact: false, gitBranch: true, sessionId: true, contextUsage: true },
        { contextOccupancy: { usedTokens: 12_500, contextWindow: 64_000 } },
      )),
      {
        stdout: rig.stdout as unknown as NodeJS.WriteStream,
        stdin: rig.stdin as unknown as NodeJS.ReadStream,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    )
    try {
      check('R15 split: status row ready', await settled(() => screenHas(rig.term, 'MODELX')))
      const row = rawStatusRow(rig.term)
      check('R15 split: slots follow their own groups',
        row.includes('LTX') && row.includes('HEADX') && row.includes('TAILX')
        && row.includes('main') && row.includes('uniqdir') && row.includes('#abcdef01')
        && row.indexOf('LTX') < row.indexOf('HEADX')
        && row.indexOf('HEADX') < row.indexOf('main')
        && row.indexOf('main') < row.indexOf('uniqdir')
        && row.indexOf('uniqdir') < row.indexOf('#abcdef01')
        && row.indexOf('#abcdef01') < row.indexOf('TAILX'), JSON.stringify(row))
      // The ctx chip is the trailing element that makes both claims
      // falsifiable: it belongs to the LEFT group (immediately after the
      // left-tail field, before right-head), and in compact mode it trails
      // the whole chain instead (see the seam docs). Order alone is not
      // enough — ctx at the HEAD of the right group gives the same
      // `LTX < ctx < HEADX` order at the opposite end of the row, so the
      // assertion pins the ` · ` adjacency.
      check('R15 split: ctx keeps the left group',
        row.includes('ctx')
        && row.includes('LTX · ctx')
        && row.indexOf('ctx') < row.indexOf('HEADX'), JSON.stringify(row))
      // …and right-head OPENS the right group. The string order above cannot
      // tell: moving the slot into the left group after ctx keeps every order
      // and `LTX · ctx` intact, and only leaves the flex gap between HEADX and
      // the first built-in right field. The adjacency is what breaks.
      check('R15 split: right-head opens the right group',
        row.includes('HEADX · main')
        && row.indexOf('HEADX') < row.indexOf('main'), JSON.stringify(row))
      // Width 100 minus the footer's 1-cell padding: the last content cell is
      // column 99, so the trimmed content must be 99 cells AND end in TAILX.
      // `trimEnd()` alone would accept blank cells after the field.
      const content = row.replace(/\s+$/, '')
      check('R15 split: right-tail sits on the row\'s right edge',
        content.endsWith('TAILX') && content.length === COLUMNS - 1, JSON.stringify(row))
    } finally {
      instance.unmount()
      await sleep(120) // 固定窗:pacing 等首帧/卸载落定，无单一可轮询锚点
      rig.term.dispose()
    }
  }

  // R16 — compact cwd keeps the project anchor once the session moves. The
  // leaf alone (`ink`, `try`) says where the session is but not which project
  // it belongs to; the breadcrumb keeps both.
  {
    const moved = (workingDirectory: string | undefined) => channelWith({}, {
      cwd: '/w/app',
      displayCwd: '/w/app',
      workingDirectory,
    })
    const still = await capture(100, {}, moved(undefined))
    const inside = await capture(100, {}, moved('/w/app/src/ink'))
    const deep = await capture(100, {}, moved('/w/app/' + 'nested/'.repeat(6) + 'leaf'))
    const outside = await capture(100, {}, moved('/other/repo'))
    check('R16 unmoved session shows the bare project name',
      statusRow(still).includes('app') && !statusRow(still).includes('›'),
      JSON.stringify(statusRow(still)))
    check('R16 in-project move shows project›relative',
      statusRow(inside).includes('app›src/ink'), JSON.stringify(statusRow(inside)))
    check('R16 deep path truncates from the left, keeping the anchor and leaf',
      statusRow(deep).includes('app›…/nested/nested/nested/leaf'), JSON.stringify(statusRow(deep)))
    check('R16 outside move shows project→path',
      statusRow(outside).includes('app→') && statusRow(outside).includes('other/repo'),
      JSON.stringify(statusRow(outside)))
    // A narrow footer is the tightest budget: the anchor must survive even
    // when the target has to truncate, and the footer must stay one line.
    // `statusRow` alone cannot prove the second half: a wrapped continuation
    // leaves the MODELX line and its anchor intact, and every viewport line is
    // at most the terminal width. Inspect the whole viewport instead: only
    // the status row may carry text.
    const narrow = async (target: string): Promise<{ row: string; lines: readonly string[] }> => {
      const lines = await capture(40, {}, moved(target))
      return { row: statusRow(lines), lines }
    }
    const narrowInside = await narrow('/w/app/src/ink')
    const narrowDeep = await narrow('/w/app/' + 'nested/'.repeat(6) + 'leaf')
    const narrowOutside = await narrow('/other/' + 'nested/'.repeat(6) + 'leaf')
    const oneFooterRow = (sample: { row: string; lines: readonly string[] }): boolean =>
      sample.lines.every(line => line === sample.row || line.trim() === '')
    check('R16 narrow footer keeps the anchor on one line',
      narrowInside.row.includes('app›') && narrowDeep.row.includes('app›') && narrowOutside.row.includes('app→')
      && [narrowInside, narrowDeep, narrowOutside].every(oneFooterRow),
      JSON.stringify([narrowInside, narrowDeep, narrowOutside].map(sample =>
        sample.lines.filter(line => line.trim() !== ''))))
  }

  // R13 — stable registration order inside one slot.
  {
    const lines = await capture(100, {
      pluginFields: [
        field({ key: 'a', text: 'AAAX', slot: 'left-tail' }),
        field({ key: 'b', text: 'BBBX', slot: 'left-tail' }),
        field({ key: 'c', text: 'CCCX', slot: 'right-head' }),
        field({ key: 'd', text: 'DDDX', slot: 'right-head' }),
      ],
    })
    const row = statusRow(lines)
    check('R13 same-slot fields keep registration order',
      ['AAAX', 'BBBX', 'CCCX', 'DDDX'].every(token => row.includes(token))
      && row.indexOf('AAAX') < row.indexOf('BBBX') && row.indexOf('CCCX') < row.indexOf('DDDX')
      && row.indexOf('BBBX') < row.indexOf('CCCX'), JSON.stringify(row))
  }

  // O1-O8 — the user's ordered list (statusBar.pluginFieldsOrder).
  {
    const four = () => [
      field({ key: 'a', text: 'AAAX', slot: 'left-tail' }),
      field({ key: 'b', text: 'BBBX', slot: 'left-tail' }),
      field({ key: 'c', text: 'CCCX', slot: 'right-head' }),
      field({ key: 'd', text: 'DDDX', slot: 'right-tail' }),
    ]

    // O1 — the default `*` keeps registration order (no explicit value at all).
    const auto = await capture(100, { pluginFields: four() }, channelWith({ pluginFieldsOrder: '*' }))
    const autoRow = statusRow(auto)
    check('O1 `*` renders registration order',
      ['AAAX', 'BBBX', 'CCCX', 'DDDX'].every(token => autoRow.includes(token))
      && autoRow.indexOf('AAAX') < autoRow.indexOf('BBBX')
      && autoRow.indexOf('BBBX') < autoRow.indexOf('CCCX')
      && autoRow.indexOf('CCCX') < autoRow.indexOf('DDDX'), JSON.stringify(autoRow))

    // O2 — `''` means none, independent of the master switch.
    const none = await capture(100, { pluginFields: four() }, channelWith({ pluginFieldsOrder: '' }))
    check('O2 empty list hides every plugin field', none.every(line => !/AAA|BBB|CCC|DDD/u.test(line)))

    // O3 — the list reorders inside a slot.
    const reordered = await capture(100, { pluginFields: four() },
      channelWith({ pluginFieldsOrder: 'b,a;;' }))
    const reorderedRow = statusRow(reordered)
    check('O3 list order wins inside a slot',
      reorderedRow.includes('BBBX') && reorderedRow.includes('AAAX')
      && reorderedRow.indexOf('BBBX') < reorderedRow.indexOf('AAAX')
      && !reorderedRow.includes('CCCX') && !reorderedRow.includes('DDDX'), JSON.stringify(reorderedRow))

    // O4 — the group index overrides the plugin-declared slot: `d` was declared
    // right-tail and is listed in group 1, so it joins the LEFT chain.
    const moved = await capture(100, { pluginFields: four() },
      channelWith({ pluginFieldsOrder: 'd;;' }))
    const movedRow = statusRow(moved)
    check('O4 listed group overrides the declared slot',
      movedRow.includes('DDDX') && movedRow.includes('MODELX') && movedRow.includes('uniqdir')
      && movedRow.indexOf('DDDX') > movedRow.indexOf('MODELX')
      && movedRow.indexOf('DDDX') < movedRow.indexOf('uniqdir') && !movedRow.includes('CCCX'),
      JSON.stringify(movedRow))

    // O5 — keys missing from the list are hidden.
    const partial = await capture(100, { pluginFields: four() },
      channelWith({ pluginFieldsOrder: 'c;;' }))
    const partialRow = statusRow(partial)
    check('O5 unlisted fields are hidden', partialRow.includes('CCCX')
      && !partialRow.includes('AAAX') && !partialRow.includes('BBBX') && !partialRow.includes('DDDX'),
      JSON.stringify(partialRow))

    // O6 — an unknown key is skipped, not rendered as a hole.
    const unknown = await capture(100, { pluginFields: four() },
      channelWith({ pluginFieldsOrder: 'a,zz;;' }))
    check('O6 unknown keys are skipped', statusRow(unknown).includes('AAAX')
      && !statusRow(unknown).includes('zz'), JSON.stringify(statusRow(unknown)))

    // O7 — the master switch outranks the list.
    const muted = await capture(100, { pluginFields: four() },
      channelWith({ pluginFields: false, pluginFieldsOrder: 'a,b,c,d;;' }))
    check('O7 pluginFields=false outranks the list', muted.every(line => !/AAA|BBB|CCC|DDD/u.test(line)))

    // O8 — a hand-edited invalid value falls back to `*` (show more, never hide).
    const invalid = await capture(100, { pluginFields: four() },
      channelWith({ pluginFieldsOrder: 'a;b' }))
    const invalidRow = statusRow(invalid)
    check('O8 invalid list renders as `*`',
      invalidRow.includes('AAAX') && invalidRow.includes('BBBX')
      && invalidRow.includes('CCCX') && invalidRow.includes('DDDX'), JSON.stringify(invalidRow))
  }

  // R4 — minimal UI never shows plugin fields.
  {
    const lines = await capture(100, { pluginFields: [field({ text: 'LTX' })] },
      { ...BASE_CHANNEL, minimalUi: true })
    check('R4 minimal UI hides plugin fields', lines.every(line => !line.includes('LTX')))
  }

  // R5 — the user switch hides them without touching the store.
  {
    const lines = await capture(100, { pluginFields: [field({ text: 'LTX' })] },
      channelWith({ pluginFields: false }))
    check('R5 statusBar.pluginFields=false hides plugin fields', lines.every(line => !line.includes('LTX')))
  }

  // R6 — minColumns is a per-field width gate.
  {
    const narrow = await capture(80, { pluginFields: [field({ text: 'LTX', minColumns: 100 })] })
    const wide = await capture(120, { pluginFields: [field({ text: 'LTX', minColumns: 100 })] })
    check('R6 field hidden below minColumns', narrow.every(line => !line.includes('LTX')))
    check('R6 field shown at/above minColumns', wide.some(line => line.includes('LTX')))
  }

  // R7 — width ladder: no wrapping, no footer growth.
  {
    const barChannel = (cols: number) => channelWith(
      { contextBar: true, contextUsage: true },
      {
        contextBarEnabled: true,
        contextSegments: { system: 1200, prompt: 300, assistant: 4000, thinking: 5000, tools: 2000 },
        contextOccupancy: { usedTokens: 12_500, contextWindow: 64_000 },
        displayCwd: '/w/' + 'nested/'.repeat(6) + 'uniqdir',
        cwd: '/w/' + 'nested/'.repeat(6) + 'uniqdir',
      },
    )
    const fields = [
      field({ key: 'lt', text: 'LONGLEFTFIELDTEXT', slot: 'left-tail', maxCells: 32 }),
      field({ key: 'rh', text: 'LONGRIGHTFIELDTEXT', slot: 'right-head', maxCells: 32 }),
    ]
    for (const cols of [60, 80, 120, 160]) {
      const lines = await capture(cols, { pluginFields: fields }, barChannel(cols))
      const row = statusRow(lines)
      check(`R7 ${cols} cols: footer stays within 3 rows`, lines.slice(3).every(line => line.trim() === ''),
        JSON.stringify(lines))
      check(`R7 ${cols} cols: status row keeps model and context usage`,
        row.includes('MODELX') && row.includes('20%') && (cols < 120 || row.includes('ctx')),
        JSON.stringify(row))
    }
  }

  // R8 — a long CJK field cannot push ctx or the bar off the row.
  {
    const lines = await capture(60, {
      pluginFields: [field({ key: 'wide', text: '构建构建构建构建构建构建构建构建构建构建构建构建', maxCells: 32 })],
    }, channelWith({ contextUsage: true }, {
      contextOccupancy: { usedTokens: 12_500, contextWindow: 64_000 },
    }))
    check('R8 long field truncates instead of overflowing the row',
      statusRow(lines, 'ctx').includes('ctx') && lines.slice(3).every(line => line.trim() === ''), JSON.stringify(lines))
  }

  // R9 — hover swaps the supplemental row to the plugin detail, and leaving
  // restores the idle state.
  {
    const rig = makeRig(100, 12)
    const instance = await ui.render(
      statusNode({ pluginFields: [field({ key: 'h', text: 'HOVERME', detail: 'DETAIL-LINE' })] }, BASE_CHANNEL),
      {
        stdout: rig.stdout as unknown as NodeJS.WriteStream,
        stdin: rig.stdin as unknown as NodeJS.ReadStream,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    )
    try {
      check('R9 field ready on screen', await settled(() => screenHas(rig.term, 'HOVERME')))
      const at = findText(rig.term, 'HOVERME')
      check('R9 hover target located', at !== null)
      if (at !== null) {
        hover(rig.stdin, at.col + 1, at.row + 1)
        check('R9 hover shows the plugin detail', await settled(() => screenHas(rig.term, 'DETAIL-LINE')))
        hover(rig.stdin, 1, 1)
        check('R9 leaving restores the idle row', await settled(() => !screenHas(rig.term, 'DETAIL-LINE')))
      }
    } finally {
      instance.unmount()
      await sleep(120) // 固定窗:pacing 等首帧/卸载落定，无单一可轮询锚点
      rig.term.dispose()
    }
  }

  // R10 — click dispatches once; a throwing click is reported and the TUI
  // keeps running. The entries come from a real activation, so the click the
  // renderer invokes is the host-WRAPPED one (the throw is caught in the
  // service, exactly as in production).
  {
    store.clear()
    const rig = makeRig(100, 12)
    let clicks = 0
    let reported: string | undefined
    store.setFieldErrorHandler(key => { reported = key })
    let pluginCtx: Context | undefined
    const fiber = await activate(ctx => {
      pluginCtx = ctx
      ctx.tuiStatus.setField('click', 'CLICKME', {
        detail: 'CLICK-DETAIL',
        onClick: () => { clicks += 1 },
      })
    })
    const instance = await ui.render(statusNode({ pluginFields: [...store.getFieldSnapshot()] }, BASE_CHANNEL), {
      stdout: rig.stdout as unknown as NodeJS.WriteStream,
      stdin: rig.stdin as unknown as NodeJS.ReadStream,
      exitOnCtrlC: false,
      patchConsole: false,
    })
    try {
      check('R10 field ready on screen', await settled(() => screenHas(rig.term, 'CLICKME')))
      check('R10 click dispatched', await clickText(rig.stdin, rig.term, 'CLICKME'))
      check('R10 callback ran exactly once', await settled(() => clicks === 1), `clicks=${clicks}`)
      // Same activation updates the same key: the new click throws.
      pluginCtx?.tuiStatus.setField('click', 'CLICKME', {
        detail: 'CLICK-DETAIL',
        onClick: () => { throw new Error('click boom') },
      })
      instance.rerender(statusNode({ pluginFields: [...store.getFieldSnapshot()] }, BASE_CHANNEL))
      check('R10 throwing field re-rendered', await settled(() => screenHas(rig.term, 'CLICKME')))
      // Past the renderer's 500ms multi-click window: a second click in the
      // same cell would otherwise become a word-select, not a click.
      await sleep(600) // 固定窗:墙钟 renderer 的 500ms 多击窗本身就是被测语义
      await clickText(rig.stdin, rig.term, 'CLICKME')
      check('R10 the throwing handler replaced the counting one', clicks === 1, `clicks=${clicks}`)
      check('R10 throwing click is reported, not thrown', await settled(() => reported === 'click'), `reported=${reported}`)
      check('R10 TUI survives the throwing click', screenHas(rig.term, 'CLICKME') && screenHas(rig.term, 'MODELX'))
    } finally {
      store.setFieldErrorHandler(undefined)
      instance.unmount()
      await sleep(120) // 固定窗:pacing 等首帧/卸载落定，无单一可轮询锚点
      rig.term.dispose()
      await fiber.dispose()
    }
  }

  // R14 — a REJECTED async click is reported and cannot reach the process
  // guard. No fatal sink is registered in this battery, so an unhandled
  // rejection rethrows and kills the run: the bad baseline fails loudly, and
  // the fix must keep the process alive through the same report path.
  {
    store.clear()
    const rig = makeRig(100, 12)
    let reported: string | undefined
    store.setFieldErrorHandler(key => { reported = key })
    const fiber = await activate(ctx => {
      ctx.tuiStatus.setField('async-click', 'ASYNCX', {
        detail: 'ASYNC-DETAIL',
        onClick: async () => { throw new Error('async boom') },
      })
    })
    const instance = await ui.render(
      statusNode({ pluginFields: [...store.getFieldSnapshot()] }, BASE_CHANNEL),
      {
        stdout: rig.stdout as unknown as NodeJS.WriteStream,
        stdin: rig.stdin as unknown as NodeJS.ReadStream,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    )
    try {
      check('R14 field ready on screen', await settled(() => screenHas(rig.term, 'ASYNCX')))
      fieldOf('async-click')?.onClick?.()
      check('R14 rejected async click is reported', await settled(() => reported === 'async-click'), `reported=${reported}`)
      check('R14 the process survives an async click rejection',
        screenHas(rig.term, 'ASYNCX') && screenHas(rig.term, 'MODELX'))
    } finally {
      store.setFieldErrorHandler(undefined)
      instance.unmount()
      await sleep(120) // 固定窗:pacing 等首帧/卸载落定，无单一可轮询锚点
      rig.term.dispose()
      await fiber.dispose()
    }
  }

  // ── Part C: adaptive single-line degradation ──────────────────────────────

  const adaptiveFields = [
    field({ key: 'left', text: 'LEFTX', slot: 'left-tail' }),
    field({ key: 'head', text: 'HEADX', slot: 'right-head' }),
    field({ key: 'tail', text: 'TAILX', slot: 'right-tail' }),
  ]
  const adaptiveProps = {
    pluginFields: adaptiveFields,
    backendMode: { id: 'acceptEdits', name: '自动', onOpen: () => {} },
  }
  const adaptiveChannel = (compact: boolean, overrides: Record<string, unknown> = {}) => channelWith({
    compact, thinking: true, tokens: true, cost: true, contextUsage: true,
    gitBranch: true, sessionTitle: true, sessionId: true,
  }, {
    reasoningEffort: 'high',
    costReport: { currency: 'USD', amount: 0.125 },
    contextOccupancy: { usedTokens: 12_800, contextWindow: 64_000 },
    // Short cwd: a shortened long directory (covered separately) must not be
    // confused with a removed field when independently counting +N.
    cwd: '/w/CWD', displayCwd: 'CWD', sessionTitle: 'TITLEX',
    ...overrides,
  })
  const optionalTokens = ['high', '1.2k→34', '$0.1250', 'LEFTX', 'HEADX', 'main', 'CWD', 'TITLEX', '#abcdef01', 'TAILX']
  const overflowCount = (row: string): number => Number(/\+([1-9]\d*)\b/u.exec(row)?.[1] ?? 0)
  const ordered = (row: string, tokens: readonly string[]): boolean =>
    tokens.every(token => row.includes(token))
    && tokens.every((token, index) => index === 0 || row.indexOf(tokens[index - 1]!) < row.indexOf(token))
  const singleStatus = (name: string, lines: readonly string[], cols: number): string => {
    const occupied = lines.filter(line => line.trim() !== '')
    const row = occupied[0] ?? ''
    check(`${name}: exactly one text row within the display-cell budget`,
      occupied.length === 1 && stringWidth(row) <= cols, JSON.stringify(occupied))
    check(`${name}: no empty separators or ellipsis-only fields`,
      row.trim() !== '' && !/^\s*·|·\s*$|·\s*·|(?:^|·)\s*…\s*(?:·|$)/u.test(row), JSON.stringify(row))
    return row
  }
  const adaptiveCapture = async (
    cols: number, props: Record<string, unknown>, channel: Record<string, unknown>, fullscreen: boolean,
  ): Promise<string[]> => {
    const rig = await mountStatus(cols, props, channel, fullscreen)
    try {
      return rig.lines()
    } finally {
      await rig.close()
    }
  }

  // C1 — an optional item is either fully readable or counted once by +N.
  // Per-field flex shrink leaves fragments/ellipses with no count, which a
  // width-only assertion would incorrectly accept as a valid narrow footer.
  for (const fullscreen of [false, true]) {
    for (const compact of [true, false]) {
      for (const cols of [30, 40, 60, 80, 120, 200]) {
        const name = `C1 ${fullscreen ? 'fullscreen' : 'inline'}/${compact ? 'compact' : 'split'} ${cols} cols`
        const lines = await adaptiveCapture(cols, adaptiveProps, adaptiveChannel(compact), fullscreen)
        const row = singleStatus(name, lines, cols)
        check(`${name}: model, exact permission name and ctx outrank optional fields`,
          row.includes('MODELX') && row.includes('自动') && row.includes('20%'), JSON.stringify(row))
        const missing = optionalTokens.filter(token => !row.includes(token)).length
        check(`${name}: +N counts whole hidden fields, not shortened ctx`,
          overflowCount(row) === missing, `missing=${missing}, row=${JSON.stringify(row)}`)
        if (cols <= 80) {
          check(`${name}: pressure produces +N and percent-only ctx`,
            overflowCount(row) > 0 && row.includes('20%') && !row.includes('/64k'), JSON.stringify(row))
        }
        if (cols === 200) {
          const left = ['MODELX', 'high', '自动', '1.2k→34', '$0.1250', 'LEFTX']
          const right = ['HEADX', 'main', 'CWD', 'TITLEX', '#abcdef01', 'TAILX']
          const context = compact ? 'ctx 20% (13k/64k)' : 'ctx 13k/64k (20%)'
          check(`${name}: wide layout preserves every field and existing group order`,
            overflowCount(row) === 0 && ordered(row, compact ? [...left, ...right, context] : [...left, context, ...right]),
            JSON.stringify(row))
          if (!compact) {
            check(`${name}: split right-tail still reaches the right edge`,
              row.endsWith('TAILX') && stringWidth(row) === cols - 1, JSON.stringify(row))
          }
        }
      }
    }
  }

  // C2 — a route longer than the screen must yield useful model text, not
  // consume every other field. CJK, a ZWJ emoji and a combining grapheme
  // distinguish display-cell fitting from JS string-length arithmetic.
  for (const model of [
    'MODELSTART-' + 'route-segment-'.repeat(18) + '-MODELEND',
    '模型👩‍💻e\u0301-' + '推理🙂模型-'.repeat(18) + '-终点',
  ]) {
    for (const compact of [true, false]) {
      for (const cols of [30, 40, 60, 80, 120, 200]) {
        const name = `C2 ${model.startsWith('MODEL') ? 'ASCII' : 'Unicode'}/${compact ? 'compact' : 'split'} ${cols} cols`
        const channel = adaptiveChannel(compact, {
          model,
          cwd: '/w/项目🙂', displayCwd: '/w/项目🙂',
          workingDirectory: '/w/项目🙂/' + '目录👩‍💻/'.repeat(8) + 'leaf',
          sessionTitle: '会话e\u0301🙂-' + '完整标题'.repeat(16) + '-TITLE-END',
        })
        const row = singleStatus(name, await adaptiveCapture(cols, adaptiveProps, channel, true), cols)
        check(`${name}: huge model leaves readable model, exact mode and percentage`,
          row.includes(model.startsWith('MODEL') ? 'MOD' : '模型')
          && row.includes('自动') && row.includes('20%') && !row.includes(model), JSON.stringify(row))
        check(`${name}: Unicode graphemes stay intact without replacement cells`,
          !/\uFFFD|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(row)
          && !/[\u200D\u0301👩💻]/u.test(row.replaceAll('👩‍💻', '').replaceAll('e\u0301', '')),
          JSON.stringify(row))
      }
    }
  }

  // C3 — an enabled DSH mode has the same safety priority as a backend mode.
  // Permission names are never abbreviated or renamed: when a custom name
  // cannot fit, hide the whole field and account for it.
  {
    const channel = adaptiveChannel(true, {
      mode: { id: 'review', label: '审阅', plan: true, sandbox: 'read-only', approval: 'ask' },
      modeIndex: 1,
    })
    channel.statusBar.mode = true
    const row = singleStatus('C3 DSH enabled mode', await adaptiveCapture(40, {
      pluginFields: adaptiveFields,
    }, channel, false), 40)
    check('C3 DSH mode keeps its configured name beside model and ctx',
      row.includes('MODELX') && row.includes('审阅') && row.includes('20%') && overflowCount(row) > 0,
      JSON.stringify(row))
    const modeName = 'Custom-Permission-自动编辑-' + 'do-not-rewrite-'.repeat(8)
    const narrow = singleStatus('C3 oversized permission', await adaptiveCapture(40, {
      ...adaptiveProps, backendMode: { id: 'acceptEdits', name: modeName, onOpen: () => {} },
    }, adaptiveChannel(true), true), 40)
    check('C3 oversized permission is hidden whole, never mislabeled',
      !narrow.includes('Custom') && !narrow.includes('Permission') && !narrow.includes('自动')
      && narrow.includes('MODELX') && narrow.includes('20%') && overflowCount(narrow) > 0,
      JSON.stringify(narrow))
  }

  // C4 — defaults at a roomy width retain the actual default-on metrics and
  // the user's plugin order, rather than permanently reducing the footer.
  for (const fullscreen of [false, true]) {
    const fields = [
      field({ key: 'a', text: 'AAAX', slot: 'left-tail' }),
      field({ key: 'b', text: 'BBBX', slot: 'left-tail' }),
      field({ key: 'c', text: 'CCCX', slot: 'right-head' }),
      field({ key: 'd', text: 'DDDX', slot: 'right-tail' }),
    ]
    const channel = channelWith({ ...DEFAULT_STATUS_BAR, pluginFieldsOrder: 'b,a;c;d' }, {
      reasoningEffort: 'high',
      lastUsage: { input: 250, output: 34, cacheRead: 750, cacheWrite: 0 },
      contextOccupancy: { usedTokens: 12_800, contextWindow: 64_000 },
      costReport: { currency: 'USD', amount: 0.125 },
    })
    const row = singleStatus(`C4 default ${fullscreen ? 'fullscreen' : 'inline'}`,
      await adaptiveCapture(200, { pluginFields: fields }, channel, fullscreen), 200)
    check('C4 wide defaults preserve metrics and user plugin order without +N',
      ordered(row, ['MODELX', 'high', '缓存 75.0%', '$0.1250', 'BBBX', 'AAAX', 'CCCX', 'uniqdir', 'DDDX', 'ctx 20% (13k/64k)'])
      && !row.includes('1.2k→34') && overflowCount(row) === 0, JSON.stringify(row))
  }

  // C5 — inspect the real floating card, not a tooltip store/helper. Its
  // wrapped rows must reconstruct the full hidden title and plugin text.
  {
    const title = '完整标题🙂-TITLE-BEGIN-' + 'long-session-'.repeat(5) + '-TITLE-END'
    const pluginText = 'HIDDEN-PLUGIN-FULL-TEXT'
    const rig = await mountStatus(40, {
      ...adaptiveProps,
      pluginFields: [field({ key: 'hidden', text: pluginText, maxCells: 32 })],
    }, adaptiveChannel(true, { sessionTitle: title }), true, true)
    try {
      const row = singleStatus('C5 hidden tooltip idle', rig.lines(), 40)
      const marker = /\+[1-9]\d*\b/u.exec(row)?.[0]
      check('C5 hidden title and plugin have a visible overflow target',
        marker !== undefined && !row.includes(title) && !row.includes(pluginText), JSON.stringify(row))
      if (marker !== undefined) {
        const lines = rig.lines()
        const lineIndex = lines.findIndex(line => line.includes(marker))
        const line = lines[lineIndex] ?? ''
        // findText uses JS indices; SGR coordinates need DISPLAY cells when
        // a wide permission label precedes the overflow target.
        const col = stringWidth(line.slice(0, line.indexOf(marker)))
        hover(rig.stdin, col + 1, lineIndex + 1)
        const cardText = (): string => rig.lines()
          .filter(line => line.includes('│'))
          .map(line => line.slice(line.indexOf('│') + 1, line.lastIndexOf('│')).trimEnd())
          .join('')
        check('C5 +N hover paints the full hidden title and plugin text',
          await settled(() => cardText().includes(title) && cardText().includes(pluginText)), JSON.stringify(rig.lines()))
        hover(rig.stdin, 1, rig.term.rows)
        check('C5 leaving +N dismisses the real tooltip',
          await settled(() => rig.lines().every(line => !/[╭╮╰╯]/u.test(line))), JSON.stringify(rig.lines()))
      }
    } finally {
      await rig.close()
    }
  }

  // C6 — resize the SAME mounted StatusLine in both terminal modes: fields
  // hidden at 40 must reappear unchanged at 200, with no stale +N, wrapped
  // leftovers, or permanently shortened context counts.
  for (const fullscreen of [false, true]) {
    for (const compact of [true, false]) {
      const name = `C6 ${fullscreen ? 'fullscreen' : 'inline'}/${compact ? 'compact' : 'split'}`
      const rig = await mountStatus(200, adaptiveProps, adaptiveChannel(compact), fullscreen)
      try {
        const initial = singleStatus(`${name} initial`, rig.lines(), 200)
        await rig.resize(40)
        const narrow = singleStatus(`${name} narrow`, rig.lines(), 40)
        check(`${name}: resize hides fields but preserves model/mode/ctx`,
          overflowCount(narrow) > 0 && narrow.includes('MODELX') && narrow.includes('自动') && narrow.includes('20%'),
          JSON.stringify(narrow))
        await rig.resize(80)
        const middle = singleStatus(`${name} middle`, rig.lines(), 80)
        check(`${name}: widening never increases the hidden count`,
          overflowCount(middle) <= overflowCount(narrow), JSON.stringify({ narrow, middle }))
        await rig.resize(200)
        const restored = singleStatus(`${name} restored`, rig.lines(), 200)
        check(`${name}: widening restores the exact original wide row`,
          initial === restored && optionalTokens.every(token => restored.includes(token)) && overflowCount(restored) === 0,
          JSON.stringify({ initial, restored }))
      } finally {
        await rig.close()
      }
    }
  }

  // C7 — content changes, not resize: hiding a hovered field unmounts its
  // mouse target without guaranteeing a leave event. Its detail must not
  // become a ghost when pressure lifts and the same field returns.
  {
    const channel = channelWith({ tokens: true }, {
      tokens: { input: 1200, output: 34, cacheRead: 0, cacheWrite: 0 },
    })
    const rig = await mountStatus(40, {}, channel)
    try {
      const initial = rig.lines()
      const at = findText(rig.term, '1.2k→34')
      check('C7 token hover target starts visible', at !== null, JSON.stringify(initial))
      if (at !== null) {
        hover(rig.stdin, at.col + 1, at.row + 1)
        check('C7 token hover displays its real supplemental detail',
          await settled(() => screenHas(rig.term, 'in 1.2k')), JSON.stringify(rig.lines()))
        await rig.rerender(adaptiveProps, adaptiveChannel(true))
        check('C7 added content pressure hides the entire token field without resizing',
          !statusRow(rig.lines()).includes('1.2k→34') && overflowCount(statusRow(rig.lines())) > 0,
          JSON.stringify(rig.lines()))
        hover(rig.stdin, 1, rig.term.rows)
        await new Promise<void>(resolve => setImmediate(resolve))
        await rig.rerender({}, channel)
        const restored = rig.lines()
        check('C7 restored tokens are painted again', statusRow(restored).includes('1.2k→34'), JSON.stringify(restored))
        check('C7 restoring an unmounted hover target keeps the original idle footer',
          restored.map(line => line.trimEnd()).join('\n') === initial.map(line => line.trimEnd()).join('\n')
          && !screenHas(rig.term, 'in 1.2k'), JSON.stringify({ initial, restored }))
      }
    } finally {
      await rig.close()
    }
  }

  await root.fiber.dispose()
  console.log(`\n${checks} checks, ${failures} failure${failures === 1 ? '' : 's'}`)
  process.exit(failures === 0 ? 0 : 1)
} catch (error) {
  console.error(error)
  process.exit(1)
}
