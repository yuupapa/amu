import {
  CREATOR_LIMITS,
  CreatorCommentId,
  CreatorCommentStatus,
  CreatorError,
  CreatorPlace,
  CreatorProjectId,
  IsoDateTime,
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  PositiveInt,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as CreatorOpen from "../../../creator/CreatorOpen.ts";
import * as CreatorService from "../../../creator/CreatorService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  CreatorService.CreatorService,
  CreatorOpen.CreatorOpen,
];

/** What a Creator tool fails with, including the access gate's refusals. */
const CreatorToolFailure = Schema.Union([
  CreatorError,
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
]);

const ProjectIdParameter = CreatorProjectId.annotate({
  description: "The Creator project id that creator_open returned (32 hex characters).",
});

export const CreatorOpenToolInput = Schema.Struct({
  // A plain string: a trimming schema would hide this description from the tool's JSON schema.
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)).annotate({
    description:
      "A HyperFrames project folder (it contains hyperframes.json) or an .mp4, .mov or .webm video inside this thread's workspace. Relative paths start at the workspace root.",
  }),
});

export const CreatorOpenToolResult = Schema.Struct({
  projectId: CreatorProjectId.annotate({
    description: "Pass this to creator_comments and creator_resolve.",
  }),
  tabId: TrimmedNonEmptyString.annotate({
    description: "The preview tab that shows the project to the user.",
  }),
});

export const CreatorCommentsToolInput = Schema.Struct({
  projectId: ProjectIdParameter,
  status: Schema.optional(
    CreatorCommentStatus.annotate({
      description:
        "Only comments in this state. `sent` are the requests waiting for you; omit for all.",
    }),
  ),
});

/** A comment as an agent reads it: the text and where it points, no screenshot bytes. */
export const CreatorCommentForAgent = Schema.Struct({
  id: CreatorCommentId,
  number: PositiveInt,
  status: CreatorCommentStatus,
  timeSec: Schema.Number.annotate({ description: "Playback time the comment was made at." }),
  comment: Schema.String,
  place: Schema.NullOr(CreatorPlace),
  hasShot: Schema.Boolean.annotate({
    description: "Whether the user attached a screenshot. It was sent with the request message.",
  }),
  sentAt: Schema.NullOr(IsoDateTime),
  resolvedNote: Schema.NullOr(Schema.String),
});
export type CreatorCommentForAgent = typeof CreatorCommentForAgent.Type;

export const CreatorCommentsToolResult = Schema.Struct({
  projectId: CreatorProjectId,
  comments: Schema.Array(CreatorCommentForAgent),
});

export const CreatorResolveToolInput = Schema.Struct({
  projectId: ProjectIdParameter,
  ids: Schema.Array(CreatorCommentId)
    .check(Schema.isMinLength(1), Schema.isMaxLength(CREATOR_LIMITS.maxComments))
    .annotate({ description: "Ids of the `sent` comments you have addressed." }),
  note: Schema.String.check(Schema.isMaxLength(CREATOR_LIMITS.maxComment)).annotate({
    description: "One short note for the user on what you changed.",
  }),
});

export const CreatorResolveToolResult = Schema.Struct({
  resolved: Schema.Array(CreatorCommentId),
});

const CreatorOpenTool = Tool.make("creator_open", {
  description:
    "Open a HyperFrames project folder or a video from this thread's workspace in Amu Creator, so the user can watch it and leave review comments that come back to this thread. Desktop app only, and only while Amu Creator is turned on.",
  parameters: CreatorOpenToolInput,
  success: CreatorOpenToolResult,
  failure: CreatorToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Open in Amu Creator")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const CreatorCommentsTool = Tool.make("creator_comments", {
  description:
    "List the review comments of an Amu Creator project that is open for this thread: number, time, text, place and status. Screenshots are not returned; they arrive with the request message.",
  parameters: CreatorCommentsToolInput,
  success: CreatorCommentsToolResult,
  failure: CreatorToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Read Creator comments")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const CreatorResolveTool = Tool.make("creator_resolve", {
  description:
    "Mark Amu Creator comments that were sent to this thread as resolved once you have made the change, with a short note. The user then confirms them in Creator.",
  parameters: CreatorResolveToolInput,
  success: CreatorResolveToolResult,
  failure: CreatorToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Resolve Creator comments")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const CreatorToolkit = Toolkit.make(
  CreatorOpenTool,
  CreatorCommentsTool,
  CreatorResolveTool,
);
