/**
 * Where the 修正コメント panel sits: docked to the right edge of Studio, just
 * below its header, 26% of the viewport wide (260..340 px). When the full panel
 * would cover more than 15% of the video's width, it shrinks to the compact bar
 * unless the user expanded it. The panel's reach is taken as its whole possible
 * height, so adding comments never makes it grow over the video.
 *
 * While the user picks a place, the panel is only the place strip (the hint and
 * 「取り消し」), put where it leaves the video clickable (`layoutPlaceStrip`).
 * The panel's own mode (full, compact, collapsed) is kept, so it comes back
 * exactly as it was.
 */
import type { Rect } from "../creatorGeometry.ts";

export const PANEL_MIN_WIDTH = 260;
export const PANEL_MAX_WIDTH = 340;
export const PANEL_VIEWPORT_SHARE = 0.26;
export const PANEL_EDGE_MARGIN = 12;
/** Studio 0.8.143's header is `h-10`. */
export const DEFAULT_HEADER_BOTTOM = 40;
const HEADER_GAP = 8;
export const COMPACT_OVERLAP_RATIO = 0.15;
/** Planned height of the place strip: two lines of the hint beside its button. */
export const PLACE_STRIP_HEIGHT = 64;
/** Wide enough for the hint on one or two lines. */
export const PLACE_STRIP_MAX_WIDTH = 520;

export const panelWidth = (viewportWidth: number): number =>
  Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, viewportWidth * PANEL_VIEWPORT_SHARE));

/** How much of the composition's width the panel covers (0 when they do not meet). */
export const overlapRatio = (panel: Rect, composition: Rect | null): number => {
  if (composition === null || composition.width <= 0 || composition.height <= 0) return 0;
  const width =
    Math.min(panel.x + panel.width, composition.x + composition.width) -
    Math.max(panel.x, composition.x);
  const height =
    Math.min(panel.y + panel.height, composition.y + composition.height) -
    Math.max(panel.y, composition.y);
  if (width <= 0 || height <= 0) return 0;
  return width / composition.width;
};

export type PanelLayoutInput = {
  readonly viewport: { readonly width: number; readonly height: number };
  /** Bottom of Studio's header in viewport px, or null when it was not found. */
  readonly headerBottom: number | null;
  /** The composition on screen, or null when it is not measurable. */
  readonly composition: Rect | null;
  readonly userExpanded: boolean;
  /** The user is picking a place on the video. */
  readonly placing?: boolean;
  /** The strip's measured height, once it has been shown. */
  readonly stripHeight?: number;
};

export type PanelLayout = {
  readonly top: number;
  readonly right: number;
  readonly width: number;
  readonly maxHeight: number;
  /** The full panel would cover too much of the video. */
  readonly crowded: boolean;
  /** Show the compact bar: crowded and not expanded by the user. */
  readonly compact: boolean;
  /** While placing: where the place strip goes instead of the panel. */
  readonly strip: PlaceStrip | null;
};

export type PlaceStrip = {
  readonly top: number;
  readonly right: number;
  readonly width: number;
  /** above / beside / below the video, or the top-right corner when none has room. */
  readonly where: "above" | "beside" | "below" | "corner";
  /** Only in the corner: the strip covers part of the video. */
  readonly overlaps: boolean;
};

export type PlaceStripInput = Pick<
  PanelLayoutInput,
  "viewport" | "headerBottom" | "composition" | "stripHeight"
>;

/**
 * Where the place strip goes so the whole video stays clickable: above it
 * (docked under the header), beside it at the top right, or below it. When the
 * video fills the guest, the strip takes the top-right corner at its narrowest.
 */
export const layoutPlaceStrip = (input: PlaceStripInput): PlaceStrip => {
  const { viewport, composition } = input;
  const top = (input.headerBottom ?? DEFAULT_HEADER_BOTTOM) + HEADER_GAP;
  const height = Math.max(PLACE_STRIP_HEIGHT, input.stripHeight ?? 0);
  const fullWidth = Math.max(
    0,
    Math.min(PLACE_STRIP_MAX_WIDTH, viewport.width - 2 * PANEL_EDGE_MARGIN),
  );
  const corner = (overlaps: boolean): PlaceStrip => ({
    top,
    right: PANEL_EDGE_MARGIN,
    width: Math.min(fullWidth, panelWidth(viewport.width)),
    where: "corner",
    overlaps,
  });
  if (composition === null || composition.width <= 0 || composition.height <= 0) {
    return corner(false);
  }
  const at = (where: PlaceStrip["where"], stripTop: number, width: number): PlaceStrip => ({
    top: stripTop,
    right: PANEL_EDGE_MARGIN,
    width,
    where,
    overlaps: false,
  });
  if (composition.y - HEADER_GAP - top >= height) return at("above", top, fullWidth);
  const besideWidth =
    viewport.width - PANEL_EDGE_MARGIN - (composition.x + composition.width) - HEADER_GAP;
  if (besideWidth >= PANEL_MIN_WIDTH) {
    return at("beside", top, Math.min(fullWidth, besideWidth));
  }
  const below = composition.y + composition.height + HEADER_GAP;
  if (viewport.height - PANEL_EDGE_MARGIN - below >= height) {
    return at("below", below, fullWidth);
  }
  return corner(true);
};

export const layoutPanel = (input: PanelLayoutInput): PanelLayout => {
  const width = panelWidth(input.viewport.width);
  const top = (input.headerBottom ?? DEFAULT_HEADER_BOTTOM) + HEADER_GAP;
  const maxHeight = Math.max(0, input.viewport.height - top - PANEL_EDGE_MARGIN);
  const reach: Rect = {
    x: input.viewport.width - PANEL_EDGE_MARGIN - width,
    y: top,
    width,
    height: maxHeight,
  };
  const crowded = overlapRatio(reach, input.composition) > COMPACT_OVERLAP_RATIO;
  return {
    top,
    right: PANEL_EDGE_MARGIN,
    width,
    maxHeight,
    crowded,
    compact: crowded && !input.userExpanded,
    strip: input.placing === true ? layoutPlaceStrip(input) : null,
  };
};
