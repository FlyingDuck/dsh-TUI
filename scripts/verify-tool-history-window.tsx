/**
 * Tool-heavy streaming: bounded mount windows and stable settled-row props.
 * Cold inline history must also reach terminal bytes and native scrollback:
 * mounting a row or painting a logical frame does not prove it was emitted.
 * Run: node --import tsx/esm scripts/verify-tool-history-window.tsx
 */
import './lib/fake-home.mjs'
import '../src/force-production-react.js'
process.env.FORCE_COLOR = '3'
process.env.TERM_PROGRAM = 'WezTerm'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'en'

import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import stripAnsi from 'strip-ansi'
import type { ScrollBoxHandle } from '../src/ui.js'
import type { ChatRow } from '../src/dsh-adapter/channel.js'
import type { DOMElement } from '../src/ink/dom.js'
import { settled } from './lib/term-test.mjs'

const [
  React, { AlternateScreen, Box, render, ScrollBox, Text }, { MessageList }, { Chat }, { QuestionStore },
  { Terminal: XTerm }, { createInitialChannelView }, { formatDuration }, { THINKING_SETTLED_MARKER },
  { activateModernEmojiWidths }, { getTerminalFlushTick, noteTerminalFlush, subscribeTerminalFlush },
] = await Promise.all([
  import('react'), import('../src/ui.js'), import('../src/components/MessageList.js'),
  import('../src/screens/Chat.js'), import('../src/dsh-adapter/questions.js'),
  import('@xterm/headless'), import('../src/dsh-adapter/channel/state.js'),
  import('../src/terminal-utils/format.js'), import('../src/terminal-utils/figures.js'),
  import('./lib/modern-widths.mjs'), import('../src/ink/flush-tick.js'),
])

const initialFlushTick = getTerminalFlushTick()
const flushNotifications: number[] = []
const unsubscribeFlush = subscribeTerminalFlush(() => flushNotifications.push(getTerminalFlushTick()))
noteTerminalFlush()
unsubscribeFlush()
noteTerminalFlush()
assert.deepEqual(flushNotifications, [initialFlushTick + 1], 'flush listeners observe the completed tick and stop after cleanup')
assert.equal(getTerminalFlushTick(), initialFlushTick + 2)

class Input extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
class Sink extends Writable {
  isTTY = true
  columns = 80
  rows = 24
  _write(_chunk: unknown, _encoding: BufferEncoding, done: () => void) { done() }
}

// A short control fits the first sticky mount window. The long fixture's two
// recent thinking rows are inside the default 120-row cap, but outside that
// initial mount window. Earlier history must replace the top spacer in the
// actual terminal, not merely in the DOM or the renderer's logical screen.
for (const total of [12, 1003]) {
  const term = new XTerm({ cols: 100, rows: 40, scrollback: 10_000, allowProposedApi: true })
  activateModernEmojiWidths(term)
  const raw: string[] = []
  class TerminalSink extends Sink {
    columns = 100
    rows = 40
    _write(chunk: unknown, _encoding: BufferEncoding, done: () => void) {
      raw.push(String(chunk))
      term.write(String(chunk), done)
    }
  }
  const reasoningIndices = new Set(total === 12
    ? [1, 5]
    : [...Array.from({ length: 29 }, (_, index) => 20 + index * 29), 870, 890, 905])
  const expectedReasoning = total === 12 ? [1, 5] : [890, 905]
  const expectedAssistants = total === 12 ? [2, 4, 6] : [889, 891, 904, 906]
  const assistantMarker = (index: number) => `INLINE-HISTORY-ASSISTANT-${index}-END`
  const header = (index: number) => `${THINKING_SETTLED_MARKER} Thinking · ${formatDuration((index + 1) * 1000)}`
  const headerBytes = (index: number) => header(index).replace(/\s+/gu, '')
  const rows: ChatRow[] = Array.from({ length: total }, (_, index): ChatRow => {
    const base = { id: index + 1, seq: index + 1 }
    if (reasoningIndices.has(index)) return {
      ...base, kind: 'reasoning', text: `Synthetic reasoning ${index}.`,
      streaming: false, durationMs: (index + 1) * 1000,
    }
    if (index % 23 === 0) return { ...base, kind: 'user', text: `Synthetic user ${index}.` }
    if (index % 17 === 0) return {
      ...base, kind: 'turn-summary', text: '',
      turnUsage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cacheKnown: true, retries: 0, durationMs: 1000, outcome: 'completed' },
    }
    if (index % 5 === 0) return {
      ...base, kind: 'tool', text: '',
      tool: {
        callId: `history-${index}`, name: 'Read', argsText: 'synthetic.txt',
        argsFull: '{"file_path":"/fixture/synthetic.txt"}', resultText: 'Synthetic output.',
        status: 'ok', startedAt: 0, durationMs: 1,
      },
    }
    return { ...base, kind: 'assistant', text: assistantMarker(index), streaming: false }
  })
  const channel = {
    ...createInitialChannelView({
      model: 'test', provider: 'test', cwd: '/fixture', whale: false, whaleIdle: false,
      smoothStreaming: true, thinkingFold: 'preview', activity: false, contextBar: false,
    }, {
      agentId: `inline-history-${total}`, sessionId: `inline-history-${total}`,
      mode: { id: 'normal', name: 'Normal' } as never, cwdDescription: '/fixture',
    }),
    rows, status: 'idle', sessionTitle: 'Synthetic inline history',
    subscribe: () => () => {}, submit() {}, cancel() {}, clear() {}, notify() {},
    loadOlder() {}, setResumeTarget() {}, listModels: async () => [],
    listSessions: async () => [], mcpStatus: () => [],
  }
  const stdout = new TerminalSink()
  const normalLines = () => Array.from({ length: term.buffer.normal.length }, (_, index) =>
    term.buffer.normal.getLine(index)?.translateToString(true) ?? '')
  // Anchor + label + this row's duration excludes a startup tip mentioning
  // "Thinking". Native scrollback is inspected as well as the current viewport.
  const hasHeader = (lines: readonly string[], index: number) =>
    lines.some(line => line.trimStart().startsWith(`${header(index)} `))
  const app = await render(<Chat channel={channel as never} questionStore={new QuestionStore()} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: new Input() as unknown as NodeJS.ReadStream,
    stderr: new Sink() as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false, patchConsole: false,
  })
  try {
    const painted = await settled(() => {
      const lines = normalLines()
      // The diff writes blank cells as cursor movement, not literal spaces.
      const bytes = stripAnsi(raw.join('')).replace(/\s+/gu, '')
      return stdout.writableLength === 0 &&
        lines.some(line => line.includes(assistantMarker(total - 1))) &&
        expectedReasoning.every(index => hasHeader(lines, index) && bytes.includes(headerBytes(index))) &&
        expectedAssistants.every(index => lines.some(line => line.includes(assistantMarker(index))) && bytes.includes(assistantMarker(index)))
    }, { timeoutMs: 4000 })
    const lines = normalLines()
    const bytes = stripAnsi(raw.join('')).replace(/\s+/gu, '')
    const diagnostic = {
      rows: total, baseY: term.buffer.normal.baseY, bufferLength: term.buffer.normal.length,
      headersInBuffer: expectedReasoning.filter(index => hasHeader(lines, index)),
      headersInBytes: expectedReasoning.filter(index => bytes.includes(headerBytes(index))),
      assistantsInBuffer: expectedAssistants.filter(index => lines.some(line => line.includes(assistantMarker(index)))),
      assistantsInBytes: expectedAssistants.filter(index => bytes.includes(assistantMarker(index))),
    }
    assert.equal(term.buffer.active, term.buffer.normal, 'inline history must use the normal buffer')
    assert.ok(painted, `inline cold history never reached terminal output: ${JSON.stringify(diagnostic)}`)
    console.log(`inline cold history reached terminal bytes and scrollback: ${JSON.stringify(diagnostic)}`)
  } finally {
    stdout.isTTY = false
    await app.unmount()
    term.dispose()
  }
}

for (const fullscreen of [true, false]) {
  const rows: ChatRow[] = Array.from({ length: 120 }, (_, i) => ({
    id: i + 1, kind: 'tool', text: '',
    tool: {
      callId: `call-${i}`, name: 'Read', argsText: `module-${i}.ts`,
      status: i === 0 ? 'error' : 'ok', startedAt: 0, durationMs: 10,
      resultText: `source ${i}\nmore source ${i}`, errorText: i === 0 ? 'earlier failure' : undefined,
    },
  }))
  const mounted = new Map<number, DOMElement>()
  const painted = new Set<number>()
  const registerRowRef = (id: number, el: DOMElement | null) => {
    if (el) mounted.set(id, el)
    else mounted.delete(id)
  }
  let handle: ScrollBoxHandle | null = null
  let latestFrame: number[] = []
  let frameCount = 0
  let revision = 0
  let hintRow = 1
  let forced: number | null = null
  const expandedRows = new Set<number>()
  const noop = () => {}
  function Harness() {
    const [scroll, setScroll] = React.useState<ScrollBoxHandle | null>(null)
    handle = scroll
    const content = <Box flexDirection="column">
      <ScrollBox ref={setScroll} height={fullscreen ? 20 : undefined} stickyScroll flexDirection="column">
        <MessageList rows={rows} expanded={false} expandedRows={expandedRows} selectedId={null}
          onToggleRow={noop} model="test" showAll onToggleAll={noop}
          historyPaintEnabled={!fullscreen} registerRowRef={registerRowRef} scrollHandle={scroll}
          failureHintRowId={hintRow} failureHint="See full trajectory" forceMountRowId={forced} />
      </ScrollBox>
      <Text>INPUT-READY {revision}</Text>
    </Box>
    return fullscreen ? <AlternateScreen>{content}</AlternateScreen> : content
  }
  const stdout = new Sink()
  const app = await render(<Harness />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: new Input() as unknown as NodeJS.ReadStream,
    stderr: new Sink() as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false, patchConsole: false,
    onFrame: () => {
      latestFrame = [...mounted.keys()]
      for (const id of latestFrame) painted.add(id)
      frameCount++
    },
  })
  try {
    if (!fullscreen) {
      // Inline history must first reach scrollback. Then a live update may
      // release the flush hold and tighten the mount window again.
      assert.ok(await settled(() => painted.size === 120),
        `inline history must paint before it is unmounted: ${JSON.stringify({ painted: painted.size, mounted: latestFrame, frameCount })}`)
      revision++
      app.rerender(<Harness />)
    }
    assert.ok(await settled(() => latestFrame.includes(120) && latestFrame.length < 30),
      `${fullscreen ? 'fullscreen' : 'inline'}: historical failure pinned ${latestFrame.length} tool cards`)
    assert.ok(!latestFrame.includes(1), 'an offscreen footnote is not a force-mount request')
    if (!fullscreen) continue // Inline history uses the terminal's native scrollback.
    // Explicit seeking still mounts its target. The hint is preserved when
    // the user returns to that card, rather than deleted to reduce work.
    forced = 1
    app.rerender(<Harness />)
    assert.ok(await settled(() => latestFrame.includes(1)))
    const first = mounted.get(1)!
    handle!.scrollToElement(first)
    assert.ok(await settled(() => !handle!.isSticky()))
    forced = null
    app.rerender(<Harness />)
    assert.ok(await settled(() => latestFrame.includes(1) && latestFrame.length < 30))
    // A later failure and a streaming tail must not widen the historical
    // window either. The current viewport remains bounded while reading.
    hintRow = 119
    rows[118]!.tool!.status = 'error'
    rows.push({ id: 121, kind: 'assistant', text: 'new streamed text', streaming: true })
    const before = frameCount
    app.rerender(<Harness />)
    assert.ok(await settled(() => frameCount > before && latestFrame.includes(1) && latestFrame.length < 30),
      `streaming widened the historical window: ${latestFrame.length} cards`)
  } finally {
    await app.unmount()
  }
}

// Exercise the real Chat -> MessageList prop chain as well. Unstable open
// callbacks used to invalidate EVERY MemoRow on each channel version,
// re-reading even collapsed settled tool results while only the tail grew.
{
  let resultReads = 0
  let lastReadAt = 0
  const resultView = () => ({
    card: 'terminal' as const,
    get output() {
      resultReads++
      lastReadAt = Date.now()
      return 'settled tool output\n'.repeat(1_000)
    },
  })
  const tool: ChatRow = {
    id: 1, kind: 'tool', text: '', tool: {
      callId: 'done', name: 'Bash', argsText: 'build', status: 'ok', startedAt: 0,
      resultView: resultView(),
    },
  }
  const tail: ChatRow = { id: 2, kind: 'assistant', text: 'LIVE', streaming: true }
  const listeners = new Set<() => void>()
  const channel = {
    version: 0, rows: [tool, tail], agentId: 'memo-probe', status: 'idle', working: false,
    whale: false, whaleIdle: false, model: 'test', provider: 'test', reasoningEffort: 'high',
    tokens: { input: 0, output: 0 }, cwd: '/tmp', displayCwd: '/tmp', gitBranch: 'main',
    spinnerMode: 'responding', responseChars: 0, activeToolCount: 0, turnStart: 0,
    pending: [], notifications: [], commandList: [], mode: { plan: false }, subagents: [],
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener) },
    submit() {}, cancel() {}, clear() {}, notify() {}, loadOlder() {}, setResumeTarget() {},
    listModels: async () => [], listSessions: async () => [], mcpStatus: () => [],
  }
  let frameCount = 0
  const stdout = new Sink()
  const app = await render(<AlternateScreen>
    <Chat channel={channel as never} questionStore={new QuestionStore()} fullscreen trajectorySeen />
  </AlternateScreen>, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: new Input() as unknown as NodeJS.ReadStream,
    stderr: new Sink() as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false, patchConsole: false,
    onFrame: () => { frameCount++ },
  })
  try {
    assert.ok(await settled(() => resultReads > 0 && frameCount > 0 && Date.now() - lastReadAt >= 100))
    const historicalReads = resultReads
    for (let i = 0; i < 5; i++) {
      const before = frameCount
      tail.text += '.'
      channel.version++
      for (const listener of listeners) listener()
      assert.ok(await settled(() => frameCount > before))
    }
    assert.equal(resultReads, historicalReads, 'streaming must not re-render the unchanged settled tool card')
    tool.tool!.resultView = resultView()
    channel.version++
    for (const listener of listeners) listener()
    assert.ok(await settled(() => resultReads > historicalReads), 'an actual result update still re-renders the card')
  } finally {
    await app.unmount()
  }
}

console.log('tool history passed (bounded windows, seek, streaming row memo, inline and fullscreen)')
