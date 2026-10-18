// @effect-diagnostics nodeBuiltinImport:off - checks the gallery folder and its Python on disk and asks its /api/health, like creatorFiles.ts.
/**
 * GalleryOpen: opens Amu Gallery, the local media gallery (`tools/media-gallery`,
 * a small Python web app on 127.0.0.1:8768), in a preview tab the way Amu
 * Creator opens Studio. The MCP tool `gallery_open` calls it with
 * `openedBy: "agent"`, the WS `gallery.openByUser` with `openedBy: "user"`.
 *
 * - Local only (`isLocalCreatorHost`, setting `amuGalleryEnabled` on).
 * - The gallery server is shared. When one already answers `/api/health` (the
 *   desktop "素材ギャラリー" app, or a previous open) it is used as is and never
 *   stopped by Amu. Otherwise Amu starts `server.py` in its own process group
 *   and stops it once the last Gallery tab closes, the setting is turned off, or
 *   the server shuts down.
 * - One Gallery tab per thread: a reopen opens a fresh tab (so the newest
 *   registered media shows) and then closes the thread's previous one.
 */
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  GalleryDisabledError,
  GalleryOperationError,
  type GalleryError,
  type GalleryOpenResult,
  type GalleryOperationErrorCode,
  type PreviewTabId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../config.ts";
import { isLocalCreatorHost } from "../creator/CreatorService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as DesktopBrowserChannel from "../preview/DesktopBrowserChannel.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as ServerSettings from "../serverSettings.ts";

export const GALLERY_PORT = 8768;
export const GALLERY_URL = `http://127.0.0.1:${GALLERY_PORT}/`;
/** `APP_NAME` in the gallery's `server.py`; `/api/health` answers `{ app }`. */
const GALLERY_APP_NAME = "showa-media-gallery";
const GALLERY_LABEL = "素材ギャラリー";

/** The gallery folder: `AMU_GALLERY_DIR`, else `~/YouTube動画/tools/media-gallery`. */
export const defaultGalleryDir = () =>
  process.env.AMU_GALLERY_DIR?.trim() ||
  NodePath.join(NodeOS.homedir(), "YouTube動画", "tools", "media-gallery");

export interface GalleryOpenInput {
  readonly threadId: ThreadId;
  readonly openedBy: "agent" | "user";
}

export class GalleryOpen extends Context.Service<
  GalleryOpen,
  {
    readonly open: (input: GalleryOpenInput) => Effect.Effect<GalleryOpenResult, GalleryError>;
  }
>()("t3/gallery/GalleryOpen") {}

export interface GalleryOpenOptions {
  readonly galleryDir?: string;
  readonly url?: string;
  /** How long a started server may take to answer `/api/health`. */
  readonly readyTimeoutMs?: number;
  readonly killGraceMs?: number;
}

interface LiveTab {
  readonly threadId: ThreadId;
  readonly tabId: PreviewTabId;
}

const operationError = (code: GalleryOperationErrorCode, detail: string) =>
  new GalleryOperationError({ code, detail });

/** True when the gallery (and not some other app) answers on its port. */
export const probeGallery = (url: string): Promise<boolean> =>
  new Promise((resolve) => {
    const request = NodeHttp.get(new URL("/api/health", url), { timeout: 1_500 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => {
        try {
          const parsed = JSON.parse(body) as { readonly app?: unknown };
          resolve(response.statusCode === 200 && parsed.app === GALLERY_APP_NAME);
        } catch {
          resolve(false);
        }
      });
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(false));
  });

const galleryAnswers = (url: string) =>
  Effect.tryPromise(() => probeGallery(url)).pipe(Effect.orElseSucceed(() => false));

export const make = (options: GalleryOpenOptions = {}) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const settings = yield* ServerSettings.ServerSettingsService;
    const channel = yield* DesktopBrowserChannel.DesktopBrowserChannel;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const previews = yield* PreviewManager.PreviewManager;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serviceScope = yield* Scope.Scope;
    const galleryDir = options.galleryDir ?? defaultGalleryDir();
    const url = options.url ?? GALLERY_URL;
    const readyTimeoutMs = options.readyTimeoutMs ?? 20_000;
    const killGraceMs = options.killGraceMs ?? 3_000;

    const tabs: Array<LiveTab> = [];
    const lock = Semaphore.makeUnsafe(1);
    /** The server Amu started, while it runs. `null` when none (or one Amu did not start). */
    let owned: Scope.Closeable | null = null;

    const stopOwned = Effect.suspend(() => {
      const scope = owned;
      owned = null;
      return scope === null ? Effect.void : Scope.close(scope, Exit.void);
    }).pipe(Effect.uninterruptible);

    const startServer = Effect.gen(function* () {
      const script = NodePath.join(galleryDir, "server.py");
      if (!NodeFS.existsSync(script)) {
        return yield* Effect.fail(operationError("not_found", `gallery_missing: ${script}`));
      }
      const venvPython = NodePath.join(galleryDir, ".venv", "bin", "python");
      const python = NodeFS.existsSync(venvPython) ? venvPython : "python3";
      // From creating the scope to recording it as owned nothing may interrupt,
      // or a started child would be left without an owner to stop it.
      const { scope, child } = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          const child = yield* spawner
            .spawn(
              ChildProcess.make(
                python,
                [script, "--port", new URL(url).port || String(GALLERY_PORT)],
                {
                  cwd: galleryDir,
                  detached: true,
                  stdin: "ignore",
                  killSignal: "SIGTERM",
                  forceKillAfter: `${killGraceMs} millis`,
                },
              ),
            )
            .pipe(
              Effect.provideService(Scope.Scope, scope),
              Effect.tapError(() => Scope.close(scope, Exit.void)),
              Effect.mapError((cause) =>
                operationError("unavailable", `spawn_failed: ${cause.message}`),
              ),
            );
          // Keep both pipes drained, or the child can block on a full buffer.
          for (const output of [child.stdout, child.stderr]) {
            yield* output.pipe(Stream.runDrain, Effect.ignore, Effect.forkIn(scope));
          }
          owned = scope;
          return { scope, child };
        }),
      );
      // A server that exits on its own is no longer ours to stop.
      yield* child.exitCode.pipe(
        Effect.exit,
        Effect.flatMap(() =>
          Effect.sync(() => {
            if (owned === scope) owned = null;
          }),
        ),
        Effect.forkIn(serviceScope),
      );
      const deadline = (yield* Clock.currentTimeMillis) + readyTimeoutMs;
      while ((yield* Clock.currentTimeMillis) < deadline) {
        if (yield* galleryAnswers(url)) return;
        if (owned !== scope) break;
        yield* Effect.sleep("200 millis");
      }
      yield* stopOwned;
      return yield* Effect.fail(operationError("unavailable", "gallery_not_ready"));
    });

    const ensureServer = Effect.gen(function* () {
      if (yield* galleryAnswers(url)) return;
      yield* stopOwned;
      yield* startServer;
    });

    /** Forgets a closed tab; stops the server Amu started once no Gallery tab is left. */
    const forgetTab = (threadId: string, tabId: string) =>
      lock.withPermits(1)(
        Effect.suspend(() => {
          const index = tabs.findIndex((tab) => tab.threadId === threadId && tab.tabId === tabId);
          if (index < 0) return Effect.void;
          tabs.splice(index, 1);
          return tabs.length === 0 ? stopOwned : Effect.void;
        }),
      );

    const closeAll = lock.withPermits(1)(
      Effect.gen(function* () {
        const all = tabs.splice(0, tabs.length);
        yield* Effect.forEach(
          all,
          (tab) => previews.close({ threadId: tab.threadId, tabId: tab.tabId }).pipe(Effect.ignore),
          { discard: true },
        );
        yield* stopOwned;
      }),
    );

    const previewEvents = yield* previews.subscribeEvents;
    yield* Stream.fromSubscription(previewEvents).pipe(
      Stream.runForEach((event) =>
        event.type === "closed" ? forgetTab(event.threadId, event.tabId) : Effect.void,
      ),
      Effect.forkScoped,
    );

    const settingsChanges = yield* settings.subscribeChanges;
    yield* Stream.runForEach(settingsChanges, (current) =>
      current.amuGalleryEnabled ? Effect.void : closeAll,
    ).pipe(Effect.forkScoped);

    const requireLocal = Effect.gen(function* () {
      const current = yield* settings.getSettings.pipe(
        Effect.mapError(() => operationError("unavailable", "settings_unreadable")),
      );
      if (!current.amuGalleryEnabled) return yield* Effect.fail(new GalleryDisabledError());
      if (!isLocalCreatorHost(config, channel)) {
        return yield* Effect.fail(operationError("unavailable", "desktop_only"));
      }
    });

    const requireThread = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const shell = yield* threads
          .getThreadShell(threadId)
          .pipe(Effect.mapError(() => operationError("unavailable", "thread_unreadable")));
        if (shell === null || shell.deletedAt !== null) {
          return yield* Effect.fail(operationError("not_found", "thread"));
        }
        if (shell.archivedAt !== null) {
          return yield* Effect.fail(operationError("invalid", "thread_archived"));
        }
      });

    const open: GalleryOpen["Service"]["open"] = Effect.fn("GalleryOpen.open")(function* (input) {
      yield* requireLocal;
      yield* requireThread(input.threadId);
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          // The setting may have been turned off (and every tab closed) while this waited.
          yield* requireLocal;
          yield* ensureServer;
          const snapshot = yield* previews
            .open({
              threadId: input.threadId,
              url,
              // An agent's open asks viewers to show the tab; the user opened it where they look.
              ...(input.openedBy === "agent" ? { reveal: true } : {}),
              gallery: { label: GALLERY_LABEL },
            })
            .pipe(
              Effect.tapError((cause) =>
                Effect.logWarning("Amu Gallery could not open its tab", { cause }),
              ),
              Effect.mapError(() => operationError("unavailable", "preview_tab")),
            );
          const previous = tabs.filter((tab) => tab.threadId === input.threadId);
          tabs.push({ threadId: input.threadId, tabId: snapshot.tabId });
          // Only now that the new tab is open, close this thread's previous one.
          for (const tab of previous) {
            tabs.splice(tabs.indexOf(tab), 1);
            yield* previews.close({ threadId: tab.threadId, tabId: tab.tabId }).pipe(Effect.ignore);
          }
          return { tabId: snapshot.tabId, url } satisfies GalleryOpenResult;
        }).pipe(
          // A failed or interrupted open must not leave a server it started with no tab.
          Effect.onExit((exit) =>
            Exit.isSuccess(exit) || tabs.length > 0 ? Effect.void : stopOwned,
          ),
        ),
      );
    });

    yield* Effect.addFinalizer(() => closeAll);
    return GalleryOpen.of({ open });
  });

export const layerWith = (options: GalleryOpenOptions) => Layer.effect(GalleryOpen, make(options));

export const layer = layerWith({});
