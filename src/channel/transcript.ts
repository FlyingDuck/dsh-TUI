/** Backend-neutral transcript limits and text helpers shared by the projector,
 *  the fold pass and the local-output paths. */
import type { ChatRow } from '../adapter/ports/channel-view.js'
import type { I18nKey } from '../i18n.js'

export const ARGS_PREVIEW_LIMIT = 160

export const RESULT_PREVIEW_LIMIT = 240

/** Local `!`-command output cap (mirrors the result preview limit). */
export const LOCAL_OUTPUT_LIMIT = 240

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
 * The `user` rows that are NOT the human's prompt, keyed by their row label,
 * mapped to the caption their bubble shows after the sender. Membership IS
 * the definition: every site that asks "is this the human speaking?" reads
 * this map instead of comparing one label string, so the next relay flavor is
 * added once, here — `team-message` (an Agent Teams peer) and `plugin-relay`
 * (an opted-in plugin relay, see `pluginRelaySourceOf`).
 */
export const PEER_MESSAGE_LABELS: ReadonlyMap<string, I18nKey> = new Map<string, I18nKey>([
  ['team-message', 'team-message-label'],
  ['plugin-relay', 'plugin-relay-label'],
])

/** The part of a row the peer predicates read (both fields are optional there). */
type PeerRow = Pick<ChatRow, 'kind'> & { readonly label?: string; readonly sender?: string }

/** Whether a `user` row is a peer message rather than the human's own prompt. */
export function isPeerMessageRow(row: PeerRow): boolean {
  return row.kind === 'user' && row.label !== undefined && PEER_MESSAGE_LABELS.has(row.label)
}

/** What a peer row's bubble shows: the sender name and its caption key. */
export function peerMessageOf(row: PeerRow): { readonly sender: string; readonly captionKey: I18nKey } | undefined {
  if (row.kind !== 'user' || row.label === undefined) return undefined
  const captionKey = PEER_MESSAGE_LABELS.get(row.label)
  return captionKey === undefined ? undefined : { sender: row.sender ?? '', captionKey }
}
