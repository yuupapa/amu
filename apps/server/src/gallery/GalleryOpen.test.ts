// @effect-diagnostics nodeBuiltinImport:off - the tests write a stand-in gallery server.py and pick a free port.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_SERVER_SETTINGS, ThreadId, type ServerSettings } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as DesktopBrowserChannel from "../preview/DesktopBrowserChannel.ts";
import * as PreviewManager from "../preview/Manager.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as GalleryOpen from "./GalleryOpen.ts";

const threadId = ThreadId.make("thread-gallery-open");

/** Stands in for tools/media-gallery/server.py: answers /api/health on --port. */
const FAKE_SERVER = `
import argparse, json, os, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
p = argparse.ArgumentParser(); p.add_argument('--port', type=int); a = p.parse_args()
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({'app': 'showa-media-gallery'}).encode()
        self.send_response(200); self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *args): pass
# Like the real gallery when the system still holds the port: refuse once.
once = os.environ.get('FAKE_GALLERY_FAIL_ONCE')
if once and not os.path.exists(once):
    open(once, 'w').close()
    raise SystemExit('Port is used by another app')
# Like the real gallery: bind first, then build the catalog, then answer.
server = ThreadingHTTPServer(('127.0.0.1', a.port), H)
time.sleep(float(os.environ.get('FAKE_GALLERY_DELAY', '0')))
server.serve_forever()
`;

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = NodeNet.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address !== null ? resolve(address.port) : reject(),
      );
    });
  });

const answers = (url: string) => Effect.promise(() => GalleryOpen.probeGallery(url));

const harness = (options: { readonly enabled?: boolean } = {}) =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(async () => {
      const made = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "amu-gallery-"));
      await NodeFSP.writeFile(NodePath.join(made, "server.py"), FAKE_SERVER);
      return made;
    });
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
    );
    const url = `http://127.0.0.1:${yield* Effect.promise(freePort)}/`;
    const configContext = yield* Layer.build(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-gallery-open-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    );
    const config = Context.get(configContext, ServerConfig.ServerConfig);
    const settingsRef = yield* Ref.make<ServerSettings>({
      ...DEFAULT_SERVER_SETTINGS,
      amuGalleryEnabled: options.enabled ?? true,
    });
    const changes = yield* PubSub.unbounded<ServerSettings>();
    const serviceScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(serviceScope, Exit.void));
    const context = yield* Layer.buildWithScope(
      GalleryOpen.layerWith({
        galleryDir: dir,
        url,
        readyTimeoutMs: 10_000,
        killGraceMs: 500,
      }).pipe(
        Layer.provideMerge(PreviewManager.layer),
        Layer.provide(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: (id) => Effect.succeed(id === threadId ? liveThreadShell(id) : null),
          }),
        ),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ServerConfig.ServerConfig, { ...config, mode: "desktop" }),
            Layer.mock(ServerSettingsService)({
              getSettings: Ref.get(settingsRef),
              streamChanges: Stream.fromPubSub(changes),
              subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
            }),
            Layer.mock(DesktopBrowserChannel.DesktopBrowserChannel)({ available: true }),
            NodeServices.layer,
          ),
        ),
      ),
      serviceScope,
    );
    return {
      dir,
      url,
      opener: Context.get(context, GalleryOpen.GalleryOpen),
      previews: Context.get(context, PreviewManager.PreviewManager),
    };
  });

const waitUntil = (check: Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    for (let i = 0; i < 50; i++) {
      if (yield* check) return true;
      yield* Effect.sleep("100 millis");
    }
    return false;
  });

it.live(
  "starts the gallery, opens a Gallery tab and stops what it started when the tab closes",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { url, opener, previews } = yield* harness();
        expect(yield* answers(url)).toBe(false);
        const opened = yield* opener.open({ threadId, openedBy: "agent" });
        expect(opened.url).toBe(url);
        expect(yield* answers(url)).toBe(true);
        const tabs = yield* previews.list({ threadId });
        const tab = tabs.sessions.find((session) => session.tabId === opened.tabId);
        expect(tab?.gallery).toEqual({ label: "素材ギャラリー" });
        expect(tab?.reveal).toBe(true);

        // A reopen replaces the thread's tab and keeps the server.
        const reopened = yield* opener.open({ threadId, openedBy: "user" });
        const after = yield* previews.list({ threadId });
        expect(after.sessions.map((session) => session.tabId)).toEqual([reopened.tabId]);
        expect(after.sessions[0]?.reveal).toBeUndefined();
        expect(yield* answers(url)).toBe(true);

        yield* previews.close({ threadId, tabId: reopened.tabId });
        expect(yield* waitUntil(Effect.map(answers(url), (up) => !up))).toBe(true);
      }),
    ),
);

it.live("is refused while the setting is off", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { opener } = yield* harness({ enabled: false });
      const error = yield* Effect.flip(opener.open({ threadId, openedBy: "agent" }));
      expect(error._tag).toBe("GalleryDisabledError");
    }),
  ),
);

it.live("reports a missing gallery folder", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { dir, opener } = yield* harness();
      yield* Effect.promise(() => NodeFSP.rm(NodePath.join(dir, "server.py")));
      const error = yield* Effect.flip(opener.open({ threadId, openedBy: "agent" }));
      expect(error).toMatchObject({ _tag: "GalleryOperationError", code: "not_found" });
    }),
  ),
);

it.live("an open interrupted while the gallery starts leaves no server behind", () =>
  Effect.scoped(
    Effect.gen(function* () {
      process.env.FAKE_GALLERY_DELAY = "1.5";
      // Interrupted before the settle time, while the port is not trusted yet.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          delete process.env.FAKE_GALLERY_DELAY;
        }),
      );
      const { url, opener } = yield* harness();
      const fiber = yield* Effect.forkChild(opener.open({ threadId, openedBy: "agent" }));
      yield* Effect.sleep("700 millis");
      yield* Fiber.interrupt(fiber);
      // The stand-in would be answering by now had it been left running.
      yield* Effect.sleep("2500 millis");
      expect(yield* answers(url)).toBe(false);
    }),
  ),
);

it.live("opens the tab while a slow gallery is still building its catalog", () =>
  Effect.scoped(
    Effect.gen(function* () {
      process.env.FAKE_GALLERY_DELAY = "4";
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          delete process.env.FAKE_GALLERY_DELAY;
        }),
      );
      const { url, opener, previews } = yield* harness();
      const opened = yield* opener.open({ threadId, openedBy: "agent" });
      // Opened before the gallery answers; it answers once its catalog is built.
      expect(yield* answers(url)).toBe(false);
      expect((yield* previews.list({ threadId })).sessions.map((tab) => tab.tabId)).toEqual([
        opened.tabId,
      ]);
      expect(yield* waitUntil(answers(url))).toBe(true);
    }),
  ),
);

it.live("starts the gallery again when its first start is refused", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { dir, url, opener } = yield* harness();
      process.env.FAKE_GALLERY_FAIL_ONCE = NodePath.join(dir, "failed-once");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          delete process.env.FAKE_GALLERY_FAIL_ONCE;
        }),
      );
      yield* opener.open({ threadId, openedBy: "user" });
      expect(yield* waitUntil(answers(url))).toBe(true);
      expect(
        yield* Effect.promise(() =>
          NodeFSP.access(NodePath.join(dir, "failed-once")).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(true);
    }),
  ),
);
