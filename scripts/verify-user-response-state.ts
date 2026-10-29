/**
 * Response presentation is causal, not a second delivery receipt. Exercises
 * DSH step-before-user, Claude late echoes/steering, positioned Codex output,
 * children, replay, terminal states and atomic full-channel notification wakes.
 * Wrong-turn tokens, stream headers, usage and empty deltas must not clear grey.
 * Run: node --import tsx/esm scripts/verify-user-response-state.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, AgentEventMeta } from '../src/agent/events.js'
import type { AgentSession } from '../src/agent/session.js'
import type { ChatRow, UserMessageResponseState } from '../src/adapter/ports/channel-view.js'

const home = mkdtempSync(join(tmpdir(), 'dsh-response-state-'))
process.env.HOME = process.env.USERPROFILE = home
process.env.DSH_HOME = join(home, 'dsh')
process.env.DSH_TUI_LANG = 'en'
const [{ createUserMessageResponses }, { createChannel }, { settled }] = await Promise.all([
  import('../src/dsh-adapter/channel/core/user-message-responses.js'),
  import('../src/dsh-adapter/channel.js'), import('./lib/term-test.mjs'),
])
let checks = 0
function check(label: string, condition: unknown): void {
  assert.ok(condition, label)
  checks += 1
  console.log(`PASS ${label}`)
}
const live: AgentEventMeta = { replay: false, wake: 'sync' }
const turn = (number: number, id?: string): AgentEvent => ({ type: 'turn.start', turn: number, origin: 'user', time: 0, ...(id === undefined ? {} : { userMessageId: id }) })
const step = (number: number, index = 1): AgentEvent => ({ type: 'step.start', turn: number, step: index })
const user = (id: string, seq: number, number?: number, anchor = String(seq)): AgentEvent => ({ type: 'user.message', id, seq, anchor, time: 0, source: 'user', text: 'SAME_TEXT', blocks: [{ type: 'text', text: 'SAME_TEXT' }], ...(number === undefined ? {} : { turn: number }) })
const attempt = (id: string, number = 1, index = 1, child?: string): AgentEvent => ({ type: 'assistant.attempt.start', attemptId: id, turn: number, step: index, ...(child === undefined ? {} : { parentCallId: child }) })
const delta = (id: string, content: Extract<AgentEvent, { type: 'assistant.delta' }>['delta'] = { kind: 'text', text: 'first' }, child?: string): AgentEvent => ({ type: 'assistant.delta', attemptId: id, index: 0, time: 0, delta: content, ...(child === undefined ? {} : { parentCallId: child }) })
function fixture() {
  const state: { rows: ChatRow[]; userMessageResponses: readonly UserMessageResponseState[] } = { rows: [], userMessageResponses: [] }
  const reducer = createUserMessageResponses(state)
  const ids = new Map<string, number>()
  let rowId = 100
  const apply = (events: AgentEvent[], meta = live) => {
    for (const event of events) {
      if (event.type !== 'user.message' || event.source !== 'user' || ids.has(event.id)) continue
      const id = rowId++
      ids.set(event.id, id)
      state.rows.push({ id, kind: 'user', text: event.text, seq: event.seq,
        ...(event.anchor === String(event.seq) ? {} : { anchor: event.anchor }) })
    }
    return reducer.apply(events, meta)
  }
  const phase = (id: string) => state.userMessageResponses.find(item => item.rowId === ids.get(id))?.phase
  return { state, reducer, apply, phase, ids }
}

// DSH records the user inside an explicit step, before the actual attempt.
{
  const f = fixture()
  f.apply([turn(1, 'a'), step(1), user('a', 1), attempt('a1')])
  check('DSH local persistence keeps its real user row waiting', f.phase('a') === 'waiting')
  for (const event of [
    delta('a1', { kind: 'other' }), delta('a1', { kind: 'text', text: '' }),
    delta('a1', { kind: 'reasoning', text: '' }), delta('a1', { kind: 'reasoning-tokens', estimated: 0 }),
    { type: 'usage', seq: 2, turn: 1, step: 1, usage: { input: 100, output: 1 }, time: 0 } as AgentEvent,
    { type: 'assistant.message', seq: 3, anchor: '3', turn: 1, step: 1, attemptId: 'a1', time: 0, canonical: true, blocks: [{ type: 'reasoning', text: '' }, { type: 'unknown-opaque' }] } as AgentEvent,
  ]) {
    f.apply([event])
    check(`${event.type} without first content is not a response`, f.phase('a') === 'waiting')
  }
  f.apply([delta('a1', { kind: 'reasoning-tokens', estimated: 1 })])
  check('positive backend reasoning output ends the grey state', f.phase('a') === undefined)
  check('response acknowledgement never removes the real row', f.state.rows.length === 1)
}
for (const [label, output] of [
  ['text', delta('a1')],
  ['reasoning', delta('a1', { kind: 'reasoning', text: 'thinking' })],
  ['tool arguments', delta('a1', { kind: 'tool-args', callId: 'call', partialJson: '', name: 'read' })],
  ['durable assistant content', { type: 'assistant.message', seq: 8, anchor: '8', turn: 1, step: 1, attemptId: 'a1', time: 0, canonical: true, blocks: [{ type: 'text', text: 'reply' }] }],
  ['main tool call', { type: 'tool.call', seq: 8, turn: 1, step: 1, callId: 'call', name: 'read', argsJson: '{}', time: 0 }],
  ['settled tool declaration before approval', { type: 'assistant.message', seq: 8, anchor: '8', turn: 1, step: 1, attemptId: 'a1', time: 0, canonical: true, blocks: [{ type: 'tool-call' }] }],
  ['generated image', { type: 'assistant.message', seq: 8, anchor: '8', turn: 1, step: 1, attemptId: 'a1', time: 0, canonical: true, blocks: [], images: [{ id: 'generated', width: 1, height: 1, read: async () => { throw new Error('presentation must not load image bytes') } }] }],
] as [string, AgentEvent][]) {
  const f = fixture()
  f.apply([turn(1, 'a'), step(1), user('a', 1, 1), attempt('a1')])
  f.apply([output])
  check(`first ${label} acknowledges its user`, f.phase('a') === undefined)
}
// An equal-text input arriving during A's active step belongs to a later call.
{
  const f = fixture()
  f.apply([turn(1, 'a'), step(1), user('a', 1, 1), attempt('a1')])
  f.apply([user('b', 2, 1)])
  f.apply([delta('a1')])
  check('A output acknowledges A only, not a later equal-text B', f.phase('a') === undefined && f.phase('b') === 'waiting')
  f.apply([attempt('child', 1, 2, 'parent'), delta('child', { kind: 'text', text: 'child output' }, 'parent')])
  check('child activity cannot acknowledge the main user', f.phase('b') === 'waiting')
  f.apply([step(1, 2), attempt('b2', 1, 2), delta('b2')])
  check('B acknowledges only at its new main model step', f.phase('b') === undefined)
  check('equal text still has two different real row identities', f.ids.get('a') !== f.ids.get('b') && f.state.rows.length === 2)
}
// Claude may claim B before its model step but replay its human echo later.
for (const outputBeforeEcho of [false, true]) {
  const f = fixture()
  f.apply([turn(1, 'a'), step(1), user('a', 1, 1), attempt('a1'), delta('a1')])
  f.apply([{ type: 'pending.changed', items: [], claimed: ['b'] }])
  f.apply([step(1, 2), attempt('b2', 1, 2)])
  if (outputBeforeEcho) f.apply([delta('b2')])
  f.apply([user('b', 2, 1, 'late-b-echo')])
  if (!outputBeforeEcho) {
    check('a claimed late echo still waits until its first model content', f.phase('b') === 'waiting')
    f.apply([delta('a1')])
    check('an older attempt cannot acknowledge the claimed late echo', f.phase('b') === 'waiting')
    f.apply([delta('b2')])
  }
  check(`claim-before-step preserves acknowledgement with outputBeforeEcho=${outputBeforeEcho}`, f.phase('b') === undefined)
}
{
  const f = fixture()
  f.apply([turn(1, 'a'), step(1), user('a', 1), user('b', 2), attempt('a1'), delta('a1')])
  check('inputs consumed together before one attempt acknowledge together', f.phase('a') === undefined && f.phase('b') === undefined)
}
{
  const f = fixture()
  f.apply([turn(1, 'a'), step(1), attempt('a1'), delta('a1')])
  f.apply([user('a', 1, 1, 'claude-user-uuid')])
  check('a model response arriving before its linked user echo does not re-grey the echo', f.phase('a') === undefined)
}
{
  const f = fixture()
  f.apply([turn(1, 'a'), step(1), user('a', 1), attempt('a1')])
  f.apply([{ type: 'turn.end', turn: 1, reason: { kind: 'error', message: 'before output' }, time: 0 }])
  check('an unanswered failure stays grey but stops animating', f.phase('a') === 'stopped')
  f.apply([turn(2, 'b'), step(2), user('b', 2, 2), attempt('b1', 2)])
  f.apply([delta('a1')])
  check('late old-turn output cannot acknowledge a newer turn', f.phase('a') === 'stopped' && f.phase('b') === 'waiting')
  f.apply([delta('b1')])
  check('only the current main output acknowledges B', f.phase('b') === undefined)
  f.reducer.reset()
  check('reset forgets every previous presentation state', f.state.userMessageResponses.length === 0)
}
for (const status of ['idle', 'disposed'] as const) {
  const f = fixture()
  f.apply([turn(1, 'a'), step(1), user('a', 1), attempt('a1')])
  f.apply([{ type: 'session.status', status }], { replay: false, wake: 'none' })
  check(`${status} without a terminal event stops waiting`, f.phase('a') === 'stopped')
}
{
  const f = fixture()
  f.apply([turn(1, 'a'), step(1), user('a', 1), attempt('a1')], { replay: true, wake: 'sync' })
  check('replayed history never creates a waiting presentation', f.state.userMessageResponses.length === 0)
  f.apply([turn(2, 'b'), step(2), user('b', 2, 2)])
  f.apply([delta('orphan')])
  check('an unpositioned orphan does not guess the open step', f.phase('b') === 'waiting')
  f.apply([attempt('orphan', 2)])
  check('a later matching attempt start can position an earlier observed delta', f.phase('b') === undefined)
}

// Once the first content is acknowledged, later tokens must not rescan a
// long transcript just to rediscover that its user already has a response.
{
  let reads = 0
  const rows: ChatRow[] = Array.from({ length: 4000 }, (_, id) => ({ id, kind: 'assistant', text: `history-${id}` }))
  rows.push({ id: 4000, kind: 'user', text: 'SAME_TEXT', seq: 999 })
  const state = { get rows() { reads += 1; return rows }, userMessageResponses: [] as readonly UserMessageResponseState[] }
  const reducer = createUserMessageResponses(state)
  reducer.apply([turn(1, 'a'), step(1), user('a', 999), attempt('a1'), delta('a1')], live)
  const settledReads = reads
  for (let index = 0; index < 1000; index += 1) reducer.apply([delta('a1')], live)
  check('later model tokens do not reread 4000 transcript rows', reads === settledReads && state.userMessageResponses.length === 0)
}

// A provider may normalize submitted shell markup as command-output. Its
// exact client ID still proves persistence, without creating a human bubble.
{
  const listeners = new Set<Parameters<AgentSession['subscribe']>[0]>()
  let submitted: Parameters<AgentSession['submit']>[0] | undefined
  let resolveReceipt!: (value: Awaited<ReturnType<AgentSession['submit']>>) => void
  const receipt = new Promise<Awaited<ReturnType<AgentSession['submit']>>>(resolve => { resolveReceipt = resolve })
  const session: AgentSession = {
    ref: { backendId: 'fake', sessionId: 'normalized-receipt' }, cwd: home, status: 'idle', capabilities: { native: {} },
    history: async () => [], subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    submit(input) { submitted = input; return receipt },
    cancel: async () => ({ stillQueued: [], outcome: 'confirmed' }), dispose: async () => {},
  }
  const ctx = { on: () => () => {}, get: () => undefined, logger: { warn() {}, info() {}, debug() {} } }
  const channel = createChannel(ctx as never, session, { provider: '', model: 'fixture', cwd: home, activity: false })
  try {
    channel.submit('<bash-stdout>\nhello\n</bash-stdout>')
    check('normalized input reaches the backend', await settled(() => submitted !== undefined))
    const event: AgentEvent = { type: 'user.message', id: submitted!.clientMessageId, seq: 1, anchor: '1', time: 0,
      source: 'command-output', text: 'hello', blocks: [{ type: 'text', text: 'hello' }] }
    for (const listener of listeners) listener([event], live)
    check('a nonhuman durable receipt still retires the exact outgoing ID', channel.outgoing.length === 0 && channel.pending.length === 0)
    check('command output never gains a human waiting presentation', channel.userMessageResponses.length === 0)
    resolveReceipt({ accepted: false, reason: 'late provider refusal' })
    await new Promise<void>(resolve => setImmediate(resolve))
    check('a late refusal cannot revive an already-recorded normalized input', channel.outgoing.length === 0 && !channel.notifications.some(note => note.text === 'late provider refusal'))
  } finally { channel.releaseContributions() }
}

// A projector notice can synchronously wake its subscribers inside apply().
// The full channel must still expose row+presentation atomically to every wake.
{
  const listeners = new Set<Parameters<AgentSession['subscribe']>[0]>()
  const session: AgentSession = {
    ref: { backendId: 'fake', sessionId: 'atomic-response' }, cwd: home, status: 'idle', capabilities: { native: {} },
    history: async () => [], subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    async submit(input) {
      const batch: AgentEvent[] = [turn(1, input.clientMessageId), step(1),
        { ...user(input.clientMessageId, 1, 1), text: input.text, blocks: [{ type: 'text', text: input.text }] },
        { type: 'turn.end', turn: 1, reason: { kind: 'error', message: 'same-batch failure' }, time: 0 }]
      for (const listener of listeners) listener(batch, live)
      return { accepted: true }
    },
    cancel: async () => ({ stillQueued: [], outcome: 'confirmed' }), dispose: async () => {},
  }
  const ctx = { on: () => () => {}, get: () => undefined, logger: { warn() {}, info() {}, debug() {} } }
  const channel = createChannel(ctx as never, session, { provider: '', model: 'fixture', cwd: home, activity: false,
    openSession: async () => ({ ...session, ref: { backendId: 'fake', sessionId: 'replacement-response' } }) })
  let badWake = false
  const off = channel.subscribe(() => {
    for (const row of channel.rows) {
      if (row.kind === 'user' && !channel.userMessageResponses.some(item => item.rowId === row.id)) badWake = true
    }
  })
  try {
    channel.submit('ATOMIC_USER')
    check('same-batch user and error are projected', await settled(() => channel.rows.some(row => row.kind === 'user') && channel.userMessageResponses.some(item => item.phase === 'stopped')))
    check('no notification wake flashes a normal bubble before the sidecar', !badWake)
    check('an already-recorded error cannot resurrect the delivery receipt', channel.outgoing.length === 0 && channel.pending.length === 0)
    const oldListeners = [...listeners]
    await new Promise<void>(resolve => setImmediate(resolve))
    check('the response-bearing session can be replaced', await channel.newSession())
    check('a new binding has no old response presentation', channel.userMessageResponses.length === 0 && channel.rows.length === 0)
    for (const listener of oldListeners) listener([turn(2, 'old'), step(2), user('old', 8, 2), attempt('old', 2), delta('old')], live)
    check('retained old callbacks cannot re-grey the replacement conversation', channel.userMessageResponses.length === 0 && channel.rows.length === 0)
  } finally { off(); channel.releaseContributions() }
}
console.log(`verify-user-response-state OK (${checks} checks)`)
