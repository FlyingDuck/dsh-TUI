import React from 'react'
import chalk from 'chalk'
import { Box, Text } from '../../ui.js'
import { t } from '../../i18n.js'
import { StreamingMarkdown } from '../StreamingMarkdown.js'
import { formatDuration, formatTokens } from '../../terminal-utils/format.js'
import {
  THINKING_SPINNER_FRAMES,
  THINKING_SPINNER_INTERVAL_MS,
  THINKING_SETTLED_MARKER,
} from '../../terminal-utils/figures.js'
import { BRAND, ICE } from '../shimmer.js'
import { interpolateColor } from '../Spinner/spinnerUtils.js'
import { isMinimalUiMode } from '../../minimalUiMode.js'
import type { ClickEvent } from '../../ink/events/click-event.js'
import { primaryComboString } from '../../utils/keymap.js'
import { expandTabs } from '../../ink/tabstops.js'

/** Fixed-height live ticker. Wrap at the actual Yoga width, then clip the
 *  oldest display rows; a long paragraph must not leave two unused slots.
 *  The minimum-height inner box keeps genuinely short text top-aligned. */
const PREVIEW_ROWS = 3

type Props = {
  thinking: string
  /** The FULL un-revealed text (reasoning rows under smooth streaming):
   *  `thinking` carries the revealed slice the expanded body paints, while
   *  the live preview ticker must follow the newest ARRIVED content — never
   *  a lagging reveal. Falls back to `thinking`. */
  textFull?: string
  /** Adds the top margin between messages. */
  marginTopOnTurn: boolean
  /** Show the full text (Ctrl+O, per-row expansion, or live click toggle). */
  verbose: boolean
  /** True while the reasoning block is still streaming — the leading anchor
   *  becomes a rotating braille spinner (Kimi Code style) and settles back
   *  to the anchor once the step ends. */
  streaming?: boolean
  /** Streaming compact mode (thinkingFold=preview): a 3-row live ticker of
   *  the model's latest reasoning lines instead of the full block —
   *  kimicode-style constant height; the block never resizes mid-stream. */
  preview?: boolean
  /** Thinking wall-clock duration once the reasoning block settled (ms). */
  durationMs?: number
  /** Estimated thinking tokens when the backend reports thinking only as a
   *  count (no text). Renders a one-line `Thinking · ~N tokens` header while
   *  streaming and `Thought · ~N tokens` once settled; text, when present,
   *  still wins. */
  reasoningTokens?: number
  /** Message-selection mode highlight. */
  isSelected?: boolean
  onClick?(event: ClickEvent): void
}

/**
 * Thinking block: settled rows fold to `⚓ Thinking` plus the localized
 * ctrl+o expand hint (hint-expand-ctrl-o);
 * streaming rows switch between a three-line preview and the full reasoning
 * text on click. The live leading mark is a rotating braille spinner
 * (`⠋⠙⠹…`, Kimi Code style), settling back to the static anchor (`⚓`). When
 * the channel records the reasoning duration, the label carries it
 * (`⚓ Thinking · 12s …`) — dsh-tui's take on making thinking time visible in
 * the transcript.
 */
export function AssistantThinkingMessage({
  thinking,
  textFull,
  marginTopOnTurn,
  verbose,
  streaming = false,
  preview = false,
  durationMs,
  reasoningTokens,
  isSelected = false,
  onClick,
}: Props): React.ReactNode {
  if (!thinking) {
    if (reasoningTokens === undefined) return null
    return (
      <ThinkingTokensHeader
        tokens={reasoningTokens}
        streaming={streaming}
        marginTopOnTurn={marginTopOnTurn}
        isSelected={isSelected}
        onClick={onClick}
      />
    )
  }

  // The preview ticker tracks the newest ARRIVED line (smooth streaming must
  // not lag it behind the reveal); the expanded body below paints `thinking`
  // — the revealed slice under smooth streaming, the full text otherwise.
  const tickerText = textFull ?? thinking

  // Spinner frame (80ms cadence, only while the reasoning is still
  // streaming — same pattern as BtwPanel's answering spinner).
  const [frame, setFrame] = React.useState(0)
  React.useEffect(() => {
    if (!streaming) return
    const interval = setInterval(() => setFrame(f => f + 1), THINKING_SPINNER_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [streaming])

  const duration =
    durationMs !== undefined && durationMs >= 1000
      ? ` · ${formatDuration(durationMs)}`
      : ''

  // Kimi Code style blue pulse: the streaming glyph breathes along the
  // header's brand→ice ladder, one sine period per ~7 frames (≈0.56s) —
  // lively without strobing. The minimal UI drops the color (plain glyph);
  // settled always keeps the plain dim anchor.
  const label = `${t('thinking-label')}${duration}${streaming ? '…' : ` ${t('hint-expand-ctrl-o', { key: primaryComboString('transcript') })}`}`
  const minimalUi = isMinimalUiMode()
  const pulse = (Math.sin(frame * 0.9) + 1) / 2
  const pulseColor = interpolateColor(BRAND, ICE, pulse)
  const frameText = THINKING_SPINNER_FRAMES[frame % THINKING_SPINNER_FRAMES.length]!
  // Hover 轻指示：可点击折叠时折叠头从 dim 提亮为正常色（不刷整行背景，
  // 转录视觉保持安静）。
  const [hovered, setHovered] = React.useState(false)
  const hoverProps = onClick !== undefined
    ? { onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false) }
    : {}
  const header =
    streaming ? (
      <Box flexDirection="row">
        <Text>{minimalUi ? frameText : chalk.rgb(pulseColor.r, pulseColor.g, pulseColor.b).bold(frameText)}</Text>
        {/* 流式行同样可点击折叠（hover 提亮标签给出指示，与落定态一致） */}
        <Text dimColor={!hovered} color={hovered ? 'text' : undefined} italic>{` ${label}`}</Text>
      </Box>
    ) : (
      <Text italic dimColor={!hovered} color={hovered ? 'text' : undefined}>{`${minimalUi ? '*' : THINKING_SETTLED_MARKER} ${label}`}</Text>
    )

  if (preview) {
    // Trailing paragraph separators are not new reasoning. At most three
    // source lines can contribute to the final three display rows, so avoid
    // wrapping the entire history. Tabs must paint at their measured width.
    const lines = tickerText.replace(/\r\n?/g, '\n').trimEnd().split('\n')
    const body = expandTabs(lines.slice(-PREVIEW_ROWS).join('\n'))
    return (
      <Box
        flexDirection="column"
        marginTop={marginTopOnTurn ? 1 : 0}
        backgroundColor={isSelected ? 'messageActionsBackground' : undefined}
        onClick={onClick}
        {...hoverProps}
      >
        {header}
        <Box
          flexDirection="row"
          paddingLeft={2}
          height={PREVIEW_ROWS}
          flexShrink={0}
          overflow="hidden"
        >
          <Box flexDirection="column" width={2} flexShrink={0}>
            {Array.from({ length: PREVIEW_ROWS }, (_, i) => (
              <Text key={i} dimColor italic>{'│ '}</Text>
            ))}
          </Box>
          <Box
            flexDirection="column"
            flexGrow={1}
            minWidth={0}
            height={PREVIEW_ROWS}
            justifyContent="flex-end"
            overflow="hidden"
          >
            {/* Keep natural wrapped height: excess rows clip off the TOP,
                not out of the middle or off the newest end of the stream. */}
            <Box flexDirection="column" flexShrink={0} minHeight={PREVIEW_ROWS}>
              <Text dimColor italic>{body}</Text>
            </Box>
          </Box>
        </Box>
      </Box>
    )
  }

  if (!verbose) {
    return (
      <Box
        marginTop={marginTopOnTurn ? 1 : 0}
        backgroundColor={isSelected ? 'messageActionsBackground' : undefined}
        onClick={onClick}
        {...hoverProps}
      >
        {header}
      </Box>
    )
  }

  return (
    <Box
      flexDirection="column"
      gap={1}
      marginTop={marginTopOnTurn ? 1 : 0}
      width="100%"
      backgroundColor={isSelected ? 'messageActionsBackground' : undefined}
      onClick={onClick}
      {...hoverProps}
    >
      {header}
      <Box paddingLeft={2}>
        {/* StreamingMarkdown: the live thinking text grows per token — the
          incremental stable-prefix + tail budget keeps the per-frame layout
          cost at O(new content) instead of re-laying out the whole block. */}
        <StreamingMarkdown dimColor>{thinking}</StreamingMarkdown>
      </Box>
    </Box>
  )
}

/**
 * Count-only thinking: the backend streams an
 * estimated token count but no thinking text. One header line in the same
 * visual language as a text block — the pulsing braille spinner while live,
 * the settled anchor afterwards — with nothing to expand.
 */
function ThinkingTokensHeader({
  tokens,
  streaming,
  marginTopOnTurn,
  isSelected,
  onClick,
}: {
  tokens: number
  streaming: boolean
  marginTopOnTurn: boolean
  isSelected: boolean
  onClick?(event: ClickEvent): void
}): React.ReactNode {
  const [frame, setFrame] = React.useState(0)
  React.useEffect(() => {
    if (!streaming) return
    const interval = setInterval(() => setFrame(f => f + 1), THINKING_SPINNER_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [streaming])
  const minimalUi = isMinimalUiMode()
  const n = formatTokens(tokens)
  const pulse = (Math.sin(frame * 0.9) + 1) / 2
  const pulseColor = interpolateColor(BRAND, ICE, pulse)
  const frameText = THINKING_SPINNER_FRAMES[frame % THINKING_SPINNER_FRAMES.length]!
  return (
    <Box
      flexDirection="row"
      marginTop={marginTopOnTurn ? 1 : 0}
      backgroundColor={isSelected ? 'messageActionsBackground' : undefined}
      onClick={onClick}
    >
      {streaming ? (
        <>
          <Text>{minimalUi ? frameText : chalk.rgb(pulseColor.r, pulseColor.g, pulseColor.b).bold(frameText)}</Text>
          <Text dimColor italic>{` ${t('thinking-tokens-live', { n })}`}</Text>
        </>
      ) : (
        <Text dimColor italic>{`${minimalUi ? '*' : THINKING_SETTLED_MARKER} ${t('thinking-tokens-done', { n })}`}</Text>
      )}
    </Box>
  )
}
