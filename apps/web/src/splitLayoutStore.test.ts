import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";

import { countSplitPanes, createSplitLayout, findSplitPane } from "./splitLayout.logic";
import { useSplitLayoutStore } from "./splitLayoutStore";
import type { ThreadRouteTarget } from "./threadRoutes";

const thread = (id: string): ThreadRouteTarget => ({
  kind: "server",
  threadRef: scopeThreadRef("env-1" as never, ThreadId.make(id)),
});

function reset(target: ThreadRouteTarget) {
  useSplitLayoutStore.setState({ layout: createSplitLayout("pane-1", target), focusRequestId: 0 });
}

function focusedTarget() {
  const { layout } = useSplitLayoutStore.getState();
  return findSplitPane(layout, layout.focusedPaneId)?.target ?? null;
}

describe("syncRouteTarget", () => {
  afterEach(() => vi.useRealTimers());

  it("replaces the focused pane by default", () => {
    reset(thread("a"));
    useSplitLayoutStore.getState().syncRouteTarget(thread("b"));
    expect(countSplitPanes(useSplitLayoutStore.getState().layout)).toBe(1);
    expect(focusedTarget()).toEqual(thread("b"));
  });

  it("opens the next route beside the pane it was asked for, once", () => {
    reset(thread("a"));
    useSplitLayoutStore.getState().placeNextRouteTarget("pane-1", "right");
    useSplitLayoutStore.getState().syncRouteTarget(thread("b"));
    const { layout } = useSplitLayoutStore.getState();
    expect(countSplitPanes(layout)).toBe(2);
    expect(findSplitPane(layout, "pane-1")?.target).toEqual(thread("a"));
    expect(focusedTarget()).toEqual(thread("b"));

    useSplitLayoutStore.getState().syncRouteTarget(thread("c"));
    expect(countSplitPanes(useSplitLayoutStore.getState().layout)).toBe(2);
    expect(focusedTarget()).toEqual(thread("c"));
  });

  it("forgets a request whose thread never arrived", () => {
    vi.useFakeTimers();
    reset(thread("a"));
    useSplitLayoutStore.getState().placeNextRouteTarget("pane-1", "right");
    vi.advanceTimersByTime(10_000);
    useSplitLayoutStore.getState().syncRouteTarget(thread("b"));
    expect(countSplitPanes(useSplitLayoutStore.getState().layout)).toBe(1);
  });
});
