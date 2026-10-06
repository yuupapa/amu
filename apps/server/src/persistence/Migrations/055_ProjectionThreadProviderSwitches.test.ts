import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import migrateProviderSwitches from "./055_ProjectionThreadProviderSwitches.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "055_ProjectionThreadProviderSwitches",
  (it) => {
    it.effect("starts the switch projector at the end of the existing log", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 54 });
        // The last event by sequence is older than the one before it.
        for (const [index, occurredAt] of [
          "2026-10-02T00:00:00.000Z",
          "2026-09-01T00:00:00.000Z",
        ].entries()) {
          yield* sql`
            INSERT INTO orchestration_events (
              event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
              command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
            ) VALUES (
              ${`event-${index}`}, 'project', 'project-1', ${index}, 'project.meta-updated',
              ${occurredAt}, NULL, NULL, NULL, 'server', '{}', '{}'
            )
          `;
        }
        yield* sql`
          INSERT INTO projection_thread_messages (
            message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
          ) VALUES (
            'message-1', 'thread-1', NULL, 'user', 'hi', 0,
            '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'
          )
        `;

        yield* runMigrations({ toMigrationInclusive: 55 });

        const cursor = yield* sql<{ readonly sequence: number; readonly updatedAt: string }>`
          SELECT last_applied_sequence AS "sequence", updated_at AS "updatedAt"
          FROM projection_state
          WHERE projector = 'projection.thread-provider-switches'
        `;
        assert.deepEqual(cursor, [{ sequence: 2, updatedAt: "2026-09-01T00:00:00.000Z" }]);

        // Messages from before the feature read as delivered (NULL).
        const messages = yield* sql<{ readonly deliveryState: string | null }>`
          SELECT delivery_state AS "deliveryState" FROM projection_thread_messages
        `;
        assert.deepEqual(messages, [{ deliveryState: null }]);

        // Re-running keeps an advanced cursor and existing tables.
        yield* sql`
          UPDATE projection_state SET last_applied_sequence = 9
          WHERE projector = 'projection.thread-provider-switches'
        `;
        yield* migrateProviderSwitches;
        const rerun = yield* sql<{ readonly sequence: number }>`
          SELECT last_applied_sequence AS "sequence" FROM projection_state
          WHERE projector = 'projection.thread-provider-switches'
        `;
        assert.deepEqual(rerun, [{ sequence: 9 }]);
      }),
    );
  },
);

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "055_ProjectionThreadProviderSwitches on an empty database",
  (it) => {
    it.effect("starts the cursor at zero and the epoch", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 55 });
        const cursor = yield* sql<{ readonly sequence: number; readonly updatedAt: string }>`
          SELECT last_applied_sequence AS "sequence", updated_at AS "updatedAt"
          FROM projection_state
          WHERE projector = 'projection.thread-provider-switches'
        `;
        assert.deepEqual(cursor, [{ sequence: 0, updatedAt: "1970-01-01T00:00:00.000Z" }]);
      }),
    );
  },
);
