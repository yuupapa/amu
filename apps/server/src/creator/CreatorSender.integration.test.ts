// @effect-diagnostics nodeBuiltinImport:off - random PNG padding for the pinned shot.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type CreatorDestination,
  type CreatorProposal,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import type { ProviderAdapterV2Shape } from "../orchestration-v2/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as DesktopBrowserChannel from "../preview/DesktopBrowserChannel.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as CreatorSender from "./CreatorSender.ts";
import * as CreatorService from "./CreatorService.ts";

// The real orchestrator, event sink, receipts and projections over an in-memory
// database. No effect worker runs, so a dispatched run never reaches a provider.
const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapterV2Shape;

const destination: CreatorDestination = {
  environmentId: EnvironmentId.make("env-1"),
  projectId: ProjectId.make("project:creator-sender"),
  threadId: ThreadId.make("thread:creator-sender"),
};
const PROJECT = CreatorService.creatorProjectIdOf("/work/integration");

/** Faults injected around the real `sendToThread`. */
interface Faults {
  /** Runs before the real call (it can block or fail before anything is committed). */
  before: Effect.Effect<void, ThreadManagement.ThreadManagementError>;
  /** After the real call committed, report a failed read instead of its result. */
  failAfterCommit: boolean;
  calls: number;
}

interface PersistedCounts {
  readonly receipts: number;
  readonly messages: number;
  readonly effects: number;
}

interface CommitBoundary {
  readonly phase: "beforeCommit" | "afterCommit";
  readonly commandId: CommandId;
  readonly messageId: MessageId;
  readonly entered: Deferred.Deferred<PersistedCounts>;
}

const persistedCounts = (sql: SqlClient.SqlClient, boundary: CommitBoundary) =>
  sql<PersistedCounts>`
    SELECT
      (SELECT COUNT(*) FROM orchestration_command_receipts WHERE command_id = ${boundary.commandId}) AS receipts,
      (SELECT COUNT(*) FROM orchestration_v2_projection_messages WHERE message_id = ${boundary.messageId}) AS messages,
      (SELECT COUNT(*) FROM orchestration_v2_effect_outbox WHERE command_id = ${boundary.commandId}) AS effects
  `.pipe(Effect.map((rows) => rows[0]!));

// Only the SQL dependency is decorated. The real EventSink still writes its
// receipt, projections and outbox in the real SQLite transaction. The inner
// barrier runs after those writes, before SqlClient issues COMMIT; the outer
// barrier runs only after COMMIT has returned. No production hook is needed.
const layerCommitBoundaryDatabase = (faults: { boundary: CommitBoundary | null }) =>
  Layer.effect(
    SqlClient.SqlClient,
    Effect.gen(function* () {
      const real = yield* SqlClient.SqlClient;
      const atBoundary = (phase: CommitBoundary["phase"]) =>
        Effect.suspend(() => {
          const boundary = faults.boundary;
          if (boundary === null || boundary.phase !== phase) return Effect.void;
          return persistedCounts(real, boundary).pipe(
            Effect.orDie,
            Effect.flatMap((counts) => {
              if (counts.receipts === 0) return Effect.void;
              // One send transaction only; later read-only projection
              // transactions must remain available to prove its outcome.
              faults.boundary = null;
              return Deferred.succeed(boundary.entered, counts).pipe(Effect.andThen(Effect.never));
            }),
          );
        });
      const withTransaction: SqlClient.SqlClient["withTransaction"] = (effect) =>
        Effect.flatMap(Effect.serviceOption(real.transactionService), (current) =>
          Option.isSome(current)
            ? real.withTransaction(effect)
            : real
                .withTransaction(effect.pipe(Effect.tap(() => atBoundary("beforeCommit"))))
                .pipe(Effect.tap(() => atBoundary("afterCommit"))),
        );
      return new Proxy(real, {
        get: (target, key) =>
          key === "withTransaction" ? withTransaction : Reflect.get(target, key),
      });
    }),
  ).pipe(Layer.provide(SqlitePersistence.layerMemory));

const layerFaultyThreads = (faults: Faults) =>
  Layer.effect(
    ThreadManagement.ThreadManagementService,
    Effect.gen(function* () {
      const real = yield* ThreadManagement.ThreadManagementService;
      return ThreadManagement.ThreadManagementService.of({
        ...real,
        sendToThread: (input) =>
          Effect.suspend(() => {
            faults.calls += 1;
            return faults.before;
          }).pipe(
            Effect.andThen(real.sendToThread(input)),
            Effect.flatMap((result) =>
              faults.failAfterCommit
                ? Effect.fail(
                    new ThreadManagement.ThreadManagementProjectionLoadError({
                      projectId: input.projectId,
                      threadId: input.threadId,
                      cause: "read after commit failed",
                    }),
                  )
                : Effect.succeed(result),
            ),
          ),
      });
    }),
  );

const png = (): Uint8Array => {
  const bytes = new Uint8Array(96);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, 64);
  view.setUint32(20, 36);
  bytes.set(NodeCrypto.randomBytes(32), 40);
  return bytes;
};

const harness = Effect.gen(function* () {
  const faults: Faults = { before: Effect.void, failAfterCommit: false, calls: 0 };
  const transactionFaults: { boundary: CommitBoundary | null } = { boundary: null };
  const layerDatabase = layerCommitBoundaryDatabase(transactionFaults);
  const layerOrchestration = ProviderReplayHarness.layerWithRegistry(
    { name: "creator-sender" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );
  const layerThreads = ThreadManagement.layer.pipe(Layer.provideMerge(layerOrchestration));
  const configContext = yield* Layer.build(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-creator-sender-int-" }),
  );
  const config: ServerConfig.ServerConfig["Service"] = {
    ...Context.get(configContext, ServerConfig.ServerConfig),
    mode: "desktop",
  };
  const context = yield* Layer.build(
    Layer.mergeAll(
      CreatorSender.layerTest(Effect.void).pipe(
        Layer.provideMerge(CreatorService.layer),
        Layer.provide(
          Layer.mergeAll(
            layerFaultyThreads(faults).pipe(Layer.provide(layerThreads)),
            CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase)),
            Layer.succeed(ServerConfig.ServerConfig, config),
            Layer.mock(ServerSettingsService)({
              getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, amuCreatorEnabled: true }),
              streamChanges: Stream.empty,
              subscribeChanges: Effect.succeed(Stream.empty),
            }),
            Layer.mock(DesktopBrowserChannel.DesktopBrowserChannel)({ available: true }),
            NodeServices.layer,
          ),
        ),
      ),
      layerThreads,
      layerDatabase,
      CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase)),
    ),
  );
  const service = Context.get(context, CreatorService.CreatorService);
  const sender = Context.get(context, CreatorSender.CreatorSender);
  const threads = Context.get(context, ThreadManagement.ThreadManagementService);
  const receipts = Context.get(context, CommandReceiptStore.CommandReceiptStoreV2);
  const orchestrator = Context.get(context, Orchestrator.OrchestratorV2);

  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create:creator-sender"),
    threadId: destination.threadId,
    projectId: destination.projectId,
    title: "Creator destination",
    modelSelection: { instanceId, model: "gpt-5.1-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });

  const binding = yield* service.bind({
    projectId: PROJECT,
    servingRoot: "/work/integration",
    sourceKind: "hyperframes",
    sourceVideo: null,
    destination,
    openedBy: "user",
    preview: { url: "http://127.0.0.1:5173/", pid: null },
  });
  yield* service.setEpoch({ bindingId: binding.bindingId, epoch: 1, generation: 0 });
  const ref = { bindingId: binding.bindingId, epoch: 1 };
  const comment = yield* service.saveDraft({
    ...ref,
    timeSec: 12.5,
    comment: "タイトルを左へ",
    place: null,
    projectRevision: "rev-1",
  });
  yield* service.attachShot({
    ...ref,
    commentId: comment.id,
    expectedRevision: comment.revision,
    png: png(),
  });
  const proposal: CreatorProposal = yield* service.propose({ ...ref, commentIds: [comment.id] });
  const commandId = CommandId.make(`creator:${proposal.id}`);
  const messageId = MessageId.make(`creator:${proposal.id}`);

  /** What the database holds for this send: its receipt and its message. */
  const landed = Effect.gen(function* () {
    const receipt = yield* receipts.getByCommandId(commandId);
    const records = yield* threads.getProjectThreadRecords(
      { projectId: destination.projectId, threadId: destination.threadId },
      ["messages"],
      { messageIds: [messageId] },
    );
    return {
      receipt: Option.getOrNull(receipt)?.status ?? null,
      message: records.messages.find((message) => message.id === messageId) ?? null,
    };
  });
  const confirm = sender.confirmSend({
    ...ref,
    proposalId: proposal.id,
    revisionKey: proposal.revisionKey,
  });
  const statuses = service
    .list(ref)
    .pipe(Effect.map((snapshot) => snapshot.comments.map((entry) => entry.status)));
  const pauseCommit = (phase: CommitBoundary["phase"]) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<PersistedCounts>();
      const boundary = { phase, commandId, messageId, entered };
      transactionFaults.boundary = boundary;
      return {
        entered: Deferred.await(entered),
        counts: persistedCounts(Context.get(context, SqlClient.SqlClient), boundary),
        clear: Effect.sync(() => {
          transactionFaults.boundary = null;
        }),
      };
    });
  return { faults, sender, ref, proposal, landed, confirm, statuses, pauseCommit };
});

it.layer(NodeServices.layer)("CreatorSender with the real orchestrator", (it) => {
  it.effect("a send interrupted before the commit leaves nothing behind and is resent", () =>
    Effect.gen(function* () {
      const { faults, sender, landed, confirm, statuses } = yield* harness;
      const entered = yield* Deferred.make<void>();
      faults.before = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
      const fiber = yield* confirm.pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(fiber);

      expect(yield* landed).toEqual({ receipt: null, message: null });
      expect(yield* statuses).toEqual(["sending"]);

      faults.before = Effect.void;
      // Automatic resends of one proposal are at least 30 seconds apart.
      yield* TestClock.adjust("30 seconds");
      yield* sender.reconcile(PROJECT);
      const after = yield* landed;
      expect(after.receipt).toBe("accepted");
      expect(after.message?.text.startsWith("Amu Creator から修正依頼（1 件）")).toBe(true);
      expect(after.message?.attachments).toHaveLength(1);
      expect(yield* statuses).toEqual(["sent"]);
      expect(faults.calls).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "interrupting the real EventSink transaction rolls back receipt, message and outbox",
    () =>
      Effect.gen(function* () {
        const { faults, sender, landed, confirm, statuses, pauseCommit } = yield* harness;
        const boundary = yield* pauseCommit("beforeCommit");
        const fiber = yield* confirm.pipe(Effect.forkScoped);
        const written = yield* boundary.entered;
        expect(written.receipts).toBe(1);
        expect(written.messages).toBe(1);
        expect(written.effects).toBeGreaterThan(0);

        // Wait for the original real send and SQLite rollback to finish before
        // using absence as evidence that the same proposal can be resent.
        yield* Fiber.interrupt(fiber);
        expect(yield* landed).toEqual({ receipt: null, message: null });
        expect(yield* boundary.counts).toEqual({ receipts: 0, messages: 0, effects: 0 });
        expect(yield* statuses).toEqual(["sending"]);
        yield* boundary.clear;
        yield* TestClock.adjust("30 seconds");
        yield* sender.reconcile(PROJECT);
        const after = yield* landed;
        expect(after.receipt).toBe("accepted");
        expect(after.message?.attachments).toHaveLength(1);
        const persisted = yield* boundary.counts;
        expect(persisted.receipts).toBe(1);
        expect(persisted.messages).toBe(1);
        expect(persisted.effects).toBe(written.effects);
        expect(yield* statuses).toEqual(["sent"]);
        expect(faults.calls).toBe(2);
      }).pipe(Effect.scoped),
  );

  it.effect("interrupting just after SQLite COMMIT settles the real send without resending", () =>
    Effect.gen(function* () {
      const { faults, sender, landed, confirm, statuses, pauseCommit } = yield* harness;
      const boundary = yield* pauseCommit("afterCommit");
      const fiber = yield* confirm.pipe(Effect.forkScoped);
      const written = yield* boundary.entered;
      expect(written.receipts).toBe(1);
      expect(written.messages).toBe(1);
      expect(written.effects).toBeGreaterThan(0);
      yield* Fiber.interrupt(fiber);
      expect((yield* landed).receipt).toBe("accepted");
      expect(yield* boundary.counts).toEqual(written);
      expect(yield* statuses).toEqual(["sending"]);
      yield* boundary.clear;
      yield* sender.reconcile(PROJECT);
      expect(yield* statuses).toEqual(["sent"]);
      expect(yield* boundary.counts).toEqual(written);
      expect(faults.calls).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("a failure after the commit is settled from the receipt without a resend", () =>
    Effect.gen(function* () {
      const { faults, sender, landed, confirm, statuses } = yield* harness;
      faults.failAfterCommit = true;
      expect(yield* confirm).toMatchObject({ state: "sending" });
      const after = yield* landed;
      expect(after.receipt).toBe("accepted");
      expect(after.message).not.toBeNull();

      faults.failAfterCommit = false;
      yield* sender.reconcile(PROJECT);
      expect(yield* statuses).toEqual(["sent"]);
      expect(faults.calls).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("halting a send that never landed finds no receipt and no message, then drafts", () =>
    Effect.gen(function* () {
      const { faults, sender, ref, proposal, landed, confirm, statuses } = yield* harness;
      faults.before = Effect.fail(
        new ThreadManagement.ThreadManagementProjectionLoadError({
          projectId: destination.projectId,
          threadId: destination.threadId,
          cause: "lost before dispatch",
        }),
      );
      expect(yield* confirm).toMatchObject({ state: "sending" });
      expect(yield* landed).toEqual({ receipt: null, message: null });
      const halted = yield* sender.haltSend({ ...ref, proposalId: proposal.id });
      expect(halted).toEqual({ proposalId: proposal.id, state: "rejected", reason: "halted" });
      expect(yield* statuses).toEqual(["draft"]);
      expect(faults.calls).toBe(1);
    }).pipe(Effect.scoped),
  );
});
