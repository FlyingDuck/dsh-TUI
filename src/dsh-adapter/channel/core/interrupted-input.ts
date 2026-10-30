/** Recorded inputs are not failed deliveries. Keep only their editable capsule. */
import type { AgentSession, CancelOutcome } from '../../../agent/session.js'
import type { TurnEndReason } from '../../../agent/events.js'
import type { ComposerSubmission, InterruptedInput } from '../../../adapter/ports/channel-view.js'

export interface InterruptedInputTarget {
  readonly id: string
  readonly rowId: number
  readonly turn: number
}

type Capsule = ComposerSubmission & { readonly session: AgentSession; readonly generation: number }
type OutputPosition = { readonly turn: number; readonly step: number }
type Intent = InterruptedInputTarget & {
  readonly capsule: Capsule
  confirmed: boolean
  terminal: boolean
  witness?: { readonly minimumStep: number; readonly attempts: Set<string> }
}

export function createInterruptedInput(deps: {
  state(): { interruptedInput?: InterruptedInput; emit(): void }
  current(session: AgentSession, generation: number): boolean
  hasImage(stageId: string): boolean
}) {
  const capsules = new Map<string, Capsule>()
  const pins = new Map<string, number>()
  let intent: Intent | undefined
  let ready: Intent | undefined

  const drop = (id: string): void => {
    const capsule = capsules.get(id)
    if (intent?.id === id) intent = undefined
    if (ready?.id === id) {
      ready = undefined
      deps.state().interruptedInput = undefined
    }
    if (capsule === undefined) return
    capsules.delete(id)
    for (const image of capsule.images ?? []) {
      const count = (pins.get(image.stageId) ?? 1) - 1
      if (count > 0) pins.set(image.stageId, count)
      else pins.delete(image.stageId)
    }
    // Release only this capsule's pins. A history recall, undo or newer draft
    // can own the same capability; the composer FIFO and session reset retain
    // their existing authority to evict/revoke it.
  }
  const revoke = (id: string): void => {
    const published = ready?.id === id
    drop(id)
    if (published) deps.state().emit()
  }
  const target = (): Intent | undefined => {
    const pending = intent ?? ready
    return pending !== undefined && deps.current(pending.capsule.session, pending.capsule.generation) ? pending : undefined
  }
  const publish = (pending: Intent): void => {
    if (intent !== pending || !pending.confirmed || !pending.terminal) return
    if (!deps.current(pending.capsule.session, pending.capsule.generation)) { drop(pending.id); return }
    intent = undefined
    ready = pending
    const { text, images } = pending.capsule
    deps.state().interruptedInput = { id: pending.id, rowId: pending.rowId, text, images }
    deps.state().emit()
  }

  return {
    retain(id: string, capsule: Capsule): void {
      if (capsules.has(id) || !deps.current(capsule.session, capsule.generation)) return
      capsules.set(id, capsule)
      // Pin only live capabilities, so this map is bounded by the composer's
      // own staging limit even if a programmatic caller supplied stale refs.
      for (const image of capsule.images ?? []) {
        if (deps.hasImage(image.stageId)) pins.set(image.stageId, (pins.get(image.stageId) ?? 0) + 1)
      }
      // Separate from submission admission: an old capsule may be evicted,
      // but a recorded message can never turn back into an outgoing failure.
      while (capsules.size > 64) drop(capsules.keys().next().value!)
    },
    has(id: string): boolean {
      const capsule = capsules.get(id)
      return capsule !== undefined && deps.current(capsule.session, capsule.generation)
    },
    isRetained(stageId: string): boolean { return pins.has(stageId) },
    /** Called BEFORE cancel. The returned callback belongs to this exact request. */
    begin(target: InterruptedInputTarget | undefined): (outcome: CancelOutcome) => void {
      if (intent !== undefined) {
        if (intent.id === target?.id) intent = undefined
        else drop(intent.id)
      }
      const capsule = target === undefined ? undefined : capsules.get(target.id)
      if (target === undefined || capsule === undefined || !deps.current(capsule.session, capsule.generation)) return () => undefined
      if (ready !== undefined) drop(ready.id)
      const pending: Intent = { ...target, capsule, confirmed: false, terminal: false }
      intent = pending
      let settled = false
      return outcome => {
        if (settled) return
        settled = true
        if (intent !== pending) return
        if (outcome !== 'confirmed' || !deps.current(capsule.session, capsule.generation)) { drop(pending.id); return }
        pending.confirmed = true
        publish(pending)
      }
    },
    /** The response tracker alone supplies this target's causal witnesses. */
    target: (): InterruptedInputTarget | undefined => target(),
    watchClosedTurn(id: string, minimumStep: number, attemptIds: readonly string[]): void {
      const pending = target()
      if (pending?.id !== id || pending.witness !== undefined) return
      if (attemptIds.length > 64) { revoke(id); return }
      pending.witness = { minimumStep, attempts: new Set(attemptIds) }
    },
    lateAttempt(attemptId: string, position: OutputPosition): void {
      const pending = target()
      const witness = pending?.witness
      if (pending === undefined || witness === undefined || position.turn !== pending.turn || position.step < witness.minimumStep) return
      witness.attempts.add(attemptId)
      if (witness.attempts.size > 64) revoke(pending.id)
    },
    lateOutput(position: OutputPosition | undefined, attemptId?: string): void {
      const pending = target()
      const witness = pending?.witness
      if (pending === undefined || witness === undefined) return
      const matches = position === undefined
        ? attemptId !== undefined && witness.attempts.has(attemptId)
        : position.turn === pending.turn && position.step >= witness.minimumStep
      // An unmatched orphan is not attributed to this input, but it can no
      // longer prove zero output either. Revoke only recovery permission;
      // known older positions remain excluded, and presentation is untouched.
      if (matches || position === undefined) revoke(pending.id)
    },
    /** Output always wins, including output racing the cancellation receipt. */
    firstOutput(id: string): void { revoke(id) },
    turnEnded(turn: number, reason: TurnEndReason, unanswered: readonly string[]): void {
      const cancelled = reason.kind === 'aborted' || reason.kind === 'interrupted'
      if (ready?.turn === turn && !cancelled) drop(ready.id)
      const pending = intent
      if (pending?.turn !== turn) return
      if (!cancelled) { drop(pending.id); return }
      if (pending.terminal) return
      if (!unanswered.includes(pending.id)) { drop(pending.id); return }
      pending.terminal = true
      publish(pending)
    },
    stopped(id: string): void {
      // Only a proven terminal may outlive its receipt. Idle/implicit closure
      // alone is not proof, so it revokes rather than preparing a draft.
      if ((intent?.id === id && intent.terminal) || ready?.id === id) return
      drop(id)
    },
    invalidate(): void {
      if (intent !== undefined) drop(intent.id)
      if (ready !== undefined) drop(ready.id)
    },
    recover(id: string): ComposerSubmission | undefined {
      const candidate = ready
      if (candidate?.id !== id || !deps.current(candidate.capsule.session, candidate.capsule.generation)) return undefined
      const { text, images } = candidate.capsule
      drop(id)
      deps.state().emit()
      return { text, images }
    },
    reset(): void {
      for (const id of capsules.keys()) drop(id)
      pins.clear()
      intent = undefined
      ready = undefined
      deps.state().interruptedInput = undefined
    },
  }
}

export type InterruptedInputRecovery = ReturnType<typeof createInterruptedInput>
