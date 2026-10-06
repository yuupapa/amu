import type { OrchestrationCheckpointSummary, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import { parseTurnDiffFilesFromNumstat } from "../checkpointing/Diffs.ts";
import { checkpointRefForThreadTurn } from "../checkpointing/Utils.ts";
import type { HandoffChangedFile } from "./CrossProviderHandoff.ts";
import type { ProjectionThreadCheckpointContext } from "./Services/ProjectionSnapshotQuery.ts";

// The handoff packet's [[AMU-CHANGES]] source (design §6.3): the final diff
// from checkpoint 0 (before the thread started) to the latest ready
// checkpoint, per file, with the last turn whose recorded diff touched it.

export interface HandoffChangesDeps {
  readonly getCheckpointContext: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProjectionThreadCheckpointContext>, ProjectionRepositoryError>;
  readonly checkpointStore: Pick<
    CheckpointStore.CheckpointStore["Service"],
    "isGitRepository" | "hasCheckpointRef" | "diffCheckpoints"
  >;
}

/** The last turn whose recorded diff touched each path, up to `upToTurn`. */
function lastChangedTurns(
  checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>,
  upToTurn: number,
): ReadonlyMap<string, number> {
  const turns = new Map<string, number>();
  for (const checkpoint of checkpoints) {
    if (checkpoint.checkpointTurnCount > upToTurn) continue;
    for (const file of checkpoint.files) {
      const known = turns.get(file.path);
      if (known === undefined || checkpoint.checkpointTurnCount > known) {
        turns.set(file.path, checkpoint.checkpointTurnCount);
      }
    }
  }
  return turns;
}

/**
 * Null when the changes cannot be read: no workspace or git repository, no
 * baseline ref, no ready checkpoint, or a failing git call. The packet then
 * says so instead of claiming there were no changes.
 */
export const readHandoffChanges = (
  deps: HandoffChangesDeps,
  threadId: ThreadId,
): Effect.Effect<ReadonlyArray<HandoffChangedFile> | null> =>
  Effect.gen(function* () {
    const context = yield* deps.getCheckpointContext(threadId);
    if (Option.isNone(context)) return null;
    const cwd = context.value.worktreePath ?? context.value.workspaceRoot;
    if (!cwd || !(yield* deps.checkpointStore.isGitRepository(cwd))) return null;
    const latest = context.value.checkpoints
      .filter((checkpoint) => checkpoint.status === "ready")
      .reduce<OrchestrationCheckpointSummary | null>(
        (best, checkpoint) =>
          best === null || checkpoint.checkpointTurnCount > best.checkpointTurnCount
            ? checkpoint
            : best,
        null,
      );
    if (latest === null) return null;
    const baseline = checkpointRefForThreadTurn(threadId, 0);
    if (!(yield* deps.checkpointStore.hasCheckpointRef({ cwd, checkpointRef: baseline }))) {
      return null;
    }
    const numstat = yield* deps.checkpointStore.diffCheckpoints({
      cwd,
      fromCheckpointRef: baseline,
      toCheckpointRef: latest.checkpointRef,
      fallbackFromToHead: false,
      ignoreWhitespace: false,
      format: "numstat",
    });
    const turns = lastChangedTurns(context.value.checkpoints, latest.checkpointTurnCount);
    return parseTurnDiffFilesFromNumstat(numstat).map((file) => ({
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
      lastChangedTurn: turns.get(file.path) ?? null,
    }));
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("handoff: could not read the thread's changes", { threadId, cause }).pipe(
        Effect.as(null),
      ),
    ),
  );
