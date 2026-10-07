import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import {
  forgetAmuForkMigrations,
  markUndeliveredAmuMessages,
  UNDELIVERED_NOTE,
} from "./amuForkMigrations.ts";
import { runMigrations } from "./Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("forgetAmuForkMigrations", (it) => {
  it.effect("lets upstream migrations run on a database Amu 0.0.47 migrated", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // An Amu 0.0.47 database: upstream through 54, then Amu's own 55 and 56.
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (55, 'ProjectionThreadProviderSwitches'), (56, 'ProjectionTurnAssignments')
      `;

      const forgotten = yield* forgetAmuForkMigrations;
      assert.deepStrictEqual(forgotten, [
        "55_ProjectionThreadProviderSwitches",
        "56_ProjectionTurnAssignments",
      ]);

      yield* runMigrations();
      const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations
        WHERE migration_id IN (55, 56) ORDER BY migration_id
      `;
      assert.deepStrictEqual(
        rows.map((row) => `${row.migration_id}_${row.name}`),
        ["55_OrchestrationV2", "56_RemoveRedundantProjectionIndexes"],
      );
      const v2 = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'orchestration_v2_projection_threads'
      `;
      assert.strictEqual(v2.length, 1);
    }),
  );

  it.effect("leaves upstream rows at the same ids alone", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const forgotten = yield* forgetAmuForkMigrations;
      assert.deepStrictEqual(forgotten, []);
      const rows = yield* sql<{ readonly name: string }>`
        SELECT name FROM effect_sql_migrations WHERE migration_id = 55
      `;
      assert.deepStrictEqual(
        rows.map((row) => row.name),
        ["OrchestrationV2"],
      );
    }),
  );
});

it.effect("does nothing on a database without a migration ledger", () =>
  Effect.gen(function* () {
    const forgotten = yield* forgetAmuForkMigrations;
    assert.deepStrictEqual(forgotten, []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("marks messages Amu never sent, once, and leaves sent ones alone", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE projection_thread_messages (
        message_id TEXT PRIMARY KEY, role TEXT NOT NULL, text TEXT NOT NULL, delivery_state TEXT
      )
    `;
    yield* sql`
      INSERT INTO projection_thread_messages (message_id, role, text, delivery_state) VALUES
        ('a', 'user', 'delete the files', 'cancelled'),
        ('b', 'user', '/compact', 'pending'),
        ('c', 'user', 'hello', 'delivered'),
        ('d', 'user', 'older', NULL),
        ('e', 'assistant', 'reply', 'cancelled')
    `;
    assert.strictEqual(yield* markUndeliveredAmuMessages, 2);
    assert.strictEqual(yield* markUndeliveredAmuMessages, 0);
    const rows = yield* sql<{ readonly message_id: string; readonly text: string }>`
      SELECT message_id, text FROM projection_thread_messages ORDER BY message_id
    `;
    assert.deepStrictEqual(
      rows.map((row) => row.text),
      [
        `${UNDELIVERED_NOTE}delete the files`,
        `${UNDELIVERED_NOTE}/compact`,
        "hello",
        "older",
        "reply",
      ],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("skips databases without Amu's delivery column", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE projection_thread_messages (message_id TEXT, role TEXT, text TEXT)`;
    assert.strictEqual(yield* markUndeliveredAmuMessages, 0);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
