import React from 'react'
import { Box, Text } from '../../ui.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { t, type I18nKey } from '../../i18n.js'

type Props = {
  /** The sending peer's name. */
  sender: string
  text: string
  /** Adds the top margin between turns. */
  marginTopOnTurn: boolean
  /** Message-selection mode highlight. */
  isSelected?: boolean
  /** The caption after the sender; defaults to the Agent Teams one (a plugin
   *  relay passes its own, see `PEER_MESSAGE_LABELS`). */
  captionKey?: I18nKey
}

const MARK = '✉ '

/**
 * A peer message delivered to this session — an Agent Teams teammate's, or a
 * plugin's opted-in relay (an inbound dsh-intercom message): a `✉ <sender>`
 * line in the agent tint, then the body in plain text with a hanging indent —
 * it reads apart from the human's bold `❯` prompt it shares a log role with.
 * The body wraps in its own flex column, so it fits whatever column hosts it
 * (the main list, a child scene's padded page, a split with the workbench).
 */
export function TeamMessageBubble({ sender, text, marginTopOnTurn, isSelected = false, captionKey = 'team-message-label' }: Props): React.ReactNode {
  return (
    <Box
      flexDirection="column"
      marginTop={marginTopOnTurn ? 1 : 0}
      backgroundColor={isSelected ? 'messageActionsBackground' : undefined}
      paddingRight={1}
    >
      <Text color="toolDotTask" wrap="truncate-end">
        {MARK}<Text bold>{sender}</Text><Text dimColor>{` · ${t(captionKey)}`}</Text>
      </Text>
      <Box flexDirection="row">
        <Box width={stringWidth(MARK)} flexShrink={0} />
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="wrap">{text}</Text>
        </Box>
      </Box>
    </Box>
  )
}
