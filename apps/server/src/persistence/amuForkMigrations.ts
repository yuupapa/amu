import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Amu 0.0.45–0.0.47 ran two fork migrations at ids 55 and 56. Upstream later
 * gave those ids to its own migrations (55 is Orchestration V2), and the
 * migrator skips every id at or below the highest one recorded. Left alone,
 * an upgraded Amu database would never get the V2 schema.
 *
 * Only these exact (id, name) rows are forgotten, so upstream's migrations at
 * those ids run. The fork's own tables and the extra message column stay;
 * nothing reads them any more. This runs on statev2.sqlite only — the V1
 * state.sqlite that it was copied from is never opened for writing.
 */
export const AMU_FORK_MIGRATIONS = [
  [55, "ProjectionThreadProviderSwitches"],
  [56, "ProjectionTurnAssignments"],
] as const;

/**
 * Amu 0.0.45–0.0.47 kept messages that never reached a model (cancelled or
 * rejected during a model switch, or still waiting for one) with a
 * `delivery_state`. Upstream's importer reads only the text, so without a
 * note they would come back as ordinary requests, and a later model would
 * read them as if they had been sent. Mark them before the import reads them.
 */
export const UNDELIVERED_NOTE = "（この発言は送信されませんでした）\n";
const UNDELIVERED_STATES = ["pending", "rejected", "cancelled", "unknown-discarded"] as const;

export const markUndeliveredAmuMessages = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('projection_thread_messages')
  `;
  if (!columns.some((column) => column.name === "delivery_state")) return 0;
  const rows = yield* sql<{ readonly message_id: string }>`
    UPDATE projection_thread_messages
    SET text = ${UNDELIVERED_NOTE} || text
    WHERE role = 'user'
      AND delivery_state IN ${sql.in(UNDELIVERED_STATES)}
      AND substr(text, 1, ${UNDELIVERED_NOTE.length}) != ${UNDELIVERED_NOTE}
    RETURNING message_id
  `;
  if (rows.length > 0) {
    yield* Effect.logInfo("Marked messages Amu never sent before importing them").pipe(
      Effect.annotateLogs({ count: rows.length }),
    );
  }
  return rows.length;
});

export const forgetAmuForkMigrations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const ledger = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (ledger.length === 0) return [];
  const forgotten: Array<string> = [];
  for (const [id, name] of AMU_FORK_MIGRATIONS) {
    const rows = yield* sql<{ readonly migration_id: number }>`
      DELETE FROM effect_sql_migrations
      WHERE migration_id = ${id} AND name = ${name}
      RETURNING migration_id
    `;
    if (rows.length > 0) forgotten.push(`${id}_${name}`);
  }
  if (forgotten.length > 0) {
    yield* Effect.logInfo("Forgot Amu fork migrations so upstream migrations run").pipe(
      Effect.annotateLogs({ forgotten }),
    );
  }
  return forgotten;
});
