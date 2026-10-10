// @effect-diagnostics nodeBuiltinImport:off - the tests seed and inspect the Creator store folder directly.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CREATOR_LIMITS,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type CreatorBindingId,
  type CreatorComment,
  type CreatorCommentId,
  type CreatorDestination,
  type CreatorPlace,
  type CreatorShotRef,
  type CreatorSnapshot,
  type CreatorStoreFile,
  type ServerSettings,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as DesktopBrowserChannel from "../preview/DesktopBrowserChannel.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as CreatorService from "./CreatorService.ts";
import { openCreatorRoot, openProjectStore, writeStoreAtomic } from "./creatorFiles.ts";
import { byteSizeOfStore, emptyCreatorState } from "./creatorState.ts";

const MB = 1024 * 1024;
const destination: CreatorDestination = {
  environmentId: EnvironmentId.make("env-1"),
  projectId: ProjectId.make("project-1"),
  threadId: ThreadId.make("thread-1"),
};
const otherThread: CreatorDestination = { ...destination, threadId: ThreadId.make("thread-2") };
const PROJECT_A = CreatorService.creatorProjectIdOf("/work/a");
const PROJECT_B = CreatorService.creatorProjectIdOf("/work/b");

const bindInput = (
  projectId = PROJECT_A,
  dest: CreatorDestination = destination,
): CreatorService.CreatorBindInput => ({
  projectId,
  servingRoot: `/serve/${projectId}`,
  sourceKind: "hyperframes",
  sourceVideo: null,
  destination: dest,
  openedBy: "user",
  preview: { url: "http://127.0.0.1:5173/", pid: 4242 },
});

/** A PNG header with the given IHDR size, padded to `size` bytes. */
const png = (width: number, height: number, size = 64): Uint8Array => {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = 8;
  bytes[25] = 6;
  bytes.set(NodeCrypto.randomBytes(Math.min(16, size - 33)), 33);
  return bytes;
};

const place: CreatorPlace = {
  x: 0.25,
  y: 0.75,
  compositionFile: "index.html",
  elementSelector: null,
  elementLabel: null,
};

interface HarnessOptions {
  readonly enabled?: boolean;
  readonly mode?: "web" | "desktop";
  readonly available?: boolean;
}

/** The service over a temp state dir, with settings whose flag the test can flip. */
const harness = (options: HarnessOptions = {}) =>
  Effect.gen(function* () {
    const configContext = yield* Layer.build(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-creator-service-" }),
    );
    const config = Context.get(configContext, ServerConfig.ServerConfig);
    const settingsRef = yield* Ref.make<ServerSettings>({
      ...DEFAULT_SERVER_SETTINGS,
      amuCreatorEnabled: options.enabled ?? true,
    });
    const changes = yield* PubSub.unbounded<ServerSettings>();
    // Every authority check reads the settings: once before the project lock and
    // once inside it. A hook runs right after a given read returned its value, so a
    // test can change authority exactly between the two checks.
    let reads = 0;
    const readHooks: Array<{ readonly at: number; readonly run: Effect.Effect<void> }> = [];
    const settingsLayer = Layer.mock(ServerSettingsService)({
      getSettings: Effect.gen(function* () {
        const current = yield* Ref.get(settingsRef);
        reads += 1;
        const due = readHooks.filter((hook) => hook.at === reads);
        for (const hook of due) yield* hook.run;
        return current;
      }),
      streamChanges: Stream.fromPubSub(changes),
      subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
    });
    const setEnabled = (enabled: boolean) =>
      Ref.updateAndGet(settingsRef, (settings) => ({
        ...settings,
        amuCreatorEnabled: enabled,
      })).pipe(Effect.flatMap((settings) => PubSub.publish(changes, settings)));
    const context = yield* Layer.build(
      CreatorService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ServerConfig.ServerConfig, {
              ...config,
              mode: options.mode ?? "desktop",
            }),
            settingsLayer,
            Layer.mock(DesktopBrowserChannel.DesktopBrowserChannel)({
              available: options.available ?? true,
            }),
          ),
        ),
      ),
    );
    const service = Context.get(context, CreatorService.CreatorService);
    const projectDir = (projectId: string) =>
      NodePath.join(config.stateDir, "creator", "projects", projectId);
    const shotsDir = (projectId: string) => NodePath.join(projectDir(projectId), "shots");
    const listShots = (projectId: string) =>
      Effect.promise(() => NodeFSP.readdir(shotsDir(projectId)).catch(() => [] as string[]));
    /** Bind and activate (epoch 1, generation 0). */
    const open = (projectId = PROJECT_A, dest: CreatorDestination = destination) =>
      Effect.gen(function* () {
        const binding = yield* service.bind(bindInput(projectId, dest));
        yield* service.setEpoch({ bindingId: binding.bindingId, epoch: 1, generation: 0 });
        return { bindingId: binding.bindingId, epoch: 1 };
      });
    /** Runs `run` right after the `count`-th settings read from now. */
    const onRead = (count: number, run: Effect.Effect<void>) =>
      Effect.sync(() => {
        readHooks.push({ at: reads + count, run });
      });
    return { service, config, setEnabled, projectDir, shotsDir, listShots, open, onRead };
  });

const draft = (
  service: CreatorService.CreatorService["Service"],
  binding: { readonly bindingId: CreatorBindingId; readonly epoch: number },
  comment = "fix the title",
) =>
  service.saveDraft({
    ...binding,
    timeSec: 1.5,
    comment,
    place: null,
    projectRevision: "rev-1",
  });

const opError = (code: string) => ({ _tag: "CreatorOperationError", code });

const baseComment = (overrides: Partial<CreatorComment> = {}): CreatorComment => ({
  id: NodeCrypto.randomUUID() as CreatorCommentId,
  number: 1,
  timeSec: 0,
  place: null,
  comment: "seed",
  revision: 1,
  status: "draft",
  shot: null,
  projectRevision: "rev-1",
  createdAt: "2026-10-09T00:00:00.000Z",
  sentAt: null,
  sentMessageId: null,
  sentVersion: null,
  resolvedNote: null,
  shotStale: false,
  ...overrides,
});

const seedStore = (stateDir: string, projectId: string, state: CreatorStoreFile) =>
  Effect.promise(async () => {
    const store = await openProjectStore(await openCreatorRoot(stateDir), projectId);
    await writeStoreAtomic(store, state);
    return store;
  });

it.layer(NodeServices.layer)("CreatorService", (it) => {
  it.effect("refuses everything while the setting is off", () =>
    Effect.gen(function* () {
      const { service } = yield* harness({ enabled: false });
      const bound = yield* Effect.flip(service.bind(bindInput()));
      expect(bound._tag).toBe("CreatorDisabledError");
      const saved = yield* Effect.flip(
        draft(service, { bindingId: NodeCrypto.randomUUID() as CreatorBindingId, epoch: 1 }),
      );
      expect(saved._tag).toBe("CreatorDisabledError");
    }).pipe(Effect.scoped),
  );

  it.effect("turning the setting off revokes bindings and ends subscriptions", () =>
    Effect.gen(function* () {
      const { service, setEnabled, open } = yield* harness();
      const binding = yield* open();
      yield* draft(service, binding);
      const subscription = yield* Stream.runDrain(service.changes(binding)).pipe(
        Effect.exit,
        Effect.forkScoped,
      );
      yield* setEnabled(false);
      const ended = yield* Fiber.join(subscription);
      expect(Exit.isFailure(ended)).toBe(true);
      const off = yield* Effect.flip(draft(service, binding));
      expect(off._tag).toBe("CreatorDisabledError");
      yield* setEnabled(true);
      const revoked = yield* Effect.flip(draft(service, binding));
      expect(revoked).toMatchObject(opError("unauthorized"));
      const required = yield* Effect.flip(service.requireBinding(binding.bindingId));
      expect(required).toMatchObject(opError("unauthorized"));
    }).pipe(Effect.scoped),
  );

  it.effect("refuses to bind outside the desktop app", () =>
    Effect.gen(function* () {
      const web = yield* harness({ mode: "web" });
      expect(yield* Effect.flip(web.service.bind(bindInput()))).toMatchObject(
        opError("unavailable"),
      );
      const detached = yield* harness({ available: false });
      expect(yield* Effect.flip(detached.service.bind(bindInput()))).toMatchObject(
        opError("unavailable"),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("refuses unknown and revoked bindings and checks the thread", () =>
    Effect.gen(function* () {
      const { service, open } = yield* harness();
      const unknown = { bindingId: NodeCrypto.randomUUID() as CreatorBindingId, epoch: 1 };
      expect(yield* Effect.flip(draft(service, unknown))).toMatchObject(opError("unauthorized"));
      const binding = yield* open();
      const found = yield* service.requireBindingForThread(PROJECT_A, destination.threadId);
      expect(found.bindingId).toBe(binding.bindingId);
      expect(
        yield* Effect.flip(service.requireBindingForThread(PROJECT_A, otherThread.threadId)),
      ).toMatchObject(opError("unauthorized"));
      expect(
        yield* Effect.flip(service.requireBindingForThread(PROJECT_B, destination.threadId)),
      ).toMatchObject(opError("unauthorized"));
      yield* service.revoke(binding.bindingId);
      expect(yield* Effect.flip(draft(service, binding))).toMatchObject(opError("unauthorized"));
      expect(
        yield* Effect.flip(service.requireBindingForThread(PROJECT_A, destination.threadId)),
      ).toMatchObject(opError("unauthorized"));
    }).pipe(Effect.scoped),
  );

  it.effect("follows the epoch and generation rules", () =>
    Effect.gen(function* () {
      const { service } = yield* harness();
      const bound = yield* service.bind(bindInput());
      expect(bound).toMatchObject({
        epoch: 0,
        generation: null,
        tabId: null,
        projectId: PROJECT_A,
      });
      const id = bound.bindingId;
      // Not activated yet: generation is null.
      expect(yield* Effect.flip(draft(service, { bindingId: id, epoch: 0 }))).toMatchObject(
        opError("stale_epoch"),
      );
      yield* service.setEpoch({ bindingId: id, epoch: 1, generation: 0 });
      expect(yield* Effect.flip(draft(service, { bindingId: id, epoch: 0 }))).toMatchObject(
        opError("stale_epoch"),
      );
      yield* draft(service, { bindingId: id, epoch: 1 });
      // Same epoch again: ignored, the binding stays active.
      const same = yield* service.setEpoch({ bindingId: id, epoch: 1, generation: null });
      expect(same).toMatchObject({ epoch: 1, generation: 0 });
      // A revoke: newer epoch, generation null. Operations at the new epoch are refused too.
      yield* service.setEpoch({ bindingId: id, epoch: 2, generation: null });
      expect(yield* Effect.flip(draft(service, { bindingId: id, epoch: 1 }))).toMatchObject(
        opError("stale_epoch"),
      );
      expect(yield* Effect.flip(draft(service, { bindingId: id, epoch: 2 }))).toMatchObject(
        opError("stale_epoch"),
      );
      // A late activation with a smaller epoch does not bring it back.
      const late = yield* service.setEpoch({ bindingId: id, epoch: 1, generation: 5 });
      expect(late).toMatchObject({ epoch: 2, generation: null });
      expect(yield* Effect.flip(draft(service, { bindingId: id, epoch: 1 }))).toMatchObject(
        opError("stale_epoch"),
      );
      yield* service.setEpoch({ bindingId: id, epoch: 3, generation: 1 });
      const saved = yield* draft(service, { bindingId: id, epoch: 3 }, "again");
      expect(saved.comment).toBe("again");
    }).pipe(Effect.scoped),
  );

  it.effect("takes the proposal's destination and binding from the binding", () =>
    Effect.gen(function* () {
      const { service, open } = yield* harness();
      const binding = yield* open();
      const comment = yield* draft(service, binding);
      const proposal = yield* service.propose({ ...binding, commentIds: [comment.id] });
      expect(proposal.destination).toEqual(destination);
      expect(proposal.bindingId).toBe(binding.bindingId);
      yield* service.cancelProposal({ ...binding, proposalId: proposal.id });
      const snapshot = yield* service.list(binding);
      expect(snapshot.proposals).toHaveLength(0);
      expect(snapshot.comments[0]?.status).toBe("draft");
    }).pipe(Effect.scoped),
  );

  it.effect("serializes concurrent saves without losing one", () =>
    Effect.gen(function* () {
      const { service, open } = yield* harness();
      const binding = yield* open();
      yield* Effect.all([draft(service, binding, "one"), draft(service, binding, "two")], {
        concurrency: "unbounded",
      });
      const snapshot = yield* service.list(binding);
      expect(snapshot.revision).toBe(2);
      expect(snapshot.comments.map((comment) => comment.comment).toSorted()).toEqual([
        "one",
        "two",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("replaces a draft through saveDraft and checks expected revisions", () =>
    Effect.gen(function* () {
      const { service, open } = yield* harness();
      const binding = yield* open();
      const created = yield* draft(service, binding);
      const replaced = yield* service.saveDraft({
        ...binding,
        commentId: created.id,
        timeSec: 3,
        comment: "replaced",
        place,
        projectRevision: "rev-2",
      });
      expect(replaced).toMatchObject({ id: created.id, comment: "replaced", place, revision: 2 });
      const stale = yield* Effect.flip(
        service.updateComment({
          ...binding,
          commentId: created.id,
          expectedRevision: 1,
          comment: "late",
        }),
      );
      expect(stale).toMatchObject(opError("stale_revision"));
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the rate limit across a reopen of the same project", () =>
    Effect.gen(function* () {
      const { service, open } = yield* harness();
      const first = yield* open();
      yield* draft(service, first);
      yield* draft(service, first);
      yield* service.revoke(first.bindingId);
      const second = yield* open();
      expect(yield* Effect.flip(draft(service, second))).toMatchObject(opError("limit"));
      // Another project has its own window.
      const other = yield* open(PROJECT_B);
      yield* draft(service, other);
    }).pipe(Effect.scoped),
  );

  it.effect("attaches a shot and reads it back", () =>
    Effect.gen(function* () {
      const { service, open, listShots } = yield* harness();
      const binding = yield* open();
      const comment = yield* draft(service, binding);
      const bytes = png(640, 360);
      const attached = yield* service.attachShot({
        ...binding,
        commentId: comment.id,
        expectedRevision: comment.revision,
        png: bytes,
      });
      expect(attached.shot).toMatchObject({
        commentId: comment.id,
        revision: comment.revision,
        width: 640,
        height: 360,
        sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
      });
      expect(yield* listShots(PROJECT_A)).toEqual([`${comment.id}-r${comment.revision}.png`]);
      const read = yield* service.readShot({
        ...binding,
        commentId: comment.id,
        revision: comment.revision,
      });
      expect(Buffer.from(read.png).equals(Buffer.from(bytes))).toBe(true);
      expect(read.shot).toEqual(attached.shot);
      // A new shot replaces the old one; the old file is no longer referenced and goes away.
      const again = yield* service.attachShot({
        ...binding,
        commentId: comment.id,
        expectedRevision: attached.revision,
        png: png(320, 180),
      });
      expect(yield* listShots(PROJECT_A)).toEqual([`${comment.id}-r${attached.revision}.png`]);
      expect(again.shot?.revision).toBe(attached.revision);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses bad PNGs and stale targets before writing any file", () =>
    Effect.gen(function* () {
      const { service, open, listShots } = yield* harness();
      const binding = yield* open();
      const comment = yield* draft(service, binding);
      const attach = (
        bytes: Uint8Array,
        overrides: Partial<{ commentId: string; rev: number }> = {},
      ) =>
        Effect.flip(
          service.attachShot({
            ...binding,
            commentId: (overrides.commentId ?? comment.id) as CreatorCommentId,
            expectedRevision: overrides.rev ?? comment.revision,
            png: bytes,
          }),
        );
      const notPng = png(10, 10);
      notPng[1] = 0;
      expect(yield* attach(notPng)).toMatchObject(opError("invalid"));
      expect(yield* attach(png(1_281, 10))).toMatchObject(opError("invalid"));
      expect(yield* attach(png(10, 1_281))).toMatchObject(opError("invalid"));
      expect(yield* attach(png(0, 10))).toMatchObject(opError("invalid"));
      expect(yield* attach(png(10, 10, CREATOR_LIMITS.maxShotBytes + 1))).toMatchObject(
        opError("limit"),
      );
      expect(yield* attach(png(10, 10), { commentId: NodeCrypto.randomUUID() })).toMatchObject(
        opError("not_found"),
      );
      expect(yield* attach(png(10, 10), { rev: comment.revision + 1 })).toMatchObject(
        opError("stale_revision"),
      );
      expect(yield* listShots(PROJECT_A)).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("removes the new shot when the store write fails, so a retake works", () =>
    Effect.gen(function* () {
      const { service, open, listShots, projectDir } = yield* harness();
      const binding = yield* open();
      const comment = yield* draft(service, binding);
      // The temp file for comments.json cannot be created; shots/ stays writable.
      yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.chmod(projectDir(PROJECT_A), 0o500)),
        () => Effect.promise(() => NodeFSP.chmod(projectDir(PROJECT_A), 0o700)),
      );
      const failed = yield* Effect.flip(
        service.attachShot({
          ...binding,
          commentId: comment.id,
          expectedRevision: comment.revision,
          png: png(100, 100),
        }),
      );
      expect(failed._tag).toBe("CreatorOperationError");
      expect(yield* listShots(PROJECT_A)).toEqual([]);
      yield* Effect.promise(() => NodeFSP.chmod(projectDir(PROJECT_A), 0o700));
      const retried = yield* service.attachShot({
        ...binding,
        commentId: comment.id,
        expectedRevision: comment.revision,
        png: png(100, 100),
      });
      expect(retried.shot?.revision).toBe(comment.revision);
      expect(yield* listShots(PROJECT_A)).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("evicts shots of confirmed comments and clears their refs", () =>
    Effect.gen(function* () {
      const { service, open, shotsDir } = yield* harness();
      const binding = yield* open();
      const confirmedId = NodeCrypto.randomUUID() as CreatorCommentId;
      const oldShot: CreatorShotRef = {
        commentId: confirmedId,
        revision: 1,
        sha256: "0".repeat(64),
        width: 10,
        height: 10,
      };
      yield* service.withProjectState(PROJECT_A, (state) =>
        Effect.succeed({
          next: {
            ...state,
            nextNumber: 2,
            comments: [
              baseComment({
                id: confirmedId,
                status: "confirmed",
                revision: 2,
                shot: oldShot,
                sentVersion: { comment: "seed", place: null, shot: oldShot, revision: 2 },
              }),
            ],
          },
          value: null,
        }),
      );
      // A sparse 48 MB file stands for the old shot.
      const oldFile = NodePath.join(shotsDir(PROJECT_A), `${confirmedId}-r1.png`);
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(oldFile, "");
        await NodeFSP.truncate(oldFile, 48 * MB);
      });
      const comment = yield* draft(service, binding);
      const attached = yield* service.attachShot({
        ...binding,
        commentId: comment.id,
        expectedRevision: comment.revision,
        png: png(100, 100, 3 * MB),
      });
      expect(attached.shot).not.toBeNull();
      const snapshot = yield* service.list(binding);
      const confirmed = snapshot.comments.find((entry) => entry.id === confirmedId);
      expect(confirmed?.shot).toBeNull();
      expect(confirmed?.sentVersion?.shot).toBeNull();
      expect(
        yield* Effect.promise(() =>
          NodeFSP.lstat(oldFile).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("sweeps unreferenced shot files when a project is first opened", () =>
    Effect.gen(function* () {
      const { service, open, config, listShots } = yield* harness();
      const keptId = NodeCrypto.randomUUID() as CreatorCommentId;
      const keptRef: CreatorShotRef = {
        commentId: keptId,
        revision: 2,
        sha256: "0".repeat(64),
        width: 1,
        height: 1,
      };
      const kept = baseComment({ id: keptId, revision: 3, shot: keptRef });
      const state: CreatorStoreFile = {
        ...emptyCreatorState(),
        revision: 1,
        nextNumber: 2,
        comments: [kept],
      };
      const store = yield* seedStore(config.stateDir, PROJECT_A, state);
      const stray = `${NodeCrypto.randomUUID()}-r1.png`;
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(NodePath.join(store.shots.path, `${kept.id}-r2.png`), "x");
        await NodeFSP.writeFile(NodePath.join(store.shots.path, stray), "x");
        await NodeFSP.writeFile(NodePath.join(store.shots.path, `${kept.id}-r1.png`), "x");
      });
      const binding = yield* open();
      yield* service.list(binding);
      expect(yield* listShots(PROJECT_A)).toEqual([`${kept.id}-r2.png`]);
    }).pipe(Effect.scoped),
  );

  it.effect("reads only shots referenced by the binding's project", () =>
    Effect.gen(function* () {
      const { service, open, shotsDir } = yield* harness();
      const a = yield* open(PROJECT_A);
      const b = yield* open(PROJECT_B, otherThread);
      const commentA = yield* draft(service, a);
      const commentB = yield* draft(service, b);
      const shotB = yield* service.attachShot({
        ...b,
        commentId: commentB.id,
        expectedRevision: commentB.revision,
        png: png(10, 10),
      });
      // Another project's comment is not visible through this binding.
      expect(
        yield* Effect.flip(
          service.readShot({ ...a, commentId: commentB.id, revision: commentB.revision }),
        ),
      ).toMatchObject(opError("not_found"));
      // A file on disk that no comment references is refused.
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(shotsDir(PROJECT_A), `${commentA.id}-r${commentA.revision}.png`),
          png(10, 10),
        ),
      );
      expect(
        yield* Effect.flip(
          service.readShot({ ...a, commentId: commentA.id, revision: commentA.revision }),
        ),
      ).toMatchObject(opError("not_found"));
      // Tampered bytes fail the hash check.
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(shotsDir(PROJECT_B), `${commentB.id}-r${commentB.revision}.png`),
          png(10, 10),
        ),
      );
      expect(
        yield* Effect.flip(
          service.readShot({ ...b, commentId: commentB.id, revision: shotB.shot!.revision }),
        ),
      ).toMatchObject(opError("conflict"));
    }).pipe(Effect.scoped),
  );

  it.effect(
    "refuses a change that would make comments.json too large and keeps the old state",
    () =>
      Effect.gen(function* () {
        const { service, open, config, projectDir } = yield* harness();
        const long = "あ".repeat(CREATOR_LIMITS.maxComment);
        const label = "あ".repeat(CREATOR_LIMITS.maxField);
        const fullPlace: CreatorPlace = { ...place, elementSelector: label, elementLabel: label };
        const comments: CreatorComment[] = [];
        for (let n = 1; n <= CREATOR_LIMITS.maxComments; n += 1) {
          comments.push(
            baseComment({
              number: n,
              status: "resolved",
              comment: n === 1 ? "short" : long,
              projectRevision: label,
              place: fullPlace,
              resolvedNote: long,
              sentVersion: { comment: long, place: fullPlace, shot: null, revision: 1 },
            }),
          );
        }
        // `state.comments` is the `comments` array itself, so trimming below updates it.
        const state: CreatorStoreFile = {
          ...emptyCreatorState(),
          revision: 7,
          nextNumber: comments.length + 1,
          comments,
        };
        const target = CREATOR_LIMITS.maxStoreBytes - 3_000;
        // Trim the last comments' notes until the store sits just under the target.
        for (let index = comments.length - 1; byteSizeOfStore(state) > target; index -= 1) {
          const over = byteSizeOfStore(state) - target;
          const note = comments[index]!.resolvedNote!;
          const keep = Math.max(0, note.length - Math.ceil(over / 3));
          comments[index] = { ...comments[index]!, resolvedNote: note.slice(0, keep) };
        }
        expect(byteSizeOfStore(state)).toBeLessThanOrEqual(target);
        expect(byteSizeOfStore(state)).toBeGreaterThan(target - 6_000);
        yield* seedStore(config.stateDir, PROJECT_A, state);
        const before = yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(projectDir(PROJECT_A), "comments.json")),
        );
        const binding = yield* open();
        const refused = yield* Effect.flip(
          service.updateComment({
            ...binding,
            commentId: comments[0]!.id,
            expectedRevision: 1,
            comment: long,
          }),
        );
        expect(refused).toMatchObject(opError("limit"));
        const snapshot = yield* service.list(binding);
        expect(snapshot.revision).toBe(7);
        expect(snapshot.comments[0]?.comment).toBe("short");
        const after = yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(projectDir(PROJECT_A), "comments.json")),
        );
        expect(after.equals(before)).toBe(true);
      }).pipe(Effect.scoped),
  );

  it.effect("binds one tab per binding", () =>
    Effect.gen(function* () {
      const { service, open } = yield* harness();
      const binding = yield* open();
      expect((yield* service.attachTab(binding.bindingId, "tab-1")).tabId).toBe("tab-1");
      expect((yield* service.attachTab(binding.bindingId, "tab-1")).tabId).toBe("tab-1");
      expect(yield* Effect.flip(service.attachTab(binding.bindingId, "tab-2"))).toMatchObject(
        opError("conflict"),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("streams the current snapshot first, then each change", () =>
    Effect.gen(function* () {
      const { service, open } = yield* harness();
      const binding = yield* open();
      yield* draft(service, binding, "first");
      const first = yield* Deferred.make<CreatorSnapshot>();
      const second = yield* Deferred.make<CreatorSnapshot>();
      yield* Stream.runForEach(service.changes(binding), (snapshot) =>
        Deferred.isDone(first).pipe(
          Effect.flatMap((done) =>
            done ? Deferred.succeed(second, snapshot) : Deferred.succeed(first, snapshot),
          ),
        ),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(first);
      yield* draft(service, binding, "second");
      const initial = yield* Deferred.await(first);
      const next = yield* Deferred.await(second);
      expect(initial.projectId).toBe(PROJECT_A);
      expect(initial.revision).toBe(1);
      expect(next.revision).toBe(2);
      expect(next.comments.map((comment) => comment.comment)).toEqual(["first", "second"]);
    }).pipe(Effect.scoped),
  );

  it.effect("resolves and confirms through the service", () =>
    Effect.gen(function* () {
      const { service, open } = yield* harness();
      const binding = yield* open();
      const sentId = NodeCrypto.randomUUID() as CreatorCommentId;
      yield* service.withProjectState(PROJECT_A, (state) =>
        Effect.succeed({
          next: { ...state, comments: [baseComment({ id: sentId, status: "sent" })] },
          value: null,
        }),
      );
      yield* service.resolve(PROJECT_A, [sentId], "done");
      const confirmed = yield* service.confirmByUser({ ...binding, commentId: sentId });
      expect(confirmed.status).toBe("confirmed");
      yield* service.deleteComment({ ...binding, commentId: sentId });
      expect((yield* service.list(binding)).comments).toHaveLength(0);
    }).pipe(Effect.scoped),
  );
  it.effect("an interrupted write finishes before the project lock is released", () =>
    Effect.gen(function* () {
      const { service, open, projectDir } = yield* harness();
      const binding = yield* open();
      yield* draft(service, binding, "one");
      const inside = yield* Deferred.make<void>();
      const added = baseComment({ number: 2, comment: "two" });
      // The step returns at once and the commit starts writing comments.json;
      // the interrupt arrives while that write is in progress.
      const writing = yield* service
        .withProjectState(PROJECT_A, (state) =>
          Deferred.succeed(inside, undefined).pipe(
            Effect.as({
              next: { ...state, nextNumber: 3, comments: [...state.comments, added] },
              value: null,
            }),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(inside);
      yield* Fiber.interrupt(writing);
      const snapshot = yield* service.list(binding);
      expect(snapshot.revision).toBe(2);
      expect(snapshot.comments.map((comment) => comment.comment)).toEqual(["one", "two"]);
      // The next save builds on the interrupted one, and disk matches memory.
      yield* draft(service, binding, "three");
      const onDisk = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(projectDir(PROJECT_A), "comments.json"), "utf8"),
      );
      const stored = JSON.parse(onDisk) as CreatorStoreFile;
      expect(stored.revision).toBe(3);
      expect(stored.comments.map((comment) => comment.comment)).toEqual(["one", "two", "three"]);
    }).pipe(Effect.scoped),
  );

  it.effect("a call admitted before a revoke cannot commit after it", () =>
    Effect.gen(function* () {
      const { service, open, onRead } = yield* harness();
      const binding = yield* open();
      // Read 1 admits the save; the revoke lands before its check inside the lock.
      yield* onRead(2, service.revoke(binding.bindingId));
      expect(yield* Effect.flip(draft(service, binding))).toMatchObject(opError("unauthorized"));
      const reopened = yield* open();
      expect((yield* service.list(reopened)).comments).toHaveLength(0);
    }).pipe(Effect.scoped),
  );

  it.effect("a call admitted before the setting goes off cannot commit after it", () =>
    Effect.gen(function* () {
      const { service, open, onRead, setEnabled } = yield* harness();
      const binding = yield* open();
      // Read 1 (before the lock) still sees the setting on; every later read sees it off.
      yield* onRead(1, setEnabled(false));
      const refused = yield* Effect.flip(draft(service, binding));
      expect(refused._tag).toBe("CreatorDisabledError");
      yield* setEnabled(true);
      const reopened = yield* open();
      expect((yield* service.list(reopened)).comments).toHaveLength(0);
    }).pipe(Effect.scoped),
  );

  it.effect("the orphan sweep goes on past an entry it cannot remove", () =>
    Effect.gen(function* () {
      const { service, open, config, listShots } = yield* harness();
      const store = yield* seedStore(config.stateDir, PROJECT_A, emptyCreatorState());
      const strays = Array.from({ length: 9 }, () => `${NodeCrypto.randomUUID()}-r1.png`);
      const folder = `${NodeCrypto.randomUUID()}-r1.png`;
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(store.shots.path, folder));
        for (const name of strays)
          await NodeFSP.writeFile(NodePath.join(store.shots.path, name), "x");
      });
      const binding = yield* open();
      yield* service.list(binding);
      expect(yield* listShots(PROJECT_A)).toEqual([folder]);
    }).pipe(Effect.scoped),
  );
});
