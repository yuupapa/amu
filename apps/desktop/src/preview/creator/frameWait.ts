// @effect-diagnostics globalTimers:off - Pure scheduling helper for the guest preload.
export interface FrameWaitScheduler {
  readonly requestFrame: (callback: () => void) => number;
  readonly cancelFrame: (handle: number) => void;
  readonly setTimer: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
}

/** Prefer rendered frames, but an occluded guest must not stall capture forever. */
export const waitForFrames = (count: number, scheduler: FrameWaitScheduler): Promise<void> => {
  if (count <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    let remaining = count;
    let settled = false;
    let frame: number | null = null;
    let timer: unknown;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (frame !== null) scheduler.cancelFrame(frame);
      scheduler.clearTimer(timer);
      resolve();
    };
    const step = () => {
      if (settled) return;
      frame = null;
      remaining -= 1;
      if (remaining <= 0) finish();
      else frame = scheduler.requestFrame(step);
    };
    timer = scheduler.setTimer(finish, Math.min(250, count * 50));
    frame = scheduler.requestFrame(step);
  });
};
