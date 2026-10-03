import { describe, expect, it } from "vite-plus/test";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";

import {
  adjacentSplitPaneId,
  closeSplitPane,
  computeSplitGeometry,
  countSplitPanes,
  createSplitLayout,
  findSplitPaneByTarget,
  listSplitPanes,
  MAX_SPLIT_PANES,
  pruneSplitLayout,
  resolveSplitDropZone,
  setSplitPaneTarget,
  setSplitRatio,
  splitSplitPane,
  toggleSplitDirectionForPane,
  type SplitLayout,
} from "./splitLayout.logic";
import type { ThreadRouteTarget } from "./threadRoutes";

const thread = (id: string): ThreadRouteTarget => ({
  kind: "server",
  threadRef: scopeThreadRef("env-1" as never, ThreadId.make(id)),
});

function split(
  layout: SplitLayout,
  paneId: string,
  placement: "left" | "right" | "top" | "bottom",
  newId: string,
) {
  const next = splitSplitPane(layout, paneId, placement, { paneId: newId, target: thread(newId) });
  if (next === null) throw new Error("split failed");
  return next;
}

describe("splitLayout.logic", () => {
  it("splits to the right and focuses the new pane", () => {
    const layout = split(createSplitLayout("a", thread("a")), "a", "right", "b");
    expect(listSplitPanes(layout.root).map((pane) => pane.paneId)).toEqual(["a", "b"]);
    expect(layout.focusedPaneId).toBe("b");
    expect(layout.root).toMatchObject({ type: "split", direction: "row", ratio: 0.5 });
  });

  it("places left and top splits first", () => {
    const left = split(createSplitLayout("a", thread("a")), "a", "left", "b");
    expect(listSplitPanes(left.root).map((pane) => pane.paneId)).toEqual(["b", "a"]);
    const top = split(createSplitLayout("a", thread("a")), "a", "top", "b");
    expect(top.root).toMatchObject({ direction: "column" });
    expect(listSplitPanes(top.root).map((pane) => pane.paneId)).toEqual(["b", "a"]);
  });

  it("refuses to go past the pane limit", () => {
    let layout = createSplitLayout("p0", thread("p0"));
    for (let i = 1; i < MAX_SPLIT_PANES; i += 1) {
      layout = split(layout, `p${i - 1}`, "right", `p${i}`);
    }
    expect(countSplitPanes(layout)).toBe(MAX_SPLIT_PANES);
    expect(splitSplitPane(layout, "p0", "bottom", { paneId: "x", target: null })).toBeNull();
  });

  it("closing a pane lets its sibling take the space and moves focus", () => {
    let layout = split(createSplitLayout("a", thread("a")), "a", "right", "b");
    layout = split(layout, "b", "bottom", "c");
    const closed = closeSplitPane(layout, "c");
    expect(listSplitPanes(closed.root).map((pane) => pane.paneId)).toEqual(["a", "b"]);
    expect(closed.focusedPaneId).toBe("b");
    const last = closeSplitPane(closeSplitPane(closed, "b"), "a");
    expect(countSplitPanes(last)).toBe(1);
  });

  it("finds panes by thread and ignores no-op target changes", () => {
    const layout = split(createSplitLayout("a", thread("a")), "a", "right", "b");
    expect(findSplitPaneByTarget(layout, thread("b"))?.paneId).toBe("b");
    expect(setSplitPaneTarget(layout, "a", thread("a"))).toBe(layout);
    const changed = setSplitPaneTarget(layout, "a", thread("z"));
    expect(findSplitPaneByTarget(changed, thread("z"))?.paneId).toBe("a");
  });

  it("clamps ratios and toggles the direction of the holding split", () => {
    let layout = split(createSplitLayout("a", thread("a")), "a", "right", "b");
    layout = setSplitRatio(layout, [], 0.99);
    expect(layout.root).toMatchObject({ ratio: 0.85 });
    layout = toggleSplitDirectionForPane(layout, "b");
    expect(layout.root).toMatchObject({ direction: "column" });
  });

  it("cycles focus in reading order", () => {
    let layout = split(createSplitLayout("a", thread("a")), "a", "right", "b");
    layout = split(layout, "b", "bottom", "c");
    expect(adjacentSplitPaneId(layout, "c", 1)).toBe("a");
    expect(adjacentSplitPaneId(layout, "a", -1)).toBe("c");
  });

  it("prunes panes whose thread is gone but keeps one pane", () => {
    const layout = split(createSplitLayout("a", thread("a")), "a", "right", "b");
    const pruned = pruneSplitLayout(layout, (target) =>
      target.kind === "server" ? target.threadRef.threadId !== "b" : true,
    );
    expect(listSplitPanes(pruned.root).map((pane) => pane.paneId)).toEqual(["a"]);
    const empty = pruneSplitLayout(pruned, () => false);
    expect(listSplitPanes(empty.root)).toEqual([{ type: "pane", paneId: "a", target: null }]);
  });

  it("computes pane rects and dividers", () => {
    let layout = split(createSplitLayout("a", thread("a")), "a", "right", "b");
    layout = split(layout, "b", "bottom", "c");
    const geometry = computeSplitGeometry(layout.root);
    expect(geometry.panes.map((pane) => [pane.paneId, pane.rect])).toEqual([
      ["a", { left: 0, top: 0, width: 0.5, height: 1 }],
      ["b", { left: 0.5, top: 0, width: 0.5, height: 0.5 }],
      ["c", { left: 0.5, top: 0.5, width: 0.5, height: 0.5 }],
    ]);
    expect(geometry.dividers.map((divider) => divider.path)).toEqual([[], ["second"]]);
  });

  it("resolves drop zones by the nearest edge", () => {
    const rect = { left: 0, top: 0, width: 100, height: 100 };
    expect(resolveSplitDropZone(rect, { x: 5, y: 50 })).toBe("left");
    expect(resolveSplitDropZone(rect, { x: 95, y: 50 })).toBe("right");
    expect(resolveSplitDropZone(rect, { x: 50, y: 90 })).toBe("bottom");
    expect(resolveSplitDropZone(rect, { x: 50, y: 50 })).toBe("center");
  });
});
