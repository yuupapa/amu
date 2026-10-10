/**
 * Pure parts of hiding Studio's controls over the preview while a shot is
 * taken (the DOM half is `hidePlayerChrome` in `studioDom.ts`).
 */
import type { Rect } from "../creatorGeometry.ts";

/**
 * From hit-test stacks (topmost first, as `elementsFromPoint` returns them),
 * the nodes painted above the player: everything before the first node of
 * the player's branch (the player or one of its ancestors). A stack that never
 * reaches the player gives nothing, since that point is not over the video.
 */
export const overlaysAbove = <T>(
  stacks: ReadonlyArray<ReadonlyArray<T>>,
  isPlayerBranch: (node: T) => boolean,
  isOurs: (node: T) => boolean,
): T[] => {
  const found: T[] = [];
  for (const stack of stacks) {
    const index = stack.findIndex(isPlayerBranch);
    if (index < 0) continue;
    for (const node of stack.slice(0, index)) {
      if (!isOurs(node) && !found.includes(node)) found.push(node);
    }
  }
  return found;
};

/** Drops nodes inside another listed node; hiding the ancestor hides them too. */
export const outermost = <T>(nodes: ReadonlyArray<T>, contains: (outer: T, inner: T) => boolean) =>
  nodes.filter((node) => !nodes.some((other) => other !== node && contains(other, node)));

const SAMPLE_FRACTIONS = [0.02, 0.2, 0.4, 0.6, 0.8, 0.98];

/** A 6 x 6 grid of points inside `rect`, including near each corner and edge. */
export const samplePoints = (rect: Rect): Array<{ x: number; y: number }> => {
  if (!(rect.width > 0 && rect.height > 0)) return [];
  return SAMPLE_FRACTIONS.flatMap((fy) =>
    SAMPLE_FRACTIONS.map((fx) => ({ x: rect.x + fx * rect.width, y: rect.y + fy * rect.height })),
  );
};

type InlineStyle = {
  getPropertyValue: (name: string) => string;
  getPropertyPriority: (name: string) => string;
  setProperty: (name: string, value: string, priority?: string) => void;
  removeProperty: (name: string) => string;
};

/**
 * Sets `visibility: hidden !important` inline and returns a restore that puts
 * back each previous inline value and priority (or removes it). Restores once.
 */
export const hideVisibility = (styles: ReadonlyArray<InlineStyle>): (() => void) => {
  const saved = styles.map((style) => ({
    style,
    value: style.getPropertyValue("visibility"),
    priority: style.getPropertyPriority("visibility"),
  }));
  for (const { style } of saved) style.setProperty("visibility", "hidden", "important");
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const { style, value, priority } of saved) {
      if (value === "") style.removeProperty("visibility");
      else style.setProperty("visibility", value, priority);
    }
  };
};

/** The overlap of two rects, or null when they do not overlap. */
export const intersectRect = (a: Rect, b: Rect): Rect | null => {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x;
  const height = Math.min(a.y + a.height, b.y + b.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
};
