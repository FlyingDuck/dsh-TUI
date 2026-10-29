import React from 'react'
import { Box, Text, useAnimationFrame, useTerminalSize, useTheme } from '../../ui.js'
import type { UserMessageResponseState } from '../../adapter/ports/channel-view.js'
import { useTerminalFocus } from '../../ink/hooks/use-terminal-focus.js'
import { getTheme } from '../../theme.js'
import { parseRGB } from '../Spinner/spinnerUtils.js'
import { sweep } from '../shimmer.js'
import { POINTER } from '../../terminal-utils/figures.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { wrapWidth } from '../../sessions/format.js'
import type { ClickEvent } from '../../ink/events/click-event.js'

type Props = {
  text: string
  /** Adds the top margin between turns. */
  marginTopOnTurn: boolean
  /** Message-selection mode highlight. */
  isSelected?: boolean
  /** Display only; failed is reserved for unaccepted outgoing previews. */
  phase?: UserMessageResponseState['phase'] | 'failed'
  onClick?(event: ClickEvent): void
}

/**
 * User prompt bubble: `❯ text` in bold userPromptLabel tint with no background
 * fill (Kimi Code style: the user turn gets a distinct bold tint — the
 * kernel-rotated brand colour of the active theme — so it reads apart from
 * assistant text; only selection mode paints a highlight).
 */
export function UserPromptMessage({
  text,
  marginTopOnTurn,
  isSelected = false,
  phase,
  onClick,
}: Props): React.ReactNode {
  const { columns } = useTerminalSize()
  const [themeName] = useTheme()
  const theme = getTheme(themeName)
  const focused = useTerminalFocus()
  const waiting = phase === 'waiting'
  // Keep clock updates inside this bubble, never on the transcript list.
  const [ref, time] = useAnimationFrame(waiting && focused ? 120 : null)
  const base = parseRGB(theme.inactive)
  const highlight = parseRGB(theme.inactiveShimmer)
  const color = phase === 'failed' ? 'error' : phase === undefined ? 'userPromptLabel' : 'inactive'
  const promptPrefix = `${POINTER} `
  const prefixWidth = stringWidth(promptPrefix)
  // Wrap here instead of letting Ink wrap the whole Text node. Ink starts an
  // automatic continuation at column zero, while a prompt needs a hanging
  // indent for both explicit newlines and width-based visual lines.
  // Leave a small safety margin for the ScrollBox edge/scrollbar. The Text
  // nodes below are explicitly wrapped, so they must never be wrapped again by
  // Ink; a second wrap would move the continuation back to column zero.
  const lines = React.useMemo(
    () => wrapWidth(text, Math.max(1, columns - prefixWidth - 3)),
    [text, columns, prefixWidth],
  )
  const continuationIndent = ' '.repeat(prefixWidth)
  // No hover tooltip here, deliberately: the message is pre-wrapped so every
  // visual line is already on screen — a float would only repeat visible
  // text, and worse, the card REPLACES the cells it covers, so a drag-copy
  // crossing it yields the tooltip fragment instead of the message.

  return (
    <Box
      ref={ref}
      flexDirection="column"
      marginTop={marginTopOnTurn ? 1 : 0}
      backgroundColor={isSelected ? 'messageActionsBackground' : undefined}
      paddingRight={1}
      onClick={onClick}
    >
      {lines.map((line, index) => (
        <Text key={index} color={color} bold wrap="truncate-end">
          {index === 0 ? promptPrefix : continuationIndent}
          {waiting && base !== null && highlight !== null
            ? sweep(line, time, base, highlight, 120)
            : line}
        </Text>
      ))}
    </Box>
  )
}
