import React from 'react'
import { Box, Text, useAnimationFrame, useTerminalSize, useTheme } from '../ui.js'
import type { OutgoingMessage } from '../adapter/ports/channel-view.js'
import { useTerminalFocus } from '../ink/hooks/use-terminal-focus.js'
import { stringWidth } from '../ink/stringWidth.js'
import { wrapWidth } from '../sessions/format.js'
import { getTheme } from '../theme.js'
import { POINTER } from '../terminal-utils/figures.js'
import { parseRGB } from './Spinner/spinnerUtils.js'
import { sweep } from './shimmer.js'

/** Temporary delivery previews, outside the persisted transcript and its row IDs. */
export function OutgoingMessages({
  messages,
  onRecover,
}: {
  messages: readonly OutgoingMessage[]
  onRecover?(id: string): void
}): React.ReactNode {
  return messages.map(message => (
    <OutgoingPreview key={message.id} message={message} onRecover={onRecover} />
  ))
}

function OutgoingPreview({
  message,
  onRecover,
}: {
  message: OutgoingMessage
  onRecover?: (id: string) => void
}): React.ReactNode {
  const { columns } = useTerminalSize()
  const [themeName] = useTheme()
  const theme = getTheme(themeName)
  const focused = useTerminalFocus()
  const animated = message.phase === 'sending' || message.phase === 'queued'
  const [ref, time] = useAnimationFrame(animated && focused ? 120 : null)
  const base = parseRGB(theme.inactive)
  const highlight = parseRGB(theme.inactiveShimmer)
  const prefix = `${POINTER} `
  const prefixWidth = stringWidth(prefix)
  // Match the persisted user prompt's hanging indent and safety margin. Only
  // colors change between frames: the wrapped lines and prefix stay fixed.
  const lines = React.useMemo(
    () => wrapWidth(message.text, Math.max(1, columns - prefixWidth - 3)),
    [message.text, columns, prefixWidth],
  )
  const failed = message.phase === 'failed'

  return (
    <Box
      ref={ref}
      flexDirection="column"
      marginTop={1}
      paddingRight={1}
      onClick={failed && onRecover !== undefined ? () => onRecover(message.id) : undefined}
    >
      {lines.map((line, index) => (
        <Text key={index} color={failed ? 'error' : 'inactive'} bold wrap="truncate-end">
          {index === 0 ? prefix : ' '.repeat(prefixWidth)}
          {animated && base !== null && highlight !== null
            ? sweep(line, time, base, highlight, 120)
            : line}
        </Text>
      ))}
    </Box>
  )
}
