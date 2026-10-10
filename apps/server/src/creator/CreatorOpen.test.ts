// @effect-diagnostics nodeBuiltinImport:off - the tests build HyperFrames folders, videos and links on disk.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ThreadId,
  type CreatorProjectId,
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
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as DesktopBrowserChannel from "../preview/DesktopBrowserChannel.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as CreatorOpen from "./CreatorOpen.ts";
import * as Supervisor from "./CreatorPreviewSupervisor.ts";
import * as CreatorService from "./CreatorService.ts";

const environmentId = EnvironmentId.make("env-creator-open");
const threadId = ThreadId.make("thread-creator-open");
const otherThreadId = ThreadId.make("thread-creator-open-other");

interface HarnessOptions {
  readonly enabled?: boolean;
  readonly mode?: "web" | "desktop";
  readonly available?: boolean;
  readonly ffprobe?: (file: string) => Promise<number>;
  readonly beforeBuild?: (stateDir: string) => Promise<void>;
  readonly afterShutdownStarted?: Effect.Effect<void>;
}

type EnsureBehaviour = "ok" | "bad_url" | "limit";

const opError = (code: string) => ({ _tag: "CreatorOperationError", code });

/**
 * CreatorOpen over a temp workspace, a real CreatorService and PreviewManager,
 * and a fake preview supervisor that records ensure/stop and never spawns.
 */
const harness = (options: HarnessOptions = {}) =>
  Effect.gen(function* () {
    const base = yield* Effect.promise(async () =>
      NodeFSP.realpath(await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "amu-creator-open-"))),
    );
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => NodeFSP.rm(base, { recursive: true, force: true })),
    );
    const work = NodePath.join(base, "work");
    const outside = NodePath.join(base, "outside");
    yield* Effect.promise(async () => {
      await NodeFSP.mkdir(work);
      await NodeFSP.mkdir(outside);
    });

    const configContext = yield* Layer.build(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-creator-open-" }),
    );
    const config = Context.get(configContext, ServerConfig.ServerConfig);
    const settingsRef = yield* Ref.make<ServerSettings>({
      ...DEFAULT_SERVER_SETTINGS,
      amuCreatorEnabled: options.enabled ?? true,
    });
    const changes = yield* PubSub.unbounded<ServerSettings>();
    const settingsLayer = Layer.mock(ServerSettingsService)({
      getSettings: Ref.get(settingsRef),
      streamChanges: Stream.fromPubSub(changes),
      subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
    });

    const released = yield* Queue.unbounded<string>();
    const setEnabled = (enabled: boolean) =>
      Ref.updateAndGet(settingsRef, (current) => ({ ...current, amuCreatorEnabled: enabled })).pipe(
        Effect.flatMap((current) => PubSub.publish(changes, current)),
      );
    const ensured: string[] = [];
    const stopped: string[] = [];
    let behaviour: EnsureBehaviour = "ok";
    let port = 41000;
    const supervisorLayer = Layer.succeed(Supervisor.CreatorPreviewSupervisor, {
      ensure: (root) =>
        Effect.suspend(() => {
          ensured.push(root);
          if (behaviour === "limit") {
            return Effect.fail(new Supervisor.CreatorPreviewLimitError({ limit: 3 }));
          }
          port += 1;
          return Effect.succeed({
            url: behaviour === "bad_url" ? "ftp://127.0.0.1/" : `http://127.0.0.1:${port}/`,
            port,
            pid: 4242,
          });
        }),
      stop: (root) =>
        Effect.sync(() => {
          stopped.push(root);
        }),
    });

    const threadsLayer = Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: (id) =>
        Effect.succeed(
          id === threadId || id === otherThreadId
            ? { ...liveThreadShell(id), worktreePath: work }
            : null,
        ),
    });

    const deps = Layer.mergeAll(
      Layer.succeed(ServerConfig.ServerConfig, { ...config, mode: options.mode ?? "desktop" }),
      settingsLayer,
      Layer.mock(DesktopBrowserChannel.DesktopBrowserChannel)({
        available: options.available ?? true,
      }),
    );
    if (options.beforeBuild) {
      yield* Effect.promise(() => options.beforeBuild!(config.stateDir));
    }
    const serviceScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(serviceScope, Exit.void));
    const context = yield* Layer.buildWithScope(
      CreatorOpen.layerWith({
        ffprobe: options.ffprobe ?? (async () => 2),
        afterRelease: (bindingId) => Queue.offer(released, bindingId).pipe(Effect.asVoid),
        ...(options.afterShutdownStarted
          ? { afterShutdownStarted: options.afterShutdownStarted }
          : {}),
      }).pipe(
        Layer.provideMerge(CreatorService.layer),
        Layer.provideMerge(PreviewManager.layer),
        Layer.provide(supervisorLayer),
        Layer.provide(threadsLayer),
        Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
        Layer.provide(
          Layer.succeed(ServerEnvironment.ServerEnvironment, {
            getEnvironmentId: Effect.succeed(environmentId),
            getDescriptor: Effect.die("unused"),
          }),
        ),
        Layer.provideMerge(deps),
      ),
      serviceScope,
    );
    const opener = Context.get(context, CreatorOpen.CreatorOpen);
    const creator = Context.get(context, CreatorService.CreatorService);
    const previews = Context.get(context, PreviewManager.PreviewManager);

    /** A HyperFrames folder (hyperframes.json + index.html). */
    const hyperframes = (dir: string) =>
      Effect.promise(async () => {
        await NodeFSP.mkdir(dir, { recursive: true });
        await NodeFSP.writeFile(NodePath.join(dir, "hyperframes.json"), "{}");
        await NodeFSP.writeFile(NodePath.join(dir, "index.html"), "<html></html>");
        return dir;
      });
    const video = (file: string) =>
      Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
        await NodeFSP.writeFile(file, "not really a video");
        return file;
      });
    const reviewDir = (projectId: CreatorProjectId) =>
      Effect.promise(async () =>
        NodePath.join(await NodeFSP.realpath(config.stateDir), "creator", "review", projectId),
      );
    const exists = (path: string) =>
      Effect.promise(() =>
        NodeFSP.lstat(path).then(
          () => true,
          () => false,
        ),
      );
    return {
      base,
      work,
      outside,
      config,
      opener,
      closeService: Scope.close(serviceScope, Exit.void),
      creator,
      previews,
      ensured,
      stopped,
      setEnabled,
      /** Waits for the next `count` releases and returns their binding ids. */
      nextReleased: (count: number) =>
        Effect.forEach(Array.from({ length: count }), () => Queue.take(released)),
      setBehaviour: (next: EnsureBehaviour) => {
        behaviour = next;
      },
      hyperframes,
      video,
      reviewDir,
      exists,
    };
  });

it.layer(NodeServices.layer)("CreatorOpen", (it) => {
  it.effect("an interrupted video open waits for its copy and removes it", () =>
    Effect.gen(function* () {
      const entered = Promise.withResolvers<void>();
      const probe = Promise.withResolvers<number>();
      let copiedFile = "";
      const h = yield* harness({
        ffprobe: (file) => {
          copiedFile = file;
          entered.resolve();
          return probe.promise;
        },
      });
      const clip = yield* h.video(NodePath.join(h.work, "clip.mp4"));
      const opening = yield* h.opener
        .open({ path: clip, threadId, openedBy: "user" })
        .pipe(Effect.forkScoped);
      yield* Effect.promise(() => entered.promise);
      const interrupted = yield* Fiber.interrupt(opening).pipe(Effect.forkScoped);
      probe.resolve(2);
      yield* Fiber.join(interrupted);
      expect(yield* h.exists(NodePath.dirname(copiedFile))).toBe(false);
      expect(h.ensured).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("closing the service releases live tabs, previews and review copies", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const clip = yield* h.video(NodePath.join(h.work, "clip.mp4"));
      const project = yield* h.hyperframes(NodePath.join(h.work, "promo"));
      const mp4 = yield* h.opener.open({ path: clip, threadId, openedBy: "user" });
      const hf = yield* h.opener.open({ path: project, threadId, openedBy: "user" });
      const copy = h.ensured[0]!;
      yield* h.closeService;
      expect(h.stopped.toSorted()).toEqual([copy, project].toSorted());
      expect(yield* h.exists(copy)).toBe(false);
      expect((yield* h.previews.list({ threadId })).sessions).toEqual([]);
      for (const binding of [mp4, hf]) {
        expect(yield* Effect.flip(h.creator.requireBinding(binding.bindingId))).toMatchObject(
          opError("unauthorized"),
        );
      }
    }).pipe(Effect.scoped),
  );

  it.effect("shutdown waits for concurrent opens and refuses new requests", () =>
    Effect.gen(function* () {
      const shutdown = yield* Deferred.make<void>();
      const entered = Promise.withResolvers<void>();
      const probe = Promise.withResolvers<number>();
      const copies: string[] = [];
      const h = yield* harness({
        afterShutdownStarted: Deferred.succeed(shutdown, undefined).pipe(Effect.asVoid),
        ffprobe: async (file) => {
          copies.push(await NodeFSP.realpath(NodePath.dirname(file)));
          if (copies.length === 2) entered.resolve();
          return probe.promise;
        },
      });
      const clips = yield* Effect.forEach(["a.mp4", "b.mp4"], (name) =>
        h.video(NodePath.join(h.work, name)),
      );
      const openings = yield* Effect.forEach(clips, (path) =>
        h.opener.open({ path, threadId, openedBy: "user" }).pipe(Effect.forkScoped),
      );
      yield* Effect.promise(() => entered.promise);
      const closing = yield* h.closeService.pipe(Effect.forkScoped);
      yield* Deferred.await(shutdown);
      const refused = yield* Effect.flip(
        h.opener.open({ path: clips[0]!, threadId, openedBy: "user" }),
      );
      expect(refused).toMatchObject({ ...opError("unavailable"), detail: "creator_stopped" });
      probe.resolve(2);
      yield* Effect.forEach(openings, Fiber.join);
      yield* Fiber.join(closing);
      expect(h.stopped.toSorted()).toEqual(copies.toSorted());
      for (const copy of copies) expect(yield* h.exists(copy)).toBe(false);
      expect((yield* h.previews.list({ threadId })).sessions).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("startup removes abandoned review copies and preserves unrelated names", () =>
    Effect.gen(function* () {
      const id = "0123456789abcdef0123456789abcdef";
      const openId = "11111111-1111-4111-8111-111111111111";
      let copy = "";
      let unrelated = "";
      const h = yield* harness({
        beforeBuild: async (stateDir) => {
          const project = NodePath.join(stateDir, "creator", "review", id);
          copy = NodePath.join(project, openId);
          unrelated = NodePath.join(project, "keep-me");
          await NodeFSP.mkdir(copy, { recursive: true });
          await NodeFSP.writeFile(NodePath.join(copy, "video.mp4"), "abandoned");
          await NodeFSP.mkdir(unrelated);
          await NodeFSP.writeFile(NodePath.join(unrelated, "sentinel"), "keep");
        },
      });
      expect(yield* h.exists(copy)).toBe(false);
      expect(yield* h.exists(NodePath.join(unrelated, "sentinel"))).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("an agent opens a HyperFrames folder inside its workspace", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const project = yield* h.hyperframes(NodePath.join(h.work, "promo"));
      const opened = yield* h.opener.open({ path: "promo", threadId, openedBy: "agent" });
      expect(opened.projectId).toBe(CreatorService.creatorProjectIdFor(project, threadId));
      expect(opened.epoch).toBe(0);
      expect(h.ensured).toEqual([project]);
      const binding = yield* h.creator.requireBinding(opened.bindingId);
      expect(binding).toMatchObject({
        tabId: opened.tabId,
        servingRoot: project,
        sourceKind: "hyperframes",
        openedBy: "agent",
        destination: { environmentId, projectId: "project:mcp-test", threadId },
      });
      const tabs = yield* h.previews.list({ threadId });
      expect(tabs.sessions.map((tab) => [tab.tabId, tab.creator, tab.reveal])).toEqual([
        [opened.tabId, { bindingId: opened.bindingId, label: "promo" }, true],
      ]);
      const forThread = yield* h.creator.requireBindingForThread(opened.projectId, threadId);
      expect(forThread.bindingId).toBe(opened.bindingId);
    }).pipe(Effect.scoped),
  );

  it.effect("an agent cannot open anything outside its workspace", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const project = yield* h.hyperframes(NodePath.join(h.outside, "promo"));
      yield* Effect.promise(() => NodeFSP.symlink(project, NodePath.join(h.work, "alias")));
      for (const path of [project, "../outside/promo", "alias"]) {
        const refused = yield* Effect.flip(h.opener.open({ path, threadId, openedBy: "agent" }));
        expect(refused).toMatchObject(opError("unauthorized"));
      }
      expect(h.ensured).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("the user may open a folder outside the workspace, by absolute path only", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const project = yield* h.hyperframes(NodePath.join(h.outside, "promo"));
      const opened = yield* h.opener.open({ path: project, threadId, openedBy: "user" });
      expect(opened.projectId).toBe(CreatorService.creatorProjectIdFor(project, threadId));
      expect((yield* h.creator.requireBinding(opened.bindingId)).openedBy).toBe("user");
      // The user opened it from the right panel, where it already shows: nothing to reveal.
      const tabs = yield* h.previews.list({ threadId });
      expect(tabs.sessions.map((tab) => [tab.tabId, tab.reveal])).toEqual([
        [opened.tabId, undefined],
      ]);
      const relative = yield* Effect.flip(
        h.opener.open({ path: "outside/promo", threadId, openedBy: "user" }),
      );
      expect(relative).toMatchObject(opError("invalid"));
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a folder that is not a HyperFrames project, and other files", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(h.work, "plain"));
        await NodeFSP.writeFile(NodePath.join(h.work, "plain", "index.html"), "<html></html>");
        await NodeFSP.writeFile(NodePath.join(h.work, "notes.txt"), "hi");
      });
      for (const path of ["plain", "notes.txt", "missing"]) {
        const refused = yield* Effect.flip(h.opener.open({ path, threadId, openedBy: "agent" }));
        expect(refused._tag).toBe("CreatorOperationError");
      }
      const missing = yield* Effect.flip(
        h.opener.open({ path: NodePath.join(h.outside, "missing"), threadId, openedBy: "user" }),
      );
      expect(missing).toMatchObject(opError("not_found"));
      const plain = yield* Effect.flip(
        h.opener.open({ path: NodePath.join(h.work, "plain"), threadId, openedBy: "user" }),
      );
      expect(plain).toMatchObject(opError("invalid"));
      expect(h.ensured).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a project with a link that points outside it", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const project = yield* h.hyperframes(NodePath.join(h.work, "promo"));
      // The leak points at the Creator state folder, the thing the scan protects.
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(h.config.stateDir, "creator"), { recursive: true });
        await NodeFSP.symlink(
          NodePath.join(h.config.stateDir, "creator"),
          NodePath.join(project, "leak.json"),
        );
      });
      const refused = yield* Effect.flip(
        h.opener.open({ path: project, threadId, openedBy: "user" }),
      );
      expect(refused).toMatchObject(opError("invalid"));
      expect(String((refused as { detail: string }).detail)).toContain("outward_link");
      expect(h.ensured).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("an mp4 is served from a review copy, with the project id of the source video", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const clip = yield* h.video(NodePath.join(h.outside, "clip.mp4"));
      const opened = yield* h.opener.open({ path: clip, threadId, openedBy: "user" });
      expect(opened.projectId).toBe(CreatorService.creatorProjectIdFor(clip, threadId));
      const review = yield* h.reviewDir(opened.projectId);
      expect(h.ensured).toHaveLength(1);
      const root = h.ensured[0]!;
      expect(NodePath.dirname(root)).toBe(review);
      expect((yield* Effect.promise(() => NodeFSP.readdir(root))).toSorted()).toEqual([
        "index.html",
        "video.mp4",
      ]);
      const binding = yield* h.creator.requireBinding(opened.bindingId);
      expect(binding).toMatchObject({ sourceKind: "mp4", sourceVideo: clip, servingRoot: root });
      const tabs = yield* h.previews.list({ threadId });
      expect(tabs.sessions[0]?.creator?.label).toBe("clip.mp4");
    }).pipe(Effect.scoped),
  );

  it.effect("reopening an mp4 builds the new open, then stops and removes the previous one", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const clip = yield* h.video(NodePath.join(h.work, "clip.mp4"));
      const first = yield* h.opener.open({ path: "clip.mp4", threadId, openedBy: "agent" });
      const firstRoot = h.ensured[0]!;
      const second = yield* h.opener.open({ path: clip, threadId, openedBy: "user" });
      expect(second.projectId).toBe(first.projectId);
      const secondRoot = h.ensured[1]!;
      expect(secondRoot).not.toBe(firstRoot);
      expect(h.stopped).toEqual([firstRoot]);
      expect(yield* h.exists(firstRoot)).toBe(false);
      expect(yield* h.exists(secondRoot)).toBe(true);
      const revoked = yield* Effect.flip(h.creator.requireBinding(first.bindingId));
      expect(revoked).toMatchObject(opError("unauthorized"));
      const tabs = yield* h.previews.list({ threadId });
      expect(tabs.sessions.map((tab) => tab.tabId)).toEqual([second.tabId]);
      // A different video is a different project.
      const other = yield* h.video(NodePath.join(h.work, "other.mov"));
      const third = yield* h.opener.open({ path: other, threadId, openedBy: "user" });
      expect(third.projectId).not.toBe(first.projectId);
    }).pipe(Effect.scoped),
  );

  it.effect("a failed mp4 reopen leaves the working open alone", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const clip = yield* h.video(NodePath.join(h.work, "clip.mp4"));
      const first = yield* h.opener.open({ path: clip, threadId, openedBy: "user" });
      const firstRoot = h.ensured[0]!;
      h.setBehaviour("bad_url");
      yield* Effect.flip(h.opener.open({ path: clip, threadId, openedBy: "user" }));
      const failedRoot = h.ensured[1]!;
      expect(h.stopped).toEqual([failedRoot]);
      expect(yield* h.exists(firstRoot)).toBe(true);
      expect(yield* h.exists(failedRoot)).toBe(false);
      expect((yield* h.creator.requireBinding(first.bindingId)).tabId).toBe(first.tabId);
      const tabs = yield* h.previews.list({ threadId });
      expect(tabs.sessions.map((tab) => tab.tabId)).toEqual([first.tabId]);
    }).pipe(Effect.scoped),
  );

  it.effect("the same folder in two threads is two projects, and neither revokes the other", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const project = yield* h.hyperframes(NodePath.join(h.work, "promo"));
      const inA = yield* h.opener.open({ path: project, threadId, openedBy: "user" });
      const inB = yield* h.opener.open({
        path: "promo",
        threadId: otherThreadId,
        openedBy: "agent",
      });
      expect(inB.projectId).not.toBe(inA.projectId);
      // One preview serves both.
      expect(h.ensured).toEqual([project, project]);
      yield* h.creator.requireBinding(inA.bindingId);
      yield* h.creator.requireBinding(inB.bindingId);
      const foreign = yield* Effect.flip(
        h.creator.requireBindingForThread(inA.projectId, otherThreadId),
      );
      expect(foreign).toMatchObject(opError("unauthorized"));
      // Reopening in B replaces only B's open.
      const againInB = yield* h.opener.open({
        path: project,
        threadId: otherThreadId,
        openedBy: "user",
      });
      expect(againInB.projectId).toBe(inB.projectId);
      yield* h.creator.requireBinding(inA.bindingId);
      expect((yield* h.previews.list({ threadId })).sessions).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("closing a tab revokes its binding, stops an unused preview and removes the copy", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const clip = yield* h.video(NodePath.join(h.work, "clip.mp4"));
      const project = yield* h.hyperframes(NodePath.join(h.work, "promo"));
      const mp4 = yield* h.opener.open({ path: clip, threadId, openedBy: "user" });
      const mp4Root = h.ensured[0]!;
      const inA = yield* h.opener.open({ path: project, threadId, openedBy: "user" });
      const inB = yield* h.opener.open({
        path: project,
        threadId: otherThreadId,
        openedBy: "user",
      });

      yield* h.previews.close({ threadId, tabId: mp4.tabId });
      expect(yield* h.nextReleased(1)).toEqual([mp4.bindingId]);
      expect(h.stopped).toEqual([mp4Root]);
      expect(yield* h.exists(mp4Root)).toBe(false);
      const revoked = yield* Effect.flip(h.creator.requireBinding(mp4.bindingId));
      expect(revoked).toMatchObject(opError("unauthorized"));

      // The folder's preview keeps running while thread B still shows it.
      yield* h.previews.close({ threadId, tabId: inA.tabId });
      expect(yield* h.nextReleased(1)).toEqual([inA.bindingId]);
      expect(h.stopped).toEqual([mp4Root]);
      yield* h.creator.requireBinding(inB.bindingId);
      yield* h.previews.close({ threadId: otherThreadId, tabId: inB.tabId });
      expect(yield* h.nextReleased(1)).toEqual([inB.bindingId]);
      expect(h.stopped).toEqual([mp4Root, project]);
    }).pipe(Effect.scoped),
  );

  it.effect("turning the setting off releases every open and closes its tab", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const clip = yield* h.video(NodePath.join(h.work, "clip.mp4"));
      const project = yield* h.hyperframes(NodePath.join(h.work, "promo"));
      const mp4 = yield* h.opener.open({ path: clip, threadId, openedBy: "user" });
      const mp4Root = h.ensured[0]!;
      const hf = yield* h.opener.open({ path: project, threadId, openedBy: "user" });
      yield* h.setEnabled(false);
      expect((yield* h.nextReleased(2)).toSorted()).toEqual(
        [mp4.bindingId, hf.bindingId].toSorted(),
      );
      expect(h.stopped.toSorted()).toEqual([mp4Root, project].toSorted());
      expect(yield* h.exists(mp4Root)).toBe(false);
      expect((yield* h.previews.list({ threadId })).sessions).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("reopening a HyperFrames folder in the same thread reuses its preview", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const project = yield* h.hyperframes(NodePath.join(h.work, "promo"));
      const first = yield* h.opener.open({ path: "promo", threadId, openedBy: "agent" });
      const second = yield* h.opener.open({ path: project, threadId, openedBy: "user" });
      expect(second.projectId).toBe(first.projectId);
      expect(h.ensured).toEqual([project, project]);
      expect(h.stopped).toEqual([]);
      const revoked = yield* Effect.flip(h.creator.requireBinding(first.bindingId));
      expect(revoked).toMatchObject(opError("unauthorized"));
      const tabs = yield* h.previews.list({ threadId });
      expect(tabs.sessions.map((tab) => tab.tabId)).toEqual([second.tabId]);
      // Another thread gets its own binding next to this one.
      const elsewhere = yield* h.opener.open({
        path: project,
        threadId: otherThreadId,
        openedBy: "user",
      });
      yield* h.creator.requireBinding(second.bindingId);
      yield* h.creator.requireBinding(elsewhere.bindingId);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a failure after the preview started undoes the binding, the preview and the copy",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const clip = yield* h.video(NodePath.join(h.work, "clip.mp4"));
        const project = yield* h.hyperframes(NodePath.join(h.work, "promo"));
        h.setBehaviour("bad_url");
        const mp4 = yield* Effect.flip(h.opener.open({ path: clip, threadId, openedBy: "user" }));
        expect(mp4._tag).toBe("CreatorOperationError");
        const mp4Root = h.ensured[0]!;
        expect(h.stopped).toEqual([mp4Root]);
        expect(yield* h.exists(mp4Root)).toBe(false);
        const projectId = CreatorService.creatorProjectIdFor(clip, threadId);
        const unbound = yield* Effect.flip(h.creator.requireBindingForThread(projectId, threadId));
        expect(unbound).toMatchObject(opError("unauthorized"));

        const hf = yield* Effect.flip(h.opener.open({ path: project, threadId, openedBy: "user" }));
        expect(hf._tag).toBe("CreatorOperationError");
        expect(h.stopped).toEqual([mp4Root, project]);
        const hfUnbound = yield* Effect.flip(
          h.creator.requireBindingForThread(
            CreatorService.creatorProjectIdFor(project, threadId),
            threadId,
          ),
        );
        expect(hfUnbound).toMatchObject(opError("unauthorized"));
        expect((yield* h.previews.list({ threadId })).sessions).toEqual([]);
      }).pipe(Effect.scoped),
  );

  it.effect("a preview that cannot start removes the review copy", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const clip = yield* h.video(NodePath.join(h.work, "clip.mp4"));
      h.setBehaviour("limit");
      const refused = yield* Effect.flip(h.opener.open({ path: clip, threadId, openedBy: "user" }));
      expect(refused).toMatchObject(opError("limit"));
      expect(yield* h.exists(h.ensured[0]!)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "refuses while the setting is off, outside the desktop app, or for an unknown thread",
    () =>
      Effect.gen(function* () {
        const off = yield* harness({ enabled: false });
        yield* off.hyperframes(NodePath.join(off.work, "promo"));
        const disabled = yield* Effect.flip(
          off.opener.open({ path: "promo", threadId, openedBy: "agent" }),
        );
        expect(disabled._tag).toBe("CreatorDisabledError");
        expect(off.ensured).toEqual([]);

        for (const options of [{ mode: "web" as const }, { available: false }]) {
          const h = yield* harness(options);
          yield* h.hyperframes(NodePath.join(h.work, "promo"));
          const refused = yield* Effect.flip(
            h.opener.open({ path: "promo", threadId, openedBy: "agent" }),
          );
          expect(refused).toMatchObject({ ...opError("unavailable"), detail: "desktop_only" });
          expect(h.ensured).toEqual([]);
        }

        const h = yield* harness();
        yield* h.hyperframes(NodePath.join(h.work, "promo"));
        const unknown = yield* Effect.flip(
          h.opener.open({ path: "promo", threadId: ThreadId.make("nope"), openedBy: "agent" }),
        );
        expect(unknown).toMatchObject(opError("not_found"));
      }).pipe(Effect.scoped),
  );
});
