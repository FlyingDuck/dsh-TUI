/** Live response presentation, deliberately separate from durable rows and input receipts. */
import type { ChatRow, UserMessageResponseState } from '../../../adapter/ports/channel-view.js'
import type { AgentEvent, AgentEventMeta, AgentEventOf, TurnEndReason } from '../../../agent/events.js'
import type { InterruptedInputTarget } from './interrupted-input.js'

type Position = { readonly turn: number; readonly step: number }
type Claim = { readonly after: number; readonly minimumSteps: ReadonlyMap<number, number> }
type Response = {
  readonly id: string
  readonly after: number
  readonly claim?: Claim
  turn: number | undefined
  minimumStep: number
  phase: UserMessageResponseState['phase'] | 'responded'
  receipt?: { readonly seq: number; readonly anchor: string }
  rowId?: number
}
type Attempt = {
  readonly firstSeen: number
  position?: Position
  signal?: number
  confirmed: boolean
  ended: boolean
  child: boolean
}
type ModelTurn = { highestStep: number; readonly steps: Map<number, number> }

function hasMessageContent(event: AgentEventOf<'assistant.message'>): boolean {
  return (event.images?.length ?? 0) > 0 || event.blocks.some(block => block.type === 'tool-call'
    || ((block.type === 'text' || block.type === 'reasoning') && (block.text?.length ?? 0) > 0))
}

function hasDeltaContent(delta: AgentEventOf<'assistant.delta'>['delta']): boolean {
  switch (delta.kind) {
    case 'text':
    case 'reasoning':
      return delta.text.length > 0
    case 'reasoning-tokens':
      return delta.estimated > 0
    case 'tool-args':
      return delta.partialJson.length > 0 || (delta.name?.length ?? 0) > 0
    case 'other':
      return false
  }
}

/**
 * Inputs only become visible here after the shared projector paints their
 * real seq/anchor. Turn links can arrive before that receipt (Claude's echo
 * fallback), so the causal ledger starts at turn.start, not at row creation.
 *
 * DSH writes user.message inside an explicit step, before opening its attempt.
 * Claude/Codex also name the turn; an input recorded after a model step began
 * must wait for a later step, never for another token of the old response.
 * Unpositioned deltas are resolved ONLY by their own attempt.start, not by
 * adopting whatever step happens to be open when the delta arrives.
 */
export function createUserMessageResponses(state: {
  readonly rows: readonly ChatRow[]
  userMessageResponses: readonly UserMessageResponseState[]
  /** Only for retiring closed, receipt-less links; never written here. */
  readonly outgoing?: readonly { readonly id: string }[]
}, recovery?: {
  firstOutput(id: string): void
  stopped(id: string): void
  turnEnded(turn: number, reason: TurnEndReason, unanswered: readonly string[]): void
  target?(): InterruptedInputTarget | undefined
  watchClosedTurn?(id: string, minimumStep: number, attemptIds: readonly string[]): void
  lateAttempt?(attemptId: string, position: Position): void
  lateOutput?(position: Position | undefined, attemptId?: string): void
}) {
  const responses = new Map<string, Response>()
  const waiting = new Set<Response>()
  const claims = new Map<string, Claim>()
  const attempts = new Map<string, Attempt>()
  const turns = new Map<number, ModelTurn>()
  const unmapped = new Set<Response>()
  let clock = 0
  let openTurn: number | undefined
  let openStep: Position | undefined
  let closedThrough = -1
  let displayDirty = false

  const minimumStep = (turn: number | undefined): number => turn === undefined ? 0
    : Math.max((turns.get(turn)?.highestStep ?? -1) + 1, openStep?.turn === turn ? openStep.step : 0)

  const claimedMinimumStep = (claim: Claim | undefined, turn: number | undefined): number =>
    claim === undefined ? minimumStep(turn) : turn === undefined ? 0 : claim.minimumSteps.get(turn) ?? 0

  const catchUp = (response: Response): void => {
    if (response.claim === undefined || response.turn === undefined || response.phase !== 'waiting') return
    // Only the late receipt/turn link scans retained attempts, never each token.
    for (const attempt of attempts.values()) {
      const position = attempt.position
      if (attempt.child || attempt.signal === undefined || position?.turn !== response.turn) continue
      const firstSeen = turns.get(position.turn)?.steps.get(position.step) ?? attempt.firstSeen
      if (position.step < response.minimumStep || firstSeen <= response.after) continue
      response.phase = 'responded'
      recovery?.firstOutput(response.id)
      waiting.delete(response)
      displayDirty = true
      break
    }
  }

  const remember = (id: string, turn: number | undefined): Response => {
    let response = responses.get(id)
    if (response === undefined) {
      const claim = claims.get(id)
      response = { id, after: claim?.after ?? clock, ...(claim === undefined ? {} : { claim }), turn, minimumStep: claimedMinimumStep(claim, turn), phase: turn !== undefined && turn <= closedThrough ? 'stopped' : 'waiting' }
      responses.set(id, response)
      if (response.phase === 'waiting') waiting.add(response)
    } else if (response.turn === undefined && turn !== undefined) {
      response.turn = turn
      response.minimumStep = claimedMinimumStep(response.claim, turn)
      if (turn <= closedThrough && response.phase === 'waiting') {
        response.phase = 'stopped'
        recovery?.stopped(response.id)
        waiting.delete(response)
        displayDirty = true
      }
    }
    catchUp(response)
    return response
  }

  const notePosition = (position: Position, firstSeen = clock): number => {
    let turn = turns.get(position.turn)
    if (turn === undefined) {
      turn = { highestStep: position.step, steps: new Map() }
      turns.set(position.turn, turn)
    }
    turn.highestStep = Math.max(turn.highestStep, position.step)
    const first = Math.min(turn.steps.get(position.step) ?? firstSeen, firstSeen)
    turn.steps.set(position.step, first)
    return first
  }

  const confirm = (position: Position, firstSeen: number): void => {
    if (position.turn <= closedThrough) return
    for (const response of waiting) {
      if (response.turn !== position.turn) continue
      if (position.step < response.minimumStep || firstSeen <= response.after) continue
      response.phase = 'responded'
      recovery?.firstOutput(response.id)
      waiting.delete(response)
      displayDirty = true
    }
  }

  const retirePositions = (): void => {
    for (const turn of turns.keys()) if (turn <= closedThrough) turns.delete(turn)
    for (const [id, attempt] of attempts) {
      if (attempt.child || attempt.ended || (attempt.position !== undefined && attempt.position.turn <= closedThrough)) attempts.delete(id)
    }
  }

  // A main stream with content but no causal position cannot prove silence.
  // Check only at stop/cancel boundaries, never once per token or historical row.
  const provablyUnanswered = (response: Response): boolean => {
    for (const attempt of attempts.values()) {
      if (!attempt.child && attempt.signal !== undefined && attempt.position === undefined && attempt.signal > response.after) return false
    }
    return true
  }

  const closeTurn = (turn: number, reason?: TurnEndReason): void => {
    const target = recovery?.target?.()
    const response = target?.turn === turn ? responses.get(target.id) : undefined
    if (reason !== undefined && response?.phase === 'waiting' && provablyUnanswered(response)) {
      // Retain only the current recovery's known main attempts, not the old
      // turn's whole stream ledger. Late buffered frames can outlive turn.end.
      const ids: string[] = []
      for (const [id, attempt] of attempts) {
        const position = attempt.position
        if (attempt.child || position?.turn !== turn || position.step < response.minimumStep) continue
        const first = turns.get(turn)?.steps.get(position.step) ?? attempt.firstSeen
        if (first <= response.after) continue
        ids.push(id)
        if (ids.length > 64) break
      }
      recovery?.watchClosedTurn?.(response.id, response.minimumStep, ids)
    }
    if (reason !== undefined) recovery?.turnEnded(turn, reason, [...waiting]
      .filter(response => response.turn === turn && provablyUnanswered(response)).map(response => response.id))
    closedThrough = Math.max(closedThrough, turn)
    for (const response of waiting) {
      if (response.turn !== undefined && response.turn <= closedThrough) {
        response.phase = 'stopped'
        recovery?.stopped(response.id)
        waiting.delete(response)
        displayDirty = true
      }
    }
    if (openTurn === turn) openTurn = undefined
    if (openStep?.turn === turn) openStep = undefined
    retirePositions()
    displayDirty = true
  }

  const stopWaiting = (): void => {
    for (const response of waiting) {
      response.phase = 'stopped'
      recovery?.stopped(response.id)
      if (response.turn !== undefined) closedThrough = Math.max(closedThrough, response.turn)
    }
    waiting.clear()
    if (openTurn !== undefined) closedThrough = Math.max(closedThrough, openTurn)
    if (openStep !== undefined) closedThrough = Math.max(closedThrough, openStep.turn)
    openTurn = undefined
    openStep = undefined
    // Idle/disposal retires every stream, including orphan deltas with no start.
    attempts.clear()
    turns.clear()
    displayDirty = true
  }

  const observeClosedOutput = (event: AgentEvent): void => {
    const target = recovery?.target?.()
    if (target === undefined || target.turn > closedThrough) return
    switch (event.type) {
      case 'assistant.attempt.start': {
        if (event.parentCallId !== undefined || attempts.get(event.attemptId)?.child === true) return
        const position = { turn: event.turn, step: event.step }
        recovery?.lateAttempt?.(event.attemptId, position)
        // Its own late start can now position a buffered orphan signal; no
        // other open/current step is ever used to guess this association.
        if (attempts.get(event.attemptId)?.signal !== undefined) recovery?.lateOutput?.(position, event.attemptId)
        return
      }
      case 'assistant.delta':
      case 'assistant.message': {
        const attempt = attempts.get(event.attemptId)
        if (event.parentCallId !== undefined || attempt?.child === true) return
        if (event.turn !== undefined && event.turn !== target.turn) return
        if (!(event.type === 'assistant.delta' ? hasDeltaContent(event.delta) : hasMessageContent(event))) return
        const position = event.turn !== undefined && event.step !== undefined ? { turn: event.turn, step: event.step } : attempt?.position
        recovery?.lateOutput?.(position, event.attemptId)
        return
      }
      case 'tool.call':
        if (event.parentCallId === undefined && event.agentId === undefined) recovery?.lateOutput?.({ turn: event.turn, step: event.step })
        return
      default:
        return
    }
  }

  const applyEvent = (event: AgentEvent): void => {
    clock += 1
    // This is recovery-only evidence. The closed-turn presentation and durable
    // projection keep their existing late-event policy unchanged.
    observeClosedOutput(event)
    switch (event.type) {
      case 'turn.start':
        if (event.turn <= closedThrough) return
        if (openTurn !== undefined && openTurn !== event.turn) closeTurn(openTurn)
        openTurn = event.turn
        if (event.origin === 'user' && event.userMessageId !== undefined) remember(event.userMessageId, event.turn)
        return
      case 'step.start':
        if (event.turn > closedThrough) openStep = { turn: event.turn, step: event.step }
        return
      case 'step.end':
        if (openStep?.turn === event.turn && openStep.step === event.step) openStep = undefined
        return
      case 'pending.changed': {
        for (const id of event.claimed ?? []) {
          if (claims.has(id) || responses.has(id)) continue
          // These are exclusion floors, not a claim-to-turn association. A
          // followup may be claimed before its own turn.start is delivered.
          const minimumSteps = new Map<number, number>()
          for (const [turn, model] of turns) minimumSteps.set(turn, model.highestStep + 1)
          if (openStep !== undefined) minimumSteps.set(openStep.turn, Math.max(minimumSteps.get(openStep.turn) ?? 0, openStep.step))
          claims.set(id, { after: clock, minimumSteps })
        }
        for (const id of event.discarded ?? []) claims.delete(id)
        return
      }
      case 'user.message': {
        if (event.source !== 'user') {
          claims.delete(event.id)
          const linked = responses.get(event.id)
          if (linked !== undefined && linked.receipt === undefined) {
            waiting.delete(linked)
            responses.delete(event.id)
          }
          return
        }
        const response = remember(event.id, event.turn ?? openStep?.turn)
        // Confirmation may have retained a capsule just before this late
        // durable receipt catches up with output/termination already observed.
        if (response.phase === 'responded') recovery?.firstOutput(event.id)
        else if (response.phase === 'stopped') recovery?.stopped(event.id)
        claims.delete(event.id)
        response.receipt = { seq: event.seq, anchor: event.anchor === '' ? String(event.seq) : event.anchor }
        if (response.rowId === undefined) unmapped.add(response)
        displayDirty = true
        return
      }
      case 'assistant.attempt.start': {
        if (event.turn <= closedThrough) { attempts.delete(event.attemptId); return }
        const existing = attempts.get(event.attemptId)
        const attempt: Attempt = existing ?? { firstSeen: clock, confirmed: false, ended: false, child: false }
        attempt.child ||= event.parentCallId !== undefined
        attempts.set(event.attemptId, attempt)
        if (attempt.child || attempt.ended) return
        if (attempt.position !== undefined && (attempt.position.turn !== event.turn || attempt.position.step !== event.step)) return
        attempt.position = { turn: event.turn, step: event.step }
        const first = notePosition(attempt.position, attempt.firstSeen)
        if (attempt.signal !== undefined && !attempt.confirmed) {
          confirm(attempt.position, first)
          attempt.confirmed = true
        }
        return
      }
      case 'assistant.delta': {
        const existing = attempts.get(event.attemptId)
        const attempt: Attempt = existing ?? { firstSeen: clock, confirmed: false, ended: false, child: false }
        attempt.child ||= event.parentCallId !== undefined
        attempts.set(event.attemptId, attempt)
        if (attempt.child || attempt.ended || attempt.confirmed) return
        // Legacy durable chunks carry their position even without a start.
        if (event.turn !== undefined && event.step !== undefined) {
          if (attempt.position !== undefined && (attempt.position.turn !== event.turn || attempt.position.step !== event.step)) return
          attempt.position = { turn: event.turn, step: event.step }
        }
        if (attempt.position !== undefined && attempt.position.turn <= closedThrough) { attempts.delete(event.attemptId); return }
        const first = attempt.position === undefined ? undefined : notePosition(attempt.position, attempt.firstSeen)
        if (hasDeltaContent(event.delta)) attempt.signal ??= clock
        if (attempt.signal !== undefined && attempt.position !== undefined && first !== undefined) {
          confirm(attempt.position, first)
          attempt.confirmed = true
        }
        return
      }
      case 'assistant.attempt.end': {
        const position = event.turn !== undefined && event.step !== undefined ? { turn: event.turn, step: event.step } : undefined
        if (position !== undefined && position.turn <= closedThrough) { attempts.delete(event.attemptId); return }
        const attempt = attempts.get(event.attemptId)
        if (attempt !== undefined) attempt.ended = true
        else attempts.set(event.attemptId, { firstSeen: clock, confirmed: false, ended: true, child: false, ...(position === undefined ? {} : { position }) })
        return
      }
      case 'assistant.message': {
        const attempt = attempts.get(event.attemptId)
        if (event.parentCallId !== undefined || attempt?.child === true) return
        const position = event.turn !== undefined && event.step !== undefined
          ? { turn: event.turn, step: event.step } : attempt?.position
        const content = hasMessageContent(event)
        if (position === undefined) {
          if (content) {
            const unresolved: Attempt = attempt ?? { firstSeen: clock, confirmed: false, ended: false, child: false }
            unresolved.signal ??= clock
            attempts.set(event.attemptId, unresolved)
          }
          return
        }
        if (position.turn <= closedThrough) return
        const first = notePosition(position, attempt?.firstSeen)
        if (content) {
          const settled: Attempt = attempt ?? { firstSeen: first, position, confirmed: true, ended: true, child: false }
          settled.position ??= position
          settled.signal ??= clock
          settled.confirmed = true
          attempts.set(event.attemptId, settled)
          confirm(position, first)
        }
        return
      }
      case 'tool.call': {
        if (event.parentCallId !== undefined || event.agentId !== undefined || event.turn <= closedThrough) return
        const position = { turn: event.turn, step: event.step }
        // A main call is also first-output evidence for its actual open attempt.
        for (const attempt of attempts.values()) {
          if (!attempt.child && attempt.position?.turn === event.turn && attempt.position.step === event.step) attempt.signal ??= clock
        }
        confirm(position, notePosition(position))
        return
      }
      case 'turn.end':
        closeTurn(event.turn, event.reason)
        return
      case 'session.status':
        if (event.status === 'idle' || event.status === 'disposed') stopWaiting()
        if (event.status === 'disposed') claims.clear()
        return
      default:
        return
    }
  }

  /** Publish only real human rows, never ids guessed from text or row order. */
  const publish = (): boolean => {
    if (!displayDirty) return false
    displayDirty = false
    if (unmapped.size > 0) {
      const bySeq = new Map<number, ChatRow>()
      for (const row of state.rows) {
        if (row.kind === 'user' && row.label === undefined && row.seq !== undefined) bySeq.set(row.seq, row)
      }
      for (const response of unmapped) {
        const receipt = response.receipt
        const row = receipt === undefined ? undefined : bySeq.get(receipt.seq)
        // The projector has already handled this receipt. A non-rendered
        // input must not be matched to an unrelated row in a later batch.
        unmapped.delete(response)
        if (row !== undefined && (row.anchor ?? String(row.seq)) === receipt?.anchor) response.rowId = row.id
      }
    }
    const next: UserMessageResponseState[] = []
    const expected = state.outgoing === undefined ? undefined : new Set(state.outgoing.map(item => item.id))
    if (expected !== undefined) for (const id of claims.keys()) if (!expected.has(id)) claims.delete(id)
    let liveRowIds: Set<number> | undefined
    for (const [id, response] of responses) {
      // A command may have opened a user-origin turn without a human row.
      // Keep a closed link only while its own delayed receipt is still owed.
      if (response.receipt === undefined && response.turn !== undefined && response.turn <= closedThrough && expected !== undefined && !expected.has(id)) {
        waiting.delete(response)
        responses.delete(id)
        continue
      }
      if (response.phase === 'responded' && response.receipt !== undefined) {
        responses.delete(id)
        continue
      }
      if (response.phase === 'stopped') {
        if (response.rowId !== undefined) liveRowIds ??= new Set(state.rows.map(row => row.id))
        if ((response.rowId !== undefined && !liveRowIds?.has(response.rowId)) || (response.rowId === undefined && response.receipt !== undefined)) {
          responses.delete(id)
          continue
        }
      }
      if (response.rowId !== undefined && response.phase !== 'responded') next.push({ rowId: response.rowId, messageId: id, phase: response.phase })
    }
    const previous = state.userMessageResponses ?? []
    if (next.length === previous.length && next.every((item, index) => item.rowId === previous[index]?.rowId && item.messageId === previous[index]?.messageId && item.phase === previous[index]?.phase)) return false
    state.userMessageResponses = next
    return true
  }

  return {
    /** Only the tracker can name a live, real row and its causally linked turn. */
    latestWaiting(owned: (id: string) => boolean): InterruptedInputTarget | undefined {
      let latest: Response | undefined
      for (const response of waiting) {
        if (response.phase !== 'waiting' || response.rowId === undefined || response.turn === undefined || response.receipt === undefined || !owned(response.id) || !provablyUnanswered(response)) continue
        if (latest === undefined || response.receipt.seq > latest.receipt!.seq) latest = response
      }
      return latest === undefined ? undefined : { id: latest.id, rowId: latest.rowId!, turn: latest.turn! }
    },
    /** Call after the same segment's durable facts have been projected. */
    apply(events: readonly AgentEvent[], meta: AgentEventMeta): boolean {
      if (meta.replay) return false
      for (const event of events) applyEvent(event)
      return publish()
    },
    /** Terminal-event backstop; this never restores or re-sends an input. */
    stop(): boolean {
      stopWaiting()
      return publish()
    },
    reset(): void {
      responses.clear()
      waiting.clear()
      claims.clear()
      attempts.clear()
      turns.clear()
      unmapped.clear()
      clock = 0
      openTurn = undefined
      openStep = undefined
      closedThrough = -1
      displayDirty = false
      state.userMessageResponses = []
    },
  }
}
