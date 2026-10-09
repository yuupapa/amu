export type Rect = { x: number; y: number; width: number; height: number };

export const SPIKE_LIMITS = {
  maxIpcBytes: 262144,
  maxComment: 2000,
  maxLabel: 200,
  maxPinsPerProposal: 30,
  maxShotLongEdge: 1280,
} as const;

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

export const pinCropRect = (
  comp: Rect,
  nx: number,
  ny: number,
  size: { width: number; height: number },
): Rect => {
  const width = Math.min(size.width, comp.width);
  const height = Math.min(size.height, comp.height);
  const cx = comp.x + nx * comp.width;
  const cy = comp.y + ny * comp.height;
  const x = Math.min(Math.max(cx - width / 2, comp.x), comp.x + comp.width - width);
  const y = Math.min(Math.max(cy - height / 2, comp.y), comp.y + comp.height - height);
  return { x, y, width, height };
};

export const isUsableRect = (
  rect: unknown,
  viewport: { width: number; height: number },
  maxArea: number,
): rect is Rect => {
  if (typeof rect !== "object" || rect === null) return false;
  const { x, y, width, height } = rect as Record<string, unknown>;
  if (![x, y, width, height].every((v) => typeof v === "number" && Number.isFinite(v)))
    return false;
  const r = rect as Rect;
  if (r.width <= 0 || r.height <= 0 || r.width * r.height > maxArea) return false;
  return (
    r.x >= 0 && r.y >= 0 && r.x + r.width <= viewport.width && r.y + r.height <= viewport.height
  );
};

/** Intersects a crop with the visible viewport; null when nothing is visible. */
export const clampToViewport = (
  rect: Record<string, unknown>,
  viewport: { width: number; height: number },
): Rect | null => {
  const { x, y, width, height } = rect;
  if (![x, y, width, height].every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  const r = rect as Rect;
  const left = Math.max(0, r.x);
  const top = Math.max(0, r.y);
  const right = Math.min(viewport.width, r.x + r.width);
  const bottom = Math.min(viewport.height, r.y + r.height);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
};
