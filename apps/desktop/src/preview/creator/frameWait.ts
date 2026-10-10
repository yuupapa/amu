// @effect-diagnostics globalTimers:off - Pure scheduling helper for the guest preload.
export interface FrameWaitScheduler {
  readonly requestFrame: (callback: () => void) => number;
  readonly cancelFrame: (handle: number) => void;
  readonly setTimer: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
}

/**
 * Prefer rendered frames, but an occluded guest must not stall capture forever.
 * Resolves `true` when every frame was rendered, `false` when the fallback
 * timer ended the wait (nothing reached the screen meanwhile).
 */
export const waitForFrames = (count: number, scheduler: FrameWaitScheduler): Promise<boolean> => {
  if (count <= 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    let remaining = count;
    let settled = false;
    let frame: number | null = null;
    let timer: unknown;
    const finish = (rendered: boolean) => {
      if (settled) return;
      settled = true;
      if (frame !== null) scheduler.cancelFrame(frame);
      scheduler.clearTimer(timer);
      resolve(rendered);
    };
    const step = () => {
      if (settled) return;
      frame = null;
      remaining -= 1;
      if (remaining <= 0) finish(true);
      else frame = scheduler.requestFrame(step);
    };
    timer = scheduler.setTimer(() => finish(false), Math.min(250, count * 50));
    frame = scheduler.requestFrame(step);
  });
};
