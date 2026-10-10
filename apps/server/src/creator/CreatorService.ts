// @effect-diagnostics nodeBuiltinImport:off - sha256 of a source path and randomUUID ids; both synchronous.
/**
 * CreatorService: the only writer of Amu Creator state.
 *
 * It keeps bindings in memory (a binding is the authority one `open` grants;
 * a restart drops them all), and per project it serializes every change as
 * read -> pure transition (`creatorState.ts`) -> size check -> atomic write
 * (`creatorFiles.ts`) -> publish. Bindings follow the desktop main's epochs:
 * `setEpoch` accepts only a newer epoch, and every other binding operation must
 * carry the current epoch while the binding has a live generation.
 *
 * While `amuCreatorEnabled` is off every operation fails with
 * `CreatorDisabledError` and all bindings are dropped. `withProjectState` is the
 * exception: it is the sender's (Task 6) way in and does not check the setting,
 * because reconciling sends must still run while Creator is off.
 */
import * as NodeCrypto from "node:crypto";

import {
  CREATOR_LIMITS,
  CreatorDisabledError,
  CreatorOperationError,
  type CreatorBindingId,
  type CreatorCancelProposalInput,
  type CreatorComment,
  type CreatorCommentId,
  type CreatorConfirmByUserInput,
  type CreatorDeleteCommentInput,
  type CreatorDestination,
  type CreatorEpoch,
  type CreatorError,
  type CreatorOperationErrorCode,
  type CreatorProjectId,
  type CreatorProposal,
  type CreatorProposalId,
  type CreatorProposeInput,
  type CreatorReadShotInput,
  type CreatorReadShotResult,
  type CreatorSaveDraftInput,
  type CreatorSetEpochInput,
  type CreatorSetPlaceInput,
  type CreatorShotRef,
  type CreatorSnapshot,
  type CreatorStoreFile,
  type CreatorUpdateCommentInput,
  type CreatorAttachShotInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as DesktopBrowserChannel from "../preview/DesktopBrowserChannel.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  CreatorFileError,
  listShotFiles,
  openCreatorRoot,
  openProjectStore,
  parseShotFileName,
  readShot as readShotFile,
  readStore,
  removeShot,
  writeShot,
  writeStoreAtomic,
  type CreatorRoot,
  type ProjectStore,
  type ShotName,
} from "./creatorFiles.ts";
import {
  attachShot as attachShotState,
  byteSizeOfStore,
  cancelProposal as cancelProposalState,
  confirmByUser as confirmByUserState,
  createDraft,
  deleteComment as deleteCommentState,
  propose as proposeState,
  replaceDraft,
  resolve as resolveState,
  setPlace as setPlaceState,
  updateComment as updateCommentState,
  type CreatorStateContext,
  type CreatorStateFailure,
  type StateResult,
} from "./creatorState.ts";
import { makeRateGate } from "./rateGate.ts";

/** A store or shot file operation failed. Surfaced to callers as `CreatorOperationError`. */
class CreatorStoreError extends Schema.TaggedError<CreatorStoreError>()("CreatorStoreError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Amu Creator store operation failed: ${this.operation}`;
  }
}

export type CreatorSourceKind = "hyperframes" | "mp4";

export interface CreatorBinding {
  readonly bindingId: CreatorBindingId;
  /** Newest epoch the desktop main reported for the tab. */
  readonly epoch: CreatorEpoch;
  /** Document generation; `null` until activated and after a revoke. */
  readonly generation: number | null;
  readonly projectId: CreatorProjectId;
  readonly servingRoot: string;
  readonly sourceKind: CreatorSourceKind;
  readonly sourceVideo: string | null;
  readonly destination: CreatorDestination;
  readonly openedBy: "agent" | "user";
  readonly preview: { readonly url: string; readonly pid: number | null };
  readonly tabId: string | null;
}

export type CreatorBindInput = Omit<CreatorBinding, "bindingId" | "epoch" | "generation" | "tabId">;

/** What an operation names to act through a binding. */
export interface CreatorBindingRef {
  readonly bindingId: CreatorBindingId;
  readonly epoch: number;
}

/** Result of a `withProjectState` step: `next` is written (and published) unless null. */
export interface CreatorProjectStep<A> {
  readonly next: CreatorStoreFile | null;
  readonly value: A;
}

/** Creator project id of a real (symlink-resolved) source path. */
export const creatorProjectIdOf = (realPath: string): CreatorProjectId =>
  NodeCrypto.createHash("sha256").update(realPath).digest("hex").slice(0, 32) as CreatorProjectId;

/**
 * The Creator project of a source opened for a thread. Comments are kept per
 * (real source path, thread), so another thread that opens the same folder or
 * video starts its own comment store and cannot read or resolve these.
 */
export const creatorProjectIdFor = (realSourcePath: string, threadId: ThreadId): CreatorProjectId =>
  creatorProjectIdOf(`${realSourcePath}\0${threadId}`);

/**
 * Stage 1 is local only: the server runs inside the desktop app and its
 * browser channel is up. Every Creator entry point checks this.
 */
export const isLocalCreatorHost = (
  config: { readonly mode: ServerConfig.ServerConfig["Service"]["mode"] },
  channel: { readonly available: boolean },
): boolean => config.mode === "desktop" && channel.available;

export class CreatorService extends Context.Service<
  CreatorService,
  {
    /** Grants a binding (epoch 0, no generation) for a desktop Creator tab. */
    readonly bind: (input: CreatorBindInput) => Effect.Effect<CreatorBinding, CreatorError>;
    /** One tab per binding; the same tab again is fine, a different one is refused. */
    readonly attachTab: (
      bindingId: CreatorBindingId,
      tabId: string,
    ) => Effect.Effect<CreatorBinding, CreatorError>;
    /**
     * The same rule as `attachTab`, synchronously and without reading the
     * setting, for `PreviewManager.open`'s `beforePublish` hook: the tab is
     * bound before its `opened` event reaches any subscriber. `false` when the
     * binding is gone or already holds another tab.
     */
    readonly attachTabNow: (bindingId: CreatorBindingId, tabId: string) => boolean;
    readonly revoke: (bindingId: CreatorBindingId) => Effect.Effect<void>;
    readonly revokeAll: Effect.Effect<void>;
    /** The live binding, regardless of epoch. */
    readonly requireBinding: (
      bindingId: CreatorBindingId,
    ) => Effect.Effect<CreatorBinding, CreatorError>;
    /**
     * For MCP: the newest live binding of `projectId` whose destination is
     * `threadId`. Like every binding check it needs the setting on and the
     * desktop app.
     */
    readonly requireBindingForThread: (
      projectId: CreatorProjectId,
      threadId: ThreadId,
    ) => Effect.Effect<CreatorBinding, CreatorError>;
    /** Accepts only an epoch newer than the stored one; otherwise returns the binding unchanged. */
    readonly setEpoch: (input: CreatorSetEpochInput) => Effect.Effect<CreatorBinding, CreatorError>;
    readonly saveDraft: (
      input: CreatorSaveDraftInput,
    ) => Effect.Effect<CreatorComment, CreatorError>;
    readonly updateComment: (
      input: CreatorUpdateCommentInput,
    ) => Effect.Effect<CreatorComment, CreatorError>;
    readonly setPlace: (input: CreatorSetPlaceInput) => Effect.Effect<CreatorComment, CreatorError>;
    readonly attachShot: (
      input: CreatorAttachShotInput,
    ) => Effect.Effect<CreatorComment, CreatorError>;
    readonly deleteComment: (input: CreatorDeleteCommentInput) => Effect.Effect<void, CreatorError>;
    /** The destination and binding id come from the binding, never from the caller. */
    readonly propose: (input: CreatorProposeInput) => Effect.Effect<CreatorProposal, CreatorError>;
    readonly cancelProposal: (
      input: CreatorCancelProposalInput,
    ) => Effect.Effect<void, CreatorError>;
    readonly confirmByUser: (
      input: CreatorConfirmByUserInput,
    ) => Effect.Effect<CreatorComment, CreatorError>;
    /** For MCP (after `requireBindingForThread`): `sent` comments become `resolved`. */
    readonly resolve: (
      projectId: CreatorProjectId,
      ids: ReadonlyArray<CreatorCommentId>,
      note: string,
    ) => Effect.Effect<void, CreatorError>;
    /** Only shots that a comment, a live proposal or a sent version of this project references. */
    readonly readShot: (
      input: CreatorReadShotInput,
    ) => Effect.Effect<CreatorReadShotResult, CreatorError>;
    /**
     * For the sender: the bytes of a shot one of the proposal's items pins
     * (sha256-checked). Does not check the setting or a binding.
     */
    readonly readProposalShot: (
      projectId: CreatorProjectId,
      proposalId: CreatorProposalId,
      ref: CreatorShotRef,
    ) => Effect.Effect<Uint8Array, CreatorError>;
    readonly list: (input: CreatorBindingRef) => Effect.Effect<CreatorSnapshot, CreatorError>;
    /** The current snapshot, then one per change. Fails when the binding is revoked. */
    readonly changes: (input: CreatorBindingRef) => Stream.Stream<CreatorSnapshot, CreatorError>;
    /**
     * Runs `f` under the project's lock with the current state. A non-null `next`
     * is size-checked, written and published. Does not check the setting.
     * `f` runs uninterruptibly while holding the lock: keep it to state work, never a send.
     */
    readonly withProjectState: <A, E, R>(
      projectId: CreatorProjectId,
      f: (
        state: CreatorStoreFile,
        ctx: CreatorStateContext,
      ) => Effect.Effect<CreatorProjectStep<A>, E, R>,
    ) => Effect.Effect<A, E | CreatorError, R>;
  }
>()("t3/creator/CreatorService") {}

type CreatorEvent =
  | {
      readonly _tag: "state";
      readonly projectId: CreatorProjectId;
      readonly state: CreatorStoreFile;
    }
  | { readonly _tag: "revoked" };

interface LoadedProject {
  readonly store: ProjectStore;
  readonly state: CreatorStoreFile;
}

interface ProjectEntry {
  readonly lock: Semaphore.Semaphore;
  loaded: LoadedProject | null;
}

const STATE_CODES: Record<CreatorStateFailure, CreatorOperationErrorCode> = {
  not_found: "not_found",
  invalid: "invalid",
  duplicate: "invalid",
  limit: "limit",
  rate_limited: "limit",
  reserved: "conflict",
  sending: "conflict",
  stale_shot: "stale_revision",
  stale_proposal: "stale_revision",
  already_sending: "conflict",
  not_sending: "conflict",
  not_halted: "conflict",
  not_conflict: "conflict",
  not_sent: "conflict",
  not_resolved: "conflict",
};

const operationError = (code: CreatorOperationErrorCode, detail: string) =>
  new CreatorOperationError({ code, detail });

const stateError = (reason: CreatorStateFailure) => operationError(STATE_CODES[reason], reason);

/** The wire error for a refused state transition, as every Creator operation reports it. */
export const creatorStateError = stateError;

const fileErrorCode = (cause: unknown): CreatorOperationErrorCode => {
  if (!(cause instanceof CreatorFileError)) return "unavailable";
  switch (cause.reason) {
    case "too_large":
    case "over_budget":
      return "limit";
    case "not_found":
      return "not_found";
    case "hash_mismatch":
    case "exists":
      return "conflict";
    case "invalid_name":
      return "invalid";
    default:
      return "unavailable";
  }
};

const fileReason = (cause: unknown) =>
  cause instanceof CreatorFileError ? cause.reason : "io_error";

const fileOp = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new CreatorStoreError({ operation, cause }) });

const isStoreError = Schema.is(CreatorStoreError);
const isOperationError = Schema.is(CreatorOperationError);

/** Maps store failures to the wire error; unexpected ones are logged with their cause. */
const surface = <A, E, R>(
  effect: Effect.Effect<A, E | CreatorStoreError, R>,
): Effect.Effect<A, Exclude<E, CreatorStoreError> | CreatorOperationError, R> =>
  effect.pipe(
    Effect.catchIf(isStoreError, (error) => {
      const code = fileErrorCode(error.cause);
      const failure = Effect.fail(
        operationError(code, `${error.operation}: ${fileReason(error.cause)}`),
      );
      return code === "unavailable"
        ? Effect.logWarning("Amu Creator store operation failed", {
            operation: error.operation,
            cause: error.cause,
          }).pipe(Effect.andThen(failure))
        : failure;
    }),
  ) as Effect.Effect<A, Exclude<E, CreatorStoreError> | CreatorOperationError, R>;

const shotKey = (ref: ShotName) => `${ref.commentId}:${ref.revision}`;

/** Every shot the state still points at: comments, sent versions and live proposal items. */
const referencedShots = (state: CreatorStoreFile): Map<string, CreatorShotRef> => {
  const refs = new Map<string, CreatorShotRef>();
  const add = (ref: CreatorShotRef | null | undefined) => {
    if (ref) refs.set(shotKey(ref), ref);
  };
  for (const comment of state.comments) {
    add(comment.shot);
    add(comment.sentVersion?.shot);
  }
  for (const proposal of state.proposals) {
    for (const item of proposal.items) add(item.shot);
  }
  return refs;
};

/** Shots of confirmed comments, oldest comment first, never one a live proposal pins. */
const evictableShots = (state: CreatorStoreFile, except: CreatorCommentId): ShotName[] => {
  const pinned = new Set(
    state.proposals.flatMap((proposal) =>
      proposal.items.flatMap((item) => (item.shot ? [shotKey(item.shot)] : [])),
    ),
  );
  const seen = new Set<string>();
  const result: ShotName[] = [];
  const confirmed = state.comments
    .filter((comment) => comment.status === "confirmed" && comment.id !== except)
    .toSorted((a, b) => a.number - b.number);
  for (const comment of confirmed) {
    for (const ref of [comment.shot, comment.sentVersion?.shot]) {
      if (!ref) continue;
      const key = shotKey(ref);
      if (seen.has(key) || pinned.has(key)) continue;
      seen.add(key);
      result.push({ commentId: ref.commentId, revision: ref.revision });
    }
  }
  return result;
};

/** Drops refs to evicted shot files from comments and sent versions. */
const clearShotRefs = (
  state: CreatorStoreFile,
  evicted: ReadonlyArray<ShotName>,
): CreatorStoreFile => {
  if (evicted.length === 0) return state;
  const gone = new Set(evicted.map(shotKey));
  const keep = (ref: CreatorShotRef | null) => (ref && gone.has(shotKey(ref)) ? null : ref);
  return {
    ...state,
    revision: state.revision + 1,
    comments: state.comments.map((comment) => ({
      ...comment,
      shot: keep(comment.shot),
      sentVersion:
        comment.sentVersion === null
          ? null
          : { ...comment.sentVersion, shot: keep(comment.sentVersion.shot) },
    })),
  };
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR = [0x49, 0x48, 0x44, 0x52];

/** Checks the PNG signature and IHDR size only; the bytes are stored, never decoded. */
const pngSize = (
  bytes: Uint8Array,
): { readonly width: number; readonly height: number } | CreatorOperationError => {
  if (bytes.byteLength > CREATOR_LIMITS.maxShotBytes) return operationError("limit", "shot_bytes");
  const header =
    bytes.byteLength >= 24 &&
    PNG_SIGNATURE.every((byte, index) => bytes[index] === byte) &&
    IHDR.every((byte, index) => bytes[12 + index] === byte);
  if (!header) return operationError("invalid", "not_png");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const edge = CREATOR_LIMITS.maxShotEdge;
  if (width < 1 || height < 1 || width > edge || height > edge) {
    return operationError("invalid", "shot_size");
  }
  return { width, height };
};

const snapshotOf = (projectId: CreatorProjectId, state: CreatorStoreFile): CreatorSnapshot => ({
  projectId,
  revision: state.revision,
  comments: state.comments,
  proposals: state.proposals,
});

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const channel = yield* DesktopBrowserChannel.DesktopBrowserChannel;
  const events = yield* PubSub.unbounded<CreatorEvent>();
  const bindings = new Map<string, CreatorBinding>();
  const projects = new Map<string, ProjectEntry>();
  // One gate keyed by project id: the limits survive closing and reopening a tab.
  const gate = makeRateGate();
  let root: Promise<CreatorRoot> | null = null;

  const creatorRoot = () => {
    root ??= openCreatorRoot(config.stateDir).catch((error: unknown) => {
      root = null;
      throw error;
    });
    return root;
  };

  const revokeWhere = (drop: (binding: CreatorBinding) => boolean) =>
    Effect.suspend(() => {
      let dropped = false;
      for (const [id, binding] of bindings) {
        if (drop(binding)) {
          bindings.delete(id);
          dropped = true;
        }
      }
      return dropped
        ? PubSub.publish(events, { _tag: "revoked" }).pipe(Effect.asVoid)
        : Effect.void;
    });

  const revokeAll = revokeWhere(() => true);
  const revoke = (bindingId: CreatorBindingId) =>
    revokeWhere((binding) => binding.bindingId === bindingId);

  // Read on every call so a flip is seen at once; the change stream below also
  // drops bindings as soon as the setting goes off, which ends subscriptions.
  const ensureEnabled = settings.getSettings.pipe(
    Effect.mapError(() => operationError("unavailable", "settings_unreadable")),
    Effect.flatMap((current) =>
      current.amuCreatorEnabled
        ? Effect.void
        : revokeAll.pipe(Effect.andThen(Effect.fail(new CreatorDisabledError()))),
    ),
  );

  const settingsChanges = yield* settings.subscribeChanges;
  yield* Stream.runForEach(settingsChanges, (current) =>
    current.amuCreatorEnabled ? Effect.void : revokeAll,
  ).pipe(Effect.forkScoped);

  const requireBinding = Effect.fn("CreatorService.requireBinding")(function* (
    bindingId: CreatorBindingId,
  ) {
    yield* ensureEnabled;
    if (!isLocalCreatorHost(config, channel)) {
      return yield* Effect.fail(operationError("unavailable", "desktop_only"));
    }
    const binding = bindings.get(bindingId);
    if (binding === undefined) {
      return yield* Effect.fail(operationError("unauthorized", "unknown_binding"));
    }
    return binding;
  });

  /** A binding operation: current epoch and a live generation. */
  const requireOperable = Effect.fn("CreatorService.requireOperable")(function* (
    ref: CreatorBindingRef,
  ) {
    const binding = yield* requireBinding(ref.bindingId);
    if (binding.generation === null || ref.epoch !== binding.epoch) {
      return yield* Effect.fail(operationError("stale_epoch", "stale_epoch"));
    }
    return binding;
  });

  const entryOf = (projectId: CreatorProjectId): ProjectEntry => {
    let entry = projects.get(projectId);
    if (entry === undefined) {
      entry = { lock: Semaphore.makeUnsafe(1), loaded: null };
      projects.set(projectId, entry);
    }
    return entry;
  };

  /** First open of a project in this process: remove shot files nothing references (J). */
  const sweepOrphans = (loaded: LoadedProject) =>
    fileOp("sweep_shots", async () => {
      const referenced = referencedShots(loaded.state);
      const failed: unknown[] = [];
      for (const name of await listShotFiles(loaded.store)) {
        const parsed = parseShotFileName(name);
        if (parsed === null || referenced.has(shotKey(parsed))) continue;
        // One odd entry (a folder, a symlink) must not stop the rest of the sweep.
        await removeShot(loaded.store, parsed).catch((cause: unknown) => failed.push(cause));
      }
      if (failed.length > 0) throw new AggregateError(failed, "some shot files were not removed");
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Amu Creator shot sweep failed", { cause })),
    );

  const load = (projectId: CreatorProjectId, entry: ProjectEntry) =>
    entry.loaded !== null
      ? Effect.succeed(entry.loaded)
      : fileOp("open_store", async () => {
          const store = await openProjectStore(await creatorRoot(), projectId);
          return { store, state: await readStore(store) } satisfies LoadedProject;
        }).pipe(
          Effect.tap(sweepOrphans),
          Effect.tap((loaded) =>
            Effect.sync(() => {
              entry.loaded = loaded;
            }),
          ),
        );

  /**
   * Runs `guard`, then `f`, holding the project's lock with its loaded state.
   * Waiting for the lock can be interrupted; the section itself cannot, so a
   * cancelled request never releases the lock while a write is still running
   * (a late rename would roll `comments.json` back). `guard` re-checks the
   * caller's authority inside the lock, so a revoke or a setting flip that
   * lands while the call waits is honoured.
   */
  const locked = <A, E, R>(
    projectId: CreatorProjectId,
    guard: Effect.Effect<unknown, CreatorError>,
    f: (loaded: LoadedProject, entry: ProjectEntry) => Effect.Effect<A, E, R>,
  ) => {
    const entry = entryOf(projectId);
    return entry.lock.withPermits(1)(
      Effect.uninterruptible(
        guard.pipe(
          Effect.andThen(load(projectId, entry)),
          Effect.flatMap((loaded) => f(loaded, entry)),
        ),
      ),
    );
  };

  const stateContext = (projectId: CreatorProjectId) =>
    DateTime.now.pipe(
      Effect.map((now): CreatorStateContext => ({
        now: DateTime.toDateUtc(now),
        newId: () => NodeCrypto.randomUUID(),
        gate,
        rateKey: projectId,
      })),
    );

  /** Best effort: remove files the previous state referenced and the next one does not. */
  const releaseShots = (store: ProjectStore, prev: CreatorStoreFile, next: CreatorStoreFile) => {
    const still = referencedShots(next);
    const dropped = [...referencedShots(prev).values()].filter((ref) => !still.has(shotKey(ref)));
    if (dropped.length === 0) return Effect.void;
    return fileOp("release_shots", async () => {
      for (const ref of dropped) await removeShot(store, ref);
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Amu Creator shot cleanup failed", { cause })),
    );
  };

  /** Size check, atomic write, cache, publish. On any failure the old state stays. */
  const commit = (
    projectId: CreatorProjectId,
    entry: ProjectEntry,
    loaded: LoadedProject,
    next: CreatorStoreFile,
  ) =>
    Effect.gen(function* () {
      const prev = loaded.state;
      const state = next.revision > prev.revision ? next : { ...next, revision: prev.revision + 1 };
      if (byteSizeOfStore(state) > CREATOR_LIMITS.maxStoreBytes) {
        return yield* Effect.fail(operationError("limit", "store_bytes"));
      }
      yield* fileOp("write_store", () => writeStoreAtomic(loaded.store, state));
      entry.loaded = { store: loaded.store, state };
      yield* PubSub.publish(events, { _tag: "state", projectId, state });
      yield* releaseShots(loaded.store, prev, state);
      return state;
    });

  /** Applies a pure transition under the project lock and commits it. */
  const runPure = <V>(
    projectId: CreatorProjectId,
    guard: Effect.Effect<unknown, CreatorError>,
    transition: (
      state: CreatorStoreFile,
      ctx: CreatorStateContext,
    ) => StateResult<V> | CreatorOperationError,
  ) =>
    surface(
      locked(projectId, guard, (loaded, entry) =>
        Effect.gen(function* () {
          const ctx = yield* stateContext(projectId);
          const result = transition(loaded.state, ctx);
          if (isOperationError(result)) return yield* Effect.fail(result);
          if (!result.ok) {
            // A refusal can still change state (a stale proposal voided); keep that change.
            if (result.state !== undefined) yield* commit(projectId, entry, loaded, result.state);
            return yield* Effect.fail(stateError(result.reason));
          }
          const state = yield* commit(projectId, entry, loaded, result.state);
          return { value: result.value, state };
        }),
      ),
    );

  const expectRevision = (
    state: CreatorStoreFile,
    commentId: CreatorCommentId,
    expected: number,
  ): CreatorOperationError | null => {
    const comment = state.comments.find((entry) => entry.id === commentId);
    return comment !== undefined && comment.revision !== expected
      ? operationError("stale_revision", "comment_revision")
      : null;
  };

  const bind: CreatorService["Service"]["bind"] = Effect.fn("CreatorService.bind")(
    function* (input) {
      yield* ensureEnabled;
      if (!isLocalCreatorHost(config, channel)) {
        return yield* Effect.fail(operationError("unavailable", "desktop_only"));
      }
      const binding: CreatorBinding = {
        ...input,
        bindingId: NodeCrypto.randomUUID() as CreatorBindingId,
        epoch: 0,
        generation: null,
        tabId: null,
      };
      bindings.set(binding.bindingId, binding);
      return binding;
    },
  );

  const attachTab: CreatorService["Service"]["attachTab"] = Effect.fn("CreatorService.attachTab")(
    function* (bindingId, tabId) {
      const binding = yield* requireBinding(bindingId);
      if (binding.tabId === tabId) return binding;
      if (binding.tabId !== null) {
        return yield* Effect.fail(operationError("conflict", "tab_already_attached"));
      }
      const next = { ...binding, tabId };
      bindings.set(bindingId, next);
      return next;
    },
  );

  const attachTabNow: CreatorService["Service"]["attachTabNow"] = (bindingId, tabId) => {
    const binding = bindings.get(bindingId);
    if (binding === undefined) return false;
    if (binding.tabId === tabId) return true;
    if (binding.tabId !== null) return false;
    bindings.set(bindingId, { ...binding, tabId });
    return true;
  };

  const requireBindingForThread: CreatorService["Service"]["requireBindingForThread"] = Effect.fn(
    "CreatorService.requireBindingForThread",
  )(function* (projectId, threadId) {
    yield* ensureEnabled;
    if (!isLocalCreatorHost(config, channel)) {
      return yield* Effect.fail(operationError("unavailable", "desktop_only"));
    }
    const matches = [...bindings.values()].filter(
      (binding) => binding.projectId === projectId && binding.destination.threadId === threadId,
    );
    const newest = matches.at(-1);
    if (newest === undefined) {
      return yield* Effect.fail(operationError("unauthorized", "no_binding_for_thread"));
    }
    return newest;
  });

  const setEpoch: CreatorService["Service"]["setEpoch"] = Effect.fn("CreatorService.setEpoch")(
    function* (input) {
      const binding = yield* requireBinding(input.bindingId);
      if (input.epoch <= binding.epoch) return binding;
      const next = { ...binding, epoch: input.epoch, generation: input.generation };
      bindings.set(binding.bindingId, next);
      return next;
    },
  );

  /** `f` gets the binding and a guard that repeats the same check inside the project lock. */
  const withBinding = <A>(
    ref: CreatorBindingRef,
    f: (
      binding: CreatorBinding,
      guard: Effect.Effect<unknown, CreatorError>,
    ) => Effect.Effect<A, CreatorError>,
  ) => requireOperable(ref).pipe(Effect.flatMap((binding) => f(binding, requireOperable(ref))));

  const saveDraft: CreatorService["Service"]["saveDraft"] = (input) =>
    withBinding(input, (binding, guard) =>
      runPure(binding.projectId, guard, (state, ctx) => {
        const commentId = input.commentId;
        if (commentId === undefined) {
          return createDraft(
            state,
            {
              timeSec: input.timeSec,
              projectRevision: input.projectRevision,
              comment: input.comment,
              place: input.place,
            },
            ctx,
          );
        }
        return replaceDraft(
          state,
          {
            id: commentId,
            timeSec: input.timeSec,
            projectRevision: input.projectRevision,
            comment: input.comment,
            place: input.place,
          },
          ctx,
        );
      }).pipe(Effect.map((result) => result.value)),
    );

  const updateComment: CreatorService["Service"]["updateComment"] = (input) =>
    withBinding(input, (binding, guard) =>
      runPure(
        binding.projectId,
        guard,
        (state, ctx) =>
          expectRevision(state, input.commentId, input.expectedRevision) ??
          updateCommentState(state, { id: input.commentId, comment: input.comment }, ctx),
      ).pipe(Effect.map((result) => result.value)),
    );

  const setPlace: CreatorService["Service"]["setPlace"] = (input) =>
    withBinding(input, (binding, guard) =>
      runPure(
        binding.projectId,
        guard,
        (state, ctx) =>
          expectRevision(state, input.commentId, input.expectedRevision) ??
          setPlaceState(state, { id: input.commentId, place: input.place }, ctx),
      ).pipe(Effect.map((result) => result.value)),
    );

  const deleteComment: CreatorService["Service"]["deleteComment"] = (input) =>
    withBinding(input, (binding, guard) =>
      runPure(binding.projectId, guard, (state, ctx) =>
        deleteCommentState(state, { id: input.commentId }, ctx),
      ).pipe(Effect.asVoid),
    );

  const propose: CreatorService["Service"]["propose"] = (input) =>
    withBinding(input, (binding, guard) =>
      runPure(binding.projectId, guard, (state, ctx) =>
        proposeState(
          state,
          {
            ids: input.commentIds,
            destination: binding.destination,
            bindingId: binding.bindingId,
          },
          ctx,
        ),
      ).pipe(Effect.map((result) => result.value)),
    );

  const cancelProposal: CreatorService["Service"]["cancelProposal"] = (input) =>
    withBinding(input, (binding, guard) =>
      runPure(binding.projectId, guard, (state, ctx) =>
        cancelProposalState(state, { proposalId: input.proposalId }, ctx),
      ).pipe(Effect.asVoid),
    );

  const confirmByUser: CreatorService["Service"]["confirmByUser"] = (input) =>
    withBinding(input, (binding, guard) =>
      runPure(binding.projectId, guard, (state, ctx) =>
        confirmByUserState(state, { ids: [input.commentId] }, ctx),
      ).pipe(
        Effect.flatMap(({ state }) => {
          const comment = state.comments.find((entry) => entry.id === input.commentId);
          return comment === undefined
            ? Effect.fail(operationError("not_found", "comment"))
            : Effect.succeed(comment);
        }),
      ),
    );

  const resolve: CreatorService["Service"]["resolve"] = (projectId, ids, note) =>
    ensureEnabled.pipe(
      Effect.andThen(
        runPure(projectId, ensureEnabled, (state, ctx) => resolveState(state, { ids, note }, ctx)),
      ),
      Effect.asVoid,
    );

  /**
   * Order matters: everything that can refuse without touching the disk runs
   * before the shot file is written, and a failed store write removes it again.
   */
  const attachShot: CreatorService["Service"]["attachShot"] = (input) =>
    withBinding(input, (binding, guard) =>
      surface(
        locked(binding.projectId, guard, (loaded, entry) =>
          Effect.gen(function* () {
            const { state, store } = loaded;
            const comment = state.comments.find((entry) => entry.id === input.commentId);
            if (comment === undefined) {
              return yield* Effect.fail(operationError("not_found", "comment"));
            }
            if (comment.status === "sending") {
              return yield* Effect.fail(operationError("conflict", "sending"));
            }
            if (comment.revision !== input.expectedRevision) {
              return yield* Effect.fail(operationError("stale_revision", "comment_revision"));
            }
            const size = pngSize(input.png);
            if (isOperationError(size)) return yield* Effect.fail(size);

            const name: ShotName = { commentId: comment.id, revision: comment.revision };
            // No ref can name the current revision (attaching bumps it), so a file
            // here is a leftover of an earlier failed attempt.
            yield* fileOp("remove_stale_shot", () => removeShot(store, name));

            /** Keep the state consistent with files already evicted, even on failure. */
            const recordEvicted = (evicted: ReadonlyArray<ShotName>) =>
              evicted.length === 0
                ? Effect.void
                : commit(binding.projectId, entry, loaded, clearShotRefs(state, evicted)).pipe(
                    Effect.asVoid,
                    Effect.catchCause((cause) =>
                      Effect.logWarning("Amu Creator could not record evicted shots", { cause }),
                    ),
                  );
            const dropNewShot = fileOp("remove_new_shot", () => removeShot(store, name)).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Amu Creator could not remove a new shot", { cause }),
              ),
            );

            const written = yield* fileOp("write_shot", () =>
              writeShot(store, name, input.png, { evictable: evictableShots(state, comment.id) }),
            ).pipe(
              Effect.tapError((error) =>
                error.cause instanceof CreatorFileError
                  ? recordEvicted(error.cause.evicted)
                  : Effect.void,
              ),
            );
            const base = clearShotRefs(state, written.evicted);
            const ctx = yield* stateContext(binding.projectId);
            const result = attachShotState(
              base,
              {
                id: comment.id,
                shot: { ...name, sha256: written.sha256, width: size.width, height: size.height },
              },
              ctx,
            );
            if (!result.ok) {
              yield* dropNewShot;
              yield* recordEvicted(written.evicted);
              return yield* Effect.fail(stateError(result.reason));
            }
            yield* commit(binding.projectId, entry, loaded, result.state).pipe(
              Effect.tapError(() =>
                dropNewShot.pipe(Effect.andThen(recordEvicted(written.evicted))),
              ),
            );
            return result.value;
          }),
        ),
      ),
    );

  const readShot: CreatorService["Service"]["readShot"] = (input) =>
    withBinding(input, (binding, guard) =>
      surface(
        locked(binding.projectId, guard, (loaded) =>
          Effect.gen(function* () {
            const shot = referencedShots(loaded.state).get(
              shotKey({ commentId: input.commentId, revision: input.revision }),
            );
            if (shot === undefined) {
              return yield* Effect.fail(operationError("not_found", "shot"));
            }
            const bytes = yield* fileOp("read_shot", () => readShotFile(loaded.store, shot));
            return { shot, png: new Uint8Array(bytes) };
          }),
        ),
      ),
    );

  const readProposalShot: CreatorService["Service"]["readProposalShot"] = (
    projectId,
    proposalId,
    ref,
  ) =>
    surface(
      locked(projectId, Effect.void, (loaded) =>
        Effect.gen(function* () {
          const proposal = loaded.state.proposals.find((entry) => entry.id === proposalId);
          const pinned = proposal?.items.some(
            (item) =>
              item.shot !== null &&
              item.shot.commentId === ref.commentId &&
              item.shot.revision === ref.revision &&
              item.shot.sha256 === ref.sha256,
          );
          if (pinned !== true) return yield* Effect.fail(operationError("not_found", "shot"));
          const bytes = yield* fileOp("read_shot", () => readShotFile(loaded.store, ref));
          return new Uint8Array(bytes);
        }),
      ),
    );

  const currentState = (projectId: CreatorProjectId, guard: Effect.Effect<unknown, CreatorError>) =>
    surface(locked(projectId, guard, (loaded) => Effect.succeed(loaded.state)));

  const list: CreatorService["Service"]["list"] = (input) =>
    withBinding(input, (binding, guard) =>
      currentState(binding.projectId, guard).pipe(
        Effect.map((state) => snapshotOf(binding.projectId, state)),
      ),
    );

  const changes: CreatorService["Service"]["changes"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const binding = yield* requireOperable(input);
        // Subscribe before reading so no change between the two is lost.
        const subscription = yield* PubSub.subscribe(events);
        const initial = yield* currentState(binding.projectId, requireOperable(input));
        const revoked = Effect.fail(operationError("unauthorized", "binding_revoked"));
        if (!bindings.has(binding.bindingId)) return Stream.fromEffect(revoked);
        let last = initial.revision;
        const live = Stream.fromSubscription(subscription).pipe(
          Stream.mapEffect((event): Effect.Effect<CreatorSnapshot | null, CreatorError> => {
            if (event._tag === "revoked") {
              return bindings.has(binding.bindingId) ? Effect.succeed(null) : revoked;
            }
            if (event.projectId !== binding.projectId || event.state.revision <= last) {
              return Effect.succeed(null);
            }
            last = event.state.revision;
            return Effect.succeed(snapshotOf(binding.projectId, event.state));
          }),
          Stream.filter((snapshot): snapshot is CreatorSnapshot => snapshot !== null),
        );
        return Stream.concat(Stream.succeed(snapshotOf(binding.projectId, initial)), live);
      }),
    );

  const withProjectState: CreatorService["Service"]["withProjectState"] = (projectId, f) =>
    surface(
      locked(projectId, Effect.void, (loaded, entry) =>
        Effect.gen(function* () {
          const ctx = yield* stateContext(projectId);
          const step = yield* f(loaded.state, ctx);
          if (step.next !== null) yield* commit(projectId, entry, loaded, step.next);
          return step.value;
        }),
      ),
    );

  return CreatorService.of({
    bind,
    attachTab,
    attachTabNow,
    revoke,
    revokeAll,
    requireBinding,
    requireBindingForThread,
    setEpoch,
    saveDraft,
    updateComment,
    setPlace,
    attachShot,
    deleteComment,
    propose,
    cancelProposal,
    confirmByUser,
    resolve,
    readShot,
    readProposalShot,
    list,
    changes,
    withProjectState,
  });
});

export const layer = Layer.effect(CreatorService, make);
