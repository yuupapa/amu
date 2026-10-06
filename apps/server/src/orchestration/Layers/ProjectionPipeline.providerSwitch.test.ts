import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSwitchId,
  ProviderSwitchPacketId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadProviderSwitchRepository } from "../../persistence/Services/ProjectionThreadProviderSwitches.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { ServerConfig } from "../../config.ts";
import { createEmptyReadModel, projectEvent } from "../projector.ts";
import { sha256Hex } from "../providerSwitchState.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const engineLayer = it.layer(
  OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-provider-switch-projection-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const createdAt = "2026-10-06T10:00:00.000Z";
const projectId = ProjectId.make("project-switch");
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
const packetText = "[[AMU-HANDOFF v1]]\n本文";

let counter = 0;
const commandId = () => CommandId.make(`cmd-switch-projection-${++counter}`);

const threadSetup = (threadId: ThreadId, messageId: MessageId): OrchestrationCommand[] => [
  {
    type: "thread.create",
    commandId: commandId(),
    threadId,
    projectId,
    title: "Switch thread",
    modelSelection: { instanceId: claude.instanceId, model: claude.model },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt,
  },
  {
    type: "thread.message.user.append",
    commandId: commandId(),
    threadId,
    message: { messageId, text: "Codex に切り替えて続けて", attachments: [] },
    createdAt,
  },
];

const switchCommands = (
  threadId: ThreadId,
  messageId: MessageId,
  switchId: ProviderSwitchId,
): OrchestrationCommand[] => {
  const base = () => ({ commandId: commandId(), threadId, createdAt, switchId });
  return [
    {
      type: "thread.provider-switch.request",
      ...base(),
      from: claude,
      to: codex,
      triggerMessageId: messageId,
      boundaryTurnCount: 2,
    },
    { type: "thread.provider-switch.milestone", ...base(), milestone: "old-stopped" },
    {
      type: "thread.provider-switch.attempt",
      ...base(),
      attemptId: 1,
      kind: "start",
      status: "planned",
      generation: 4,
    },
    {
      type: "thread.provider-switch.attempt",
      ...base(),
      attemptId: 1,
      kind: "start",
      status: "succeeded",
    },
    {
      type: "thread.provider-switch.packet",
      ...base(),
      packetId: ProviderSwitchPacketId.make(`packet-${switchId}`),
      text: packetText,
      sha256: sha256Hex(packetText),
      chars: packetText.length,
      includedMessages: 3,
      omittedMessages: 1,
      truncated: true,
    },
    {
      type: "thread.provider-switch.attempt",
      ...base(),
      attemptId: 2,
      kind: "submit",
      status: "planned",
    },
    {
      type: "thread.provider-switch.await-user",
      ...base(),
      attemptId: 2,
      resumeCount: 0,
      reason: "unknown-delivery",
      detail: "timeout",
    },
    { type: "thread.provider-switch.resolve", ...base(), decision: "resend" },
  ];
};

const dispatchAll = (commands: ReadonlyArray<OrchestrationCommand>) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    for (const command of commands) {
      yield* engine.dispatch(command);
    }
  });

/** The in-memory projector over the whole persisted log: what the engine held before restart. */
const foldPersistedLog = Effect.gen(function* () {
  const eventStore = yield* OrchestrationEventStore;
  const events = yield* Stream.runCollect(eventStore.readFromSequence(0, Number.MAX_SAFE_INTEGER));
  let model = createEmptyReadModel(createdAt);
  for (const event of events as Iterable<OrchestrationEvent>) {
    model = yield* projectEvent(model, event);
  }
  return model;
});

engineLayer("provider switch persistence", (it) => {
  it.effect("starts the switch projector at the end of the existing log", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly lastAppliedSequence: number }>`
        SELECT last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        WHERE projector = 'projection.thread-provider-switches'
      `;
      assert.strictEqual(rows.length, 1);
    }),
  );

  it.effect("rebuilds the same switch state after a restart", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-switch-restart");
      const messageId = MessageId.make("message-switch-restart");
      yield* dispatchAll([
        {
          type: "project.create",
          commandId: commandId(),
          projectId,
          title: "Switch project",
          workspaceRoot: "/tmp/project-switch",
          defaultModelSelection: null,
          createdAt,
        },
        ...threadSetup(threadId, messageId),
        ...switchCommands(threadId, messageId, ProviderSwitchId.make("switch-restart")),
      ]);

      const inMemory = (yield* foldPersistedLog).threads.find((thread) => thread.id === threadId);
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const reloaded = (yield* snapshotQuery.getCommandReadModel()).threads.find(
        (thread) => thread.id === threadId,
      );
      assert.ok(inMemory?.providerSwitch);
      assert.deepEqual(reloaded?.providerSwitch, inMemory.providerSwitch);
      assert.strictEqual(reloaded?.providerSwitch?.pending?.resumeCount, 1);
      assert.strictEqual(reloaded?.providerSwitch?.pending?.resendAllowed, true);
    }),
  );

  it.effect("stores the exact packet text and never rewrites it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly text: string; readonly truncated: number }>`
        SELECT text, truncated
        FROM projection_thread_handoff_packets
        WHERE packet_id = 'packet-switch-restart'
      `;
      assert.deepEqual(rows, [{ text: packetText, truncated: 1 }]);
    }),
  );

  it.effect("records delivery state on the message row and survives a delivered switch", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-switch-abort");
      const messageId = MessageId.make("message-switch-abort");
      const switchId = ProviderSwitchId.make("switch-abort");
      const base = () => ({ commandId: commandId(), threadId, createdAt, switchId });
      yield* dispatchAll([
        ...threadSetup(threadId, messageId),
        {
          type: "thread.provider-switch.request",
          ...base(),
          from: claude,
          to: codex,
          triggerMessageId: messageId,
          boundaryTurnCount: 0,
        },
        { type: "thread.provider-switch.milestone", ...base(), milestone: "old-stopped" },
        {
          type: "thread.provider-switch.await-user",
          ...base(),
          attemptId: 0,
          resumeCount: 0,
          reason: "failed-retryable",
          detail: "start failed",
        },
        { type: "thread.provider-switch.abort", ...base(), returnToPrevious: false },
      ]);
      const rows = yield* sql<{ readonly deliveryState: string | null }>`
        SELECT delivery_state AS "deliveryState"
        FROM projection_thread_messages
        WHERE message_id = ${messageId}
      `;
      assert.deepEqual(rows, [{ deliveryState: "cancelled" }]);

      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const reloaded = (yield* snapshotQuery.getCommandReadModel()).threads.find(
        (thread) => thread.id === threadId,
      );
      assert.strictEqual(reloaded?.providerSwitch?.pending, null);
      assert.deepEqual(reloaded?.providerSwitch?.resolvedSwitchIds, [switchId]);
    }),
  );

  it.effect("keeps the boundary of a delivered switch across a restart", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-switch-restart");
      const switchId = ProviderSwitchId.make("switch-restart");
      const base = () => ({ commandId: commandId(), threadId, createdAt, switchId });
      const turnId = TurnId.make("turn-codex-restart");
      yield* dispatchAll([
        {
          type: "thread.provider-switch.attempt",
          ...base(),
          attemptId: 3,
          kind: "submit",
          status: "planned",
        },
        {
          type: "thread.provider-switch.attempt",
          ...base(),
          attemptId: 3,
          kind: "submit",
          status: "succeeded",
          turnId,
        },
        {
          type: "thread.provider-switch.milestone",
          ...base(),
          milestone: "delivered",
          attemptId: 3,
          turnId,
        },
      ]);
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const reloaded = (yield* snapshotQuery.getCommandReadModel()).threads.find(
        (thread) => thread.id === threadId,
      );
      assert.deepEqual(reloaded?.providerSwitch?.lastDelivered, {
        switchId,
        attemptId: 3,
        turnId,
        boundaryTurnCount: 2,
      });
    }),
  );

  it.effect("drops a re-created thread's switch state and packets", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-switch-restart");
      yield* dispatchAll([
        { type: "thread.delete", commandId: commandId(), threadId },
        ...threadSetup(threadId, MessageId.make("message-switch-recreated")),
      ]);
      const states = yield* sql`
        SELECT thread_id FROM projection_thread_provider_switch_state WHERE thread_id = ${threadId}
      `;
      const packets = yield* sql`
        SELECT packet_id FROM projection_thread_handoff_packets WHERE thread_id = ${threadId}
      `;
      assert.strictEqual(states.length, 0);
      assert.strictEqual(packets.length, 0);
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const reloaded = (yield* snapshotQuery.getCommandReadModel()).threads.find(
        (thread) => thread.id === threadId,
      );
      assert.strictEqual(reloaded?.providerSwitch, undefined);
    }),
  );

  it.effect("keeps a message's delivery state when a revert re-inserts it", () =>
    Effect.gen(function* () {
      const messages = yield* ProjectionThreadMessageRepository;
      const switches = yield* ProjectionThreadProviderSwitchRepository;
      const threadId = ThreadId.make("thread-switch-abort");
      const messageId = MessageId.make("message-switch-abort");
      // thread.reverted deletes the thread's rows and upserts the kept ones.
      const kept = yield* messages.listByThreadId({ threadId });
      assert.strictEqual(
        kept.find((row) => row.messageId === messageId)?.deliveryState,
        "cancelled",
      );
      yield* messages.deleteByThreadId({ threadId });
      for (const row of kept) {
        yield* messages.upsert(row);
      }
      const reinserted = yield* messages.getByMessageId({ messageId });
      assert.strictEqual(
        reinserted._tag === "Some" ? reinserted.value.deliveryState : null,
        "cancelled",
      );

      // A later message-sent upsert without a state never clears it.
      if (reinserted._tag === "Some") {
        const { deliveryState: _dropped, ...withoutState } = reinserted.value;
        yield* messages.upsert({ ...withoutState, text: "edited" });
      }
      const afterUpsert = yield* messages.getByMessageId({ messageId });
      assert.strictEqual(
        afterUpsert._tag === "Some" ? afterUpsert.value.deliveryState : null,
        "cancelled",
      );
      yield* switches.setMessageDeliveryState({ messageId, deliveryState: "unknown-discarded" });
      const updated = yield* messages.getByMessageId({ messageId });
      assert.strictEqual(
        updated._tag === "Some" ? updated.value.deliveryState : null,
        "unknown-discarded",
      );
    }),
  );

  it.effect("refuses a packet id reused with different content and commits nothing", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const eventStore = yield* OrchestrationEventStore;
      const switches = yield* ProjectionThreadProviderSwitchRepository;
      const packetId = ProviderSwitchPacketId.make("packet-shared");
      const prepare = (threadId: ThreadId, switchId: ProviderSwitchId) => {
        const base = () => ({ commandId: commandId(), threadId, createdAt, switchId });
        return [
          ...threadSetup(threadId, MessageId.make(`message-${threadId}`)),
          {
            type: "thread.provider-switch.request",
            ...base(),
            from: claude,
            to: codex,
            triggerMessageId: MessageId.make(`message-${threadId}`),
            boundaryTurnCount: 0,
          },
          { type: "thread.provider-switch.milestone", ...base(), milestone: "old-stopped" },
        ] satisfies OrchestrationCommand[];
      };
      const packetCommand = (threadId: ThreadId, switchId: ProviderSwitchId, text: string) =>
        ({
          type: "thread.provider-switch.packet",
          commandId: commandId(),
          threadId,
          createdAt,
          switchId,
          packetId,
          text,
          sha256: sha256Hex(text),
          chars: text.length,
          includedMessages: 1,
          omittedMessages: 0,
          truncated: false,
        }) satisfies OrchestrationCommand;
      const threadA = ThreadId.make("thread-packet-a");
      const threadB = ThreadId.make("thread-packet-b");
      const switchA = ProviderSwitchId.make("switch-packet-a");
      const switchB = ProviderSwitchId.make("switch-packet-b");
      yield* dispatchAll([...prepare(threadA, switchA), ...prepare(threadB, switchB)]);
      yield* dispatchAll([packetCommand(threadA, switchA, "packet-a")]);
      // The identical record again is accepted and changes nothing.
      yield* dispatchAll([packetCommand(threadA, switchA, "packet-a")]);

      const before = yield* Stream.runCollect(
        eventStore.readFromSequence(0, Number.MAX_SAFE_INTEGER),
      );
      const failed = yield* Effect.flip(
        engine.dispatch(packetCommand(threadB, switchB, "packet-b")),
      );
      assert.include(String(failed.message), "different content");
      const after = yield* Stream.runCollect(
        eventStore.readFromSequence(0, Number.MAX_SAFE_INTEGER),
      );
      assert.strictEqual(Array.from(after).length, Array.from(before).length);

      const stored = yield* switches.getPacket({ packetId });
      assert.strictEqual(stored._tag === "Some" ? stored.value.text : null, "packet-a");
      const stateB = yield* switches.getStateByThreadId({ threadId: threadB });
      assert.strictEqual(
        stateB._tag === "Some" ? stateB.value.state.pending?.milestone : null,
        "old-stopped",
      );
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const reloadedB = (yield* snapshotQuery.getCommandReadModel()).threads.find(
        (thread) => thread.id === threadB,
      );
      assert.strictEqual(reloadedB?.providerSwitch?.pending?.packet, null);
    }),
  );

  it.effect("moves the thread's updatedAt like the in-memory projector", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-switch-updated-at");
      const messageId = MessageId.make("message-switch-updated-at");
      const later = "2026-10-06T11:00:00.000Z";
      yield* dispatchAll([
        ...threadSetup(threadId, messageId),
        {
          type: "thread.provider-switch.request",
          commandId: commandId(),
          threadId,
          createdAt: later,
          switchId: ProviderSwitchId.make("switch-updated-at"),
          from: claude,
          to: codex,
          triggerMessageId: messageId,
          boundaryTurnCount: 0,
        },
      ]);
      const inMemory = (yield* foldPersistedLog).threads.find((thread) => thread.id === threadId);
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const reloaded = (yield* snapshotQuery.getCommandReadModel()).threads.find(
        (thread) => thread.id === threadId,
      );
      assert.strictEqual(inMemory?.updatedAt, later);
      assert.strictEqual(reloaded?.updatedAt, later);
    }),
  );
});
