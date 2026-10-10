/**
 * Channels between the desktop main process and the Amu Creator overlay in a
 * preview guest (HyperFrames Studio). Imported by both sides, so it must stay
 * free of Electron and Node imports.
 *
 * Every guest -> main message is one object carrying the `generation` the guest
 * was activated with. Main drops it unless it comes from the guest's main frame,
 * on the current attachment, for the live session's document, within 256KB and
 * the per-guest rate limits. The guest page can forge any of these, so main
 * treats every field as untrusted.
 */
import type { DesktopPreviewCreatorGuestKind } from "@t3tools/contracts";

/** main -> guest `{ generation: number | null }`. `null` switches the overlay off. */
export const CREATOR_ACTIVATE_CHANNEL = "creator:activate";

/** guest -> main `{ generation, payload }`; main forwards `payload` to the renderer untouched. */
export const CREATOR_GUEST_CHANNELS: Readonly<Record<DesktopPreviewCreatorGuestKind, string>> = {
  draft: "creator:draft",
  update: "creator:update",
  place: "creator:place",
  delete: "creator:delete",
  propose: "creator:propose",
  cancel: "creator:cancel",
  "confirm-by-user": "creator:confirm-by-user",
};

/**
 * guest -> main `{ generation, requestId, purpose: "draft" | "place", timeSec, commentId?, place? }`.
 * `requestId` is 1-64 of `[A-Za-z0-9_-]`, unique per request.
 */
export const CREATOR_CAPTURE_REQUEST_CHANNEL = "creator:capture-request";
/** main -> guest `{ requestId }`: freeze at `timeSec`, hide the overlay, then report ready. */
export const CREATOR_CAPTURE_BEGIN_CHANNEL = "creator:capture-begin";
/**
 * guest -> main `{ generation, requestId, rect, pin? }`, both in the guest's CSS
 * pixels relative to its viewport. `pin` is the point the comment marks; a crop
 * that does not show it is refused.
 */
export const CREATOR_CAPTURE_READY_CHANNEL = "creator:capture-ready";
/** main -> guest `{ requestId, ok }`: restore the overlay and playback. */
export const CREATOR_CAPTURE_DONE_CHANNEL = "creator:capture-done";
/**
 * main -> guest `{ kind, reason }` when a message from the live document was
 * refused for its size or rate (`too_large`, `rate_limited`, `bad_request`), so
 * the panel can ask the user to wait.
 */
export const CREATOR_REFUSED_CHANNEL = "creator:refused";
/** main -> guest `{ generation, state }`: the panel state the renderer pushed. */
export const CREATOR_STATE_CHANNEL = "creator:state";
