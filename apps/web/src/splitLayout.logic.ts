/**
 * Pure helpers for the chat split view: a binary tree whose leaves are panes
 * (each showing one thread) and whose branches split their area in two.
 * The store and the workspace component only call these, so every layout
 * rule lives here and is covered by `splitLayout.logic.test.ts`.
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";

import type { ThreadRouteTarget } from "./threadRoutes";

export const MAX_SPLIT_PANES = 4;
export const MIN_SPLIT_RATIO = 0.15;
export const MAX_SPLIT_RATIO = 0.85;

/** `row` lays the two halves side by side, `column` stacks them. */
export type SplitDirection = "row" | "column";
export type SplitPlacement = "left" | "right" | "top" | "bottom";
export type SplitBranchKey = "first" | "second";
export type SplitPath = readonly SplitBranchKey[];

export interface SplitPaneLeaf {
  type: "pane";
  paneId: string;
  target: ThreadRouteTarget | null;
}

export interface SplitBranchNode {
  type: "split";
  direction: SplitDirection;
  /** Share of the branch's area given to `first`. */
  ratio: number;
  first: SplitNode;
  second: SplitNode;
}

export type SplitNode = SplitPaneLeaf | SplitBranchNode;

export interface SplitLayout {
  root: SplitNode;
  focusedPaneId: string;
}

export interface SplitRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface SplitPaneRect {
  paneId: string;
  target: ThreadRouteTarget | null;
  rect: SplitRect;
  /** How the split holding this pane is arranged; null for a lone pane. */
  parentDirection: SplitDirection | null;
}

export interface SplitDividerRect {
  path: SplitPath;
  direction: SplitDirection;
  /** The branch's whole area, used to turn pointer movement into a ratio. */
  area: SplitRect;
  ratio: number;
}

export function createSplitLayout(paneId: string, target: ThreadRouteTarget | null): SplitLayout {
  return { root: { type: "pane", paneId, target }, focusedPaneId: paneId };
}

export function threadRouteTargetKey(target: ThreadRouteTarget | null): string | null {
  if (target === null) return null;
  return target.kind === "server"
    ? `server:${scopedThreadKey(target.threadRef)}`
    : `draft:${target.draftId}`;
}

export function listSplitPanes(node: SplitNode): SplitPaneLeaf[] {
  return node.type === "pane"
    ? [node]
    : [...listSplitPanes(node.first), ...listSplitPanes(node.second)];
}

export function countSplitPanes(layout: SplitLayout): number {
  return listSplitPanes(layout.root).length;
}

export function findSplitPane(layout: SplitLayout, paneId: string): SplitPaneLeaf | null {
  return listSplitPanes(layout.root).find((pane) => pane.paneId === paneId) ?? null;
}

export function findSplitPaneByTarget(
  layout: SplitLayout,
  target: ThreadRouteTarget | null,
): SplitPaneLeaf | null {
  const key = threadRouteTargetKey(target);
  if (key === null) return null;
  return (
    listSplitPanes(layout.root).find((pane) => threadRouteTargetKey(pane.target) === key) ?? null
  );
}

export function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
}

function mapPane(
  node: SplitNode,
  paneId: string,
  fn: (pane: SplitPaneLeaf) => SplitNode,
): SplitNode {
  if (node.type === "pane") {
    return node.paneId === paneId ? fn(node) : node;
  }
  const first = mapPane(node.first, paneId, fn);
  const second = mapPane(node.second, paneId, fn);
  return first === node.first && second === node.second ? node : { ...node, first, second };
}

/**
 * Puts `newPane` next to `paneId` on the given side. Returns null when the
 * layout is full or the pane does not exist, so callers can tell the user.
 */
export function splitSplitPane(
  layout: SplitLayout,
  paneId: string,
  placement: SplitPlacement,
  newPane: { paneId: string; target: ThreadRouteTarget | null },
): SplitLayout | null {
  if (countSplitPanes(layout) >= MAX_SPLIT_PANES) return null;
  if (findSplitPane(layout, paneId) === null) return null;
  const leaf: SplitPaneLeaf = { type: "pane", paneId: newPane.paneId, target: newPane.target };
  const direction: SplitDirection =
    placement === "left" || placement === "right" ? "row" : "column";
  const newFirst = placement === "left" || placement === "top";
  const root = mapPane(layout.root, paneId, (existing) => ({
    type: "split",
    direction,
    ratio: 0.5,
    first: newFirst ? leaf : existing,
    second: newFirst ? existing : leaf,
  }));
  return { root, focusedPaneId: newPane.paneId };
}

function removePane(node: SplitNode, paneId: string): SplitNode | null {
  if (node.type === "pane") {
    return node.paneId === paneId ? null : node;
  }
  const first = removePane(node.first, paneId);
  const second = removePane(node.second, paneId);
  if (first === null) return second;
  if (second === null) return first;
  return first === node.first && second === node.second ? node : { ...node, first, second };
}

/** Closes a pane; its sibling takes over the freed space. The last pane stays. */
export function closeSplitPane(layout: SplitLayout, paneId: string): SplitLayout {
  const panes = listSplitPanes(layout.root);
  const index = panes.findIndex((pane) => pane.paneId === paneId);
  if (index === -1 || panes.length <= 1) return layout;
  const root = removePane(layout.root, paneId);
  if (root === null) return layout;
  if (layout.focusedPaneId !== paneId) return { root, focusedPaneId: layout.focusedPaneId };
  const remaining = listSplitPanes(root);
  const nextFocus = remaining[Math.min(index, remaining.length - 1)] ?? remaining[0]!;
  return { root, focusedPaneId: nextFocus.paneId };
}

export function setSplitPaneTarget(
  layout: SplitLayout,
  paneId: string,
  target: ThreadRouteTarget | null,
): SplitLayout {
  const pane = findSplitPane(layout, paneId);
  if (pane === null || threadRouteTargetKey(pane.target) === threadRouteTargetKey(target)) {
    return layout;
  }
  return { ...layout, root: mapPane(layout.root, paneId, (leaf) => ({ ...leaf, target })) };
}

export function focusSplitPane(layout: SplitLayout, paneId: string): SplitLayout {
  if (layout.focusedPaneId === paneId || findSplitPane(layout, paneId) === null) return layout;
  return { ...layout, focusedPaneId: paneId };
}

/** The pane `delta` steps after `paneId` in reading order, wrapping around. */
export function adjacentSplitPaneId(layout: SplitLayout, paneId: string, delta: number): string {
  const panes = listSplitPanes(layout.root);
  const index = panes.findIndex((pane) => pane.paneId === paneId);
  if (index === -1 || panes.length === 0) return layout.focusedPaneId;
  const next = (((index + delta) % panes.length) + panes.length) % panes.length;
  return panes[next]!.paneId;
}

function updateBranchAtPath(
  node: SplitNode,
  path: SplitPath,
  fn: (branch: SplitBranchNode) => SplitBranchNode,
): SplitNode {
  if (node.type === "pane") return node;
  if (path.length === 0) return fn(node);
  const [head, ...rest] = path;
  const child = node[head!];
  const updated = updateBranchAtPath(child, rest, fn);
  return updated === child ? node : { ...node, [head!]: updated };
}

export function setSplitRatio(layout: SplitLayout, path: SplitPath, ratio: number): SplitLayout {
  const nextRatio = clampSplitRatio(ratio);
  const root = updateBranchAtPath(layout.root, path, (branch) =>
    branch.ratio === nextRatio ? branch : { ...branch, ratio: nextRatio },
  );
  return root === layout.root ? layout : { ...layout, root };
}

function findParentPath(node: SplitNode, paneId: string, path: SplitBranchKey[]): SplitPath | null {
  if (node.type === "pane") return null;
  for (const key of ["first", "second"] as const) {
    const child = node[key];
    if (child.type === "pane" && child.paneId === paneId) return path;
    const found = findParentPath(child, paneId, [...path, key]);
    if (found) return found;
  }
  return null;
}

/** Flips the split that directly holds `paneId` between side by side and stacked. */
export function toggleSplitDirectionForPane(layout: SplitLayout, paneId: string): SplitLayout {
  const path = findParentPath(layout.root, paneId, []);
  if (path === null) return layout;
  const root = updateBranchAtPath(layout.root, path, (branch) => ({
    ...branch,
    direction: branch.direction === "row" ? "column" : "row",
  }));
  return { ...layout, root };
}

/**
 * Drops panes whose thread no longer exists. A pane with no target is kept
 * only when it is the last one, so the layout never becomes empty.
 */
export function pruneSplitLayout(
  layout: SplitLayout,
  isTargetAlive: (target: ThreadRouteTarget) => boolean,
): SplitLayout {
  let next = layout;
  for (const pane of listSplitPanes(layout.root)) {
    if (pane.target !== null && !isTargetAlive(pane.target)) {
      const closed = closeSplitPane(next, pane.paneId);
      next = closed === next ? setSplitPaneTarget(next, pane.paneId, null) : closed;
    }
  }
  return next;
}

/** Flattens the tree into absolute rects (0–1 fractions) for rendering. */
export function computeSplitGeometry(root: SplitNode): {
  panes: SplitPaneRect[];
  dividers: SplitDividerRect[];
} {
  const panes: SplitPaneRect[] = [];
  const dividers: SplitDividerRect[] = [];
  const walk = (
    node: SplitNode,
    rect: SplitRect,
    path: SplitBranchKey[],
    parentDirection: SplitDirection | null = null,
  ) => {
    if (node.type === "pane") {
      panes.push({ paneId: node.paneId, target: node.target, rect, parentDirection });
      return;
    }
    const ratio = clampSplitRatio(node.ratio);
    dividers.push({ path, direction: node.direction, area: rect, ratio });
    if (node.direction === "row") {
      const firstWidth = rect.width * ratio;
      walk(node.first, { ...rect, width: firstWidth }, [...path, "first"], "row");
      walk(
        node.second,
        { ...rect, left: rect.left + firstWidth, width: rect.width - firstWidth },
        [...path, "second"],
        "row",
      );
    } else {
      const firstHeight = rect.height * ratio;
      walk(node.first, { ...rect, height: firstHeight }, [...path, "first"], "column");
      walk(
        node.second,
        { ...rect, top: rect.top + firstHeight, height: rect.height - firstHeight },
        [...path, "second"],
        "column",
      );
    }
  };
  walk(root, { left: 0, top: 0, width: 1, height: 1 }, []);
  return { panes, dividers };
}

/** Which edge of a pane a pointer is over, or `center` to replace its thread. */
export function resolveSplitDropZone(
  rect: { left: number; top: number; width: number; height: number },
  point: { x: number; y: number },
): SplitPlacement | "center" {
  const x = (point.x - rect.left) / rect.width;
  const y = (point.y - rect.top) / rect.height;
  const edges: Array<[SplitPlacement, number]> = [
    ["left", x],
    ["right", 1 - x],
    ["top", y],
    ["bottom", 1 - y],
  ];
  const [placement, distance] = edges.reduce((best, edge) => (edge[1] < best[1] ? edge : best));
  return distance < 0.25 ? placement : "center";
}
