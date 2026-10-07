import { assert, it } from "@effect/vitest";
import { MessageId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { buildHandoffPacket } from "../../orchestration/CrossProviderHandoff.ts";
import { assembleHandoffSource } from "../../orchestration/handoffSource.ts";
import { ProjectionThreadProviderSwitchRepository } from "../Services/ProjectionThreadProviderSwitches.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionThreadProviderSwitchRepositoryLive } from "./ProjectionThreadProviderSwitches.ts";

const layer = it.layer(
  ProjectionThreadProviderSwitchRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const at = (minute: number) =>
  `2026-10-06T10:${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}.000Z`;

const insertThread = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
        branch, worktree_path, created_at, updated_at
      ) VALUES (
        ${threadId}, 'project-1', 'Thread', '{"instanceId":"claude","model":"claude-opus-5-5"}',
        'full-access', 'default', 'amu/feature', '/tmp/wt', ${at(0)}, ${at(0)}
      )
    `;
  });

const insertMessage = (input: {
  threadId: string;
  messageId: string;
  role: "user" | "assistant";
  text: string;
  minute: number;
  turnId?: string | null;
  deliveryState?: string | null;
  contextJson?: string | null;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, context_json, is_streaming,
        delivery_state, created_at, updated_at
      ) VALUES (
        ${input.messageId}, ${input.threadId}, ${input.turnId ?? null}, ${input.role}, ${input.text},
        ${input.contextJson ?? null}, 0, ${input.deliveryState ?? null},
        ${at(input.minute)}, ${at(input.minute)}
      )
    `;
  });

const insertTurn = (input: {
  threadId: string;
  turnId: string;
  count: number;
  pendingMessageId?: string;
  state?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_turns (
        thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_turn_count,
        checkpoint_files_json
      ) VALUES (
        ${input.threadId}, ${input.turnId}, ${input.pendingMessageId ?? null},
        ${input.state ?? "completed"}, ${at(input.count)}, ${input.count}, '[]'
      )
    `;
  });

const read = (threadId: string, triggerMessageId = "trigger") =>
  Effect.gen(function* () {
    const repository = yield* ProjectionThreadProviderSwitchRepository;
    return yield* repository.readHandoffSource({
      threadId: ThreadId.make(threadId),
      triggerMessageId: MessageId.make(triggerMessageId),
    });
  });

layer("readHandoffSource", (it) => {
  it.effect("keeps only delivered user messages, never the trigger, oldest first", () =>
    Effect.gen(function* () {
      const threadId = "thread-delivery";
      yield* insertThread(threadId);
      yield* insertMessage({
        threadId,
        messageId: "u1",
        role: "user",
        text: "最初の依頼",
        minute: 1,
      });
      yield* insertMessage({
        threadId,
        messageId: "u2",
        role: "user",
        text: "二つ目",
        minute: 2,
        deliveryState: "delivered",
      });
      for (const [index, state] of [
        "pending",
        "rejected",
        "cancelled",
        "unknown-discarded",
      ].entries()) {
        yield* insertMessage({
          threadId,
          messageId: `skip-${state}`,
          role: "user",
          text: state,
          minute: 3 + index,
          deliveryState: state,
        });
      }
      yield* insertMessage({ threadId, messageId: "u3", role: "user", text: "三つ目", minute: 8 });
      yield* insertMessage({
        threadId,
        messageId: "trigger",
        role: "user",
        text: "今回",
        minute: 9,
      });

      const rows = yield* read(threadId);
      assert.strictEqual(rows.firstUser?.text, "最初の依頼");
      assert.deepEqual(
        rows.users.map((row) => row.text),
        ["二つ目", "三つ目"],
      );
      assert.strictEqual(rows.omittedUsers, 0);
      assert.deepEqual(rows.thread, {
        branch: "amu/feature",
        worktreePath: "/tmp/wt",
        runtimeMode: "full-access",
        interactionMode: "default",
      });
    }),
  );

  it.effect("caps user messages by count and keeps the newest", () =>
    Effect.gen(function* () {
      const threadId = "thread-many-users";
      yield* insertThread(threadId);
      for (let index = 0; index < 250; index += 1) {
        yield* insertMessage({
          threadId,
          messageId: `u-${String(index).padStart(3, "0")}`,
          role: "user",
          text: `msg ${index}`,
          minute: index,
        });
      }
      const rows = yield* read(threadId);
      assert.strictEqual(rows.firstUser?.text, "msg 0");
      assert.strictEqual(rows.users.length, 200);
      assert.strictEqual(rows.users[0]?.text, "msg 50");
      assert.strictEqual(rows.users.at(-1)?.text, "msg 249");
      assert.strictEqual(rows.omittedUsers, 49);
    }),
  );

  it.effect("caps user messages by total characters and cuts each in SQL", () =>
    Effect.gen(function* () {
      const threadId = "thread-long-users";
      yield* insertThread(threadId);
      yield* insertMessage({ threadId, messageId: "first", role: "user", text: "依頼", minute: 0 });
      for (let index = 1; index <= 40; index += 1) {
        yield* insertMessage({
          threadId,
          messageId: `long-${String(index).padStart(2, "0")}`,
          role: "user",
          text: "あ".repeat(10_000),
          minute: index,
        });
      }
      const rows = yield* read(threadId);
      // 6,000 kept characters each; 33 × 6,000 fits in 200,000, 34 does not.
      assert.strictEqual(rows.users.length, 33);
      assert.strictEqual(rows.omittedUsers, 7);
      assert.ok(rows.users.every((row) => row.text.length === 6_000 && row.fullChars === 10_000));

      const source = assembleHandoffSource({
        rows,
        cwd: "/tmp/wt",
        fromDriver: "claudeAgent",
        fromModel: "claude-opus-5-5",
        fromTurnCount: 0,
        changes: null,
      });
      const packet = buildHandoffPacket({ source, expandedNow: "続けて", budgetChars: 60_000 });
      assert.strictEqual(packet._tag, "built");
      if (packet._tag === "built") {
        assert.include(packet.text, "…（4000字省略）");
      }
    }),
  );

  it.effect("reads context labels without their bodies", () =>
    Effect.gen(function* () {
      const threadId = "thread-context";
      yield* insertThread(threadId);
      yield* insertMessage({
        threadId,
        messageId: "u-context",
        role: "user",
        text: "これを見て",
        minute: 1,
        contextJson:
          '{"version":1,"records":[{"version":1,"contextId":"c1","kind":"file","label":"README.md","body":"SECRET"}]}',
      });
      const rows = yield* read(threadId);
      assert.deepEqual(rows.firstUser?.contextLabels, ["file: README.md"]);
    }),
  );

  it.effect("reads the log of the last turns with their models, and counts the rest", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threadId = "thread-log";
      yield* insertThread(threadId);
      for (let count = 1; count <= 55; count += 1) {
        const turnId = `turn-${count}`;
        yield* insertTurn({ threadId, turnId, count });
        yield* insertMessage({
          threadId,
          messageId: `a-${count}`,
          role: "assistant",
          text: count === 55 ? "x".repeat(3_000) : `answer ${count}`,
          minute: count,
          turnId,
        });
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
          ) VALUES (
            ${`act-${count}`}, ${threadId}, ${turnId}, 'tool', 'tool.completed',
            ${`ran tool ${count}`}, '{"huge":"payload"}', ${at(count)}
          )
        `;
      }
      yield* sql`
        INSERT INTO projection_turn_assignments (
          thread_id, turn_id, message_id, instance_id, driver, model, generation, recorded_at
        ) VALUES (${threadId}, 'turn-55', 'u', 'claude', 'claudeAgent', 'claude-opus-5-5', 1, ${at(55)})
      `;
      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id, status, provider_name, active_turn_id, last_error, updated_at
        ) VALUES (${threadId}, 'error', 'claudeAgent', NULL, 'boom', ${at(56)})
      `;
      yield* sql`
        UPDATE projection_turns SET state = 'error' WHERE thread_id = ${threadId} AND turn_id = 'turn-55'
      `;

      const rows = yield* read(threadId);
      // Last 50 turns only: turns 6–55, one assistant message and one tool entry each.
      assert.strictEqual(rows.log.length, 100);
      assert.strictEqual(rows.log[0]?.turn, 6);
      const newest = rows.log.at(-1);
      assert.strictEqual(newest?.kind, "tool");
      const newestAssistant = rows.log.findLast((row) => row.kind === "assistant");
      assert.strictEqual(newestAssistant?.model, "claude-opus-5-5");
      assert.strictEqual(newestAssistant?.text.length, 2_000);
      assert.strictEqual(newestAssistant?.fullChars, 3_000);
      assert.strictEqual(rows.omittedAssistantMessages, 5);
      assert.strictEqual(rows.omittedToolEntries, 5);
      assert.strictEqual(rows.lastTurnState, "error");

      const source = assembleHandoffSource({
        rows,
        cwd: null,
        fromDriver: "claudeAgent",
        fromModel: "claude-opus-5-5",
        fromTurnCount: 55,
        changes: null,
      });
      assert.deepEqual(source.state, { lastTurn: "failed", errorSummary: "boom" });
    }),
  );

  it.effect("reads the latest plan and whether it was implemented", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threadId = "thread-plan";
      yield* insertThread(threadId);
      yield* sql`
        INSERT INTO projection_thread_proposed_plans (
          plan_id, thread_id, turn_id, plan_markdown, implemented_at, created_at, updated_at
        ) VALUES
          ('p1', ${threadId}, NULL, '古い計画', NULL, ${at(1)}, ${at(1)}),
          ('p2', ${threadId}, NULL, '新しい計画', ${at(3)}, ${at(2)}, ${at(3)})
      `;
      const rows = yield* read(threadId);
      assert.deepEqual(rows.plan, { markdown: "新しい計画", fullChars: 5, implemented: true });
      assert.strictEqual(rows.firstUser, null);
      assert.strictEqual(rows.lastTurnState, null);
    }),
  );

  it.effect("counts omitted characters in code points for emoji in USER, PLAN and LOG", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threadId = "thread-emoji";
      const emoji = "😀";
      yield* insertThread(threadId);
      yield* insertMessage({
        threadId,
        messageId: "emoji-u1",
        role: "user",
        text: emoji.repeat(8_000),
        minute: 1,
      });
      yield* insertTurn({ threadId, turnId: "turn-e", count: 1 });
      yield* insertMessage({
        threadId,
        messageId: "emoji-a1",
        role: "assistant",
        text: emoji.repeat(3_000),
        minute: 2,
        turnId: "turn-e",
      });
      yield* sql`
        INSERT INTO projection_thread_proposed_plans (
          plan_id, thread_id, turn_id, plan_markdown, implemented_at, created_at, updated_at
        ) VALUES ('p-e', ${threadId}, NULL, ${emoji.repeat(7_000)}, NULL, ${at(3)}, ${at(3)})
      `;
      const rows = yield* read(threadId);
      const source = assembleHandoffSource({
        rows,
        cwd: null,
        fromDriver: "claudeAgent",
        fromModel: "claude-opus-5-5",
        fromTurnCount: 1,
        changes: null,
      });
      // SQL kept 6,000 / 6,000 / 2,000 code points.
      assert.strictEqual(source.firstUserMessage?.omittedChars, 2_000);
      assert.strictEqual(source.plan?.omittedChars, 1_000);
      assert.strictEqual(source.log[0]?.kind === "assistant" && source.log[0].omittedChars, 1_000);

      const packet = buildHandoffPacket({ source, expandedNow: "続けて", budgetChars: 60_000 });
      assert.strictEqual(packet._tag, "built");
      if (packet._tag !== "built") return;
      // 6,000 UTF-16 units hold 3,000 emoji: USER omits 5,000, PLAN 4,000; LOG fits, omits 1,000.
      assert.include(packet.text, "…（5000字省略）");
      assert.include(packet.text, "…（4000字省略）");
      assert.include(packet.text, "…（1000字省略）");
      assert.notMatch(packet.text, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
    }),
  );

  it.effect("reads bodies for at most the capped number of log entries", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threadId = "thread-busy-turn";
      yield* insertThread(threadId);
      yield* insertTurn({ threadId, turnId: "turn-busy", count: 1 });
      for (let index = 0; index < 1_000; index += 1) {
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
          ) VALUES (
            ${`act-${String(index).padStart(4, "0")}`}, ${threadId}, 'turn-busy', 'tool',
            'tool.completed', ${`tool ${index}`}, '{}', ${at(index)}
          )
        `;
      }
      const rows = yield* read(threadId);
      assert.strictEqual(rows.log.length, 200);
      assert.strictEqual(rows.log.at(-1)?.text, "tool 999");
      assert.strictEqual(rows.omittedToolEntries, 800);
    }),
  );

  it.effect("keeps one log line per tool call: its completion, not its start or progress", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threadId = "thread-tool-progress";
      yield* insertThread(threadId);
      yield* insertTurn({ threadId, turnId: "turn-tools", count: 1 });
      // The last start has no completion, as in an interrupted turn.
      const kinds = ["tool.started", "tool.updated", "tool.completed", "tool.started"] as const;
      for (const [index, kind] of kinds.entries()) {
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
          ) VALUES (
            ${`act-progress-${index}`}, ${threadId}, 'turn-tools', 'tool', ${kind},
            ${`Command run (${kind})`}, '{}', ${at(index)}
          )
        `;
      }
      const rows = yield* read(threadId);
      assert.deepEqual(
        rows.log.map((row) => row.text),
        ["Command run (tool.completed)"],
      );
      assert.strictEqual(rows.omittedToolEntries, 0);
    }),
  );

  it.effect("numbers user turns from the assignment record, not a mispaired pending row", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threadId = "thread-pairing";
      yield* insertThread(threadId);
      yield* insertMessage({ threadId, messageId: "A", role: "user", text: "A の依頼", minute: 1 });
      yield* insertMessage({ threadId, messageId: "B", role: "user", text: "B の依頼", minute: 2 });
      // B's request was saved before A was accepted: turn 1 got paired with B.
      yield* insertTurn({ threadId, turnId: "turn-1", count: 1, pendingMessageId: "B" });
      yield* insertTurn({ threadId, turnId: "turn-2", count: 2 });
      yield* sql`
        INSERT INTO projection_turn_assignments (
          thread_id, turn_id, message_id, instance_id, driver, model, generation, recorded_at
        ) VALUES
          (${threadId}, 'turn-1', 'A', 'claude', 'claudeAgent', 'claude-opus-5-5', 1, ${at(3)}),
          (${threadId}, 'turn-2', 'B', 'claude', 'claudeAgent', 'claude-opus-5-5', 1, ${at(4)})
      `;
      const rows = yield* read(threadId);
      assert.strictEqual(rows.firstUser?.turn, 1);
      assert.deepEqual(
        rows.users.map((row) => [row.messageId as string, row.turn]),
        [["B", 2]],
      );

      // Without an assignment, a pending row assigned to another message is not used.
      yield* insertMessage({ threadId, messageId: "C", role: "user", text: "C", minute: 5 });
      yield* sql`
        UPDATE projection_turns SET pending_message_id = 'C' WHERE thread_id = ${threadId} AND turn_id = 'turn-2'
      `;
      const again = yield* read(threadId);
      assert.strictEqual(again.users.find((row) => row.messageId === "C")?.turn, null);
    }),
  );
});
