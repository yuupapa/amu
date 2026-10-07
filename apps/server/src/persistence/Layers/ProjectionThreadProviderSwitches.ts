import {
  OrchestrationThreadProviderSwitchState,
  type MessageDeliveryState,
} from "@t3tools/contracts";
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
  HANDOFF_SOURCE_LIMITS,
  type HandoffSourceLogRow,
  type HandoffSourceRows,
  type HandoffSourceUserRow,
  ProjectionThreadHandoffPacket,
  ProjectionThreadIdInput,
  ProjectionThreadProviderSwitchRepository,
  ProjectionThreadProviderSwitchStateRow,
  ProjectionTurnAssignment,
  SetProjectionMessageDeliveryStateInput,
  type ProjectionThreadProviderSwitchRepositoryShape,
} from "../Services/ProjectionThreadProviderSwitches.ts";

const StateDbRow = ProjectionThreadProviderSwitchStateRow.mapFields(
  Struct.assign({ state: Schema.fromJsonString(OrchestrationThreadProviderSwitchState) }),
);
const PacketDbRow = ProjectionThreadHandoffPacket.mapFields(
  Struct.assign({ truncated: Schema.Number }),
);

const AssignmentDbRow = ProjectionTurnAssignment.mapFields(
  Struct.assign({ changedMidTurn: Schema.Number }),
);
const AssignmentRecordRequest = Schema.Struct(
  Struct.omit(ProjectionTurnAssignment.fields, ["changedMidTurn"]),
);

// A tool's start and progress repeat the summary its completion carries, so
// the packet log keeps one line per tool call (§6.2).
const TOOL_PROGRESS_KINDS = ["tool.started", "tool.updated"];

const decodeContextLabels = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(Schema.String)),
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

  // First record wins; a differing later record only flags the change.
  const recordAssignmentRow = SqlSchema.void({
    Request: AssignmentRecordRequest,
    execute: (row) => sql`
      INSERT INTO projection_turn_assignments (
        thread_id,
        turn_id,
        message_id,
        instance_id,
        driver,
        model,
        generation,
        changed_mid_turn,
        recorded_at
      )
      VALUES (
        ${row.threadId},
        ${row.turnId},
        ${row.messageId},
        ${row.instanceId},
        ${row.driver},
        ${row.model},
        ${row.generation},
        0,
        ${row.recordedAt}
      )
      ON CONFLICT (thread_id, turn_id)
      DO UPDATE SET
        changed_mid_turn = CASE
          WHEN projection_turn_assignments.instance_id <> excluded.instance_id
            OR projection_turn_assignments.model <> excluded.model
          THEN 1
          ELSE projection_turn_assignments.changed_mid_turn
        END
    `,
  });

  const listAssignmentRows = SqlSchema.findAll({
    Request: ProjectionThreadIdInput,
    Result: AssignmentDbRow,
    execute: ({ threadId }) => sql`
      SELECT
        thread_id AS "threadId",
        turn_id AS "turnId",
        message_id AS "messageId",
        instance_id AS "instanceId",
        driver,
        model,
        generation,
        changed_mid_turn AS "changedMidTurn",
        recorded_at AS "recordedAt"
      FROM projection_turn_assignments
      WHERE thread_id = ${threadId}
      ORDER BY recorded_at ASC, turn_id ASC
    `,
  });

  const deleteAssignmentRows = SqlSchema.void({
    Request: ProjectionThreadIdInput,
    execute: ({ threadId }) => sql`
      DELETE FROM projection_turn_assignments WHERE thread_id = ${threadId}
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

  // ── Handoff source (design §6.4) ─────────────────────────────────
  const L = HANDOFF_SOURCE_LIMITS;

  interface RawUserRow {
    readonly messageId: string;
    readonly turn: number | null;
    readonly text: string;
    readonly fullChars: number;
    readonly contextLabels: string | null;
  }
  const toUserRow = (row: RawUserRow): HandoffSourceUserRow => ({
    messageId: row.messageId as HandoffSourceUserRow["messageId"],
    turn: row.turn,
    text: row.text,
    fullChars: row.fullChars,
    contextLabels: row.contextLabels === null ? [] : decodeContextLabels(row.contextLabels),
  });

  // Bodies are only read for rows already chosen by id and time, so the work
  // stays bounded however long the thread is (design §6.4, P10).

  // Delivered user messages except the trigger; NULL delivery_state is delivered.
  const deliveredUserFilter = (threadId: string, triggerMessageId: string) => sql`
    m.thread_id = ${threadId}
    AND m.role = 'user'
    AND (m.delivery_state IS NULL OR m.delivery_state = 'delivered')
    AND m.message_id <> ${triggerMessageId}
  `;

  // Turn number of a user message: the turn-assignment record maps the message
  // to its turn even when pending turn rows were paired out of order (P7). The
  // pending pairing is only a fallback, and never when it points at a turn
  // that a record assigns to another message.
  const userTurnNumber = sql`
    COALESCE(
      (
        SELECT t.checkpoint_turn_count
        FROM projection_turn_assignments ta
        JOIN projection_turns t ON t.thread_id = ta.thread_id AND t.turn_id = ta.turn_id
        WHERE ta.thread_id = m.thread_id AND ta.message_id = m.message_id
        LIMIT 1
      ),
      CASE WHEN NOT EXISTS (
        SELECT 1 FROM projection_turn_assignments ta
        WHERE ta.thread_id = m.thread_id AND ta.message_id = m.message_id
      ) THEN (
        SELECT t.checkpoint_turn_count
        FROM projection_turns t
        WHERE t.thread_id = m.thread_id
          AND (t.pending_message_id = m.message_id OR (m.turn_id IS NOT NULL AND t.turn_id = m.turn_id))
          AND t.checkpoint_turn_count IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM projection_turn_assignments other
            WHERE other.thread_id = t.thread_id
              AND other.turn_id = t.turn_id
              AND other.message_id <> m.message_id
          )
        LIMIT 1
      ) END
    )
  `;

  // Body, length, turn and context labels for the given message ids only.
  // Labels come from the JSON in SQL so record bodies never reach the server.
  const userDetails = (threadId: string, ids: ReadonlyArray<string>) =>
    ids.length === 0
      ? Effect.succeed([] as ReadonlyArray<RawUserRow & { readonly createdAt: string }>)
      : sql<RawUserRow & { readonly createdAt: string }>`
          SELECT
            m.message_id AS "messageId",
            m.created_at AS "createdAt",
            substr(m.text, 1, ${L.userMessageChars}) AS "text",
            length(m.text) AS "fullChars",
            ${userTurnNumber} AS "turn",
            CASE WHEN m.context_json IS NOT NULL AND json_valid(m.context_json) THEN (
              SELECT json_group_array(label) FROM (
                SELECT json_extract(r.value, '$.kind') || ': ' || json_extract(r.value, '$.label') AS label
                FROM json_each(m.context_json, '$.records') AS r
                WHERE json_extract(r.value, '$.label') IS NOT NULL
                LIMIT ${L.contextLabels}
              )
            ) END AS "contextLabels"
          FROM projection_thread_messages m
          WHERE m.thread_id = ${threadId} AND m.message_id IN ${sql.in(ids)}
        `;

  /** Keeps rows (newest first) while their summed text fits; returns them oldest first. */
  const takeWithinChars = <Row extends { readonly text: string }>(
    newestFirst: ReadonlyArray<Row>,
    maxChars: number,
  ): ReadonlyArray<Row> => {
    const kept: Row[] = [];
    let total = 0;
    for (const row of newestFirst) {
      total += row.text.length;
      if (total > maxChars) break;
      kept.push(row);
    }
    return kept.toReversed();
  };

  const readHandoffSourceRows = (input: { threadId: string; triggerMessageId: string }) =>
    Effect.gen(function* () {
      const { threadId, triggerMessageId } = input;
      const threadRows = yield* sql<{
        readonly branch: string | null;
        readonly worktreePath: string | null;
        readonly runtimeMode: string;
        readonly interactionMode: string;
      }>`
        SELECT
          branch,
          worktree_path AS "worktreePath",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `;

      // Ids first, without bodies: the first request, then the newest others.
      const firstIdRows = yield* sql<{ readonly messageId: string }>`
        SELECT m.message_id AS "messageId"
        FROM projection_thread_messages m
        WHERE ${deliveredUserFilter(threadId, triggerMessageId)}
        ORDER BY m.created_at ASC, m.message_id ASC
        LIMIT 1
      `;
      const firstId = firstIdRows[0]?.messageId ?? "";
      const candidateRows = yield* sql<{ readonly messageId: string }>`
        SELECT m.message_id AS "messageId"
        FROM projection_thread_messages m
        WHERE ${deliveredUserFilter(threadId, triggerMessageId)}
          AND m.message_id <> ${firstId}
        ORDER BY m.created_at DESC, m.message_id DESC
        LIMIT ${L.userMessages}
      `;

      const firstDetails = yield* userDetails(threadId, firstId === "" ? [] : [firstId]);
      const candidateDetails = yield* userDetails(
        threadId,
        candidateRows.map((row) => row.messageId),
      );
      const newestUsers = candidateDetails.toSorted(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) ||
          (b.messageId < a.messageId ? -1 : b.messageId > a.messageId ? 1 : 0),
      );
      const userRows = takeWithinChars(newestUsers, L.userChars);
      const first = firstDetails[0] ?? null;

      const userCountRows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS "count"
        FROM projection_thread_messages m
        WHERE ${deliveredUserFilter(threadId, triggerMessageId)}
          AND m.message_id <> ${firstId}
      `;

      const planRows = yield* sql<{
        readonly markdown: string;
        readonly fullChars: number;
        readonly implemented: number;
      }>`
        SELECT
          substr(plan_markdown, 1, ${L.planChars}) AS "markdown",
          length(plan_markdown) AS "fullChars",
          CASE WHEN implemented_at IS NULL THEN 0 ELSE 1 END AS "implemented"
        FROM projection_thread_proposed_plans
        WHERE thread_id = ${threadId}
        ORDER BY created_at DESC, plan_id DESC
        LIMIT 1
      `;

      const turnRows = yield* sql<{ readonly state: string }>`
        SELECT state
        FROM projection_turns
        WHERE thread_id = ${threadId} AND turn_id IS NOT NULL
        ORDER BY row_id DESC
        LIMIT 1
      `;
      const sessionRows = yield* sql<{ readonly lastError: string | null }>`
        SELECT last_error AS "lastError"
        FROM projection_thread_sessions
        WHERE thread_id = ${threadId}
      `;

      // Assistant text and tool summaries of the last turns; payloads are never
      // read. Candidates are chosen by id and time first; bodies only for them.
      const logCandidates = yield* sql<{
        readonly kind: "assistant" | "tool";
        readonly id: string;
      }>`
        WITH recent_turns AS (
          SELECT turn_id
          FROM projection_turns
          WHERE thread_id = ${threadId} AND turn_id IS NOT NULL
          ORDER BY row_id DESC
          LIMIT ${L.logTurns}
        )
        SELECT kind AS "kind", id AS "id" FROM (
          SELECT 'assistant' AS kind, m.message_id AS id, m.created_at AS at
          FROM projection_thread_messages m
          JOIN recent_turns r ON r.turn_id = m.turn_id
          WHERE m.thread_id = ${threadId} AND m.role = 'assistant' AND m.is_streaming = 0
          UNION ALL
          SELECT 'tool', a.activity_id, a.created_at
          FROM projection_thread_activities a
          JOIN recent_turns r ON r.turn_id = a.turn_id
          WHERE a.thread_id = ${threadId} AND a.tone = 'tool'
            AND a.kind NOT IN ${sql.in(TOOL_PROGRESS_KINDS)}
        )
        ORDER BY at DESC, id DESC
        LIMIT ${L.logEntries}
      `;
      const assistantIds = logCandidates
        .filter((row) => row.kind === "assistant")
        .map((row) => row.id);
      const toolIds = logCandidates.filter((row) => row.kind === "tool").map((row) => row.id);
      interface RawLogRow {
        readonly kind: "assistant" | "tool";
        readonly id: string;
        readonly at: string;
        readonly turn: number | null;
        readonly model: string | null;
        readonly text: string;
        readonly fullChars: number;
      }
      const assistantDetails =
        assistantIds.length === 0
          ? []
          : yield* sql<RawLogRow>`
              SELECT
                'assistant' AS "kind", m.message_id AS "id", m.created_at AS "at",
                t.checkpoint_turn_count AS "turn", ta.model AS "model",
                substr(m.text, 1, ${L.logEntryChars}) AS "text", length(m.text) AS "fullChars"
              FROM projection_thread_messages m
              LEFT JOIN projection_turns t ON t.thread_id = m.thread_id AND t.turn_id = m.turn_id
              LEFT JOIN projection_turn_assignments ta
                ON ta.thread_id = m.thread_id AND ta.turn_id = m.turn_id
              WHERE m.thread_id = ${threadId} AND m.message_id IN ${sql.in(assistantIds)}
            `;
      const toolDetails =
        toolIds.length === 0
          ? []
          : yield* sql<RawLogRow>`
              SELECT
                'tool' AS "kind", a.activity_id AS "id", a.created_at AS "at",
                t.checkpoint_turn_count AS "turn", NULL AS "model",
                substr(a.summary, 1, ${L.logEntryChars}) AS "text", length(a.summary) AS "fullChars"
              FROM projection_thread_activities a
              LEFT JOIN projection_turns t ON t.thread_id = a.thread_id AND t.turn_id = a.turn_id
              WHERE a.thread_id = ${threadId} AND a.activity_id IN ${sql.in(toolIds)}
            `;
      const newestLog = [...assistantDetails, ...toolDetails].toSorted(
        (a, b) => b.at.localeCompare(a.at) || (b.id < a.id ? -1 : b.id > a.id ? 1 : 0),
      );
      const logRows = takeWithinChars(newestLog, L.logChars);
      const logCountRows = yield* sql<{ readonly assistant: number; readonly tool: number }>`
        SELECT
          (
            SELECT COUNT(*) FROM projection_thread_messages
            WHERE thread_id = ${threadId} AND role = 'assistant' AND is_streaming = 0
          ) AS "assistant",
          (
            SELECT COUNT(*) FROM projection_thread_activities
            WHERE thread_id = ${threadId} AND tone = 'tool'
              AND kind NOT IN ${sql.in(TOOL_PROGRESS_KINDS)}
          ) AS "tool"
      `;

      const log: HandoffSourceLogRow[] = logRows.map((row) => ({
        kind: row.kind,
        turn: row.turn,
        model: row.model,
        text: row.text,
        fullChars: row.fullChars,
      }));
      const keptAssistant = log.filter((row) => row.kind === "assistant").length;
      const keptTool = log.length - keptAssistant;
      const counts = logCountRows[0] ?? { assistant: 0, tool: 0 };
      const plan = planRows[0];
      return {
        thread: threadRows[0] ?? null,
        firstUser: first === null ? null : toUserRow(first),
        users: userRows.map(toUserRow),
        omittedUsers: Math.max(0, (userCountRows[0]?.count ?? 0) - userRows.length),
        plan:
          plan === undefined
            ? null
            : {
                markdown: plan.markdown,
                fullChars: plan.fullChars,
                implemented: plan.implemented === 1,
              },
        lastTurnState: turnRows[0]?.state ?? null,
        lastError: sessionRows[0]?.lastError ?? null,
        log,
        omittedAssistantMessages: Math.max(0, counts.assistant - keptAssistant),
        omittedToolEntries: Math.max(0, counts.tool - keptTool),
      } satisfies HandoffSourceRows;
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
      Effect.all([deleteStateRow(input), deletePacketRows(input), deleteAssignmentRows(input)], {
        discard: true,
      }).pipe(Effect.mapError(fail("deleteByThreadId"))),
    recordTurnAssignment: (row) =>
      recordAssignmentRow(row).pipe(Effect.mapError(fail("recordTurnAssignment"))),
    listTurnAssignments: (input) =>
      listAssignmentRows(input).pipe(
        Effect.map((rows) =>
          rows.map((row) => ({ ...row, changedMidTurn: row.changedMidTurn === 1 })),
        ),
        Effect.mapError(fail("listTurnAssignments")),
      ),
    hasDeliveredUserMessage: (input) =>
      sql<{ readonly found: number }>`
        SELECT EXISTS (
          SELECT 1 FROM projection_thread_messages m
          WHERE ${deliveredUserFilter(input.threadId, input.excludeMessageId)}
        ) AS "found"
      `.pipe(
        Effect.map((rows) => (rows[0]?.found ?? 0) === 1),
        Effect.mapError(fail("hasDeliveredUserMessage")),
      ),
    getMessageDeliveryState: (input) =>
      sql<{ readonly state: string | null }>`
        SELECT delivery_state AS "state"
        FROM projection_thread_messages
        WHERE message_id = ${input.messageId}
      `.pipe(
        Effect.map((rows) => (rows[0]?.state ?? null) as MessageDeliveryState | null),
        Effect.mapError(fail("getMessageDeliveryState")),
      ),
    getLatestCheckpointTurnCount: (input) =>
      sql<{ readonly count: number | null }>`
        SELECT MAX(checkpoint_turn_count) AS "count"
        FROM projection_turns
        WHERE thread_id = ${input.threadId}
      `.pipe(
        Effect.map((rows) => rows[0]?.count ?? 0),
        Effect.mapError(fail("getLatestCheckpointTurnCount")),
      ),
    readHandoffSource: (input) =>
      readHandoffSourceRows(input).pipe(Effect.mapError(fail("readHandoffSource"))),
    setMessageDeliveryState: (input) =>
      setDeliveryState(input).pipe(Effect.mapError(fail("setMessageDeliveryState"))),
  } satisfies ProjectionThreadProviderSwitchRepositoryShape;
});

export const ProjectionThreadProviderSwitchRepositoryLive = Layer.effect(
  ProjectionThreadProviderSwitchRepository,
  makeProjectionThreadProviderSwitchRepository,
);
