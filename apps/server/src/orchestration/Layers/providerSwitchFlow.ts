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
import {
  buildHandoffPacket,
  computeHandoffBudget,
  type HandoffChangedFile,
} from "../CrossProviderHandoff.ts";
import { assembleHandoffSource } from "../handoffSource.ts";
import { sha256Hex } from "../providerSwitchState.ts";
import { expandTurnInputText } from "../turnInputText.ts";

// The server side of one cross-provider switch (design §4.6, §7). Every step
// is recorded before the next starts, so a failure always lands in a state
// the user can resolve (§8.2) and a restart can pick it up (§9.1).

export const PENDING_SWITCH_REJECTION =
  "乗り換えの途中です。完了を待つか、表示中の選択肢から選んでください（選択肢が出ないときは、Amu の最新版で開いてください）。";
// Older clients show only the session error and cannot offer the choices (§8.6).
const OLD_CLIENT_HINT = "（選択肢は Amu の最新版で表示されます）";
const NOT_ALLOWED_DETAIL = "このモデルへの乗り換えはまだ対応していません。";
// Only these adapters stamp session generations yet (§7.5, §10). After a
// switch, events without one are dropped, so no other driver can take over.
const GENERATION_STAMPING_DRIVERS: ReadonlySet<string> = new Set(["claudeAgent", "codex"]);
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
    /** Reserved by the start attempt; ProviderService starts the session with it. */
    readonly sessionGeneration: number;
  }) => Effect.Effect<unknown, ProviderSwitchStepError>;
  readonly appendTurnStartFailure: (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly summary: string;
    readonly detail: string;
    readonly createdAt: string;
  }) => Effect.Effect<unknown, ProviderSwitchStepError>;
  readonly resolveCwd: (thread: OrchestrationThreadShell) => Effect.Effect<string | null>;
  /** The thread's final diff for [[AMU-CHANGES]]; null when it cannot be read (§6.3). */
  readonly readChanges: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<HandoffChangedFile> | null>;
  /** The thread and the switch's trigger message, to resume a stored switch. */
  readonly loadThread: (threadId: ThreadId) => Effect.Effect<OrchestrationThreadShell | null>;
  readonly loadMessage: (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
  }) => Effect.Effect<ProviderSwitchTrigger["message"] | null>;
  /** A switch stopped to wait for the user: the thread session must not stay "starting". */
  readonly markSessionFailed: (input: {
    readonly threadId: ThreadId;
    readonly detail: string;
  }) => Effect.Effect<unknown, ProviderSwitchStepError>;
  /** The full model selection last used on the thread, only when it names this exact party. */
  readonly cachedSelection: (
    threadId: ThreadId,
    party: { readonly instanceId: ProviderInstanceId; readonly model: string },
  ) => ModelSelection | undefined;
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

  /**
   * One run per thread at a time. A resume that arrives mid-run (retry,
   * resend, recovery) is not dropped: the running fiber re-reads the state
   * and runs again once it finishes, so nothing is sent twice or lost.
   */
  const running = new Map<ThreadId, { rerun: boolean }>();
  const runExclusive = <A, E, R>(
    threadId: ThreadId,
    run: Effect.Effect<A, E, R>,
  ): Effect.Effect<void, E, R> =>
    Effect.suspend(() => {
      const active = running.get(threadId);
      if (active !== undefined) {
        active.rerun = true;
        return Effect.void;
      }
      const entry = { rerun: false };
      running.set(threadId, entry);
      // Reruns pick their work from the state then, not the first caller's run.
      const rerunUntilSettled: Effect.Effect<void, E, R> = Effect.suspend(() => {
        if (!entry.rerun) return Effect.void;
        entry.rerun = false;
        return driveThread(threadId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("provider switch rerun failed", {
              threadId,
              cause: describeCause(cause),
            }),
          ),
          Effect.flatMap(() => rerunUntilSettled),
        );
      });
      return run.pipe(
        Effect.flatMap(() => rerunUntilSettled),
        Effect.ensuring(Effect.sync(() => running.delete(threadId))),
      );
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

    const binding = yield* deps.providerService
      .getThreadBinding(thread.id)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    // Only this thread's sessions: another thread's stale binding never
    // blocks this decision. The bound instance's session is the active one.
    const threadSessions = yield* deps.providerService.listThreadSessions(thread.id);
    const active =
      threadSessions.find(
        (session) =>
          Option.isSome(binding) && session.providerInstanceId === binding.value.instanceId,
      ) ?? threadSessions[0];
    const activeInfo =
      active?.providerInstanceId === undefined
        ? Option.none()
        : yield* instanceDriver(active.providerInstanceId);
    // A session left by a discarded switch may lack its packet (§3.1).
    const switchRow = yield* deps.switches.getStateByThreadId({ threadId: thread.id });
    const unconfirmedInstanceId = Option.isSome(switchRow)
      ? (switchRow.value.state.handoffUnconfirmedInstanceId ?? null)
      : null;
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
              awaitingHandoffDelivery: binding.value.instanceId === unconfirmedInstanceId,
            }
          : null,
      activeSession:
        active?.providerInstanceId !== undefined && Option.isSome(activeInfo)
          ? {
              instanceId: active.providerInstanceId,
              driver: activeInfo.value.driver,
              continuationKey: activeInfo.value.continuationKey,
              awaitingHandoffDelivery: active.providerInstanceId === unconfirmedInstanceId,
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
      !GENERATION_STAMPING_DRIVERS.has(desired.value.driver) ||
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
    if (
      thread.session?.status === "running" ||
      thread.session?.status === "starting" ||
      active?.status === "running"
    ) {
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
      yield* deps
        .markSessionFailed({ threadId, detail: `${detail}${OLD_CLIENT_HINT}` })
        .pipe(Effect.catchCause(() => Effect.void));
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
      readonly generation?: number | undefined;
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
        generation: result.generation ?? null,
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
    const toInstanceId = pending.to.instanceId;
    // Only a recorded, succeeded start counts as live; this thread's sessions
    // are read on their own, so another thread's stale binding cannot fail it.
    const live =
      latestStart?.status === "succeeded" &&
      (yield* deps.providerService.listThreadSessions(threadId).pipe(
        Effect.map((sessions) =>
          sessions.some((session) => session.providerInstanceId === toInstanceId),
        ),
        Effect.orElseSucceed(() => false),
      ));
    if (!live) {
      // A session of the new provider may survive an earlier start whose
      // bookkeeping and undo both failed: stop it by instance first.
      if (latestStart !== undefined) {
        const cleared = yield* deps.providerService
          .releaseThreadForHandoff(threadId, { alsoStopInstanceId: toInstanceId })
          .pipe(
            Effect.as(true),
            Effect.catchCause((cause) =>
              failRetryable(describeCause(cause)).pipe(Effect.as(false)),
            ),
          );
        if (!cleared) return;
      }
      const attemptId = lastAttemptId(pending) + 1;
      // Above every generation this switch reserved and every one the thread's
      // sessions used, so only the new session's events are current (§7.5).
      const startGeneration =
        Math.max(
          pending.attempts.reduce(
            (max, attempt) =>
              attempt.kind === "start" && attempt.generation !== null
                ? Math.max(max, attempt.generation)
                : max,
            0,
          ),
          yield* deps.providerService.currentSessionGeneration(threadId),
        ) + 1;
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
          sessionGeneration: startGeneration,
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
        changes: yield* deps.readChanges(threadId),
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
          generation: result.generation,
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
          ...(sent.model !== undefined && sent.model.trim().length > 0
            ? { model: sent.model }
            : {}),
          ...(sent.generation !== undefined ? { acceptedGeneration: sent.generation } : {}),
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
          ...(sent.generation !== undefined ? { generation: sent.generation } : {}),
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

  /**
   * Continues a stored switch: after retry or resolve(resend), and at startup.
   * The trigger message and target come from the stored switch, never from
   * the client.
   */
  const resumeSwitchInner = Effect.fn("resumeProviderSwitch")(function* (input: {
    readonly threadId: ThreadId;
    readonly switchId: ProviderSwitchId;
  }) {
    const pending = yield* readPending(input.threadId);
    if (
      pending === null ||
      pending.switchId !== input.switchId ||
      pending.status !== "in-progress"
    ) {
      return;
    }
    const thread = yield* deps.loadThread(input.threadId);
    const message = yield* deps.loadMessage({
      threadId: input.threadId,
      messageId: pending.triggerMessageId,
    });
    if (thread === null || message === null) {
      yield* awaitUser(
        input.threadId,
        input.switchId,
        pending.deliveryUncertain && !pending.resendAllowed
          ? "unknown-delivery"
          : "failed-retryable",
        "乗り換えに使う発言が見つかりませんでした。",
      );
      return;
    }
    const toSelection = deps.cachedSelection(input.threadId, pending.to) ?? {
      instanceId: pending.to.instanceId,
      model: pending.to.model,
    };
    yield* continueSwitch({
      thread,
      switchId: input.switchId,
      trigger: {
        message,
        interactionMode: thread.interactionMode,
        toSelection,
      },
    });
  });

  const resumeSwitch = (input: {
    readonly threadId: ThreadId;
    readonly switchId: ProviderSwitchId;
  }) => runExclusive(input.threadId, resumeSwitchInner(input));

  /** Whatever the thread's unresolved switch needs now: run on, finish an abort, or nothing. */
  function driveThread(threadId: ThreadId) {
    return Effect.gen(function* () {
      const pending = yield* readPending(threadId);
      if (pending === null) return;
      const input = { threadId, switchId: pending.switchId };
      if (pending.status === "closing") {
        yield* finishAbortedSwitchRetried(input);
      } else if (pending.status === "in-progress") {
        yield* resumeSwitchInner(input);
      }
    });
  }

  /**
   * Finishes an aborted switch (§8.2): stop a session the switch itself
   * started and unbind it, so a blank session never receives the next send;
   * the old session is left alone if the switch never stopped it. "Return to
   * previous" restores the old model selection (its cursor is gone, so the
   * next send hands over). Only then is the switch resolved: until close
   * commits, sends stay refused and a restart repeats this cleanup.
   */
  const finishAbortedSwitch = Effect.fn("finishAbortedSwitch")(function* (input: {
    readonly threadId: ThreadId;
    readonly switchId: ProviderSwitchId;
  }) {
    const pending = yield* readPending(input.threadId);
    if (pending === null || pending.switchId !== input.switchId || pending.status !== "closing") {
      return;
    }
    let releasedInstanceId: ProviderInstanceId | undefined;
    if (pending.milestone !== "requested") {
      const binding = yield* deps.providerService.getThreadBinding(input.threadId);
      if (Option.isSome(binding) && binding.value.instanceId === pending.to.instanceId) {
        yield* deps.providerService.releaseThreadForHandoff(input.threadId);
      } else {
        // A session on the new instance whose start was never recorded in the
        // binding is stopped by instance; the old binding is left as it is.
        yield* deps.providerService.releaseThreadForHandoff(input.threadId, {
          alsoStopInstanceId: pending.to.instanceId,
        });
      }
      releasedInstanceId = pending.to.instanceId;
    }
    if (pending.closing?.returnToPrevious === true) {
      const previous = deps.cachedSelection(input.threadId, pending.from) ?? {
        instanceId: pending.from.instanceId,
        model: pending.from.model,
      };
      yield* dispatchSwitch(
        (base) => ({
          type: "thread.meta.update",
          commandId: base.commandId,
          threadId: input.threadId,
          modelSelection: previous,
        }),
        "return-to-previous",
      );
    }
    yield* dispatchSwitch(
      (base) => ({
        type: "thread.provider-switch.close",
        ...base,
        threadId: input.threadId,
        switchId: input.switchId,
        ...(releasedInstanceId !== undefined ? { releasedInstanceId } : {}),
      }),
      "close",
    );
  });

  /** The abort cleanup with its retries; every caller uses this one. */
  const finishAbortedSwitchRetried = (input: {
    readonly threadId: ThreadId;
    readonly switchId: ProviderSwitchId;
  }) =>
    finishAbortedSwitch(input).pipe(
      Effect.retry({ times: 3, schedule: Schedule.exponential("200 millis") }),
    );

  const cleanUpAbortedSwitch = (input: {
    readonly threadId: ThreadId;
    readonly switchId: ProviderSwitchId;
  }) => runExclusive(input.threadId, finishAbortedSwitchRetried(input));

  /**
   * Startup recovery (§9.1), from recorded facts only. Returns the switches to
   * resume; the caller runs them after the reactor is subscribed.
   */
  /**
   * Startup recovery (§9.1), one run per thread through the same guard as
   * resume, so it can never act on a switch a live run is still driving.
   */
  const recoverAtStartup = Effect.fn("recoverProviderSwitchesAtStartup")(function* () {
    const rows = yield* deps.switches.listStates();
    return rows
      .filter((row) => row.state.pending !== null && row.state.pending.status !== "awaiting-user")
      .map((row) => ({ threadId: row.threadId, switchId: row.state.pending!.switchId }));
  });

  /** Recovers one thread's switch from its current state, then runs it on. */
  const recoverThread = (input: {
    readonly threadId: ThreadId;
    readonly switchId: ProviderSwitchId;
  }) =>
    runExclusive(
      input.threadId,
      Effect.gen(function* () {
        const pending = yield* readPending(input.threadId);
        if (pending === null || pending.switchId !== input.switchId) return;
        if (pending.status === "closing") {
          yield* finishAbortedSwitchRetried(input);
          return;
        }
        if (pending.status !== "in-progress") return;
        // One switch failing to recover must not stop the others.
        const outcome = yield* recoverOne(input.threadId, pending).pipe(
          Effect.catchCause((cause) =>
            awaitUser(
              input.threadId,
              pending.switchId,
              pending.deliveryUncertain && !pending.resendAllowed
                ? "unknown-delivery"
                : "failed-retryable",
              describeCause(cause),
            ).pipe(
              Effect.catchCause((waitCause) =>
                Effect.logError("provider switch recovery and its wait both failed", {
                  threadId: input.threadId,
                  switchId: pending.switchId,
                  cause: describeCause(cause),
                  waitCause: describeCause(waitCause),
                }),
              ),
              Effect.as("handled" as const),
            ),
          ),
        );
        if (outcome === "resume") yield* resumeSwitchInner(input);
      }),
    );

  const recoverOne = Effect.fn("recoverProviderSwitch")(function* (
    threadId: ThreadId,
    pending: OrchestrationPendingProviderSwitch,
  ) {
    const latestSubmit = pending.attempts.findLast((attempt) => attempt.kind === "submit");
    if (latestSubmit?.status === "planned") {
      // Sent or not, nobody recorded the outcome: never send it again by itself.
      yield* awaitUser(
        threadId,
        pending.switchId,
        "unknown-delivery",
        "再起動したため、送信が届いたか確認できませんでした。",
      );
      return "handled" as const;
    }
    if (
      latestSubmit?.status === "succeeded" &&
      latestSubmit.turnId !== null &&
      !pending.resendAllowed
    ) {
      // The provider accepted it (turnId and model recorded); only delivered was missing.
      const turnId = latestSubmit.turnId;
      const attemptId = latestSubmit.attemptId;
      const model = latestSubmit.model ?? undefined;
      const generation = latestSubmit.acceptedGeneration ?? undefined;
      yield* dispatchSwitch(
        (base) => ({
          type: "thread.provider-switch.milestone",
          ...base,
          threadId,
          switchId: pending.switchId,
          milestone: "delivered",
          attemptId,
          turnId,
          ...(model !== undefined ? { model } : {}),
          ...(generation !== undefined ? { generation } : {}),
        }),
        "recover-delivered",
      );
      return "handled" as const;
    }
    // Nothing was sent since the last grant. A start left planned died with the process.
    const danglingStart = pending.attempts.find(
      (attempt) => attempt.kind === "start" && attempt.status === "planned",
    );
    if (danglingStart !== undefined) {
      yield* dispatchSwitch(
        (base) => ({
          type: "thread.provider-switch.attempt",
          ...base,
          threadId,
          switchId: pending.switchId,
          attemptId: danglingStart.attemptId,
          kind: "start",
          status: "failed",
          detail: "再起動で中断しました。",
        }),
        "recover-start",
      );
    }
    return "resume" as const;
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
    resumeSwitch,
    cleanUpAbortedSwitch,
    recoverAtStartup,
    recoverThread,
    runExclusive,
  };
}

export type ProviderSwitchFlow = ReturnType<typeof makeProviderSwitchFlow>;
