import * as NodeSqlite from "node:sqlite";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * Upstream copies state.sqlite into statev2.sqlite once and never again. If
 * Amu goes back to a V1 build after that (an update that rolled back, or a
 * manual reinstall) and the user keeps talking there, the next V2 start would
 * not show those conversations.
 *
 * Before the copy is opened, compare the newest V1 event in state.sqlite with
 * the newest V1 event inside the copy. When V1 moved on and the copy holds
 * nothing written by V2 itself (every V2 event is an import, `migration:…`),
 * the copy is set aside — never deleted — and upstream takes a fresh one.
 * When both moved on, the copy is kept and a warning is logged.
 */

export type StaleSnapshotDecision =
  | { readonly kind: "no-snapshot" }
  | { readonly kind: "current" }
  | { readonly kind: "set-aside"; readonly movedTo: string }
  | { readonly kind: "both-changed"; readonly v1Newest: number; readonly copyNewest: number };

const IMPORT_EVENT_PREFIX = "migration:";

function readNumber(databasePath: string, query: string): number | null {
  const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare(query).get() as { readonly value: number | null } | undefined;
    return row?.value ?? null;
  } finally {
    database.close();
  }
}

function hasColumn(databasePath: string, table: string, column: string): boolean {
  const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      readonly name: string;
    }>;
    return rows.some((row) => row.name === column);
  } finally {
    database.close();
  }
}

export const refreshStaleV2Snapshot = Effect.fn("amu.refreshStaleV2Snapshot")(function* (
  destinationPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sourcePath = path.join(path.dirname(destinationPath), "state.sqlite");
  if (!(yield* fs.exists(destinationPath)) || !(yield* fs.exists(sourcePath))) {
    return { kind: "no-snapshot" } satisfies StaleSnapshotDecision as StaleSnapshotDecision;
  }

  const counts = yield* Effect.try(() => {
    const v1Newest =
      readNumber(sourcePath, "SELECT MAX(sequence) AS value FROM orchestration_events") ?? 0;
    // The copy keeps V1's rows; V2 writes its own with application_event_version = 2.
    const versioned = hasColumn(
      destinationPath,
      "orchestration_events",
      "application_event_version",
    );
    const copyNewest =
      readNumber(
        destinationPath,
        versioned
          ? "SELECT MAX(sequence) AS value FROM orchestration_events WHERE application_event_version IS NOT 2"
          : "SELECT MAX(sequence) AS value FROM orchestration_events",
      ) ?? 0;
    const writtenByV2 = versioned
      ? (readNumber(
          destinationPath,
          `SELECT COUNT(*) AS value FROM orchestration_events
           WHERE application_event_version = 2 AND event_id NOT LIKE '${IMPORT_EVENT_PREFIX}%'`,
        ) ?? 0)
      : 0;
    return { v1Newest, copyNewest, writtenByV2 };
  });

  if (counts.v1Newest <= counts.copyNewest) {
    return { kind: "current" } satisfies StaleSnapshotDecision as StaleSnapshotDecision;
  }
  if (counts.writtenByV2 > 0) {
    yield* Effect.logWarning(
      "state.sqlite changed after statev2.sqlite was copied, and statev2.sqlite has its own conversations. Keeping statev2.sqlite; conversations made in the older Amu since then are only in state.sqlite.",
    ).pipe(Effect.annotateLogs({ v1Newest: counts.v1Newest, copyNewest: counts.copyNewest }));
    return {
      kind: "both-changed",
      v1Newest: counts.v1Newest,
      copyNewest: counts.copyNewest,
    } satisfies StaleSnapshotDecision as StaleSnapshotDecision;
  }

  const stamp = DateTime.formatIso(yield* DateTime.now).replace(/[:.]/g, "-");
  const movedTo = `${destinationPath}.stale-${stamp}`;
  for (const suffix of ["", "-wal", "-shm"]) {
    const from = `${destinationPath}${suffix}`;
    if (yield* fs.exists(from)) yield* fs.rename(from, `${movedTo}${suffix}`);
  }
  yield* Effect.logInfo(
    "state.sqlite changed after statev2.sqlite was copied; set the old copy aside to copy again",
  ).pipe(Effect.annotateLogs({ movedTo }));
  return { kind: "set-aside", movedTo } satisfies StaleSnapshotDecision as StaleSnapshotDecision;
});
