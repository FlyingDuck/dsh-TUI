import React from 'react'
import { Box, Text } from '../../ui.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { t, type I18nKey } from '../../i18n.js'
import { primaryComboString } from '../../utils/keymap.js'
import type { ClickEvent } from '../../ink/events/click-event.js'
import { relayBodyView } from './relayBodyLines.js'

type Props = {
  /** The sending peer's name. */
  sender: string
  text: string
  /** Adds the top margin between turns. */
  marginTopOnTurn: boolean
  /** Message-selection mode highlight. */
  isSelected?: boolean
  /** The caption after the sender; absent for a plugin relay, whose head
   *  (`lead`) already names the plugin and the action. */
  captionKey?: I18nKey
  /** The sanitized head before the sender for a plugin relay, composed by the
   *  projector (`intercom · receive ← `); empty for a team message. */
  lead?: string
  /** Full body (Ctrl+O, or this row expanded on its own); a long body folds to
   *  a three-line preview with the shared expand hint otherwise. */
  verbose?: boolean
  /** Toggles this row's expansion. Attached to the hint line only: a plain text
   *  row stays a reading area (see `relayBodyLines`). */
  onClick?: (event: ClickEvent) => void
}

const MARK = '✉ '

/**
 * A peer message delivered to this session — an Agent Teams teammate's, or a
 * plugin's opted-in relay (an inbound dsh-intercom message): a `✉ <sender>`
 * line in the agent tint, then the body in plain text with a hanging indent —
 * it reads apart from the human's bold `❯` prompt it shares a log role with.
 * The body wraps in its own flex column, so it fits whatever column hosts it
 * (the main list, a child scene's padded page, a split with the workbench), and
 * a long one folds like a collapsed tool card rather than flooding the screen.
 */
export function TeamMessageBubble({ sender, text, marginTopOnTurn, isSelected = false, lead = '', captionKey, verbose = false, onClick }: Props): React.ReactNode {
  const body = relayBodyView(text, verbose)
  return (
    <Box
      flexDirection="column"
      marginTop={marginTopOnTurn ? 1 : 0}
      backgroundColor={isSelected ? 'messageActionsBackground' : undefined}
      paddingRight={1}
    >
      <Text color="toolDotTask" wrap="truncate-end">
        {MARK}{lead === '' ? null : <Text dimColor>{lead}</Text>}<Text bold>{sender}</Text>{captionKey === undefined ? null : <Text dimColor>{` · ${t(captionKey)}`}</Text>}
      </Text>
      <Box flexDirection="row">
        <Box width={stringWidth(MARK)} flexShrink={0} />
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="wrap">{body.lines.join('\n')}</Text>
        </Box>
      </Box>
      {body.hiddenLines > 0 && (
        <Box flexDirection="row" onClick={onClick}>
          <Box width={stringWidth(MARK)} flexShrink={0} />
          <Box flexGrow={1} flexShrink={1}>
            <Text dimColor>{t('lines-folded-expand', { n: body.hiddenLines, key: primaryComboString('transcript') })}</Text>
          </Box>
        </Box>
      )}
    </Box>
  )
}
