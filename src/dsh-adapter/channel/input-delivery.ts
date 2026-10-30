import { createUserMessage, freezeMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { AgentSession } from '../../agent/session.js'
import { t } from '../../i18n.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  firstStaleComposerToken,
  formatMissingReference,
  orderedComposerImages,
  type ComposerImages,
} from './composer-images.js'
import { expandComposerMentions } from './composer-mentions.js'
import { appendAttachedContextBlocks } from './attached-context.js'
import { normalizeInputDecision } from './decisions.js'
import { attachIdeSelection } from './ide-selection.js'
import { mentionAttachments, mentionFs } from './mentions.js'
import type { ChannelHost } from './channel-host.js'
import type { LocalImageStore } from './core/local-images.js'
import type { InterruptedInputRecovery } from './core/interrupted-input.js'
import type { ChannelOwner } from './owner.js'
import { sessionWorkingDirectory } from '../../channel/working-directory.js'
import type { AttachedContext, ChannelSelection, SelectionAttachment } from '../../adapter/ports/channel-view.js'
import type {
  ChannelImageBlock,
  ChannelState,
  ComposerImageRef,
  ComposerSubmission,
  OutgoingMessage,
  MentionAttachments,
  MentionFs,
  PendingMessage,
  StagedImageInput,
} from './types.js'

/** One submission's enqueue-time world: the session it was typed in, the
 *  services that resolve its references, and the capabilities live then. */
export interface UserTextOrigin {
  readonly session: AgentSession
  readonly agentId: string
  readonly generation: number
  readonly cwd: string
  /** Where `@` mentions resolve: the session's current directory, the same
   *  one the model-facing fs tools use (the project stays `cwd`). */
  readonly workingDirectory: string
  readonly fs: MentionFs | undefined
  readonly attachments: MentionAttachments | undefined
  /** The in-memory image store when the session takes images itself: the
   *  staged references resolve to its facades for `submit`. */
  readonly localImages?: LocalImageStore
  readonly stagedImages: ReadonlyMap<string, ChannelImageBlock['attachment']>
  /** Live editor selection AT ENQUEUE (undefined = none). Captured here so a
   *  selection made while the FIFO or mention expansion parks the delivery
   *  can never attach to this message. */
  readonly selection: ChannelSelection | undefined
  /** "Send to Chat" contexts AT ENQUEUE, already taken off the channel (see
   *  `consumeAttachedContexts`): the same one-shot rule as the selection, and
   *  the reason a chip can never ride along with a second submission. */
  readonly attachedContexts: readonly AttachedContext[]
}

/** Input FIFO, staged attachments and decision notice timers share one lifetime. */
export function createInputDelivery(
 ctx: ChannelHost, owner: ChannelOwner, binding: { readonly session: AgentSession },
 state: () => Pick<ChannelState, 'cwd' | 'workingDirectory' | 'agentId' | 'agentBindingGeneration' | 'working'>,
 notify: ChannelState['notify'],
 trackPending: (message: { id: string; text: string; images?: readonly ComposerImageRef[] }, placement: PendingMessage['placement']) => void,
 untrackPending: (id: string) => void,
 composer: ComposerImages,
 selection: () => ChannelSelection | undefined,
 rememberSelection: (messageId: string, info: SelectionAttachment) => void,
 /** The fs surface to use when the host mounts no `fs` service (a non-DSH
  *  composition reads the local disk); absent = no fallback. */
 fallbackFs?: () => MentionFs | undefined,
 /** The in-memory image store of a session that takes images itself (the
  *  `images` capability); absent / undefined = the DSH attachments service. */
 localImages?: () => LocalImageStore | undefined,
 /**
  * Take-and-clear the staged "Send to Chat" contexts for the submission being
  * enqueued (side-panel §6.7). Optional so a bare embedder/fixture that owns
  * only the decision seam stays constructible; with it absent the origin
  * simply carries no contexts.
  */
 consumeAttachedContexts?: () => readonly AttachedContext[],
 outgoingState?: () => Pick<ChannelState, 'outgoing' | 'pending' | 'attachedContexts' | 'emit'>,
 interrupted?: Pick<InterruptedInputRecovery, 'retain' | 'reset'>,
) {
  /**
   * `@` file mentions (issue #15): expansion reads files asynchronously, so
   * every user-text delivery (submit / steer / interrupt-requeue) funnels
   * through this chain to keep the send order FIFO.
   */
  let inputChain: Promise<void> = Promise.resolve()
  /** Monotonic inputs that entered the FIFO; `/new` compares it. */
  let dispatched = 0
  /** Identity matters: a stale completion must not shift the new FIFO's head. */
  const inFlight: { id: string; text: string }[] = []
  const submissions = new Map<string, {
    readonly origin: UserTextOrigin
    readonly attach?: UserMessage
    /** Only a composer action owns an editable original, not internal relay/skill text. */
    readonly draft?: ComposerSubmission
    submitted: boolean
  }>()
  const transferring = new Set<string>()
  const discardedDuringTransfer = new Set<string>()
  const reservations = new Map<symbol, number>()
  const assertCapacity = (count = 1, replacing: readonly string[] = []): void => {
    const replaced = new Set(replacing.filter(id => submissions.has(id))).size
    const reserved = [...reservations.values()].reduce((sum, slots) => sum + slots, 0)
    if (submissions.size + reserved - replaced + count > 64) throw new Error(t('input-outgoing-full'))
  }
  /** An interrupt's deferred microtask must not lose capacity to a later send. */
  const reserveCapacity = (count: number, replacing: readonly string[]): (() => void) => {
    assertCapacity(count, replacing)
    const token = Symbol()
    const replaced = new Set(replacing.filter(id => submissions.has(id))).size
    reservations.set(token, Math.max(0, count - replaced))
    return () => { reservations.delete(token) }
  }
  const removeOutgoing = (id: string): boolean => {
    const view = outgoingState?.()
    if (view === undefined) return false
    const remaining = view.outgoing.filter(item => item.id !== id)
    if (remaining.length === view.outgoing.length) return false
    view.outgoing = remaining
    return true
  }
  const transition = (id: string, phase: OutgoingMessage['phase'], error?: string, emit = true): void => {
    const entry = submissions.get(id)
    const view = outgoingState?.()
    if (entry === undefined || !current(entry.origin) || view === undefined) return
    let changed = false
    view.outgoing = view.outgoing.map(item => {
      if (item.id !== id || (item.phase === 'failed' && phase !== 'failed') || (item.phase === 'uncertain' && phase === 'queued')) return item
      changed = true
      return { ...item, phase, ...(error === undefined ? {} : { error }) }
    })
    if (changed && emit) view.emit()
  }
  const restoreContexts = (origin: UserTextOrigin): void => {
    const view = outgoingState?.()
    if (view === undefined || !current(origin) || origin.attachedContexts.length === 0) return
    // Keep newer chips intact, including a new revision of the same source.
    const key = (context: AttachedContext): string => `${context.sourceId}\u0000${context.title}`
    const live = new Set(view.attachedContexts.map(key))
    view.attachedContexts = [...origin.attachedContexts.filter(context => !live.has(key(context))), ...view.attachedContexts]
  }
  const forgetOutgoing = (id: string, restore = false): boolean => {
    const entry = submissions.get(id)
    if (restore && entry !== undefined) restoreContexts(entry.origin)
    submissions.delete(id)
    transferring.delete(id)
    discardedDuringTransfer.delete(id)
    return removeOutgoing(id)
  }
  const recoverFailedOutgoing = (id: string): ComposerSubmission | undefined => {
    const view = outgoingState?.()
    const entry = submissions.get(id)
    const receipt = view?.outgoing.find(item => item.id === id && item.phase === 'failed')
    if (receipt === undefined || entry === undefined || !current(entry.origin)) return undefined
    forgetOutgoing(id, true)
    view!.emit()
    return { text: receipt.text, images: receipt.images }
  }

  /**
   * Attached-context registry (issue #842): `deliverUserText(..., attach)`
   * records the model-facing companion message under the DELIVERED user
   * message's id. The resident `agent/pre-step` listener below claims an entry
   * exactly once — on the step that admits its user message — and appends it
   * AFTER `next()`'s batch, the same shape and order as dsh-tool-skill's
   * gesture boundary. The map is emptied on claim, on inbox discard and on
   * channel release (owner.own below).
   */
  const attachedByMessageId = new Map<string, UserMessage>()

  /** Claim the batch's registered attachments, deleting each entry so a later
   *  step can never append it a second time. */
  const claimAttachments = (messages: readonly UserMessage[]): UserMessage[] => {
    if (attachedByMessageId.size === 0) return []
    const attached: UserMessage[] = []
    for (const message of messages) {
      const context = attachedByMessageId.get(message.id)
      if (context === undefined) continue
      attachedByMessageId.delete(message.id)
      attached.push(context)
    }
    return attached
  }

  /** Drop an attachment whose user message will never be claimed (inbox discard). */
  const retireAttachment = (messageId: string): void => {
    attachedByMessageId.delete(messageId)
    const view = outgoingState?.()
    if (transferring.has(messageId)) { discardedDuringTransfer.add(messageId); return }
    if (!view?.pending.some(item => item.id === messageId && item.docked === true)) {
      // Queue bookkeeping is not a durable receipt. A discard can accompany
      // an ambiguous submit failure; only an explicit refusal may restore it.
      transition(messageId, 'uncertain', undefined, false)
    }
  }

  /**
   * Resident `agent/pre-step` listener (D3/D4): `await next()` lets every
   * later transform run first; the waterfall applies AFTER-next transforms in
   * registration order, so registering at channel construction keeps this
   * append LAST (范例: presets/liangshen/instruction-hint.mjs). A rejected
   * step never claims — no context message without its admitted user line —
   * and a released owner returns the decision untouched. One `owner.own`
   * lifetime covers both the subscription and the whole registry (D5).
   */
  const disposePreStep = ctx.onAgentPreStep?.(async (_payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    if (!owner.current()) return decision
    const attached = claimAttachments(decision.messages)
    if (attached.length === 0) return decision
    return { ...decision, messages: [...decision.messages, ...attached] }
  })
  owner.own(() => {
    disposePreStep?.()
    attachedByMessageId.clear()
  })

  /** Stale fence: the submission belongs to the session it was typed in (the
   *  bound session object plus the binding generation every adoption
   *  advances; works for any backend, no DSH agent needed). */
  const current = (origin: UserTextOrigin): boolean =>
    owner.current() && binding.session === origin.session && state().agentBindingGeneration === origin.generation

  /** D-6: bind the submission to the session it was typed in AT ENQUEUE
   *  TIME. The FIFO chain may park this task behind a slow predecessor
   *  while the user /new's away — capturing the agent at run time would
   *  adopt the NEW session as this text's origin and deliver the old
   *  conversation's words into it. */
  const captureOrigin = (): UserTextOrigin => {
    const local = localImages?.()
    return {
    session: binding.session,
    agentId: state().agentId,
    generation: state().agentBindingGeneration,
    cwd: state().cwd,
    workingDirectory: sessionWorkingDirectory(state()),
    fs: mentionFs(ctx) ?? fallbackFs?.(),
    attachments: local ?? mentionAttachments(ctx),
    ...(local === undefined ? {} : { localImages: local }),
    stagedImages: composer.snapshot(),
    selection: selection(),
    // Consumed (not merely read): the snapshot and the clear are one step, so
    // the chips leave with the submission that owns them and a second,
    // faster-typed message can never re-attach the same context.
    attachedContexts: consumeAttachedContexts?.() ?? [],
    }
  }

  /**
   * Expand the text's `@` mentions and deliver ONE user message: the typed
   * text stays the first content block (the transcript bubble renders it —
   * never the file dump) and each resolved reference appends a model-facing
   * attachment block. The pending preview tracks the typed text.
   */
  const deliverUserText = async (
    text: string,
    placement: PendingMessage['placement'],
    images: readonly ComposerImageRef[],
    origin: UserTextOrigin,
    seed: UserMessage,
    attach?: UserMessage,
  ): Promise<void> => {
    const orderedImages = orderedComposerImages(text, images, origin.stagedImages)
    // A `[Image #N]` placeholder whose staging was evicted (FIFO cap) or
    // whose draft capability was lost (history/rewind/session switch) would
    // otherwise ship as plain text with no image attached — warn loudly,
    // deliver unchanged (the text is the user's; rewriting is worse).
    const stale = firstStaleComposerToken(text, orderedImages)
    if (stale !== undefined) {
      notify(t('input-image-token-stale', { token: stale }), { color: 'warning', timeoutMs: 5000 })
    }
    const expansion = await expandComposerMentions(
      origin.fs,
      origin.workingDirectory,
      text,
      origin.attachments,
      orderedImages,
    )
    // Mention reads can park for arbitrary I/O. A session switch during that
    // await invalidates the whole submission; neither the old nor the new
    // agent may receive a message assembled for a different conversation.
    if (!current(origin)) {
      notify(t('ext-stale-dropped'), { color: 'warning', timeoutMs: 4000 })
      return
    }
    // IDE selection consumption: append the ENQUEUE-time selection as its own
    // attached-file block — direct construction, never text parsing, failures
    // silently skipped (an IDE-side extra must never block a send).
    const selectionAttached = await attachIdeSelection(expansion.blocks, origin.cwd, origin.selection, origin.fs)
    // "Send to Chat": append every context staged for THIS submission as its
    // own `<attached-context …>` block, behind the typed text and the
    // mention/selection attachments. Unlike the selection there is nothing to
    // resolve and nothing that can fail — the body is already in hand.
    appendAttachedContextBlocks(expansion.blocks, origin.attachedContexts)
    if (!current(origin)) return
    const message = freezeMessage({ ...seed, content: expansion.blocks })
    if (selectionAttached !== undefined) rememberSelection(message.id, selectionAttached)
    // The message is real from here on: remember its attached context BEFORE
    // the submit so the pre-step listener can find it. A throwing submit
    // rolls both the pending preview and this entry back.
    if (attach !== undefined) attachedByMessageId.set(message.id, attach)
    // Track BEFORE the submit: a synchronous throw inside it rolls the
    // preview back; otherwise the backend's pending changes retire it once
    // the message is claimed or discarded.
    trackPending({ id: message.id, text, images }, placement)
    try {
      // The message id IS the clientMessageId every ledger above keys on; the
      // DSH session delivers this exact message (steer/followup).
      // A session that takes images itself reads them through their
      // in-memory facades, in block order.
      const local = origin.localImages
      const images = local === undefined ? undefined : expansion.blocks.flatMap(block => {
        if (block.type !== 'image') return []
        const view = local.facade(block.attachment)
        return view === undefined ? [] : [view]
      })
      const receipt = origin.session.submit({ text, blocks: message.content, clientMessageId: message.id, native: message, ...(images === undefined || images.length === 0 ? {} : { images }) }, placement)
      // Only a synchronous throw proves the backend never accepted the call.
      const entry = submissions.get(message.id)
      if (entry !== undefined) entry.submitted = true
      const result = await receipt
      if (!current(origin) || !submissions.has(message.id)) return
      // A backend refusal need not emit pending.changed. Retire its preview
      // and attached context here, and show the refusal instead of queuing it.
      if (!result.accepted) {
        if (attach !== undefined) attachedByMessageId.delete(message.id)
        untrackPending(message.id)
        transition(message.id, 'failed', result.reason || t('input-not-accepted'))
        // A refusal with no reason is still a refusal: say so, or the send
        // looks successful while nothing was queued.
        if (result.reason !== undefined && result.reason !== '') notify(result.reason, { color: 'warning', timeoutMs: 4000 })
        else notify(t('input-not-accepted'), { color: 'warning', timeoutMs: 4000 })
        return
      }
      if (result.handled === true) {
        const changed = forgetOutgoing(message.id)
        attachedByMessageId.delete(message.id)
        untrackPending(message.id)
        if (changed) outgoingState?.().emit()
        return
      }
      transition(message.id, 'queued')
    } catch (error) {
      if (current(origin) && submissions.has(message.id)) {
        const entry = submissions.get(message.id)!
        if (!entry.submitted && attach !== undefined) attachedByMessageId.delete(message.id)
        untrackPending(message.id)
      }
      throw error
    }
    if (current(origin)) {
      for (const { path, adjustment } of expansion.imageAdjustments ?? []) {
        const detail: string[] = []
        if (adjustment.resized) detail.push(t('input-image-detail-resized', { width: adjustment.width, height: adjustment.height }))
        if (adjustment.mediaType !== adjustment.sourceMediaType) {
          const from = adjustment.sourceMediaType.replace(/^image\//u, '').toUpperCase()
          const to = adjustment.mediaType.replace(/^image\//u, '').toUpperCase()
          detail.push(t(adjustment.flattened ? 'input-image-detail-converted-flattened' : 'input-image-detail-converted', { from, to }))
        }
        if (detail.length > 0) notify(t('mentions-image-adjusted', { path, detail: detail.join(' · ') }), { timeoutMs: 5000 })
      }
      for (const { path, reason } of expansion.imageFailures ?? []) {
        notify(t('mentions-image-failed', { path, reason }), { color: 'warning', timeoutMs: 5000 })
      }
    }
    if (expansion.attached.length > 0) {
      notify(t('mentions-attached', { count: expansion.attached.length }), { timeoutMs: 2500 })
    }
    if (expansion.missing.length > 0) {
      notify(t('mentions-missing', { paths: expansion.missing.map(formatMissingReference).join(' ') }), {
        color: 'warning',
        timeoutMs: 4000,
      })
    }
  }
  /**
   * RFC 0005 D-8: a flow parked on a plugin decision must be user-observable.
   * Decisions normally resolve in milliseconds, so the notice only fires
   * once the wait crosses a threshold — a slow plugin (e.g. one showing a
   * managed dialog) then explains the pause instead of looking like the TUI
   * ate the input.
   */
  const DECISION_PENDING_MS = 400
  /**
   * Session-scoped ledger of live pending-decision indicators. A session
   * replacement must cancel the notice timer and dismiss an already-visible
   * sticky notice even when the plugin's decision promise never settles; the
   * owner-scoped release alone would keep it up until channel teardown, and a
   * timer firing after the switch would raise the notice into the session that
   * replaced the one which parked the input (review finding: stale decision
   * notices were no longer dismissed or suppressed on session change).
   */
  const pendingDecisionCleanups = new Set<() => void>()
  const withDecisionPending = <T>(name: string, pending: Promise<T>, origin?: UserTextOrigin): Promise<T> => {
    let dismiss: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = (): void => {
      if (timer !== undefined) { clearTimeout(timer); timer = undefined }
      const raised = dismiss
      dismiss = undefined
      raised?.()
      pendingDecisionCleanups.delete(cleanup)
    }
    timer = setTimeout(() => {
      // Sticky (timeoutMs 0), D-8: the indicator must cover the WHOLE wait —
      // an auto-expiring notice would vanish after ~4s while the decision,
      // the delivery and every queued FIFO task behind them stay parked,
      // leaving the user with no sign the flow is still waiting. It comes
      // down only when the decision settles (finally below); a decision
      // that never settles keeps its indicator up, which is the truthful
      // state.
      // A notice must never be raised for a session that has already been
      // replaced: the switch drains this ledger, and the origin fence covers
      // a timer that fires before that drain lands.
      if (origin !== undefined && !current(origin)) { cleanup(); return }
      if (!owner.current()) return
      dismiss = notify(t('ext-decision-pending', { event: name }), { timeoutMs: 0 })
    }, DECISION_PENDING_MS)
    pendingDecisionCleanups.add(cleanup)
    // Both exits are covered: a fast decision clears the timer before it
    // fires; a slow one dismisses the indicator it raised. The owner release
    // keeps the channel-teardown path working on top of the session drain.
    const release = owner.own(cleanup)
    return pending.finally(release)
  }
  /**
   * The `tui/input` decision event (pi's `input` seam): the FIRST plugin
   * returning a valid decision wins — transform the text, mark it handled,
   * or cancel it. No listeners (or only crashing/malformed ones) means
   * delivery proceeds unchanged, so a broken plugin can never wedge the
   * input path — and can never skip a later veto listener either
   * (dispatchTuiDecision isolates crashes and normalizes returns per
   * listener instead of bailing on the first object).
   *
   * Decision AND delivery enter one FIFO chain in submission order: a slow
   * listener on A parks A's delivery AND any later submissions behind it —
   * without the chain, B's decision could resolve first and the model would
   * receive B before A. Each submission binds its origin agent AT ENQUEUE,
   * so a session switch landing before OR during its decision drops the
   * stale text with a notice instead of sending the old conversation's
   * words to the new session.
   */
  const runUserTextDecision = async (
    text: string,
    placement: PendingMessage['placement'],
    images: readonly ComposerImageRef[],
    origin: UserTextOrigin,
    seed: UserMessage,
    attach?: UserMessage,
  ): Promise<void> => {
    // Stale detection compares the SESSION REFERENCE, not the id: session ids
    // are reusable (A → /new → /resume A lands back on the same id with a
    // fresh session), so an id check has an ABA hole. Both origin values are
    // ENQUEUE-time captures (see dispatchUserText): a decision parked behind
    // a slow predecessor must still be judged against the session its text
    // was typed in, not whichever session is live when it finally runs.
    const dropIfStale = (): boolean => {
      if (current(origin)) return false
      notify(t('ext-stale-dropped'), { color: 'warning', timeoutMs: 4000 })
      return true
    }
    // A follower can wait behind an older slow decision while /new replaces
    // the session. Do not even expose that stale text to plugins.
    if (dropIfStale()) return
    const decision = await withDecisionPending('tui/input', ctx.dispatchDecision('tui/input', {
      text,
      delivery: placement === 'steer' ? 'steer' : 'followup',
      sessionId: origin.agentId,
      cwd: origin.cwd,
    }, normalizeInputDecision), origin)
    // Staleness wins over cancel/handled: an old plugin result must neither
    // toast into nor claim input from the replacement session.
    if (dropIfStale()) return
    if (decision !== undefined) {
      // Both intercepts toast — a bare {cancel}/{handled} must not make the
      // typed line vanish silently (the host-localized fallback mirrors the
      // other decision events' ext-action-cancelled handling).
      if ('cancel' in decision) {
        transition(seed.id, 'failed', decision.reason ?? t('ext-action-cancelled'))
        notify(decision.reason ?? t('ext-action-cancelled'), { color: 'warning', timeoutMs: 4000 })
        return
      }
      if ('handled' in decision) {
        if (forgetOutgoing(seed.id)) outgoingState?.().emit()
        notify(decision.notice ?? t('ext-action-handled'), { timeoutMs: 4000 })
        return
      }
      text = decision.text.trim()
    }
    try {
      await deliverUserText(text, placement, images, origin, seed, attach)
    } catch (error: unknown) {
      // The FIFO must survive a failed expansion/send: surface it, then let
      // the next input proceed through the settled inputChain.
      if (!current(origin) || !submissions.has(seed.id)) return
      const message = error instanceof Error ? error.message : String(error)
      transition(seed.id, submissions.get(seed.id)!.submitted ? 'uncertain' : 'failed', message)
      logForDebugging(`submit: delivery failed (${message})`)
      notify(t(submissions.get(seed.id)?.submitted === true ? 'input-delivery-uncertain' : 'send-failed', { err: message }), { color: 'error' })
    }
  }
  const dispatchUserText = (
    text: string,
    placement: PendingMessage['placement'],
    images: readonly ComposerImageRef[] = [],
    attach?: UserMessage,
    previousId?: string,
    presentation?: 'immediate',
    recoverable = false,
  ): void => {
    assertCapacity(1, previousId === undefined ? [] : [previousId])
    // Capture before the async FIFO: later turn changes cannot move this preview.
    const queuePlacement = presentation !== 'immediate' && state().working === true ? placement : undefined
    const previous = previousId === undefined ? undefined : submissions.get(previousId)
    const capturedImages = composer.captureDraftImages(text, images)
    const origin = previous?.origin ?? captureOrigin()
    const message = createUserMessage({ content: [{ type: 'text', text: text.trim() }], source: { kind: 'user' } })
    if (previousId !== undefined) forgetOutgoing(previousId)
    const companion = attach ?? previous?.attach
    submissions.set(message.id, { origin, attach: companion, submitted: false,
      ...(recoverable ? { draft: { text, images: capturedImages } } : {}),
    })
    const view = outgoingState?.()
    if (view !== undefined) {
      view.outgoing = [...view.outgoing, {
        id: message.id, text, images: capturedImages, phase: 'sending',
        ...(queuePlacement === undefined ? {} : { queuePlacement }),
      }]
      view.emit()
    }
    dispatched += 1
    inFlight.push({ id: message.id, text })
    inputChain = inputChain.then(() => runUserTextDecision(text.trim(), placement, capturedImages, origin, message, companion)).catch((error: unknown) => {
      // Preparation/decision failure is definite: submit has not run yet.
      if (current(origin) && submissions.has(message.id)) {
        const reason = error instanceof Error ? error.message : String(error)
        transition(message.id, submissions.get(message.id)!.submitted ? 'uncertain' : 'failed', reason)
        notify(t(submissions.get(message.id)?.submitted === true ? 'input-delivery-uncertain' : 'send-failed', { err: reason }), { color: 'error' })
      }
      ctx.logger.warn('dsh-tui: tui/input dispatch failed: %o', error)
    }).finally(() => {
      const index = inFlight.findIndex(entry => entry.id === message.id)
      if (index !== -1) inFlight.splice(index, 1)
    })
  }
  /** Public companion for callers that own a line but not a draft (skill
   *  registrations): same decision pass and FIFO as a typed submit. The
   *  optional `attach` is registered by `deliverUserText` only once its user
   *  message is real, then appended at the end of that message's step batch. */
  const deliverUserTextNow = (
    text: string,
    placement: PendingMessage['placement'],
    images: readonly ComposerImageRef[] = [],
    attach?: UserMessage,
  ): void => dispatchUserText(text, placement, images, attach)
  /** Main's `clearStagedImages`: revoke capabilities AND release the FIFO so
   *  a task parked on the replaced session cannot wedge the new one, and drop
   *  every pending-decision indicator owned by the session being replaced. */
  const resetOutgoing = (): void => {
    interrupted?.reset()
    submissions.clear()
    transferring.clear()
    discardedDuringTransfer.clear()
    reservations.clear()
    attachedByMessageId.clear()
    inputChain = Promise.resolve()
    inFlight.length = 0
    const view = outgoingState?.()
    if (view !== undefined) view.outgoing = []
    for (const cleanup of [...pendingDecisionCleanups]) cleanup()
  }
  owner.own(resetOutgoing)
  const clearStagedImages = (): void => {
    resetOutgoing()
    composer.clearStagedImages()
  }

  return {
    dispatchUserText,
    assertCapacity,
    reserveCapacity,
    beginTransfer: (ids: readonly string[]): (() => void) => {
      for (const id of ids) transferring.add(id)
      return () => {
        for (const id of ids) {
          transferring.delete(id)
          if (discardedDuringTransfer.delete(id)) transition(id, 'uncertain')
        }
      }
    },
    hasOutgoing: (id: string): boolean => submissions.has(id),
    /** A swap parks the current draft's contexts, then restores the old row's. */
    parkDraft: (id: string, previousId: string): void => {
      assertCapacity(1, [previousId])
      const origin = captureOrigin()
      forgetOutgoing(previousId, true)
      attachedByMessageId.delete(previousId)
      submissions.set(id, { origin, submitted: false })
    },
    recoverFailedOutgoing,
    resetOutgoing,
    /** Event routing owns the single wake after confirmation + projection. */
    confirmOutgoing: (id: string, human = true): boolean => {
      const entry = submissions.get(id)
      if (human && entry?.draft !== undefined && current(entry.origin)) {
        interrupted?.retain(id, { ...entry.draft, session: entry.origin.session, generation: entry.origin.generation })
      }
      return forgetOutgoing(id)
    },
    /** A successful explicit retraction transfers contexts back to the draft. */
    retractOutgoing: (id: string): void => { forgetOutgoing(id, true); attachedByMessageId.delete(id) },
    /** Inputs dispatched so far, and whether any is still in the FIFO (a
     *  parked decision, an `@` read, an IDE-selection read). */
    activity: (): { readonly dispatched: number; readonly unsettled: boolean; readonly parked?: string } => ({
      dispatched,
      unsettled: inFlight.length > 0,
      ...(inFlight[0] === undefined ? {} : { parked: inFlight[0].text }),
    }),
    deliverUserText: deliverUserTextNow,
    claimAttachments,
    retireAttachment,
    withDecisionPending,
    clearStagedImages,
    stageImage: (input: StagedImageInput): Promise<string> => composer.stageImage(input),
    stagedImages: (): ReadonlyMap<string, ChannelImageBlock['attachment']> => composer.snapshot(),
    composer,
  }
}
