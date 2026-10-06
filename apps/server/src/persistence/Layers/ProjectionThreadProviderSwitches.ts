import { OrchestrationThreadProviderSwitchState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { PersistenceSqlError, toPersistenceSqlError } from "../Errors.ts";
import {
  GetProjectionThreadHandoffPacketInput,
  ProjectionThreadHandoffPacket,
  ProjectionThreadIdInput,
  ProjectionThreadProviderSwitchRepository,
  ProjectionThreadProviderSwitchStateRow,
  SetProjectionMessageDeliveryStateInput,
  type ProjectionThreadProviderSwitchRepositoryShape,
} from "../Services/ProjectionThreadProviderSwitches.ts";

const StateDbRow = ProjectionThreadProviderSwitchStateRow.mapFields(
  Struct.assign({ state: Schema.fromJsonString(OrchestrationThreadProviderSwitchState) }),
);
const PacketDbRow = ProjectionThreadHandoffPacket.mapFields(
  Struct.assign({ truncated: Schema.Number }),
);

const toPacket = (row: typeof PacketDbRow.Type): ProjectionThreadHandoffPacket => ({
  ...row,
  truncated: row.truncated === 1,
});

const makeProjectionThreadProviderSwitchRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getStateRow = SqlSchema.findOneOption({
    Request: ProjectionThreadIdInput,
    Result: StateDbRow,
    execute: ({ threadId }) => sql`
      SELECT
        thread_id AS "threadId",
        state_json AS "state",
        updated_at AS "updatedAt"
      FROM projection_thread_provider_switch_state
      WHERE thread_id = ${threadId}
    `,
  });

  const listStateRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: StateDbRow,
    execute: () => sql`
      SELECT
        thread_id AS "threadId",
        state_json AS "state",
        updated_at AS "updatedAt"
      FROM projection_thread_provider_switch_state
      ORDER BY thread_id ASC
    `,
  });

  // Request encodes `state` to its JSON text before execute sees it.
  const upsertStateRow = SqlSchema.void({
    Request: StateDbRow,
    execute: (row) => sql`
      INSERT INTO projection_thread_provider_switch_state (thread_id, state_json, updated_at)
      VALUES (${row.threadId}, ${row.state}, ${row.updatedAt})
      ON CONFLICT (thread_id)
      DO UPDATE SET
        state_json = excluded.state_json,
        updated_at = excluded.updated_at
    `,
  });

  const insertPacketRow = SqlSchema.void({
    Request: ProjectionThreadHandoffPacket,
    execute: (row) => sql`
      INSERT INTO projection_thread_handoff_packets (
        packet_id,
        thread_id,
        switch_id,
        text,
        sha256,
        chars,
        included_messages,
        omitted_messages,
        truncated,
        created_at
      )
      VALUES (
        ${row.packetId},
        ${row.threadId},
        ${row.switchId},
        ${row.text},
        ${row.sha256},
        ${row.chars},
        ${row.includedMessages},
        ${row.omittedMessages},
        ${row.truncated ? 1 : 0},
        ${row.createdAt}
      )
    `,
  });

  const getPacketRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadHandoffPacketInput,
    Result: PacketDbRow,
    execute: ({ packetId }) => sql`
      SELECT
        packet_id AS "packetId",
        thread_id AS "threadId",
        switch_id AS "switchId",
        text,
        sha256,
        chars,
        included_messages AS "includedMessages",
        omitted_messages AS "omittedMessages",
        truncated,
        created_at AS "createdAt"
      FROM projection_thread_handoff_packets
      WHERE packet_id = ${packetId}
    `,
  });

  const deleteStateRow = SqlSchema.void({
    Request: ProjectionThreadIdInput,
    execute: ({ threadId }) => sql`
      DELETE FROM projection_thread_provider_switch_state WHERE thread_id = ${threadId}
    `,
  });
  const deletePacketRows = SqlSchema.void({
    Request: ProjectionThreadIdInput,
    execute: ({ threadId }) => sql`
      DELETE FROM projection_thread_handoff_packets WHERE thread_id = ${threadId}
    `,
  });

  const setDeliveryState = SqlSchema.void({
    Request: SetProjectionMessageDeliveryStateInput,
    execute: ({ messageId, deliveryState }) => sql`
      UPDATE projection_thread_messages
      SET delivery_state = ${deliveryState}
      WHERE message_id = ${messageId}
    `,
  });

  const fail = (operation: string) =>
    toPersistenceSqlError(`ProjectionThreadProviderSwitchRepository.${operation}:query`);

  return {
    getStateByThreadId: (input) =>
      getStateRow(input).pipe(Effect.mapError(fail("getStateByThreadId"))),
    listStates: () => listStateRows(undefined).pipe(Effect.mapError(fail("listStates"))),
    upsertState: (row) => upsertStateRow(row).pipe(Effect.mapError(fail("upsertState"))),
    // Packets are immutable: the same record again is a no-op, a different
    // record under a used packet id fails so its event never commits.
    insertPacket: (row) =>
      getPacketRow({ packetId: row.packetId }).pipe(
        Effect.mapError(fail("insertPacket")),
        Effect.flatMap((existing) => {
          if (Option.isNone(existing)) {
            return insertPacketRow(row).pipe(Effect.mapError(fail("insertPacket")));
          }
          const stored = toPacket(existing.value);
          const same =
            stored.threadId === row.threadId &&
            stored.switchId === row.switchId &&
            stored.text === row.text &&
            stored.sha256 === row.sha256 &&
            stored.chars === row.chars &&
            stored.includedMessages === row.includedMessages &&
            stored.omittedMessages === row.omittedMessages &&
            stored.truncated === row.truncated;
          return same
            ? Effect.void
            : Effect.fail(
                new PersistenceSqlError({
                  operation: "ProjectionThreadProviderSwitchRepository.insertPacket",
                  detail: `Packet '${row.packetId}' already exists with different content.`,
                }),
              );
        }),
      ),
    getPacket: (input) =>
      getPacketRow(input).pipe(
        Effect.map((row) => row.pipe(Option.map(toPacket))),
        Effect.mapError(fail("getPacket")),
      ),
    deleteByThreadId: (input) =>
      Effect.all([deleteStateRow(input), deletePacketRows(input)], { discard: true }).pipe(
        Effect.mapError(fail("deleteByThreadId")),
      ),
    setMessageDeliveryState: (input) =>
      setDeliveryState(input).pipe(Effect.mapError(fail("setMessageDeliveryState"))),
  } satisfies ProjectionThreadProviderSwitchRepositoryShape;
});

export const ProjectionThreadProviderSwitchRepositoryLive = Layer.effect(
  ProjectionThreadProviderSwitchRepository,
  makeProjectionThreadProviderSwitchRepository,
);
