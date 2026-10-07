import type {
  CrossProviderHandoffSettings,
  MessageId,
  OrchestrationThread,
  ProviderInstanceId,
  ServerProvider,
  TurnId,
} from "@t3tools/contracts";
import { isProviderHandoffAllowed } from "@t3tools/shared/providerContinuation";
import { PROVIDER_SWITCH_OLD_CLIENT_HINT } from "@t3tools/shared/providerSwitchFold";

import { getTriggerDisplayModelName } from "./providerIconUtils";

// What the chat shows about cross-provider switches (design §8). Pure, so
// every pane renders the same server state the same way.

/** Only these drivers stamp session generations yet (§7.5, §17-5). */
const GENERATION_STAMPING_DRIVERS: ReadonlySet<string> = new Set(["claudeAgent", "codex"]);

export type SwitchProvider = Pick<
  ServerProvider,
  | "instanceId"
  | "driver"
  | "displayName"
  | "models"
  | "continuation"
  | "requiresNewThreadForModelChange"
>;

export interface SwitchParty {
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
}

type SwitchThread = Pick<
  OrchestrationThread,
  "providerSwitch" | "turnAssignments" | "session" | "modelSelection" | "messages" | "latestTurn"
>;

/** "Claude Opus 5.5" for a party, or its raw model id when the catalog lacks it. */
export function switchPartyLabel(
  party: SwitchParty,
  providers: ReadonlyArray<SwitchProvider>,
): string {
  const model = providers
    .find((provider) => provider.instanceId === party.instanceId)
    ?.models.find((entry) => entry.slug === party.model);
  return model ? getTriggerDisplayModelName(model) : party.model;
}

/** The provider's name, for telling two instances of one model apart (§8.3). */
function providerLabel(
  instanceId: ProviderInstanceId,
  providers: ReadonlyArray<SwitchProvider>,
): string {
  const provider = providers.find((entry) => entry.instanceId === instanceId);
  return provider?.displayName ?? provider?.driver ?? instanceId;
}

/**
 * The record of the current answerer: the latest turn's, else the newest
 * session generation's. A record saved late for an older turn (a retried
 * write) is appended last but must not pull the holder back.
 */
function currentAssignment(thread: SwitchThread) {
  const assignments = thread.turnAssignments ?? [];
  const latestTurnId = thread.latestTurn?.turnId;
  const forLatestTurn =
    latestTurnId === undefined
      ? undefined
      : assignments.find((assignment) => assignment.turnId === latestTurnId);
  if (forLatestTurn !== undefined) return forLatestTurn;
  return assignments.reduce<(typeof assignments)[number] | undefined>(
    (best, assignment) =>
      best === undefined || (assignment.generation ?? -1) >= (best.generation ?? -1)
        ? assignment
        : best,
    undefined,
  );
}

/**
 * Who holds the conversation now: the current recorded answerer, else the live
 * session's instance with the thread's model. thread.modelSelection alone is
 * the next send's pick (/compact saves it but compacts on the holder), so it
 * only stands in when nothing was recorded. Null before any turn.
 */
export function conversationOwner(thread: SwitchThread): SwitchParty | null {
  const last = currentAssignment(thread);
  if (last !== undefined) return { instanceId: last.instanceId, model: last.model };
  const sessionInstance = thread.session?.providerInstanceId;
  if (sessionInstance !== undefined) {
    return { instanceId: sessionInstance, model: thread.modelSelection.model };
  }
  if (thread.latestTurn !== null || thread.messages.length > 0) {
    return { instanceId: thread.modelSelection.instanceId, model: thread.modelSelection.model };
  }
  return null;
}

/**
 * Whether sending with `selection` hands the conversation over instead of
 * continuing it natively (§3.1, as far as a client can tell; the server
 * decides): another driver or continuation group, or a model change the
 * instance cannot make within the thread.
 */
export function predictsHandoff(
  owner: SwitchParty | null,
  selection: SwitchParty,
  providers: ReadonlyArray<SwitchProvider>,
  hints: SwitchContinuationHints = NO_HINTS,
): boolean {
  if (owner === null) return false;
  // The last switch was closed after the old session stopped: its cursor is
  // gone, so the next send hands over whatever is picked (§8.2).
  if (hints.released) return true;
  // A session that never received its packet cannot continue natively (§3.1).
  if (hints.unconfirmedInstanceId === selection.instanceId) return true;
  const from = providers.find((provider) => provider.instanceId === owner.instanceId);
  if (owner.instanceId === selection.instanceId) {
    return from?.requiresNewThreadForModelChange === true && owner.model !== selection.model;
  }
  const to = providers.find((provider) => provider.instanceId === selection.instanceId);
  if (from === undefined || to === undefined) return true;
  const groupOf = (provider: SwitchProvider) =>
    provider.continuation?.groupKey ?? `${provider.driver}:${provider.instanceId}`;
  return from.driver !== to.driver || groupOf(from) !== groupOf(to);
}

/** What the client knows that can force a handoff even to the same model. */
export interface SwitchContinuationHints {
  readonly released: boolean;
  readonly unconfirmedInstanceId: ProviderInstanceId | null;
}
const NO_HINTS: SwitchContinuationHints = { released: false, unconfirmedInstanceId: null };

export function switchContinuationHints(
  thread: Pick<OrchestrationThread, "providerSwitch">,
): SwitchContinuationHints {
  const state = thread.providerSwitch;
  if (state === undefined) return NO_HINTS;
  const lastResolved = state.resolvedSwitchIds.at(-1);
  const closed = state.lastClosed ?? null;
  return {
    released:
      state.pending === null &&
      closed !== null &&
      closed.oldStopped &&
      lastResolved === closed.switchId,
    unconfirmedInstanceId: state.handoffUnconfirmedInstanceId ?? null,
  };
}

/** The user message's send state when it did not simply go out (§4.5, §8.2). */
export function userMessageDeliveryLabel(
  state: OrchestrationThread["messages"][number]["deliveryState"],
): string | null {
  switch (state) {
    case "cancelled":
      return "未送信・取消";
    case "unknown-discarded":
      return "届いたか不明・再送なし";
    case "rejected":
      return "未送信";
    default:
      return null;
  }
}

/**
 * Whether the picker may offer a switch to `targetDriver` now (§8.1): the
 * feature is on, both drivers are allowed, the target stamps generations,
 * and the thread is not working, waiting on the user, or switching.
 */
export function canOfferHandoffTo(input: {
  readonly settings: Pick<CrossProviderHandoffSettings, "enabled" | "allowedDrivers">;
  readonly ownerDriver: string | null;
  readonly targetDriver: string;
  readonly threadBusy: boolean;
  readonly switchPending: boolean;
}): boolean {
  return (
    input.settings.enabled &&
    input.ownerDriver !== null &&
    !input.threadBusy &&
    !input.switchPending &&
    GENERATION_STAMPING_DRIVERS.has(input.targetDriver) &&
    isProviderHandoffAllowed({
      fromDriver: input.ownerDriver,
      toDriver: input.targetDriver,
      allowedDrivers: input.settings.allowedDrivers,
    })
  );
}

/**
 * Why the picker offers no switch now, when only the thread's state stands in
 * the way (§8.1). Null when the feature is off: the old lock message applies.
 */
export function handoffLockReason(input: {
  readonly enabled: boolean;
  readonly threadBusy: boolean;
  readonly waitsOnUser: boolean;
  readonly switchPending: boolean;
}): string | null {
  if (!input.enabled) return null;
  if (input.switchPending) return "モデルの乗り換え中です。終わってから選んでください。";
  if (input.waitsOnUser) {
    return "質問か承認への返答を待っています。返答してから選んでください。";
  }
  if (input.threadBusy) return "応答中は乗り換えられません。応答が終わってから選んでください。";
  return null;
}

/**
 * session.lastError as this client shows it. The server writes the switch
 * failure there for older clients (§8.6); this client shows the switch banner.
 */
export function visibleSessionError(lastError: string | null | undefined): string | null {
  if (lastError === null || lastError === undefined) return null;
  return lastError.endsWith(PROVIDER_SWITCH_OLD_CLIENT_HINT) ? null : lastError;
}

/** What the composer shows while a switch is unresolved (§8.2). */
export type SwitchBannerModel =
  | { readonly kind: "in-progress"; readonly toLabel: string }
  | { readonly kind: "closing"; readonly returnToPrevious: boolean }
  | {
      readonly kind: "failed-retryable";
      readonly switchId: string;
      readonly from: SwitchParty;
      readonly fromLabel: string;
      readonly toLabel: string;
      readonly detail: string | null;
    }
  | {
      readonly kind: "unknown-delivery";
      readonly switchId: string;
      readonly toLabel: string;
      readonly detail: string | null;
    };

export function switchBannerModel(
  thread: Pick<OrchestrationThread, "providerSwitch">,
  providers: ReadonlyArray<SwitchProvider>,
): SwitchBannerModel | null {
  const pending = thread.providerSwitch?.pending ?? null;
  if (pending === null) return null;
  const toLabel = switchPartyLabel(pending.to, providers);
  if (pending.status === "closing") {
    return { kind: "closing", returnToPrevious: pending.closing?.returnToPrevious === true };
  }
  if (pending.status === "in-progress") return { kind: "in-progress", toLabel };
  const detail = pending.awaitingDetail ?? null;
  if (pending.awaitingReason === "unknown-delivery") {
    return { kind: "unknown-delivery", switchId: pending.switchId, toLabel, detail };
  }
  return {
    kind: "failed-retryable",
    switchId: pending.switchId,
    from: { instanceId: pending.from.instanceId, model: pending.from.model },
    fromLabel: switchPartyLabel(pending.from, providers),
    toLabel,
    detail,
  };
}

/** Why a revert to `turnCount` is refused, with the server's words (§7.4). */
export function switchRevertBlock(
  thread: Pick<OrchestrationThread, "providerSwitch">,
  turnCount: number,
): string | null {
  const state = thread.providerSwitch;
  if (state === undefined) return null;
  if (state.pending !== null) return "モデルの乗り換え中は戻せません。";
  const boundary = state.lastDelivered?.boundaryTurnCount;
  if (boundary !== undefined && turnCount <= boundary) {
    return "この操作は、モデルを乗り換えた所より前には戻せません。";
  }
  return null;
}

/** One divider per delivered switch, above the message the new model answered (§8.3). */
export interface HandoffDivider {
  readonly label: string;
  readonly providerLabel: string;
  readonly packetId: string | null;
}

export function handoffDividers(
  thread: Pick<OrchestrationThread, "providerSwitch">,
  providers: ReadonlyArray<SwitchProvider>,
): ReadonlyMap<MessageId, HandoffDivider> {
  const dividers = new Map<MessageId, HandoffDivider>();
  for (const delivery of thread.providerSwitch?.deliveries ?? []) {
    if (delivery.triggerMessageId === undefined || delivery.to === undefined) continue;
    dividers.set(delivery.triggerMessageId, {
      label: switchPartyLabel(delivery.to, providers),
      providerLabel: providerLabel(delivery.to.instanceId, providers),
      packetId: delivery.packetId ?? null,
    });
  }
  return dividers;
}

/**
 * The answering model of a turn, from its record (§8.4). Threads that never
 * switched show nothing; switched threads say when the record is missing.
 */
export function answeringModelLabel(
  thread: Pick<OrchestrationThread, "providerSwitch" | "turnAssignments">,
  turnId: TurnId | null,
  providers: ReadonlyArray<SwitchProvider>,
): string | null {
  if (thread.providerSwitch?.hasHistory !== true) return null;
  const assignment =
    turnId === null ? undefined : thread.turnAssignments?.find((entry) => entry.turnId === turnId);
  return assignment === undefined ? "担当モデル不明" : switchPartyLabel(assignment, providers);
}

/** What the new model does not receive (§6.8), shown the first time (decision 3). */
export const HANDOFF_NOT_CARRIED =
  "引き継がれないもの: 思考過程、ツールの入出力の全文、添付画像の中身、コンポーザー文脈の中身、内部で圧縮された文脈、コミット一覧";

/**
 * Lets only the latest of overlapping requests land (the packet dialog):
 * starting a request or cancelling voids every earlier one.
 */
export function makeLatestRequestGate() {
  let current = 0;
  return {
    begin: () => ++current,
    cancel: () => {
      current += 1;
    },
    isCurrent: (id: number) => id === current,
  };
}
