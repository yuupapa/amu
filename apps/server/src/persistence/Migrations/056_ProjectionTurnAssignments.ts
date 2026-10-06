import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Which provider instance, model and session generation answered each turn
// (design §5.4). Kept apart from projection_turns, whose rows are rewritten
// by many paths: the record carries both ids, so the order in which the turn
// row and this record arrive does not matter.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_turn_assignments (
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      driver TEXT NOT NULL,
      model TEXT NOT NULL,
      generation INTEGER,
      changed_mid_turn INTEGER NOT NULL DEFAULT 0,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, turn_id)
    )
  `;
  // The handoff source maps a user message to its turn by message id.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_turn_assignments_message
    ON projection_turn_assignments(thread_id, message_id, turn_id)
  `;
});
