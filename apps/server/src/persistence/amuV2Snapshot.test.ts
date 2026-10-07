import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { refreshStaleV2Snapshot } from "./amuV2Snapshot.ts";

function writeV1(file: string, newest: number) {
  const db = new NodeSqlite.DatabaseSync(file);
  db.exec("CREATE TABLE orchestration_events (sequence INTEGER PRIMARY KEY, event_id TEXT)");
  for (let sequence = 1; sequence <= newest; sequence++) {
    db.prepare("INSERT INTO orchestration_events VALUES (?, ?)").run(sequence, `v1-${sequence}`);
  }
  db.close();
}

function writeCopy(file: string, copiedNewest: number, v2EventIds: readonly string[]) {
  const db = new NodeSqlite.DatabaseSync(file);
  db.exec(
    "CREATE TABLE orchestration_events (sequence INTEGER PRIMARY KEY, event_id TEXT, application_event_version INTEGER)",
  );
  for (let sequence = 1; sequence <= copiedNewest; sequence++) {
    db.prepare("INSERT INTO orchestration_events VALUES (?, ?, 1)").run(sequence, `v1-${sequence}`);
  }
  v2EventIds.forEach((id, index) => {
    db.prepare("INSERT INTO orchestration_events VALUES (?, ?, 2)").run(1000 + index, id);
  });
  db.close();
}

const setup = (v1Newest: number, copiedNewest: number, v2EventIds: readonly string[]) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "amu-v2-snapshot-" });
    const destination = path.join(directory, "statev2.sqlite");
    writeV1(path.join(directory, "state.sqlite"), v1Newest);
    writeCopy(destination, copiedNewest, v2EventIds);
    return { fs, destination };
  });

it.effect("keeps a copy that is up to date", () =>
  Effect.gen(function* () {
    const { fs, destination } = yield* setup(5, 5, ["migration:v1:thread:a"]);
    const decision = yield* refreshStaleV2Snapshot(destination);
    assert.strictEqual(decision.kind, "current");
    assert.isTrue(yield* fs.exists(destination));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("sets aside a copy V2 never wrote to when V1 moved on", () =>
  Effect.gen(function* () {
    const { fs, destination } = yield* setup(8, 5, ["migration:v1:thread:a"]);
    const decision = yield* refreshStaleV2Snapshot(destination);
    assert.strictEqual(decision.kind, "set-aside");
    assert.isFalse(yield* fs.exists(destination));
    if (decision.kind === "set-aside") assert.isTrue(yield* fs.exists(decision.movedTo));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps a copy with its own conversations even when V1 moved on", () =>
  Effect.gen(function* () {
    const { fs, destination } = yield* setup(8, 5, ["migration:v1:thread:a", "evt-new-run"]);
    const decision = yield* refreshStaleV2Snapshot(destination);
    assert.strictEqual(decision.kind, "both-changed");
    assert.isTrue(yield* fs.exists(destination));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("does nothing before the first copy", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "amu-v2-snapshot-" });
    writeV1(path.join(directory, "state.sqlite"), 3);
    const decision = yield* refreshStaleV2Snapshot(path.join(directory, "statev2.sqlite"));
    assert.strictEqual(decision.kind, "no-snapshot");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
