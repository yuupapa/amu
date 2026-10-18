import * as Effect from "effect/Effect";

import * as GalleryOpen from "../../../gallery/GalleryOpen.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { GalleryToolkit } from "./tools.ts";

/** Gallery tabs belong to the calling thread. */
const requireGalleryAccess = McpInvocationContext.requireThreadMcpCapability("gallery");

const handlers = {
  gallery_open: McpToolAccess.actsAsCaller(() =>
    Effect.gen(function* () {
      const scope = yield* requireGalleryAccess;
      const opener = yield* GalleryOpen.GalleryOpen;
      return yield* opener.open({ threadId: scope.thread.threadId, openedBy: "agent" });
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof GalleryToolkit.tools>;

export const layer = McpToolAccess.toLayer(GalleryToolkit, handlers);
