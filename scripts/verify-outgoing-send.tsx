/**
 * Outgoing input lifecycle through the real channel, guarded UI facade and Chat.
 * No model, credentials or network: the session's admission receipts and durable
 * user events are independently controlled. Checks must fail when a receipt is
 * mistaken for persistence, a late refusal resurrects an already-confirmed input,
 * an async refusal loses a draft/image, or a recovery overwrites a newer draft.
 * Run: node --import tsx/esm scripts/verify-outgoing-send.tsx
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import type { AgentSession, AgentInput, SubmitPlacement } from '../src/agent/session.js'
import type { AgentEvent, AgentEventMeta } from '../src/agent/events.js'
import type { PromptController } from '../src/components/PromptInput.js'

const home = mkdtempSync(join(tmpdir(), 'dsh-tui-outgoing-'))
process.env.HOME = process.env.USERPROFILE = home
process.env.DSH_HOME = join(home, 'dsh')
process.env.DSH_TUI_LANG = 'en'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_DISABLE_TERMINAL_IMAGES = '1'
process.env.FORCE_COLOR = '3'

const [React, xterm, ui, { Chat }, { createChannel }, { mountChannelUi },
  { registerTuiChannel }, { QuestionStore }, { settled, viewportLines, findText, sleep },
] = await Promise.all([
  import('react'), import('@xterm/headless'), import('../src/ui.js'),
  import('../src/screens/Chat.js'), import('../src/dsh-adapter/channel.js'),
  import('../src/dsh-adapter/channel-ui.js'), import('../src/adapter/channel/host-registry.js'),
  import('../src/channel/questions.js'), import('./lib/term-test.mjs'),
])
const XTerm = xterm.Terminal ?? xterm.default.Terminal

type Receipt = Awaited<ReturnType<AgentSession['submit']>>
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
let checks = 0
function check(label: string, condition: unknown, detail?: unknown): asserts condition {
  checks += 1
  assert.ok(condition, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`)
  console.log(`PASS ${label}`)
}
async function wait(label: string, predicate: () => boolean): Promise<void> {
  check(label, await settled(predicate, { timeoutMs: 8000 }))
}
function fakeSession(id: string) {
  const listeners = new Set<(events: readonly AgentEvent[], meta: AgentEventMeta) => void>()
  const submits: { input: AgentInput; placement: SubmitPlacement; receipt: ReturnType<typeof deferred<Receipt>> }[] = []
  let seq = 1
  const session: AgentSession = {
    ref: { backendId: 'fake', sessionId: id }, cwd: home, status: 'idle',
    capabilities: {
      native: {},
      images: { limits: { mediaTypes: ['image/png'], maxImageBytes: 1_000_000, maxImagesPerMessage: 8,
        maxMessageImageBytes: 8_000_000, maxImageDimension: 8192, maxImagePixels: 64_000_000 } },
      pendingRetraction: { remove: () => true },
    },
    history: async () => [],
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    submit(input, placement) {
      const receipt = deferred<Receipt>()
      submits.push({ input, placement, receipt })
      return receipt.promise
    },
    cancel: async () => ({ stillQueued: [], outcome: 'confirmed' }),
    dispose: async () => {},
  }
  const emit = (...events: AgentEvent[]): void => {
    for (const listener of [...listeners]) listener(events, { replay: false, wake: 'sync' })
  }
  const confirm = (index: number): void => {
    const { input } = submits[index]!
    emit({ type: 'user.message', id: input.clientMessageId, anchor: input.clientMessageId,
      seq: seq++, time: Date.now(), source: 'user', text: input.text,
      blocks: input.blocks ?? [{ type: 'text', text: input.text }] })
  }
  return { session, submits, emit, confirm }
}
function fixture() {
  const first = fakeSession(`outgoing-${Math.random()}`)
  const next = fakeSession(`next-${Math.random()}`)
  const ctx = { on: () => () => {}, get: () => undefined,
    logger: { warn() {}, info() {}, debug() {} } }
  const raw = createChannel(ctx as never, first.session, {
    model: 'OUTGOING_MODEL', provider: '', cwd: home, activity: false,
    whale: false, whaleIdle: false, launchpad: false,
    openSession: async () => next.session,
  })
  const unregister = registerTuiChannel(ctx, raw)
  const mounted = mountChannelUi(ctx, raw, undefined, 'new')
  return { raw, channel: mounted.channel, first, next,
    close() { mounted.dispose(); unregister(); raw.releaseContributions() } }
}
type Fixture = ReturnType<typeof fixture>
const outgoing = (f: Fixture) => f.channel.outgoing ?? []
const firstId = (f: Fixture) => outgoing(f)[0]!.id

// ── Channel/receipt truth, including the production detached UI view. ─────────
{
  const f = fixture()
  try {
    f.channel.submit('PENDING_ONE')
    check('enqueue publishes a sending record synchronously', outgoing(f).length === 1 && outgoing(f)[0]?.phase === 'sending')
    const id = firstId(f)
    check('a pending preview is never a durable transcript row', !f.raw.rows.some(row => row.kind === 'user' && row.text === 'PENDING_ONE'))
    await wait('submission reaches the backend', () => f.first.submits.length === 1)
    check('outgoing, backend and inbox use the same id', f.first.submits[0]?.input.clientMessageId === id && f.raw.pending[0]?.id === id)
    f.first.submits[0]!.receipt.resolve({ accepted: true })
    await wait('an admission receipt only marks queued', () => outgoing(f)[0]?.phase === 'queued')
    check('queued input still has no durable bubble', !f.raw.rows.some(row => row.kind === 'user' && row.text === 'PENDING_ONE'))
    f.first.emit({ type: 'pending.changed', items: [], claimed: [id] })
    check('claiming an inbox item is not persistence confirmation', outgoing(f).some(item => item.id === id))
    let duplicated = false
    const unsubscribe = f.raw.subscribe(() => {
      if (outgoing(f).some(item => item.id === id) && f.raw.rows.some(row => row.kind === 'user' && row.text === 'PENDING_ONE')) duplicated = true
    })
    f.first.confirm(0)
    check('durable confirmation replaces the preview atomically', outgoing(f).length === 0 && !duplicated)
    check('exactly one durable bubble remains', f.raw.rows.filter(row => row.kind === 'user' && row.text === 'PENDING_ONE').length === 1)
    unsubscribe()
  } finally { f.close() }
}
{
  const f = fixture()
  try {
    f.channel.submit('SAME_TEXT')
    f.channel.submit('SAME_TEXT')
    const [a, b] = outgoing(f).map(item => item.id)
    check('identical text retains distinct submission identities', a !== b && outgoing(f).length === 2)
    await wait('first duplicate-text input is dispatched', () => f.first.submits.length === 1)
    f.first.confirm(0)
    f.first.submits[0]!.receipt.resolve({ accepted: false, reason: 'late refusal' })
    await wait('FIFO progresses after a late refusal', () => f.first.submits.length === 2)
    check('confirmation wins over a later negative receipt', outgoing(f).length === 1 && outgoing(f)[0]?.id === b)
    check('the second equal-text input is not swallowed', f.first.submits[1]?.input.clientMessageId === b)
    f.first.submits[1]!.receipt.resolve({ accepted: true })
    f.first.confirm(1)
    check('both confirmed equal-text inputs appear once', outgoing(f).length === 0 && f.raw.rows.filter(row => row.kind === 'user' && row.text === 'SAME_TEXT').length === 2)
  } finally { f.close() }
}
{
  const f = fixture()
  try {
    f.channel.submit('REFUSED')
    await wait('refused input reaches admission', () => f.first.submits.length === 1)
    const id = firstId(f)
    f.first.emit({ type: 'pending.changed', items: [], discarded: [id] })
    f.first.submits[0]!.receipt.resolve({ accepted: false, reason: 'not admitted' })
    await wait('an explicit refusal produces a recoverable failed record', () => outgoing(f)[0]?.phase === 'failed')
    check('failed delivery is not left in the backend queue', f.raw.pending.length === 0)
    check('the reason is surfaced without creating a fake message', f.raw.notifications.some(note => note.text.includes('not admitted')) && f.raw.rows.every(row => row.kind !== 'user'))
    const recovered = f.channel.recoverFailedOutgoing?.(id)
    check('recovery returns the original input exactly once', recovered?.text === 'REFUSED' && outgoing(f).length === 0 && f.channel.recoverFailedOutgoing?.(id) === undefined)
    f.channel.submit('NEXT_INPUT')
    await wait('failure does not wedge subsequent sends', () => f.first.submits.length === 2)
    f.first.submits[1]!.receipt.resolve({ accepted: true })
    f.first.confirm(1)
  } finally { f.close() }
}
{
  const f = fixture()
  try {
    f.channel.submit('UNCERTAIN')
    await wait('uncertain input was handed to the backend', () => f.first.submits.length === 1)
    const id = firstId(f)
    f.first.emit({ type: 'pending.changed', items: [], discarded: [id] })
    check('a discard without an admission verdict is not a recoverable refusal', outgoing(f)[0]?.phase !== 'failed')
    f.first.submits[0]!.receipt.reject(new Error('connection closed after write'))
    await wait('an ambiguous rejection is not classified as definitely unsent', () => outgoing(f)[0]?.phase === 'uncertain')
    check('uncertain delivery cannot be pulled back and resent', f.channel.recoverFailedOutgoing?.(id) === undefined && outgoing(f).length === 1)
    f.first.confirm(0)
    check('late durable confirmation resolves uncertainty', outgoing(f).length === 0 && f.raw.rows.some(row => row.kind === 'user' && row.text === 'UNCERTAIN'))
  } finally { f.close() }
}
{
  const f = fixture()
  try {
    f.channel.attachContext({ source: 'panel', sourceId: 'one', title: 'context', content: 'original bytes' })
    f.channel.submit('WITH_CONTEXT')
    await wait('attached context follows the submission', () => f.first.submits.length === 1)
    check('submitted context was consumed once', f.raw.attachedContexts.length === 0)
    const id = firstId(f)
    f.channel.attachContext({ source: 'panel', sourceId: 'one', title: 'context', content: 'new bytes' })
    f.first.submits[0]!.receipt.resolve({ accepted: false })
    await wait('context-bearing refusal is recoverable', () => outgoing(f)[0]?.phase === 'failed')
    f.channel.recoverFailedOutgoing?.(id)
    check('recovering an old input never overwrites a newer same-source context', f.raw.attachedContexts.length === 1 && f.raw.attachedContexts[0]?.content === 'new bytes')
  } finally { f.close() }
}
{
  const f = fixture()
  try {
    f.channel.submit('OLD_SESSION')
    await wait('old session send started', () => f.first.submits.length === 1)
    check('an unresolved admission retains the existing session-switch guard', await f.raw.newSession() === false)
    f.first.submits[0]!.receipt.resolve({ accepted: true })
    await wait('the old input is queued but still unconfirmed', () => outgoing(f)[0]?.phase === 'queued')
    check('session switch succeeds once admission has settled', await f.raw.newSession())
    check('the replacement session has no old outgoing input', outgoing(f).length === 0)
    f.first.emit({ type: 'notice', level: 'error', text: 'old refusal' })
    f.first.confirm(0)
    check('late old-session events cannot restore into another conversation', outgoing(f).length === 0 && !f.raw.notifications.some(note => note.text === 'old refusal') && f.raw.rows.every(row => row.kind !== 'user'))
  } finally { f.close() }
}
{
  const f = fixture()
  try {
    f.channel.submit('DOCKED_INPUT')
    await wait('docked input was dispatched', () => f.first.submits.length === 1)
    f.first.submits[0]!.receipt.resolve({ accepted: true })
    await wait('docked input admission settled', () => outgoing(f)[0]?.phase === 'queued')
    check('interrupt holds rather than resends the input', f.channel.interruptAndDock() === 1)
    await wait('held input remains in the dock', () => f.raw.pending[0]?.docked === true)
    const id = f.raw.pending[0]!.id
    check('manual dock retraction succeeds', f.channel.removePending(id))
    check('manual retraction retires any duplicate outgoing ownership', !outgoing(f).some(item => item.id === id))
  } finally { f.close() }
}

// A backend-handled native command expects no future durable user bubble.
{
  const f = fixture()
  try {
    f.channel.submit('BACKEND_HANDLED')
    await wait('native handler receives the input', () => f.first.submits.length === 1)
    f.first.submits[0]!.receipt.resolve({ accepted: true, handled: true })
    await wait('handled admission retires the preview without waiting for a user event', () => outgoing(f).length === 0 && f.raw.pending.length === 0)
    check('handled admission does not fabricate a durable user message', f.raw.rows.every(row => row.kind !== 'user'))
  } finally { f.close() }
}

// Capacity refusal happens before consuming the new draft's context.
{
  const f = fixture()
  try {
    for (let index = 0; index < 64; index += 1) f.channel.submit(`QUEUED_${index}`)
    f.channel.attachContext({ source: 'panel', sourceId: 'capacity', title: 'keep', content: 'keep this chip' })
    assert.throws(() => f.channel.submit('OVER_CAPACITY'))
    check('capacity refuses new input without dropping existing previews', outgoing(f).length === 64)
    check('a rejected enqueue does not consume new attached context', f.raw.attachedContexts[0]?.content === 'keep this chip')
  } finally { f.close() }
}
// An old queued copy and a new equal-text draft are not the same input.
{
  const f = fixture()
  try {
    f.channel.submit('SAME_INTERRUPT_TEXT')
    await wait('interrupt race original is dispatched', () => f.first.submits.length === 1)
    f.first.submits[0]!.receipt.resolve({ accepted: true })
    await wait('interrupt race original is queued', () => outgoing(f)[0]?.phase === 'queued')
    const id = firstId(f)
    const cancelled = deferred<Awaited<ReturnType<AgentSession['cancel']>>>()
    f.first.session.cancel = () => cancelled.promise
    check('interrupt identifies old input separately from an equal new draft', f.channel.interruptAndDeliver([
      { pendingId: id, text: 'SAME_INTERRUPT_TEXT' }, { text: 'SAME_INTERRUPT_TEXT' },
    ]) === 2)
    f.first.confirm(0)
    cancelled.resolve({ stillQueued: [], outcome: 'confirmed' })
    await wait('only the new equal-text draft is dispatched after late confirmation', () => f.first.submits.length === 2)
    f.first.submits[1]!.receipt.resolve({ accepted: true })
    await wait('new equal-text draft remains separately queued', () => outgoing(f).length === 1 && outgoing(f)[0]?.phase === 'queued')
    check('already-confirmed old copy is never automatically re-sent', f.first.submits.length === 2 && outgoing(f)[0]?.id !== id)
    f.first.confirm(1)
  } finally { f.close() }
}

// Preview placement is enqueue-time UI intent, not a later admission phase.
{
  const f = fixture()
  try {
    f.first.emit({ type: 'turn.start', turn: 1, origin: 'user', time: 0 })
    f.channel.steer('RUNNING_ORIGIN')
    check('running input captures composer-queue origin synchronously', outgoing(f)[0]?.queuePlacement === 'steer')
    f.first.emit({ type: 'turn.end', turn: 1, reason: { kind: 'completed' }, time: 0 })
    await wait('running-origin input survives its FIFO while the prior turn ends', () => f.first.submits.length === 1)
    f.first.submits[0]!.receipt.resolve({ accepted: true })
    await wait('admission preserves running-origin placement', () => outgoing(f)[0]?.phase === 'queued')
    check('ending a turn does not promote an unclaimed queue item to the transcript', outgoing(f)[0]?.queuePlacement === 'steer')
    f.channel.submit('IDLE_ORIGIN')
    check('idle direct input does not acquire a queue origin', outgoing(f).find(item => item.text === 'IDLE_ORIGIN')?.queuePlacement === undefined)
    f.first.emit({ type: 'turn.start', turn: 2, origin: 'user', time: 0 })
    check('starting a turn does not reclassify an idle-origin preview', outgoing(f).find(item => item.text === 'IDLE_ORIGIN')?.queuePlacement === undefined)
  } finally { f.close() }
}
{
  const f = fixture()
  try {
    f.first.emit({ type: 'turn.start', turn: 1, origin: 'user', time: 0 })
    f.channel.interruptAndDeliver([{ text: 'EXPLICIT_INTERRUPT_SEND' }])
    await wait('an explicit interrupt send reaches the backend once', () => f.first.submits.length === 1)
    check('interrupt send is not mistaken for ordinary running queue input', outgoing(f)[0]?.queuePlacement === undefined)
  } finally { f.close() }
}

// ── Actual input events, draft safety, image capabilities and confirmation. ──
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
async function mount(fullscreen: boolean, columns: number, launchpad = false) {
  const f = fixture()
  const term = new XTerm({ cols: columns, rows: 32, scrollback: 200, allowProposedApi: true })
  const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) { term.write(String(chunk), done) } }), { columns, rows: 32, isTTY: true })
  const stderr = Object.assign(new Writable({ write(_chunk, _encoding, done) { done() } }), { isTTY: true })
  const stdin = new FakeStdin()
  const controller = { current: null as PromptController | null }
  const app = await ui.render(React.createElement(Chat, { channel: f.channel, fullscreen,
    questionStore: new QuestionStore(), promptControllerRef: controller, launchpadOnBoot: launchpad }),
  { stdout: stdout as never, stderr: stderr as never, stdin: stdin as never, exitOnCtrlC: false, patchConsole: false })
  let lastEnterAt = 0
  return { f, term, stdin, controller,
    async enter() {
      const remaining = 90 - (Date.now() - lastEnterAt)
      // 固定窗:墙钟 the composer's 80ms CR/LF debounce must not eat a new retry.
      if (remaining > 0) await sleep(remaining)
      stdin.write('\r')
      lastEnterAt = Date.now()
    },
    lines: () => viewportLines(term),
    close: async () => { app.unmount(); await new Promise<void>(resolve => stdout.write('', () => resolve())); f.close(); term.dispose() },
  }
}
if (process.env.VERIFY_OUTGOING_CORE_ONLY !== '1') {
for (const fullscreen of [false, true]) for (const columns of [40, 100]) {
  const rig = await mount(fullscreen, columns)
  const label = `${fullscreen ? 'fullscreen' : 'inline'} ${columns} columns`
  const text = `SEND_${fullscreen ? 'FULL' : 'INLINE'}_${columns}`
  try {
    await wait(`${label}: composer mounts`, () => rig.controller.current !== null)
    rig.stdin.write(`\x1b[200~${text}\x1b[201~`)
    await wait(`${label}: draft is editable before sending`, () => rig.controller.current?.text?.() === text)
    await rig.enter()
    await wait(`${label}: backend admission is in flight`, () => rig.f.first.submits.length === 1)
    await wait(`${label}: sending clears only the submitted draft`, () => rig.controller.current?.text?.() === '')
    await wait(`${label}: unconfirmed input is visible in the conversation`, () => rig.lines().some(line => line.includes(text)))
    check(`${label}: pending input is not a durable row`, rig.f.raw.rows.every(row => row.kind !== 'user'))
    check(`${label}: the same input is not shown in an old queue overlay too`, rig.lines().filter(line => line.includes(text)).length === 1, rig.lines())
    check(`${label}: no textual sending or queued labels are added`, !rig.lines().some(line => /sending|queued|follow-up|steering/iu.test(line)), rig.lines())
    rig.f.first.submits[0]!.receipt.resolve({ accepted: false, reason: 'REJECTED_BY_FIXTURE' })
    await wait(`${label}: explicit failure restores the submitted draft`, () => rig.controller.current?.text?.() === text)
    check(`${label}: automatic recovery consumes its temporary record`, outgoing(rig.f).length === 0)

    // The next failed submission must not overwrite anything typed meanwhile.
    await rig.enter()
    check(`${label}: retry starts once`, await settled(() => rig.f.first.submits.length === 2, { timeoutMs: 8000 }),
      { draft: rig.controller.current?.text(), outgoing: outgoing(rig.f), pending: rig.f.raw.pending, lines: rig.lines() })
    rig.stdin.write('\x1b[200~NEW_DRAFT\x1b[201~')
    await wait(`${label}: a newer draft is present`, () => rig.controller.current?.text?.() === 'NEW_DRAFT')
    rig.f.first.submits[1]!.receipt.resolve({ accepted: false, reason: 'REJECTED_WITH_NEW_DRAFT' })
    await wait(`${label}: failed input remains available for recovery`, () => outgoing(rig.f).some(item => item.phase === 'failed'))
    check(`${label}: the newer draft is not replaced`, rig.controller.current?.text?.() === 'NEW_DRAFT')
    // A whitespace-only draft is still a draft, not permission to overwrite.
    rig.controller.current!.clear()
    rig.controller.current!.append('   ')
    await wait(`${label}: whitespace draft remains protected`, () => rig.controller.current?.text?.() === '   ')
    check(`${label}: failed input is not consumed by a whitespace draft`, outgoing(rig.f).some(item => item.phase === 'failed'))
    rig.controller.current!.clear()
    await wait(`${label}: clearing the new draft restores the failed original`, () => rig.controller.current?.text?.() === text)
    await rig.enter()
    await wait(`${label}: recovered input is submitted exactly once`, () => rig.f.first.submits.length === 3)
    rig.f.first.confirm(2)
    rig.f.first.submits[2]!.receipt.resolve({ accepted: true })
    await wait(`${label}: persisted confirmation replaces the transient input`, () => outgoing(rig.f).length === 0 && rig.f.raw.rows.filter(row => row.kind === 'user' && row.text === text).length === 1)
    check(`${label}: successful confirmation does not put a draft back`, rig.controller.current?.text?.() === '')
  } finally { await rig.close() }
}

// Running Enter/Tab must retain the original dim arrow queue, not a second
// transcript bubble. Model output and working=false alone cannot promote it.
for (const fullscreen of [false, true]) for (const columns of [40, 100]) {
  for (const placement of ['steer', 'followup'] as const) {
    const rig = await mount(fullscreen, columns)
    const label = `${fullscreen ? 'fullscreen' : 'inline'} ${columns} ${placement} queue`
    const text = placement === 'steer' ? 'QUEUE_STEER' : 'QUEUE_FOLLOWUP'
    const appearance = (value: string) => {
      const at = findText(rig.term, value)
      if (at === null) return undefined
      const line = rig.term.buffer.active.getLine(rig.term.buffer.active.baseY + at.row)
      return { line: line?.translateToString(true),
        fg: Array.from({ length: value.length }, (_, index) => line?.getCell(at.col + index)?.getFgColor()),
        bold: Array.from({ length: value.length }, (_, index) => line?.getCell(at.col + index)?.isBold()) }
    }
    try {
      await wait(`${label}: composer mounts`, () => rig.controller.current !== null)
      rig.f.first.emit(
        { type: 'turn.start', turn: 1, origin: 'user', userMessageId: 'older', time: Date.now() },
        { type: 'step.start', turn: 1, step: 1 },
        { type: 'user.message', id: 'older', anchor: '1', seq: 1, turn: 1, time: Date.now(), source: 'user', text: 'OLDER_NORMAL', blocks: [{ type: 'text', text: 'OLDER_NORMAL' }] },
        { type: 'assistant.attempt.start', attemptId: 'older-attempt', turn: 1, step: 1 },
        { type: 'assistant.delta', attemptId: 'older-attempt', index: 0, time: Date.now(), delta: { kind: 'text', text: 'ACTIVE_REPLY' } },
      )
      await wait(`${label}: the preceding turn is visibly running`, () => rig.f.raw.working && appearance('OLDER_NORMAL') !== undefined)
      const normal = appearance('OLDER_NORMAL')!.fg[0]
      rig.stdin.write(text)
      await wait(`${label}: additional draft is editable`, () => rig.controller.current?.text() === text)
      if (placement === 'steer') await rig.enter()
      else rig.stdin.write('\t')
      await wait(`${label}: the queued submission reaches the backend`, () => rig.f.first.submits.length === 1)
      const submission = rig.f.first.submits[0]!
      const id = submission.input.clientMessageId
      submission.receipt.resolve({ accepted: true })
      await wait(`${label}: queue receipt is admitted`, () => outgoing(rig.f).find(item => item.id === id)?.phase === 'queued')
      check(`${label}: queue origin survives the guarded UI snapshot`, outgoing(rig.f).find(item => item.id === id)?.queuePlacement === placement)
      check(`${label}: backend placement is unchanged`, submission.placement === placement)
      await wait(`${label}: the original arrow queue is visible`, () => appearance(text)?.line?.includes('↳') === true)
      // ThemedText's dimColor resolves to theme.inactive RGB, not ANSI dim.
      const queueColor = appearance('↳')!.fg[0]
      check(`${label}: the old muted, non-bold styling is preserved`, appearance(text)!.fg.every(color => color === queueColor) && !appearance(text)!.bold.some(Boolean), appearance(text))
      check(`${label}: there is exactly one preview and no durable user row`, rig.lines().filter(line => line.includes(text)).length === 1 && !rig.f.raw.rows.some(row => row.kind === 'user' && row.text === text))
      rig.f.first.emit({ type: 'assistant.delta', attemptId: 'older-attempt', index: 1, time: Date.now(), delta: { kind: 'text', text: '\nOLDER_MORE' } })
      await wait(`${label}: more output from the preceding request is projected`, () => rig.f.raw.rows.some(row => row.text.includes('OLDER_MORE')))
      // The restored absolute queue can cover that assistant row. A visible
      // new draft fences the next real paint without demanding occluded text.
      rig.controller.current!.append('QUEUE_NEW_DRAFT')
      await wait(`${label}: a new draft fences the next queue paint`, () => rig.lines().some(line => line.includes('QUEUE_NEW_DRAFT')))
      check(`${label}: preceding output leaves the item in the original queue`, appearance(text)?.line?.includes('↳') && appearance(text)!.fg.every(color => color === queueColor) && !appearance(text)!.bold.some(Boolean))
      rig.f.first.emit({ type: 'turn.end', turn: 1, reason: { kind: 'completed' }, time: Date.now() })
      rig.controller.current!.append('_')
      await wait(`${label}: the idle frame and latest draft paint`, () => !rig.f.raw.working && rig.lines().some(line => line.includes('QUEUE_NEW_DRAFT_')))
      check(`${label}: ending the preceding turn keeps its unclaimed queue in place`, appearance(text)?.line?.includes('↳') === true)
      rig.f.first.emit({ type: 'pending.changed', items: [], claimed: [id] })
      rig.controller.current!.append('C')
      await wait(`${label}: the claimed-before-record frame paints`, () => rig.lines().some(line => line.includes('QUEUE_NEW_DRAFT_C')))
      check(`${label}: claiming alone retains the composer preview without inventing pending`, rig.f.raw.pending.length === 0 && appearance(text)?.line?.includes('↳') === true && !rig.f.raw.rows.some(row => row.kind === 'user' && row.text === text))
      check(`${label}: a claimed display-only preview advertises no retraction`, !rig.lines().some(line => line.includes('Alt+↑')))
      rig.f.first.emit(
        { type: 'turn.start', turn: 2, origin: 'user', userMessageId: id, time: Date.now() },
        { type: 'step.start', turn: 2, step: 1 },
        { type: 'user.message', id, anchor: '2', seq: 2, turn: 2, time: Date.now(), source: 'user', text, blocks: [{ type: 'text', text }] },
        { type: 'assistant.attempt.start', attemptId: 'own-attempt', turn: 2, step: 1 },
      )
      await wait(`${label}: only its recorded real bubble is promoted`, () => {
        const row = rig.f.raw.rows.find(row => row.kind === 'user' && row.text === text)
        return row !== undefined && outgoing(rig.f).every(item => item.id !== id)
          && rig.f.channel.userMessageResponses?.some(item => item.rowId === row.id && item.phase === 'waiting') === true
          && appearance(text)?.bold.every(Boolean) === true && appearance(text)?.line?.includes('↳') === false
      })
      check(`${label}: promotion does not duplicate its text`, rig.lines().filter(line => line.includes(text)).length === 1)
      rig.f.first.emit({ type: 'assistant.delta', attemptId: 'own-attempt', index: 0, time: Date.now(), delta: { kind: 'reasoning', text: 'OWN_THOUGHT' } })
      await wait(`${label}: only its own model output restores the normal bubble color`, () => appearance(text)?.fg.every(color => color === normal) === true)
      check(`${label}: queue promotion never overwrites the newer draft`, rig.controller.current?.text() === 'QUEUE_NEW_DRAFT_C')
    } finally { await rig.close() }
  }
}

// The second input can still be behind a slow FIFO predecessor: it needs a
// composer-only preview before it has any actual backend queue/retraction.
{
  const rig = await mount(true, 80)
  try {
    await wait('FIFO queue case mounts', () => rig.controller.current !== null)
    rig.f.first.emit({ type: 'turn.start', turn: 1, origin: 'user', time: Date.now() })
    rig.f.channel.steer('FIFO_HEAD')
    await wait('the first queue input blocks its admission receipt', () => rig.f.first.submits.length === 1)
    rig.stdin.write('FIFO_PREFLIGHT')
    await wait('the later FIFO draft is editable', () => rig.controller.current?.text() === 'FIFO_PREFLIGHT')
    await rig.enter()
    await wait('preflight input remains visible in the old queue style', () => rig.lines().some(line => line.includes('↳ FIFO_PREFLIGHT')))
    const staged = outgoing(rig.f).find(item => item.text === 'FIFO_PREFLIGHT')!
    check('a display-only FIFO item is not a backend pending message', rig.f.first.submits.length === 1 && !rig.f.raw.pending.some(item => item.id === staged.id))
    check('preflight appears once and advertises no fake retraction', rig.lines().filter(line => line.includes('FIFO_PREFLIGHT')).length === 1 && !rig.lines().some(line => line.includes('Alt+↑')))
    rig.f.first.submits[0]!.receipt.resolve({ accepted: true })
    await wait('the later FIFO input is really delivered once', () => rig.f.first.submits.length === 2)
    rig.f.first.submits[1]!.receipt.resolve({ accepted: true })
    await wait('actual backend queue graduation restores the old action hint', () => rig.f.raw.pending.some(item => item.id === staged.id) && rig.lines().some(line => line.includes('Alt+↑')))
    check('real pending replaces its display-only copy without duplication', rig.lines().filter(line => line.includes('FIFO_PREFLIGHT')).length === 1)
    rig.f.first.emit({ type: 'pending.changed', items: [{ id: staged.id, text: staged.text, placement: 'steer' }], claimed: [rig.f.first.submits[0]!.input.clientMessageId] })
    rig.controller.current!.append('FIFO_ORDER_FENCE')
    await wait('the claimed-head queue frame paints', () => rig.lines().some(line => line.includes('FIFO_ORDER_FENCE')))
    const headLine = rig.lines().findIndex(line => line.includes('↳ FIFO_HEAD'))
    const followerLine = rig.lines().findIndex(line => line.includes('↳ FIFO_PREFLIGHT'))
    check('a claimed display-only head keeps its enqueue order before real pending', headLine >= 0 && followerLine > headLine)
  } finally { await rig.close() }
}

// Failed/unknown admissions are not normal queue items and must remain
// recoverable/visible after the composer queue relinquishes their identities.
for (const uncertain of [false, true]) {
  const rig = await mount(true, 80)
  const text = uncertain ? 'UNKNOWN_QUEUE' : 'REFUSED_QUEUE'
  try {
    await wait(`${text}: composer mounts`, () => rig.controller.current !== null)
    rig.f.first.emit({ type: 'turn.start', turn: 1, origin: 'user', time: Date.now() })
    rig.stdin.write(text)
    await wait(`${text}: running draft is editable`, () => rig.controller.current?.text() === text)
    await rig.enter()
    await wait(`${text}: backend receipt is pending`, () => rig.f.first.submits.length === 1)
    rig.controller.current!.append('PROTECTED_QUEUE_DRAFT')
    if (uncertain) rig.f.first.submits[0]!.receipt.reject(new Error('unknown queue acceptance'))
    else rig.f.first.submits[0]!.receipt.resolve({ accepted: false, reason: 'queue refused' })
    await wait(`${text}: failed or uncertain input stays visible outside the normal queue`, () => outgoing(rig.f).some(item => item.phase === (uncertain ? 'uncertain' : 'failed')) && rig.lines().some(line => line.includes(text) && !line.includes('↳')))
    check(`${text}: a newer draft is never overwritten`, rig.controller.current?.text() === 'PROTECTED_QUEUE_DRAFT')
  } finally { await rig.close() }
}

// Failure before the first turn must also survive the launchpad/composer handoff.
{
  const rig = await mount(true, 80, true)
  try {
    await wait('launchpad is mounted', () => rig.lines().some(line => line.includes('❯')))
    rig.stdin.write('\x1b[200~FIRST_MESSAGE\x1b[201~')
    await wait('launchpad draft is visible', () => rig.lines().some(line => line.includes('FIRST_MESSAGE')))
    await rig.enter()
    await wait('launchpad sends exactly once', () => rig.f.first.submits.length === 1)
    rig.f.first.submits[0]!.receipt.resolve({ accepted: false })
    await wait('failed first message moves into the mounted composer', () => rig.controller.current?.text?.() === 'FIRST_MESSAGE')
  } finally { await rig.close() }
}

// A real paste creates the token/capability sidecar, rather than faking a token.
{
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  const imagePath = join(home, 'recovery.png')
  writeFileSync(imagePath, png)
  const rig = await mount(true, 80)
  try {
    await wait('image case composer mounts', () => rig.controller.current !== null)
    rig.stdin.write(`\x1b[200~${imagePath}\x1b[201~`)
    await wait('image paste binds an actual staged capability', () => (rig.controller.current?.previewImages?.().length ?? 0) === 1)
    const original = rig.controller.current!.text()
    await rig.enter()
    await wait('image submission is in flight', () => rig.f.first.submits.length === 1)
    const stageId = outgoing(rig.f)[0]?.images?.[0]?.stageId
    check('outgoing record retains the image capability, not only its label', stageId !== undefined && rig.f.raw.hasStagedImage(stageId))
    rig.f.raw.discardStagedImage(stageId!)
    check('a submitted image stays pinned while its outcome is pending', rig.f.raw.hasStagedImage(stageId!))
    rig.f.first.submits[0]!.receipt.resolve({ accepted: false })
    await wait('image refusal restores both text and image preview', () => rig.controller.current?.text() === original && rig.controller.current?.previewImages?.().length === 1)
    check('recovered image keeps its original stage identity', rig.f.raw.hasStagedImage(stageId!))
    await rig.enter()
    await wait('the recovered image can really be submitted again', () => rig.f.first.submits.length === 2)
    check('retry carries actual image data', rig.f.first.submits[1]?.input.images?.length === 1)
    rig.f.first.submits[1]!.receipt.resolve({ accepted: true })
    rig.f.first.confirm(1)
  } finally { await rig.close() }
}

// A new image drop owns the empty composer even before staging yields a token.
{
  const imagePath = join(home, 'recovery.png')
  const rig = await mount(true, 80)
  const stageGate = deferred<void>()
  let stageEntered = false
  const stageImage = rig.f.raw.stageComposerImage.bind(rig.f.raw)
  rig.f.raw.stageComposerImage = async (...args) => {
    stageEntered = true
    await stageGate.promise
    return stageImage(...args)
  }
  try {
    await wait('deferred image case composer mounts', () => rig.controller.current !== null)
    rig.stdin.write('FAILED_BEFORE_IMAGE')
    await wait('deferred image original draft is present', () => rig.controller.current?.text() === 'FAILED_BEFORE_IMAGE')
    await rig.enter()
    await wait('original message waits for its receipt', () => rig.f.first.submits.length === 1)
    rig.stdin.write(`\x1b[200~${imagePath}\x1b[201~`)
    await wait('new image staging starts on the empty draft', () => stageEntered)
    rig.f.first.submits[0]!.receipt.resolve({ accepted: false })
    await wait('the old failed message remains available during new input work', () => outgoing(rig.f).some(item => item.phase === 'failed'))
    check('failure recovery does not replace an in-flight empty image draft', rig.controller.current?.text() === '')
    stageGate.resolve()
    await wait('the new image is not dropped by an invalidated draft lease', () => rig.controller.current?.previewImages?.().length === 1)
    check('the new image draft takes priority over the older failed text', rig.controller.current?.text().includes('[Image #1]') && outgoing(rig.f).some(item => item.phase === 'failed'))
    const id = firstId(rig.f)
    rig.controller.current?.recoverFailedOutgoing?.(id)
    check('manual recovery also refuses to overwrite the newly staged image', rig.controller.current?.previewImages?.().length === 1 && outgoing(rig.f).some(item => item.id === id))
    rig.controller.current!.clear()
    await wait('old failed input becomes recoverable after the new image draft is cleared', () => rig.controller.current?.text() === 'FAILED_BEFORE_IMAGE')
  } finally { stageGate.resolve(); await rig.close() }
}

// Animation changes only cell colors and suspends on real terminal focus loss.
{
  const rig = await mount(true, 60)
  const text = 'SHIMMER_GEOMETRY_SENTINEL'
  const appearance = () => {
    const at = findText(rig.term, text)
    if (at === null) return null
    const line = rig.term.buffer.active.getLine(rig.term.buffer.active.baseY + at.row)
    return { row: at.row, col: at.col, text: line?.translateToString(true),
      fg: Array.from({ length: text.length }, (_, index) => line?.getCell(at.col + index)?.getFgColor()) }
  }
  try {
    await wait('shimmer case composer mounts', () => rig.controller.current !== null)
    rig.stdin.write(`\x1b[200~${text}\x1b[201~\r`)
    await wait('shimmer preview is visible', () => appearance() !== null)
    const before = appearance()!
    await wait('pending preview visibly sweeps its color', () => {
      const now = appearance()
      return now !== null && JSON.stringify(now.fg) !== JSON.stringify(before.fg)
    })
    const changed = appearance()!
    check('shimmer never moves or edits the pending text', before.row === changed.row && before.col === changed.col && before.text === changed.text)
    rig.stdin.write('\x1b[O')
    // 固定窗:墙钟 terminal-focus transition and the animation cadence are under test.
    await sleep(200)
    const blurred = appearance()!
    // 固定窗:探针 a focused clock must not keep painting a blurred pending preview.
    await sleep(300)
    check('shimmer is color-stable while the terminal is unfocused', JSON.stringify(appearance()) === JSON.stringify(blurred))
    rig.stdin.write('\x1b[I')
    await wait('shimmer resumes on terminal focus', () => JSON.stringify(appearance()?.fg) !== JSON.stringify(blurred.fg))
  } finally { await rig.close() }
}

}

console.log(`\nverify-outgoing-send OK (${checks} checks)`)
