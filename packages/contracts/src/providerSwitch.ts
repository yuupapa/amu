import * as Schema from "effect/Schema";

import {
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

// Cross-provider handoff: one switch operation per thread at a time.
// See docs/internals/cross-provider-handoff.md §4–§5.

export const ProviderSwitchId = TrimmedNonEmptyString.pipe(Schema.brand("ProviderSwitchId"));
export type ProviderSwitchId = typeof ProviderSwitchId.Type;

export const ProviderSwitchPacketId = TrimmedNonEmptyString.pipe(
  Schema.brand("ProviderSwitchPacketId"),
);
export type ProviderSwitchPacketId = typeof ProviderSwitchPacketId.Type;

export const ProviderSwitchParty = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  model: TrimmedNonEmptyString,
});
export type ProviderSwitchParty = typeof ProviderSwitchParty.Type;

export const ProviderSwitchAwaitReason = Schema.Literals(["failed-retryable", "unknown-delivery"]);
export type ProviderSwitchAwaitReason = typeof ProviderSwitchAwaitReason.Type;

export const ProviderSwitchCloseReason = Schema.Literals(["aborted", "discarded"]);
export type ProviderSwitchCloseReason = typeof ProviderSwitchCloseReason.Type;

/** Milestones a switch reaches while unresolved; `delivered` resolves it. */
export const ProviderSwitchOpenMilestone = Schema.Literals([
  "requested",
  "old-stopped",
  "packet-built",
]);
export type ProviderSwitchOpenMilestone = typeof ProviderSwitchOpenMilestone.Type;

export const ProviderSwitchAttemptKind = Schema.Literals(["start", "submit"]);
export type ProviderSwitchAttemptKind = typeof ProviderSwitchAttemptKind.Type;

export const ProviderSwitchAttemptStatus = Schema.Literals(["planned", "succeeded", "failed"]);
export type ProviderSwitchAttemptStatus = typeof ProviderSwitchAttemptStatus.Type;

/**
 * Read-model view of an attempt. `abandoned` is never recorded directly: it is
 * what a still-planned attempt becomes when the switch moves to awaiting-user
 * (a start that never reported back, or a submit whose delivery is unknown).
 */
export const ProviderSwitchAttemptState = Schema.Struct({
  attemptId: PositiveInt,
  kind: ProviderSwitchAttemptKind,
  status: Schema.Literals(["planned", "succeeded", "failed", "abandoned"]),
  generation: Schema.NullOr(NonNegativeInt),
  turnId: Schema.NullOr(TurnId),
  /** A succeeded submit: the model the provider reported. Optional for stored states. */
  model: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  /**
   * A succeeded submit: the generation of the session that accepted the turn,
   * which a native resume may have moved past the start's (§5.4, P7).
   */
  acceptedGeneration: Schema.optional(Schema.NullOr(NonNegativeInt)),
});
export type ProviderSwitchAttemptState = typeof ProviderSwitchAttemptState.Type;

/** What identifies a built packet; the text itself stays in the event. */
export const ProviderSwitchPacketFingerprint = Schema.Struct({
  packetId: ProviderSwitchPacketId,
  sha256: TrimmedNonEmptyString,
  chars: NonNegativeInt,
  includedMessages: NonNegativeInt,
  omittedMessages: NonNegativeInt,
  truncated: Schema.Boolean,
});
export type ProviderSwitchPacketFingerprint = typeof ProviderSwitchPacketFingerprint.Type;

export const OrchestrationPendingProviderSwitch = Schema.Struct({
  switchId: ProviderSwitchId,
  from: ProviderSwitchParty,
  to: ProviderSwitchParty,
  triggerMessageId: MessageId,
  boundaryTurnCount: NonNegativeInt,
  /**
   * closing: the user aborted; the switch stays unresolved (sends refused)
   * until its new session is stopped and the selection restored (§8.2).
   */
  status: Schema.Literals(["in-progress", "awaiting-user", "closing"]),
  awaitingReason: Schema.NullOr(ProviderSwitchAwaitReason),
  /** Set while closing. Optional for stored states. */
  closing: Schema.optional(Schema.NullOr(Schema.Struct({ returnToPrevious: Schema.Boolean }))),
  milestone: ProviderSwitchOpenMilestone,
  packet: Schema.NullOr(ProviderSwitchPacketFingerprint),
  /** Every attempt of this switch, in attemptId order. */
  attempts: Schema.Array(ProviderSwitchAttemptState),
  /**
   * A submit was planned at some point, so the message may have reached a
   * provider. Closing the switch then marks the message unknown-discarded,
   * never cancelled.
   */
  deliveryUncertain: Schema.Boolean,
  /** Granted by resolve(resend); spent by the next planned submit. */
  resendAllowed: Schema.Boolean,
  /** Bumped by every retry and resolve(resend); a wait must name the current value. */
  resumeCount: NonNegativeInt,
  requestedAt: IsoDateTime,
});
export type OrchestrationPendingProviderSwitch = typeof OrchestrationPendingProviderSwitch.Type;

export const ProviderSwitchDelivery = Schema.Struct({
  switchId: ProviderSwitchId,
  attemptId: PositiveInt,
  turnId: TurnId,
  /** S in §7.4: reverts to a turn count at or below it are refused. */
  boundaryTurnCount: NonNegativeInt,
});
export type ProviderSwitchDelivery = typeof ProviderSwitchDelivery.Type;

export const OrchestrationThreadProviderSwitchState = Schema.Struct({
  pending: Schema.NullOr(OrchestrationPendingProviderSwitch),
  lastDelivered: Schema.NullOr(ProviderSwitchDelivery),
  /**
   * Every resolved switch, most recent last, so a stray record can never
   * reopen one. Each entry needed a user action or a delivery, so this stays small.
   */
  resolvedSwitchIds: Schema.Array(ProviderSwitchId),
  /** Any switch was ever requested on this thread. */
  hasHistory: Schema.Boolean,
  /**
   * The switch most recently closed by abort or discard, so cleanup knows
   * which session the switch itself started (§8.2). Optional: stored states
   * from before it decode without it.
   */
  lastClosed: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        switchId: ProviderSwitchId,
        from: ProviderSwitchParty,
        to: ProviderSwitchParty,
        reason: ProviderSwitchCloseReason,
        /** The old session had been stopped (milestone old-stopped or later). */
        oldStopped: Schema.Boolean,
      }),
    ),
  ),
  /**
   * A session of this instance may be bound without having received its
   * packet (the switch was discarded). It never counts as a native
   * continuation; the next delivered switch clears it (§3.1).
   */
  handoffUnconfirmedInstanceId: Schema.optional(Schema.NullOr(ProviderInstanceId)),
  /**
   * Event ids of accepted reverts not yet reverted or failed. In-memory
   * only: a restart drops in-flight reverts, so the command read model
   * starts empty.
   */
  revertsInFlight: Schema.Array(EventId),
});
export type OrchestrationThreadProviderSwitchState =
  typeof OrchestrationThreadProviderSwitchState.Type;

export const EMPTY_THREAD_PROVIDER_SWITCH_STATE: OrchestrationThreadProviderSwitchState = {
  pending: null,
  lastDelivered: null,
  resolvedSwitchIds: [],
  hasHistory: false,
  revertsInFlight: [],
};

export const MessageDeliveryState = Schema.Literals([
  "delivered",
  "pending",
  "rejected",
  "cancelled",
  "unknown-discarded",
]);
export type MessageDeliveryState = typeof MessageDeliveryState.Type;

// Event payloads (§5.1). Commands share these fields plus the envelope.

export const ThreadProviderSwitchRequestedPayloadFields = {
  switchId: ProviderSwitchId,
  from: ProviderSwitchParty,
  to: ProviderSwitchParty,
  triggerMessageId: MessageId,
  boundaryTurnCount: NonNegativeInt,
} as const;

export const ThreadProviderSwitchMilestonePayloadFields = {
  switchId: ProviderSwitchId,
  milestone: Schema.Literals(["old-stopped", "delivered"]),
  attemptId: Schema.optional(PositiveInt),
  turnId: Schema.optional(TurnId),
  /** delivered: the model the provider reported for the accepted turn (§5.4). */
  model: Schema.optional(TrimmedNonEmptyString),
  /** delivered: the generation of the session that accepted the turn (§5.4). */
  generation: Schema.optional(NonNegativeInt),
} as const;

export const ThreadProviderSwitchPacketPayloadFields = {
  switchId: ProviderSwitchId,
  packetId: ProviderSwitchPacketId,
  text: Schema.String,
  sha256: TrimmedNonEmptyString,
  chars: NonNegativeInt,
  includedMessages: NonNegativeInt,
  omittedMessages: NonNegativeInt,
  truncated: Schema.Boolean,
} as const;

export const ThreadProviderSwitchAttemptPayloadFields = {
  switchId: ProviderSwitchId,
  attemptId: PositiveInt,
  kind: ProviderSwitchAttemptKind,
  status: ProviderSwitchAttemptStatus,
  generation: Schema.optional(NonNegativeInt),
  turnId: Schema.optional(TurnId),
  /** submit succeeded: the model the provider reported. */
  model: Schema.optional(TrimmedNonEmptyString),
  /** submit succeeded: the generation of the session that accepted the turn. */
  acceptedGeneration: Schema.optional(NonNegativeInt),
  detail: Schema.optional(Schema.String),
} as const;

export const ThreadProviderSwitchAwaitUserPayloadFields = {
  switchId: ProviderSwitchId,
  /** The switch's latest attemptId when the wait began (0 if none), so a stale wait cannot hit a newer attempt. */
  attemptId: NonNegativeInt,
  /** The switch's resumeCount when the wait began, so a wait from before a resume is stale. */
  resumeCount: NonNegativeInt,
  reason: ProviderSwitchAwaitReason,
  detail: Schema.String,
} as const;

export const ThreadProviderSwitchRetryPayloadFields = {
  switchId: ProviderSwitchId,
} as const;

export const ThreadProviderSwitchAbortPayloadFields = {
  switchId: ProviderSwitchId,
  returnToPrevious: Schema.Boolean,
} as const;

/** Server: an aborted switch finished its cleanup and is resolved. */
export const ThreadProviderSwitchClosePayloadFields = {
  switchId: ProviderSwitchId,
  /** The instance whose session cleanup stopped and unbound, if any. */
  releasedInstanceId: Schema.optional(ProviderInstanceId),
} as const;

export const ThreadProviderSwitchResolvePayloadFields = {
  switchId: ProviderSwitchId,
  decision: Schema.Literals(["resend", "discard"]),
} as const;

export const ThreadTurnAssignmentPayloadFields = {
  messageId: MessageId,
  turnId: TurnId,
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  model: TrimmedNonEmptyString,
  generation: Schema.NullOr(NonNegativeInt),
} as const;

/**
 * Who answered a turn (§5.4), as thread snapshots carry it. The first record
 * for a turn wins; a later one naming another instance or model only sets
 * changedMidTurn.
 */
export const OrchestrationTurnAssignment = Schema.Struct({
  ...ThreadTurnAssignmentPayloadFields,
  changedMidTurn: Schema.Boolean,
});
export type OrchestrationTurnAssignment = typeof OrchestrationTurnAssignment.Type;

export const ThreadMessageDeliveryStatePayloadFields = {
  messageId: MessageId,
  state: MessageDeliveryState,
  reason: Schema.optional(Schema.String),
} as const;
