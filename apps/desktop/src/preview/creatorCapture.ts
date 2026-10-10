/**
 * Pure geometry for Amu Creator screenshots. The guest reports rects in its own
 * CSS pixels; `capturePage` crops in the page's DIPs, which differ by the tab's
 * zoom factor. Everything here is untrusted-input safe: a rect is whatever the
 * guest page sent.
 */
import { CREATOR_LIMITS } from "@t3tools/contracts";

import type { Rect } from "./creatorGeometry.ts";

export { normalizePoint, pinCropRect, toPageRect, type Rect } from "./creatorGeometry.ts";

type Size = { readonly width: number; readonly height: number };

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export const isUsableRect = (rect: unknown, viewport: Size, maxArea: number): rect is Rect => {
  if (typeof rect !== "object" || rect === null) return false;
  const { x, y, width, height } = rect as Record<string, unknown>;
  if (![x, y, width, height].every(isFiniteNumber)) return false;
  const r = rect as Rect;
  if (r.width <= 0 || r.height <= 0 || r.width * r.height > maxArea) return false;
  return (
    r.x >= 0 && r.y >= 0 && r.x + r.width <= viewport.width && r.y + r.height <= viewport.height
  );
};

/** Intersects a crop with the visible viewport; null when nothing is visible or it is not a rect. */
export const clampToViewport = (rect: unknown, viewport: Size): Rect | null => {
  if (typeof rect !== "object" || rect === null) return null;
  const { x, y, width, height } = rect as Record<string, unknown>;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width)) return null;
  if (!isFiniteNumber(height)) return null;
  const left = Math.max(0, x);
  const top = Math.max(0, y);
  const right = Math.min(viewport.width, x + width);
  const bottom = Math.min(viewport.height, y + height);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
};

export type CreatorCapturePlan =
  | { readonly ok: true; readonly rect: Rect }
  | { readonly ok: false; readonly reason: "bad_viewport" | "not_visible" | "pin_not_visible" };

/**
 * Turns the guest's crop (CSS px) into the `capturePage` rect (DIP, whole
 * pixels): clamped to the visible viewport, then scaled by the tab's zoom.
 * A pin, when given, must sit inside the visible crop, or the shot would not
 * show what the comment points at.
 */
export const planCreatorCapture = (input: {
  readonly rect: unknown;
  readonly pin?: unknown;
  readonly viewport: Size;
  readonly zoomFactor: number;
}): CreatorCapturePlan => {
  const { viewport, zoomFactor } = input;
  if (
    !isFiniteNumber(zoomFactor) ||
    zoomFactor <= 0 ||
    !isFiniteNumber(viewport.width) ||
    !isFiniteNumber(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    return { ok: false, reason: "bad_viewport" };
  }
  const visible = clampToViewport(input.rect, viewport);
  if (!visible) return { ok: false, reason: "not_visible" };
  if (input.pin !== undefined && input.pin !== null) {
    const { x, y } = input.pin as Record<string, unknown>;
    if (
      !isFiniteNumber(x) ||
      !isFiniteNumber(y) ||
      x < visible.x ||
      y < visible.y ||
      x > visible.x + visible.width ||
      y > visible.y + visible.height
    ) {
      return { ok: false, reason: "pin_not_visible" };
    }
  }
  const left = Math.floor(visible.x * zoomFactor);
  const top = Math.floor(visible.y * zoomFactor);
  const right = Math.min(
    Math.ceil((visible.x + visible.width) * zoomFactor),
    Math.round(viewport.width * zoomFactor),
  );
  const bottom = Math.min(
    Math.ceil((visible.y + visible.height) * zoomFactor),
    Math.round(viewport.height * zoomFactor),
  );
  if (right <= left || bottom <= top) return { ok: false, reason: "not_visible" };
  return { ok: true, rect: { x: left, y: top, width: right - left, height: bottom - top } };
};

/** Output size with the long edge at most `maxEdge` (the stored shot limit), aspect kept. */
export const fitLongEdge = (size: Size, maxEdge: number = CREATOR_LIMITS.maxShotEdge): Size => {
  const longEdge = Math.max(size.width, size.height);
  if (longEdge <= maxEdge) return { width: size.width, height: size.height };
  const scale = maxEdge / longEdge;
  return size.width >= size.height
    ? { width: maxEdge, height: Math.max(1, Math.round(size.height * scale)) }
    : { width: Math.max(1, Math.round(size.width * scale)), height: maxEdge };
};
