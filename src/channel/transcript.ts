/** Backend-neutral transcript limits and text helpers shared by the projector,
 *  the fold pass and the local-output paths. */
import type { ChatRow } from '../adapter/ports/channel-view.js'
import type { PluginRelayAction } from '../agent/messages.js'
import type { I18nKey } from '../i18n.js'
import { cleanRenderText, NOTICE_CELLS, previewLocalLine } from './sanitize.js'

export const ARGS_PREVIEW_LIMIT = 160

export const RESULT_PREVIEW_LIMIT = 240

/** Local `!`-command output cap per line, in terminal cells. */
export const LOCAL_OUTPUT_LIMIT = 240

/** How many output lines one local `!` command may add to the transcript. */
export const MAX_LOCAL_OUTPUT_LINES = 200

/**
 * In-memory transcript window cap. Older rows beyond this count are folded:
 * their full-text fields (assistant/reasoning text, tool args/results) are
 * dropped and only the preview/status metadata kept, so a long merge/deploy
 * turn cannot grow the TUI's RAM without bound. The session log still holds
 * everything (`/export` reads it, `/resume` replays it); the
 * folded row keeps its kind/id so scrolling and selection stay stable.
 */
export const MAX_ROWS = 600

export function preview(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

/**
 * Split one local command's output into transcript rows: one line per row
 * (the shape `pushLocal` and the projector already use), each sanitized as a
 * block line (see {@link previewLocalLine}) and capped, with the overflow
 * counted so the caller can add a single omission row. The caller passes
 * output already trimmed at both ends.
 */
export function localOutputLines(
  output: string,
  maxCells = LOCAL_OUTPUT_LIMIT,
  maxLines = MAX_LOCAL_OUTPUT_LINES,
): { readonly lines: readonly string[]; readonly omitted: number } {
  const all = output.split(/\r?\n/u)
  const lines = all.slice(0, maxLines).map(line => previewLocalLine(line, maxCells))
  return { lines, omitted: Math.max(0, all.length - maxLines) }
}

/**
 * The `user` rows that are NOT the human's prompt, keyed by their row label,
 * mapped to the caption their bubble shows after the sender (`null`: the head
 * is composed from the row's own payload instead — see {@link relayLeadOf}).
 * Membership IS the definition: every site that asks "is this the human
 * speaking?" reads this map instead of comparing one label string, so the next
 * relay flavor is added once, here — `team-message` (an Agent Teams peer) and
 * `plugin-relay` (an opted-in plugin relay, see `pluginRelaySourceOf`).
 */
export const PEER_MESSAGE_LABELS: ReadonlyMap<string, I18nKey | null> = new Map<string, I18nKey | null>([
  ['team-message', 'team-message-label'],
  ['plugin-relay', null],
])

/**
 * The head a plugin relay's bubble shows before its sender, symmetric with the
 * sending side's card (`intercom · send → X`): `intercom · receive ← ` for one
 * of the frozen action tokens. Empty — the bubble then shows the bare sender —
 * when either half is missing, so an unvetted token is never printed. Both
 * halves are plugin-authored text, so the plugin name goes through the
 * render-path contract (single line, control sequences stripped).
 */
export function relayLeadOf(plugin: string | undefined, action: PluginRelayAction | undefined): string {
  if (plugin === undefined || action === undefined) return ''
  const head = cleanRenderText(plugin, NOTICE_CELLS)
  return head === '' ? '' : `${head} · ${action} ← `
}

/** The part of a row the peer predicates read (all fields are optional there). */
type PeerRow = Pick<ChatRow, 'kind'> & { readonly label?: string; readonly sender?: string; readonly senderLead?: string }

/** Whether a `user` row is a peer message rather than the human's own prompt. */
export function isPeerMessageRow(row: PeerRow): boolean {
  return row.kind === 'user' && row.label !== undefined && PEER_MESSAGE_LABELS.has(row.label)
}

/** What a peer row's bubble shows: the head, the sender name and its caption. */
export function peerMessageOf(row: PeerRow): { readonly sender: string; readonly lead: string; readonly captionKey?: I18nKey } | undefined {
  if (row.kind !== 'user' || row.label === undefined) return undefined
  if (!PEER_MESSAGE_LABELS.has(row.label)) return undefined
  const captionKey = PEER_MESSAGE_LABELS.get(row.label)
  return {
    sender: row.sender ?? '',
    lead: row.senderLead ?? '',
    ...(captionKey === undefined || captionKey === null ? {} : { captionKey }),
  }
}
