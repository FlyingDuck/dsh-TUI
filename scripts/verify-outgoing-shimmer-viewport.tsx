/**
 * Outgoing shimmer must keep advancing after ScrollBox's first sticky pin.
 * Real OutgoingMessages + ScrollBox, zero/70 history lines, no channel receipt
 * and no confirmation: the same pending preview remains visible throughout.
 * One controlled clock drives both roots at exactly 120ms steps. A sibling
 * tick fence proves each step reached React and xterm without rerendering the
 * preview's parent. Every consecutive window must change cell colors; a single
 * initial glint followed by a frozen preview is a failure.
 * Run: node --import tsx/esm scripts/verify-outgoing-shimmer-viewport.tsx
 */
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import type { ReactNode } from 'react'
import type { Clock } from '../src/ink/components/ClockContext.js'

process.env.FORCE_COLOR = '3'
delete process.env.NO_COLOR
process.env.DSH_TUI_THEME = 'dark'

const [React, xterm, ui, { OutgoingMessages }, { ClockContext }, focus,
  { settled, viewportLines, findText },
] = await Promise.all([
  import('react'), import('@xterm/headless'), import('../src/ui.js'),
  import('../src/components/OutgoingMessages.js'),
  import('../src/ink/components/ClockContext.js'),
  import('../src/ink/terminal-focus-state.js'),
  import('./lib/term-test.mjs'),
])
const XTerm = xterm.Terminal ?? xterm.default.Terminal

const listeners = new Map<() => void, boolean>()
const activeSubscriptions = () => [...listeners.values()].filter(Boolean).length
let time = 0
const clock: Clock = {
  now: () => time,
  subscribe(listener, keepAlive) { listeners.set(listener, keepAlive); return () => { listeners.delete(listener) } },
  setTickInterval() {},
  suspend() {},
}
const marker = () => `CLOCK_${time}`
function TickFence(): ReactNode {
  const [observed, setObserved] = React.useState(clock.now)
  React.useEffect(() => clock.subscribe(() => setObserved(clock.now()), false), [])
  return <ui.Text>{`CLOCK_${observed}`}</ui.Text>
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
const text = 'OUTGOING_VIEWPORT_SENTINEL'
async function mount(historyLines: number, hidden = false) {
  const term = new XTerm({ cols: 60, rows: 16, allowProposedApi: true })
  const stdout = Object.assign(new Writable({
    write(chunk, _encoding, done) { term.write(String(chunk), done) },
  }), { columns: 60, rows: 16, isTTY: true })
  const stderr = Object.assign(new Writable({
    write(_chunk, _encoding, done) { done() },
  }), { isTTY: true })
  const app = await ui.render(
    <ClockContext.Provider value={clock}>
      <ui.Box flexDirection="column" height={16}>
        <ui.ScrollBox flexDirection="column" height={15} stickyScroll>
          {hidden && <OutgoingMessages messages={[{ id: 'hidden', text, phase: 'queued' }]} />}
          <ui.Text>{Array.from({ length: historyLines }, (_, index) => `History ${index}`).join('\n')}</ui.Text>
          {!hidden && <OutgoingMessages messages={[{ id: `pending-${historyLines}`, text, phase: 'queued' }]} />}
        </ui.ScrollBox>
        <TickFence />
      </ui.Box>
    </ClockContext.Provider>,
    { stdout: stdout as never, stderr: stderr as never, stdin: new FakeStdin() as never,
      exitOnCtrlC: false, patchConsole: false, terminalImages: false },
  )
  const flush = () => new Promise<void>(resolve => stdout.write('', () => resolve()))
  const appearance = () => {
    const at = findText(term, text)
    if (at === null) return null
    const line = term.buffer.active.getLine(term.buffer.active.baseY + at.row)
    return { row: at.row, col: at.col, text: line?.translateToString(true),
      fg: Array.from({ length: text.length }, (_, index) => line?.getCell(at.col + index)?.getFgColor()) }
  }
  return { historyLines, term, appearance, flush,
    ready: () => viewportLines(term).some(line => line.includes(marker())) && (hidden
      ? appearance() === null && viewportLines(term).some(line => line.includes(`History ${historyLines - 1}`))
      : appearance() !== null),
    close: async () => { app.unmount(); await flush(); app.cleanup(); term.dispose() },
  }
}

focus.setTerminalFocused(true)
const rigs: Awaited<ReturnType<typeof mount>>[] = []
const report: string[] = []
let failures = 0
try {
  for (const historyLines of [0, 70]) rigs.push(await mount(historyLines))
  for (const rig of rigs) {
    assert.ok(await settled(rig.ready), `${rig.historyLines} history: pending preview and tick fence mount`)
  }
  let previous = rigs.map(rig => rig.appearance()!)
  // Each clock step is one exact shimmer window, not a wall-clock sleep. The
  // fence is a sibling, so its updates cannot repair stale viewport state by
  // rerendering OutgoingMessages or its parent.
  for (const nextTime of [120, 240, 360, 480]) {
    time = nextTime
    for (const listener of [...listeners.keys()]) listener()
    for (const rig of rigs) assert.ok(await settled(rig.ready), `${rig.historyLines} history: clock ${time} parsed`)
    await Promise.all(rigs.map(rig => rig.flush()))
    assert.equal(focus.getTerminalFocusState(), 'focused')
    const current = rigs.map((rig, index) => {
      const now = rig.appearance()
      assert.ok(now, `${rig.historyLines} history: pending preview stays in the viewport at ${time}`)
      const before = previous[index]!
      assert.deepEqual({ row: now.row, col: now.col, text: now.text },
        { row: before.row, col: before.col, text: before.text }, 'shimmer changes colors, not geometry')
      const advanced = JSON.stringify(now.fg) !== JSON.stringify(before.fg)
      if (!advanced) failures += 1
      report.push(`${advanced ? 'PASS' : 'FAIL'} history=${rig.historyLines} clock=${time - 120}->${time} focused=true visible=true color-advanced=${advanced}`)
      return now
    })
    previous = current
  }
  if (failures === 0) {
    const visibleRigs = [...rigs]
    const hidden = await mount(70, true)
    rigs.push(hidden)
    assert.ok(await settled(hidden.ready), 'the third preview is genuinely above the pinned viewport')
    for (const nextTime of [600, 720, 840]) {
      time = nextTime
      for (const listener of [...listeners.keys()]) listener()
      for (const rig of rigs) assert.ok(await settled(rig.ready), `lifecycle clock ${time} parsed`)
      await Promise.all(rigs.map(rig => rig.flush()))
    }
    assert.equal(activeSubscriptions(), 2, 'an offscreen preview stops driving the clock after sampling layout')
    report.push('PASS offscreen preview releases its animation subscription')

    focus.setTerminalFocused(false)
    assert.ok(await settled(() => activeSubscriptions() === 0), 'blur releases even the visible animation subscriptions')
    const paused = visibleRigs.map(rig => rig.appearance()!.fg)
    time = 960
    for (const listener of [...listeners.keys()]) listener()
    for (const rig of rigs) assert.ok(await settled(rig.ready), 'blurred tick fence parsed')
    await Promise.all(rigs.map(rig => rig.flush()))
    assert.deepEqual(visibleRigs.map(rig => rig.appearance()!.fg), paused, 'paused colors remain unchanged')
    report.push('PASS blur keeps colors frozen and releases every animation subscription')

    focus.setTerminalFocused(true)
    assert.ok(await settled(() => activeSubscriptions() === 2), 'focus resumes only the visible previews')
    time = 1080
    for (const listener of [...listeners.keys()]) listener()
    for (const rig of rigs) assert.ok(await settled(rig.ready), 'refocused tick fence parsed')
    await Promise.all(rigs.map(rig => rig.flush()))
    for (const [index, rig] of visibleRigs.entries()) {
      assert.notDeepEqual(rig.appearance()!.fg, paused[index], 'refocused preview starts advancing again')
    }
    report.push('PASS focus resumes both visible previews without waking the hidden preview')
  }
} catch (error) {
  failures += 1
  report.push(`FAIL ${error instanceof Error ? error.message : String(error)}`)
} finally {
  for (const rig of rigs) await rig.close()
}
assert.equal(listeners.size, 0, 'unmount releases every clock subscription')
for (const line of report) console.log(line)
if (failures > 0) {
  console.error(`verify-outgoing-shimmer-viewport FAILED (${failures} outgoing shimmer windows froze)`)
  process.exitCode = 1
} else {
  console.log('verify-outgoing-shimmer-viewport OK (both previews advance in every 120ms window)')
}
