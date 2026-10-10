// @effect-diagnostics nodeBuiltinImport:off - comment ids for the seeded store.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type CreatorComment,
  type CreatorCommentId,
  type CreatorProjectId,
  type ServerSettings,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerConfig from "../config.ts";
import * as CreatorOpen from "../creator/CreatorOpen.ts";
import * as CreatorService from "../creator/CreatorService.ts";
import * as DesktopBrowserChannel from "../preview/DesktopBrowserChannel.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";

const environmentId = EnvironmentId.make("environment-creator-test");
const threadA = ThreadId.make("thread-creator-a");
const threadB = ThreadId.make("thread-creator-b");

const invocation = (
  threadId: ThreadId,
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: `provider-session-${threadId}`,
  thread: {
    threadId,
    providerSessionId: `provider-session-${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const sentComment = (id: CreatorCommentId): CreatorComment => ({
  id,
  number: 1,
  timeSec: 3.5,
  place: null,
  comment: "make the title gold",
  revision: 1,
  status: "sent",
  shot: null,
  projectRevision: "rev-1",
  createdAt: "2026-10-09T00:00:00.000Z",
  sentAt: "2026-10-09T00:01:00.000Z",
  sentMessageId: null,
  sentVersion: null,
  resolvedNote: null,
  shotStale: false,
});

interface Options {
  readonly enabled?: boolean;
  readonly mode?: "web" | "desktop";
}

/**
 * The creator toolkit over a real CreatorService. `CreatorOpen` is a stand-in
 * that records its input and binds through the real service, so the binding
 * rules (setting, desktop, thread) are the real ones.
 */
const layerFor = (options: Options, opened: Array<CreatorOpen.CreatorOpenInput>) => {
  const settingsLayer = Layer.effect(
    ServerSettingsService,
    Effect.gen(function* () {
      const settings = yield* Ref.make<ServerSettings>({
        ...DEFAULT_SERVER_SETTINGS,
        amuCreatorEnabled: options.enabled ?? true,
      });
      const changes = yield* PubSub.unbounded<ServerSettings>();
      return ServerSettingsService.of({
        getSettings: Ref.get(settings),
        streamChanges: Stream.fromPubSub(changes),
        subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
      } as unknown as ServerSettingsService["Service"]);
    }),
  );
  const configLayer = Layer.effect(
    ServerConfig.ServerConfig,
    ServerConfig.ServerConfig.pipe(
      Effect.map((config) => ({ ...config, mode: options.mode ?? "desktop" })),
    ),
  ).pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-creator-toolkit-" })),
  );
  const creatorLayer = CreatorService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        configLayer,
        settingsLayer,
        Layer.mock(DesktopBrowserChannel.DesktopBrowserChannel)({ available: true }),
      ),
    ),
  );
  const openLayer = Layer.effect(
    CreatorOpen.CreatorOpen,
    Effect.gen(function* () {
      const creator = yield* CreatorService.CreatorService;
      return CreatorOpen.CreatorOpen.of({
        open: (input) =>
          Effect.gen(function* () {
            opened.push(input);
            const projectId = CreatorService.creatorProjectIdOf(`/work/${input.path}`);
            const binding = yield* creator.bind({
              projectId,
              servingRoot: `/work/${input.path}`,
              sourceKind: "hyperframes",
              sourceVideo: null,
              destination: {
                environmentId,
                projectId: ProjectId.make("project:mcp-test"),
                threadId: input.threadId,
              },
              openedBy: input.openedBy,
              preview: { url: "http://127.0.0.1:5173/", pid: null },
            });
            return {
              bindingId: binding.bindingId,
              projectId,
              epoch: binding.epoch,
              tabId: `tab-${opened.length}`,
            };
          }),
      });
    }),
  );
  return McpHttpServer.layerCreatorToolkit.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
    Layer.provideMerge(openLayer),
    Layer.provideMerge(creatorLayer),
    Layer.provide(NodeServices.layer),
  );
};

const call = (
  threadId: ThreadId,
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
  name: string,
  args: Record<string, unknown>,
) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    Effect.provideService(
      McpInvocationContext.McpInvocationContext,
      invocation(threadId, capabilities),
    ),
    Effect.provideService(McpSchema.McpServerClient, client),
  );

const errorText = (result: { readonly content: ReadonlyArray<unknown> }) =>
  JSON.stringify(result.content);

it.effect("registers the Creator tools and opens as the calling thread's agent", () => {
  const opened: Array<CreatorOpen.CreatorOpenInput> = [];
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    expect(server.tools.map(({ tool }) => tool.name).toSorted()).toEqual([
      "creator_comments",
      "creator_open",
      "creator_resolve",
    ]);
    const result = yield* call(threadA, ["creator"], "creator_open", { path: "promo" });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      projectId: CreatorService.creatorProjectIdOf("/work/promo"),
      tabId: "tab-1",
    });
    expect(opened).toEqual([{ path: "promo", threadId: threadA, openedBy: "agent" }]);
  }).pipe(Effect.scoped, Effect.provide(layerFor({}, opened)));
});

it.effect("refuses every Creator tool without the creator capability", () => {
  const opened: Array<CreatorOpen.CreatorOpenInput> = [];
  return Effect.gen(function* () {
    const projectId = CreatorService.creatorProjectIdOf("/work/promo");
    for (const [name, args] of [
      ["creator_open", { path: "promo" }],
      ["creator_comments", { projectId }],
      ["creator_resolve", { projectId, ids: [NodeCrypto.randomUUID()], note: "done" }],
    ] as const) {
      const result = yield* call(threadA, ["preview", "orchestration"], name, args);
      expect(result.isError, name).toBe(true);
      expect(errorText(result)).toContain("creator");
    }
    expect(opened).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(layerFor({}, opened)));
});

it.effect("refuses while the setting is off and outside the desktop app", () =>
  Effect.gen(function* () {
    for (const options of [{ enabled: false }, { mode: "web" as const }]) {
      const opened: Array<CreatorOpen.CreatorOpenInput> = [];
      yield* Effect.gen(function* () {
        const open = yield* call(threadA, ["creator"], "creator_open", { path: "promo" });
        expect(open.isError).toBe(true);
        const comments = yield* call(threadA, ["creator"], "creator_comments", {
          projectId: CreatorService.creatorProjectIdOf("/work/promo"),
        });
        expect(comments.isError).toBe(true);
        expect(errorText(comments)).toMatch(
          options.enabled === false ? /turned off/ : /desktop_only/,
        );
      }).pipe(Effect.scoped, Effect.provide(layerFor(options, opened)));
    }
  }),
);

it.effect("only the thread a project was opened for reads and resolves its comments", () => {
  const opened: Array<CreatorOpen.CreatorOpenInput> = [];
  return Effect.gen(function* () {
    const creator = yield* CreatorService.CreatorService;
    const open = yield* call(threadA, ["creator"], "creator_open", { path: "promo" });
    const { projectId } = open.structuredContent as { projectId: CreatorProjectId };
    const id = NodeCrypto.randomUUID() as CreatorCommentId;
    yield* creator.withProjectState(projectId, (state) =>
      Effect.succeed({
        next: { ...state, nextNumber: 2, comments: [sentComment(id)] },
        value: null,
      }),
    );

    const foreignRead = yield* call(threadB, ["creator"], "creator_comments", { projectId });
    expect(foreignRead.isError).toBe(true);
    expect(errorText(foreignRead)).toContain("no_binding_for_thread");
    const foreignResolve = yield* call(threadB, ["creator"], "creator_resolve", {
      projectId,
      ids: [id],
      note: "not mine",
    });
    expect(foreignResolve.isError).toBe(true);

    const pending = yield* call(threadA, ["creator"], "creator_comments", {
      projectId,
      status: "sent",
    });
    expect(pending.isError).toBe(false);
    expect(pending.structuredContent).toEqual({
      projectId,
      comments: [
        {
          id,
          number: 1,
          status: "sent",
          timeSec: 3.5,
          comment: "make the title gold",
          place: null,
          hasShot: false,
          sentAt: "2026-10-09T00:01:00.000Z",
          resolvedNote: null,
        },
      ],
    });

    const resolved = yield* call(threadA, ["creator"], "creator_resolve", {
      projectId,
      ids: [id],
      note: "Title is gold now",
    });
    expect(resolved.isError).toBe(false);
    expect(resolved.structuredContent).toEqual({ resolved: [id] });

    const after = yield* call(threadA, ["creator"], "creator_comments", { projectId });
    expect(after.structuredContent).toMatchObject({
      comments: [{ id, status: "resolved", resolvedNote: "Title is gold now" }],
    });
    const stillSent = yield* call(threadA, ["creator"], "creator_comments", {
      projectId,
      status: "sent",
    });
    expect(stillSent.structuredContent).toEqual({ projectId, comments: [] });
  }).pipe(Effect.scoped, Effect.provide(layerFor({}, opened)));
});
