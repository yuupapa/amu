/**
 * Gallery - Schemas for Amu Gallery, the in-app view of the local media
 * gallery (the image and video review app under `tools/media-gallery`).
 *
 * The server starts the gallery's own web server when it is not running yet,
 * opens it in a preview tab marked with `GalleryTabInfo`, and stops the server
 * it started once the last Gallery tab closes. The gallery page itself is
 * unchanged; Amu only hosts it the way it hosts Amu Creator.
 *
 * @module Gallery
 */
import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Marks a preview tab opened by Amu Gallery. Only the server sets it. */
export const GalleryTabInfo = Schema.Struct({
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
});
export type GalleryTabInfo = typeof GalleryTabInfo.Type;

export class GalleryDisabledError extends Schema.TaggedError<GalleryDisabledError>()(
  "GalleryDisabledError",
  {},
) {
  override get message() {
    return "Amu Gallery is turned off on this environment.";
  }
}

export const GalleryOperationErrorCode = Schema.Literals([
  "unauthorized",
  "not_found",
  "invalid",
  "unavailable",
]);
export type GalleryOperationErrorCode = typeof GalleryOperationErrorCode.Type;

export class GalleryOperationError extends Schema.TaggedError<GalleryOperationError>()(
  "GalleryOperationError",
  { code: GalleryOperationErrorCode, detail: Schema.String },
) {
  override get message() {
    return `Amu Gallery: ${this.code}: ${this.detail}`;
  }
}

export const GalleryError = Schema.Union([GalleryDisabledError, GalleryOperationError]);
export type GalleryError = typeof GalleryError.Type;

export const GalleryOpenByUserInput = Schema.Struct({
  threadId: ThreadId,
});
export type GalleryOpenByUserInput = typeof GalleryOpenByUserInput.Type;

export const GalleryOpenResult = Schema.Struct({
  tabId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  url: TrimmedNonEmptyString,
});
export type GalleryOpenResult = typeof GalleryOpenResult.Type;
