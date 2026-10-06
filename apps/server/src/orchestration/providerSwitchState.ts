import * as NodeCrypto from "node:crypto";

import {
  EMPTY_THREAD_PROVIDER_SWITCH_STATE,
  type MessageDeliveryState,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationPendingProviderSwitch,
  type OrchestrationThread,
  type OrchestrationThreadProviderSwitchState,
  type ProviderSwitchAttemptState,
  type ProviderSwitchParty,
} from "@t3tools/contracts";

// Rules for one cross-provider switch operation (design §4.4). Pure: the
// decider asks `checkProviderSwitchCommand`, the projector folds events with
// `applyProviderSwitchEvent`.
//
// Idempotency: a record identical to one already applied is accepted and
// folds to the same state. A record that reuses an id with different content
// is refused, so the event store never holds two versions of one fact.
//
// Recovery (§9.1): a start attempt left planned by a restart must first be
// recorded failed; only then can a new start attempt be planned. A submit
// left planned goes to awaiting-user (unknown-delivery) instead.

export type ProviderSwitchCommand = Extract<
  OrchestrationCommand,
  {
    type:
      | "thread.provider-switch.request"
      | "thread.provider-switch.milestone"
      | "thread.provider-switch.packet"
      | "thread.provider-switch.attempt"
      | "thread.provider-switch.await-user"
      | "thread.provider-switch.retry"
      | "thread.provider-switch.abort"
      | "thread.provider-switch.resolve"
      | "thread.provider-switch.close";
  }
>;

export type ProviderSwitchEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.provider-switch-requested"
      | "thread.provider-switch-milestone-reached"
      | "thread.provider-switch-packet-built"
      | "thread.provider-switch-attempt-recorded"
      | "thread.provider-switch-awaiting-user"
      | "thread.provider-switch-retry-requested"
      | "thread.provider-switch-aborted"
      | "thread.provider-switch-resolved"
      | "thread.provider-switch-closed";
  }
>;

type CommandOf<T extends ProviderSwitchCommand["type"]> = Extract<
  ProviderSwitchCommand,
  { type: T }
>;

export const threadProviderSwitchState = (
  thread: Pick<OrchestrationThread, "providerSwitch">,
): OrchestrationThreadProviderSwitchState =>
  thread.providerSwitch ?? EMPTY_THREAD_PROVIDER_SWITCH_STATE;

const partiesEqual = (a: ProviderSwitchParty, b: ProviderSwitchParty) =>
  a.instanceId === b.instanceId && a.driver === b.driver && a.model === b.model;

const latestOfKind = (
  pending: OrchestrationPendingProviderSwitch,
  kind: ProviderSwitchAttemptState["kind"],
): ProviderSwitchAttemptState | null =>
  pending.attempts.findLast((attempt) => attempt.kind === kind) ?? null;

const lastAttemptId = (pending: OrchestrationPendingProviderSwitch) =>
  pending.attempts.at(-1)?.attemptId ?? 0;

const lastStartGeneration = (pending: OrchestrationPendingProviderSwitch) =>
  pending.attempts.reduce<number | null>(
    (max, attempt) =>
      attempt.kind === "start" && attempt.generation !== null
        ? Math.max(max ?? attempt.generation, attempt.generation)
        : max,
    null,
  );

export const sha256Hex = (text: string) =>
  NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");

/** Null when accepted; otherwise why the command is refused. */
export function checkProviderSwitchCommand(
  state: OrchestrationThreadProviderSwitchState,
  command: ProviderSwitchCommand,
): string | null {
  const pending = state.pending;

  if (command.type === "thread.provider-switch.request") {
    if (state.resolvedSwitchIds.includes(command.switchId)) {
      return `Provider switch '${command.switchId}' is already resolved.`;
    }
    if (pending !== null) {
      if (pending.switchId !== command.switchId) {
        return `Provider switch '${pending.switchId}' is still unresolved.`;
      }
      const same =
        partiesEqual(pending.from, command.from) &&
        partiesEqual(pending.to, command.to) &&
        pending.triggerMessageId === command.triggerMessageId &&
        pending.boundaryTurnCount === command.boundaryTurnCount;
      return same ? null : `Provider switch '${command.switchId}' was requested differently.`;
    }
    if (state.revertsInFlight.length > 0) {
      return "A checkpoint revert is still in progress.";
    }
    return null;
  }

  if (pending === null || pending.switchId !== command.switchId) {
    const delivered = state.lastDelivered;
    if (
      command.type === "thread.provider-switch.milestone" &&
      command.milestone === "delivered" &&
      delivered !== null &&
      delivered.switchId === command.switchId
    ) {
      return delivered.attemptId === command.attemptId && delivered.turnId === command.turnId
        ? null
        : `Provider switch '${command.switchId}' was delivered with a different attempt.`;
    }
    if (state.resolvedSwitchIds.includes(command.switchId)) {
      return `Provider switch '${command.switchId}' is already resolved.`;
    }
    return pending === null
      ? `No unresolved provider switch; '${command.switchId}' is not current.`
      : `Provider switch '${command.switchId}' is not current; '${pending.switchId}' is.`;
  }

  switch (command.type) {
    case "thread.provider-switch.milestone":
      return checkMilestone(pending, command);
    case "thread.provider-switch.packet":
      return checkPacket(pending, command);
    case "thread.provider-switch.attempt":
      return checkAttempt(pending, command);
    case "thread.provider-switch.await-user":
      return checkAwaitUser(pending, command);
    case "thread.provider-switch.retry":
      return requireAwaiting(pending, "failed-retryable", "retry");
    case "thread.provider-switch.abort":
      if (pending.status === "closing") {
        // The same abort again is a no-op.
        return pending.closing?.returnToPrevious === command.returnToPrevious
          ? null
          : `Provider switch '${pending.switchId}' is already closing.`;
      }
      return requireAwaiting(pending, "failed-retryable", "abort");
    case "thread.provider-switch.resolve":
      return requireAwaiting(pending, "unknown-delivery", `resolve(${command.decision})`);
    case "thread.provider-switch.close":
      return pending.status === "closing"
        ? null
        : `Provider switch '${pending.switchId}' was not aborted.`;
  }
}

/**
 * The delivery state the trigger message gets when this command closes the
 * switch, or null when the command does not close it (§4.5, decisions 5, 8).
 */
export function closedMessageDeliveryState(
  pending: OrchestrationPendingProviderSwitch,
  command: ProviderSwitchCommand,
): MessageDeliveryState | null {
  const closes =
    command.type === "thread.provider-switch.abort" ||
    (command.type === "thread.provider-switch.resolve" && command.decision === "discard");
  if (!closes) return null;
  // Once a submit was planned the message may have arrived; never claim it was not sent.
  return pending.deliveryUncertain ? "unknown-discarded" : "cancelled";
}

function requireInProgress(pending: OrchestrationPendingProviderSwitch): string | null {
  return pending.status === "in-progress"
    ? null
    : `Provider switch '${pending.switchId}' is waiting for the user.`;
}

function requireAwaiting(
  pending: OrchestrationPendingProviderSwitch,
  reason: "failed-retryable" | "unknown-delivery",
  action: string,
): string | null {
  return pending.status === "awaiting-user" && pending.awaitingReason === reason
    ? null
    : `Cannot ${action}: provider switch '${pending.switchId}' is not awaiting the user for ${reason}.`;
}

function checkMilestone(
  pending: OrchestrationPendingProviderSwitch,
  command: CommandOf<"thread.provider-switch.milestone">,
): string | null {
  const notInProgress = requireInProgress(pending);
  if (notInProgress !== null) return notInProgress;
  if (command.milestone === "old-stopped") {
    // Recovery may stop the old session again; reaching it twice is a no-op.
    return null;
  }
  if (pending.milestone !== "packet-built") {
    return "Cannot record delivered before the packet is built.";
  }
  const submit = latestOfKind(pending, "submit");
  if (
    submit === null ||
    submit.status !== "succeeded" ||
    command.attemptId !== submit.attemptId ||
    command.turnId === undefined ||
    command.turnId !== submit.turnId
  ) {
    return "Delivered must name the succeeded submit attempt and its turn.";
  }
  return null;
}

function checkPacket(
  pending: OrchestrationPendingProviderSwitch,
  command: CommandOf<"thread.provider-switch.packet">,
): string | null {
  const notInProgress = requireInProgress(pending);
  if (notInProgress !== null) return notInProgress;
  if (command.chars !== command.text.length) {
    return "Packet chars must equal the text length.";
  }
  if (command.sha256 !== sha256Hex(command.text)) {
    return "Packet sha256 does not match its text.";
  }
  const built = pending.packet;
  if (built !== null) {
    const same =
      built.packetId === command.packetId &&
      built.sha256 === command.sha256 &&
      built.chars === command.chars &&
      built.includedMessages === command.includedMessages &&
      built.omittedMessages === command.omittedMessages &&
      built.truncated === command.truncated;
    return same ? null : `Packet '${built.packetId}' was already built for this switch.`;
  }
  if (pending.milestone !== "old-stopped") {
    return "Cannot build the packet before the old session is stopped.";
  }
  return null;
}

function checkAttempt(
  pending: OrchestrationPendingProviderSwitch,
  command: CommandOf<"thread.provider-switch.attempt">,
): string | null {
  const notInProgress = requireInProgress(pending);
  if (notInProgress !== null) return notInProgress;
  const existing = pending.attempts.find((attempt) => attempt.attemptId === command.attemptId);
  const generation = command.generation ?? null;
  const turnId = command.turnId ?? null;

  if (command.status === "planned") {
    if (existing !== undefined) {
      return existing.kind === command.kind && existing.generation === generation
        ? null
        : `Attempt ${command.attemptId} was already planned differently.`;
    }
    return checkNewPlannedAttempt(pending, command);
  }

  if (existing === undefined || existing.kind !== command.kind) {
    return `Attempt ${command.attemptId} is not a planned ${command.kind} attempt.`;
  }
  if (command.generation !== undefined && command.generation !== existing.generation) {
    return `Attempt ${command.attemptId} reserved generation ${existing.generation}.`;
  }
  if (existing.status === command.status) {
    return existing.turnId === turnId &&
      (existing.model ?? null) === (command.model ?? null) &&
      (existing.acceptedGeneration ?? null) === (command.acceptedGeneration ?? null)
      ? null
      : `Attempt ${command.attemptId} already ${existing.status} with a different turn, model or generation.`;
  }
  if (existing.status !== "planned") {
    return `Attempt ${command.attemptId} already ${existing.status}.`;
  }
  if (command.kind === "submit" && command.status === "succeeded" && turnId === null) {
    return "A succeeded submit attempt must carry its turnId.";
  }
  return null;
}

function checkNewPlannedAttempt(
  pending: OrchestrationPendingProviderSwitch,
  command: CommandOf<"thread.provider-switch.attempt">,
): string | null {
  if (command.attemptId <= lastAttemptId(pending)) {
    return `Attempt ids must increase; last was ${lastAttemptId(pending)}.`;
  }
  if (pending.milestone === "requested") {
    return "Cannot plan an attempt before the old session is stopped.";
  }
  if (pending.attempts.some((attempt) => attempt.status === "planned")) {
    return "Another attempt is still unresolved.";
  }
  if (command.kind === "start") {
    if (command.generation === undefined) {
      return "A start attempt must reserve a generation.";
    }
    const last = lastStartGeneration(pending);
    if (last !== null && command.generation <= last) {
      return `Generations must increase; last was ${last}.`;
    }
    return null;
  }
  if (pending.milestone !== "packet-built") {
    return "Cannot submit before the packet is built.";
  }
  if (latestOfKind(pending, "start")?.status !== "succeeded") {
    return "Cannot submit without a succeeded start attempt.";
  }
  if (latestOfKind(pending, "submit") !== null && !pending.resendAllowed) {
    return "Sending again needs resolve(resend).";
  }
  return null;
}

function checkAwaitUser(
  pending: OrchestrationPendingProviderSwitch,
  command: CommandOf<"thread.provider-switch.await-user">,
): string | null {
  if (pending.status === "closing") {
    return `Provider switch '${pending.switchId}' is closing.`;
  }
  if (command.attemptId !== lastAttemptId(pending)) {
    return `The wait names attempt ${command.attemptId}; the latest is ${lastAttemptId(pending)}.`;
  }
  if (command.resumeCount !== pending.resumeCount) {
    return `The wait predates resume ${pending.resumeCount}.`;
  }
  if (pending.status === "awaiting-user") {
    // Recording the same wait twice is a no-op.
    return pending.awaitingReason === command.reason
      ? null
      : `Provider switch '${pending.switchId}' is already waiting for ${pending.awaitingReason}.`;
  }
  if (command.reason === "unknown-delivery") {
    return pending.deliveryUncertain
      ? null
      : "Delivery can only be unknown after a submit attempt was planned.";
  }
  // Retryable only if retry can lead to a submit: nothing was sent yet, or a
  // granted resend is still unspent (the restart failed, not the send).
  if (pending.deliveryUncertain && !pending.resendAllowed) {
    return "A submit may have reached the provider; its delivery is unknown, not retryable.";
  }
  return null;
}

/** Null when the revert may proceed; otherwise why it is refused (§4.4, §7.4). */
export function checkRevertAgainstProviderSwitch(
  state: OrchestrationThreadProviderSwitchState,
  turnCount: number,
): string | null {
  if (state.pending !== null) {
    return "Cannot revert while a provider switch is unresolved.";
  }
  const boundary = state.lastDelivered?.boundaryTurnCount;
  if (boundary !== undefined && turnCount <= boundary) {
    return `Cannot revert to turn ${turnCount}: the thread switched providers after turn ${boundary}.`;
  }
  return null;
}

function patchPending(
  state: OrchestrationThreadProviderSwitchState,
  switchId: string,
  patch: (pending: OrchestrationPendingProviderSwitch) => OrchestrationPendingProviderSwitch,
): OrchestrationThreadProviderSwitchState {
  if (state.pending === null || state.pending.switchId !== switchId) return state;
  const next = patch(state.pending);
  return next === state.pending ? state : { ...state, pending: next };
}

function resolvePending(
  state: OrchestrationThreadProviderSwitchState,
  switchId: string,
  extra: Partial<OrchestrationThreadProviderSwitchState> = {},
): OrchestrationThreadProviderSwitchState {
  const pending = state.pending;
  if (pending === null || pending.switchId !== switchId) return state;
  return {
    ...state,
    ...extra,
    pending: null,
    resolvedSwitchIds: [...state.resolvedSwitchIds, pending.switchId],
  };
}

const closedRecord = (
  state: OrchestrationThreadProviderSwitchState,
  reason: "aborted" | "discarded",
): Partial<OrchestrationThreadProviderSwitchState> =>
  state.pending === null
    ? {}
    : {
        lastClosed: {
          switchId: state.pending.switchId,
          from: state.pending.from,
          to: state.pending.to,
          reason,
          oldStopped: state.pending.milestone !== "requested",
        },
      };

const abandonPlanned = (attempts: ReadonlyArray<ProviderSwitchAttemptState>) =>
  attempts.map((attempt) =>
    attempt.status === "planned" ? { ...attempt, status: "abandoned" as const } : attempt,
  );

export function applyProviderSwitchEvent(
  state: OrchestrationThreadProviderSwitchState,
  event: ProviderSwitchEvent,
): OrchestrationThreadProviderSwitchState {
  switch (event.type) {
    case "thread.provider-switch-requested": {
      const payload = event.payload;
      if (state.pending !== null || state.resolvedSwitchIds.includes(payload.switchId)) {
        return state;
      }
      return {
        ...state,
        hasHistory: true,
        pending: {
          switchId: payload.switchId,
          from: payload.from,
          to: payload.to,
          triggerMessageId: payload.triggerMessageId,
          boundaryTurnCount: payload.boundaryTurnCount,
          status: "in-progress",
          awaitingReason: null,
          milestone: "requested",
          packet: null,
          attempts: [],
          deliveryUncertain: false,
          resendAllowed: false,
          resumeCount: 0,
          requestedAt: payload.createdAt,
        },
      };
    }
    case "thread.provider-switch-milestone-reached": {
      const payload = event.payload;
      if (payload.milestone === "old-stopped") {
        return patchPending(state, payload.switchId, (pending) =>
          pending.milestone === "requested" ? { ...pending, milestone: "old-stopped" } : pending,
        );
      }
      const pending = state.pending;
      if (
        pending === null ||
        pending.switchId !== payload.switchId ||
        payload.attemptId === undefined ||
        payload.turnId === undefined
      ) {
        return state;
      }
      return resolvePending(state, payload.switchId, {
        handoffUnconfirmedInstanceId: null,
        lastDelivered: {
          switchId: pending.switchId,
          attemptId: payload.attemptId,
          turnId: payload.turnId,
          boundaryTurnCount: pending.boundaryTurnCount,
        },
      });
    }
    case "thread.provider-switch-packet-built": {
      const payload = event.payload;
      return patchPending(state, payload.switchId, (pending) =>
        pending.milestone === "old-stopped" && pending.packet === null
          ? {
              ...pending,
              milestone: "packet-built",
              packet: {
                packetId: payload.packetId,
                sha256: payload.sha256,
                chars: payload.chars,
                includedMessages: payload.includedMessages,
                omittedMessages: payload.omittedMessages,
                truncated: payload.truncated,
              },
            }
          : pending,
      );
    }
    case "thread.provider-switch-attempt-recorded": {
      const payload = event.payload;
      return patchPending(state, payload.switchId, (pending) => {
        const index = pending.attempts.findIndex(
          (attempt) => attempt.attemptId === payload.attemptId,
        );
        if (payload.status === "planned") {
          if (index !== -1) return pending;
          return {
            ...pending,
            attempts: [
              ...pending.attempts,
              {
                attemptId: payload.attemptId,
                kind: payload.kind,
                status: "planned",
                generation: payload.generation ?? null,
                turnId: null,
              },
            ],
            deliveryUncertain: pending.deliveryUncertain || payload.kind === "submit",
            resendAllowed: payload.kind === "submit" ? false : pending.resendAllowed,
          };
        }
        const existing = pending.attempts[index];
        if (existing === undefined || existing.status !== "planned") return pending;
        const attempts = pending.attempts.slice();
        attempts[index] = {
          ...existing,
          status: payload.status,
          turnId: payload.turnId ?? null,
          ...(payload.model !== undefined ? { model: payload.model } : {}),
          ...(payload.acceptedGeneration !== undefined
            ? { acceptedGeneration: payload.acceptedGeneration }
            : {}),
        };
        return { ...pending, attempts };
      });
    }
    case "thread.provider-switch-awaiting-user":
      return patchPending(state, event.payload.switchId, (pending) =>
        pending.status === "awaiting-user" ||
        event.payload.attemptId !== lastAttemptId(pending) ||
        event.payload.resumeCount !== pending.resumeCount
          ? pending
          : {
              ...pending,
              status: "awaiting-user",
              awaitingReason: event.payload.reason,
              attempts: abandonPlanned(pending.attempts),
            },
      );
    case "thread.provider-switch-retry-requested":
      return patchPending(state, event.payload.switchId, (pending) =>
        pending.status === "awaiting-user" && pending.awaitingReason === "failed-retryable"
          ? {
              ...pending,
              status: "in-progress",
              awaitingReason: null,
              resumeCount: pending.resumeCount + 1,
            }
          : pending,
      );
    case "thread.provider-switch-aborted":
      return patchPending(state, event.payload.switchId, (pending) =>
        pending.status === "awaiting-user" && pending.awaitingReason === "failed-retryable"
          ? {
              ...pending,
              status: "closing",
              awaitingReason: null,
              closing: { returnToPrevious: event.payload.returnToPrevious },
            }
          : pending,
      );
    case "thread.provider-switch-closed":
      if (state.pending?.status !== "closing") return state;
      return resolvePending(state, event.payload.switchId, {
        ...closedRecord(state, "aborted"),
        // Only a session cleanup actually stopped stops being unconfirmed.
        ...(event.payload.releasedInstanceId !== undefined &&
        event.payload.releasedInstanceId === state.handoffUnconfirmedInstanceId
          ? { handoffUnconfirmedInstanceId: null }
          : {}),
      });
    case "thread.provider-switch-resolved":
      if (event.payload.decision === "discard") {
        const startedNew =
          state.pending?.switchId === event.payload.switchId &&
          state.pending.attempts.some(
            (attempt) => attempt.kind === "start" && attempt.status === "succeeded",
          );
        return resolvePending(state, event.payload.switchId, {
          ...closedRecord(state, "discarded"),
          // The new session is left running and may not have the packet.
          ...(startedNew && state.pending !== null
            ? { handoffUnconfirmedInstanceId: state.pending.to.instanceId }
            : {}),
        });
      }
      return patchPending(state, event.payload.switchId, (pending) =>
        pending.status === "awaiting-user" && pending.awaitingReason === "unknown-delivery"
          ? {
              ...pending,
              status: "in-progress",
              awaitingReason: null,
              resendAllowed: true,
              resumeCount: pending.resumeCount + 1,
            }
          : pending,
      );
  }
}
