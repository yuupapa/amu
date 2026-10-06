import {
  CommandId,
  ProviderSwitchId,
  ProviderSwitchPacketId,
  type ChatAttachment,
  type CrossProviderHandoffSettings,
  type MessageId,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationMessage,
  type OrchestrationPendingProviderSwitch,
  type OrchestrationThreadShell,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderSwitchAwaitReason,
  type ProviderSwitchParty,
  type ServerSettingsError,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import {
  decideProviderContinuation,
  isProviderHandoffAllowed,
} from "@t3tools/shared/providerContinuation";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import type { OrchestrationDispatchError } from "../Errors.ts";
import type { ProjectionThreadProviderSwitchRepositoryShape } from "../../persistence/Services/ProjectionThreadProviderSwitches.ts";
import type { ProviderServiceShape } from "../../provider/Services/ProviderService.ts";
import { expandProviderTurnText } from "../../provider/providerTurnText.ts";
import { buildHandoffPacket, computeHandoffBudget } from "../CrossProviderHandoff.ts";
import { assembleHandoffSource } from "../handoffSource.ts";
import { sha256Hex } from "../providerSwitchState.ts";
import { expandTurnInputText } from "../turnInputText.ts";

// The server side of one cross-provider switch (design §4.6, §7). Every step
// is recorded before the next starts, so a failure always lands in a state
// the user can resolve (§8.2) and a restart can pick it up (§9.1).

export const PENDING_SWITCH_REJECTION =
  "乗り換えの途中です。完了を待つか、表示中の選択肢から選んでください。";
const NOT_ALLOWED_DETAIL = "このモデルへの乗り換えはまだ対応していません。";
const REQUIRED_EXCEEDS_DETAIL =
  "今回の発言が長すぎて、引き継ぎに必要な情報を入れられません。発言を短くするか、新しいチャットで始めてください。";

/** A reactor step the flow depends on failed; `detail` is shown to the user. */
export class ProviderSwitchStepError extends Schema.TaggedError<ProviderSwitchStepError>()(
  "ProviderSwitchStepError",
  { step: Schema.String, detail: Schema.String },
) {}

export interface ProviderSwitchFlowDeps {
  readonly dispatch: (
    command: OrchestrationCommand,
  ) => Effect.Effect<unknown, OrchestrationDispatchError>;
  readonly providerService: ProviderServiceShape;
  readonly switches: ProjectionThreadProviderSwitchRepositoryShape;
  readonly getSettings: Effect.Effect<CrossProviderHandoffSettings, ServerSettingsError>;
  readonly randomId: Effect.Effect<string, PlatformError.PlatformError>;
  readonly nowIso: Effect.Effect<string>;
  readonly attachmentsDir: string;
  readonly requiresNewThreadForModelChange: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<boolean>;
  /** Starts the new provider's session; the handoff path skips the cross-driver guards. */
  readonly startHandoffSession: (input: {
    readonly threadId: ThreadId;
    readonly createdAt: string;
    readonly modelSelection: ModelSelection;
  }) => Effect.Effect<unknown, ProviderSwitchStepError>;
  readonly appendTurnStartFailure: (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly summary: string;
    readonly detail: string;
    readonly createdAt: string;
  }) => Effect.Effect<unknown, ProviderSwitchStepError>;
  readonly resolveCwd: (thread: OrchestrationThreadShell) => Effect.Effect<string | null>;
}

export type ProviderSwitchDecision =
  | { readonly kind: "native" }
  | { readonly kind: "refuse"; readonly detail: string }
  | {
      readonly kind: "handoff";
      readonly from: ProviderSwitchParty;
      readonly to: ProviderSwitchParty;
      readonly toSelection: ModelSelection;
    };

/** What the switch needs from the message being sent now. */
export interface ProviderSwitchTrigger {
  readonly message: Pick<OrchestrationMessage, "id" | "text" | "context" | "attachments">;
  readonly interactionMode?: "default" | "plan";
  readonly toSelection: ModelSelection;
}

const describeCause = (cause: Cause.Cause<unknown>) => Cause.pretty(cause);

export function makeProviderSwitchFlow(deps: ProviderSwitchFlowDeps) {
  const commandId = (tag: string) =>
    deps.randomId.pipe(Effect.map((id) => CommandId.make(`server:provider-switch-${tag}:${id}`)));

  const dispatchSwitch = (
    build: (base: { commandId: CommandId; createdAt: string }) => OrchestrationCommand,
    tag: string,
  ) =>
    Effect.gen(function* () {
      const base = { commandId: yield* commandId(tag), createdAt: yield* deps.nowIso };
      yield* deps.dispatch(build(base));
    });

  const readPending = (threadId: ThreadId) =>
    deps.switches
      .getStateByThreadId({ threadId })
      .pipe(Effect.map((row) => (Option.isSome(row) ? row.value.state.pending : null)));

  const markMessage = (
    threadId: ThreadId,
    messageId: MessageId,
    state: "pending" | "rejected" | "delivered",
    reason?: string,
  ) =>
    dispatchSwitch(
      (base) => ({
        type: "thread.message.delivery-state.set",
        ...base,
        threadId,
        messageId,
        state,
        ...(reason !== undefined ? { reason } : {}),
      }),
      "delivery-state",
    );

  /**
   * §9.3: while a switch is unresolved every new send is refused from the DB
   * state alone. Only the message and one activity change; the live session
   * and its running turn are left alone.
   */
  const rejectTurnStartIfSwitchPending = Effect.fn("rejectTurnStartIfSwitchPending")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly messageId: MessageId;
      readonly createdAt: string;
    }) {
      const pending = yield* readPending(input.threadId);
      if (pending === null) return false;
      yield* markMessage(input.threadId, input.messageId, "rejected", PENDING_SWITCH_REJECTION);
      yield* deps.appendTurnStartFailure({
        threadId: input.threadId,
        messageId: input.messageId,
        summary: "送信できませんでした",
        detail: PENDING_SWITCH_REJECTION,
        createdAt: input.createdAt,
      });
      return true;
    },
  );

  const instanceDriver = (instanceId: ProviderInstanceId) =>
    deps.providerService.getInstanceInfo(instanceId).pipe(
      Effect.map((info) => ({
        driver: info.driverKind,
        continuationKey: info.continuationIdentity.continuationKey,
      })),
      Effect.option,
    );

  /** §3.1 with the live session and the binding, not thread.modelSelection, as the current side. */
  const decide = Effect.fn("decideProviderSwitch")(function* (input: {
    readonly thread: OrchestrationThreadShell;
    readonly requestedModelSelection: ModelSelection | undefined;
    readonly triggerMessageId: MessageId;
  }) {
    const settings = yield* deps.getSettings;
    if (!settings.enabled) return { kind: "native" } as ProviderSwitchDecision;
    const { thread } = input;
    const toSelection = input.requestedModelSelection ?? thread.modelSelection;
    const desired = yield* instanceDriver(toSelection.instanceId);
    // An unknown target keeps the existing path, which reports it.
    if (Option.isNone(desired)) return { kind: "native" } as ProviderSwitchDecision;

    const active = (yield* deps.providerService.listSessions()).find(
      (session) => session.threadId === thread.id,
    );
    const activeInfo =
      active?.providerInstanceId === undefined
        ? Option.none()
        : yield* instanceDriver(active.providerInstanceId);
    const binding = yield* deps.providerService
      .getThreadBinding(thread.id)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    const bindingInfo = Option.isSome(binding)
      ? yield* instanceDriver(binding.value.instanceId)
      : Option.none();

    // The selection may already name the new model (the client updates it
    // before sending), so the old model comes from the session or binding.
    const boundModel = Option.isSome(binding) ? binding.value.model : null;
    const currentModel =
      active?.model ??
      boundModel ??
      (Option.isSome(binding) && binding.value.instanceId === thread.modelSelection.instanceId
        ? thread.modelSelection.model
        : null);
    // Only delivered messages are a conversation to hand over (§4.5).
    const hasPriorConversation = yield* deps.switches.hasDeliveredUserMessage({
      threadId: thread.id,
      excludeMessageId: input.triggerMessageId,
    });
    const decision = decideProviderContinuation({
      binding:
        Option.isSome(binding) && Option.isSome(bindingInfo)
          ? {
              instanceId: binding.value.instanceId,
              driver: bindingInfo.value.driver,
              continuationKey: bindingInfo.value.continuationKey,
              hasResumeCursor: binding.value.hasResumeCursor,
              awaitingHandoffDelivery: false,
            }
          : null,
      activeSession:
        active?.providerInstanceId !== undefined && Option.isSome(activeInfo)
          ? {
              instanceId: active.providerInstanceId,
              driver: activeInfo.value.driver,
              continuationKey: activeInfo.value.continuationKey,
              awaitingHandoffDelivery: false,
            }
          : null,
      desired: {
        instanceId: toSelection.instanceId,
        driver: desired.value.driver,
        continuationKey: desired.value.continuationKey,
        requiresNewThreadForModelChange: yield* deps.requiresNewThreadForModelChange(
          toSelection.instanceId,
        ),
        modelChanged: toSelection.model !== currentModel,
      },
      threadHasPriorConversation: hasPriorConversation,
    });
    if (decision !== "handoff") return { kind: "native" } as ProviderSwitchDecision;

    const fromInstanceId =
      active?.providerInstanceId ??
      (Option.isSome(binding) ? binding.value.instanceId : thread.modelSelection.instanceId);
    const fromDriver: ProviderDriverKind | null = Option.isSome(activeInfo)
      ? activeInfo.value.driver
      : Option.isSome(binding)
        ? binding.value.driver
        : Option.getOrNull(
            Option.map(yield* instanceDriver(fromInstanceId), (info) => info.driver),
          );
    if (
      fromDriver === null ||
      !isProviderHandoffAllowed({
        fromDriver,
        toDriver: desired.value.driver,
        allowedDrivers: settings.allowedDrivers,
      })
    ) {
      return { kind: "refuse", detail: NOT_ALLOWED_DETAIL } as ProviderSwitchDecision;
    }
    // §7.3: the old provider must be idle and not waiting on the user.
    const oldModel = currentModel ?? "前のモデル";
    if (thread.session?.status === "running" || thread.session?.status === "starting") {
      return {
        kind: "refuse",
        detail: `${oldModel}が作業中です。停止してから切り替えてください。`,
      } as ProviderSwitchDecision;
    }
    if (thread.hasPendingApprovals || thread.hasPendingUserInput) {
      const what = thread.hasPendingApprovals ? "承認" : "質問";
      return {
        kind: "refuse",
        detail: `${oldModel}の${what}に応答してから切り替えてください。`,
      } as ProviderSwitchDecision;
    }
    return {
      kind: "handoff",
      from: { instanceId: fromInstanceId, driver: fromDriver, model: currentModel ?? "不明" },
      to: {
        instanceId: toSelection.instanceId,
        driver: desired.value.driver,
        model: toSelection.model,
      },
      toSelection,
    } as ProviderSwitchDecision;
  });

  const lastAttemptId = (pending: OrchestrationPendingProviderSwitch) =>
    pending.attempts.at(-1)?.attemptId ?? 0;

  const awaitUser = (
    threadId: ThreadId,
    switchId: ProviderSwitchId,
    reason: ProviderSwitchAwaitReason,
    detail: string,
  ) =>
    Effect.gen(function* () {
      const pending = yield* readPending(threadId);
      if (pending === null || pending.switchId !== switchId) return;
      yield* dispatchSwitch(
        (base) => ({
          type: "thread.provider-switch.await-user",
          ...base,
          threadId,
          switchId,
          attemptId: lastAttemptId(pending),
          resumeCount: pending.resumeCount,
          reason,
          detail,
        }),
        "await-user",
      );
    });

  /** A message saved pending must settle, even if the feature was turned off since. */
  const isTracked = (messageId: MessageId) =>
    deps.switches
      .getMessageDeliveryState({ messageId })
      .pipe(Effect.map((state) => state === "pending"));

  /**
   * Normal path: record who accepted the turn from the send result itself, so
   * a later session change cannot be attributed to it (§5.4). The decider marks
   * the message delivered in the same commit. Retried, because a tracked
   * message left pending would drop out of the next handoff.
   */
  const recordNativeTurnAssignment = Effect.fn("recordNativeTurnAssignment")(function* (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly result: {
      readonly turnId: TurnId;
      readonly providerInstanceId?: ProviderInstanceId | undefined;
      readonly provider?: ProviderDriverKind | undefined;
      readonly model?: string | undefined;
    };
  }) {
    const enabled = (yield* deps.getSettings).enabled;
    if (!enabled && !(yield* isTracked(input.messageId))) return;
    const { result } = input;
    if (
      result.providerInstanceId === undefined ||
      result.provider === undefined ||
      result.model === undefined
    ) {
      // Accepted, but the adapter did not say which model ran it: the message
      // is still delivered, only the answerer stays unknown.
      const id = yield* commandId("delivery-state");
      const createdAt = yield* deps.nowIso;
      yield* deps
        .dispatch({
          type: "thread.message.delivery-state.set",
          commandId: id,
          threadId: input.threadId,
          messageId: input.messageId,
          state: "delivered",
          createdAt,
        })
        .pipe(Effect.retry({ times: 4, schedule: Schedule.exponential("100 millis") }));
      return;
    }
    const party = {
      instanceId: result.providerInstanceId,
      driver: result.provider,
      model: result.model,
    };
    // One command id for every attempt: a retry after an unseen success is a no-op.
    const id = yield* commandId("turn-assignment");
    const createdAt = yield* deps.nowIso;
    yield* deps
      .dispatch({
        type: "thread.turn-assignment.record",
        commandId: id,
        threadId: input.threadId,
        messageId: input.messageId,
        turnId: result.turnId,
        instanceId: party.instanceId,
        driver: party.driver,
        model: party.model,
        generation: null,
        createdAt,
      })
      .pipe(Effect.retry({ times: 4, schedule: Schedule.exponential("100 millis") }));
  });

  /** A tracked send that failed is not part of any handoff (§4.5). */
  const markSendRejected = Effect.fn("markSendRejected")(function* (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly detail: string;
  }) {
    if (!(yield* isTracked(input.messageId))) return;
    yield* markMessage(input.threadId, input.messageId, "rejected", input.detail);
  });

  /**
   * Runs the switch forward from wherever its milestones and attempts stand.
   * Each failure is recorded as a wait for the user and ends the run.
   */
  const runSwitchSteps = Effect.fn("runProviderSwitchSteps")(function* (input: {
    readonly thread: OrchestrationThreadShell;
    readonly switchId: ProviderSwitchId;
    readonly trigger: ProviderSwitchTrigger;
  }) {
    const threadId = input.thread.id;
    const { switchId, trigger } = input;
    const failRetryable = (detail: string) =>
      awaitUser(threadId, switchId, "failed-retryable", detail);

    let pending = yield* readPending(threadId);
    if (pending === null || pending.switchId !== switchId || pending.status !== "in-progress")
      return;

    // 1. Stop the old session and forget its resume cursor.
    if (pending.milestone === "requested") {
      const released = yield* deps.providerService.releaseThreadForHandoff(threadId).pipe(
        Effect.as(true),
        Effect.catchCause((cause) => failRetryable(describeCause(cause)).pipe(Effect.as(false))),
      );
      if (!released) return;
      yield* dispatchSwitch(
        (base) => ({
          type: "thread.provider-switch.milestone",
          ...base,
          threadId,
          switchId,
          milestone: "old-stopped",
        }),
        "old-stopped",
      );
      pending = yield* readPending(threadId);
      if (pending === null) return;
    }

    // 2. A live session for the new provider, started by a succeeded attempt.
    const latestStart = pending.attempts.findLast((attempt) => attempt.kind === "start");
    const live = (yield* deps.providerService.listSessions()).some(
      (session) =>
        session.threadId === threadId && session.providerInstanceId === pending!.to.instanceId,
    );
    let generation = latestStart?.generation ?? null;
    if (latestStart?.status !== "succeeded" || !live) {
      const attemptId = lastAttemptId(pending) + 1;
      generation =
        pending.attempts.reduce(
          (max, attempt) =>
            attempt.kind === "start" && attempt.generation !== null
              ? Math.max(max, attempt.generation)
              : max,
          0,
        ) + 1;
      const startGeneration = generation;
      yield* dispatchSwitch(
        (base) => ({
          type: "thread.provider-switch.attempt",
          ...base,
          threadId,
          switchId,
          attemptId,
          kind: "start",
          status: "planned",
          generation: startGeneration,
        }),
        "start-planned",
      );
      const started = yield* deps
        .startHandoffSession({
          threadId,
          createdAt: yield* deps.nowIso,
          modelSelection: trigger.toSelection,
        })
        .pipe(
          Effect.as({ ok: true as const }),
          Effect.catchCause((cause) =>
            Effect.succeed({ ok: false as const, detail: describeCause(cause) }),
          ),
        );
      yield* dispatchSwitch(
        (base) => ({
          type: "thread.provider-switch.attempt",
          ...base,
          threadId,
          switchId,
          attemptId,
          kind: "start",
          status: started.ok ? "succeeded" : "failed",
          ...(started.ok ? {} : { detail: started.detail }),
        }),
        "start-result",
      );
      if (!started.ok) {
        yield* failRetryable(started.detail);
        return;
      }
      pending = yield* readPending(threadId);
      if (pending === null) return;
    }

    // 3. The packet: built once, then always the stored text (§4.2).
    let packetText: string;
    if (pending.packet !== null) {
      const stored = yield* deps.switches.getPacket({ packetId: pending.packet.packetId });
      if (Option.isNone(stored)) {
        yield* failRetryable("保存した引き継ぎ内容が見つかりませんでした。");
        return;
      }
      packetText = stored.value.text;
    } else {
      const settings = yield* deps.getSettings;
      const composed = expandTurnInputText(trigger.message);
      const expanded = expandProviderTurnText({
        text: composed,
        attachments: (trigger.message.attachments ?? []) as ReadonlyArray<ChatAttachment>,
        attachmentsDir: deps.attachmentsDir,
      });
      if (expanded._tag === "attachment-context-too-long") {
        yield* failRetryable(REQUIRED_EXCEEDS_DETAIL);
        return;
      }
      const expandedNow = expanded.text ?? "";
      const rows = yield* deps.switches.readHandoffSource({
        threadId,
        triggerMessageId: trigger.message.id,
      });
      const source = assembleHandoffSource({
        rows,
        cwd: yield* deps.resolveCwd(input.thread),
        fromDriver: pending.from.driver,
        fromModel: pending.from.model,
        fromTurnCount: pending.boundaryTurnCount,
        // §6.3 changes come with the checkpoint diff in a later step.
        changes: null,
      });
      const built = buildHandoffPacket({
        source,
        expandedNow,
        budgetChars: computeHandoffBudget(expandedNow, settings.packetBudgetChars),
      });
      if (built._tag === "required-exceeds-budget") {
        yield* failRetryable(REQUIRED_EXCEEDS_DETAIL);
        return;
      }
      packetText = built.text;
      const packetId = ProviderSwitchPacketId.make(`packet-${yield* deps.randomId}`);
      yield* dispatchSwitch(
        (base) => ({
          type: "thread.provider-switch.packet",
          ...base,
          threadId,
          switchId,
          packetId,
          text: built.text,
          sha256: sha256Hex(built.text),
          chars: built.text.length,
          includedMessages: built.stats.includedMessages,
          omittedMessages: built.stats.omittedMessages,
          truncated: built.stats.truncated,
        }),
        "packet",
      );
      pending = yield* readPending(threadId);
      if (pending === null) return;
    }

    // 4. Send. From here a failure may have reached the provider (§9.2).
    const submitId = lastAttemptId(pending) + 1;
    yield* dispatchSwitch(
      (base) => ({
        type: "thread.provider-switch.attempt",
        ...base,
        threadId,
        switchId,
        attemptId: submitId,
        kind: "submit",
        status: "planned",
      }),
      "submit-planned",
    );
    const sent = yield* deps.providerService
      .sendTurn({
        threadId,
        input: packetText,
        ...(trigger.message.attachments !== undefined && trigger.message.attachments.length > 0
          ? { attachments: trigger.message.attachments as ReadonlyArray<ChatAttachment> }
          : {}),
        modelSelection: trigger.toSelection,
        ...(trigger.interactionMode !== undefined
          ? { interactionMode: trigger.interactionMode }
          : {}),
        inputTextExpanded: true,
      })
      .pipe(
        Effect.map((result) => ({
          ok: true as const,
          turnId: result.turnId,
          model: result.model,
        })),
        Effect.catchCause((cause) =>
          Effect.succeed({ ok: false as const, detail: describeCause(cause) }),
        ),
      );
    if (!sent.ok) {
      yield* awaitUser(threadId, switchId, "unknown-delivery", sent.detail);
      return;
    }
    const delivered = Effect.gen(function* () {
      yield* dispatchSwitch(
        (base) => ({
          type: "thread.provider-switch.attempt",
          ...base,
          threadId,
          switchId,
          attemptId: submitId,
          kind: "submit",
          status: "succeeded",
          turnId: sent.turnId,
        }),
        "submit-succeeded",
      );
      yield* dispatchSwitch(
        (base) => ({
          type: "thread.provider-switch.milestone",
          ...base,
          threadId,
          switchId,
          milestone: "delivered",
          attemptId: submitId,
          turnId: sent.turnId,
          ...(sent.model !== undefined && sent.model.trim().length > 0
            ? { model: sent.model }
            : {}),
        }),
        "delivered",
      );
    });
    // turnId was received: a failure to record it means the turn may be running.
    yield* delivered.pipe(
      Effect.catchCause((cause) =>
        awaitUser(threadId, switchId, "unknown-delivery", describeCause(cause)),
      ),
    );
  });

  /**
   * Any failure after the request lands in a wait the user can resolve:
   * unknown-delivery once a submit may have reached the provider, otherwise
   * failed-retryable (§4.4, §9.2). Only a failure to record even that is left
   * to startup recovery.
   */
  const continueSwitch = Effect.fn("continueProviderSwitch")(function* (input: {
    readonly thread: OrchestrationThreadShell;
    readonly switchId: ProviderSwitchId;
    readonly trigger: ProviderSwitchTrigger;
  }) {
    yield* runSwitchSteps(input).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          const pending = yield* readPending(input.thread.id);
          if (
            pending === null ||
            pending.switchId !== input.switchId ||
            pending.status !== "in-progress"
          ) {
            return;
          }
          const latestSubmit = pending.attempts.findLast((attempt) => attempt.kind === "submit");
          const mayHaveReachedProvider =
            latestSubmit?.status === "planned" ||
            latestSubmit?.status === "succeeded" ||
            (pending.deliveryUncertain && !pending.resendAllowed);
          yield* awaitUser(
            input.thread.id,
            input.switchId,
            mayHaveReachedProvider ? "unknown-delivery" : "failed-retryable",
            describeCause(cause),
          );
        }),
      ),
    );
  });

  /**
   * Records the switch request (§4.6). Runs inside the reactor worker so the
   * pending switch exists before the next send is processed (§9.3); the rest
   * runs from continueSwitch. Returns null when the decider refused it.
   */
  const requestSwitch = Effect.fn("requestProviderSwitch")(function* (input: {
    readonly thread: OrchestrationThreadShell;
    readonly from: ProviderSwitchParty;
    readonly to: ProviderSwitchParty;
    readonly triggerMessageId: MessageId;
    readonly createdAt: string;
  }) {
    const threadId = input.thread.id;
    const switchId = ProviderSwitchId.make(`switch-${yield* deps.randomId}`);
    const boundaryTurnCount = yield* deps.switches.getLatestCheckpointTurnCount({ threadId });
    const requested = yield* dispatchSwitch(
      (base) => ({
        type: "thread.provider-switch.request",
        ...base,
        threadId,
        switchId,
        from: input.from,
        to: input.to,
        triggerMessageId: input.triggerMessageId,
        boundaryTurnCount,
      }),
      "request",
    ).pipe(
      Effect.as({ ok: true as const }),
      Effect.catchCause((cause) =>
        Effect.succeed({ ok: false as const, detail: describeCause(cause) }),
      ),
    );
    if (!requested.ok) {
      // Refused by the decider (another switch or a revert in flight).
      yield* refuseSwitch({
        threadId,
        messageId: input.triggerMessageId,
        detail: requested.detail,
        createdAt: input.createdAt,
      });
      return null;
    }
    return switchId;
  });

  const refuseSwitch = (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    Effect.gen(function* () {
      yield* markMessage(input.threadId, input.messageId, "rejected", input.detail);
      yield* deps.appendTurnStartFailure({
        threadId: input.threadId,
        messageId: input.messageId,
        summary: "モデルを切り替えられませんでした",
        detail: input.detail,
        createdAt: input.createdAt,
      });
    });

  return {
    rejectTurnStartIfSwitchPending,
    decide,
    requestSwitch,
    continueSwitch,
    refuseSwitch,
    recordNativeTurnAssignment,
    markSendRejected,
  };
}

export type ProviderSwitchFlow = ReturnType<typeof makeProviderSwitchFlow>;
