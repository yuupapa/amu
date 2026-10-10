/**
 * The guest half of the Creator capture (see `CreatorProtocol.ts`), as a state
 * machine with the clock and every DOM step injected.
 *
 * request -> main answers `capture-begin` -> pause, seek to the comment time,
 * wait for the seek and two frames, hide the overlay, re-measure, send
 * `capture-ready` -> main captures and answers `capture-done` -> show the
 * overlay again. When no frame was rendered after hiding (rendering suspended,
 * e.g. an occluded window), the capture is given up: main would copy the last
 * frame shown, which still has the panel over the video. Controls stay frozen from request to done. The client gives up
 * on its own after `CAPTURE_SELF_TIMEOUT_MS` (main gives up after 5 s), and a
 * begin or done for another request id is ignored.
 */
import { pinCropRect, type Rect } from "../creatorGeometry.ts";
import { intersectRect } from "./playerChrome.ts";

export type Point = { readonly x: number; readonly y: number };

export type CaptureSpec = {
  readonly requestId: string;
  readonly purpose: "draft" | "place";
  readonly timeSec: number;
  readonly commentId: string | null;
  /** The `CreatorPlace` sent along for a place capture. */
  readonly place: unknown;
  /** Normalized point inside the composition for a place capture. */
  readonly pin: Point | null;
};

export type CaptureMeasure = { readonly rect: Rect; readonly pin?: Point };

/**
 * A place shot: half the composition around the place, from its normalized
 * point against the composition as it is on screen now (a stored place is
 * re-pinned the same way), cut to the part the preview shows. The pin stays
 * on the place even when that part is cut off.
 */
export const measurePlaceCapture = (
  composition: Rect,
  visible: Rect,
  place: Point,
): { readonly rect: Rect; readonly pin: Point } => {
  const crop = pinCropRect(composition, place.x, place.y, {
    width: composition.width / 2,
    height: composition.height / 2,
  });
  return {
    rect: intersectRect(crop, visible) ?? crop,
    pin: {
      x: composition.x + place.x * composition.width,
      y: composition.y + place.y * composition.height,
    },
  };
};

export type CaptureDeps = {
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  readonly sendRequest: (spec: CaptureSpec) => void;
  readonly sendReady: (input: { requestId: string; rect: Rect; pin?: Point }) => void;
  readonly pause: () => void;
  /** Resolves once the player shows `timeSec` (or gave up waiting). */
  readonly seek: (timeSec: number) => Promise<void>;
  /** `true` when the frames were rendered, `false` when only the fallback timer ended the wait. */
  readonly waitFrames: (count: number) => Promise<boolean>;
  readonly hide: () => void;
  readonly show: () => void;
  /** The crop (and pin) in viewport CSS px, or `null` when the composition is not on screen. */
  readonly measure: (spec: CaptureSpec) => CaptureMeasure | null;
  /** `began` is false when main refused the request without a begin (busy or the 1 s gate). */
  readonly onSettled: (spec: CaptureSpec, ok: boolean, began: boolean) => void;
};

export const CAPTURE_SELF_TIMEOUT_MS = 6_000;

type Current = {
  readonly spec: CaptureSpec;
  phase: "requested" | "preparing" | "ready";
  hidden: boolean;
  timer: unknown;
};

export const createCaptureClient = (deps: CaptureDeps) => {
  let current: Current | null = null;

  const finish = (ok: boolean) => {
    const settled = current;
    if (settled === null) return;
    current = null;
    deps.clearTimer(settled.timer);
    if (settled.hidden) deps.show();
    deps.onSettled(settled.spec, ok, settled.phase !== "requested");
  };
  const arm = (entry: Current) => {
    deps.clearTimer(entry.timer);
    entry.timer = deps.setTimer(() => {
      if (current === entry) finish(false);
    }, CAPTURE_SELF_TIMEOUT_MS);
  };

  return {
    /** A capture is requested or running. */
    busy: () => current !== null,
    /** Play, seek and Studio keys must be ignored. */
    frozen: () => current !== null,
    /** Sends the request; `false` while another capture is under way. */
    request: (spec: CaptureSpec): boolean => {
      if (current !== null) return false;
      const entry: Current = { spec, phase: "requested", hidden: false, timer: null };
      current = entry;
      arm(entry);
      deps.sendRequest(spec);
      return true;
    },
    begin: async (requestId: string): Promise<void> => {
      const entry = current;
      if (entry === null || entry.spec.requestId !== requestId || entry.phase !== "requested") {
        return;
      }
      entry.phase = "preparing";
      arm(entry);
      deps.pause();
      await deps.seek(entry.spec.timeSec);
      if (current !== entry) return;
      await deps.waitFrames(2);
      if (current !== entry) return;
      deps.hide();
      entry.hidden = true;
      // Let the hidden overlay reach the screen before main captures.
      const rendered = await deps.waitFrames(1);
      if (current !== entry) return;
      if (!rendered) {
        finish(false);
        return;
      }
      const measured = deps.measure(entry.spec);
      if (measured === null) {
        finish(false);
        return;
      }
      entry.phase = "ready";
      deps.sendReady({
        requestId,
        rect: measured.rect,
        ...(measured.pin === undefined ? {} : { pin: measured.pin }),
      });
    },
    done: (requestId: string, ok: boolean) => {
      if (current?.spec.requestId !== requestId) return;
      finish(ok);
    },
    /** Teardown: restores the overlay and drops the request. */
    cancel: () => finish(false),
  };
};

export type CaptureClient = ReturnType<typeof createCaptureClient>;
