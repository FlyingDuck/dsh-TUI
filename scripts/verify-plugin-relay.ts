/**
 * 插件中继消息（dsh-intercom 入站）的转录显示回归。
 *
 * 输入是 `scripts/fixtures/plugin-relay/intercom-inbound-rows.json` —— 从真实会话
 * 日志抠出的落盘形状（见该文件的 provenance），三条覆盖三个场景：
 *
 *   A. `agent/inbox/spliced`（进收件箱待领）**不落转录行**：投递事实与转录事实分属
 *      两个 stage，同一条消息的转录行只由后面的 `user/message` 产出，所以不用排重。
 *      注意它并不是「不产事件」—— 兜底的 `custom` 事件要经 `tuiRenderers` 接缝才画，
 *      真正的不变量是「不产 `user.message` 且投影不落行」，这条也防着以后有人给
 *      `agent/inbox/spliced` 注册渲染器而画出第二个气泡；
 *   B. `user/message` 没有 `transcript` payload → 仍是 `injected`、正文为空：
 *      老日志与没 opt-in 的插件照旧不显示；
 *   C. `user/message` 带 payload → `plugin-relay`，气泡正文与 sender 取自 durable
 *      source，而 `blocks` 仍是模型面那份框架文本（两者必须不同源，否则模型面被改）；
 *   D. opt-in 判据的负例：`form` 不对 / kind 不在 `plugin:` 命名空间 / `text` 为空或
 *      非字符串 / `transcript` 不是对象 —— 一律落到 `injected`；
 *   E. 投影落行：`kind: 'user'` + `label: 'plugin-relay'` + sender，且上下文占用按
 *      **模型面** 的 `blocks` 计（用两份只差 blocks 的输入对比，不依赖分词实现）；
 *   F. 「不是人说的话」只有一个真源：`isPeerMessageRow` / `peerMessageOf` 覆盖
 *      `team-message` 与 `plugin-relay`（带 label 的 steering 不在内），并且 `/export`
 *      真的按这个谓词换分节标题。
 *
 * 运行：node --import tsx/esm scripts/verify-plugin-relay.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '../src/agent/events.js'
import { isPeerMessageRow, peerMessageOf } from '../src/channel/transcript.js'
import { createCoreReports } from '../src/dsh-adapter/channel/core/reports.js'
import { createDshTranslator } from '../src/dsh-adapter/backend/translate.js'
import { setLang } from '../src/i18n.js'
import { createProjectorHarness } from './lib/projector-harness.js'

type RawRow = {
  readonly label: string
  readonly real: boolean
  readonly expected: string
  readonly row: { readonly type: string; readonly seq: number; readonly time: number; readonly data: Record<string, unknown> }
}

const fixture = JSON.parse(readFileSync(new URL('./fixtures/plugin-relay/intercom-inbound-rows.json', import.meta.url), 'utf8')) as { readonly rows: readonly RawRow[] }
const rows = fixture.rows
const sourceOf = (entry: RawRow): { readonly transcript?: unknown } | undefined => entry.row.data.source as { readonly transcript?: unknown } | undefined
const splicedRow = rows.find(entry => entry.row.type === 'agent/inbox/spliced')
const noPayloadRow = rows.find(entry => entry.row.type === 'user/message' && sourceOf(entry)?.transcript === undefined)
const payloadRow = rows.find(entry => sourceOf(entry)?.transcript !== undefined)
assert.ok(splicedRow !== undefined && noPayloadRow !== undefined && payloadRow !== undefined, 'fixture 三条场景都在')
const payload = (payloadRow.row.data.source as { transcript: { sender: string; sessionId: string; text: string } }).transcript

// 中文断言（分节标题）不依赖这台机器的语言偏好。
setLang('zh')

const DEPS = { tools: () => undefined, scope: () => ({}), attachments: () => undefined }
/** 一条输入一行输出：每个场景都用全新的 translator，避免跨场景的状态串味。 */
const translate = (row: unknown): readonly AgentEvent[] => createDshTranslator(DEPS).translateEvent(row as never)
const userMessages = (events: readonly AgentEvent[]) => events.filter((event): event is Extract<AgentEvent, { type: 'user.message' }> => event.type === 'user.message')

/** 把 fixture 的 user/message 换一个 source（opt-in 负例都靠它）。 */
const withSource = (source: unknown): unknown => ({ ...payloadRow.row, data: { ...payloadRow.row.data, source } })

let checks = 0
const failures: string[] = []
const check = (name: string, ok: boolean, detail = ''): void => {
  checks += 1
  if (!ok) failures.push(`${name}${detail === '' ? '' : `: ${detail}`}`)
}

// ── A. spliced 不落转录行 ──────────────────────────────────────────────────
// 判据**不是**「不产事件」：`translate.ts` 第二个 switch 的 default 会把任何
// 未识别类型兜底成一条 `custom` 事件（nativeType = 原标题），`agent/inbox/
// spliced` 也走这条。它经 `tuiRenderers` 接缝渲染 —— **没有为这个 nativeType
// 注册渲染器时什么都不画**。所以真正要钉的是：不产 `user.message`，且投影不落行。
{
  const events = translate(splicedRow.row)
  check('A spliced 不产 user.message（转录行只由 user/message 产出）', userMessages(events).length === 0, JSON.stringify(events.slice(0, 1)))
  check('A spliced 兜底成 custom 事件（所以判据不能写成「不产事件」）',
    events.length === 1 && events[0]?.type === 'custom', events.map(event => event.type).join(', '))
  const harness = createProjectorHarness()
  harness.apply(events)
  check('A spliced 在投影里不落任何行（该 nativeType 没有注册渲染器）', harness.state.rows.length === 0, String(harness.state.rows.length))
}

// ── B. 没有 payload 仍然是 injected ────────────────────────────────────────
{
  const events = userMessages(translate(noPayloadRow.row))
  const [event] = events
  check('B 无 payload：产出恰好一条 user.message', events.length === 1, String(events.length))
  check('B 无 payload：source 仍是 injected', event?.source === 'injected', String(event?.source))
  check('B 无 payload：正文为空（不露出框架文本）', event?.text === '', JSON.stringify(event?.text))
  check('B 无 payload：不带 label（落不成气泡）', event?.label === undefined, String(event?.label))
}

// ── C. 带 payload → plugin-relay ───────────────────────────────────────────
const relayEvent = userMessages(translate(payloadRow.row))[0]
{
  check('C 带 payload：产出恰好一条 user.message', relayEvent !== undefined)
  check('C 带 payload：source 是 plugin-relay', relayEvent?.source === 'plugin-relay', String(relayEvent?.source))
  check('C 带 payload：正文取自 durable source', relayEvent?.text === payload.text, JSON.stringify(relayEvent?.text))
  check('C 带 payload：sender 取自 durable source', relayEvent?.sender === payload.sender, String(relayEvent?.sender))
  // 模型面没被动过：blocks 仍是插件写的那份框架文本，且与展示正文不同源。
  const modelText = (relayEvent?.blocks ?? []).filter(block => block.type === 'text').map(block => block.text).join('')
  check('C 模型面仍是框架文本', modelText.includes('[INTERCOM MESSAGE]') && modelText.includes(payload.text), modelText.slice(0, 60))
  check('C 展示正文与模型面确实不同源', relayEvent?.text !== modelText)
}

// ── D. opt-in 负例 ────────────────────────────────────────────────────────
{
  const cases: readonly { readonly name: string; readonly source: unknown; readonly relay: boolean; readonly sender?: string }[] = [
    { name: 'form 不是 relay', source: { kind: 'plugin:dsh-intercom', transcript: { text: 'hi' } }, relay: false },
    { name: 'kind 不在 plugin: 命名空间', source: { kind: 'other-producer', form: 'relay', transcript: { text: 'hi' } }, relay: false },
    { name: 'text 是空串', source: { kind: 'plugin:x', form: 'relay', transcript: { text: '' } }, relay: false },
    { name: 'text 不是字符串', source: { kind: 'plugin:x', form: 'relay', transcript: { text: 5 } }, relay: false },
    { name: 'transcript 不是对象', source: { kind: 'plugin:x', form: 'relay', transcript: 'hi' }, relay: false },
    { name: '只有 form 没有 transcript', source: { kind: 'plugin:x', form: 'relay' }, relay: false },
    { name: '最小 opt-in（无 sender）也显示', source: { kind: 'plugin:x', form: 'relay', transcript: { text: 'hi' } }, relay: true, sender: '' },
    { name: 'sender 存在时透传', source: { kind: 'plugin:x', form: 'relay', transcript: { text: 'hi', sender: 'peer-b' } }, relay: true, sender: 'peer-b' },
  ]
  for (const entry of cases) {
    const [event] = userMessages(translate(withSource(entry.source)))
    check(`D ${entry.name}：source 是 ${entry.relay ? 'plugin-relay' : 'injected'}`, event?.source === (entry.relay ? 'plugin-relay' : 'injected'), String(event?.source))
    if (entry.sender !== undefined) check(`D ${entry.name}：sender 是 ${JSON.stringify(entry.sender)}`, event?.sender === entry.sender, JSON.stringify(event?.sender))
  }
}

// ── E. 投影落行 + 上下文按模型面计 ────────────────────────────────────────
{
  const harness = createProjectorHarness()
  harness.apply([...translate(payloadRow.row)])
  const row = harness.state.rows.filter(candidate => candidate.kind === 'user').at(-1)
  check('E 落出一条 user 行', row !== undefined)
  check('E 行的 label 是 plugin-relay', row?.label === 'plugin-relay', String(row?.label))
  check('E 行的正文是展示正文（不是框架文本）', row?.text === payload.text, JSON.stringify(row?.text))
  check('E 行的 sender 是 payload.sender', row?.sender === payload.sender, String(row?.sender))
  check('E 该行被认作 peer（不是人类 prompt）', row !== undefined && isPeerMessageRow(row))
  check('E 该行带上自己的分节标题键', row !== undefined && peerMessageOf(row)?.captionKey === 'plugin-relay-label')
  check('E 上下文占用按模型面记了（> 0）', harness.state.contextSegments.prompt > 0, String(harness.state.contextSegments.prompt))

  // 两份输入只差 `content`（一份是框架文本，一份只有展示正文），展示正文相同：
  // 若占用跟着 blocks 走，长的那份必然更贵。
  const shortContent = { ...payloadRow.row, data: { ...payloadRow.row.data, content: [{ type: 'text', text: payload.text }] } }
  const shortHarness = createProjectorHarness()
  shortHarness.apply([...translate(shortContent)])
  check('E 占用跟的是 blocks（模型面），不是展示正文',
    harness.state.contextSegments.prompt > shortHarness.state.contextSegments.prompt,
    `${harness.state.contextSegments.prompt} vs ${shortHarness.state.contextSegments.prompt}`)
}

// ── F. 单一真源 + /export 分节 ────────────────────────────────────────────
{
  check('F team-message 是 peer', isPeerMessageRow({ kind: 'user', label: 'team-message' }))
  check('F plugin-relay 是 peer', isPeerMessageRow({ kind: 'user', label: 'plugin-relay' }))
  check('F 人类 prompt（无 label）不是 peer', !isPeerMessageRow({ kind: 'user' }))
  check('F steering（带 label 的人类行）不是 peer', !isPeerMessageRow({ kind: 'user', label: 'steering' }))
  check('F assistant 行不是 peer', !isPeerMessageRow({ kind: 'assistant', label: 'plugin-relay' }))
  check('F team-message 的标题键仍旧', peerMessageOf({ kind: 'user', label: 'team-message' })?.captionKey === 'team-message-label')
  check('F 无 sender 的 peer 仍然显示（空名字）', peerMessageOf({ kind: 'user', label: 'plugin-relay' })?.sender === '')

  const cwd = mkdtempSync(join(tmpdir(), 'dsh-relay-export-'))
  try {
    const reports = createCoreReports({
      owner: { current: () => true },
      binding: { session: {} as never, capture: () => 1, isCurrent: () => true },
      state: () => ({
        rows: [
          { id: 1, kind: 'user', text: '我说的话' },
          { id: 2, kind: 'user', label: 'plugin-relay', sender: payload.sender, text: payload.text },
          { id: 3, kind: 'user', label: 'team-message', sender: 'teammate-a', text: '队友说的话' },
        ],
        model: 'fixture-model',
        cwd,
        contextWindow: undefined,
        agentId: 'fixture-agent',
        backendCapabilities: {},
      }) as never,
    })
    const target = reports.exportSession()
    check('F /export 写出了文件', typeof target === 'string' && target !== '', String(target))
    const text = target === null ? '' : readFileSync(target, 'utf8')
    check('F /export：插件中继带自己的分节与 sender', text.includes(`## 对端消息 · ${payload.sender}`), text)
    check('F /export：队友消息也走同一分节', text.includes('## 对端消息 · teammate-a'), text)
    check('F /export：人类那条仍在 ## 用户 下', text.includes('## 用户\n\n我说的话'), text)
    // 只有人类那条能落在 ## 用户 下：对端两条各占自己的分节。
    check('F /export：## 用户 只出现一次', text.split('## 用户').length === 2, text)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

if (failures.length > 0) {
  console.error(`plugin-relay FAILED (${failures.length}/${checks}):`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`plugin-relay OK (${checks} checks: spliced 不产行、无 payload 不显示、带 payload 落气泡、opt-in 负例、投影落行与模型面占用、/export 分节)`)
process.exit(0)
