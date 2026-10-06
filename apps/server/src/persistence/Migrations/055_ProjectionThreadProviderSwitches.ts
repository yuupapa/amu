import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Cross-provider handoff persistence (design §5.2).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One row per thread that ever had a switch: the folded switch state.
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_provider_switch_state (
      thread_id TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  // The exact packet text sent to the new provider, rebuilt from its event.
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_handoff_packets (
      packet_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      switch_id TEXT NOT NULL,
      text TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      chars INTEGER NOT NULL,
      included_messages INTEGER NOT NULL,
      omitted_messages INTEGER NOT NULL,
      truncated INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_handoff_packets_thread
    ON projection_thread_handoff_packets(thread_id)
  `;

  // NULL means delivered: every message from before this feature.
  const messageColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_messages)
  `;
  if (!messageColumns.some((column) => column.name === "delivery_state")) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN delivery_state TEXT
    `;
  }

  // No switch events exist before this migration, so the new projector can
  // start at the current end of the log instead of rescanning every event.
  // Sequence and time come from the same last event (by sequence, not by
  // time): snapshots take the newest projector timestamp as their updatedAt.
  yield* sql`
    INSERT OR IGNORE INTO projection_state (projector, last_applied_sequence, updated_at)
    SELECT
      'projection.thread-provider-switches',
      COALESCE(last_event.sequence, 0),
      COALESCE(last_event.occurred_at, '1970-01-01T00:00:00.000Z')
    FROM (SELECT 1) AS anchor
    LEFT JOIN (
      SELECT sequence, occurred_at
      FROM orchestration_events
      ORDER BY sequence DESC
      LIMIT 1
    ) AS last_event ON 1 = 1
  `;
});
