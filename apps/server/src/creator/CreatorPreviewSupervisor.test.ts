// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDateInEffect:off - temporary roots, pid polling and wall-clock timing of real child processes.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Supervisor from "./CreatorPreviewSupervisor.ts";

const FAKE = NodePath.join(import.meta.dirname, "fixtures", "fake-preview.mjs");

type Mode = "ready" | "silent" | "exit" | "ignore-sigterm" | "bad";

/** The fake reads its mode from the root's folder name prefix: `<mode>--<n>`. */
const fakeCommand: Supervisor.CreatorPreviewCommand = {
  file: process.execPath,
  args: (root, port) => [FAKE, NodePath.basename(root).split("--")[0]!, root, String(port)],
};

const tempRoots: string[] = [];
const makeRoot = (mode: Mode) =>
  Effect.promise(async () => {
    const parent = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "amu-preview-")),
    );
    const root = NodePath.join(parent, `${mode}--${tempRoots.length}`);
    await NodeFSP.mkdir(root);
    tempRoots.push(parent);
    return root;
  });

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** pids written by the fake: [leader, grandchild]. */
const readPids = (root: string) =>
  Effect.promise(async () => {
    for (let i = 0; i < 200; i += 1) {
      const names = (await NodeFSP.readdir(root)).filter((name) => name.startsWith("pids-"));
      if (names.length > 0) {
        const text = await NodeFSP.readFile(NodePath.join(root, names[0]!), "utf8");
        const pids = text.trim().split(" ").map(Number);
        if (pids.length === 2 && pids.every((pid) => pid > 1)) return pids;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`no pid file in ${root}`);
  });

const pidFileCount = (root: string) =>
  Effect.promise(
    async () => (await NodeFSP.readdir(root)).filter((name) => name.startsWith("pids-")).length,
  );

/** A killed process can take a moment to be reaped; wait up to 3 s. */
const expectGone = (pids: ReadonlyArray<number>) =>
  Effect.promise(async () => {
    for (let i = 0; i < 150 && pids.some(isAlive); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(pids.filter(isAlive)).toEqual([]);
  });

const services = Layer.mergeAll(NodeServices.layer, NetService.layer);

const withSupervisor = <A, E>(
  options: Supervisor.CreatorPreviewOptions,
  f: (supervisor: Supervisor.CreatorPreviewSupervisor["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const supervisor = yield* Supervisor.make({ command: fakeCommand, ...options });
      return yield* f(supervisor);
    }),
  ).pipe(Effect.provide(services));

const startError = (exit: Exit.Exit<unknown, unknown>) => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const error = exit.cause.reasons.find((reason) => reason._tag === "Fail");
    return error?._tag === "Fail" ? error.error : undefined;
  }
  return undefined;
};

it.afterAll(async () => {
  await Promise.all(tempRoots.map((dir) => NodeFSP.rm(dir, { recursive: true, force: true })));
});

it.live("returns the Studio URL once ready and shares one child per root", () =>
  Effect.gen(function* () {
    const root = yield* makeRoot("ready");
    const pids = yield* withSupervisor({}, (supervisor) =>
      Effect.gen(function* () {
        const [a, b] = yield* Effect.all([supervisor.ensure(root), supervisor.ensure(root)], {
          concurrency: "unbounded",
        });
        expect(a).toEqual(b);
        expect(a.url).toBe(`http://localhost:${a.port}/#project/${NodePath.basename(root)}`);
        const pids = yield* readPids(root);
        expect(a.pid).toBe(pids[0]);
        expect(yield* pidFileCount(root)).toBe(1);
        // A later call reuses the running preview.
        expect(yield* supervisor.ensure(root)).toEqual(a);
        expect(pids.every(isAlive)).toBe(true);
        return pids;
      }),
    );
    yield* expectGone(pids);
  }),
);

it.live("stop(root) stops the group and frees the slot", () =>
  Effect.gen(function* () {
    const root = yield* makeRoot("ready");
    const other = yield* makeRoot("ready");
    yield* withSupervisor({ maxPreviews: 1 }, (supervisor) =>
      Effect.gen(function* () {
        yield* supervisor.ensure(root);
        const pids = yield* readPids(root);
        yield* supervisor.stop(root);
        yield* expectGone(pids);
        const next = yield* supervisor.ensure(other);
        expect(next.pid).toBe((yield* readPids(other))[0]);
      }),
    );
  }),
);

it.live("a silent child times out, its group is killed and the slot is freed", () =>
  Effect.gen(function* () {
    const silent = yield* makeRoot("silent");
    const ready = yield* makeRoot("ready");
    yield* withSupervisor({ maxPreviews: 1, readyTimeoutMs: 400 }, (supervisor) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(supervisor.ensure(silent));
        expect(startError(exit)).toMatchObject({
          _tag: "CreatorPreviewStartError",
          reason: "timeout",
        });
        yield* expectGone(yield* readPids(silent));
        yield* supervisor.ensure(ready);
      }),
    );
  }),
);

it.live("a child that exits early fails the start and frees the slot", () =>
  Effect.gen(function* () {
    const early = yield* makeRoot("exit");
    const ready = yield* makeRoot("ready");
    yield* withSupervisor({ maxPreviews: 1 }, (supervisor) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(supervisor.ensure(early));
        expect(startError(exit)).toMatchObject({
          _tag: "CreatorPreviewStartError",
          reason: "exited",
        });
        yield* supervisor.ensure(ready);
      }),
    );
  }),
);

it.live("a Studio line that does not point at our port is refused", () =>
  Effect.gen(function* () {
    const bad = yield* makeRoot("bad");
    yield* withSupervisor({}, (supervisor) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(supervisor.ensure(bad));
        expect(startError(exit)).toMatchObject({ reason: "bad_output" });
        yield* expectGone(yield* readPids(bad));
      }),
    );
  }),
);

it.live("refuses a fourth preview while three run, counting one still starting", () =>
  Effect.gen(function* () {
    const a = yield* makeRoot("ready");
    const b = yield* makeRoot("ready");
    const starting = yield* makeRoot("silent");
    const fourth = yield* makeRoot("ready");
    const pids = yield* withSupervisor({ readyTimeoutMs: 30_000 }, (supervisor) =>
      Effect.gen(function* () {
        yield* supervisor.ensure(a);
        yield* supervisor.ensure(b);
        const pending = yield* Effect.forkChild(supervisor.ensure(starting));
        const startingPids = yield* readPids(starting);
        const exit = yield* Effect.exit(supervisor.ensure(fourth));
        expect(startError(exit)).toMatchObject({
          _tag: "CreatorPreviewLimitError",
          limit: 3,
        });
        expect(yield* pidFileCount(fourth)).toBe(0);
        // Stopping the starting one fails its waiter and frees the slot.
        yield* supervisor.stop(starting);
        const pendingExit = yield* Fiber.await(pending);
        expect(startError(pendingExit)).toMatchObject({ reason: "stopped" });
        yield* expectGone(startingPids);
        yield* supervisor.ensure(fourth);
        return [...(yield* readPids(a)), ...(yield* readPids(b)), ...(yield* readPids(fourth))];
      }),
    );
    // Closing the supervisor's scope stops every preview.
    yield* expectGone(pids);
  }),
);

it.live("a child that ignores SIGTERM is killed with SIGKILL after the grace period", () =>
  Effect.gen(function* () {
    const root = yield* makeRoot("ignore-sigterm");
    yield* withSupervisor({ killGraceMs: 500 }, (supervisor) =>
      Effect.gen(function* () {
        yield* supervisor.ensure(root);
        const pids = yield* readPids(root);
        const started = Date.now();
        yield* supervisor.stop(root);
        expect(Date.now() - started).toBeGreaterThanOrEqual(450);
        yield* expectGone(pids);
      }),
    );
  }),
);

it.live("a preview that exits after it was ready frees its slot and starts again", () =>
  Effect.gen(function* () {
    const root = yield* makeRoot("ready");
    yield* withSupervisor({ maxPreviews: 1 }, (supervisor) =>
      Effect.gen(function* () {
        const first = yield* supervisor.ensure(root);
        const [leader, grandchild] = yield* readPids(root);
        // Only the pid this test's supervisor spawned.
        process.kill(leader!, "SIGKILL");
        yield* expectGone([leader!, grandchild!]);
        // The watcher releases the slot; the next ensure starts a new child.
        let next = first;
        for (let i = 0; i < 100 && next.pid === first.pid; i += 1) {
          yield* Effect.sleep("20 millis");
          next = yield* supervisor.ensure(root);
        }
        expect(next.pid).not.toBe(first.pid);
      }),
    );
  }),
);

it.live("an ensure interrupted right after admitting its slot still starts or frees it", () =>
  Effect.gen(function* () {
    const root = yield* makeRoot("ready");
    const other = yield* makeRoot("ready");
    const admitted = yield* Deferred.make<void>();
    yield* withSupervisor(
      {
        maxPreviews: 1,
        // Test seam: runs between admission and the start of the launch.
        afterAdmit: Deferred.succeed(admitted, undefined).pipe(
          Effect.andThen(Effect.sleep("50 millis")),
        ),
      },
      (supervisor) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(supervisor.ensure(root));
          yield* Deferred.await(admitted);
          yield* Fiber.interrupt(fiber);
          // The slot was started (not left admitted forever): a new ensure gets it.
          const ready = yield* supervisor
            .ensure(root)
            .pipe(Effect.timeoutOption("5 seconds"), Effect.map(Option.getOrUndefined));
          expect(ready?.url).toContain(`/#project/${NodePath.basename(root)}`);
          yield* supervisor.stop(root);
          yield* supervisor.ensure(other);
        }),
    );
  }),
);

it.live("a defect while launching frees the slot", () =>
  Effect.gen(function* () {
    const broken = yield* makeRoot("ready");
    const ready = yield* makeRoot("ready");
    const command: Supervisor.CreatorPreviewCommand = {
      file: fakeCommand.file,
      args: (root, port) => {
        if (root === broken) throw new Error("boom");
        return fakeCommand.args(root, port);
      },
    };
    yield* withSupervisor({ maxPreviews: 1, command }, (supervisor) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(supervisor.ensure(broken));
        expect(startError(exit)).toMatchObject({ reason: "internal" });
        yield* supervisor.ensure(ready);
      }),
    );
  }),
);

it.live("refuses a relative root without taking a slot", () =>
  withSupervisor({ maxPreviews: 1 }, (supervisor) =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(supervisor.ensure("relative/project"));
      expect(startError(exit)).toMatchObject({ reason: "invalid_root" });
      yield* supervisor.ensure(yield* makeRoot("ready"));
    }),
  ),
);
