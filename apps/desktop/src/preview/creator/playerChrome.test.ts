import { describe, expect, it } from "vite-plus/test";

import {
  hideVisibility,
  intersectRect,
  outermost,
  overlaysAbove,
  samplePoints,
} from "./playerChrome.ts";

type Node = { readonly name: string; readonly parent: Node | null };
const node = (name: string, parent: Node | null = null): Node => ({ name, parent });
const contains = (outer: Node, inner: Node): boolean => {
  for (let current: Node | null = inner; current !== null; current = current.parent) {
    if (current === outer) return true;
  }
  return false;
};

const body = node("body");
const stage = node("stage", body);
const playerHost = node("player-host", stage);
const player = node("player", playerHost);
const overlayLayer = node("overlay-layer", stage);
const toolbar = node("toolbar", overlayLayer);
const snapButton = node("snap", toolbar);
const panelHost = node("amu-panel");
const isPlayerBranch = (candidate: Node) => contains(candidate, player);

describe("overlaysAbove", () => {
  it("keeps what is painted above the player and nothing below it", () => {
    const stacks = [
      [snapButton, toolbar, overlayLayer, player, playerHost, stage, body],
      [player, playerHost, stage, body],
    ];
    expect(overlaysAbove(stacks, isPlayerBranch, () => false)).toEqual([
      snapButton,
      toolbar,
      overlayLayer,
    ]);
  });

  it("never returns the player, its ancestors or the overlay's own nodes", () => {
    const stacks = [[panelHost, playerHost, player, stage, body]];
    expect(overlaysAbove(stacks, isPlayerBranch, (candidate) => candidate === panelHost)).toEqual(
      [],
    );
  });

  it("returns nothing for a stack that never reaches the player's branch", () => {
    const floating = node("floating-popup");
    expect(overlaysAbove([[floating]], isPlayerBranch, () => false)).toEqual([]);
  });

  it("stops at an ancestor of the player when the player itself is not hit-testable", () => {
    expect(
      overlaysAbove([[toolbar, overlayLayer, stage, body]], isPlayerBranch, () => false),
    ).toEqual([toolbar, overlayLayer]);
  });
});

describe("outermost", () => {
  it("drops nodes already covered by a hidden ancestor", () => {
    expect(outermost([snapButton, toolbar, overlayLayer], contains)).toEqual([overlayLayer]);
    expect(outermost([snapButton, playerHost], contains)).toEqual([snapButton, playerHost]);
  });
});

describe("samplePoints", () => {
  it("covers the rect's corners and inside, never outside", () => {
    const rect = { x: 100, y: 50, width: 400, height: 200 };
    const points = samplePoints(rect);
    expect(points.length).toBeGreaterThanOrEqual(16);
    for (const point of points) {
      expect(point.x).toBeGreaterThan(rect.x);
      expect(point.x).toBeLessThan(rect.x + rect.width);
      expect(point.y).toBeGreaterThan(rect.y);
      expect(point.y).toBeLessThan(rect.y + rect.height);
    }
    // Studio's toolbar sits in the top-right corner.
    expect(points.some((p) => p.x > rect.x + rect.width - 20 && p.y < rect.y + 20)).toBe(true);
    // A bottom control bar would sit along the bottom edge.
    expect(points.some((p) => p.y > rect.y + rect.height - 20)).toBe(true);
  });

  it("gives no points for an empty rect", () => {
    expect(samplePoints({ x: 0, y: 0, width: 0, height: 10 })).toEqual([]);
  });
});

describe("hideVisibility", () => {
  const style = (value: string, priority = "") => {
    const props = new Map<string, { value: string; priority: string }>();
    if (value !== "") props.set("visibility", { value, priority });
    return {
      props,
      getPropertyValue: (name: string) => props.get(name)?.value ?? "",
      getPropertyPriority: (name: string) => props.get(name)?.priority ?? "",
      setProperty: (name: string, next: string, nextPriority = "") => {
        props.set(name, { value: next, priority: nextPriority });
      },
      removeProperty: (name: string) => {
        const before = props.get(name)?.value ?? "";
        props.delete(name);
        return before;
      },
    };
  };

  it("hides with visibility and restores every inline value exactly", () => {
    const plain = style("");
    const visible = style("visible");
    const important = style("collapse", "important");
    const restore = hideVisibility([plain, visible, important]);
    for (const target of [plain, visible, important]) {
      expect(target.props.get("visibility")).toEqual({ value: "hidden", priority: "important" });
    }
    restore();
    expect(plain.props.has("visibility")).toBe(false);
    expect(visible.props.get("visibility")).toEqual({ value: "visible", priority: "" });
    expect(important.props.get("visibility")).toEqual({ value: "collapse", priority: "important" });
  });

  it("restores only once", () => {
    const target = style("visible");
    const restore = hideVisibility([target]);
    restore();
    target.setProperty("visibility", "hidden");
    restore();
    expect(target.props.get("visibility")?.value).toBe("hidden");
  });
});

describe("intersectRect", () => {
  it("keeps only the part of the composition the preview surface shows", () => {
    // A zoomed-in composition runs past the bottom of the preview surface.
    const composition = { x: 100, y: 60, width: 1200, height: 900 };
    const surface = { x: 80, y: 50, width: 1000, height: 700 };
    expect(intersectRect(composition, surface)).toEqual({ x: 100, y: 60, width: 980, height: 690 });
  });

  it("is the composition itself when it fits, and null when nothing is shown", () => {
    const composition = { x: 100, y: 60, width: 400, height: 225 };
    expect(intersectRect(composition, { x: 0, y: 0, width: 1000, height: 700 })).toEqual(
      composition,
    );
    expect(intersectRect(composition, { x: 600, y: 0, width: 100, height: 100 })).toBeNull();
  });
});
