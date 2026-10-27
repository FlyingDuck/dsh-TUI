/**
 * AssistantThinkingMessage live-preview regression.
 *
 * Check painted content as well as the fixed three-row body: paragraph
 * separators must not leave two empty slots, and a long logical line must
 * show its latest three display rows rather than only its first few words.
 *
 * Run: node --import tsx/esm scripts/verify-thinking-preview.tsx
 */
import './lib/fake-home.mjs'
import assert from 'node:assert/strict'

process.env.DSH_TUI_LANG = 'en'
process.env.FORCE_COLOR = '3'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, Box, Text, AlternateScreen }, { AssistantThinkingMessage }, { settled, viewportLines }] =
  await Promise.all([
    import('node:stream'),
    import('react'),
    import('@xterm/headless'),
    import('../src/ui.js'),
    import('../src/components/messages/AssistantThinkingMessage.js'),
    import('./lib/term-test.mjs'),
  ])

const ROWS = 12
const EXPECTED_HEADER_TO_SENTINEL = 4
interface PreviewCase {
  name: string
  thinking: string
  textFull?: string
  expectedRows?: readonly string[]
  filledRows?: number
  latest?: string
  absent?: string
}

const cases: readonly PreviewCase[] = [
  { name: 'short thinking', thinking: 'brief', expectedRows: ['brief', '', ''] },
  { name: 'single-line thinking', thinking: 'one complete line of thinking' },
  {
    name: 'latest logical lines', thinking: 'old-0\nold-1\nline-2\nline-3\nline-4',
    expectedRows: ['line-2', 'line-3', 'line-4'], absent: 'old-0',
  },
  {
    name: 'an omission marker must not displace an exact-width line',
    thinking: 'older\nxxxxxxxxxxxxxxxx\nsecond\nlatest',
    expectedRows: ['xxxxxxxxxxxxxxxx', 'second', 'latest'],
  },
  {
    name: 'trailing paragraph separators', thinking: 'old-0\nline-1\nline-2\nline-3\n\n',
    expectedRows: ['line-1', 'line-2', 'line-3'],
  },
  {
    name: 'trailing spaces and CRLF', thinking: 'old-0\r\nline-1\r\nline-2\r\nline-3\r\n \t\r\n  ',
    expectedRows: ['line-1', 'line-2', 'line-3'],
  },
  {
    name: 'internal paragraph spacing is preserved', thinking: 'old-0\nline-1\n\nline-2\n\n',
    expectedRows: ['line-1', '', 'line-2'],
  },
  {
    name: 'long logical line follows its visual tail',
    thinking: 'OLD-PREFIX ' + 'older words '.repeat(24) + 'LATEST-END',
    filledRows: 3, latest: 'LATEST-END', absent: 'OLD-PREFIX',
  },
  {
    name: 'heading and a wrapped paragraph with trailing separators',
    thinking: '**Synthetic heading**\n\n' + 'synthetic paragraph words '.repeat(24) + 'PARAGRAPH-END\n\n',
    filledRows: 3, latest: 'PARAGRAPH-END', absent: 'Synthetic heading',
  },
  {
    name: 'tabs paint at their measured width',
    thinking: '\t'.repeat(8) + 'TAB-TAIL', latest: 'TAB-TAIL',
  },
  {
    name: 'wide graphemes and wrapped tail',
    thinking: 'OLD-PREFIX ' + '中文e\u0301 '.repeat(16) + 'LATEST-END',
    filledRows: 3, latest: 'LATEST-END', absent: 'OLD-PREFIX',
  },
  {
    name: 'preview follows arrived text instead of the reveal', thinking: 'revealed-only',
    textFull: 'old-0\nfull-1\nfull-2\nfull-3\n\n',
    expectedRows: ['full-1', 'full-2', 'full-3'], absent: 'revealed-only',
  },
  { name: 'whitespace-only thinking holds its height', thinking: ' \n\t\n ', expectedRows: ['', '', ''] },
]

async function renderCase(test: PreviewCase, columns: number, fullscreen: boolean): Promise<string[]> {
  const term = new XTerm({ cols: columns, rows: ROWS, scrollback: 100, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = columns
    rows = ROWS
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
      term.write(String(chunk), callback)
    }
  }
  const stdin = new PassThrough() as NodeJS.ReadStream
  Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, ref: () => stdin, unref: () => stdin })
  const stderr = new Writable({ write(_chunk, _encoding, callback) { callback() } }) as NodeJS.WriteStream
  const body = (
    <Box flexDirection="column" width={columns}>
      <AssistantThinkingMessage thinking={test.thinking} textFull={test.textFull} marginTopOnTurn={false} verbose={false} streaming preview />
      <Box height={1}><Text>preview-sentinel</Text></Box>
    </Box>
  )
  const app = await render(fullscreen ? <AlternateScreen>{body}</AlternateScreen> : body, {
    stdout: new FakeStdout() as NodeJS.WriteStream, stdin, stderr,
    exitOnCtrlC: false, patchConsole: false,
  })
  try {
    assert.ok(await settled(() => viewportLines(term).some(line => line.includes('preview-sentinel'))), 'preview fixture painted')
    return viewportLines(term)
  } finally {
    app.unmount()
    term.dispose()
  }
}

for (const fullscreen of [false, true]) {
  for (const columns of [20, 32]) {
    for (const test of cases) {
      const name = `${fullscreen ? 'fullscreen' : 'inline'} ${columns}: ${test.name}`
      const lines = await renderCase(test, columns, fullscreen)
      const header = lines.findIndex(line => line.includes('Thinking'))
      const sentinel = lines.findIndex(line => line.includes('preview-sentinel'))
      const detail = `\n${lines.join('\n')}`
      assert.ok(header >= 0, name + ': thinking header is visible' + detail)
      assert.equal(sentinel - header, EXPECTED_HEADER_TO_SENTINEL, name + ': fixed three-row body' + detail)
      const body = lines.slice(header + 1, sentinel)
      assert.ok(body.every(line => line.startsWith('  │') && (line[3] === undefined || line[3] === ' ')), name + ': all three rails stay aligned' + detail)
      const payload = body.map(line => line.slice(4).trim())
      if (test.expectedRows !== undefined) {
        for (const [index, expected] of test.expectedRows.entries()) {
          assert.ok(expected === '' ? payload[index] === '' : payload[index]?.includes(expected), name + `: body row ${index + 1} contains ${JSON.stringify(expected)}` + detail)
        }
      }
      if (test.filledRows !== undefined) assert.equal(payload.filter(Boolean).length, test.filledRows, name + ': visible rows contain reasoning' + detail)
      if (test.latest !== undefined) assert.ok(payload.some(line => line.includes(test.latest!)), name + ': newest tokens remain visible' + detail)
      if (test.absent !== undefined) assert.ok(payload.every(line => !line.includes(test.absent!)), name + ': older text does not replace the tail' + detail)
      console.log('PASS: ' + name)
    }
  }
}
console.log(`AssistantThinkingMessage preview height and content regressions passed (${cases.length * 4} cases)`)
