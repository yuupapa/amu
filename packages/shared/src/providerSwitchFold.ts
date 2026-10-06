import {
  EMPTY_THREAD_PROVIDER_SWITCH_STATE,
  type OrchestrationTurnAssignment,
  type OrchestrationEvent,
  type OrchestrationPendingProviderSwitch,
  type OrchestrationThread,
  type OrchestrationThreadProviderSwitchState,
  type ProviderSwitchAttemptState,
} from "@t3tools/contracts";

// How a thread's cross-provider switch state follows its events (design
// §4.4). Pure and shared: the server's projectors and every client fold the
// same events with this one function, so all of them show the same state
// (§8.2, P11).

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

export const threadProviderSwitchState = (
  thread: Pick<OrchestrationThread, "providerSwitch">,
): OrchestrationThreadProviderSwitchState =>
  thread.providerSwitch ?? EMPTY_THREAD_PROVIDER_SWITCH_STATE;

export const lastAttemptId = (pending: OrchestrationPendingProviderSwitch) =>
  pending.attempts.at(-1)?.attemptId ?? 0;

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
      const delivery = {
        switchId: pending.switchId,
        attemptId: payload.attemptId,
        turnId: payload.turnId,
        boundaryTurnCount: pending.boundaryTurnCount,
        triggerMessageId: pending.triggerMessageId,
        from: pending.from,
        to: pending.to,
        packetId: pending.packet?.packetId ?? null,
      };
      return resolvePending(state, payload.switchId, {
        handoffUnconfirmedInstanceId: null,
        lastDelivered: delivery,
        deliveries: [...(state.deliveries ?? []), delivery],
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
              awaitingDetail: event.payload.detail ?? null,
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
              awaitingDetail: null,
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
              awaitingDetail: null,
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
              awaitingDetail: null,
              resendAllowed: true,
              resumeCount: pending.resumeCount + 1,
            }
          : pending,
      );
  }
}

/** True when the state carries nothing worth keeping on the thread. */
export const isEmptyProviderSwitchState = (state: OrchestrationThreadProviderSwitchState) =>
  state.pending === null && !state.hasHistory && state.revertsInFlight.length === 0;

/**
 * Adds a turn-assignment record (§5.4) the way the SQL projection does: the
 * first record for a turn wins; a later one naming another instance or model
 * only sets changedMidTurn. Returns the same array when nothing changes.
 */
export function applyTurnAssignmentRecord(
  assignments: ReadonlyArray<OrchestrationTurnAssignment>,
  record: Omit<OrchestrationTurnAssignment, "changedMidTurn">,
): ReadonlyArray<OrchestrationTurnAssignment> {
  const index = assignments.findIndex((assignment) => assignment.turnId === record.turnId);
  if (index === -1) return [...assignments, { ...record, changedMidTurn: false }];
  const existing = assignments[index]!;
  const changed = existing.instanceId !== record.instanceId || existing.model !== record.model;
  if (!changed || existing.changedMidTurn) return assignments;
  const next = assignments.slice();
  next[index] = { ...existing, changedMidTurn: true };
  return next;
}

/**
 * Joins the answerers of an older page into the loaded ones. The page's rows
 * come from the server's table, where the first record of a turn is settled,
 * so they win; a loaded record for the same turn (a live record seen before
 * the page) can only add that the answerer changed mid-turn.
 */
export function mergeTurnAssignmentPages(
  older: ReadonlyArray<OrchestrationTurnAssignment>,
  loaded: ReadonlyArray<OrchestrationTurnAssignment>,
): ReadonlyArray<OrchestrationTurnAssignment> {
  const olderByTurn = new Map(older.map((row) => [row.turnId, row]));
  const merged = loaded.map((row) => {
    const settled = olderByTurn.get(row.turnId);
    if (settled === undefined) return row;
    olderByTurn.delete(row.turnId);
    const changedMidTurn =
      settled.changedMidTurn ||
      row.changedMidTurn ||
      row.instanceId !== settled.instanceId ||
      row.model !== settled.model;
    return { ...settled, changedMidTurn };
  });
  return [...older.filter((row) => olderByTurn.has(row.turnId)), ...merged];
}
