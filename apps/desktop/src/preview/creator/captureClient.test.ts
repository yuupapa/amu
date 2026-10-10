import { describe, expect, it } from "vite-plus/test";

import {
  CAPTURE_SELF_TIMEOUT_MS,
  createCaptureClient,
  type CaptureDeps,
  type CaptureSpec,
} from "./captureClient.ts";

type Deferred = { promise: Promise<void>; resolve: () => void };
const deferred = (): Deferred => {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

/** Lets every pending microtask (awaited steps of the client) run. */
const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

const makeHarness = (options: { measure?: CaptureDeps["measure"] } = {}) => {
  const log: string[] = [];
  let now = 0;
  let nextTimer = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const seeks: Deferred[] = [];
  const frames: Deferred[] = [];
  const ready: unknown[] = [];
  const settled: Array<{ requestId: string; ok: boolean }> = [];
  const deps: CaptureDeps = {
    setTimer: (fn, ms) => {
      const id = nextTimer;
      nextTimer += 1;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
    sendRequest: (spec) => log.push(`request ${spec.requestId}`),
    sendReady: (input) => {
      log.push(`ready ${input.requestId}`);
      ready.push(input);
    },
    pause: () => log.push("pause"),
    seek: (timeSec) => {
      log.push(`seek ${timeSec}`);
      const step = deferred();
      seeks.push(step);
      return step.promise;
    },
    waitFrames: (count) => {
      log.push(`frames ${count}`);
      const step = deferred();
      frames.push(step);
      return step.promise;
    },
    hide: () => log.push("hide"),
    show: () => log.push("show"),
    measure:
      options.measure ??
      ((spec) => {
        log.push(`measure ${spec.requestId}`);
        return { rect: { x: 10, y: 20, width: 960, height: 540 } };
      }),
    onSettled: (spec, ok) => settled.push({ requestId: spec.requestId, ok }),
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of timers) {
      if (timer.at <= now) {
        timers.delete(id);
        timer.fn();
      }
    }
  };
  return { deps, log, seeks, frames, ready, settled, advance, timers };
};

const spec = (overrides: Partial<CaptureSpec> = {}): CaptureSpec => ({
  requestId: "r1",
  purpose: "draft",
  timeSec: 12.5,
  commentId: null,
  place: null,
  pin: null,
  ...overrides,
});

/** Runs begin through every awaited step. */
const runBegin = async (
  harness: ReturnType<typeof makeHarness>,
  client: ReturnType<typeof createCaptureClient>,
  requestId = "r1",
) => {
  const begun = client.begin(requestId);
  await flush();
  harness.seeks.at(-1)?.resolve();
  await flush();
  harness.frames.at(-1)?.resolve();
  await flush();
  harness.frames.at(-1)?.resolve();
  await flush();
  await begun;
};

describe("createCaptureClient", () => {
  it("pauses, seeks, waits two frames, hides, measures and reports ready", async () => {
    const harness = makeHarness();
    const client = createCaptureClient(harness.deps);
    expect(client.request(spec())).toBe(true);
    await runBegin(harness, client);
    expect(harness.log).toEqual([
      "request r1",
      "pause",
      "seek 12.5",
      "frames 2",
      "hide",
      "frames 1",
      "measure r1",
      "ready r1",
    ]);
    expect(harness.ready).toEqual([
      { requestId: "r1", rect: { x: 10, y: 20, width: 960, height: 540 } },
    ]);
  });

  it("sends the pin when the measure has one", async () => {
    const harness = makeHarness({
      measure: () => ({ rect: { x: 0, y: 0, width: 100, height: 50 }, pin: { x: 40, y: 20 } }),
    });
    const client = createCaptureClient(harness.deps);
    client.request(spec({ purpose: "place", pin: { x: 0.4, y: 0.4 } }));
    await runBegin(harness, client);
    expect(harness.ready).toEqual([
      { requestId: "r1", rect: { x: 0, y: 0, width: 100, height: 50 }, pin: { x: 40, y: 20 } },
    ]);
  });

  it("restores the overlay on done and reports the outcome", async () => {
    const harness = makeHarness();
    const client = createCaptureClient(harness.deps);
    client.request(spec());
    await runBegin(harness, client);
    expect(client.frozen()).toBe(true);
    client.done("r1", true);
    expect(harness.log.at(-1)).toBe("show");
    expect(client.frozen()).toBe(false);
    expect(client.busy()).toBe(false);
    expect(harness.settled).toEqual([{ requestId: "r1", ok: true }]);
    expect(harness.timers.size).toBe(0);
  });

  it("ignores done and begin for another request", async () => {
    const harness = makeHarness();
    const client = createCaptureClient(harness.deps);
    client.request(spec());
    await client.begin("other");
    expect(harness.log).toEqual(["request r1"]);
    await runBegin(harness, client);
    client.done("other", true);
    expect(client.frozen()).toBe(true);
    expect(harness.log).not.toContain("show");
    expect(harness.settled).toEqual([]);
  });

  it("restores by itself after the self timeout", async () => {
    const harness = makeHarness();
    const client = createCaptureClient(harness.deps);
    client.request(spec());
    await runBegin(harness, client);
    harness.advance(CAPTURE_SELF_TIMEOUT_MS - 1);
    expect(client.frozen()).toBe(true);
    harness.advance(1);
    expect(client.frozen()).toBe(false);
    expect(harness.log.at(-1)).toBe("show");
    expect(harness.settled).toEqual([{ requestId: "r1", ok: false }]);
    // A late done for the expired request changes nothing.
    client.done("r1", true);
    expect(harness.settled).toHaveLength(1);
  });

  it("gives up a request main never begins", () => {
    const harness = makeHarness();
    const client = createCaptureClient(harness.deps);
    client.request(spec());
    harness.advance(CAPTURE_SELF_TIMEOUT_MS);
    expect(client.busy()).toBe(false);
    expect(harness.log).not.toContain("hide");
    expect(harness.settled).toEqual([{ requestId: "r1", ok: false }]);
  });

  it("settles a refused request (done before begin) without hiding", () => {
    const harness = makeHarness();
    const client = createCaptureClient(harness.deps);
    client.request(spec());
    client.done("r1", false);
    expect(harness.log).toEqual(["request r1"]);
    expect(harness.settled).toEqual([{ requestId: "r1", ok: false }]);
    expect(client.busy()).toBe(false);
  });

  it("keeps controls frozen from request to done and refuses a second request", async () => {
    const harness = makeHarness();
    const client = createCaptureClient(harness.deps);
    expect(client.frozen()).toBe(false);
    client.request(spec());
    expect(client.frozen()).toBe(true);
    expect(client.request(spec({ requestId: "r2" }))).toBe(false);
    await runBegin(harness, client);
    expect(client.frozen()).toBe(true);
    client.done("r1", false);
    expect(client.frozen()).toBe(false);
    expect(client.request(spec({ requestId: "r2" }))).toBe(true);
  });

  it("stops preparing when done arrives in the middle", async () => {
    const harness = makeHarness();
    const client = createCaptureClient(harness.deps);
    client.request(spec());
    const begun = client.begin("r1");
    await flush();
    client.done("r1", false);
    harness.seeks.at(-1)?.resolve();
    await flush();
    harness.frames.at(-1)?.resolve();
    await flush();
    await begun;
    expect(harness.log).toEqual(["request r1", "pause", "seek 12.5"]);
    expect(harness.settled).toEqual([{ requestId: "r1", ok: false }]);
  });

  it("restores at once when the composition cannot be measured", async () => {
    const harness = makeHarness({ measure: () => null });
    const client = createCaptureClient(harness.deps);
    client.request(spec());
    await runBegin(harness, client);
    expect(harness.log).toContain("show");
    expect(harness.ready).toEqual([]);
    expect(harness.settled).toEqual([{ requestId: "r1", ok: false }]);
    expect(client.busy()).toBe(false);
  });

  it("cancel restores a hidden overlay without reporting ready", async () => {
    const harness = makeHarness();
    const client = createCaptureClient(harness.deps);
    client.request(spec());
    await runBegin(harness, client);
    client.cancel();
    expect(harness.log.at(-1)).toBe("show");
    expect(client.busy()).toBe(false);
    expect(harness.timers.size).toBe(0);
  });
});
