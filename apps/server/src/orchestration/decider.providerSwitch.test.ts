import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSwitchId,
  ProviderSwitchPacketId,
  ThreadId,
  TurnId,
  OrchestrationEvent as OrchestrationEventSchema,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";
import { sha256Hex } from "./providerSwitchState.ts";

const decodeOrchestrationEvent = Schema.decodeUnknownEffect(OrchestrationEventSchema);

const createdAt = "2026-10-06T10:00:00.000Z";
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-switch");
const triggerMessageId = MessageId.make("message-trigger");
const switchId = ProviderSwitchId.make("switch-1");
const packetId = ProviderSwitchPacketId.make("packet-1");
const turnId = TurnId.make("turn-codex-1");

const claude = {
  instanceId: ProviderInstanceId.make("claude"),
  driver: ProviderDriverKind.make("claudeAgent"),
  model: "claude-opus-5-5",
};
const codex = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  model: "gpt-6.1-sol",
};

let commandCounter = 0;
const nextCommandId = () => CommandId.make(`command-${++commandCounter}`);

const base = () => ({ commandId: nextCommandId(), threadId, createdAt });

const request = (overrides: Partial<{ switchId: ProviderSwitchId }> = {}) =>
  ({
    type: "thread.provider-switch.request",
    ...base(),
    switchId,
    from: claude,
    to: codex,
    triggerMessageId,
    boundaryTurnCount: 3,
    ...overrides,
  }) as const;
const oldStopped = () =>
  ({
    type: "thread.provider-switch.milestone",
    ...base(),
    switchId,
    milestone: "old-stopped",
  }) as const;
const delivered = (attemptId = 2, deliveredTurnId = turnId) =>
  ({
    type: "thread.provider-switch.milestone",
    ...base(),
    switchId,
    milestone: "delivered",
    attemptId,
    turnId: deliveredTurnId,
  }) as const;
const packet = (id = packetId) => {
  const text = "[[AMU-HANDOFF v1]]";
  return {
    type: "thread.provider-switch.packet",
    ...base(),
    switchId,
    packetId: id,
    text,
    sha256: sha256Hex(text),
    chars: text.length,
    includedMessages: 1,
    omittedMessages: 0,
    truncated: false,
  } as const;
};
const startPlanned = (attemptId: number, generation: number | undefined) =>
  ({
    type: "thread.provider-switch.attempt",
    ...base(),
    switchId,
    attemptId,
    kind: "start",
    status: "planned",
    ...(generation === undefined ? {} : { generation }),
  }) as const;
const attemptResult = (
  kind: "start" | "submit",
  attemptId: number,
  status: "succeeded" | "failed",
  resultTurnId?: TurnId,
) =>
  ({
    type: "thread.provider-switch.attempt",
    ...base(),
    switchId,
    attemptId,
    kind,
    status,
    ...(resultTurnId === undefined ? {} : { turnId: resultTurnId }),
  }) as const;
const submitPlanned = (attemptId: number) =>
  ({
    type: "thread.provider-switch.attempt",
    ...base(),
    switchId,
    attemptId,
    kind: "submit",
    status: "planned",
  }) as const;
const awaitUser = (
  reason: "failed-retryable" | "unknown-delivery",
  attemptId: number,
  resumeCount = 0,
) =>
  ({
    type: "thread.provider-switch.await-user",
    ...base(),
    switchId,
    attemptId,
    resumeCount,
    reason,
    detail: "boom",
  }) as const;
const retry = (id = switchId) =>
  ({ type: "thread.provider-switch.retry", ...base(), switchId: id }) as const;
const abort = () =>
  ({ type: "thread.provider-switch.abort", ...base(), switchId, returnToPrevious: false }) as const;
const close = (id = switchId) =>
  ({ type: "thread.provider-switch.close", ...base(), switchId: id }) as const;
const resolve = (decision: "resend" | "discard") =>
  ({ type: "thread.provider-switch.resolve", ...base(), switchId, decision }) as const;
const revert = (
  turnCount: number,
  type: "thread.checkpoint.revert" | "thread.conversation.revert" = "thread.checkpoint.revert",
) => ({ type, ...base(), turnCount }) as const;

const revertFailed = (activityId: string, revertRequestEventId?: EventId) =>
  ({
    type: "thread.activity.append",
    ...base(),
    activity: {
      id: EventId.make(activityId),
      tone: "error",
      kind: "checkpoint.revert.failed",
      summary: "Checkpoint revert failed",
      payload: {
        turnCount: 0,
        detail: "nope",
        ...(revertRequestEventId === undefined ? {} : { revertRequestEventId }),
      },
      turnId: null,
      createdAt,
    },
  }) as const;
const revertComplete = (revertRequestEventId?: EventId) =>
  ({
    type: "thread.revert.complete",
    ...base(),
    turnCount: 0,
    ...(revertRequestEventId === undefined ? {} : { revertRequestEventId }),
  }) as const;

const readModelWithThread = Effect.gen(function* () {
  const withProject = yield* projectEvent(createEmptyReadModel(createdAt), {
    sequence: 1,
    eventId: EventId.make("event-project-created"),
    aggregateKind: "project",
    aggregateId: projectId,
    type: "project.created",
    occurredAt: createdAt,
    commandId: CommandId.make("command-project-created"),
    causationEventId: null,
    correlationId: CommandId.make("command-project-created"),
    metadata: {},
    payload: {
      projectId,
      title: "Project",
      workspaceRoot: "/tmp/project",
      defaultModelSelection: null,
      scripts: [],
      createdAt,
      updatedAt: createdAt,
    },
  });
  return yield* projectEvent(withProject, {
    sequence: 2,
    eventId: EventId.make("event-thread-created"),
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.created",
    occurredAt: createdAt,
    commandId: CommandId.make("command-thread-created"),
    causationEventId: null,
    correlationId: CommandId.make("command-thread-created"),
    metadata: {},
    payload: {
      threadId,
      projectId,
      title: "Switch thread",
      modelSelection: { instanceId: claude.instanceId, model: claude.model },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
      updatedAt: createdAt,
    },
  });
});

/** Decides each command against the evolving read model, like the engine does. */
const run = (readModel: OrchestrationReadModel, commands: ReadonlyArray<OrchestrationCommand>) =>
  Effect.gen(function* () {
    let model = readModel;
    const types: string[] = [];
    const events: OrchestrationEvent[] = [];
    for (const command of commands) {
      const planned = yield* decideOrchestrationCommand({ command, readModel: model });
      for (const event of Array.isArray(planned) ? planned : [planned]) {
        const sequenced = { ...event, sequence: model.snapshotSequence + 1 } as OrchestrationEvent;
        types.push(event.type);
        events.push(sequenced);
        model = yield* projectEvent(model, sequenced);
      }
    }
    return { model, types, events };
  });

const runModel = (
  readModel: OrchestrationReadModel,
  commands: ReadonlyArray<OrchestrationCommand>,
) => run(readModel, commands).pipe(Effect.map((result) => result.model));

const refusal = (readModel: OrchestrationReadModel, command: OrchestrationCommand) =>
  Effect.flip(decideOrchestrationCommand({ command, readModel })).pipe(
    Effect.map((error) => error.message),
  );

const switchState = (model: OrchestrationReadModel) =>
  model.threads.find((thread) => thread.id === threadId)?.providerSwitch;

/** Requested, old session stopped, new session started (attempt 1, generation 5). */
const started = Effect.gen(function* () {
  return yield* runModel(yield* readModelWithThread, [
    request(),
    oldStopped(),
    startPlanned(1, 5),
    attemptResult("start", 1, "succeeded"),
  ]);
});

/** Packet built and submit attempt 2 planned: delivery outcome not yet known. */
const submitting = Effect.gen(function* () {
  return yield* runModel(yield* started, [packet(), submitPlanned(2)]);
});

it.layer(NodeServices.layer)("provider switch decider", (it) => {
  describe("happy path", () => {
    it.effect("walks requested → old-stopped → packet-built → delivered", () =>
      Effect.gen(function* () {
        const model = yield* runModel(yield* submitting, [
          attemptResult("submit", 2, "succeeded", turnId),
          delivered(),
        ]);
        expect(switchState(model)).toEqual({
          pending: null,
          lastDelivered: { switchId, attemptId: 2, turnId, boundaryTurnCount: 3 },
          resolvedSwitchIds: [switchId],
          hasHistory: true,
          handoffUnconfirmedInstanceId: null,
          revertsInFlight: [],
        });
      }),
    );

    it.effect("tracks milestone, packet and attempts while unresolved", () =>
      Effect.gen(function* () {
        const pending = switchState(yield* submitting)?.pending;
        expect(pending).toMatchObject({
          status: "in-progress",
          milestone: "packet-built",
          packet: { packetId, sha256: sha256Hex("[[AMU-HANDOFF v1]]"), chars: 18 },
          attempts: [
            { attemptId: 1, kind: "start", status: "succeeded", generation: 5, turnId: null },
            { attemptId: 2, kind: "submit", status: "planned", generation: null, turnId: null },
          ],
          deliveryUncertain: true,
          resendAllowed: false,
        });
      }),
    );

    it.effect("accepts repeated records without changing the state", () =>
      Effect.gen(function* () {
        const model = yield* submitting;
        const repeated = yield* runModel(model, [
          request(),
          oldStopped(),
          packet(),
          submitPlanned(2),
          attemptResult("start", 1, "succeeded"),
        ]);
        expect(switchState(repeated)).toEqual(switchState(model));

        const done = yield* runModel(model, [
          attemptResult("submit", 2, "succeeded", turnId),
          delivered(),
        ]);
        const again = yield* runModel(done, [delivered()]);
        expect(switchState(again)).toEqual(switchState(done));
      }),
    );
  });

  describe("one unresolved switch per thread", () => {
    it.effect("refuses a second switch while one is unresolved", () =>
      Effect.gen(function* () {
        const message = yield* refusal(
          yield* started,
          request({ switchId: ProviderSwitchId.make("switch-2") }),
        );
        expect(message).toContain("still unresolved");
      }),
    );

    it.effect("refuses a second switch while the first is awaiting the user", () =>
      Effect.gen(function* () {
        const model = yield* runModel(yield* started, [awaitUser("failed-retryable", 1)]);
        const message = yield* refusal(
          model,
          request({ switchId: ProviderSwitchId.make("switch-2") }),
        );
        expect(message).toContain("still unresolved");
      }),
    );

    it.effect("refuses commands for a switch that is not current", () =>
      Effect.gen(function* () {
        const model = yield* runModel(yield* started, [awaitUser("failed-retryable", 1)]);
        expect(yield* refusal(model, retry(ProviderSwitchId.make("switch-old")))).toContain(
          "is not current",
        );
        const none = yield* readModelWithThread;
        expect(yield* refusal(none, retry())).toContain("No unresolved provider switch");
      }),
    );
  });

  describe("milestones only move forward", () => {
    it.effect("refuses a packet before the old session is stopped", () =>
      Effect.gen(function* () {
        const model = yield* runModel(yield* readModelWithThread, [request()]);
        expect(yield* refusal(model, packet())).toContain("before the old session is stopped");
      }),
    );

    it.effect("refuses a second, different packet", () =>
      Effect.gen(function* () {
        const model = yield* runModel(yield* started, [packet()]);
        expect(yield* refusal(model, packet(ProviderSwitchPacketId.make("packet-2")))).toContain(
          "already built",
        );
      }),
    );

    it.effect("refuses a packet whose chars disagree with its text", () =>
      Effect.gen(function* () {
        const message = yield* refusal(yield* started, { ...packet(), chars: 1 });
        expect(message).toContain("chars must equal");
      }),
    );

    it.effect("refuses delivered before the packet or without the succeeded submit", () =>
      Effect.gen(function* () {
        expect(yield* refusal(yield* started, delivered())).toContain("before the packet");
        const model = yield* submitting;
        expect(yield* refusal(model, delivered())).toContain("succeeded submit attempt");
        const succeeded = yield* runModel(model, [attemptResult("submit", 2, "succeeded", turnId)]);
        expect(yield* refusal(succeeded, delivered(1))).toContain("succeeded submit attempt");
        expect(yield* refusal(succeeded, delivered(2, TurnId.make("turn-other")))).toContain(
          "succeeded submit attempt",
        );
      }),
    );
  });

  describe("attempts", () => {
    it.effect("refuses attempts before the old session is stopped", () =>
      Effect.gen(function* () {
        const model = yield* runModel(yield* readModelWithThread, [request()]);
        expect(yield* refusal(model, startPlanned(1, 5))).toContain(
          "before the old session is stopped",
        );
      }),
    );

    it.effect("requires increasing attempt ids and generations", () =>
      Effect.gen(function* () {
        const model = yield* runModel(yield* started, [
          startPlanned(3, 6),
          attemptResult("start", 3, "failed"),
        ]);
        expect(yield* refusal(model, startPlanned(3, 7))).toContain("planned differently");
        expect(yield* refusal(model, startPlanned(2, 7))).toContain("must increase");
        expect(yield* refusal(model, startPlanned(4, 6))).toContain("Generations must increase");
        expect(yield* refusal(model, startPlanned(4, undefined))).toContain(
          "must reserve a generation",
        );
      }),
    );

    it.effect("refuses a second attempt while one is unresolved", () =>
      Effect.gen(function* () {
        const model = yield* runModel(yield* started, [startPlanned(2, 6)]);
        expect(yield* refusal(model, startPlanned(3, 7))).toContain("still unresolved");
        const submittingModel = yield* submitting;
        expect(yield* refusal(submittingModel, startPlanned(3, 7))).toContain("still unresolved");
      }),
    );

    it.effect("refuses a result that contradicts or names no planned attempt", () =>
      Effect.gen(function* () {
        expect(yield* refusal(yield* started, attemptResult("start", 1, "failed"))).toContain(
          "already succeeded",
        );
        const model = yield* runModel(yield* started, [startPlanned(2, 6)]);
        expect(yield* refusal(model, attemptResult("start", 1, "failed"))).toContain(
          "already succeeded",
        );
        expect(yield* refusal(model, attemptResult("start", 9, "failed"))).toContain(
          "not a planned start attempt",
        );
        expect(yield* refusal(model, attemptResult("submit", 2, "failed"))).toContain(
          "not a planned submit attempt",
        );
      }),
    );

    it.effect("refuses a submit before the packet or without a succeeded start", () =>
      Effect.gen(function* () {
        expect(yield* refusal(yield* started, submitPlanned(2))).toContain(
          "before the packet is built",
        );
        const failedStart = yield* runModel(yield* readModelWithThread, [
          request(),
          oldStopped(),
          startPlanned(1, 5),
          attemptResult("start", 1, "failed"),
          packet(),
        ]);
        expect(yield* refusal(failedStart, submitPlanned(2))).toContain(
          "without a succeeded start",
        );
      }),
    );

    it.effect("refuses a succeeded submit without its turn", () =>
      Effect.gen(function* () {
        expect(
          yield* refusal(yield* submitting, attemptResult("submit", 2, "succeeded")),
        ).toContain("must carry its turnId");
      }),
    );

    it.effect("refuses sending again without resolve(resend)", () =>
      Effect.gen(function* () {
        const model = yield* runModel(yield* submitting, [
          attemptResult("submit", 2, "succeeded", turnId),
        ]);
        expect(yield* refusal(model, submitPlanned(3))).toContain("needs resolve(resend)");
      }),
    );

    it.effect("a failed submit still needs resolve(resend) before sending again", () =>
      Effect.gen(function* () {
        const failed = yield* runModel(yield* submitting, [attemptResult("submit", 2, "failed")]);
        expect(yield* refusal(failed, submitPlanned(3))).toContain("needs resolve(resend)");
        const model = yield* runModel(failed, [
          awaitUser("unknown-delivery", 2),
          resolve("resend"),
          submitPlanned(3),
        ]);
        expect(switchState(model)?.pending?.attempts.at(-1)).toMatchObject({
          attemptId: 3,
          status: "planned",
        });
      }),
    );

    it.effect("refuses attempt records while awaiting the user", () =>
      Effect.gen(function* () {
        const model = yield* runModel(yield* started, [awaitUser("failed-retryable", 1)]);
        expect(yield* refusal(model, startPlanned(2, 6))).toContain("waiting for the user");
        expect(yield* refusal(model, packet())).toContain("waiting for the user");
        expect(yield* refusal(model, oldStopped())).toContain("waiting for the user");
      }),
    );
  });

  describe("failed before sending", () => {
    it.effect("retry resumes and treats a dangling start as abandoned", () =>
      Effect.gen(function* () {
        const model = yield* runModel(yield* started, [
          startPlanned(2, 6),
          awaitUser("failed-retryable", 2),
        ]);
        expect(switchState(model)?.pending).toMatchObject({
          status: "awaiting-user",
          awaitingReason: "failed-retryable",
          attempts: [
            expect.objectContaining({ attemptId: 1, status: "succeeded" }),
            expect.objectContaining({ attemptId: 2, status: "abandoned" }),
          ],
        });
        const resumed = yield* runModel(model, [retry(), startPlanned(3, 7)]);
        expect(switchState(resumed)?.pending).toMatchObject({
          status: "in-progress",
          awaitingReason: null,
          attempts: [
            expect.objectContaining({ attemptId: 1 }),
            expect.objectContaining({ attemptId: 2, status: "abandoned" }),
            expect.objectContaining({ attemptId: 3, status: "planned", generation: 7 }),
          ],
        });
      }),
    );

    it.effect("abort closes the switch and cancels the message in the same commit", () =>
      Effect.gen(function* () {
        const model = yield* runModel(yield* started, [awaitUser("failed-retryable", 1)]);
        const { model: closing, types } = yield* run(model, [abort()]);
        expect(types).toEqual([
          "thread.provider-switch-aborted",
          "thread.message-delivery-state-set",
        ]);
        // Still unresolved until its cleanup closes it.
        expect(switchState(closing)?.pending?.status).toBe("closing");
        const closed = yield* runModel(closing, [close()]);
        expect(switchState(closed)).toMatchObject({
          pending: null,
          lastDelivered: null,
          resolvedSwitchIds: [switchId],
          hasHistory: true,
        });
      }),
    );

    it.effect("refuses failed-retryable once a submit may have reached the provider", () =>
      Effect.gen(function* () {
        expect(yield* refusal(yield* submitting, awaitUser("failed-retryable", 2))).toContain(
          "delivery is unknown",
        );
      }),
    );

    it.effect("refuses retry and abort when delivery is unknown", () =>
      Effect.gen(function* () {
        const model = yield* runModel(yield* submitting, [awaitUser("unknown-delivery", 2)]);
        expect(yield* refusal(model, retry())).toContain("not awaiting the user");
        expect(yield* refusal(model, abort())).toContain("not awaiting the user");
      }),
    );
  });

  describe("delivery unknown", () => {
    it.effect("refuses unknown-delivery before any submit was planned", () =>
      Effect.gen(function* () {
        expect(yield* refusal(yield* started, awaitUser("unknown-delivery", 1))).toContain(
          "after a submit attempt was planned",
        );
      }),
    );

    it.effect("resolve(resend) allows exactly one more submit", () =>
      Effect.gen(function* () {
        const model = yield* runModel(yield* submitting, [
          awaitUser("unknown-delivery", 2),
          resolve("resend"),
        ]);
        expect(switchState(model)?.pending).toMatchObject({
          status: "in-progress",
          resendAllowed: true,
          attempts: [
            expect.objectContaining({ attemptId: 1, status: "succeeded" }),
            expect.objectContaining({ attemptId: 2, status: "abandoned" }),
          ],
        });
        const resent = yield* runModel(model, [submitPlanned(3)]);
        expect(switchState(resent)?.pending?.resendAllowed).toBe(false);
        const succeeded = yield* runModel(resent, [
          attemptResult("submit", 3, "succeeded", turnId),
        ]);
        expect(yield* refusal(succeeded, submitPlanned(4))).toContain("needs resolve(resend)");
      }),
    );

    it.effect("resolve(resend) may restart the session before sending again", () =>
      Effect.gen(function* () {
        const model = yield* runModel(yield* submitting, [
          awaitUser("unknown-delivery", 2),
          resolve("resend"),
          startPlanned(3, 6),
          attemptResult("start", 3, "succeeded"),
          submitPlanned(4),
          attemptResult("submit", 4, "succeeded", turnId),
          delivered(4),
        ]);
        expect(switchState(model)?.lastDelivered?.attemptId).toBe(4);
      }),
    );

    it.effect("resolve(discard) closes the switch and marks the message", () =>
      Effect.gen(function* () {
        const model = yield* runModel(yield* submitting, [awaitUser("unknown-delivery", 2)]);
        const { model: closed, types } = yield* run(model, [resolve("discard")]);
        expect(types).toEqual([
          "thread.provider-switch-resolved",
          "thread.message-delivery-state-set",
        ]);
        expect(switchState(closed)?.pending).toBeNull();
      }),
    );

    it.effect("refuses resolve when the failure was retryable", () =>
      Effect.gen(function* () {
        const model = yield* runModel(yield* started, [awaitUser("failed-retryable", 1)]);
        expect(yield* refusal(model, resolve("resend"))).toContain("not awaiting the user");
      }),
    );
  });

  describe("reverts", () => {
    const deliveredModel = Effect.gen(function* () {
      return yield* runModel(yield* submitting, [
        attemptResult("submit", 2, "succeeded", turnId),
        delivered(),
      ]);
    });

    it.effect("refuses both reverts while a switch is unresolved", () =>
      Effect.gen(function* () {
        const model = yield* started;
        expect(yield* refusal(model, revert(5))).toContain("モデルの乗り換え中は戻せません");
        expect(yield* refusal(model, revert(5, "thread.conversation.revert"))).toContain(
          "モデルの乗り換え中は戻せません",
        );
      }),
    );

    it.effect("refuses reverting to or before the switch boundary", () =>
      Effect.gen(function* () {
        const model = yield* deliveredModel;
        expect(yield* refusal(model, revert(3))).toContain(
          "モデルを乗り換えた所より前には戻せません",
        );
        expect(yield* refusal(model, revert(0, "thread.conversation.revert"))).toContain(
          "モデルを乗り換えた所より前には戻せません",
        );
        const { types } = yield* run(model, [revert(4)]);
        expect(types).toEqual(["thread.checkpoint-revert-requested"]);
      }),
    );

    it.effect("leaves threads without a switch alone", () =>
      Effect.gen(function* () {
        const { model, types } = yield* run(yield* readModelWithThread, [revert(0)]);
        expect(types).toEqual(["thread.checkpoint-revert-requested"]);
        expect(switchState(model)?.revertsInFlight).toHaveLength(1);
        const reverted = yield* runModel(model, [
          { type: "thread.revert.complete", ...base(), turnCount: 0 },
        ]);
        expect(switchState(reverted)).toBeUndefined();
      }),
    );

    it.effect("refuses a switch while a revert is in flight, until it completes", () =>
      Effect.gen(function* () {
        const reverting = yield* runModel(yield* readModelWithThread, [revert(0)]);
        expect(yield* refusal(reverting, request())).toContain("revert is still in progress");
        const reverted = yield* runModel(reverting, [
          { type: "thread.revert.complete", ...base(), turnCount: 0 },
        ]);
        const { types } = yield* run(reverted, [request()]);
        expect(types).toEqual(["thread.provider-switch-requested"]);
      }),
    );

    it.effect("a failed revert also releases the switch", () =>
      Effect.gen(function* () {
        const { model: reverting, events } = yield* run(yield* readModelWithThread, [revert(0)]);
        const failed = yield* runModel(reverting, [revertFailed("activity-1", events[0]!.eventId)]);
        expect(switchState(failed)).toBeUndefined();
        const { types } = yield* run(failed, [request()]);
        expect(types).toEqual(["thread.provider-switch-requested"]);
      }),
    );
  });

  describe("message delivery state", () => {
    it.effect("records the state on the message", () =>
      Effect.gen(function* () {
        const withMessage = yield* runModel(yield* readModelWithThread, [
          {
            type: "thread.message.user.append",
            ...base(),
            message: { messageId: triggerMessageId, text: "switch", attachments: [] },
          },
        ]);
        const closed = yield* runModel(withMessage, [
          request(),
          oldStopped(),
          startPlanned(1, 5),
          awaitUser("failed-retryable", 1),
          abort(),
        ]);
        const message = closed.threads[0]?.messages.find((entry) => entry.id === triggerMessageId);
        expect(message?.deliveryState).toBe("cancelled");
      }),
    );
  });

  describe("resolved switches stay resolved", () => {
    const deliveredModel = Effect.gen(function* () {
      return yield* runModel(yield* submitting, [
        attemptResult("submit", 2, "succeeded", turnId),
        delivered(),
      ]);
    });

    it.effect("refuses to reopen a delivered, aborted or discarded switch", () =>
      Effect.gen(function* () {
        expect(yield* refusal(yield* deliveredModel, request())).toContain("already resolved");
        const closing = yield* runModel(yield* started, [
          awaitUser("failed-retryable", 1),
          abort(),
        ]);
        // While closing the switch is still unresolved: no retry, no new switch.
        expect(yield* refusal(closing, retry())).toContain("not awaiting the user");
        expect(yield* refusal(closing, awaitUser("failed-retryable", 1))).toContain("is closing");
        const aborted = yield* runModel(closing, [close()]);
        expect(yield* refusal(aborted, request())).toContain("already resolved");
        expect(yield* refusal(aborted, retry())).toContain("already resolved");
        const discarded = yield* runModel(yield* submitting, [
          awaitUser("unknown-delivery", 2),
          resolve("discard"),
        ]);
        expect(yield* refusal(discarded, request())).toContain("already resolved");
      }),
    );

    it.effect("refuses a repeated delivered record with a different attempt", () =>
      Effect.gen(function* () {
        expect(
          yield* refusal(yield* deliveredModel, delivered(2, TurnId.make("turn-x"))),
        ).toContain("different attempt");
      }),
    );

    it.effect("a later switch can start once the first is resolved", () =>
      Effect.gen(function* () {
        const { types } = yield* run(yield* deliveredModel, [
          request({ switchId: ProviderSwitchId.make("switch-2") }),
        ]);
        expect(types).toEqual(["thread.provider-switch-requested"]);
      }),
    );
  });

  describe("same id, different content", () => {
    it.effect("refuses a repeated request with different fields", () =>
      Effect.gen(function* () {
        const message = yield* refusal(yield* started, { ...request(), boundaryTurnCount: 4 });
        expect(message).toContain("requested differently");
      }),
    );

    it.effect("refuses a repeated planned attempt with a different generation or kind", () =>
      Effect.gen(function* () {
        const model = yield* started;
        expect(yield* refusal(model, startPlanned(1, 6))).toContain("planned differently");
        expect(yield* refusal(model, { ...submitPlanned(1) })).toContain("planned differently");
      }),
    );

    it.effect("refuses a repeated submit result with a different reported model", () =>
      Effect.gen(function* () {
        const model = yield* runModel(yield* submitting, [
          { ...attemptResult("submit", 2, "succeeded", turnId), model: "model-a" },
        ]);
        expect(
          yield* refusal(model, {
            ...attemptResult("submit", 2, "succeeded", turnId),
            model: "model-b",
          }),
        ).toContain("different turn, model or generation");
        const { types } = yield* run(model, [
          { ...attemptResult("submit", 2, "succeeded", turnId), model: "model-a" },
        ]);
        expect(types).toEqual(["thread.provider-switch-attempt-recorded"]);
      }),
    );

    it.effect("refuses a repeated submit result with a different accepting generation", () =>
      Effect.gen(function* () {
        const model = yield* runModel(yield* submitting, [
          { ...attemptResult("submit", 2, "succeeded", turnId), acceptedGeneration: 3 },
        ]);
        expect(
          yield* refusal(model, {
            ...attemptResult("submit", 2, "succeeded", turnId),
            acceptedGeneration: 4,
          }),
        ).toContain("different turn, model or generation");
        const { types } = yield* run(model, [
          { ...attemptResult("submit", 2, "succeeded", turnId), acceptedGeneration: 3 },
        ]);
        expect(types).toEqual(["thread.provider-switch-attempt-recorded"]);
      }),
    );

    it.effect("refuses a repeated submit result with a different turn", () =>
      Effect.gen(function* () {
        const model = yield* runModel(yield* submitting, [
          attemptResult("submit", 2, "succeeded", turnId),
        ]);
        expect(
          yield* refusal(model, attemptResult("submit", 2, "succeeded", TurnId.make("turn-x"))),
        ).toContain("different turn");
      }),
    );

    it.effect("refuses a repeated packet with different content", () =>
      Effect.gen(function* () {
        const model = yield* runModel(yield* started, [packet()]);
        expect(yield* refusal(model, { ...packet(), sha256: "other" })).toContain(
          "sha256 does not match",
        );
        const sameLength = "[[AMU-HANDOFF v2]]";
        expect(yield* refusal(model, { ...packet(), text: sameLength })).toContain(
          "sha256 does not match",
        );
        expect(
          yield* refusal(model, { ...packet(), text: sameLength, sha256: sha256Hex(sameLength) }),
        ).toContain("already built");
        expect(yield* refusal(model, { ...packet(), truncated: true })).toContain("already built");
      }),
    );
  });

  describe("old records never move state backwards", () => {
    it.effect("replaying an older attempt keeps the newer one current", () =>
      Effect.gen(function* () {
        const model = yield* runModel(yield* readModelWithThread, [
          request(),
          oldStopped(),
          startPlanned(1, 5),
          attemptResult("start", 1, "failed"),
          startPlanned(3, 6),
          attemptResult("start", 3, "succeeded"),
        ]);
        const replayed = yield* runModel(model, [
          startPlanned(1, 5),
          attemptResult("start", 1, "failed"),
          startPlanned(3, 6),
          attemptResult("start", 3, "succeeded"),
        ]);
        expect(switchState(replayed)).toEqual(switchState(model));
        const { model: afterPacket } = yield* run(replayed, [packet(), submitPlanned(4)]);
        expect(switchState(afterPacket)?.pending?.attempts.at(-1)?.attemptId).toBe(4);
      }),
    );

    it.effect("re-applying the same events folds to the same state", () =>
      Effect.gen(function* () {
        const { model, events } = yield* run(yield* readModelWithThread, [
          request(),
          oldStopped(),
          startPlanned(1, 5),
          attemptResult("start", 1, "succeeded"),
          packet(),
          submitPlanned(2),
          awaitUser("unknown-delivery", 2),
          resolve("resend"),
        ]);
        let replayed = model;
        for (const event of events) {
          replayed = yield* projectEvent(replayed, {
            ...event,
            sequence: replayed.snapshotSequence + 1,
          });
        }
        expect(switchState(replayed)).toEqual(switchState(model));
      }),
    );
  });

  describe("closing after an uncertain delivery", () => {
    it.effect("abort after a resend never marks the message as not sent", () =>
      Effect.gen(function* () {
        const model = yield* runModel(yield* submitting, [
          awaitUser("unknown-delivery", 2),
          resolve("resend"),
          startPlanned(3, 6),
          attemptResult("start", 3, "failed"),
          awaitUser("failed-retryable", 3, 1),
        ]);
        const { events } = yield* run(model, [abort()]);
        expect(events[1]).toMatchObject({
          type: "thread.message-delivery-state-set",
          payload: { messageId: triggerMessageId, state: "unknown-discarded" },
        });
      }),
    );

    it.effect("abort before any submit marks the message cancelled", () =>
      Effect.gen(function* () {
        const model = yield* runModel(yield* started, [awaitUser("failed-retryable", 1)]);
        const { events } = yield* run(model, [abort()]);
        expect(events[1]?.payload).toMatchObject({ state: "cancelled" });
      }),
    );
  });

  describe("recovery after a restart (§9.1)", () => {
    it.effect("a start left planned at old-stopped is failed, then started again", () =>
      Effect.gen(function* () {
        const model = yield* runModel(yield* readModelWithThread, [
          request(),
          oldStopped(),
          startPlanned(1, 5),
        ]);
        expect(yield* refusal(model, startPlanned(2, 6))).toContain("still unresolved");
        const recovered = yield* runModel(model, [
          attemptResult("start", 1, "failed"),
          startPlanned(2, 6),
          attemptResult("start", 2, "succeeded"),
          packet(),
          submitPlanned(3),
        ]);
        expect(switchState(recovered)?.pending?.milestone).toBe("packet-built");
      }),
    );

    it.effect("a start left planned at packet-built reuses the stored packet", () =>
      Effect.gen(function* () {
        const model = yield* runModel(yield* started, [packet(), startPlanned(2, 6)]);
        const recovered = yield* runModel(model, [
          attemptResult("start", 2, "failed"),
          startPlanned(3, 7),
          attemptResult("start", 3, "succeeded"),
          submitPlanned(4),
          attemptResult("submit", 4, "succeeded", turnId),
          delivered(4),
        ]);
        expect(switchState(recovered)?.lastDelivered?.attemptId).toBe(4);
      }),
    );

    it.effect("a restart after resend restarts the session and spends the resend once", () =>
      Effect.gen(function* () {
        const model = yield* runModel(yield* submitting, [
          awaitUser("unknown-delivery", 2),
          resolve("resend"),
          startPlanned(3, 6),
        ]);
        const recovered = yield* runModel(model, [
          attemptResult("start", 3, "failed"),
          startPlanned(4, 7),
          attemptResult("start", 4, "succeeded"),
          submitPlanned(5),
        ]);
        expect(switchState(recovered)?.pending?.resendAllowed).toBe(false);
      }),
    );
  });

  describe("reverts in flight are tracked per request", () => {
    it.effect("a duplicated failure releases only its own revert", () =>
      Effect.gen(function* () {
        const { model, events } = yield* run(yield* readModelWithThread, [revert(0), revert(0)]);
        const firstId = events[0]!.eventId;
        const failedTwice = yield* runModel(model, [
          revertFailed("activity-1", firstId),
          revertFailed("activity-1", firstId),
        ]);
        expect(switchState(failedTwice)?.revertsInFlight).toEqual([events[1]!.eventId]);
        expect(yield* refusal(failedTwice, request())).toContain("revert is still in progress");
      }),
    );

    it.effect("duplicated requested and reverted events count once", () =>
      Effect.gen(function* () {
        const { model, events } = yield* run(yield* readModelWithThread, [revert(0)]);
        const requested = events[0]!;
        const twice = yield* projectEvent(model, {
          ...requested,
          sequence: model.snapshotSequence + 1,
        });
        expect(switchState(twice)?.revertsInFlight).toEqual([requested.eventId]);
        const done = yield* runModel(twice, [
          revertComplete(requested.eventId),
          revertComplete(requested.eventId),
        ]);
        expect(switchState(done)).toBeUndefined();
      }),
    );
  });

  describe("event shapes", () => {
    it.effect("every produced event decodes as an OrchestrationEvent", () =>
      Effect.gen(function* () {
        const { events } = yield* run(yield* readModelWithThread, [
          request(),
          oldStopped(),
          startPlanned(1, 5),
          attemptResult("start", 1, "succeeded"),
          packet(),
          submitPlanned(2),
          awaitUser("unknown-delivery", 2),
          resolve("resend"),
          submitPlanned(3),
          attemptResult("submit", 3, "succeeded", turnId),
          delivered(3),
          request({ switchId: ProviderSwitchId.make("switch-2") }),
          {
            type: "thread.provider-switch.milestone",
            ...base(),
            switchId: ProviderSwitchId.make("switch-2"),
            milestone: "old-stopped",
          },
          {
            type: "thread.provider-switch.attempt",
            ...base(),
            switchId: ProviderSwitchId.make("switch-2"),
            attemptId: 1,
            kind: "start",
            status: "planned",
            generation: 9,
          },
          {
            type: "thread.provider-switch.await-user",
            ...base(),
            switchId: ProviderSwitchId.make("switch-2"),
            attemptId: 1,
            resumeCount: 0,
            reason: "failed-retryable",
            detail: "x",
          },
          {
            type: "thread.provider-switch.retry",
            ...base(),
            switchId: ProviderSwitchId.make("switch-2"),
          },
          {
            type: "thread.provider-switch.await-user",
            ...base(),
            switchId: ProviderSwitchId.make("switch-2"),
            attemptId: 1,
            resumeCount: 1,
            reason: "failed-retryable",
            detail: "x",
          },
          {
            type: "thread.provider-switch.abort",
            ...base(),
            switchId: ProviderSwitchId.make("switch-2"),
            returnToPrevious: true,
          },
          {
            type: "thread.turn-assignment.record",
            ...base(),
            messageId: triggerMessageId,
            turnId,
            instanceId: codex.instanceId,
            driver: codex.driver,
            model: codex.model,
            generation: 5,
          },
          {
            type: "thread.message.delivery-state.set",
            ...base(),
            messageId: triggerMessageId,
            state: "delivered",
          },
        ]);
        const decodedTypes: string[] = [];
        for (const event of events) {
          const decoded = yield* decodeOrchestrationEvent(event);
          decodedTypes.push(decoded.type);
        }
        expect(new Set(decodedTypes)).toEqual(
          new Set([
            "thread.provider-switch-requested",
            "thread.provider-switch-milestone-reached",
            "thread.provider-switch-packet-built",
            "thread.provider-switch-attempt-recorded",
            "thread.provider-switch-awaiting-user",
            "thread.provider-switch-retry-requested",
            "thread.provider-switch-aborted",
            "thread.provider-switch-resolved",
            "thread.turn-assignment-recorded",
            "thread.message-delivery-state-set",
          ]),
        );
      }),
    );
  });

  describe("second review round", () => {
    it.effect("a stale wait cannot hit a newer attempt", () =>
      Effect.gen(function* () {
        const { model, events } = yield* run(yield* submitting, [
          awaitUser("unknown-delivery", 2),
          resolve("resend"),
          submitPlanned(3),
        ]);
        expect(yield* refusal(model, awaitUser("unknown-delivery", 2))).toContain(
          "names attempt 2",
        );
        const staleWait = events[0]!;
        const replayed = yield* projectEvent(model, {
          ...staleWait,
          sequence: model.snapshotSequence + 1,
        });
        expect(switchState(replayed)).toEqual(switchState(model));
        const { types } = yield* run(replayed, [attemptResult("submit", 3, "succeeded", turnId)]);
        expect(types).toEqual(["thread.provider-switch-attempt-recorded"]);
      }),
    );

    it.effect("a switch resolved long ago still cannot be reopened", () =>
      Effect.gen(function* () {
        let model = yield* runModel(yield* started, [
          awaitUser("failed-retryable", 1),
          abort(),
          close(),
        ]);
        for (let index = 2; index <= 60; index += 1) {
          const id = ProviderSwitchId.make(`switch-${index}`);
          model = yield* runModel(model, [
            request({ switchId: id }),
            {
              type: "thread.provider-switch.milestone",
              ...base(),
              switchId: id,
              milestone: "old-stopped",
            },
            {
              type: "thread.provider-switch.await-user",
              ...base(),
              switchId: id,
              attemptId: 0,
              resumeCount: 0,
              reason: "failed-retryable",
              detail: "x",
            },
            {
              type: "thread.provider-switch.abort",
              ...base(),
              switchId: id,
              returnToPrevious: false,
            },
            close(id),
          ]);
        }
        expect(switchState(model)?.resolvedSwitchIds).toHaveLength(60);
        expect(yield* refusal(model, request())).toContain("already resolved");
      }),
    );

    it.effect("a send that failed after the resend was spent is unknown, not retryable", () =>
      Effect.gen(function* () {
        const model = yield* runModel(yield* submitting, [
          awaitUser("unknown-delivery", 2),
          resolve("resend"),
          submitPlanned(3),
          attemptResult("submit", 3, "failed"),
        ]);
        expect(yield* refusal(model, awaitUser("failed-retryable", 3, 1))).toContain(
          "delivery is unknown",
        );
        const { types } = yield* run(model, [awaitUser("unknown-delivery", 3, 1)]);
        expect(types).toEqual(["thread.provider-switch-awaiting-user"]);
      }),
    );

    it.effect("a restart that fails while a resend is unspent can be retried into a send", () =>
      Effect.gen(function* () {
        const model = yield* runModel(yield* submitting, [
          awaitUser("unknown-delivery", 2),
          resolve("resend"),
          startPlanned(3, 6),
          attemptResult("start", 3, "failed"),
          awaitUser("failed-retryable", 3, 1),
          retry(),
          startPlanned(4, 7),
          attemptResult("start", 4, "succeeded"),
        ]);
        const { types } = yield* run(model, [submitPlanned(5)]);
        expect(types).toEqual(["thread.provider-switch-attempt-recorded"]);
      }),
    );

    it.effect("a repeated legacy failure without a request id releases one revert", () =>
      Effect.gen(function* () {
        const { model, events } = yield* run(yield* readModelWithThread, [revert(0), revert(0)]);
        const failedTwice = yield* runModel(model, [
          revertFailed("activity-legacy"),
          revertFailed("activity-legacy"),
        ]);
        expect(switchState(failedTwice)?.revertsInFlight).toEqual([events[1]!.eventId]);
      }),
    );
  });

  describe("third review round", () => {
    it.effect("a wait from before resolve(resend) is refused and ignored", () =>
      Effect.gen(function* () {
        const { model, events } = yield* run(yield* submitting, [
          awaitUser("unknown-delivery", 2),
          resolve("resend"),
        ]);
        expect(yield* refusal(model, awaitUser("unknown-delivery", 2))).toContain(
          "predates resume 1",
        );
        const replayed = yield* projectEvent(model, {
          ...events[0]!,
          sequence: model.snapshotSequence + 1,
        });
        expect(switchState(replayed)).toEqual(switchState(model));
        const { types } = yield* run(replayed, [submitPlanned(3)]);
        expect(types).toEqual(["thread.provider-switch-attempt-recorded"]);
      }),
    );

    it.effect("a wait from before retry is refused even with no attempts", () =>
      Effect.gen(function* () {
        const model = yield* runModel(yield* readModelWithThread, [
          request(),
          oldStopped(),
          awaitUser("failed-retryable", 0),
          retry(),
        ]);
        expect(yield* refusal(model, awaitUser("failed-retryable", 0))).toContain(
          "predates resume 1",
        );
        const { types } = yield* run(model, [awaitUser("failed-retryable", 0, 1)]);
        expect(types).toEqual(["thread.provider-switch-awaiting-user"]);
      }),
    );

    it.effect("applying every event twice in a row folds to the same state", () =>
      Effect.gen(function* () {
        // The engine's dispatch-failure reconcile may re-project committed events.
        const { model, events } = yield* run(yield* readModelWithThread, [
          revert(0),
          revertComplete(),
          request(),
          oldStopped(),
          startPlanned(1, 5),
          attemptResult("start", 1, "failed"),
          awaitUser("failed-retryable", 1),
          retry(),
          startPlanned(2, 6),
          attemptResult("start", 2, "succeeded"),
          packet(),
          submitPlanned(3),
          awaitUser("unknown-delivery", 3, 1),
          resolve("resend"),
          submitPlanned(4),
          attemptResult("submit", 4, "succeeded", turnId),
          delivered(4),
        ]);
        let doubled = yield* readModelWithThread;
        for (const event of events) {
          for (let copy = 0; copy < 2; copy += 1) {
            doubled = yield* projectEvent(doubled, {
              ...event,
              sequence: doubled.snapshotSequence + 1,
            });
          }
        }
        expect(switchState(doubled)).toEqual(switchState(model));
      }),
    );
  });

  describe("delivery tracking", () => {
    it.effect("saves a tracked send pending in the same commit as the message", () =>
      Effect.gen(function* () {
        const { types, events } = yield* run(yield* readModelWithThread, [
          {
            type: "thread.turn.start",
            ...base(),
            message: { messageId: triggerMessageId, role: "user", text: "hi", attachments: [] },
            runtimeMode: "full-access",
            interactionMode: "default",
            trackDelivery: true,
          },
        ]);
        expect(types).toEqual([
          "thread.message-sent",
          "thread.message-delivery-state-set",
          "thread.turn-start-requested",
        ]);
        expect(events[1]?.payload).toMatchObject({ messageId: triggerMessageId, state: "pending" });
      }),
    );

    it.effect("saves a tracked send persisted ahead of its turn pending in the same commit", () =>
      Effect.gen(function* () {
        const { types, events } = yield* run(yield* readModelWithThread, [
          {
            type: "thread.message.user.append",
            ...base(),
            message: { messageId: triggerMessageId, text: "hi", attachments: [] },
            trackDelivery: true,
          },
        ]);
        expect(types).toEqual(["thread.message-sent", "thread.message-delivery-state-set"]);
        expect(events[1]?.payload).toMatchObject({ messageId: triggerMessageId, state: "pending" });
      }),
    );

    it.effect("leaves an untracked send without a delivery state", () =>
      Effect.gen(function* () {
        const { types } = yield* run(yield* readModelWithThread, [
          {
            type: "thread.turn.start",
            ...base(),
            message: { messageId: triggerMessageId, role: "user", text: "hi", attachments: [] },
            runtimeMode: "full-access",
            interactionMode: "default",
          },
        ]);
        expect(types).toEqual(["thread.message-sent", "thread.turn-start-requested"]);
      }),
    );
  });

  describe("answering model", () => {
    it.effect("records the model the provider reported, not the requested alias", () =>
      Effect.gen(function* () {
        const { events } = yield* run(yield* submitting, [
          attemptResult("submit", 2, "succeeded", turnId),
          { ...delivered(), model: "gpt-6.1-sol-2026-09" },
        ]);
        expect(
          events.find((event) => event.type === "thread.turn-assignment-recorded")?.payload,
        ).toMatchObject({
          turnId,
          instanceId: codex.instanceId,
          model: "gpt-6.1-sol-2026-09",
          generation: 5,
        });
      }),
    );

    it.effect("falls back to the requested model when none was reported", () =>
      Effect.gen(function* () {
        const { events } = yield* run(yield* submitting, [
          attemptResult("submit", 2, "succeeded", turnId),
          delivered(),
        ]);
        expect(
          events.find((event) => event.type === "thread.turn-assignment-recorded")?.payload,
        ).toMatchObject({ model: codex.model });
      }),
    );
  });

  describe("conditional session update", () => {
    const sessionSet = (status: "starting" | "running" | "error", expectedStatus?: "starting") =>
      ({
        type: "thread.session.set",
        ...base(),
        session: {
          threadId,
          status,
          providerName: "codex",
          providerInstanceId: codex.instanceId,
          runtimeMode: "full-access",
          activeTurnId: status === "running" ? turnId : null,
          lastError: null,
          updatedAt: createdAt,
        },
        ...(expectedStatus !== undefined ? { expectedStatus } : {}),
      }) as const;

    it.effect("applies only while the session still has the expected status", () =>
      Effect.gen(function* () {
        const starting = yield* runModel(yield* readModelWithThread, [sessionSet("starting")]);
        const { types } = yield* run(starting, [sessionSet("error", "starting")]);
        expect(types).toEqual(["thread.session-set"]);

        // A turn started in between: the stale update is refused.
        const running = yield* runModel(starting, [sessionSet("running")]);
        expect(yield* refusal(running, sessionSet("error", "starting"))).toContain(
          "no longer 'starting'",
        );
      }),
    );
  });
});
