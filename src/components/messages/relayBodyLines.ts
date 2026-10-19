/**
 * Long relay bodies fold to a preview, the way a collapsed tool card does: the
 * shared `lines-folded-expand` hint (`… +N lines (Ctrl+O to expand)`) and the
 * per-row expand (or Ctrl+O) for the rest. The hint line is the mouse target —
 * a plain text row stays unclickable on purpose ("转录是阅读区", see the
 * foldOnClick note in MessageList), so the fold must not turn the whole bubble
 * into a button.
 *
 * The budget matches the collapsed tool card's three lines. Hiding a single line
 * is not worth a fold — that one is shown directly, mirroring the tool card's
 * `capLines` and wrapText's "one extra line is shown directly" rule.
 *
 * @module dsh-tui/components/messages/relayBodyLines
 */

/** Lines a collapsed relay body keeps before the fold hint. */
export const RELAY_BODY_LINES = 3

export interface RelayBodyView {
  /** The lines to render (all of them when the body is not folded). */
  readonly lines: readonly string[]
  /** How many lines the fold hid; 0 when the body is shown in full. */
  readonly hiddenLines: number
}

/** Fold `text` to {@link RELAY_BODY_LINES} lines unless `verbose`. */
export function relayBodyView(text: string, verbose: boolean): RelayBodyView {
  const lines = text.split('\n')
  const hiddenLines = lines.length - RELAY_BODY_LINES
  if (verbose || hiddenLines <= 1) return { lines, hiddenLines: 0 }
  return { lines: lines.slice(0, RELAY_BODY_LINES), hiddenLines }
}
