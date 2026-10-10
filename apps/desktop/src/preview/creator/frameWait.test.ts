import { describe, expect, it } from "vite-plus/test";

import { waitForFrames, type FrameWaitScheduler } from "./frameWait.ts";

const harness = () => {
  let next = 1;
  const frames = new Map<number, () => void>();
  const timers = new Map<number, { callback: () => void; milliseconds: number }>();
  const cancelled: number[] = [];
  const scheduler: FrameWaitScheduler = {
    requestFrame: (callback) => {
      const id = next++;
      frames.set(id, callback);
      return id;
    },
    cancelFrame: (id) => {
      cancelled.push(id);
      frames.delete(id);
    },
    setTimer: (callback, milliseconds) => {
      const id = next++;
      timers.set(id, { callback, milliseconds });
      return id;
    },
    clearTimer: (id) => {
      timers.delete(id as number);
    },
  };
  const frame = () => {
    const [id, callback] = frames.entries().next().value!;
    frames.delete(id);
    callback();
  };
  return { scheduler, frames, timers, cancelled, frame };
};

describe("waitForFrames", () => {
  it("waits for every requested frame and clears the fallback when rendering runs", async () => {
    const h = harness();
    const waited = waitForFrames(2, h.scheduler);
    h.frame();
    expect(h.frames.size).toBe(1);
    h.frame();
    await waited;
    expect(h.frames.size).toBe(0);
    expect(h.timers.size).toBe(0);
  });

  it("finishes on a bounded timer when an occluded window produces no frames", async () => {
    const h = harness();
    const waited = waitForFrames(2, h.scheduler);
    expect(h.timers.size).toBe(1);
    const timer = h.timers.values().next().value!;
    expect(timer.milliseconds).toBeGreaterThan(0);
    expect(timer.milliseconds).toBeLessThanOrEqual(250);
    const lateFrame = h.frames.values().next().value!;
    timer.callback();
    await waited;
    expect(h.frames.size).toBe(0);
    expect(h.timers.size).toBe(0);
    expect(h.cancelled).toHaveLength(1);
    lateFrame();
    expect(h.frames.size).toBe(0);
  });

  it("cancels the latest pending frame when only part of the wait rendered", async () => {
    const h = harness();
    const waited = waitForFrames(2, h.scheduler);
    h.frame();
    expect(h.timers.size).toBe(1);
    const pending = h.frames.keys().next().value!;
    h.timers.values().next().value!.callback();
    await waited;
    expect(h.cancelled).toEqual([pending]);
    expect(h.frames.size + h.timers.size).toBe(0);
  });

  it("settles once and leaves no work when a timer and a frame race", async () => {
    const h = harness();
    let settled = 0;
    const waited = waitForFrames(1, h.scheduler).then(() => {
      settled += 1;
    });
    expect(h.timers.size).toBe(1);
    const timer = h.timers.values().next().value!.callback;
    h.frame();
    timer();
    await waited;
    expect(settled).toBe(1);
    expect(h.frames.size + h.timers.size).toBe(0);
  });

  it("does not schedule anything for a zero-frame wait", async () => {
    const h = harness();
    await waitForFrames(0, h.scheduler);
    expect(h.frames.size + h.timers.size).toBe(0);
  });
});
