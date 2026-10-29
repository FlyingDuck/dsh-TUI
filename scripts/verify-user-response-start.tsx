/**
 * A locally recorded user input must stay grey until real model content arrives.
 * Uses the real DSH registry/loop/session, a gated LlmAdapter, channel UI facade
 * and Chat. No remote model, credentials or network; persistence and stream
 * headers happen before the independently released first content chunk.
 * Fails if persistence turns a bubble normal, headers count as content, the
 * response must finish before acknowledgement, or an error restores sent input.
 * Run: node --import tsx/esm scripts/verify-user-response-start.tsx
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import type { PromptController } from '../src/components/PromptInput.js'

const home = mkdtempSync(join(tmpdir(), 'dsh-response-start-'))
process.env.HOME = process.env.USERPROFILE = home
process.env.DSH_HOME = join(home, 'dsh')
process.env.DSH_TUI_LANG = 'en'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_DISABLE_TERMINAL_IMAGES = '1'
process.env.FORCE_COLOR = '3'
delete process.env.NO_COLOR

const [React, xterm, ui, { Context }, { default: AgentRegistry },
  { default: AgentLoop }, { default: LlmRuntime, LlmAdapter, createUserMessage },
  { default: SessionStore, SessionId }, { default: SessionProjectionRegistry },
  { default: SystemPrompt }, { default: ToolRuntime }, { createChannel },
  { mountChannelUi }, { registerTuiChannel }, { Chat }, { QuestionStore },
  { settled, findText, viewportLines, sleep },
] = await Promise.all([
  import('react'), import('@xterm/headless'), import('../src/ui.js'), import('@deepseek-ai/cordis'),
  import('@deepseek-ai/dsh-agent'), import('@deepseek-ai/dsh-agent-loop'),
  import('@deepseek-ai/dsh-llm'), import('@deepseek-ai/dsh-session'),
  import('@deepseek-ai/dsh-session-projection'), import('@deepseek-ai/dsh-system-prompt'),
  import('@deepseek-ai/dsh-tools'), import('../src/dsh-adapter/channel.js'),
  import('../src/dsh-adapter/channel-ui.js'), import('../src/adapter/channel/host-registry.js'),
  import('../src/screens/Chat.js'), import('../src/channel/questions.js'), import('./lib/term-test.mjs'),
])
const XTerm = xterm.Terminal ?? xterm.default.Terminal
const provider = 'response-fixture'
let checks = 0
let serial = 0
const check = (label: string, value: unknown): void => {
  assert.ok(value, label)
  checks += 1
  console.log(`PASS ${label}`)
}
const wait = async (label: string, ready: () => boolean): Promise<void> => {
  check(label, await settled(ready, { timeoutMs: 8000 }))
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}

class GatedAdapter extends LlmAdapter {
  readonly headers = deferred()
  readonly content = deferred()
  readonly finish = deferred()
  requests = 0
  headersConsumed = false
  historyStarted = false
  constructor(readonly mode: 'text' | 'reasoning' | 'error') { super() }
  async resolveModel(selectedProvider: string, model: string) {
    assert.equal(selectedProvider, provider)
    return { provider: selectedProvider, id: model, name: model }
  }
  async *stream() {
    if (!this.historyStarted) {
      this.historyStarted = true
      yield { type: 'block-start' as const, index: 0, blockType: 'text' as const }
      yield { type: 'text-delta' as const, index: 0, text: 'HISTORICAL_REPLY' }
      yield { type: 'block-end' as const, index: 0, block: { type: 'text' as const, text: 'HISTORICAL_REPLY' } }
      yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
      return
    }
    this.requests += 1
    await this.headers.promise
    const reasoning = this.mode === 'reasoning'
    yield { type: 'block-start' as const, index: 0, blockType: reasoning ? 'reasoning' as const : 'text' as const }
    this.headersConsumed = true
    await this.content.promise
    if (this.mode === 'error') throw new Error('fixture failed before model content')
    const text = reasoning ? 'FIRST_MODEL_THOUGHT' : 'FIRST_MODEL_TEXT'
    if (reasoning) yield { type: 'reasoning-delta' as const, index: 0, text }
    else yield { type: 'text-delta' as const, index: 0, text }
    await this.finish.promise
    yield { type: 'block-end' as const, index: 0, block: { type: reasoning ? 'reasoning' as const : 'text' as const, text } }
    yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
  }
  release() { this.headers.resolve(); this.content.resolve(); this.finish.resolve() }
}
class Input extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}

async function mount(fullscreen: boolean, columns: number, mode: 'text' | 'reasoning' | 'error') {
  const ctx = new Context()
  for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, AgentRegistry]) {
    await ctx.plugin(plugin)
  }
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new GatedAdapter(mode)
  ctx.llm.registerAdapter([provider], adapter)
  const handle = await ctx.agents.create({
    sessionId: SessionId(`response-${++serial}`), meta: { cwd: home },
    agentOptions: { provider, model: 'gated' },
  })
  handle.agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'HISTORICAL_NORMAL' }], source: { kind: 'user' },
  }))
  assert.ok(await settled(() => handle.agent.status === 'idle'
    && handle.agent.session.snapshotEvents().some(event => event.type === 'turn/end')),
  'the real DSH warmup creates replayable history through the canonical surface')
  const raw = createChannel(ctx, handle.agent, { handle, provider, model: 'gated', cwd: home,
    whale: false, whaleIdle: false, activity: false, launchpad: false })
  const unregister = registerTuiChannel(ctx, raw)
  const mounted = mountChannelUi(ctx, raw, undefined, 'new')
  const channel = mounted.channel
  const term = new XTerm({ cols: columns, rows: 34, scrollback: 300, allowProposedApi: true })
  const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) { term.write(String(chunk), done) } }),
    { columns, rows: 34, isTTY: true })
  const stderr = Object.assign(new Writable({ write(_chunk, _encoding, done) { done() } }), { isTTY: true })
  const stdin = new Input()
  const controller = { current: null as PromptController | null }
  const app = await ui.render(React.createElement(Chat, { channel, fullscreen, trajectorySeen: true,
    questionStore: new QuestionStore(), promptControllerRef: controller, launchpadOnBoot: false }),
  { stdout: stdout as never, stderr: stderr as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false })
  let lastEnterAt = 0
  const appearance = (text: string) => {
    const at = findText(term, text)
    if (at === null) return undefined
    const line = term.buffer.active.getLine(term.buffer.active.baseY + at.row)
    return { row: at.row, col: at.col,
      fg: Array.from({ length: text.length }, (_, index) => line?.getCell(at.col + index)?.getFgColor()) }
  }
  const phase = (rowId: number) => channel.userMessageResponses?.find(item => item.rowId === rowId)?.phase
  return { raw, channel, adapter, handle, term, stdin, controller, appearance, phase,
    lines: () => viewportLines(term),
    enter: async () => {
      const remaining = 90 - (Date.now() - lastEnterAt)
      // 固定窗:墙钟 the composer's 80ms CR/LF debounce must not eat a second submit.
      if (remaining > 0) await sleep(remaining)
      stdin.write('\r')
      lastEnterAt = Date.now()
    },
    close: async () => {
      adapter.release()
      raw.cancel()
      app.unmount()
      await new Promise<void>(resolve => stdout.write('', () => resolve()))
      mounted.dispose()
      unregister()
      raw.releaseContributions()
      await handle.dispose()
      await ctx.fiber.dispose()
      term.dispose()
    },
  }
}

async function verify(fullscreen: boolean, columns: number, mode: 'text' | 'reasoning' | 'error') {
  const label = `${fullscreen ? 'fullscreen' : 'inline'} ${columns} ${mode}`
  const rig = await mount(fullscreen, columns, mode)
  const sent = 'RECORDED_WAITING'
  try {
    await wait(`${label}: history and composer mount`, () => rig.appearance('HISTORICAL_NORMAL') !== undefined && rig.controller.current !== null)
    check(`${label}: replayed user rows have no waiting presentation`, (rig.channel.userMessageResponses ?? []).length === 0)
    const normal = rig.appearance('HISTORICAL_NORMAL')!.fg[0]
    rig.stdin.write(sent)
    await wait(`${label}: draft is editable`, () => rig.controller.current?.text() === sent)
    await rig.enter()
    await wait(`${label}: real DSH records the user before model output`, () => rig.raw.rows.some(row => row.kind === 'user' && row.text === sent) && rig.adapter.requests > 0)
    const row = rig.raw.rows.find(row => row.kind === 'user' && row.text === sent)!
    check(`${label}: the session log already contains the submitted user`, rig.handle.agent.session.snapshotEvents().some(event => event.type === 'user/message' && (event.data as { content?: { text?: string }[] }).content?.some(block => block.text === sent)))
    check(`${label}: persistence retires only the delivery receipt`, rig.channel.outgoing?.length === 0)
    await wait(`${label}: the real recorded bubble remains grey while the model is gated`, () => rig.phase(row.id) === 'waiting' && rig.appearance(sent)?.fg.some(color => color !== normal) === true)
    check(`${label}: only one real bubble exists`, rig.raw.rows.filter(item => item.kind === 'user' && item.text === sent).length === 1)
    check(`${label}: the submitted composer is empty`, rig.controller.current?.text() === '')
    const before = rig.appearance(sent)!.fg
    await wait(`${label}: the recorded bubble actually shimmers`, () => JSON.stringify(rig.appearance(sent)?.fg) !== JSON.stringify(before))
    rig.adapter.headers.resolve()
    await wait(`${label}: the real adapter delivered stream headers`, () => rig.adapter.headersConsumed)
    check(`${label}: headers alone do not acknowledge model content`, rig.phase(row.id) === 'waiting')
    rig.controller.current!.append('NEW_UNSENT_DRAFT')
    await wait(`${label}: a newer draft stays in the composer`, () => rig.controller.current?.text() === 'NEW_UNSENT_DRAFT')
    rig.adapter.content.resolve()
    if (mode === 'error') {
      await wait(`${label}: an unanswered error stops the animation`, () => rig.phase(row.id) === 'stopped' && !rig.raw.working)
      check(`${label}: the already-recorded input is not made recoverable`, rig.channel.outgoing?.every(item => item.phase !== 'failed'))
      check(`${label}: failure never overwrites the newer draft`, rig.controller.current?.text() === 'NEW_UNSENT_DRAFT')
    } else {
      await wait(`${label}: first real model content restores the normal bubble color`, () => rig.phase(row.id) === undefined && rig.appearance(sent)?.fg.every(color => color === normal) === true)
      check(`${label}: acknowledgement does not wait for the turn to finish`, rig.raw.working)
      check(`${label}: first output does not clear a newer draft`, rig.controller.current?.text() === 'NEW_UNSENT_DRAFT')
      rig.adapter.finish.resolve()
      await wait(`${label}: the gated model turn completes`, () => !rig.raw.working)
    }
    check(`${label}: the recorded user was never withdrawn or duplicated`, rig.raw.rows.filter(item => item.kind === 'user' && item.text === sent).length === 1)
    check(`${label}: no textual sending or queued label is introduced`, !rig.lines().some(line => /Sending|Queued|Awaiting response/u.test(line)))
  } finally { await rig.close() }
}

for (const fullscreen of [false, true]) for (const columns of [40, 100]) await verify(fullscreen, columns, 'text')
await verify(true, 80, 'reasoning')
await verify(true, 80, 'error')

// Real DSH inbox + gated model: an already-recorded primary prompt may
// shimmer while a later unclaimed steer keeps its original composer queue.
{
  const rig = await mount(true, 80, 'text')
  try {
    await wait('real DSH queue: composer mounts', () => rig.controller.current !== null)
    rig.stdin.write('PRIMARY_REQUEST')
    await wait('real DSH queue: primary draft is editable', () => rig.controller.current?.text() === 'PRIMARY_REQUEST')
    await rig.enter()
    await wait('real DSH queue: the primary model request is gated', () => rig.adapter.requests === 1 && rig.raw.rows.some(row => row.text === 'PRIMARY_REQUEST'))
    const primary = rig.raw.rows.find(row => row.kind === 'user' && row.text === 'PRIMARY_REQUEST')!
    rig.stdin.write('NATIVE_QUEUED_STEER')
    await wait('real DSH queue: the later draft is editable', () => rig.controller.current?.text() === 'NATIVE_QUEUED_STEER')
    await rig.enter()
    await wait('real DSH queue: the native inbox owns the queued steer', () => rig.raw.pending.some(item => item.text === 'NATIVE_QUEUED_STEER' && item.placement === 'steer'))
    const queued = rig.raw.pending.find(item => item.text === 'NATIVE_QUEUED_STEER')!
    await wait('real DSH queue: the old arrow preview is visible', () => rig.lines().some(line => line.includes('↳ NATIVE_QUEUED_STEER')))
    check('real DSH queue: recorded primary and unclaimed queue have separate presentation', rig.phase(primary.id) === 'waiting' && rig.channel.outgoing?.find(item => item.id === queued.id)?.queuePlacement === 'steer')
    check('real DSH queue: the unclaimed steer has no fake transcript row or duplicate text', !rig.raw.rows.some(row => row.kind === 'user' && row.text === queued.text) && rig.lines().filter(line => line.includes(queued.text)).length === 1)
    rig.adapter.headers.resolve()
    rig.adapter.content.resolve()
    await wait('real DSH queue: primary output acknowledges only the primary prompt', () => rig.phase(primary.id) === undefined && rig.raw.rows.some(row => row.text.includes('FIRST_MODEL_TEXT')))
    check('real DSH queue: primary output does not retire the later queue', rig.raw.pending.some(item => item.id === queued.id) && rig.channel.outgoing?.some(item => item.id === queued.id))
    check('real DSH queue: native retraction still works', rig.channel.removePending(queued.id))
    await wait('real DSH queue: retraction consumes both queue and volatile receipt', () => !rig.raw.pending.some(item => item.id === queued.id) && rig.channel.outgoing?.every(item => item.id !== queued.id) === true)
    rig.adapter.finish.resolve()
    await wait('real DSH queue: the primary turn settles', () => !rig.raw.working)
    check('real DSH queue: the withdrawn steer never starts a second model request', rig.adapter.requests === 1 && !rig.raw.rows.some(row => row.kind === 'user' && row.text === queued.text))
  } finally { await rig.close() }
}
console.log(`verify-user-response-start OK (${checks} checks)`)
