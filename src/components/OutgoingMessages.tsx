import React from 'react'
import type { OutgoingMessage } from '../adapter/ports/channel-view.js'
import { UserPromptMessage } from './messages/UserPromptMessage.js'

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
  const failed = message.phase === 'failed'
  const waiting = message.phase === 'sending' || message.phase === 'queued'

  return (
    <UserPromptMessage
      text={message.text}
      marginTopOnTurn
      phase={failed ? 'failed' : waiting ? 'waiting' : 'stopped'}
      onClick={failed && onRecover !== undefined ? () => onRecover(message.id) : undefined}
    />
  )
}
