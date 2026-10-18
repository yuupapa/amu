import {
  GalleryError,
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as GalleryOpen from "../../../gallery/GalleryOpen.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  GalleryOpen.GalleryOpen,
];

const GalleryToolFailure = Schema.Union([
  GalleryError,
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
]);

export const GalleryOpenToolResult = Schema.Struct({
  tabId: TrimmedNonEmptyString.annotate({
    description: "The preview tab that shows the gallery to the user.",
  }),
  url: TrimmedNonEmptyString.annotate({ description: "The gallery's local address." }),
});

const GalleryOpenTool = Tool.make("gallery_open", {
  description:
    "Open Amu Gallery (the local media gallery of generated images and videos, tools/media-gallery) in Amu, the same way Amu Creator opens. Call it after registering newly generated media so the user can review them; it starts the gallery server when needed and replaces this thread's previous Gallery tab. Desktop app only, and only while Amu Gallery is turned on.",
  // No `parameters`: Tool.make defaults to Tool.EmptyParams (an empty object schema).
  success: GalleryOpenToolResult,
  failure: GalleryToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Open Amu Gallery")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const GalleryToolkit = Toolkit.make(GalleryOpenTool);
