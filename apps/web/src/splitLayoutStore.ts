/**
 * Chat split view layout. The URL keeps pointing at the focused pane's
 * thread, so everything that reads the route keeps acting on the pane the
 * user is working in; the other panes are only known to this store.
 */
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";
import { randomUUID } from "./lib/utils";
import {
  adjacentSplitPaneId,
  closeSplitPane,
  countSplitPanes,
  createSplitLayout,
  findSplitPane,
  findSplitPaneByTarget,
  focusSplitPane,
  listSplitPanes,
  pruneSplitLayout,
  setSplitPaneTarget,
  setSplitRatio,
  splitSplitPane,
  threadRouteTargetKey,
  toggleSplitDirectionForPane,
  type SplitLayout,
  type SplitPath,
  type SplitPlacement,
} from "./splitLayout.logic";
import type { ThreadRouteTarget } from "./threadRoutes";

export const SPLIT_LAYOUT_STORAGE_KEY = "amu:split-layout:v1";

function newPaneId(): string {
  return randomUUID();
}

interface SplitLayoutStore {
  layout: SplitLayout;
  /** Bumped when focus moves to a pane without a click, so it can take DOM focus. */
  focusRequestId: number;
  /**
   * Opens `target` next to `basePaneId` (the focused pane by default). A
   * thread already on screen is just focused. Returns false when full.
   */
  openInSplit: (
    target: ThreadRouteTarget,
    placement: SplitPlacement,
    basePaneId?: string,
  ) => boolean;
  /**
   * Drops `target` onto `paneId`: `center` swaps that pane's thread, an edge
   * splits it. A thread already on screen moves instead of being copied.
   * Returns false when the layout is full.
   */
  placeThread: (
    target: ThreadRouteTarget,
    paneId: string,
    zone: SplitPlacement | "center",
  ) => boolean;
  /** Adds an empty pane next to the focused one. Returns false when full. */
  splitFocusedPane: (placement: SplitPlacement) => boolean;
  /** Makes the focused pane follow the route (sidebar clicks, new threads). */
  syncRouteTarget: (target: ThreadRouteTarget) => void;
  setPaneTarget: (paneId: string, target: ThreadRouteTarget | null) => void;
  focusPane: (paneId: string) => void;
  focusAdjacentPane: (delta: number) => void;
  closePane: (paneId: string) => void;
  setRatio: (path: SplitPath, ratio: number) => void;
  toggleDirection: (paneId: string) => void;
  prune: (isTargetAlive: (target: ThreadRouteTarget) => boolean) => void;
}

export const useSplitLayoutStore = create<SplitLayoutStore>()(
  persist(
    (set, get) => ({
      layout: createSplitLayout(newPaneId(), null),
      focusRequestId: 0,
      openInSplit: (target, placement, basePaneId) => {
        const { layout } = get();
        const existing = findSplitPaneByTarget(layout, target);
        if (existing) {
          set({
            layout: focusSplitPane(layout, existing.paneId),
            focusRequestId: get().focusRequestId + 1,
          });
          return true;
        }
        const next = splitSplitPane(layout, basePaneId ?? layout.focusedPaneId, placement, {
          paneId: newPaneId(),
          target,
        });
        if (next === null) return false;
        set({ layout: next, focusRequestId: get().focusRequestId + 1 });
        return true;
      },
      placeThread: (target, paneId, zone) => {
        let { layout } = get();
        const bump = get().focusRequestId + 1;
        const existing = findSplitPaneByTarget(layout, target);
        if (existing && (zone === "center" || existing.paneId === paneId)) {
          set({ layout: focusSplitPane(layout, existing.paneId), focusRequestId: bump });
          return true;
        }
        if (zone === "center") {
          layout = focusSplitPane(setSplitPaneTarget(layout, paneId, target), paneId);
          set({ layout, focusRequestId: bump });
          return true;
        }
        if (existing) layout = closeSplitPane(layout, existing.paneId);
        const next = splitSplitPane(layout, paneId, zone, { paneId: newPaneId(), target });
        if (next === null) return false;
        set({ layout: next, focusRequestId: bump });
        return true;
      },
      splitFocusedPane: (placement) => {
        const { layout } = get();
        const next = splitSplitPane(layout, layout.focusedPaneId, placement, {
          paneId: newPaneId(),
          target: null,
        });
        if (next === null) return false;
        set({ layout: next });
        return true;
      },
      syncRouteTarget: (target) => {
        const { layout } = get();
        const existing = findSplitPaneByTarget(layout, target);
        if (existing) {
          if (existing.paneId !== layout.focusedPaneId) {
            set({
              layout: focusSplitPane(layout, existing.paneId),
              focusRequestId: get().focusRequestId + 1,
            });
          }
          return;
        }
        set({ layout: setSplitPaneTarget(layout, layout.focusedPaneId, target) });
      },
      setPaneTarget: (paneId, target) => {
        const { layout } = get();
        const duplicate = findSplitPaneByTarget(layout, target);
        // A draft promoted in one pane may already be shown elsewhere; keep one copy.
        if (duplicate && duplicate.paneId !== paneId) {
          set({ layout: closeSplitPane(layout, paneId) });
          return;
        }
        set({ layout: setSplitPaneTarget(layout, paneId, target) });
      },
      focusPane: (paneId) => set({ layout: focusSplitPane(get().layout, paneId) }),
      focusAdjacentPane: (delta) => {
        const { layout } = get();
        set({
          layout: focusSplitPane(layout, adjacentSplitPaneId(layout, layout.focusedPaneId, delta)),
          focusRequestId: get().focusRequestId + 1,
        });
      },
      closePane: (paneId) => set({ layout: closeSplitPane(get().layout, paneId) }),
      setRatio: (path, ratio) => set({ layout: setSplitRatio(get().layout, path, ratio) }),
      toggleDirection: (paneId) =>
        set({ layout: toggleSplitDirectionForPane(get().layout, paneId) }),
      prune: (isTargetAlive) => set({ layout: pruneSplitLayout(get().layout, isTargetAlive) }),
    }),
    {
      name: SPLIT_LAYOUT_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ layout: state.layout }),
      merge: (persisted, current) => {
        const layout = (persisted as { layout?: SplitLayout } | undefined)?.layout;
        if (!layout || !isValidLayout(layout)) return current;
        return { ...current, layout };
      },
    },
  ),
);

function isValidLayout(layout: SplitLayout): boolean {
  try {
    const panes = listSplitPanes(layout.root);
    const keys = panes.map((pane) => threadRouteTargetKey(pane.target)).filter(Boolean);
    return (
      panes.length > 0 &&
      new Set(panes.map((pane) => pane.paneId)).size === panes.length &&
      panes.length <= 4 &&
      new Set(keys).size === keys.length &&
      findSplitPane(layout, layout.focusedPaneId) !== null
    );
  } catch {
    return false;
  }
}

export function selectIsSplit(state: SplitLayoutStore): boolean {
  return countSplitPanes(state.layout) > 1;
}

/** Thread keys of every pane on screen, for "is this thread visible" checks. */
export function selectVisibleThreadTargetKeys(state: SplitLayoutStore): string {
  return listSplitPanes(state.layout.root)
    .map((pane) => threadRouteTargetKey(pane.target))
    .filter((key): key is string => key !== null)
    .join("\n");
}

/** Whether a thread is on screen in some pane (the route only names the focused one). */
export function isThreadShownInSplitPane(threadRef: ScopedThreadRef): boolean {
  const { layout } = useSplitLayoutStore.getState();
  if (countSplitPanes(layout) < 2) return false;
  return (
    findSplitPaneByTarget(layout, {
      kind: "server",
      threadRef,
    }) !== null
  );
}
