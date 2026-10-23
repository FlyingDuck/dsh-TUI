/**
 * Fullscreen transcript edge-selection regression through real Ink + ScrollBox.
 * One SGR motion parks the pointer at an edge; without further mouse events,
 * scrolling must continue and OSC 52 must contain every selected logical row.
 * Also checks repeated motions, multi-click reversal, viewport shrink,
 * Unicode soft wraps, cancellation, ownership, overlays, and inline mode.
 *
 * Run: node --import tsx/esm scripts/verify-selection-auto-scroll.tsx
 */
import './lib/fake-home.mjs'
import type { ScrollBoxHandle } from '../src/ink/components/ScrollBox.js'

process.env.SSH_CONNECTION = 'headless-test'
delete process.env.TMUX
delete process.env.DSH_TUI_DISABLE_MOUSE
process.env.DSH_TUI_LANG = 'en'
process.env.DSH_TUI_THEME = 'dark'
process.env.FORCE_COLOR = '3'

const [
  { PassThrough, Writable },
  React,
  { Terminal },
  { createRoot, AlternateScreen, Box, Text, ScrollBox, NoSelect, useInput, useCopyOnSelect },
  { useSelection },
  { default: instances },
  { settled, sleep, viewportLines },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/ink/hooks/use-selection.js'),
  import('../src/ink/instances.js'),
  import('./lib/term-test.mjs'),
])

const ROWS = 18
const VIEWPORT = 8
const COUNT = 40
const rowText = (index: number): string => `R${String(index).padStart(3, '0')}: text`
const selectedRows = (first: number, last: number): string =>
  Array.from({ length: last - first + 1 }, (_, index) => rowText(first + index)).join('\n')
let failures = 0

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function verify(name: string, test: () => Promise<void>): Promise<void> {
  try {
    await test()
    console.log(`PASS: ${name}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL: ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function fixture(columns: number, options: { fullscreen?: boolean; optIn?: boolean; sidebar?: boolean; viewportHeight?: number; lines?: readonly string[] } = {}) {
  const fullscreen = options.fullscreen !== false
  const chatWidth = options.sidebar === false ? columns : columns - 8
  const lines = options.lines ?? Array.from({ length: COUNT }, (_, index) => rowText(index))
  const terminal = new Terminal({ cols: columns, rows: ROWS, allowProposedApi: true })
  const frames: string[] = []
  let painted = Promise.resolve()
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      frames.push(String(chunk))
      painted = painted.then(() => new Promise<void>(resolve => terminal.write(String(chunk), resolve)))
      callback()
    },
  }) as NodeJS.WriteStream
  stdout.columns = columns
  stdout.rows = ROWS
  Object.assign(stdout, { isTTY: true })
  const stderr = new Writable({ write(_chunk, _encoding, callback) { callback() } }) as NodeJS.WriteStream
  const stdin = new PassThrough() as NodeJS.ReadStream
  Object.assign(stdin, {
    isTTY: true,
    setRawMode: () => stdin,
    ref: () => stdin,
    unref: () => stdin,
  })
  let handle: ScrollBoxHandle | null = null
  let overlay = false
  let chrome = false
  let viewportHeight = options.viewportHeight ?? VIEWPORT
  let mounted = true
  let disposed = false
  let transcriptKey = 0
  const previousInk = instances.get(process.stdout)
  const root = await createRoot({ stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false, terminalImages: false })
  const ink = instances.get(stdout)
  expect(ink, 'fixture created a real Ink instance')
  // Bind BEFORE the first tree mounts: selection hooks resolve process.stdout,
  // not the fake stream passed to createRoot.
  instances.set(process.stdout, ink)

  function Input() {
    const { clearSelection, hasSelection, getState } = useSelection()
    useCopyOnSelect()
    // A useInput consumer is required to arm App's real stdin reader.
    useInput((_input, key, event) => {
      if (key.escape && (hasSelection() || getState()?.isDragging)) {
        clearSelection()
        event.stopImmediatePropagation()
      }
    })
    return null
  }

  function Scene() {
    const viewport = chrome ? viewportHeight - 2 : viewportHeight
    const content = (
      <Box flexDirection="column" height={ROWS}>
        <Input />
        <Box height={chrome ? 3 : 2} flexShrink={0}><Text>HEADER</Text></Box>
        <Box flexDirection="row" height={viewport} flexShrink={0}>
          <ScrollBox
            key={transcriptKey}
            ref={value => { handle = value }}
            selectionAutoScroll={options.optIn !== false}
            width={chatWidth}
            height={viewport}
            flexDirection="column"
            flexShrink={0}
          >
            {lines.map((line, index) => <Text key={index}>{line}</Text>)}
          </ScrollBox>
          {options.sidebar !== false && (
            <NoSelect width={8} height={viewport} flexDirection="column" flexShrink={0}>
              {Array.from({ length: viewport }, (_, index) => <Text key={index}>PANEL</Text>)}
            </NoSelect>
          )}
        </Box>
        <Box height={2} flexShrink={0} flexDirection="column">
          <Text>PROMPT</Text><Text>FOOTER</Text>
        </Box>
        {overlay && (
          <Box position="absolute" top={2} left={0} width={chatWidth} height={VIEWPORT}>
            <ScrollBox width="100%" height={VIEWPORT} flexDirection="column">
              {Array.from({ length: COUNT }, (_, index) => <Text key={index}>MODAL-{index}</Text>)}
            </ScrollBox>
          </Box>
        )}
      </Box>
    )
    return fullscreen ? <AlternateScreen>{content}</AlternateScreen> : content
  }

  const draw = async (): Promise<void> => {
    root.render(<Scene />)
    ink.renderNow()
    await painted
  }
  const flush = async (): Promise<void> => { ink.renderNow(); await painted }
  const scroll = (): ScrollBoxHandle => {
    expect(handle, 'transcript handle is mounted')
    return handle
  }
  const seek = async (top: number): Promise<void> => {
    ink.clearTextSelection()
    scroll().scrollTo(top)
    expect(await settled(() => scroll().getScrollTop() === top && scroll().getPendingDelta() === 0), `seek reached ${top}`)
    await flush()
  }
  const copies = (): string[] => [...frames.join('').matchAll(/\x1b\]52;c;([A-Za-z0-9+/=]+)/g)]
    .map(match => Buffer.from(match[1]!, 'base64').toString('utf8'))
  const press = (col: number, row: number): void => { stdin.write(`\x1b[<0;${col + 1};${row + 1}M`) }
  const motion = (col: number, row: number): void => { stdin.write(`\x1b[<32;${col + 1};${row + 1}M`) }
  const release = (col: number, row: number): void => { stdin.write(`\x1b[<0;${col + 1};${row + 1}m`) }
  const bounds = (): { top: number; bottom: number } => {
    const top = scroll().getViewportTop()
    return { top, bottom: top + scroll().getViewportHeight() - 1 }
  }
  const pauseIsStable = async (message: string): Promise<void> => {
    expect(await settled(() => scroll().getPendingDelta() === 0), 'queued scrolling drained before stop probe')
    const top = scroll().getScrollTop()
    await sleep(220) // 固定窗:探针 停止后跨过四个 50ms tick，转录不得继续滚动
    expect(scroll().getScrollTop() === top && scroll().getPendingDelta() === 0, message)
  }
  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    if (mounted) root.unmount()
    mounted = false
    await painted
    terminal.dispose()
    instances.delete(stdout)
    if (previousInk) instances.set(process.stdout, previousInk)
    else instances.delete(process.stdout)
  }

  try {
    await draw()
    expect(await settled(() => handle !== null && handle.getViewportHeight() === viewportHeight && handle.getScrollHeight() >= lines.length), 'fixture has a measured scrolling viewport')
    await flush()
  } catch (error) {
    await dispose()
    throw error
  }
  return {
    ink, stdin, terminal, frames, scroll, seek, copies, press, motion, release, bounds, flush, pauseIsStable, dispose,
    async setOverlay(value: boolean) { overlay = value; await draw() },
    async addChrome() { chrome = true; await draw() },
    async setHeight(height: number) { viewportHeight = height; await draw() },
    async remountTranscript() { transcriptKey += 1; await draw() },
    async unmount() {
      root.unmount()
      mounted = false
      await painted
    },
  }
}

async function crossViewport(columns: number, direction: 'up' | 'down'): Promise<void> {
  const f = await fixture(columns)
  try {
    await f.seek(direction === 'down' ? 0 : COUNT - VIEWPORT)
    const { top, bottom } = f.bounds()
    const lastCol = rowText(0).length - 1
    if (direction === 'down') {
      f.press(0, top + 1)
      f.motion(lastCol, ROWS - 1) // Beyond the transcript: the focus must clamp, not copy chrome.
    } else {
      f.press(lastCol, bottom - 1)
      f.motion(0, 0)
    }
    const destination = direction === 'down' ? COUNT - VIEWPORT : 0
    expect(await settled(() => f.scroll().getScrollTop() === destination && f.scroll().getPendingDelta() === 0,
      { timeoutMs: 8000 }), 'one edge motion keeps scrolling across multiple viewports')
    expect(f.ink.selection.isDragging && f.ink.hasTextSelection(), 'gesture survives while the pointer stays still')
    expect(f.copies().length === 0, 'edge ticks never copy before release')
    await f.flush()
    const visible = viewportLines(f.terminal)
    expect(visible.some(line => line.includes(rowText(direction === 'down' ? COUNT - 1 : 0))), 'the terminal actually painted the destination rows')
    f.release(direction === 'down' ? lastCol : 0, direction === 'down' ? ROWS - 1 : 0)
    expect(await settled(() => f.copies().length === 1), 'release produces one OSC 52 write')
    const expected = direction === 'down' ? selectedRows(1, COUNT - 1) : selectedRows(0, COUNT - 2)
    expect(f.copies()[0] === expected, `cross-screen copy is exact: ${JSON.stringify(f.copies()[0])}`)
    expect(!f.ink.selection.stale && f.ink.hasTextSelection(), 'legitimate edge-follow is not stale and retains its highlight')
    await f.pauseIsStable('release stops the edge timer')
  } finally { await f.dispose() }
}

async function stopGesture(kind: 'interior' | 'release' | 'escape' | 'blur' | 'owner-unmount' | 'unmount' | 'overlay'): Promise<void> {
  const f = await fixture(60)
  try {
    await f.seek(20)
    const { top, bottom } = f.bounds()
    f.press(rowText(0).length - 1, bottom - 1)
    f.motion(0, top)
    expect(await settled(() => f.scroll().getScrollTop() <= 17), 'edge gesture started before testing stop')
    if (kind === 'interior') {
      f.motion(0, top + 3)
      expect(await settled(() => f.ink.selection.focus?.row === top + 3), 'pointer returned to the viewport interior')
    } else if (kind === 'release') {
      f.release(0, top)
      expect(await settled(() => !f.ink.selection.isDragging && f.copies().length === 1), 'release settles and copies once')
    } else if (kind === 'escape') {
      f.stdin.write('\x1b')
      expect(await settled(() => !f.ink.selection.isDragging && !f.ink.hasTextSelection()), 'Escape cancels the active drag')
      expect(f.copies().length === 0, 'Escape does not copy')
    } else if (kind === 'blur') {
      f.stdin.write('\x1b[O')
      expect(await settled(() => !f.ink.selection.isDragging && f.copies().length === 1), 'focus loss preserves existing settle-and-copy semantics')
    } else if (kind === 'overlay') {
      await f.setOverlay(true)
    } else if (kind === 'unmount') {
      await f.unmount()
      const writes = f.frames.length
      await sleep(220) // 固定窗:探针 Ink 卸载后跨过四个 tick，不得再绘制或复制
      expect(f.frames.length === writes, 'unmount cancels further edge-timer output')
      return
    } else {
      await f.remountTranscript()
      // Do not use seek(): it clears the selection and would hide a missing
      // owner-unmount cancellation. The replacement viewport is a new owner.
      f.scroll().scrollTo(20)
      expect(await settled(() => f.scroll().getScrollTop() === 20 && f.scroll().getPendingDelta() === 0), 'replacement viewport reached its starting position')
    }
    await f.pauseIsStable(`${kind} stops scrolling without further pointer motion`)
    if (kind === 'interior') {
      expect(f.ink.selection.isDragging && f.copies().length === 0, 'moving inside pauses without completing the selection')
      f.release(0, top + 3)
    }
    if (kind === 'escape') {
      f.motion(0, top)
      f.release(0, top)
      await f.pauseIsStable('late motion/release cannot revive an Escape-cancelled timer')
      expect(f.copies().length === 0, 'late release after Escape does not copy')
    }
  } finally { await f.dispose() }
}

async function noScroll(kind: 'header' | 'footer' | 'panel' | 'plain' | 'inline' | 'overlay' | 'bare-press'): Promise<void> {
  const f = await fixture(60, { optIn: kind !== 'plain', fullscreen: kind !== 'inline' })
  try {
    await f.seek(20)
    if (kind === 'overlay') await f.setOverlay(true)
    const { top, bottom } = f.bounds()
    if (kind === 'header') {
      f.press(0, 0)
      f.motion(0, top)
    } else if (kind === 'footer') {
      f.press(0, bottom + 1)
      f.motion(0, top)
    } else if (kind === 'panel') {
      f.press(54, top + 3)
      f.motion(0, top)
    } else if (kind === 'bare-press') {
      f.press(0, top)
    } else {
      f.press(0, top + 3)
      f.motion(0, top)
    }
    // Ensure stdin has been consumed before the negative observation window.
    await new Promise<void>(resolve => setImmediate(resolve))
    await f.pauseIsStable(`${kind} never acquires the transcript edge-scroll owner`)
    expect(f.scroll().getScrollTop() === 20, `${kind} leaves the underlying transcript at its initial position`)
    f.release(0, top)
  } finally { await f.dispose() }
}

async function reverseDirection(): Promise<void> {
  const f = await fixture(60)
  try {
    await f.seek(12)
    const { top, bottom } = f.bounds()
    const anchor = 15
    f.press(0, top + 3)
    f.motion(rowText(0).length - 1, bottom)
    expect(await settled(() => f.scroll().getScrollTop() >= 24), 'downward edge scrolling captured off-screen rows')
    expect(f.ink.selection.scrolledOffAbove.length > 0, 'reversal really exercises an existing accumulator')
    f.motion(0, top)
    expect(await settled(() => f.scroll().getScrollTop() <= 8), 'opposite edge scrolls back past the original anchor')
    f.motion(0, top + 1)
    await f.pauseIsStable('moving inside pauses the reverse edge gesture')
    // Refresh the focus after the last queued scroll frame, then derive the
    // expected source span independently from the painted viewport position.
    f.motion(0, top + 1)
    expect(await settled(() => f.ink.selection.focus?.row === top + 1), 'reverse gesture focus is at its final pointer row')
    const first = f.scroll().getScrollTop() + 1
    expect(first < anchor, 'final source row lies before the original press')
    f.release(0, top + 1)
    expect(await settled(() => f.copies().length === 1), 'reversed gesture copies once')
    const expected = `${selectedRows(first, anchor - 1)}\nR`
    expect(f.copies()[0] === expected, `reversal does not duplicate stale captured rows: ${JSON.stringify(f.copies()[0])}`)
  } finally { await f.dispose() }
}

async function multiClick(kind: 'word' | 'line'): Promise<void> {
  const f = await fixture(60)
  try {
    await f.seek(0)
    const { top } = f.bounds()
    const row = top + 1
    f.press(7, row)
    f.release(7, row)
    f.press(7, row)
    if (kind === 'line') {
      f.release(7, row)
      f.press(7, row)
    }
    expect(await settled(() => f.ink.selection.anchorSpan?.kind === kind && f.ink.selection.isDragging), `${kind} gesture starts through real multi-click input`)
    const before = f.copies().length
    f.motion(rowText(0).length - 1, ROWS - 1)
    expect(await settled(() => f.scroll().getScrollTop() === COUNT - VIEWPORT && f.scroll().getPendingDelta() === 0,
      { timeoutMs: 8000 }), `${kind} drag keeps scrolling with a stationary pointer`)
    expect(f.copies().length === before, `${kind} edge ticks do not copy before release`)
    f.release(rowText(0).length - 1, ROWS - 1)
    expect(await settled(() => f.copies().length === before + 1), `${kind} release copies once`)
    const expected = kind === 'line' ? selectedRows(1, COUNT - 1) : `text\n${selectedRows(2, COUNT - 1)}`
    expect(f.copies().at(-1) === expected, `${kind} copy preserves the original multi-click bounds: ${JSON.stringify(f.copies().at(-1))}`)
  } finally { await f.dispose() }
}

async function continuousMotion(): Promise<void> {
  const f = await fixture(60)
  let timer: ReturnType<typeof setInterval> | undefined
  try {
    await f.seek(8)
    const { top, bottom } = f.bounds()
    f.press(0, top + 2)
    expect(await settled(() => f.ink.selection.isDragging), 'continuous-motion gesture owns the pressed button')
    let motions = 0
    f.motion(9, bottom)
    timer = setInterval(() => { f.motion(6 + (motions++ % 4), bottom) }, 10)
    await sleep(500) // 固定窗:墙钟 持续 motion 不得反复 debounce 掉 50ms 边缘滚动定时器
    // Inspect BEFORE stopping the repeated motions. Waiting for scrolling
    // afterward would let a broken trailing-debounce implementation pass.
    expect(motions >= 5, 'the edge received a sustained stream of mouse-motion events')
    expect(f.scroll().getScrollTop() >= 10, `edge scroll advances during continuous motion, not only after it stops: ${f.scroll().getScrollTop()}`)
    expect(f.copies().length === 0, 'continuous edge motion never settles the selection prematurely')
    clearInterval(timer)
    timer = undefined
    f.motion(0, top + 2)
    await f.pauseIsStable('moving inside also stops a continuous-motion gesture')
    f.release(0, top + 2)
    expect(await settled(() => f.copies().length === 1), 'continuous-motion selection copies once on release')
  } finally {
    if (timer !== undefined) clearInterval(timer)
    await f.dispose()
  }
}

async function multiClickReverse(kind: 'word' | 'line'): Promise<void> {
  const f = await fixture(60)
  try {
    await f.seek(12)
    const { top, bottom } = f.bounds()
    const row = top + 3
    f.press(7, row)
    f.release(7, row)
    f.press(7, row)
    if (kind === 'line') {
      f.release(7, row)
      f.press(7, row)
    }
    expect(await settled(() => f.ink.selection.anchorSpan?.kind === kind && f.ink.selection.isDragging), `${kind} reverse gesture starts from a real multi-click span`)
    const before = f.copies().length
    f.motion(rowText(0).length - 1, bottom)
    expect(await settled(() => f.scroll().getScrollTop() >= 24), `${kind} original span really left the viewport`)
    expect(f.ink.selection.scrolledOffAbove.length > 0, `${kind} reversal exercises captured span columns`)
    f.motion(0, top)
    expect(await settled(() => f.scroll().getScrollTop() <= 8), `${kind} reversal passes the original source row`)
    f.motion(0, top + 1)
    await f.pauseIsStable(`${kind} reverse gesture pauses in the viewport interior`)
    f.motion(0, top + 1)
    expect(await settled(() => f.ink.selection.focus?.row === top + 1), `${kind} reversed focus reaches its final pointer row`)
    const first = f.scroll().getScrollTop() + 1
    expect(first < 15, `${kind} copied span ends at the original row from the opposite direction`)
    f.release(0, top + 1)
    expect(await settled(() => f.copies().length === before + 1), `${kind} reversed gesture copies once`)
    // The initial word is "text" (cols 6..9). Reversing must retain its FAR
    // edge at col 9, not the near edge (6) or a mutated clamped anchorSpan.
    const expected = selectedRows(first, 15)
    expect(f.copies().at(-1) === expected, `${kind} reversal preserves the exact original far boundary: ${JSON.stringify(f.copies().at(-1))}`)
  } finally { await f.dispose() }
}

async function viewportShrink(): Promise<void> {
  const f = await fixture(60)
  try {
    await f.seek(COUNT - VIEWPORT)
    const { bottom } = f.bounds()
    f.press(rowText(0).length - 1, bottom - 1)
    f.motion(0, 0)
    expect(await settled(() => f.scroll().getScrollTop() <= 29), 'upward edge scroll started before chrome changes')
    await f.addChrome()
    expect(await settled(() => f.scroll().getViewportTop() === 3 && f.scroll().getViewportHeight() === VIEWPORT - 2), 'chrome really moved and shrank the scrolling viewport')
    expect(await settled(() => f.scroll().getScrollTop() === 0 && f.scroll().getPendingDelta() === 0,
      { timeoutMs: 8000 }), 'stationary pointer continues against the new viewport geometry')
    f.release(0, 0)
    expect(await settled(() => f.copies().length === 1), 'resized drag still copies on release')
    expect(f.copies()[0] === selectedRows(0, COUNT - 2), `resize copy contains all original rows and no chrome: ${JSON.stringify(f.copies()[0])}`)
  } finally { await f.dispose() }
}

async function wrappedUnicode(): Promise<void> {
  const lines = Array.from({ length: 12 }, (_, index) => `C${String(index).padStart(3, '0')} 界e\u0301👩‍💻 alpha beta gamma delta`)
  // Soft-wrap metadata is row-wide: a separately painted sidebar is covered
  // by the ownership cases, not mixed into this logical-line copy assertion.
  const f = await fixture(20, { lines, sidebar: false })
  try {
    await f.seek(0)
    const { top } = f.bounds()
    expect(f.scroll().getScrollHeight() > lines.length, 'Unicode fixture actually wraps across multiple screen rows')
    f.press(0, top)
    f.motion(19, ROWS - 1)
    expect(await settled(() => f.scroll().getScrollTop() === f.scroll().getScrollHeight() - VIEWPORT && f.scroll().getPendingDelta() === 0,
      { timeoutMs: 10000 }), 'wrapped Unicode text scrolls to its real content bottom')
    f.release(19, ROWS - 1)
    expect(await settled(() => f.copies().length === 1), 'wrapped Unicode gesture copies once')
    expect(f.copies()[0] === lines.join('\n').normalize('NFC'), `copy preserves CJK, graphemes, and logical soft-wrap joins: ${JSON.stringify(f.copies()[0])}`)
  } finally { await f.dispose() }
}

async function ordinaryWheelResize(): Promise<void> {
  const f = await fixture(60, { viewportHeight: 6 })
  try {
    await f.seek(20)
    const { top } = f.bounds()
    f.press(2, top + 2) // Source row 22, starting inside the row text.
    f.motion(11, top + 3) // Source row 23; neither point touched an edge.
    expect(await settled(() => f.ink.selection.focus?.row === top + 3), 'ordinary drag is active without ever entering edge-scroll mode')
    f.stdin.write(`\x1b[<64;12;${top + 4}M`)
    expect(await settled(() => f.scroll().getScrollTop() === 17 && f.scroll().getPendingDelta() === 0), 'ordinary wheel-up moves three source rows')
    await f.setHeight(8)
    expect(await settled(() => f.scroll().getViewportHeight() === 8), 'ordinary wheel selection viewport really widened from six to eight rows')
    // No motion after the wheel or resize: both endpoints must remain
    // text-anchored, not be pinned to the last mouse screen coordinate.
    f.release(11, top + 3)
    expect(await settled(() => f.copies().length === 1), 'ordinary wheel/resize selection copies once')
    const expected = `${rowText(22).slice(2)}\n${rowText(23)}`
    expect(f.copies()[0] === expected, `never-edge resize preserves the exact original source span: ${JSON.stringify(f.copies()[0])}`)
  } finally { await f.dispose() }
}

async function formerEdgeWheel(): Promise<void> {
  const f = await fixture(60, { viewportHeight: 6 })
  try {
    await f.seek(20)
    const { top, bottom } = f.bounds()
    f.press(2, top + 2)
    f.motion(11, bottom)
    expect(await settled(() => f.ink.selection.focus?.row === bottom && f.scroll().getPendingDelta() === 0,
      { stepMs: 1 }), 'the held pointer actually entered the old bottom edge')
    // Capture the source endpoint before growing the viewport. If a slow
    // runner admitted an edge tick already, retain that legitimate extension.
    const last = f.scroll().getScrollTop() + 5
    await f.setHeight(8)
    expect(await settled(() => f.scroll().getViewportHeight() === 8), 'the old edge became an interior row without another mouse motion')
    await f.pauseIsStable('growing past the parked pointer stops the edge timer')
    const beforeWheel = f.scroll().getScrollTop()
    f.stdin.write(`\x1b[<64;12;${top + 4}M`)
    expect(await settled(() => f.scroll().getScrollTop() === beforeWheel - 3 && f.scroll().getPendingDelta() === 0), 'wheel-up still scrolls after leaving edge mode through layout')
    f.release(11, bottom)
    expect(await settled(() => f.copies().length === 1), 'former-edge wheel selection copies once')
    const expected = `${rowText(22).slice(2)}\n${selectedRows(23, last)}`
    expect(f.copies()[0] === expected, `former edge cannot leave the wheel focus pinned: ${JSON.stringify(f.copies()[0])}`)
  } finally { await f.dispose() }
}

for (const columns of [60, 20]) {
  for (const direction of ['down', 'up'] as const) {
    await verify(`${columns} columns: stationary ${direction} edge selects across screens`, () => crossViewport(columns, direction))
  }
}
await verify('edge reversal copies exactly without duplicate accumulated rows', reverseDirection)
await verify('word-select edge drag preserves its initial word boundary', () => multiClick('word'))
await verify('line-select edge drag preserves its initial line boundary', () => multiClick('line'))
await verify('continuous edge motion cannot debounce away scrolling', continuousMotion)
await verify('word-select reversal preserves the original far boundary', () => multiClickReverse('word'))
await verify('line-select reversal preserves the original far boundary', () => multiClickReverse('line'))
await verify('mid-drag chrome shrink preserves the complete source span', viewportShrink)
await verify('narrow Unicode soft-wrapped rows copy as logical lines', wrappedUnicode)
await verify('never-edge wheel selection stays text-anchored through viewport growth', ordinaryWheelResize)
await verify('a former edge becomes ordinary wheel selection after viewport growth', formerEdgeWheel)
for (const kind of ['interior', 'release', 'escape', 'blur', 'owner-unmount', 'unmount', 'overlay'] as const) {
  await verify(`edge scroll stops on ${kind}`, () => stopGesture(kind))
}
for (const kind of ['header', 'footer', 'panel', 'plain', 'inline', 'overlay', 'bare-press'] as const) {
  await verify(`${kind} selection cannot scroll the transcript`, () => noScroll(kind))
}
console.log(failures === 0 ? '\nAll edge-selection checks passed.' : `\n${failures} edge-selection check(s) failed.`)
process.exitCode = failures === 0 ? 0 : 1
