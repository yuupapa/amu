/**
 * Runs `hyperframes preview` for Amu Creator, one child per serving folder.
 *
 * - One slot per serving root. Concurrent `ensure` calls for the same root wait
 *   on the same start. A slot counts from the moment it is admitted, so a
 *   preview that is still starting counts toward the limit (3 by default).
 * - Every start has its own scope holding the child. The child runs in its own
 *   process group (`detached`), and closing the scope signals the group with
 *   SIGTERM, waits up to the grace period (3 s) and then sends SIGKILL.
 * - A start fails when the ready line does not arrive in time (60 s), the child
 *   exits first, or the Studio line does not point at the port we chose. The
 *   group is stopped and the slot freed before the waiters see the failure.
 * - A child that exits after it was ready frees its slot, so the next `ensure`
 *   starts it again. Closing the supervisor's scope stops every preview.
 *
 * Without `--foreground` a non-interactive launch daemonizes and the spawned
 * process exits, so the default command always passes it.
 */
import { CREATOR_LIMITS } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export const HYPERFRAMES_VERSION = "0.8.143";

export interface CreatorPreviewCommand {
  readonly file: string;
  readonly args: (root: string, port: number) => ReadonlyArray<string>;
}

export const HYPERFRAMES_PREVIEW_COMMAND: CreatorPreviewCommand = {
  file: "npx",
  args: (root, port) => [
    "--yes",
    `hyperframes@${HYPERFRAMES_VERSION}`,
    "preview",
    root,
    "--port",
    String(port),
    "--foreground",
    "--no-open",
    "--force-new",
  ],
};

export interface CreatorPreviewOptions {
  readonly command?: CreatorPreviewCommand;
  readonly readyTimeoutMs?: number;
  readonly maxPreviews?: number;
  /** Time between SIGTERM and SIGKILL when stopping a process group. */
  readonly killGraceMs?: number;
  /** Test seam: runs after a new slot is admitted and before its launch is forked. */
  readonly afterAdmit?: Effect.Effect<void>;
}

export interface CreatorPreview {
  readonly url: string;
  readonly port: number;
  readonly pid: number;
}

export class CreatorPreviewLimitError extends Data.TaggedError("CreatorPreviewLimitError")<{
  readonly limit: number;
}> {}

export type CreatorPreviewStartFailure =
  | "port_unavailable"
  | "spawn_failed"
  | "timeout"
  | "exited"
  | "bad_output"
  | "stopped"
  | "invalid_root"
  | "internal";

export class CreatorPreviewStartError extends Data.TaggedError("CreatorPreviewStartError")<{
  readonly reason: CreatorPreviewStartFailure;
  readonly detail: string;
}> {}

export class CreatorPreviewSupervisor extends Context.Service<
  CreatorPreviewSupervisor,
  {
    /** Starts the preview for a serving root, or returns the one already running or starting. */
    readonly ensure: (
      servingRoot: string,
    ) => Effect.Effect<CreatorPreview, CreatorPreviewLimitError | CreatorPreviewStartError>;
    /** Stops the preview for a serving root (no-op when none). Waits until the group is gone. */
    readonly stop: (servingRoot: string) => Effect.Effect<void>;
  }
>()("t3/creator/CreatorPreviewSupervisor") {}

const MAX_LINE_CHARS = 64 * 1024;
const STDERR_TAIL_CHARS = 2 * 1024;
// CSI sequences (colors, cursor) and OSC sequences (hyperlinks, titles).
// oxlint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/**
 * Reads one output line. `null` when it is not the Studio line; `"bad"` when it
 * is, but its URL is not `http://localhost:<port>` (or 127.0.0.1).
 */
export const parseStudioLine = (line: string, port: number): string | "bad" | null => {
  const text = line.replace(ANSI, "").trim();
  if (!text.startsWith("Studio")) return null;
  const match = /https?:\/\/\S+/.exec(text);
  if (match === null) return "bad";
  let url: URL;
  try {
    url = new URL(match[0]);
  } catch {
    return "bad";
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  return url.protocol === "http:" && local && url.port === String(port) ? match[0] : "bad";
};

interface Slot {
  readonly ready: Deferred.Deferred<CreatorPreview, CreatorPreviewStartError>;
  /** Completed once the group is stopped and the slot removed. */
  readonly closed: Deferred.Deferred<void>;
  /** Holds the child; closing it stops the process group. */
  readonly scope: Scope.Closeable;
  stopping: boolean;
}

const startError = (reason: CreatorPreviewStartFailure, detail: string) =>
  new CreatorPreviewStartError({ reason, detail });

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.fn("CreatorPreviewSupervisor.make")(function* (
  options: CreatorPreviewOptions = {},
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const net = yield* NetService.NetService;
  const serviceScope = yield* Scope.Scope;
  const command = options.command ?? HYPERFRAMES_PREVIEW_COMMAND;
  const readyTimeoutMs = options.readyTimeoutMs ?? CREATOR_LIMITS.hyperframesStartTimeoutMs;
  const maxPreviews = options.maxPreviews ?? CREATOR_LIMITS.maxPreviews;
  const killGraceMs = options.killGraceMs ?? 3_000;
  const slots = yield* Ref.make<ReadonlyMap<string, Slot>>(new Map());

  /**
   * Stops the group, then frees the slot, then fails anyone still waiting.
   * Idempotent: a second caller waits for the first to finish. Uninterruptible
   * so a stop that has begun always frees its slot.
   */
  const stopSlot = (root: string, slot: Slot, error: CreatorPreviewStartError) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        if (slot.stopping) return yield* Deferred.await(slot.closed);
        slot.stopping = true;
        yield* Scope.close(slot.scope, Exit.void);
        yield* Ref.update(slots, (map) => {
          if (map.get(root) !== slot) return map;
          const next = new Map(map);
          next.delete(root);
          return next;
        });
        yield* Deferred.fail(slot.ready, error);
        yield* Deferred.succeed(slot.closed, undefined);
      }),
    );

  const launch = (root: string, slot: Slot) =>
    Effect.gen(function* () {
      const port = yield* net
        .reserveLoopbackPort()
        .pipe(Effect.mapError((cause) => startError("port_unavailable", cause.message)));
      const child = yield* spawner
        .spawn(
          ChildProcess.make(command.file, [...command.args(root, port)], {
            detached: true,
            stdin: "ignore",
            killSignal: "SIGTERM",
            forceKillAfter: `${killGraceMs} millis`,
          }),
        )
        .pipe(
          Effect.provideService(Scope.Scope, slot.scope),
          Effect.mapError((cause) => startError("spawn_failed", cause.message)),
        );
      const pid = Number(child.pid);
      const readyUrl = yield* Deferred.make<string, CreatorPreviewStartError>();

      // Keep draining both pipes for the life of the child, or it can block on
      // a full buffer. Only the first Studio line matters.
      let pending = "";
      let decided = false;
      yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) =>
          Effect.suspend(() => {
            if (decided) return Effect.void;
            const lines = `${pending}${chunk}`.split(/\r?\n/);
            pending = (lines.pop() ?? "").slice(-MAX_LINE_CHARS);
            for (const line of lines) {
              const parsed = parseStudioLine(line, port);
              if (parsed === null) continue;
              decided = true;
              return parsed === "bad"
                ? Deferred.fail(
                    readyUrl,
                    startError("bad_output", `Unexpected Studio line: ${line.slice(0, 200)}`),
                  )
                : Deferred.succeed(readyUrl, parsed);
            }
            return Effect.void;
          }),
        ),
        Effect.ignore,
        Effect.forkIn(slot.scope),
      );
      let stderrTail = "";
      yield* child.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) =>
          Effect.sync(() => {
            stderrTail = `${stderrTail}${chunk}`.slice(-STDERR_TAIL_CHARS);
          }),
        ),
        Effect.ignore,
        Effect.forkIn(slot.scope),
      );

      // Watches the child for its whole life, outside the slot's scope so it can
      // stop that scope. Before ready: fails the start. After: frees the slot.
      yield* child.exitCode.pipe(
        Effect.exit,
        Effect.flatMap((exit) =>
          Effect.gen(function* () {
            const how = Exit.isSuccess(exit) ? `code ${exit.value}` : "a signal";
            const error = startError(
              "exited",
              `hyperframes preview exited with ${how}. ${stderrTail.trim()}`.trim(),
            );
            const wasReady = yield* Deferred.isDone(readyUrl);
            yield* Deferred.fail(readyUrl, error);
            if (wasReady) yield* stopSlot(root, slot, error);
          }),
        ),
        Effect.forkIn(serviceScope),
      );

      const result = yield* Effect.exit(
        Deferred.await(readyUrl).pipe(Effect.timeoutOption(readyTimeoutMs)),
      );
      if (Exit.isFailure(result) || Option.isNone(result.value)) {
        const error = Exit.isFailure(result)
          ? Option.getOrElse(Exit.findErrorOption(result), () =>
              startError("exited", "hyperframes preview stopped before it was ready"),
            )
          : startError("timeout", `No Studio line within ${readyTimeoutMs} ms`);
        return yield* stopSlot(root, slot, error);
      }
      yield* Deferred.succeed(slot.ready, { url: result.value.value, port, pid });
    }).pipe(
      // Defects too, so a bug in a launch still frees its slot. Interruption
      // (supervisor closing) is left to the scope's finalizer.
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : stopSlot(
              root,
              slot,
              Option.getOrElse(Cause.findErrorOption(cause), () =>
                startError("internal", `Unexpected failure: ${String(Cause.squash(cause))}`),
              ),
            ),
      ),
      // Interrupted only when the supervisor's scope closes; its finalizer stops the slot.
      Effect.onInterrupt(() =>
        Deferred.fail(slot.ready, startError("stopped", "Amu Creator preview supervisor stopped")),
      ),
    );

  /**
   * Admits a slot (or finds one) and, for a new slot, forks its launch. Runs
   * uninterruptibly so an admitted slot is always launched, which in turn
   * always ends in ready or a stop that frees it.
   */
  const admit = (root: string) =>
    Effect.gen(function* () {
      const decision = yield* Ref.modify(
        slots,
        (
          map,
        ): readonly [
          (
            | { readonly kind: "join" | "wait" | "start"; readonly slot: Slot }
            | { readonly kind: "limit" }
          ),
          ReadonlyMap<string, Slot>,
        ] => {
          const existing = map.get(root);
          if (existing !== undefined) {
            return [{ kind: existing.stopping ? "wait" : "join", slot: existing }, map];
          }
          if (map.size >= maxPreviews) return [{ kind: "limit" }, map];
          const slot: Slot = {
            ready: Deferred.makeUnsafe(),
            closed: Deferred.makeUnsafe(),
            scope: Scope.makeUnsafe(),
            stopping: false,
          };
          return [{ kind: "start", slot }, new Map(map).set(root, slot)];
        },
      );
      if (decision.kind === "start") {
        if (options.afterAdmit !== undefined) yield* options.afterAdmit;
        // Forked into the supervisor's scope: the start goes on for the other
        // waiters even if this caller is interrupted.
        yield* launch(root, decision.slot).pipe(Effect.forkIn(serviceScope));
      }
      return decision;
    }).pipe(Effect.uninterruptible);

  const ensure: CreatorPreviewSupervisor["Service"]["ensure"] = Effect.fn(
    "CreatorPreviewSupervisor.ensure",
  )(function* (root) {
    // POSIX only (process groups), so an absolute path starts with `/`.
    if (!root.startsWith("/")) {
      return yield* startError("invalid_root", "The serving root must be an absolute path");
    }
    while (true) {
      // Only the waits below can be interrupted.
      const decision = yield* admit(root);
      if (decision.kind === "limit") {
        return yield* new CreatorPreviewLimitError({ limit: maxPreviews });
      }
      if (decision.kind === "wait") {
        yield* Deferred.await(decision.slot.closed);
        continue;
      }
      return yield* Deferred.await(decision.slot.ready);
    }
  });

  const stop: CreatorPreviewSupervisor["Service"]["stop"] = Effect.fn(
    "CreatorPreviewSupervisor.stop",
  )(function* (root) {
    const slot = (yield* Ref.get(slots)).get(root);
    if (slot === undefined) return;
    yield* stopSlot(root, slot, startError("stopped", "The preview was stopped"));
  });

  // Registered before any start is forked, so it runs after their fibers are
  // interrupted (finalizers run in reverse order).
  yield* Scope.addFinalizer(
    serviceScope,
    Effect.gen(function* () {
      const all = [...(yield* Ref.get(slots)).entries()];
      yield* Effect.forEach(
        all,
        ([root, slot]) =>
          stopSlot(root, slot, startError("stopped", "Amu Creator preview supervisor stopped")),
        { concurrency: "unbounded", discard: true },
      );
    }),
  );

  return CreatorPreviewSupervisor.of({ ensure, stop });
});

export const layer = Layer.effect(CreatorPreviewSupervisor, make()).pipe(
  Layer.provide(NetService.layer),
);
