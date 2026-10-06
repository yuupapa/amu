/**
 * Decides whether a thread's next turn can continue the provider's native
 * conversation, or needs an Amu handoff packet in a fresh provider session.
 *
 * The web client and the server share this so the model picker and the turn
 * start path never disagree. See docs/internals/cross-provider-handoff.md §3.1.
 */

export interface ProviderContinuationTarget {
  readonly instanceId: string;
  readonly driver: string;
  readonly continuationKey: string;
}

export interface ProviderContinuationBinding extends ProviderContinuationTarget {
  readonly hasResumeCursor: boolean;
  /** Bound to a provider switch whose packet has not been delivered yet. */
  readonly awaitingHandoffDelivery: boolean;
}

export interface ProviderContinuationSession extends ProviderContinuationTarget {
  /** Started by a provider switch whose packet has not been delivered yet. */
  readonly awaitingHandoffDelivery: boolean;
}

export interface ProviderContinuationInput {
  /** Persisted binding. Null when none exists or its instance was deleted. */
  readonly binding: ProviderContinuationBinding | null;
  readonly activeSession: ProviderContinuationSession | null;
  readonly desired: ProviderContinuationTarget & {
    readonly requiresNewThreadForModelChange: boolean;
    /** True when the requested model differs from the session's current model. */
    readonly modelChanged: boolean;
  };
  /** Whether delivered conversation exists, excluding the message being sent. */
  readonly threadHasPriorConversation: boolean;
}

export type ProviderContinuation = "native" | "handoff" | "fresh";

const sameContinuation = (a: ProviderContinuationTarget, b: ProviderContinuationTarget) =>
  a.driver === b.driver && a.continuationKey === b.continuationKey;

export function decideProviderContinuation(input: ProviderContinuationInput): ProviderContinuation {
  if (!input.threadHasPriorConversation) {
    return "fresh";
  }
  const blocksModelChange =
    input.desired.requiresNewThreadForModelChange && input.desired.modelChanged;
  const session = input.activeSession;
  if (
    session !== null &&
    !session.awaitingHandoffDelivery &&
    sameContinuation(session, input.desired) &&
    !blocksModelChange
  ) {
    return "native";
  }
  const binding = input.binding;
  if (
    session === null &&
    binding !== null &&
    binding.hasResumeCursor &&
    !binding.awaitingHandoffDelivery &&
    sameContinuation(binding, input.desired) &&
    !blocksModelChange
  ) {
    return "native";
  }
  return "handoff";
}

/**
 * Phase 1 allows a handoff only when both sides are allowlisted. Callers pass
 * the persisted binding's driver when the old instance was deleted.
 */
export function isProviderHandoffAllowed(input: {
  readonly fromDriver: string;
  readonly toDriver: string;
  readonly allowedDrivers: ReadonlyArray<string>;
}): boolean {
  return (
    input.allowedDrivers.includes(input.fromDriver) && input.allowedDrivers.includes(input.toDriver)
  );
}
