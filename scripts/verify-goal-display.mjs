/**
 * How the goal text is displayed now that the full-text overlay is gone:
 *
 *  - truncated goal text: hovering shows the whole objective, a fitting goal
 *    stays tooltip-silent, leaving clears it;
 *  - clicking the goal text opens nothing — the keyboard stays on the
 *    composer (the removed panel used to own it);
 *  - bare `/goal` over a DSH-style registry row prints a transcript BLOCK
 *    (the `/plugins` shape: a `! /goal` echo row plus one row per line) that
 *    carries the WHOLE objective. Inline mode sees no pointer events, so the
 *    block is the only way to read a long objective there; the single-row
 *    toast it replaced flattened and truncated the status text. Subcommands
 *    (`/goal pause`) keep the toast.
 *
 * Run: node --import tsx/esm scripts/verify-goal-display.mjs
 */
process.env.DSH_TUI_LANG = 'en'
process.env.FORCE_COLOR = '3'
const [React, { Writable, PassThrough }, { Terminal }, { render, AlternateScreen }, { Chat },
  { settled, settle, sleep, findText }, { QuestionStore }, { getTooltipSnapshot, clearTooltip }] = await Promise.all([
  import('react'), import('node:stream'), import('@xterm/headless'), import('../src/ui.js'),
  import('../src/screens/Chat.js'), import('./lib/term-test.mjs'), import('../src/dsh-adapter/questions.js'),
  import('../src/components/Tooltip.js'),
])
let failed = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${ok || detail === '' ? '' : `\n  ${detail}`}`)
  if (!ok) failed++
}
function makeTerm(columns = 90, rows = 24) {
  const term = new Terminal({ cols: columns, rows, scrollback: 1000, allowProposedApi: true })
  const stdout = new Writable({ write(chunk, _enc, cb) { term.write(String(chunk), cb) } })
  Object.assign(stdout, { columns, rows, isTTY: true })
  const stderr = new Writable({ write(_chunk, _enc, cb) { cb() } })
  stderr.isTTY = true
  const stdin = new PassThrough()
  Object.assign(stdin, { isTTY: true, setRawMode() { return this }, ref() { return this }, unref() { return this } })
  const screen = () => Array.from(
    { length: rows },
    (_, y) => term.buffer.active.getLine(term.buffer.active.baseY + y)?.translateToString(true) ?? '',
  ).join('\n')
  return { term, stdout, stderr, stdin, screen }
}
/** The whole terminal, scrollback included — `screen()` sees the viewport only. */
function bufferText(term) {
  const buffer = term.buffer.active
  return Array.from({ length: buffer.baseY + term.rows }, (_, y) => buffer.getLine(y)?.translateToString(true) ?? '').join('\n')
}
// Long enough to blow the toast's 200-cell single-line budget (and the
// 240-cell local-output one), short enough to stay under the transcript's
// 1000-char long-line fold — a single line past THAT is clipped by the
// shared fold (with its marker and Ctrl+O), not by the goal path.
const objective = 'GOAL_HEAD ' + 'Validate recovered evidence, partial downloads and paired depth evaluations. '.repeat(10) + 'GOAL_TAIL'
/** `dsh-command-goal`'s status text, verbatim shape: seven lines, one long. */
const DSH_STATUS = [
  'Goal',
  'Status: active',
  `Objective: ${objective}`,
  'Rounds: 0/40',
  'Activation: armed',
  '',
  'Commands: /goal edit <objective>, /goal pause, /goal clear',
].join('\n')

function makeChannel({ externalGoal = false, goal = undefined } = {}) {
  const listeners = new Set()
  const channel = {
    version: 0,
    rows: [{ id: 0, kind: 'user', text: 'Keep working' }, { id: 1, kind: 'assistant', text: 'Ready.' }],
    agentId: 'goal-session', sessionTitle: 'probe', status: 'idle', model: 'm', provider: 'deepseek',
    cwd: '/tmp', displayCwd: '/tmp', working: false, spinnerMode: 'requesting', responseChars: 0,
    activeToolCount: 0, turnStart: 0, lastUserText: '', pending: [], notifications: [], localBlocks: [],
    tokens: { input: 0, output: 0 }, tpsSamples: [], contextBarEnabled: false, activityEnabled: false,
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    mode: { id: 'default', plan: false, sandbox: 'workspace-write', approval: 'ask' }, modeIndex: 0,
    goal, todos: [],
    // A DSH composition: the registry row owns /goal, so the command is
    // offered and the host command answers with its own multi-line text.
    commandList: externalGoal
      ? [{ name: 'goal', description: 'Set or view the goal for a long-running task', external: true }]
      : [],
    commandCompletions: () => [], listFiles: async () => [], listModels: async () => [],
    loadOlder: () => 0, cycleMode() {}, setResumeTarget() {}, submit() { channel.submitted++ },
    cancel() { channel.cancelled++ }, submitted: 0, cancelled: 0,
    runExternalCommandOutcome: () => Promise.resolve({ kind: 'success', text: DSH_STATUS, consumeDraft: true }),
    // Mirrors the core's row shape (local + one local-output row per line).
    pushLocal(title, lines, options) {
      channel.localBlocks.push({ title, lines: [...lines], lineLimit: options?.lineLimit })
      channel.rows.push({ id: channel.rows.length, kind: 'local', text: title })
      for (const line of lines) channel.rows.push({ id: channel.rows.length, kind: 'local-output', text: line })
      channel.emit()
    },
    notify(text, options) { channel.notifications.push({ text, color: options?.color }); channel.emit() },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    emit() { channel.version++; for (const listener of listeners) listener() },
  }
  return channel
}
const mount = (io, channel, fullscreen) => render(
  fullscreen
    ? React.createElement(AlternateScreen, null, React.createElement(Chat, { channel, fullscreen: true, questionStore: new QuestionStore(), onExit() {} }))
    : React.createElement(Chat, { channel, fullscreen: false, questionStore: new QuestionStore(), onExit() {} }),
  { stdout: io.stdout, stderr: io.stderr, stdin: io.stdin, exitOnCtrlC: false, patchConsole: false },
)
const type = async (io, text) => {
  for (const char of text) io.stdin.write(char)
  // 固定窗:pacing the prompt applies typed characters on its own render tick.
  await sleep(120)
}

// ── 1. inline: bare `/goal` prints the whole objective as a block ────────
{
  const io = makeTerm()
  const channel = makeChannel({ externalGoal: true })
  const app = await mount(io, channel, false)
  await settle(() => io.screen().includes('Ready.'))
  await type(io, '/goal')
  io.stdin.write('\r')
  check('inline: bare /goal prints a transcript block', await settled(() => bufferText(io.term).includes('! /goal')), bufferText(io.term))
  check('inline: the whole objective reached the transcript (no cell truncation)',
    await settled(() => bufferText(io.term).includes('GOAL_HEAD') && bufferText(io.term).includes('GOAL_TAIL')))
  check('inline: every status line survives as its own row',
    bufferText(io.term).includes('Status: active') && bufferText(io.term).includes('Rounds: 0/40')
    && bufferText(io.term).includes('Commands: /goal edit'))
  check('inline: the flattened single-row toast is gone',
    channel.localBlocks.length === 1 && channel.notifications.length === 0
    && !bufferText(io.term).includes('Goal Status:'), `${JSON.stringify(channel.localBlocks)}\n${channel.notifications.map(item => item.text).join('|')}`)
  check('inline: the block rides the raised per-line budget', channel.localBlocks[0]?.lineLimit > 240, String(channel.localBlocks[0]?.lineLimit))
  await app.unmount(); io.term.dispose()
}

// ── 1b. the same block on a narrow inline terminal ──────────────────────
{
  const io = makeTerm(54, 18)
  const channel = makeChannel({ externalGoal: true })
  const app = await mount(io, channel, false)
  await settle(() => io.screen().includes('Ready.'))
  await type(io, '/goal')
  io.stdin.write('\r')
  check('narrow inline (54 cols): the block still carries the whole objective',
    await settled(() => bufferText(io.term).includes('! /goal')
      && bufferText(io.term).includes('GOAL_HEAD') && bufferText(io.term).includes('GOAL_TAIL')),
    bufferText(io.term).split('\n').slice(-14).join('\n'))
  await app.unmount(); io.term.dispose()
}

// ── 2. a subcommand keeps the toast (only the status query is a block) ───
{
  const io = makeTerm()
  const channel = makeChannel({ externalGoal: true })
  const app = await mount(io, channel, false)
  await settle(() => io.screen().includes('Ready.'))
  await type(io, '/goal pause')
  io.stdin.write('\r')
  check('subcommand: /goal pause still notifies and pushes no block',
    await settled(() => channel.notifications.length === 1) && channel.localBlocks.length === 0,
    channel.notifications.map(item => item.text).join('|'))
  await app.unmount(); io.term.dispose()
}

// ── 3. fullscreen: hover reads the goal, the click opens nothing ─────────
{
  const io = makeTerm()
  const channel = makeChannel({ goal: { id: 'g1', revision: 1, objective, phase: 'active', roundsStarted: 0, maxGoalRounds: 12 } })
  const app = await mount(io, channel, true)
  await settle(() => findText(io.term, 'GOAL_HEAD') !== null)
  const hover = (hit) => io.stdin.write(`\x1b[<35;${hit.col + 1};${hit.row + 1}M`)
  const click = (hit) => io.stdin.write(`\x1b[<0;${hit.col + 1};${hit.row + 1}M\x1b[<0;${hit.col + 1};${hit.row + 1}m`)
  hover(findText(io.term, 'GOAL_HEAD'))
  check('fullscreen: hovering truncated goal text shows the whole objective',
    await settled(() => getTooltipSnapshot()?.content.includes('GOAL_TAIL') === true), String(getTooltipSnapshot()?.content?.length))
  io.stdin.write('\x1b[<35;1;1M')
  check('fullscreen: leaving the goal clears the tooltip', await settled(() => getTooltipSnapshot() === null))
  channel.goal = { ...channel.goal, objective: 'Short goal' }
  channel.emit()
  await settle(() => findText(io.term, 'Short goal') !== null)
  hover(findText(io.term, 'Short goal'))
  await sleep(700) // 固定窗:墙钟 tooltip dwell must finish before checking absence.
  check('fullscreen: a fitting goal stays tooltip-silent', getTooltipSnapshot() === null)
  io.stdin.write('\x1b[<35;1;1M')
  channel.goal = { ...channel.goal, objective }
  channel.emit()
  await settle(() => findText(io.term, 'GOAL_HEAD') !== null)
  const rowsBefore = channel.rows.length
  click(findText(io.term, 'GOAL_HEAD'))
  // The removed overlay owned the keyboard here; the composer must keep it.
  await type(io, 'leak')
  io.stdin.write('\r')
  check('fullscreen: clicking the goal text opens nothing (composer keeps the keyboard)',
    await settled(() => channel.submitted === 1) && channel.rows.length === rowsBefore && channel.cancelled === 0,
    `submitted=${channel.submitted} rows=${channel.rows.length - rowsBefore}`)
  clearTooltip()
  await app.unmount(); io.term.dispose()
}
// Footer dismissal is a Chat action, so exercise its real key route in both modes.
for (const fullscreen of [false, true]) {
  const io = makeTerm(70, 24)
  const channel = makeChannel({ goal: {
    id: 'finished', revision: 1, objective: 'COMPLETED_FOOTER', phase: 'complete',
    roundsStarted: 1, maxGoalRounds: 1,
  } })
  channel.todos = [{ content: 'RESIDUAL_TODO', status: 'in_progress' }]
  const originalTodos = channel.todos
  const app = await mount(io, channel, fullscreen)
  await settle(() => io.screen().includes('Ready.'))
  check(`${fullscreen}: completed idle goal and stale todos leave the footer`,
    !io.screen().includes('COMPLETED_FOOTER') && !io.screen().includes('RESIDUAL_TODO'))
  io.stdin.write('\x11')
  check(`${fullscreen}: Ctrl+Q restores an automatically hidden completed footer`,
    await settled(() => io.screen().includes('COMPLETED_FOOTER') && io.screen().includes('RESIDUAL_TODO')))
  io.stdin.write('\x11')
  await settle(() => !io.screen().includes('COMPLETED_FOOTER') && !io.screen().includes('RESIDUAL_TODO'))
  // Footer snapshots compare by content (the production read view re-copies
  // every version), so the later update must carry new data, not a new array.
  const laterTodos = [{ content: 'RESIDUAL_TODO', status: 'pending' }]
  channel.todos = laterTodos
  channel.emit()
  check(`${fullscreen}: a later todo update is visible beside a completed goal`, await settled(() => io.screen().includes('RESIDUAL_TODO')))
  channel.goal = undefined
  channel.emit()
  // Wait for the goal-less render: the todo row is already on screen, and a
  // press before this frame would act on the previous (goal) content.
  await settle(() => io.screen().includes('RESIDUAL_TODO') && !io.screen().includes('COMPLETED_FOOTER'))
  io.stdin.write('\x11')
  check(`${fullscreen}: Ctrl+Q hides idle residual todos`, await settled(() => !io.screen().includes('RESIDUAL_TODO')))
  check(`${fullscreen}: hide preserves canonical todo snapshot`, channel.todos === laterTodos && channel.todos[0].status === 'pending')
  io.stdin.write('\x11')
  await settle(() => io.screen().includes('RESIDUAL_TODO'))
  io.stdin.write('\x11')
  await settle(() => !io.screen().includes('RESIDUAL_TODO'))
  channel.todos = [{ content: 'NEW_TODO_SNAPSHOT', status: 'pending' }]
  channel.emit()
  check(`${fullscreen}: a new todo snapshot reveals the footer`, await settled(() => io.screen().includes('NEW_TODO_SNAPSHOT')))
  channel.goal = { id: 'finished', revision: 2, objective: 'REACTIVATED_GOAL', phase: 'active', roundsStarted: 1, maxGoalRounds: 3 }
  channel.emit()
  check(`${fullscreen}: a reactivated goal is visible`, await settled(() => io.screen().includes('REACTIVATED_GOAL')))
  await app.unmount()
  io.term.dispose()
}

// A settled footer must not come back on a later turn. Mount through the real
// ChannelUi read view: it re-copies goal/todo objects on every channel
// version, so the footer can only recognise "the same snapshot" by content.
const { createChannelUi, createChannelUiLease } = await import('../src/adapter/channel/ui.js')
const { CHANNEL_UI_EFFECTS } = await import('../src/adapter/channel/ui-policy.js')
// The view wraps every effect key; give the stub a no-op for the ones it lacks
// so the production wrappers have something to call. Observations and notify
// hand their result to the lease as a disposer.
const project = raw => {
  for (const key of Object.keys(CHANNEL_UI_EFFECTS)) {
    if (typeof raw[key] !== 'function') raw[key] = key.startsWith('subscribe') ? () => () => {} : () => undefined
  }
  const notify = raw.notify
  raw.notify = (...args) => { notify.apply(raw, args); return () => {} }
  raw.subagentControl ??= { interrupt() {} }
  return createChannelUi(raw, 'new', createChannelUiLease(() => true))
}
const footerShows = (io, text) => io.screen().includes(text)
// Advance the channel version without new goal/todo data (activity, status…).
const bump = async (raw, times = 3) => {
  for (let index = 0; index < times; index++) raw.emit()
  await sleep(150) // 固定窗:探针 仅 version 变化后已完成的底栏不得重新画出
}
const completedGoal = (objective, id = 'turn-goal') => ({
  id, revision: 2, objective, phase: 'complete', roundsStarted: 1, maxGoalRounds: 3,
})
for (const fullscreen of [false, true]) {
  // a. The settling turn shows progress, idle hides it, the next query keeps
  //    it hidden through several version-only updates, new work shows.
  {
    const io = makeTerm(70, 24)
    const raw = makeChannel({ goal: { ...completedGoal('SETTLING_GOAL'), revision: 1, phase: 'active' } })
    raw.todos = [{ content: 'GOAL_TODO', status: 'in_progress' }]
    raw.working = true
    raw.turnStart = 1
    const app = await mount(io, project(raw), fullscreen)
    await settle(() => footerShows(io, 'SETTLING_GOAL'))
    raw.goal = completedGoal('SETTLING_GOAL')
    raw.todos = [{ content: 'GOAL_TODO', status: 'completed' }]
    raw.emit()
    await bump(raw)
    check(`${fullscreen}: the goal stays visible through the turn that completes it`, footerShows(io, 'SETTLING_GOAL'), io.screen())
    raw.working = false
    raw.emit()
    check(`${fullscreen}: the completed goal hides when that turn goes idle`,
      await settled(() => !footerShows(io, 'SETTLING_GOAL') && !footerShows(io, 'GOAL_TODO')))
    raw.working = true
    raw.turnStart = 2
    raw.emit()
    await bump(raw)
    check(`${fullscreen}: the next query does not bring the completed goal back`,
      !footerShows(io, 'SETTLING_GOAL') && !footerShows(io, 'GOAL_TODO'), io.screen())
    raw.todos = [{ content: 'NEXT_TURN_TODO', status: 'in_progress' }]
    raw.emit()
    check(`${fullscreen}: new todo work in the next turn is visible`, await settled(() => footerShows(io, 'NEXT_TURN_TODO')))
    await app.unmount(); io.term.dispose()
  }
  // b. Without a goal, an all-completed list settles the footer the same way.
  {
    const io = makeTerm(70, 24)
    const raw = makeChannel()
    raw.todos = [{ content: 'LIST_DONE_A', status: 'in_progress' }, { content: 'LIST_DONE_B', status: 'completed' }]
    raw.working = true
    raw.turnStart = 1
    const app = await mount(io, project(raw), fullscreen)
    await settle(() => footerShows(io, 'LIST_DONE_A'))
    raw.todos = [{ content: 'LIST_DONE_A', status: 'completed' }, { content: 'LIST_DONE_B', status: 'completed' }]
    raw.emit()
    await bump(raw)
    check(`${fullscreen}: an all-completed list stays visible through its turn`, footerShows(io, 'LIST_DONE_A'), io.screen())
    raw.working = false
    raw.emit()
    check(`${fullscreen}: the all-completed list hides when the turn goes idle`,
      await settled(() => !footerShows(io, 'LIST_DONE_A') && !footerShows(io, '✓ 2/2')))
    raw.working = true
    raw.turnStart = 2
    raw.emit()
    await bump(raw)
    check(`${fullscreen}: the next query does not bring the completed list back`,
      !footerShows(io, 'LIST_DONE_A') && !footerShows(io, '✓ 2/2'), io.screen())
    raw.todos = [{ content: 'FRESH_LIST', status: 'pending' }]
    raw.emit()
    check(`${fullscreen}: a fresh todo list is visible`, await settled(() => footerShows(io, 'FRESH_LIST')))
    await app.unmount(); io.term.dispose()
  }
  // c. Restart + resume: the first render is already a running turn over a
  //    completed goal and list (the reported bug). Nothing settled reappears.
  {
    const io = makeTerm(70, 24)
    const raw = makeChannel({ goal: completedGoal('RESUMED_GOAL') })
    raw.todos = [{ content: 'RESUMED_TODO', status: 'completed' }]
    raw.working = true
    raw.turnStart = 5
    const app = await mount(io, project(raw), fullscreen)
    await settle(() => io.screen().includes('Ready.'))
    await bump(raw)
    check(`${fullscreen}: a resumed session's first running turn hides its completed goal and todos`,
      !footerShows(io, 'RESUMED_GOAL') && !footerShows(io, 'RESUMED_TODO'), io.screen())
    raw.goal = { ...completedGoal('RESUMED_NEW_GOAL', 'next-goal'), revision: 1, phase: 'active' }
    raw.emit()
    check(`${fullscreen}: a new goal after resume is visible`, await settled(() => footerShows(io, 'RESUMED_NEW_GOAL')))
    await app.unmount(); io.term.dispose()
  }
  // d. Back-to-back turns: the UI never observes idle between them. What the
  //    first turn completed must still hide once the second turn starts.
  {
    const io = makeTerm(70, 24)
    const raw = makeChannel({ goal: { ...completedGoal('QUEUED_GOAL'), revision: 1, phase: 'active' } })
    raw.working = true
    raw.turnStart = 1
    const app = await mount(io, project(raw), fullscreen)
    await settle(() => footerShows(io, 'QUEUED_GOAL'))
    raw.goal = completedGoal('QUEUED_GOAL')
    raw.emit()
    await bump(raw)
    check(`${fullscreen}: back-to-back: visible through the turn that completes it`, footerShows(io, 'QUEUED_GOAL'), io.screen())
    raw.turnStart = 2
    raw.emit()
    check(`${fullscreen}: back-to-back: hidden once the next turn starts without an idle`,
      await settled(() => !footerShows(io, 'QUEUED_GOAL')))
    await app.unmount(); io.term.dispose()
  }
  // e. Ctrl+Q reveal survives version-only updates (content, not references)
  //    and stays scoped to its session.
  {
    const io = makeTerm(70, 24)
    const raw = makeChannel({ goal: completedGoal('REVEALED_GOAL') })
    const app = await mount(io, project(raw), fullscreen)
    await settle(() => io.screen().includes('Ready.') && !footerShows(io, 'REVEALED_GOAL'))
    io.stdin.write('\x11')
    check(`${fullscreen}: Ctrl+Q reveals the settled footer`, await settled(() => footerShows(io, 'REVEALED_GOAL')))
    await bump(raw)
    check(`${fullscreen}: the reveal survives version-only updates`, footerShows(io, 'REVEALED_GOAL'), io.screen())
    raw.agentId = 'other-session'
    raw.emit()
    check(`${fullscreen}: the reveal does not carry into another session`,
      await settled(() => !footerShows(io, 'REVEALED_GOAL')))
    await app.unmount(); io.term.dispose()
  }
}

process.exitCode = failed ? 1 : 0
