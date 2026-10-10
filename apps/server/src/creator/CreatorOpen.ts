// @effect-diagnostics nodeBuiltinImport:off - realpath/stat of the chosen path and randomUUID open ids; the same plain async file work as creatorFiles.ts.
/**
 * CreatorOpen: the one way an Amu Creator tab is opened, and the owner of what
 * an open holds (binding, tab, preview, review copy) until it is released. The
 * MCP tool `creator_open` calls it with `openedBy: "agent"`, the WS
 * `creator.openByUser` with `openedBy: "user"`.
 *
 * - Local only (`isLocalCreatorHost`, setting on). Checked before anything
 *   touches the disk or starts a process.
 * - The caller's path is resolved to its real path once, and only that real
 *   path is used afterwards: containment, `hyperframes.json` detection, the link
 *   scan, the preview root and the review copy's source. An agent may open only
 *   what really lies inside its thread's workspace (`realPathInside`); the user
 *   may open any absolute path (the WS surface is the desktop app's own session).
 *   Races with another process of the same user after these checks are outside
 *   the threat model (see `creatorFiles.ts`).
 * - A folder with `hyperframes.json` is served as is. A `.mp4`/`.mov`/`.webm`
 *   gets a fresh review copy under `<stateDir>/creator/review/<projectId>/<openId>/`
 *   per open. Anything else is refused, and the served folder must not hold a
 *   link that leaves it (`scanForOutwardLinks`).
 * - Comments are kept per (real source path, thread) (`creatorProjectIdFor`), so
 *   one thread never sees or replaces another thread's open. Previews are
 *   shared per serving folder and reference-counted across opens.
 * - Sequence: preview -> binding -> tab (`PreviewManager.open`, whose synchronous
 *   `beforePublish` binds the tab before its `opened` event publishes) -> record
 *   -> release the thread's previous open of the same project. A failure undoes
 *   what was done, newest first, so a failed reopen leaves the working open alone.
 * - Release (tab closed, setting turned off, replaced by a reopen): revoke the
 *   binding, close the tab, stop the preview when no other open uses its folder,
 *   remove the review copy.
 * - Opens and releases of one project run one at a time.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  CreatorDisabledError,
  CreatorOperationError,
  type CreatorBindingId,
  type CreatorDestination,
  type CreatorError,
  type CreatorOpenResult,
  type CreatorOperationErrorCode,
  type CreatorProjectId,
  type PreviewTabId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as DesktopBrowserChannel from "../preview/DesktopBrowserChannel.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CreatorFileError, openCreatorRoot } from "./creatorFiles.ts";
import { realPathInside, scanForOutwardLinks } from "./creatorPaths.ts";
import * as CreatorPreviewSupervisor from "./CreatorPreviewSupervisor.ts";
import { CreatorService, creatorProjectIdFor, isLocalCreatorHost } from "./CreatorService.ts";
import {
  FfprobeError,
  makeReviewProject,
  removeReviewCopy,
  removeStaleReviewCopies,
  runFfprobe,
} from "./reviewProject.ts";

export interface CreatorOpenInput {
  /** Agent: inside the thread's workspace, relative to it or absolute. User: absolute. */
  readonly path: string;
  /** The thread the tab opens in and the comments are sent to. */
  readonly threadId: ThreadId;
  readonly openedBy: "agent" | "user";
}

export class CreatorOpen extends Context.Service<
  CreatorOpen,
  {
    readonly open: (input: CreatorOpenInput) => Effect.Effect<CreatorOpenResult, CreatorError>;
  }
>()("t3/creator/CreatorOpen") {}

export interface CreatorOpenOptions {
  /** Duration of a video file in seconds; `runFfprobe` by default. */
  readonly ffprobe?: (file: string) => Promise<number>;
  /** Test seam: runs after an open was released (tab closed, setting off, reopened). */
  readonly afterRelease?: (bindingId: CreatorBindingId) => Effect.Effect<void>;
  /** Test seam: shutdown refused new requests, before waiting for admitted opens. */
  readonly afterShutdownStarted?: Effect.Effect<void>;
}

const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set(["mp4", "mov", "webm"]);

type Source =
  | { readonly kind: "hyperframes"; readonly root: string; readonly label: string }
  | { readonly kind: "mp4"; readonly video: string; readonly label: string };

/** A tab this service opened whose binding it has not revoked yet. */
interface LiveOpen {
  readonly bindingId: CreatorBindingId;
  readonly projectId: CreatorProjectId;
  readonly threadId: ThreadId;
  readonly tabId: PreviewTabId;
  readonly servingRoot: string;
  /** The review copy (mp4 only). */
  readonly openId: string | null;
}

const operationError = (code: CreatorOperationErrorCode, detail: string) =>
  new CreatorOperationError({ code, detail });

const isOperationError = Schema.is(CreatorOperationError);

/** A file step of an open failed; reported to the caller as a `CreatorOperationError`. */
class CreatorOpenFileError extends Data.TaggedError("CreatorOpenFileError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

const tryFile = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new CreatorOpenFileError({ operation, cause }),
  });

/** Unexpected file failures are logged and reported as `unavailable`. */
const unavailableAfterLog = (error: CreatorOpenFileError) =>
  Effect.logWarning("Amu Creator open failed", {
    operation: error.operation,
    cause: error.cause,
  }).pipe(Effect.andThen(Effect.fail(operationError("unavailable", error.operation))));

const filePromise = <A>(operation: string, run: () => Promise<A>) =>
  tryFile(operation, run).pipe(Effect.catch(unavailableAfterLog));

/** Where `input.path` really is and what kind of Creator source it is. */
const locate = async (
  input: CreatorOpenInput,
  workspace: string | null,
): Promise<Source | CreatorOperationError> => {
  let real: string;
  if (input.openedBy === "agent") {
    const inside = workspace === null ? null : await realPathInside(workspace, input.path);
    if (inside === null) return operationError("unauthorized", "not_in_workspace");
    real = inside;
  } else {
    if (!NodePath.isAbsolute(input.path)) return operationError("invalid", "path_not_absolute");
    try {
      real = await NodeFSP.realpath(input.path);
    } catch {
      return operationError("not_found", "path");
    }
  }
  const stats = await NodeFSP.stat(real);
  const label = NodePath.basename(real);
  if (stats.isDirectory()) {
    const manifest = await NodeFSP.stat(NodePath.join(real, "hyperframes.json")).catch(() => null);
    return manifest?.isFile() === true
      ? { kind: "hyperframes", root: real, label }
      : operationError("invalid", "not_creator_project");
  }
  const ext = NodePath.extname(real).slice(1).toLowerCase();
  return stats.isFile() && VIDEO_EXTENSIONS.has(ext)
    ? { kind: "mp4", video: real, label }
    : operationError("invalid", "not_creator_project");
};

const reviewCopyError = (cause: unknown): CreatorOperationError | null => {
  if (cause instanceof FfprobeError) return operationError("invalid", "video_unreadable");
  if (!(cause instanceof CreatorFileError)) return null;
  switch (cause.reason) {
    case "too_large":
      return operationError("limit", "video_too_large");
    case "not_found":
      return operationError("not_found", "video");
    case "invalid_name":
      return operationError("invalid", "video_type");
    case "unsafe_path":
      return operationError("invalid", "video_changed");
    default:
      return null;
  }
};

const previewError = (
  error:
    | CreatorPreviewSupervisor.CreatorPreviewLimitError
    | CreatorPreviewSupervisor.CreatorPreviewStartError,
) =>
  error._tag === "CreatorPreviewLimitError"
    ? operationError("limit", `preview_limit: ${error.limit}`)
    : operationError("unavailable", `preview_${error.reason}`);

export const make = (options: CreatorOpenOptions = {}) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const settings = yield* ServerSettings.ServerSettingsService;
    const channel = yield* DesktopBrowserChannel.DesktopBrowserChannel;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const projects = yield* ProjectService.ProjectService;
    const creator = yield* CreatorService;
    const supervisor = yield* CreatorPreviewSupervisor.CreatorPreviewSupervisor;
    const previews = yield* PreviewManager.PreviewManager;
    const ffprobe = options.ffprobe ?? ((file: string) => runFfprobe(file));
    const afterRelease = options.afterRelease ?? (() => Effect.void);

    // Finish startup cleanup before any request can own a copy. Never follows links.
    yield* tryFile("cleanup_review_copies", () => removeStaleReviewCopies(config.stateDir)).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Amu Creator review-copy cleanup failed", { cause }),
      ),
      Effect.uninterruptible,
    );

    const opens = new Map<CreatorBindingId, LiveOpen>();
    let closing = false;
    let activeOpens = 0;
    let drained = Deferred.makeUnsafe<void>();
    const admitOpen = Effect.suspend(() => {
      if (closing) return Effect.fail(operationError("unavailable", "creator_stopped"));
      if (activeOpens++ === 0) drained = Deferred.makeUnsafe<void>();
      return Effect.void;
    });
    const finishOpen = Effect.suspend(() => {
      activeOpens -= 1;
      return activeOpens === 0
        ? Deferred.succeed(drained, undefined).pipe(Effect.asVoid)
        : Effect.void;
    });
    const lockMap = <K>() => {
      const locks = new Map<K, Semaphore.Semaphore>();
      return (key: K) => {
        let lock = locks.get(key);
        if (lock === undefined) {
          lock = Semaphore.makeUnsafe(1);
          locks.set(key, lock);
        }
        return lock;
      };
    };
    const projectLock = lockMap<CreatorProjectId>();
    const rootLock = lockMap<string>();
    /** Opens (live or starting) per serving folder; the preview stops when it reaches 0. */
    const rootUsers = new Map<string, number>();

    const dropRootUser = (root: string) =>
      Effect.suspend(() => {
        const left = (rootUsers.get(root) ?? 1) - 1;
        if (left > 0) {
          rootUsers.set(root, left);
          return Effect.void;
        }
        rootUsers.delete(root);
        return supervisor.stop(root);
      });

    /** Counts this open as a user of the folder's preview and starts it if needed. */
    const acquirePreview = (root: string) =>
      rootLock(root).withPermits(1)(
        Effect.suspend(() => {
          rootUsers.set(root, (rootUsers.get(root) ?? 0) + 1);
          return supervisor.ensure(root).pipe(
            Effect.mapError(previewError),
            Effect.onError(() => dropRootUser(root)),
          );
        }),
      );

    const releasePreview = (root: string) => rootLock(root).withPermits(1)(dropRootUser(root));

    const requireLocal = Effect.gen(function* () {
      const current = yield* settings.getSettings.pipe(
        Effect.mapError(() => operationError("unavailable", "settings_unreadable")),
      );
      if (!current.amuCreatorEnabled) return yield* Effect.fail(new CreatorDisabledError());
      if (!isLocalCreatorHost(config, channel)) {
        return yield* Effect.fail(operationError("unavailable", "desktop_only"));
      }
    });

    /** The destination of the thread and, for an agent, the workspace it may open from. */
    const threadContext = Effect.fn("CreatorOpen.threadContext")(function* (
      input: CreatorOpenInput,
    ) {
      const shell = yield* threads
        .getThreadShell(input.threadId)
        .pipe(Effect.mapError(() => operationError("unavailable", "thread_unreadable")));
      if (shell === null || shell.deletedAt !== null) {
        return yield* Effect.fail(operationError("not_found", "thread"));
      }
      if (shell.archivedAt !== null) {
        return yield* Effect.fail(operationError("invalid", "thread_archived"));
      }
      let workspace: string | null = null;
      if (input.openedBy === "agent") {
        workspace = shell.worktreePath;
        if (workspace === null) {
          const project = yield* projects
            .getById(shell.projectId)
            .pipe(Effect.mapError(() => operationError("unavailable", "project_unreadable")));
          if (Option.isNone(project)) {
            return yield* Effect.fail(operationError("not_found", "project"));
          }
          workspace = project.value.workspaceRoot;
        }
      }
      const destination: CreatorDestination = {
        environmentId: yield* environment.getEnvironmentId,
        projectId: shell.projectId,
        threadId: input.threadId,
      };
      return { destination, workspace };
    });

    const removeCopy = (projectId: CreatorProjectId, openId: string) =>
      Effect.tryPromise(async () =>
        removeReviewCopy(await openCreatorRoot(config.stateDir), projectId, openId),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Amu Creator could not remove a review copy", { cause }),
        ),
        Effect.asVoid,
      );

    const closeTab = (threadId: ThreadId, tabId: PreviewTabId) =>
      previews.close({ threadId, tabId }).pipe(Effect.ignore);

    /**
     * Releases a recorded open (call it holding the project's lock). Only the
     * first call for an open does anything, so a tab-closed event that races an
     * explicit release is harmless.
     */
    const releaseOpen = (open: LiveOpen) =>
      Effect.suspend(() => {
        if (!opens.delete(open.bindingId)) return Effect.void;
        return Effect.gen(function* () {
          yield* creator.revoke(open.bindingId);
          yield* closeTab(open.threadId, open.tabId);
          yield* releasePreview(open.servingRoot);
          if (open.openId !== null) yield* removeCopy(open.projectId, open.openId);
          yield* afterRelease(open.bindingId);
        });
      }).pipe(Effect.uninterruptible);

    const releaseLocked = (open: LiveOpen) =>
      projectLock(open.projectId).withPermits(1)(releaseOpen(open));

    // A closed tab ends its open. Subscribed now, so no close is missed.
    const previewEvents = yield* previews.subscribeEvents;
    yield* Stream.fromSubscription(previewEvents).pipe(
      Stream.runForEach((event) => {
        if (event.type !== "closed") return Effect.void;
        const open = [...opens.values()].find(
          (entry) => entry.threadId === event.threadId && entry.tabId === event.tabId,
        );
        return open === undefined ? Effect.void : releaseLocked(open);
      }),
      Effect.forkScoped,
    );

    // Turning the setting off ends every open (CreatorService drops the bindings too).
    const settingsChanges = yield* settings.subscribeChanges;
    yield* Stream.runForEach(settingsChanges, (current) =>
      current.amuCreatorEnabled
        ? Effect.void
        : Effect.forEach([...opens.values()], releaseLocked, { discard: true }),
    ).pipe(Effect.forkScoped);

    const openLocked = (
      input: CreatorOpenInput,
      destination: CreatorDestination,
      source: Source,
      projectId: CreatorProjectId,
    ) => {
      // Undo steps, run newest first when anything below fails or is interrupted.
      const undo: Array<Effect.Effect<void>> = [];
      return Effect.gen(function* () {
        let servingRoot: string;
        let openId: string | null = null;
        if (source.kind === "mp4") {
          const root = yield* filePromise("creator_root", () => openCreatorRoot(config.stateDir));
          const id = NodeCrypto.randomUUID();
          const review = yield* tryFile("review_copy", () =>
            makeReviewProject(source.video, root, { projectId, openId: id, ffprobe }),
          ).pipe(
            Effect.catch((error) => {
              const known = reviewCopyError(error.cause);
              return known !== null ? Effect.fail(known) : unavailableAfterLog(error);
            }),
            // The Promise cannot abort: wait for it and register its undo before
            // honouring interruption, otherwise the copy loses its owner.
            Effect.tap(() => Effect.sync(() => undo.push(removeCopy(projectId, id)))),
            Effect.uninterruptible,
          );
          openId = id;
          // The state folder may sit under a symlink (macOS /var); serve and key by the real path.
          servingRoot = yield* filePromise("review_copy", () =>
            NodeFSP.realpath(review.servingRoot),
          );
        } else {
          servingRoot = source.root;
        }

        const scan = yield* filePromise("link_scan", () => scanForOutwardLinks(servingRoot));
        if (!scan.ok) {
          const where = "path" in scan ? `: ${NodePath.relative(servingRoot, scan.path)}` : "";
          return yield* Effect.fail(operationError("invalid", `${scan.reason}${where}`));
        }

        const preview = yield* acquirePreview(servingRoot);
        undo.push(releasePreview(servingRoot));

        const binding = yield* creator.bind({
          projectId,
          servingRoot,
          sourceKind: source.kind,
          sourceVideo: source.kind === "mp4" ? source.video : null,
          destination,
          openedBy: input.openedBy,
          preview: { url: preview.url, pid: preview.pid },
        });
        undo.push(creator.revoke(binding.bindingId));

        let attached = false;
        const snapshot = yield* previews
          .open({
            threadId: input.threadId,
            url: preview.url,
            reveal: true,
            creator: { bindingId: binding.bindingId, label: source.label },
            beforePublish: (opened) => {
              attached = creator.attachTabNow(binding.bindingId, opened.tabId);
            },
          })
          .pipe(
            Effect.tapError((cause) =>
              Effect.logWarning("Amu Creator could not open its tab", { cause }),
            ),
            Effect.mapError(() => operationError("unavailable", "preview_tab")),
          );
        undo.push(closeTab(input.threadId, snapshot.tabId));
        // The binding was dropped between bind and the tab (a revokeAll).
        if (!attached) return yield* Effect.fail(operationError("unauthorized", "binding_revoked"));

        const recorded: LiveOpen = {
          bindingId: binding.bindingId,
          projectId,
          threadId: input.threadId,
          tabId: snapshot.tabId,
          servingRoot,
          openId,
        };
        opens.set(recorded.bindingId, recorded);
        // From here on, releasing the recorded open undoes all of the above.
        undo.splice(0, undo.length, releaseOpen(recorded));
        // A close or a setting flip that landed before the open was recorded
        // found nothing to release; catch it now.
        yield* creator.requireBinding(binding.bindingId);
        const tabs = yield* previews.list({ threadId: input.threadId });
        if (!tabs.sessions.some((tab) => tab.tabId === snapshot.tabId)) {
          return yield* Effect.fail(operationError("conflict", "tab_closed"));
        }

        // Only now that the new open works, release this thread's previous one.
        yield* Effect.forEach(
          [...opens.values()].filter(
            (open) => open.projectId === projectId && open.bindingId !== recorded.bindingId,
          ),
          releaseOpen,
          { discard: true },
        );
        return {
          bindingId: binding.bindingId,
          projectId,
          epoch: binding.epoch,
          tabId: snapshot.tabId,
        } satisfies CreatorOpenResult;
      }).pipe(
        Effect.onError(() =>
          Effect.suspend(() =>
            Effect.forEach(undo.toReversed(), (step) => step, { discard: true }),
          ),
        ),
      );
    };

    const openOperation = Effect.fn("CreatorOpen.open")(function* (input: CreatorOpenInput) {
      yield* requireLocal;
      const { destination, workspace } = yield* threadContext(input);
      const located = yield* filePromise("locate", () => locate(input, workspace));
      if (isOperationError(located)) return yield* Effect.fail(located);
      const projectId = creatorProjectIdFor(
        located.kind === "mp4" ? located.video : located.root,
        input.threadId,
      );
      return yield* projectLock(projectId).withPermits(1)(
        openLocked(input, destination, located, projectId),
      );
    });

    // Registered after subscriptions: release resources while dependencies are
    // still live. An admitted request must finish (including its undo) first.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        closing = true;
        if (options.afterShutdownStarted) yield* options.afterShutdownStarted;
        if (activeOpens > 0) yield* Deferred.await(drained);
        yield* Effect.forEach([...opens.values()], releaseLocked, { discard: true });
      }),
    );
    const open: CreatorOpen["Service"]["open"] = (input) =>
      Effect.acquireUseRelease(
        admitOpen,
        () => openOperation(input),
        () => finishOpen,
      );
    return CreatorOpen.of({ open });
  });

export const layerWith = (options: CreatorOpenOptions) => Layer.effect(CreatorOpen, make(options));

export const layer = layerWith({});
