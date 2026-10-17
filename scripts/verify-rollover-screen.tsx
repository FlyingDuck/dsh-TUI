/**
 * `/rollover` screen flow: the Chat dispatcher's rollover-then-new transaction,
 * in the order and with the copy the user actually sees.
 *
 * The channel-side invariants (the archived name, the refusal that must land
 * before the rename) live in verify-rollover-command. This drives the real Chat
 * screen through xterm and pins what only the screen decides:
 *
 *  - `channel.rolloverSession()` runs BEFORE `channel.newSession()`, and a
 *    refused rollover never reaches the new-session transaction at all;
 *  - the successor inherits a title the USER set (`channel.renameSession`) and
 *    an auto-generated one is not carried over;
 *  - a rename that landed but whose session switch was then vetoed says so,
 *    instead of leaving a silent rename behind.
 *
 * Run: node --import tsx/esm scripts/verify-rollover-screen.tsx
 * Exits non-zero on any assertion failure (CI gate).
 */
import './lib/default-lang-zh.mjs'
import './lib/fake-home.mjs'

process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'

const [
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render },
  { Chat },
  { settle, settled, sleep, viewportLines },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('./lib/term-test.mjs'),
])

const COLS = 100
const ROWS = 30

// One screen per scenario. A shared buffer would let the NEXT scenario's
// "the typed line reached the composer" gate match the PREVIOUS scenario's
// leftover frame, and its Enter would then race the typing on a loaded
// runner — the failure mode would be a missing command, not a wrong paint.
let screen = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
let typedInput = new PassThrough()

class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void) { screen.write(String(chunk), callback) }
}
class FakeStderr extends Writable {
  isTTY = true
  _write(_chunk: unknown, _encoding: BufferEncoding, callback: () => void) { callback() }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}

let failures = 0
function check(name: string, condition: boolean, detail = ''): void {
  console.log(`${condition ? 'PASS' : 'FAIL'}: ${name}${detail === '' ? '' : `  (${detail})`}`)
  if (!condition) failures += 1
}

function screenText(): string {
  return viewportLines(screen, ROWS).join('\n')
}

/** The channel as the screen sees it, with the archive transaction scripted. */
function makeChannel(script: {
  rollover: () => Promise<unknown>
  openNew?: () => Promise<boolean>
}) {
  const listeners = new Set<() => void>()
  const calls: string[] = []
  const renameCalls: string[] = []
  const notifications: Array<{ id: number; text: string; color?: string; timeoutMs?: number }> = []
  let noticeId = 0
  const channel: any = {
    version: 0,
    rows: [{ id: 1, kind: 'user', text: '归档前的对话' }],
    status: 'idle',
    sessionTitle: '归档前的标题',
    sessionColor: '',
    promptSessionLabel: true,
    agentId: 'archive-screen',
    model: 'deepseek-v4-flash',
    provider: 'deepseek',
    tokens: { input: 20, output: 10 },
    cwd: '/proj/bean',
    displayCwd: '/proj/bean',
    gitBranch: 'main',
    working: false,
    spinnerMode: 'requesting',
    responseChars: 0,
    activeToolCount: 0,
    turnStart: 0,
    lastUserText: '',
    pending: [],
    notifications,
    contextWindow: undefined,
    reasoningEffort: 'max',
    activityEnabled: false,
    contextBarEnabled: true,
    agentPreset: 'standard',
    goal: undefined,
    todos: [],
    commandList: [
      { name: 'rollover', description: 'Roll this session over as project-date-NN and start a new one' },
      { name: 'new', description: 'Start a new session' },
    ],
    commandCompletions(input: string) {
      const prefix = input.replace(/^\//u, '').trim().toLowerCase()
      return this.commandList
        .filter((command: { name: string }) => command.name.startsWith(prefix))
        .map((command: { name: string; description: string }) => ({
          ...command,
          commandLine: `/${command.name}`,
          replacement: `/${command.name} `,
        }))
    },
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    mode: { id: 'default', plan: false, sandbox: 'workspace-write', approval: 'ask' },
    modeIndex: 0,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    notify(text: string, options?: { color?: string; timeoutMs?: number }) {
      notifications.push({ id: ++noticeId, text, ...options })
      channel.emit()
    },
    pushLocal() {},
    setSessionColor() {},
    renameSession(title: string) {
      renameCalls.push(title)
      channel.sessionTitle = title
      channel.emit()
    },
    rolloverSession() {
      calls.push('rolloverSession')
      return script.rollover()
    },
    newSession() {
      calls.push('newSession')
      return script.openNew === undefined ? Promise.resolve(true) : script.openNew()
    },
    emit() {
      channel.version += 1
      for (const listener of listeners) listener()
    },
    submit() {},
    steer() {},
    removePending: () => true,
    cancel() {},
    interruptAndDeliver: () => 0,
    clear() {},
    loadOlder: () => 0,
    listModels: async () => [],
    listFiles: async () => [],
    listSessions: async () => [],
    setResumeTarget() {},
    setActivityFrames: () => true,
    activityFrames: 'moon8',
    runExternalCommand: async () => '',
    mcpStatus: () => [],
    exportSession: () => null,
    initWorkspace: () => null,
    doctorInfo: () => [],
    pluginsInfo: () => Promise.resolve([]),
    listSubagents: async () => [],
    listPresets: async () => [],
    switchPreset: async () => false,
    switchModel: async () => false,
    rewindTo: async () => null,
    resumeTo: async () => ({ ok: false, reason: 'unavailable' }),
    compact() {},
    traceEvents: () => [],
    settingsSections: () => [],
    subscribeSettingsSections: () => () => {},
    calls,
    renameCalls,
  }
  return channel
}

/**
 * Type one command into the real composer and run it, then wait for the
 * screen to show the outcome. The archive flow is a promise chain
 * (`rolloverSession().then(newSession)`), so asserting on the mock straight
 * after Enter would read it before it ran: every scenario waits on its own
 * visible completion signal first, and only then checks the call order.
 */
async function run(line: string, signal: () => boolean): Promise<boolean> {
  typedInput.write(line)
  await settle(() => screenText().includes(line))
  typedInput.write('\r')
  return settled(signal, { timeoutMs: 10000 })
}

const questionStore = { subscribe: () => () => {}, getSnapshot: () => null, answerCurrent: () => {} }
const approvalStore = { subscribe: () => () => {}, getSnapshot: () => null }

async function withChat<T>(channel: unknown, body: () => Promise<T>): Promise<T> {
  screen = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  typedInput = new FakeStdin()
  const instance = await render(
    <Chat fullscreen channel={channel as never} questionStore={questionStore as never} approvalStore={approvalStore as never} />,
    { stdout: new FakeStdout(), stderr: new FakeStderr(), stdin: typedInput as never, exitOnCtrlC: false, patchConsole: false },
  )
  try {
    return await body()
  } finally {
    instance.unmount()
    typedInput.destroy()
  }
}

// ── 1. The archived session is renamed first, then the successor opens ─────
const inherited = makeChannel({
  rollover: async () => ({ ok: true, title: 'bean-2026-10-17-03', inherit: '我的会话' }),
})
await withChat(inherited, async () => {
  const reached = await run('/rollover', () => screenText().includes('已结转为「bean-2026-10-17-03」'))
  check('the rollover transaction reaches its notice', reached)
  check('`/rollover` rolls over before it opens anything', JSON.stringify(inherited.calls) === JSON.stringify(['rolloverSession', 'newSession']),
    JSON.stringify(inherited.calls))
  check('a user title is handed to the successor', JSON.stringify(inherited.renameCalls) === JSON.stringify(['我的会话']),
    JSON.stringify(inherited.renameCalls))
  check('the successor carries that title', inherited.sessionTitle === '我的会话', inherited.sessionTitle)
  check('the notice names both the archived name and the inherited title',
    screenText().includes('已结转为「bean-2026-10-17-03」，新会话沿用「我的会话」'),
    screenText().split('\n').filter(line => line.includes('归档')).join(' / '))
})

// ── 2. An auto-generated title is not carried over ────────────────────────
const generated = makeChannel({ rollover: async () => ({ ok: true, title: 'bean-2026-10-17-04' }) })
await withChat(generated, async () => {
  const reached = await run('/rollover', () => screenText().includes('已结转为「bean-2026-10-17-04」'))
  check('the rollover without an inherited title reaches its notice', reached)
  check('an auto-generated title is not renamed onto the successor', generated.renameCalls.length === 0,
    JSON.stringify(generated.renameCalls))
  check('the notice reports the archive alone',
    screenText().includes('已结转为「bean-2026-10-17-04」并新开会话'), screenText().split('\n').filter(line => line.includes('归档')).join(' / '))
})

// ── 3. A refused archive never reaches the new-session transaction ────────
const refused = makeChannel({ rollover: async () => ({ ok: false, reason: 'working' }) })
await withChat(refused, async () => {
  const reached = await run('/rollover', () => refused.calls.length > 0)
  check('the refused rollover still reaches the channel', reached)
  // Absence needs a settle window of its own: the new-session call would be a
  // second link in the same promise chain, so a few ticks is the whole race.
  await sleep(150)
  check('a refused rollover does not open a new session', JSON.stringify(refused.calls) === JSON.stringify(['rolloverSession']),
    JSON.stringify(refused.calls))
  check('and renames nothing', refused.renameCalls.length === 0)
  check('the screen adds no rollover notice of its own', refused.notifications.length === 0,
    JSON.stringify(refused.notifications))
})

// ── 4. A rename that landed but whose switch was vetoed says so ───────────
const vetoed = makeChannel({ rollover: async () => ({ ok: true, title: 'bean-2026-10-17-05', inherit: '我的会话' }), openNew: async () => false })
await withChat(vetoed, async () => {
  const reached = await run('/rollover', () => screenText().includes('但新会话没有打开'))
  check('the failed switch is reported instead of a silent rename', reached,
    screenText().split('\n').filter(line => line.includes('归档')).join(' / '))
  check('and the rollover is named in it', screenText().includes('已结转为「bean-2026-10-17-05」，但新会话没有打开'))
  check('the successor title is not applied to a session that never opened', vetoed.renameCalls.length === 0,
    JSON.stringify(vetoed.renameCalls))
})

console.log(failures === 0 ? 'verify:rollover-screen OK' : `verify:rollover-screen FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
