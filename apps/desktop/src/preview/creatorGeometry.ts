/**
 * Pure geometry shared by the Creator capture in main and the overlay in the
 * guest preload. No imports: the sandboxed guest preload bundles this file and
 * cannot load packages at runtime.
 */
export type Rect = { x: number; y: number; width: number; height: number };
type Size = { readonly width: number; readonly height: number };

export const toPageRect = (input: {
  compInIframe: Rect;
  iframeInPage: Rect;
  iframeScaleX: number;
  iframeScaleY: number;
}): Rect => ({
  x: input.iframeInPage.x + input.compInIframe.x * input.iframeScaleX,
  y: input.iframeInPage.y + input.compInIframe.y * input.iframeScaleY,
  width: input.compInIframe.width * input.iframeScaleX,
  height: input.compInIframe.height * input.iframeScaleY,
});

export const normalizePoint = (
  comp: Rect,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null => {
  const x = (clientX - comp.x) / comp.width;
  const y = (clientY - comp.y) / comp.height;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
};

export const pinCropRect = (comp: Rect, nx: number, ny: number, size: Size): Rect => {
  const width = Math.min(size.width, comp.width);
  const height = Math.min(size.height, comp.height);
  const cx = comp.x + nx * comp.width;
  const cy = comp.y + ny * comp.height;
  const x = Math.min(Math.max(cx - width / 2, comp.x), comp.x + comp.width - width);
  const y = Math.min(Math.max(cy - height / 2, comp.y), comp.y + comp.height - height);
  return { x, y, width, height };
};
