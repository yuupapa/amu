import { describe, expect, it } from "vite-plus/test";

import {
  SPIKE_LIMITS,
  isUsableRect,
  normalizePoint,
  pinCropRect,
  toPageRect,
} from "./creatorSpikeGeometry.ts";

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

it("exposes the spec limits", () => {
  expect(SPIKE_LIMITS).toEqual({
    maxIpcBytes: 262144,
    maxComment: 2000,
    maxLabel: 200,
    maxPinsPerProposal: 30,
    maxShotLongEdge: 1280,
  });
});
