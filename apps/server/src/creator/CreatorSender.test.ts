// @effect-diagnostics nodeBuiltinImport:off - the tests read the Creator store and attachment files directly.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  MessageId,
  ProjectId,
  ThreadId,
  type CreatorBindingId,
  type CreatorDestination,
  type CreatorPlace,
  type CreatorProposal,
  type CreatorStoreFile,
  type OrchestrationV2ConversationMessage,
  type ServerSettings,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { createDeterministicAttachmentId } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { AttachmentClaimError } from "../orchestration-v2/AttachmentClaims.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as DesktopBrowserChannel from "../preview/DesktopBrowserChannel.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as CreatorSender from "./CreatorSender.ts";
import * as CreatorService from "./CreatorService.ts";

const NOW = DateTime.makeUnsafe("2026-10-09T00:00:00.000Z");
const destination: CreatorDestination = {
  environmentId: EnvironmentId.make("env-1"),
  projectId: ProjectId.make("project-1"),
  threadId: ThreadId.make("thread-1"),
};
const PROJECT = CreatorService.creatorProjectIdOf("/work/shinbashira");
/** Automatic resends of one proposal are at least this far apart. */
const RESEND_PAUSE = "30 seconds";

const place: CreatorPlace = {
  x: 0.7,
  y: 0.62,
  compositionFile: "compositions/sc05-shinbashira.html",
  elementSelector: "#sc05-core-rect",
  elementLabel: "金の柱",
};

/** A PNG header with the given IHDR size and random padding. */
const png = (width = 64, height = 36): Uint8Array => {
  const bytes = new Uint8Array(96);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set(NodeCrypto.randomBytes(32), 40);
  return bytes;
};

type SendFailure = ThreadManagement.ThreadManagementError | Orchestrator.OrchestratorV2Error;
type SendBehavior = (
  input: ThreadManagement.ThreadManagementSendInput,
  world: World,
) => Effect.Effect<ThreadManagement.ThreadManagementSendResult, SendFailure>;

/** The destination thread and its command receipts, as the mocks see them. */
interface World {
  readonly receipts: Map<string, CommandReceiptStore.CommandReceiptV2>;
  readonly messages: Map<string, OrchestrationV2ConversationMessage>;
  readonly calls: Array<ThreadManagement.ThreadManagementSendInput>;
  archived: boolean;
  receiptQueryFails: boolean;
  threadQueryFails: boolean;
  /** Runs once, inside the next thread read. */
  onThreadRead: Effect.Effect<void> | null;
  behavior: SendBehavior;
}

const commit = (
  world: World,
  input: ThreadManagement.ThreadManagementSendInput,
  text = input.text,
) =>
  Effect.sync(() => {
    world.receipts.set(input.commandId, {
      commandId: input.commandId,
      threadId: input.threadId,
      commandType: "message.dispatch",
      acceptedAt: NOW,
      resultSequence: world.receipts.size + 1,
      status: "accepted",
      error: null,
    });
    const message = {
      id: input.messageId,
      threadId: input.threadId,
      runId: null,
      nodeId: null,
      role: "user",
      text,
      attachments: input.attachments,
      streaming: false,
      createdAt: NOW,
      updatedAt: NOW,
      createdBy: input.createdBy,
      creationSource: input.creationSource,
    } as OrchestrationV2ConversationMessage;
    world.messages.set(input.messageId, message);
    return message;
  });

const asResult = (message: OrchestrationV2ConversationMessage) =>
  ({ message }) as unknown as ThreadManagement.ThreadManagementSendResult;

const accept: SendBehavior = (input, world) => commit(world, input).pipe(Effect.map(asResult));
/** Committed, then the read after the commit failed: the caller cannot tell. */
const lostAfterCommit: SendBehavior = (input, world) =>
  commit(world, input).pipe(
    Effect.andThen(
      Effect.fail(
        new ThreadManagement.ThreadManagementProjectionLoadError({
          projectId: input.projectId,
          threadId: input.threadId,
          cause: "read after commit failed",
        }),
      ),
    ),
  );
/** A generic dispatch failure with nothing committed: the caller cannot tell either. */
const lostBeforeCommit: SendBehavior = (input) =>
  Effect.fail(
    new Orchestrator.OrchestratorDispatchError({
      commandId: input.commandId,
      commandType: "message.dispatch",
      cause: "connection reset",
    }),
  );
const refused: SendBehavior = (input) =>
  Effect.fail(
    new Orchestrator.OrchestratorCommandRejectedError({
      commandId: input.commandId,
      commandType: "message.dispatch",
    }),
  );
const archivedAtSend: SendBehavior = (input) =>
  Effect.fail(
    new ThreadManagement.ThreadManagementThreadArchivedError({ threadId: input.threadId }),
  );
const mismatched: SendBehavior = (input, world) =>
  commit(world, input, "someone else's text").pipe(Effect.map(asResult));
const gated =
  (entered: Deferred.Deferred<void>, gate: Deferred.Deferred<void>, then: SendBehavior) =>
  (input: ThreadManagement.ThreadManagementSendInput, world: World) =>
    Deferred.succeed(entered, undefined).pipe(
      Effect.andThen(Deferred.await(gate)),
      Effect.andThen(then(input, world)),
    );

const makeWorld = (): World => ({
  receipts: new Map(),
  messages: new Map(),
  calls: [],
  archived: false,
  receiptQueryFails: false,
  threadQueryFails: false,
  onThreadRead: null,
  behavior: accept,
});

const getProjectThreadRecords =
  (world: World): ThreadManagement.ThreadManagementServiceShape["getProjectThreadRecords"] =>
  (input, _fields, filter) =>
    Effect.suspend(() => {
      const hook = world.onThreadRead;
      world.onThreadRead = null;
      return hook ?? Effect.void;
    }).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          if (world.threadQueryFails) {
            return Effect.fail(
              new ThreadManagement.ThreadManagementProjectionLoadError({
                projectId: input.projectId,
                threadId: input.threadId,
                cause: "projection read failed",
              }),
            );
          }
          const messages = [...world.messages.values()].filter(
            (message) => filter?.messageIds === undefined || filter.messageIds.includes(message.id),
          );
          return Effect.succeed({
            thread: {
              id: input.threadId,
              projectId: input.projectId,
              archivedAt: world.archived ? NOW : null,
              deletedAt: null,
            },
            messages,
          } as never);
        }),
      ),
    );

const layerWorld = (world: World) =>
  Layer.mergeAll(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      sendToThread: (input) =>
        Effect.suspend(() => {
          world.calls.push(input);
          return world.behavior(input, world);
        }),
      getProjectThreadRecords: getProjectThreadRecords(world),
    }),
    Layer.mock(CommandReceiptStore.CommandReceiptStoreV2)({
      getByCommandId: (commandId) =>
        Effect.suspend(() =>
          world.receiptQueryFails
            ? Effect.fail(new CommandReceiptStore.CommandReceiptStoreReadError({ commandId }))
            : Effect.succeed(Option.fromNullishOr(world.receipts.get(commandId))),
        ),
    }),
  );

/** A command-readiness gate the test opens and closes. */
const makeGate = Effect.gen(function* () {
  const opened = yield* Deferred.make<void>();
  const blocked = yield* Deferred.make<void>();
  const state = { open: true };
  return {
    gate: Effect.suspend(() =>
      state.open
        ? Effect.void
        : Deferred.succeed(blocked, undefined).pipe(Effect.andThen(Deferred.await(opened))),
    ),
    close: Effect.sync(() => {
      state.open = false;
    }),
    open: Effect.sync(() => {
      state.open = true;
    }).pipe(Effect.andThen(Deferred.succeed(opened, undefined))),
    /** Completes once a caller is waiting at the closed gate. */
    blocked: Deferred.await(blocked),
  };
});

/** One state dir and one destination thread; `start` builds a server lifetime over them. */
const harness = (
  options: {
    readonly enabled?: boolean;
    /** Stands in for the server's command-readiness gate. */
    readonly commandGate?: Effect.Effect<void>;
  } = {},
) =>
  Effect.gen(function* () {
    const configContext = yield* Layer.build(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-creator-sender-" }),
    );
    const config: ServerConfig.ServerConfig["Service"] = {
      ...Context.get(configContext, ServerConfig.ServerConfig),
      mode: "desktop",
    };
    const settingsRef = yield* Ref.make<ServerSettings>({
      ...DEFAULT_SERVER_SETTINGS,
      amuCreatorEnabled: options.enabled ?? true,
    });
    const changes = yield* PubSub.unbounded<ServerSettings>();
    // A hook runs right after the given settings read (counted from when it is set).
    let reads = 0;
    const readHooks: Array<{ readonly at: number; readonly run: Effect.Effect<void> }> = [];
    const onSettingsRead = (count: number, run: Effect.Effect<void>) =>
      Effect.sync(() => {
        readHooks.push({ at: reads + count, run });
      });
    const settingsLayer = Layer.mock(ServerSettingsService)({
      getSettings: Effect.gen(function* () {
        const current = yield* Ref.get(settingsRef);
        reads += 1;
        for (const hook of readHooks.filter((entry) => entry.at === reads)) yield* hook.run;
        return current;
      }),
      streamChanges: Stream.fromPubSub(changes),
      subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
    });
    const setEnabled = (enabled: boolean) =>
      Ref.updateAndGet(settingsRef, (settings) => ({
        ...settings,
        amuCreatorEnabled: enabled,
      })).pipe(
        Effect.flatMap((settings) => PubSub.publish(changes, settings)),
        Effect.asVoid,
      );
    const world = makeWorld();
    const start = Effect.gen(function* () {
      const context = yield* Layer.build(
        CreatorSender.layerTest(options.commandGate ?? Effect.void).pipe(
          Layer.provideMerge(CreatorService.layer),
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ServerConfig.ServerConfig, config),
              settingsLayer,
              Layer.mock(DesktopBrowserChannel.DesktopBrowserChannel)({ available: true }),
              layerWorld(world),
              NodeServices.layer,
            ),
          ),
        ),
      );
      const service = Context.get(context, CreatorService.CreatorService);
      const sender = Context.get(context, CreatorSender.CreatorSender);
      const open = Effect.gen(function* () {
        const binding = yield* service.bind({
          projectId: PROJECT,
          servingRoot: "/work/shinbashira",
          sourceKind: "hyperframes",
          sourceVideo: null,
          destination,
          openedBy: "user",
          preview: { url: "http://127.0.0.1:5173/", pid: null },
        });
        yield* service.setEpoch({ bindingId: binding.bindingId, epoch: 1, generation: 0 });
        return { bindingId: binding.bindingId, epoch: 1 };
      });
      return { service, sender, open };
    });
    const storeFile = Effect.promise(
      async () =>
        JSON.parse(
          await NodeFSP.readFile(
            NodePath.join(config.stateDir, "creator", "projects", PROJECT, "comments.json"),
            "utf8",
          ),
        ) as CreatorStoreFile,
    );
    return { config, world, setEnabled, onSettingsRead, start, storeFile };
  });

type Instance =
  Effect.Success<ReturnType<typeof harness>>["start"] extends Effect.Effect<
    infer A,
    infer _E,
    infer _R
  >
    ? A
    : never;
type Binding = { readonly bindingId: CreatorBindingId; readonly epoch: number };

/** Up to two comments (the draft rate limit), the first with a shot, in one proposal. */
const proposal = (
  instance: Instance,
  binding: Binding,
  options: { readonly comments?: 1 | 2; readonly shot?: boolean } = {},
) =>
  Effect.gen(function* () {
    const ids = [];
    for (let index = 0; index < (options.comments ?? 1); index += 1) {
      const comment = yield* instance.service.saveDraft({
        ...binding,
        timeSec: 76.2 + index,
        comment: `柱を太く ${index}`,
        place: index === 0 ? place : null,
        projectRevision: "rev-1",
      });
      if (index === 0 && options.shot !== false) {
        yield* instance.service.attachShot({
          ...binding,
          commentId: comment.id,
          expectedRevision: comment.revision,
          png: png(),
        });
      }
      ids.push(comment.id);
    }
    return yield* instance.service.propose({ ...binding, commentIds: ids });
  });

const confirm = (instance: Instance, binding: Binding, created: CreatorProposal) =>
  instance.sender.confirmSend({
    ...binding,
    proposalId: created.id,
    revisionKey: created.revisionKey,
  });

const statuses = (instance: Instance, binding: Binding) =>
  instance.service
    .list(binding)
    .pipe(Effect.map((snapshot) => snapshot.comments.map((comment) => comment.status)));

const opError = (code: string) => ({ _tag: "CreatorOperationError", code });

it.layer(NodeServices.layer)("CreatorSender", (it) => {
  it.effect("an accepted send marks the comments sent with the message id", () =>
    Effect.gen(function* () {
      const { world, start, config } = yield* harness();
      const instance = yield* start;
      const binding = yield* instance.open;
      const created = yield* proposal(instance, binding, { comments: 2 });
      const result = yield* confirm(instance, binding, created);
      expect(result).toEqual({ proposalId: created.id, state: "accepted", reason: null });

      expect(world.calls).toHaveLength(1);
      const call = world.calls[0]!;
      const messageId = MessageId.make(`creator:${created.id}`);
      expect(call).toMatchObject({
        projectId: destination.projectId,
        threadId: destination.threadId,
        commandId: CommandId.make(`creator:${created.id}`),
        messageId,
        mode: "auto",
        createdBy: "user",
        creationSource: "web",
      });
      expect(call.text.split("\n")[0]).toBe("Amu Creator から修正依頼（2 件）");
      expect(call.text).toContain("｜画像 1 枚目｜");
      expect(call.text).toContain("｜場所なし｜画像なし｜");
      // One image, under a deterministic id, holding the pinned shot's bytes.
      const attachmentId = createDeterministicAttachmentId(destination.threadId, `${messageId}:0`);
      expect(call.attachments.map((attachment) => attachment.id)).toEqual([attachmentId]);
      const written = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(config.attachmentsDir, `${attachmentId}.png`)),
      );
      expect(written.byteLength).toBe(call.attachments[0]!.sizeBytes);

      const snapshot = yield* instance.service.list(binding);
      expect(snapshot.proposals).toEqual([]);
      expect(snapshot.comments.map((comment) => [comment.status, comment.sentMessageId])).toEqual([
        ["sent", messageId],
        ["sent", messageId],
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("a refused send goes back to draft with the reason kept", () =>
    Effect.gen(function* () {
      const { world, start, storeFile } = yield* harness();
      world.behavior = refused;
      const instance = yield* start;
      const binding = yield* instance.open;
      const created = yield* proposal(instance, binding);
      const result = yield* confirm(instance, binding, created);
      expect(result).toMatchObject({ state: "rejected" });
      expect(result.reason).toContain("OrchestratorCommandRejectedError");
      expect(yield* statuses(instance, binding)).toEqual(["draft"]);
      const stored = yield* storeFile;
      expect(stored.history[0]).toMatchObject({ id: created.id, outcome: "rejected" });
    }).pipe(Effect.scoped),
  );

  it.effect("an archived destination is refused without sending", () =>
    Effect.gen(function* () {
      const { world, start } = yield* harness();
      world.archived = true;
      const instance = yield* start;
      const binding = yield* instance.open;
      const created = yield* proposal(instance, binding);
      const result = yield* confirm(instance, binding, created);
      expect(result).toEqual({
        proposalId: created.id,
        state: "rejected",
        reason: "thread_archived",
      });
      expect(world.calls).toHaveLength(0);
      expect(yield* statuses(instance, binding)).toEqual(["draft"]);
    }).pipe(Effect.scoped),
  );

  it.effect("a thread archived right before dispatch is a definite refusal", () =>
    Effect.gen(function* () {
      const { world, start } = yield* harness();
      world.behavior = archivedAtSend;
      const instance = yield* start;
      const binding = yield* instance.open;
      const created = yield* proposal(instance, binding);
      expect(yield* confirm(instance, binding, created)).toMatchObject({ state: "rejected" });
      expect(yield* statuses(instance, binding)).toEqual(["draft"]);
    }).pipe(Effect.scoped),
  );

  it.effect("a lost response stays sending until the receipt is found, with one dispatch", () =>
    Effect.gen(function* () {
      const { world, start } = yield* harness();
      world.behavior = lostAfterCommit;
      const instance = yield* start;
      const binding = yield* instance.open;
      const created = yield* proposal(instance, binding);
      expect(yield* confirm(instance, binding, created)).toMatchObject({ state: "sending" });
      expect(yield* statuses(instance, binding)).toEqual(["sending"]);
      yield* instance.sender.reconcile(PROJECT);
      expect(yield* statuses(instance, binding)).toEqual(["sent"]);
      expect(world.calls).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("after a restart a committed send is found by its receipt", () =>
    Effect.gen(function* () {
      const { world, start } = yield* harness();
      world.behavior = lostAfterCommit;
      const first = yield* start;
      const binding = yield* first.open;
      yield* confirm(first, binding, yield* proposal(first, binding));

      const second = yield* start;
      yield* second.sender.startupDone;
      const reopened = yield* second.open;
      expect(yield* statuses(second, reopened)).toEqual(["sent"]);
      expect(world.calls).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("after a restart an uncommitted send is resent once with the same record", () =>
    Effect.gen(function* () {
      const { world, start } = yield* harness();
      world.behavior = lostBeforeCommit;
      const first = yield* start;
      const binding = yield* first.open;
      yield* confirm(first, binding, yield* proposal(first, binding));
      expect(world.calls).toHaveLength(1);

      yield* TestClock.adjust(RESEND_PAUSE);
      world.behavior = accept;
      const second = yield* start;
      yield* second.sender.startupDone;
      const reopened = yield* second.open;
      expect(yield* statuses(second, reopened)).toEqual(["sent"]);
      expect(world.calls).toHaveLength(2);
      const [original, resent] = world.calls;
      const payload = (call: ThreadManagement.ThreadManagementSendInput) => ({
        commandId: call.commandId,
        messageId: call.messageId,
        threadId: call.threadId,
        text: call.text,
        attachments: call.attachments,
      });
      expect(payload(resent!)).toEqual(payload(original!));
    }).pipe(Effect.scoped),
  );

  it.effect("two confirmations of one proposal send once", () =>
    Effect.gen(function* () {
      const { world, start } = yield* harness();
      const entered = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      world.behavior = gated(entered, gate, accept);
      const instance = yield* start;
      const binding = yield* instance.open;
      const created = yield* proposal(instance, binding);
      const first = yield* confirm(instance, binding, created).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const second = yield* confirm(instance, binding, created).pipe(
        Effect.flip,
        Effect.forkScoped,
      );
      yield* Deferred.succeed(gate, undefined);
      expect(yield* Fiber.join(first)).toMatchObject({ state: "accepted" });
      expect((yield* Fiber.join(second))._tag).toBe("CreatorOperationError");
      expect(world.calls).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("an edit before confirming voids the proposal and nothing is sent", () =>
    Effect.gen(function* () {
      const { world, start } = yield* harness();
      const instance = yield* start;
      const binding = yield* instance.open;
      const created = yield* proposal(instance, binding, { shot: false });
      // A stale revision key: the proposal is voided.
      const stale = yield* Effect.flip(
        instance.sender.confirmSend({ ...binding, proposalId: created.id, revisionKey: "old" }),
      );
      expect(stale).toMatchObject(opError("stale_revision"));
      expect(yield* statuses(instance, binding)).toEqual(["draft"]);
      expect(world.calls).toHaveLength(0);
    }).pipe(Effect.scoped),
  );

  it.effect("an edited comment voids the proposal before confirming", () =>
    Effect.gen(function* () {
      const { world, start } = yield* harness();
      const instance = yield* start;
      const binding = yield* instance.open;
      const created = yield* proposal(instance, binding, { shot: false });
      const comment = (yield* instance.service.list(binding)).comments[0]!;
      yield* instance.service.updateComment({
        ...binding,
        commentId: comment.id,
        expectedRevision: comment.revision,
        comment: "やっぱり細く",
      });
      expect(yield* Effect.flip(confirm(instance, binding, created))).toMatchObject(
        opError("not_found"),
      );
      expect(world.calls).toHaveLength(0);
    }).pipe(Effect.scoped),
  );

  it.effect("a receipt whose message differs from the record is a conflict, not a resend", () =>
    Effect.gen(function* () {
      const { world, start } = yield* harness();
      world.behavior = mismatched;
      const instance = yield* start;
      const binding = yield* instance.open;
      const created = yield* proposal(instance, binding);
      expect(yield* confirm(instance, binding, created)).toMatchObject({
        state: "conflict",
        reason: "content_mismatch",
      });
      yield* instance.sender.reconcile(PROJECT);
      const snapshot = yield* instance.service.list(binding);
      expect(snapshot.proposals[0]!.send).toMatchObject({ state: "conflict" });
      expect(world.calls).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("the user's acknowledgement finishes a conflict as sent, and nothing else", () =>
    Effect.gen(function* () {
      const { world, start } = yield* harness();
      world.behavior = mismatched;
      const instance = yield* start;
      const binding = yield* instance.open;
      const created = yield* proposal(instance, binding);
      const acknowledge = instance.sender.acknowledgeConflict({
        ...binding,
        proposalId: created.id,
      });
      // Not started yet: nothing to acknowledge.
      expect(yield* Effect.flip(acknowledge)).toMatchObject(opError("conflict"));
      expect(yield* confirm(instance, binding, created)).toMatchObject({ state: "conflict" });
      // A stale epoch cannot acknowledge.
      expect(
        yield* Effect.flip(
          instance.sender.acknowledgeConflict({ ...binding, epoch: 0, proposalId: created.id }),
        ),
      ).toMatchObject(opError("stale_epoch"));

      expect(yield* acknowledge).toEqual({
        proposalId: created.id,
        state: "accepted",
        reason: null,
      });
      const snapshot = yield* instance.service.list(binding);
      expect(snapshot.proposals).toHaveLength(0);
      expect(snapshot.comments[0]).toMatchObject({
        status: "sent",
        sentMessageId: MessageId.make(`creator:${created.id}`),
      });
      // Acknowledging never sends anything, and a second one is a no-op report.
      expect(world.calls).toHaveLength(1);
      expect(yield* acknowledge).toMatchObject({ state: "accepted" });
    }).pipe(Effect.scoped),
  );

  it.effect("acknowledging a send that is not in conflict is refused and changes nothing", () =>
    Effect.gen(function* () {
      const { world, start } = yield* harness();
      world.behavior = lostBeforeCommit;
      const instance = yield* start;
      const binding = yield* instance.open;
      const created = yield* proposal(instance, binding);
      expect(yield* confirm(instance, binding, created)).toMatchObject({ state: "sending" });
      expect(
        yield* Effect.flip(
          instance.sender.acknowledgeConflict({ ...binding, proposalId: created.id }),
        ),
      ).toMatchObject(opError("conflict"));
      expect(yield* statuses(instance, binding)).toEqual(["sending"]);
    }).pipe(Effect.scoped),
  );

  it.effect("reconcile also checks the content behind a found receipt", () =>
    Effect.gen(function* () {
      const { world, start } = yield* harness();
      world.behavior = (input, current) =>
        commit(current, input, "different").pipe(
          Effect.andThen(
            Effect.fail(
              new Orchestrator.OrchestratorDispatchError({
                commandId: input.commandId,
                commandType: "message.dispatch",
              }),
            ),
          ),
        );
      const instance = yield* start;
      const binding = yield* instance.open;
      yield* confirm(instance, binding, yield* proposal(instance, binding));
      yield* instance.sender.reconcile(PROJECT);
      const snapshot = yield* instance.service.list(binding);
      expect(snapshot.proposals[0]!.send).toMatchObject({ state: "conflict" });
      expect(world.calls).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("halting while in flight keeps it halted; a late acceptance still wins", () =>
    Effect.gen(function* () {
      const { world, start } = yield* harness();
      const entered = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      world.behavior = gated(entered, gate, accept);
      const instance = yield* start;
      const binding = yield* instance.open;
      const created = yield* proposal(instance, binding);
      const sending = yield* confirm(instance, binding, created).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      // Returns while the send still holds the proposal's lock.
      const halted = yield* instance.sender.haltSend({ ...binding, proposalId: created.id });
      expect(halted).toMatchObject({ state: "halted" });
      expect((yield* instance.service.list(binding)).proposals[0]!.send).toMatchObject({
        state: "halted",
        haltRequested: true,
      });
      yield* Deferred.succeed(gate, undefined);
      expect(yield* Fiber.join(sending)).toMatchObject({ state: "accepted" });
      expect(yield* statuses(instance, binding)).toEqual(["sent"]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "halting after an unknown outcome with no receipt and no message returns to draft",
    () =>
      Effect.gen(function* () {
        const { world, start, storeFile } = yield* harness();
        world.behavior = lostBeforeCommit;
        const instance = yield* start;
        const binding = yield* instance.open;
        const created = yield* proposal(instance, binding);
        yield* confirm(instance, binding, created);
        const result = yield* instance.sender.haltSend({ ...binding, proposalId: created.id });
        expect(result).toEqual({ proposalId: created.id, state: "rejected", reason: "halted" });
        expect(yield* statuses(instance, binding)).toEqual(["draft"]);
        expect((yield* storeFile).reservations).toEqual({});
        yield* instance.sender.reconcile(PROJECT);
        expect(world.calls).toHaveLength(1);
      }).pipe(Effect.scoped),
  );

  it.effect("a failed query keeps a halted send halted, and it is never resent", () =>
    Effect.gen(function* () {
      const { world, start } = yield* harness();
      world.behavior = lostBeforeCommit;
      const instance = yield* start;
      const binding = yield* instance.open;
      const created = yield* proposal(instance, binding);
      yield* confirm(instance, binding, created);
      yield* TestClock.adjust(RESEND_PAUSE);
      world.receiptQueryFails = true;
      const result = yield* instance.sender.haltSend({ ...binding, proposalId: created.id });
      expect(result.state).toBe("halted");
      expect(result.reason).toContain("unverified");
      world.receiptQueryFails = false;
      world.threadQueryFails = true;
      yield* instance.sender.reconcile(PROJECT);
      expect((yield* instance.service.list(binding)).proposals[0]!.send).toMatchObject({
        state: "halted",
      });
      expect(yield* statuses(instance, binding)).toEqual(["sending"]);
      world.threadQueryFails = false;
      yield* instance.sender.reconcile(PROJECT);
      expect(yield* statuses(instance, binding)).toEqual(["draft"]);
      expect(world.calls).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("resend attempts survive a restart and the third makes the send stuck", () =>
    Effect.gen(function* () {
      const { world, start, storeFile } = yield* harness();
      world.behavior = lostBeforeCommit;
      const first = yield* start;
      const binding = yield* first.open;
      yield* confirm(first, binding, yield* proposal(first, binding));
      yield* TestClock.adjust(RESEND_PAUSE);
      yield* first.sender.reconcile(PROJECT);
      expect(world.calls).toHaveLength(2);
      expect((yield* storeFile).proposals[0]!.send).toMatchObject({ attempts: 1 });

      yield* TestClock.adjust(RESEND_PAUSE);
      const second = yield* start;
      yield* second.sender.startupDone;
      expect((yield* storeFile).proposals[0]!.send).toMatchObject({
        attempts: 2,
        state: "sending",
      });
      yield* TestClock.adjust(RESEND_PAUSE);
      yield* second.sender.reconcile(PROJECT);
      expect((yield* storeFile).proposals[0]!.send).toMatchObject({
        attempts: 3,
        state: "stuck",
      });
      yield* TestClock.adjust(RESEND_PAUSE);
      yield* second.sender.reconcile(PROJECT);
      expect(world.calls).toHaveLength(4);
    }).pipe(Effect.scoped),
  );

  it.effect("with the setting off, reconcile only reads receipts and never resends", () =>
    Effect.gen(function* () {
      const { world, start, setEnabled } = yield* harness();
      world.behavior = lostBeforeCommit;
      const instance = yield* start;
      const binding = yield* instance.open;
      const created = yield* proposal(instance, binding);
      yield* confirm(instance, binding, created);
      yield* TestClock.adjust(RESEND_PAUSE);
      yield* setEnabled(false);
      yield* instance.sender.reconcile(PROJECT);
      expect(world.calls).toHaveLength(1);
      // The dispatch had committed after all.
      yield* commit(world, world.calls[0]!);
      yield* instance.sender.reconcile(PROJECT);
      yield* setEnabled(true);
      const reopened = yield* instance.open;
      expect(yield* statuses(instance, reopened)).toEqual(["sent"]);
      expect(world.calls).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("the periodic pass resends only for projects with open sends", () =>
    Effect.gen(function* () {
      const { world, start } = yield* harness();
      world.behavior = lostBeforeCommit;
      const instance = yield* start;
      const binding = yield* instance.open;
      yield* confirm(instance, binding, yield* proposal(instance, binding));
      world.behavior = accept;
      yield* TestClock.adjust(RESEND_PAUSE);
      yield* instance.sender.reconcileOpen;
      expect(yield* statuses(instance, binding)).toEqual(["sent"]);
      yield* instance.sender.reconcileOpen;
      expect(world.calls).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  it.effect("a stale epoch or another binding cannot confirm", () =>
    Effect.gen(function* () {
      const { world, start } = yield* harness();
      const instance = yield* start;
      const binding = yield* instance.open;
      const created = yield* proposal(instance, binding);
      const other = yield* instance.open;
      expect(yield* Effect.flip(confirm(instance, other, created))).toMatchObject(
        opError("unauthorized"),
      );
      yield* instance.service.setEpoch({ bindingId: binding.bindingId, epoch: 2, generation: 0 });
      expect(yield* Effect.flip(confirm(instance, binding, created))).toMatchObject(
        opError("stale_epoch"),
      );
      expect(world.calls).toHaveLength(0);
      expect(
        yield* confirm(instance, { bindingId: binding.bindingId, epoch: 2 }, created),
      ).toMatchObject({ state: "accepted" });
    }).pipe(Effect.scoped),
  );
  it.effect("a setting turned off during confirmation stops the dispatch", () =>
    Effect.gen(function* () {
      const { world, start, setEnabled } = yield* harness();
      const instance = yield* start;
      const binding = yield* instance.open;
      const created = yield* proposal(instance, binding);
      // Turned off while confirmSend reads the destination thread, after its admission.
      world.onThreadRead = setEnabled(false);
      expect(yield* confirm(instance, binding, created)).toMatchObject({ state: "sending" });
      expect(world.calls).toHaveLength(0);
      yield* setEnabled(true);
      yield* TestClock.adjust(RESEND_PAUSE);
      yield* instance.sender.reconcile(PROJECT);
      expect(world.calls).toHaveLength(1);
      const reopened = yield* instance.open;
      expect(yield* statuses(instance, reopened)).toEqual(["sent"]);
    }).pipe(Effect.scoped),
  );

  it.effect("a setting turned off during a reconcile pass stops the resend", () =>
    Effect.gen(function* () {
      const { world, start, setEnabled, storeFile } = yield* harness();
      world.behavior = lostBeforeCommit;
      const instance = yield* start;
      const binding = yield* instance.open;
      yield* confirm(instance, binding, yield* proposal(instance, binding));
      yield* TestClock.adjust(RESEND_PAUSE);
      // The pass starts with the setting on; it goes off while the thread is read.
      world.onThreadRead = setEnabled(false);
      yield* instance.sender.reconcile(PROJECT);
      expect(world.calls).toHaveLength(1);
      expect((yield* storeFile).proposals[0]!.send).toMatchObject({ attempts: 0 });
    }).pipe(Effect.scoped),
  );

  it.effect("a confirmed send waits for the server to accept commands", () =>
    Effect.gen(function* () {
      const gate = yield* makeGate;
      const { world, start } = yield* harness({ commandGate: gate.gate });
      const instance = yield* start;
      yield* instance.sender.startupDone;
      const binding = yield* instance.open;
      const created = yield* proposal(instance, binding);
      yield* gate.close;
      const fiber = yield* confirm(instance, binding, created).pipe(Effect.forkScoped);
      yield* gate.blocked;
      expect(world.calls).toHaveLength(0);
      yield* gate.open;
      expect(yield* Fiber.join(fiber)).toMatchObject({ state: "accepted" });
      expect(world.calls).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("a resend waits for the server to accept commands", () =>
    Effect.gen(function* () {
      const gate = yield* makeGate;
      const { world, start } = yield* harness({ commandGate: gate.gate });
      world.behavior = lostBeforeCommit;
      const instance = yield* start;
      yield* instance.sender.startupDone;
      const binding = yield* instance.open;
      yield* confirm(instance, binding, yield* proposal(instance, binding));
      world.behavior = accept;
      yield* TestClock.adjust(RESEND_PAUSE);
      yield* gate.close;
      const fiber = yield* instance.sender.reconcile(PROJECT).pipe(Effect.forkScoped);
      yield* gate.blocked;
      expect(world.calls).toHaveLength(1);
      yield* gate.open;
      yield* Fiber.join(fiber);
      expect(world.calls).toHaveLength(2);
      expect(yield* statuses(instance, binding)).toEqual(["sent"]);
    }).pipe(Effect.scoped),
  );

  it.effect("a revoke that lands after confirmSend was admitted does not cancel it", () =>
    Effect.gen(function* () {
      const { world, start, onSettingsRead } = yield* harness();
      const instance = yield* start;
      yield* instance.sender.startupDone;
      const binding = yield* instance.open;
      const created = yield* proposal(instance, binding);
      // Read 1 admits the call; read 2 starts the pre-send reconcile. The revoke lands there.
      yield* onSettingsRead(
        2,
        instance.service
          .setEpoch({ bindingId: binding.bindingId, epoch: 2, generation: null })
          .pipe(Effect.asVoid, Effect.orDie),
      );
      expect(yield* confirm(instance, binding, created)).toMatchObject({ state: "accepted" });
      expect(world.calls).toHaveLength(1);
      // A confirmSend that arrives after the revoke is refused.
      expect(yield* Effect.flip(confirm(instance, binding, created))).toMatchObject(
        opError("stale_epoch"),
      );
      expect(world.calls).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("a halt between beginSend and dispatch is settled by the periodic pass", () =>
    Effect.gen(function* () {
      const gate = yield* makeGate;
      const { world, start } = yield* harness({ commandGate: gate.gate });
      const instance = yield* start;
      yield* instance.sender.startupDone;
      const binding = yield* instance.open;
      const created = yield* proposal(instance, binding);
      yield* gate.close;
      const fiber = yield* confirm(instance, binding, created).pipe(Effect.forkScoped);
      // The record is pinned; the dispatch waits at the gate.
      yield* gate.blocked;
      expect(yield* instance.sender.haltSend({ ...binding, proposalId: created.id })).toMatchObject(
        { state: "halted" },
      );
      yield* gate.open;
      expect(yield* Fiber.join(fiber)).toMatchObject({ state: "halted" });
      expect(world.calls).toHaveLength(0);
      yield* instance.sender.reconcileOpen;
      expect(yield* statuses(instance, binding)).toEqual(["draft"]);
    }).pipe(Effect.scoped),
  );

  it.effect("automatic resends of one proposal are at least 30 seconds apart", () =>
    Effect.gen(function* () {
      const { world, start, storeFile } = yield* harness();
      world.behavior = lostBeforeCommit;
      const instance = yield* start;
      const binding = yield* instance.open;
      yield* confirm(instance, binding, yield* proposal(instance, binding));
      // A storm of triggers right after the send resends nothing.
      for (let index = 0; index < 3; index += 1) {
        yield* instance.sender.reconcile(PROJECT);
        yield* instance.sender.reconcileOpen;
      }
      yield* TestClock.adjust("29 seconds");
      yield* instance.sender.reconcile(PROJECT);
      expect(world.calls).toHaveLength(1);
      yield* TestClock.adjust("1 second");
      yield* instance.sender.reconcile(PROJECT);
      yield* instance.sender.reconcile(PROJECT);
      expect(world.calls).toHaveLength(2);
      expect((yield* storeFile).proposals[0]!.send).toMatchObject({ attempts: 1 });
    }).pipe(Effect.scoped),
  );
});

it("classifySendFailure separates definite refusals from unknown outcomes", () => {
  const commandId = CommandId.make("creator:x");
  const threadId = ThreadId.make("thread-1");
  const projectId = ProjectId.make("project-1");
  const messageId = MessageId.make("creator:x");
  const table: ReadonlyArray<readonly [{ readonly _tag: string }, "rejected" | "unknown"]> = [
    [new AttachmentClaimError({ message: "too big" }), "rejected"],
    [new ThreadManagement.ThreadManagementThreadArchivedError({ threadId }), "rejected"],
    [
      new ThreadManagement.ThreadManagementNoSteerableRunError({ threadId, mode: "steer" }),
      "rejected",
    ],
    [
      new Orchestrator.OrchestratorCommandRejectedError({ commandId, commandType: "m" }),
      "rejected",
    ],
    [new Orchestrator.OrchestratorProjectionError({ threadId }), "rejected"],
    [
      new Orchestrator.OrchestratorCommandPreviouslyRejectedError({
        commandId,
        commandType: "m",
        detail: "no",
      }),
      "rejected",
    ],
    [
      new Orchestrator.OrchestratorCommandIdConflictError({
        commandId,
        commandType: "m",
        receiptThreadId: threadId,
        commandThreadId: threadId,
      }),
      "rejected",
    ],
    [new Orchestrator.OrchestratorSubagentThreadReadOnlyError({ commandId, threadId }), "rejected"],
    [new Orchestrator.OrchestratorDispatchError({ commandId, commandType: "m" }), "unknown"],
    [new Orchestrator.OrchestratorDomainEventStreamError({}), "unknown"],
    [
      new ThreadManagement.ThreadManagementProjectionLoadError({ projectId, threadId, cause: 1 }),
      "unknown",
    ],
    [
      new ThreadManagement.ThreadManagementDurableRunProjectionError({ threadId, messageId }),
      "unknown",
    ],
    [new ThreadManagement.ThreadManagementThreadNotFoundError({ projectId, threadId }), "unknown"],
  ];
  for (const [error, expected] of table) {
    expect([error._tag, CreatorSender.classifySendFailure(error)]).toEqual([error._tag, expected]);
  }
});
