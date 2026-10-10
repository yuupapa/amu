import { CREATOR_LIMITS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  clampToViewport,
  fitLongEdge,
  isUsableRect,
  normalizePoint,
  pinCropRect,
  planCreatorCapture,
  toPageRect,
} from "./creatorCapture.ts";

describe("toPageRect", () => {
  it("adds the iframe offset when the iframe is not scaled", () => {
    expect(
      toPageRect({
        compInIframe: { x: 10, y: 20, width: 960, height: 540 },
        iframeInPage: { x: 400, y: 100, width: 980, height: 560 },
        iframeScaleX: 1,
        iframeScaleY: 1,
      }),
    ).toEqual({ x: 410, y: 120, width: 960, height: 540 });
  });

  it("applies a CSS scale on the iframe before the offset", () => {
    expect(
      toPageRect({
        compInIframe: { x: 0, y: 0, width: 1920, height: 1080 },
        iframeInPage: { x: 300, y: 80, width: 960, height: 540 },
        iframeScaleX: 0.5,
        iframeScaleY: 0.5,
      }),
    ).toEqual({ x: 300, y: 80, width: 960, height: 540 });
  });
});

describe("normalizePoint", () => {
  const comp = { x: 300, y: 80, width: 960, height: 540 };
  it("maps a click inside the composition to 0..1", () => {
    expect(normalizePoint(comp, 780, 350)).toEqual({ x: 0.5, y: 0.5 });
  });
  it("rejects a click outside the composition", () => {
    expect(normalizePoint(comp, 100, 350)).toBeNull();
  });
});

describe("pinCropRect", () => {
  it("keeps the crop inside the composition near an edge", () => {
    const comp = { x: 300, y: 80, width: 960, height: 540 };
    expect(pinCropRect(comp, 0.98, 0.02, { width: 480, height: 270 })).toEqual({
      x: 780,
      y: 80,
      width: 480,
      height: 270,
    });
  });
});

describe("isUsableRect", () => {
  const viewport = { width: 1600, height: 1000 };
  it("accepts a visible rect under the area limit", () => {
    expect(isUsableRect({ x: 0, y: 0, width: 800, height: 450 }, viewport, 1600 * 1000)).toBe(true);
  });
  it("rejects NaN, negative size, off-screen and oversized rects", () => {
    expect(isUsableRect({ x: Number.NaN, y: 0, width: 10, height: 10 }, viewport, 1e9)).toBe(false);
    expect(isUsableRect({ x: 0, y: 0, width: -1, height: 10 }, viewport, 1e9)).toBe(false);
    expect(isUsableRect({ x: 2000, y: 0, width: 10, height: 10 }, viewport, 1e9)).toBe(false);
    expect(isUsableRect({ x: 0, y: 0, width: 1600, height: 1000 }, viewport, 1000)).toBe(false);
  });
});

describe("clampToViewport", () => {
  const viewport = { width: 1100, height: 688 };
  it("keeps the visible part of a crop that runs past the bottom edge", () => {
    expect(clampToViewport({ x: 15, y: 330, width: 730, height: 410 }, viewport)).toEqual({
      x: 15,
      y: 330,
      width: 730,
      height: 358,
    });
  });
  it("returns null when nothing of the crop is visible or the input is not a rect", () => {
    expect(clampToViewport({ x: 1200, y: 0, width: 50, height: 50 }, viewport)).toBeNull();
    expect(clampToViewport({ x: "a", y: 0, width: 50, height: 50 }, viewport)).toBeNull();
    expect(clampToViewport(null, viewport)).toBeNull();
  });
});

describe("planCreatorCapture", () => {
  const viewport = { width: 1000, height: 600 };

  it("passes a visible rect through at zoom 1", () => {
    expect(
      planCreatorCapture({
        rect: { x: 100, y: 50, width: 400, height: 300 },
        viewport,
        zoomFactor: 1,
      }),
    ).toEqual({ ok: true, rect: { x: 100, y: 50, width: 400, height: 300 } });
  });

  it("scales CSS pixels to the page's DIP rect at zoom 1.5", () => {
    expect(
      planCreatorCapture({
        rect: { x: 100, y: 50, width: 400, height: 300 },
        viewport,
        zoomFactor: 1.5,
      }),
    ).toEqual({ ok: true, rect: { x: 150, y: 75, width: 600, height: 450 } });
  });

  it("clamps an overflowing rect to the viewport before zooming", () => {
    expect(
      planCreatorCapture({
        rect: { x: 800, y: 500, width: 400, height: 300 },
        viewport,
        zoomFactor: 1.5,
      }),
    ).toEqual({ ok: true, rect: { x: 1200, y: 750, width: 300, height: 150 } });
  });

  it("refuses a rect with nothing visible", () => {
    expect(
      planCreatorCapture({
        rect: { x: 2000, y: 0, width: 10, height: 10 },
        viewport,
        zoomFactor: 1,
      }),
    ).toEqual({ ok: false, reason: "not_visible" });
  });

  it("refuses when the pin is outside the visible crop", () => {
    expect(
      planCreatorCapture({
        rect: { x: 800, y: 500, width: 400, height: 300 },
        pin: { x: 1100, y: 550 },
        viewport,
        zoomFactor: 1,
      }),
    ).toEqual({ ok: false, reason: "pin_not_visible" });
    expect(
      planCreatorCapture({
        rect: { x: 0, y: 0, width: 400, height: 300 },
        pin: { x: "a", y: 1 },
        viewport,
        zoomFactor: 1,
      }),
    ).toEqual({ ok: false, reason: "pin_not_visible" });
  });

  it("accepts a pin inside the visible crop", () => {
    expect(
      planCreatorCapture({
        rect: { x: 800, y: 500, width: 400, height: 300 },
        pin: { x: 900, y: 550 },
        viewport,
        zoomFactor: 1,
      }),
    ).toEqual({ ok: true, rect: { x: 800, y: 500, width: 200, height: 100 } });
  });

  it("refuses an unusable zoom factor or viewport", () => {
    expect(
      planCreatorCapture({
        rect: { x: 0, y: 0, width: 10, height: 10 },
        viewport,
        zoomFactor: 0,
      }),
    ).toEqual({ ok: false, reason: "bad_viewport" });
    expect(
      planCreatorCapture({
        rect: { x: 0, y: 0, width: 10, height: 10 },
        viewport: { width: Number.NaN, height: 10 },
        zoomFactor: 1,
      }),
    ).toEqual({ ok: false, reason: "bad_viewport" });
  });
});

describe("fitLongEdge", () => {
  it("keeps an image whose long edge is within the limit", () => {
    expect(fitLongEdge({ width: 1280, height: 720 })).toEqual({ width: 1280, height: 720 });
  });

  it("scales a Retina capture so the long edge is the shot limit", () => {
    expect(CREATOR_LIMITS.maxShotEdge).toBe(1280);
    expect(fitLongEdge({ width: 2560, height: 1440 })).toEqual({ width: 1280, height: 720 });
    expect(fitLongEdge({ width: 900, height: 3000 })).toEqual({ width: 384, height: 1280 });
  });

  it("never rounds the short edge down to zero", () => {
    expect(fitLongEdge({ width: 5000, height: 1 })).toEqual({ width: 1280, height: 1 });
  });
});
