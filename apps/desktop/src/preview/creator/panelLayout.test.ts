import { describe, expect, it } from "vite-plus/test";

import {
  COMPACT_OVERLAP_RATIO,
  DEFAULT_HEADER_BOTTOM,
  PANEL_EDGE_MARGIN,
  layoutPanel,
  overlapRatio,
  panelWidth,
} from "./panelLayout.ts";

const viewport = { width: 1440, height: 900 };

describe("panelWidth", () => {
  it("is 26% of the viewport, clamped to 260..340 px", () => {
    expect(panelWidth(800)).toBe(260);
    expect(panelWidth(1200)).toBeCloseTo(312);
    expect(panelWidth(2000)).toBe(340);
  });
});

describe("overlapRatio", () => {
  const comp = { x: 100, y: 100, width: 1000, height: 560 };

  it("is the horizontal overlap as a share of the composition's width", () => {
    expect(overlapRatio({ x: 900, y: 50, width: 340, height: 800 }, comp)).toBeCloseTo(0.2);
    expect(overlapRatio({ x: 1100, y: 50, width: 340, height: 800 }, comp)).toBe(0);
  });

  it("is 0 when the boxes do not meet vertically or there is no composition", () => {
    expect(overlapRatio({ x: 900, y: 700, width: 340, height: 100 }, comp)).toBe(0);
    expect(overlapRatio({ x: 900, y: 50, width: 340, height: 800 }, null)).toBe(0);
    expect(overlapRatio({ x: 900, y: 50, width: 340, height: 800 }, { ...comp, width: 0 })).toBe(0);
  });
});

describe("layoutPanel", () => {
  it("docks to the right edge just below Studio's header", () => {
    const layout = layoutPanel({
      viewport,
      headerBottom: 40,
      composition: null,
      userExpanded: false,
    });
    expect(layout.right).toBe(PANEL_EDGE_MARGIN);
    expect(layout.width).toBe(340);
    expect(layout.top).toBeGreaterThanOrEqual(40);
    expect(layout.top).toBeLessThan(60);
    expect(layout.maxHeight).toBe(viewport.height - layout.top - PANEL_EDGE_MARGIN);
    expect(layout.compact).toBe(false);
    expect(layout.crowded).toBe(false);
  });

  it("falls back to Studio's usual header height when the header is not found", () => {
    const layout = layoutPanel({
      viewport,
      headerBottom: null,
      composition: null,
      userExpanded: false,
    });
    expect(layout.top).toBe(
      layoutPanel({
        viewport,
        headerBottom: DEFAULT_HEADER_BOTTOM,
        composition: null,
        userExpanded: false,
      }).top,
    );
  });

  it("stays full while the video has room beside the panel", () => {
    // Panel spans x 1088..1428; the composition ends at 1080.
    const layout = layoutPanel({
      viewport,
      headerBottom: 40,
      composition: { x: 200, y: 120, width: 880, height: 495 },
      userExpanded: false,
    });
    expect(layout.crowded).toBe(false);
    expect(layout.compact).toBe(false);
  });

  it("allows a small overlap up to 15% of the video's width", () => {
    // Overlap 1088..1200 = 112 px of 800 px = 14%.
    const layout = layoutPanel({
      viewport,
      headerBottom: 40,
      composition: { x: 400, y: 120, width: 800, height: 450 },
      userExpanded: false,
    });
    expect(layout.crowded).toBe(false);
    expect(layout.compact).toBe(false);
  });

  it("switches to the compact bar when the panel would cover more than 15% of the video", () => {
    // Overlap 1088..1300 = 212 px of 1000 px = 21%.
    const composition = { x: 300, y: 120, width: 1000, height: 562 };
    expect(
      overlapRatio({ x: 1088, y: 0, width: 340, height: viewport.height }, composition),
    ).toBeGreaterThan(COMPACT_OVERLAP_RATIO);
    const layout = layoutPanel({ viewport, headerBottom: 40, composition, userExpanded: false });
    expect(layout.crowded).toBe(true);
    expect(layout.compact).toBe(true);
  });

  it("shows the full list when the user expands the compact bar", () => {
    const layout = layoutPanel({
      viewport,
      headerBottom: 40,
      composition: { x: 300, y: 120, width: 1000, height: 562 },
      userExpanded: true,
    });
    expect(layout.crowded).toBe(true);
    expect(layout.compact).toBe(false);
  });

  it("ignores a composition that sits entirely below the panel's reach", () => {
    const layout = layoutPanel({
      viewport: { width: 1440, height: 400 },
      headerBottom: 40,
      composition: { x: 300, y: 420, width: 1000, height: 300 },
      userExpanded: false,
    });
    expect(layout.crowded).toBe(false);
  });
});
