/**
 * Focused `/rollover` regression, channel side: the rolled-over NAME, the
 * mid-turn refusal that must land BEFORE the rename, and the wiring that
 * routes the command.
 *
 * `/rollover` renames the live session to `<project>-<date>-<NN>` and reports
 * the title its successor inherits. Two properties break silently, so both
 * are checked against the REAL listing pipeline (written logs, real digests)
 * rather than a hand-fed row list:
 *
 *  - the ordinal is this project's, this day's, and one past the HIGHEST
 *    existing one — not a count, not another day's, not another project's,
 *    and not a non-numeric suffix;
 *  - a running turn refuses BEFORE any title is appended, and a binding that
 *    moved during the scan refuses too: a rollover that did not happen leaves
 *    the live session untouched. What the screen does with each outcome is
 *    verify-rollover-screen's job.
 *
 * Run: node --import tsx/esm scripts/verify-rollover-command.ts
 * Exits non-zero on any assertion failure (CI gate).
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

// Isolation BEFORE any src import: the session root, the listing snapshot and
// ~/.dsh-tui all resolve at import/call time, and the listing writes to disk.
const root = mkdtempSync(join(tmpdir(), 'dsh-tui-rollover-root-'))
const home = mkdtempSync(join(tmpdir(), 'dsh-tui-rollover-home-'))
process.env.DSH_TUI_SESSION_ROOT = root
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_TUI_LANG = 'zh'

const [
  { createSessionMetadataActions },
  { createChannelActionMethods, createUnavailableActionDelegates },
  { createChannelOwner },
  { CHANNEL_UI_EFFECTS },
  commands,
  { i18nDict, t },
] = await Promise.all([
  import('../src/dsh-adapter/channel/session-metadata.js'),
  import('../src/dsh-adapter/channel/action-readiness.js'),
  import('../src/dsh-adapter/channel/owner.js'),
  import('../src/adapter/channel/ui-policy.js'),
  import('../src/commands.js'),
  import('../src/i18n.js'),
])

const PROJECT = '/proj/bean'
/** The local calendar day, from a formatter rather than the source's own pad. */
const TODAY = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())

let checks = 0
const check = (label: string, condition: boolean, detail = ''): void => {
  assert.ok(condition, `${label}${detail === '' ? '' : `  (${detail})`}`)
  checks += 1
}

/**
 * One stored session, as the listing reads it back: a real log with a title.
 *
 * `ageSeconds` is written onto the log's mtime on purpose. The listing orders
 * rows by `updatedAt` (dominated by that mtime), so this is the one lever that
 * pins the row order the ordinal scan walks — see {@link OWN_DAY}.
 */
const stored = (id: string, cwd: string, title: string, ageSeconds: number): { id: string; cwd: string; createdAt: number } => {
  const dir = join(root, '--bean--', id)
  mkdirSync(dir, { recursive: true })
  const frame = [
    { type: 'session', version: 0, id, createdAt: 1, cwd, delegationDepth: 0, agentPreset: 'standard' },
    { type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: '结转夹具' }] } },
    { type: 'session/title', seq: 1, time: 2, data: { title, messageSeqs: [], source: { kind: 'user' } } },
  ]
  const file = join(dir, 'session.jsonl.zstd')
  writeFileSync(file, zstdCompressSync(Buffer.from(frame.map(event => JSON.stringify(event)).join('\n') + '\n', 'utf8')))
  const stamp = new Date(Date.now() - ageSeconds * 1000)
  utimesSync(file, stamp, stamp)
  return { id, cwd, createdAt: 1 }
}

const uuid = (suffix: string): string => `aaaaaaaa-0000-0000-0000-0000000000${suffix}`
// Newest first, and deliberately NOT in ordinal order: the highest ordinal of
// the day is the FIRST matching row, the lower one comes later. A scan that
// took "the last row that matched" instead of the highest ordinal answers 02
// from this history, and a scan that ignored the prefix answers 10 off the
// other project's row or 100 off the other day's.
const OWN_DAY = [
  stored(uuid('01'), PROJECT, `bean-${TODAY}-07`, 0),
  stored(uuid('02'), PROJECT, `bean-${TODAY}-01`, 60),
  stored(uuid('03'), PROJECT, `bean-${TODAY}-x3`, 120),
  stored(uuid('04'), '/proj/other', `other-${TODAY}-09`, 180),
  stored(uuid('05'), PROJECT, 'bean-2020-01-01-99', 240),
]

interface RolloverRun {
  result: { ok: boolean; title?: string; inherit?: string; reason?: string }
  events: Array<{ type: string; data: unknown }>
  notices: Array<{ message: string; options: unknown }>
  titles: string[]
  emits: number
}

/** Drive one `rolloverSession()` against the real listing with the given live log. */
async function rolloverOnce(options: {
  headers?: readonly { id: string; cwd: string; createdAt: number }[]
  liveTitles?: ReadonlyArray<{ title: string; kind: string }>
  working?: boolean
  cwd?: string | null
  duringList?: (handle: { move: () => void }) => void
} = {}): Promise<RolloverRun> {
  let generation = 1
  const events: Array<{ type: string; data: unknown }> = (options.liveTitles ?? []).map(({ title, kind }) => ({
    type: 'session/title',
    data: { title, messageSeqs: [], source: { kind } },
  }))
  const session = {
    id: 'live-session',
    events,
    append: (type: string, data: unknown): unknown => {
      events.push({ type, data })
      return { type, data }
    },
  }
  const agent = { session }
  const owner = createChannelOwner()
  const binding = {
    capture: () => ({ agent, generation }),
    isCurrent: (capture: { agent: unknown; generation: number }): boolean =>
      owner.current() && capture.agent === agent && capture.generation === generation,
  }
  const notices: RolloverRun['notices'] = []
  const titles: string[] = []
  let emits = 0
  const source = {
    name: 'verify-rollover-fixture',
    config: { root },
    list: async (): Promise<unknown> => {
      options.duringList?.({ move: () => { generation += 1 } })
      return options.headers ?? []
    },
  }
  const ctx = { get: (name: string) => name === 'sessionPersistence' ? source : undefined }
  const actions = createSessionMetadataActions(ctx as never, {
    owner,
    binding: binding as never,
    provider: () => 'deepseek',
    model: () => 'model',
    ...(options.cwd === null ? {} : { cwd: () => options.cwd ?? PROJECT }),
    emit: () => { emits += 1 },
    sessionTitle: () => '',
    setSessionTitle: title => { titles.push(title) },
    working: () => options.working === true,
    notify: (message, opts) => { notices.push({ message, options: opts }) },
    setSessionColor: () => undefined,
    forgetAgentView: () => undefined,
    setPersistedSessions: () => undefined,
    skillRegistryFor: () => undefined,
    skillViewOptions: () => ({ scope: agent as never, cwd: PROJECT }),
  })
  const result = await actions.rolloverSession() as RolloverRun['result']
  return { result, events, notices, titles, emits }
}

const userTitle = (title: string): { title: string; kind: string } => ({ title, kind: 'user' })
const autoTitle = (title: string): { title: string; kind: string } => ({ title, kind: 'provider' })

try {
  // ── 1. The ordinal is this project's, this day's, one past the highest ────
  const first = await rolloverOnce({ headers: OWN_DAY, liveTitles: [userTitle('我的会话')] })
  check('the rolled-over name counts on from the highest ordinal of this day',
    first.result.title === `bean-${TODAY}-08`, String(first.result.title))
  check('a user title is reported for the successor to inherit', first.result.inherit === '我的会话', String(first.result.inherit))
  check('the live log carries the rename with the strict payload the log reader needs',
    JSON.stringify(first.events.at(-1)) === JSON.stringify({ type: 'session/title', data: { title: `bean-${TODAY}-08`, messageSeqs: [], source: { kind: 'user' } } }),
    JSON.stringify(first.events.at(-1)))
  check('the rename reaches the status line once', first.titles.length === 1 && first.titles[0] === `bean-${TODAY}-08` && first.emits === 1,
    JSON.stringify({ titles: first.titles, emits: first.emits }))
  check('a successful rollover says nothing itself; the screen reports it', first.notices.length === 0)

  // ── 2. An automatic title is the provider's, not the user's: not inherited ─
  const auto = await rolloverOnce({ headers: OWN_DAY, liveTitles: [autoTitle('Bean 项目重构')] })
  check('a provider-generated title is not carried over', auto.result.ok === true && auto.result.inherit === undefined,
    JSON.stringify(auto.result))
  check('the last title event wins when the log carries several',
    (await rolloverOnce({ headers: OWN_DAY, liveTitles: [autoTitle('自动'), userTitle('最后')] })).result.inherit === '最后')

  // ── 3. A running turn refuses BEFORE the rename ──────────────────────────
  const working = await rolloverOnce({ headers: OWN_DAY, liveTitles: [userTitle('我的会话')], working: true })
  check('a running turn refuses with its own reason',
    working.result.ok === false && working.result.reason === 'working', JSON.stringify(working.result))
  check('and says so with the notice /new refuses on',
    working.notices.length === 1 && working.notices[0]!.message === t('new-session-while-working'),
    JSON.stringify(working.notices))
  check('the refusal leaves the live log untouched: no rename was appended',
    working.events.length === 1 && working.titles.length === 0 && working.emits === 0,
    JSON.stringify({ events: working.events.length, titles: working.titles, emits: working.emits }))

  // ── 4. A binding that moved during the scan renames nothing ──────────────
  const moved = await rolloverOnce({ headers: OWN_DAY, duringList: handle => { handle.move() } })
  check('a session replaced mid-scan refuses as cancelled',
    moved.result.ok === false && moved.result.reason === 'cancelled', JSON.stringify(moved.result))
  check('and appends nothing to the session that left', moved.events.length === 0 && moved.titles.length === 0,
    JSON.stringify({ events: moved.events.length, titles: moved.titles }))

  // ── 5. First archive of the day, and the cwd-less fallback name ──────────
  const empty = await rolloverOnce({ headers: [] })
  check('an empty history starts at 01', empty.result.title === `bean-${TODAY}-01`, String(empty.result.title))
  const noCwd = await rolloverOnce({ headers: [], cwd: null })
  check('a session without a workspace rolls over under the fallback name',
    noCwd.result.title === `session-${TODAY}-01`, String(noCwd.result.title))

  // ── 6. Wiring: the command, its gate, its effect class and its refusals ───
  check('/rollover is a declared local command', commands.LOCAL_COMMANDS.some(command => command.name === 'rollover'))
  const declared = commands.LOCAL_COMMANDS.find(command => command.name === 'rollover')!
  check('/rollover is advertised through its i18n description',
    commands.localizedDescription(declared) === i18nDict['cmd-desc-rollover']?.zh,
    commands.localizedDescription(declared))
  check('/rollover is refused while a turn runs, like /new', commands.workingHoldOf('rollover') === 'gated')
  check('and shares /new\'s refusal text', commands.WORKING_GATE_NOTICES['rollover'] === 'new-session-while-working')
  check('the channel classifies the rollover as a mutation', CHANNEL_UI_EFFECTS['rolloverSession'] === 'mutate')

  const proxied = createChannelActionMethods(() => ({ rolloverSession: () => Promise.resolve({ ok: true, title: 'proxied' }) }) as never)
  check('the Channel proxy forwards rolloverSession to the installed delegates',
    JSON.stringify(await proxied.rolloverSession()) === JSON.stringify({ ok: true, title: 'proxied' }))

  const refusedNames: string[] = []
  const unavailable = createUnavailableActionDelegates(name => refusedNames.push(name), () => [])
  const refusedRollover = await unavailable.rolloverSession()
  check('a composition without the rollover action refuses instead of pretending',
    JSON.stringify(refusedRollover) === JSON.stringify({ ok: false, reason: 'unavailable' }),
    JSON.stringify(refusedRollover))
  check('and the refusal is reported as the /rollover action', JSON.stringify(refusedNames) === JSON.stringify(['rollover']),
    JSON.stringify(refusedNames))

  console.log(`verify:rollover-command OK (${checks} checks)`)
} finally {
  rmSync(root, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
}
