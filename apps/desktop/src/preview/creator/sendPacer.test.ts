import { describe, expect, it } from "vite-plus/test";

import { createRateBudget, createUpdateScheduler } from "./sendPacer.ts";

const makeClock = () => {
  let now = 0;
  let nextTimer = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const id = nextTimer;
      nextTimer += 1;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (handle: unknown) => {
      timers.delete(handle as number);
    },
    advanceTo: (target: number) => {
      while (true) {
        const due = [...timers].filter(([, timer]) => timer.at <= target);
        if (due.length === 0) break;
        due.sort((a, b) => a[1].at - b[1].at);
        const [id, timer] = due[0]!;
        timers.delete(id);
        now = timer.at;
        timer.fn();
      }
      now = target;
    },
    pending: () => timers.size,
  };
};

describe("createRateBudget", () => {
  it("allows two comment messages per second, shared by every comment kind", () => {
    const budget = createRateBudget();
    expect(budget.take("update", 0)).toBe(true);
    expect(budget.take("place", 100)).toBe(true);
    expect(budget.take("delete", 200)).toBe(false);
    expect(budget.take("update", 1_000)).toBe(true);
  });

  it("allows one propose or cancel per two seconds", () => {
    const budget = createRateBudget();
    expect(budget.take("propose", 0)).toBe(true);
    expect(budget.take("cancel", 1_999)).toBe(false);
    expect(budget.take("cancel", 2_000)).toBe(true);
    // The comment bucket is separate.
    expect(budget.take("draft", 2_000)).toBe(true);
  });

  it("does not spend a slot on a refused message", () => {
    const budget = createRateBudget();
    budget.take("update", 0);
    budget.take("update", 500);
    expect(budget.take("update", 900)).toBe(false);
    expect(budget.take("update", 1_000)).toBe(true);
    expect(budget.take("update", 1_499)).toBe(false);
    expect(budget.take("update", 1_500)).toBe(true);
  });
});

describe("createUpdateScheduler", () => {
  it("sends once, 800 ms after the last change", () => {
    const clock = makeClock();
    const sent: Array<[string, string, number]> = [];
    const scheduler = createUpdateScheduler({
      ...clock,
      send: (key, value) => {
        sent.push([key, value, clock.now()]);
        return true;
      },
    });
    scheduler.change("a", "h");
    clock.advanceTo(100);
    scheduler.change("a", "he");
    clock.advanceTo(200);
    scheduler.change("a", "hey");
    clock.advanceTo(5_000);
    expect(sent).toEqual([["a", "hey", 1_000]]);
  });

  it("never sends more than once per second across keys", () => {
    const clock = makeClock();
    const sent: Array<[string, number]> = [];
    const scheduler = createUpdateScheduler({
      ...clock,
      send: (key) => {
        sent.push([key, clock.now()]);
        return true;
      },
    });
    scheduler.change("a", "x");
    clock.advanceTo(850);
    scheduler.change("b", "y");
    clock.advanceTo(900);
    scheduler.change("a", "x2");
    clock.advanceTo(10_000);
    expect(sent).toEqual([
      ["a", 800],
      ["b", 1_800],
      ["a", 2_800],
    ]);
  });

  it("flush sends now when the last send was over a second ago", () => {
    const clock = makeClock();
    const sent: Array<[string, number]> = [];
    const scheduler = createUpdateScheduler({
      ...clock,
      send: (_key, value) => {
        sent.push([value, clock.now()]);
        return true;
      },
    });
    scheduler.change("a", "x");
    clock.advanceTo(100);
    scheduler.flush("a");
    expect(sent).toEqual([["x", 100]]);
    clock.advanceTo(300);
    scheduler.change("a", "y");
    clock.advanceTo(400);
    scheduler.flush("a");
    expect(sent).toHaveLength(1);
    clock.advanceTo(1_100);
    expect(sent).toEqual([
      ["x", 100],
      ["y", 1_100],
    ]);
  });

  it("retries a send that was not ready, keeping the newest value", () => {
    const clock = makeClock();
    let ready = false;
    const sent: Array<[string, number]> = [];
    const scheduler = createUpdateScheduler({
      ...clock,
      send: (_key, value) => {
        if (!ready) return false;
        sent.push([value, clock.now()]);
        return true;
      },
    });
    scheduler.change("a", "x");
    clock.advanceTo(900);
    expect(scheduler.pending("a")).toBe(true);
    scheduler.change("a", "xy");
    ready = true;
    clock.advanceTo(10_000);
    expect(sent).toEqual([["xy", 1_700]]);
    expect(scheduler.pending("a")).toBe(false);
  });

  it("cancel drops a pending value", () => {
    const clock = makeClock();
    const sent: string[] = [];
    const scheduler = createUpdateScheduler({
      ...clock,
      send: (_key, value) => {
        sent.push(value);
        return true;
      },
    });
    scheduler.change("a", "x");
    scheduler.cancel("a");
    clock.advanceTo(5_000);
    expect(sent).toEqual([]);
    expect(clock.pending()).toBe(0);
  });

  it("rekey moves a pending value to a new key", () => {
    const clock = makeClock();
    const sent: Array<[string, string]> = [];
    const scheduler = createUpdateScheduler({
      ...clock,
      send: (key, value) => {
        sent.push([key, value]);
        return true;
      },
    });
    scheduler.change("placeholder", "x");
    scheduler.rekey("placeholder", "comment-1");
    clock.advanceTo(5_000);
    expect(sent).toEqual([["comment-1", "x"]]);
  });
});
