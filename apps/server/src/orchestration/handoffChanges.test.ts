import {
  CheckpointRef,
  type OrchestrationCheckpointSummary,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { checkpointRefForThreadTurn } from "../checkpointing/Utils.ts";
import { readHandoffChanges, type HandoffChangesDeps } from "./handoffChanges.ts";
import type { ProjectionThreadCheckpointContext } from "./Services/ProjectionSnapshotQuery.ts";

const threadId = ThreadId.make("thread-changes");

const checkpoint = (
  turn: number,
  status: OrchestrationCheckpointSummary["status"],
  files: ReadonlyArray<string>,
): OrchestrationCheckpointSummary => ({
  turnId: TurnId.make(`turn-${turn}`),
  checkpointTurnCount: turn,
  checkpointRef: CheckpointRef.make(`refs/test/${turn}`),
  status,
  files: files.map((path) => ({ path, kind: "modified", additions: 1, deletions: 0 })),
  assistantMessageId: null,
  completedAt: "2026-01-01T00:00:00.000Z",
});

const context = (
  checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>,
): ProjectionThreadCheckpointContext => ({
  threadId,
  projectId: ProjectId.make("project-changes"),
  workspaceRoot: "/repo",
  worktreePath: null,
  checkpoints,
});

const makeDeps = (input: {
  readonly context?: ProjectionThreadCheckpointContext | null;
  readonly isGit?: boolean;
  readonly hasBaseline?: boolean;
  readonly numstat?: string;
  readonly diffCalls?: Array<{ from: string; to: string; format: string | undefined }>;
}): HandoffChangesDeps => ({
  getCheckpointContext: () => Effect.succeed(Option.fromNullishOr(input.context ?? null)),
  checkpointStore: {
    isGitRepository: () => Effect.succeed(input.isGit ?? true),
    hasCheckpointRef: () => Effect.succeed(input.hasBaseline ?? true),
    diffCheckpoints: (diff) => {
      input.diffCalls?.push({
        from: diff.fromCheckpointRef,
        to: diff.toCheckpointRef,
        format: diff.format,
      });
      return Effect.succeed(input.numstat ?? "");
    },
  },
});

describe("readHandoffChanges", () => {
  it.effect("diffs checkpoint 0 against the latest ready checkpoint, per file", () =>
    Effect.gen(function* () {
      const diffCalls: Array<{ from: string; to: string; format: string | undefined }> = [];
      const changes = yield* readHandoffChanges(
        makeDeps({
          context: context([
            checkpoint(1, "ready", ["src/a.ts"]),
            checkpoint(2, "ready", ["src/a.ts", "src/b.ts"]),
            // A later checkpoint that is not ready is not the final state.
            checkpoint(3, "missing", ["src/c.ts"]),
          ]),
          numstat: "3\t1\tsrc/a.ts\u00005\t0\tsrc/b.ts\u00002\t2\tsrc/old.ts\u0000",
          diffCalls,
        }),
        threadId,
      );
      assert.deepEqual(diffCalls, [
        {
          from: checkpointRefForThreadTurn(threadId, 0),
          to: "refs/test/2",
          format: "numstat",
        },
      ]);
      assert.deepEqual(changes, [
        { path: "src/a.ts", additions: 3, deletions: 1, lastChangedTurn: 2 },
        { path: "src/b.ts", additions: 5, deletions: 0, lastChangedTurn: 2 },
        // Changed outside the recorded turn diffs (or before them): no turn.
        { path: "src/old.ts", additions: 2, deletions: 2, lastChangedTurn: null },
      ]);
    }),
  );

  it.effect("returns no changes for an unchanged workspace", () =>
    Effect.gen(function* () {
      const changes = yield* readHandoffChanges(
        makeDeps({ context: context([checkpoint(1, "ready", [])]), numstat: "" }),
        threadId,
      );
      assert.deepEqual(changes, []);
    }),
  );

  it.effect("cannot read the changes without a workspace, repository, baseline or checkpoint", () =>
    Effect.gen(function* () {
      const ready = context([checkpoint(1, "ready", ["src/a.ts"])]);
      for (const deps of [
        makeDeps({ context: null }),
        makeDeps({ context: { ...ready, workspaceRoot: "" } }),
        makeDeps({ context: ready, isGit: false }),
        makeDeps({ context: ready, hasBaseline: false }),
        makeDeps({ context: context([checkpoint(1, "error", ["src/a.ts"])]) }),
      ]) {
        assert.strictEqual(yield* readHandoffChanges(deps, threadId), null);
      }
    }),
  );

  it.effect("cannot read the changes when git fails", () =>
    Effect.gen(function* () {
      const deps = makeDeps({ context: context([checkpoint(1, "ready", ["src/a.ts"])]) });
      const failing: HandoffChangesDeps = {
        ...deps,
        checkpointStore: {
          ...deps.checkpointStore,
          diffCheckpoints: () => Effect.fail({ _tag: "VcsProcessExitError" } as never) as never,
        },
      };
      assert.strictEqual(yield* readHandoffChanges(failing, threadId), null);
    }),
  );
});
