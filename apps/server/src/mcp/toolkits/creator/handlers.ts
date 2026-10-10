import type { CreatorComment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as CreatorOpen from "../../../creator/CreatorOpen.ts";
import * as CreatorService from "../../../creator/CreatorService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { CreatorToolkit, type CreatorCommentForAgent } from "./tools.ts";

/** Creator tabs and their comments belong to the calling thread. */
const requireCreatorAccess = McpInvocationContext.requireThreadMcpCapability("creator");

const forAgent = (comment: CreatorComment): CreatorCommentForAgent => ({
  id: comment.id,
  number: comment.number,
  status: comment.status,
  timeSec: comment.timeSec,
  comment: comment.comment,
  place: comment.place,
  hasShot: comment.shot !== null,
  sentAt: comment.sentAt,
  resolvedNote: comment.resolvedNote,
});

const handlers = {
  creator_open: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireCreatorAccess;
      const opener = yield* CreatorOpen.CreatorOpen;
      // An agent never opens as the user: it stays inside its workspace.
      const opened = yield* opener.open({
        path: input.path,
        threadId: scope.thread.threadId,
        openedBy: "agent",
      });
      return { projectId: opened.projectId, tabId: opened.tabId };
    }),
  ),
  creator_comments: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireCreatorAccess;
      const creator = yield* CreatorService.CreatorService;
      yield* creator.requireBindingForThread(input.projectId, scope.thread.threadId);
      const state = yield* creator.withProjectState(input.projectId, (current) =>
        Effect.succeed({ next: null, value: current }),
      );
      const comments = state.comments.filter(
        (comment) => input.status === undefined || comment.status === input.status,
      );
      return { projectId: input.projectId, comments: comments.map(forAgent) };
    }),
  ),
  creator_resolve: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireCreatorAccess;
      const creator = yield* CreatorService.CreatorService;
      yield* creator.requireBindingForThread(input.projectId, scope.thread.threadId);
      yield* creator.resolve(input.projectId, input.ids, input.note);
      return { resolved: [...input.ids] };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof CreatorToolkit.tools>;

export const layer = McpToolAccess.toLayer(CreatorToolkit, handlers);
