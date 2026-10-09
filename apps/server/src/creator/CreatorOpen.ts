// @effect-diagnostics nodeBuiltinImport:off - realpath/stat of the chosen path and randomUUID open ids; the same plain async file work as creatorFiles.ts.
/**
 * CreatorOpen: the one way an Amu Creator tab is opened. The MCP tool
 * `creator_open` calls it with `openedBy: "agent"`, the WS `creator.openByUser`
 * with `openedBy: "user"`.
 *
 * - Local only: the setting is on, the server is the desktop app's
 *   (`mode === "desktop"`) and its browser channel is available. Checked before
 *   anything touches the disk or starts a process.
 * - An agent may open only what really lies inside its thread's workspace
 *   (`realPathInside`). The user may open any absolute path: the WS caller is
 *   Amu's own UI, and the path comes from the desktop folder or file picker.
 * - A folder with `hyperframes.json` is served as is; its project id comes from
 *   its real path. A `.mp4`/`.mov`/`.webm` gets a fresh review copy under
 *   `<stateDir>/creator/review/<projectId>/<openId>/` per open, with the project
 *   id of the source video's real path, so reopening the same video shows the
 *   same comments. Anything else is refused. The served folder must not hold a
 *   link that leaves it (`scanForOutwardLinks`).
 * - Sequence: preview (`CreatorPreviewSupervisor.ensure`) -> binding -> tab
 *   (`PreviewManager.open`, whose synchronous `beforePublish` binds the tab
 *   before its `opened` event publishes). A failure on the way undoes what was
 *   done, newest first: close the tab, revoke the binding, stop a preview this
 *   open started, remove the review copy.
 * - At most one review copy per project and one live binding per project and
 *   thread: reopening an mp4 first revokes, stops and removes the previous
 *   open; reopening a HyperFrames folder in the same thread revokes the
 *   previous binding (the preview is shared by folder and keeps running).
 * - Opens of one project run one at a time.
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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as DesktopBrowserChannel from "../preview/DesktopBrowserChannel.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CreatorFileError, openCreatorRoot, type CreatorRoot } from "./creatorFiles.ts";
import { realPathInside, scanForOutwardLinks } from "./creatorPaths.ts";
import * as CreatorPreviewSupervisor from "./CreatorPreviewSupervisor.ts";
import { CreatorService, creatorProjectIdOf } from "./CreatorService.ts";
import { FfprobeError, makeReviewProject, removeReviewCopy, runFfprobe } from "./reviewProject.ts";

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

    const opens = new Map<CreatorBindingId, LiveOpen>();
    const locks = new Map<CreatorProjectId, Semaphore.Semaphore>();
    const lockOf = (projectId: CreatorProjectId) => {
      let lock = locks.get(projectId);
      if (lock === undefined) {
        lock = Semaphore.makeUnsafe(1);
        locks.set(projectId, lock);
      }
      return lock;
    };

    const requireLocal = Effect.gen(function* () {
      const current = yield* settings.getSettings.pipe(
        Effect.mapError(() => operationError("unavailable", "settings_unreadable")),
      );
      if (!current.amuCreatorEnabled) return yield* Effect.fail(new CreatorDisabledError());
      if (config.mode !== "desktop" || !channel.available) {
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

    const removeCopy = (root: CreatorRoot, projectId: CreatorProjectId, openId: string) =>
      Effect.tryPromise(() => removeReviewCopy(root, projectId, openId)).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Amu Creator could not remove a review copy", { cause }),
        ),
        Effect.asVoid,
      );

    const closeTab = (open: Pick<LiveOpen, "threadId" | "tabId">) =>
      previews.close({ threadId: open.threadId, tabId: open.tabId }).pipe(Effect.ignore);

    /**
     * Revokes the matching opens and closes their tabs. A review copy's preview
     * is its own, so it is stopped and the copy removed; a HyperFrames preview
     * is shared by folder and keeps running.
     */
    const closeOpens = (root: CreatorRoot, matches: (open: LiveOpen) => boolean) =>
      Effect.forEach(
        [...opens.values()].filter(matches),
        (open) =>
          Effect.gen(function* () {
            opens.delete(open.bindingId);
            yield* creator.revoke(open.bindingId);
            yield* closeTab(open);
            if (open.openId !== null) {
              yield* supervisor.stop(open.servingRoot);
              yield* removeCopy(root, open.projectId, open.openId);
            }
          }),
        { discard: true },
      );

    const openLocked = (
      input: CreatorOpenInput,
      destination: CreatorDestination,
      source: Source,
      projectId: CreatorProjectId,
    ) => {
      // Undo steps, run newest first when anything below fails or is interrupted.
      const undo: Array<Effect.Effect<void>> = [];
      return Effect.gen(function* () {
        const root = yield* filePromise("creator_root", () => openCreatorRoot(config.stateDir));
        if (source.kind === "mp4") {
          yield* closeOpens(root, (open) => open.projectId === projectId && open.openId !== null);
        }

        let servingRoot: string;
        let openId: string | null = null;
        if (source.kind === "mp4") {
          const id = NodeCrypto.randomUUID();
          const review = yield* tryFile("review_copy", () =>
            makeReviewProject(source.video, root, { projectId, openId: id, ffprobe }),
          ).pipe(
            Effect.catch((error) => {
              const known = reviewCopyError(error.cause);
              return known !== null ? Effect.fail(known) : unavailableAfterLog(error);
            }),
          );
          openId = id;
          undo.push(removeCopy(root, projectId, id));
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

        // A HyperFrames preview is shared by folder; stop it on failure only if
        // no other open of this service serves the same folder.
        const shared = [...opens.values()].some((open) => open.servingRoot === servingRoot);
        if (!shared) undo.push(supervisor.stop(servingRoot));
        const preview = yield* supervisor.ensure(servingRoot).pipe(Effect.mapError(previewError));

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
        undo.push(closeTab({ threadId: input.threadId, tabId: snapshot.tabId }));
        // The binding was dropped between bind and the tab (a revokeAll).
        if (!attached) return yield* Effect.fail(operationError("unauthorized", "binding_revoked"));

        yield* closeOpens(
          root,
          (open) => open.projectId === projectId && open.threadId === input.threadId,
        );
        opens.set(binding.bindingId, {
          bindingId: binding.bindingId,
          projectId,
          threadId: input.threadId,
          tabId: snapshot.tabId,
          servingRoot,
          openId,
        });
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

    const open: CreatorOpen["Service"]["open"] = Effect.fn("CreatorOpen.open")(function* (input) {
      yield* requireLocal;
      const { destination, workspace } = yield* threadContext(input);
      const located = yield* filePromise("locate", () => locate(input, workspace));
      if (isOperationError(located)) return yield* Effect.fail(located);
      const projectId = creatorProjectIdOf(located.kind === "mp4" ? located.video : located.root);
      return yield* lockOf(projectId).withPermits(1)(
        openLocked(input, destination, located, projectId),
      );
    });

    return CreatorOpen.of({ open });
  });

export const layerWith = (options: CreatorOpenOptions) => Layer.effect(CreatorOpen, make(options));

export const layer = layerWith({});
